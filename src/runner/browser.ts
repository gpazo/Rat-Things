import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import type { JsonValue } from '../domain/contracts.js';
import { validateArtifactPath } from '../domain/artifacts.js';
import {
  COMPUTER_VIEWPORT,
  type ComputerSnapshot,
  type ComputerTakeoverReceipt,
  type HumanBrowserAction,
  type TeachRecordingInput,
  type TeachRecordingResult,
} from '../domain/interaction.js';

// `browser` is reserved by the Responses runtime, so host-provided dynamic
// tools use a Rat Things-specific namespace.
export const BROWSER_TOOL_NAMESPACE = 'rat_browser';
const MAX_BROWSER_TEXT_BYTES = 64 * 1024;
const MAX_BROWSER_IMAGE_BYTES = 4 * 1024 * 1024;
export const HUMAN_COMPUTER_LEASE_MS = 15 * 60 * 1_000;
export const TEACH_DEMONSTRATION_MAXIMUM_MS = 10 * 60 * 1_000;
const MAX_TEACH_STEPS = 100;

export interface BrowserToolCall {
  namespace: string | null;
  tool: string;
  arguments: JsonValue;
}

export interface BrowserToolResponse {
  success: boolean;
  contentItems: Array<
    | { type: 'inputText'; text: string }
    | { type: 'inputImage'; imageUrl: string }
  >;
}

export interface BrowserBackendResult {
  text: string;
  imageDataUrl?: string;
}

export interface BrowserBackend {
  execute(command: BrowserCommand, signal?: AbortSignal): Promise<BrowserBackendResult>;
  close(): Promise<void>;
}

export type BrowserCommand =
  | { type: 'navigate'; url: string }
  | { type: 'observe'; includeScreenshot: boolean }
  | { type: 'screenshot'; path: string; fullPage: boolean }
  | { type: 'record_start'; path: string; fps: number }
  | { type: 'record_stop' }
  | { type: 'click'; ref?: string; x?: number; y?: number }
  | { type: 'type'; ref?: string; text: string; clear: boolean; submit: boolean }
  | { type: 'press'; key: string }
  | { type: 'select'; ref: string; value: string }
  | { type: 'scroll'; deltaX: number; deltaY: number }
  | { type: 'wait'; milliseconds: number }
  | { type: 'back' };

export class BrowserToolSession {
  public readonly tools = browserDynamicTools();
  private takeover: { startedAt: number; expiresAt: number } | undefined;
  private teaching: {
    runId: string;
    recordingId: string;
    name: string;
    goal?: string;
    startedAt: number;
    steps: HumanBrowserAction[];
  } | undefined;
  private operation: Promise<void> = Promise.resolve();

  public constructor(
    private readonly backend: BrowserBackend = new BrowserHostBackend(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async call(call: BrowserToolCall, signal?: AbortSignal): Promise<BrowserToolResponse> {
    if (call.namespace !== BROWSER_TOOL_NAMESPACE) {
      throw new Error(`browser tool namespace must be ${BROWSER_TOOL_NAMESPACE}`);
    }
    const command = parseBrowserCommand(call.tool, call.arguments);
    return this.serial(async () => {
      await this.releaseExpiredTakeover();
      if (this.takeover) {
        throw new Error('browser is under temporary human control; wait until control is returned');
      }
      const result = await this.backend.execute(command, signal);
      return toolResponse(result);
    });
  }

  public computer(runId: string): Promise<ComputerSnapshot> {
    return this.serial(async () => {
      await this.releaseExpiredTakeover();
      const result = await this.backend.execute({ type: 'observe', includeScreenshot: true });
      return this.snapshot(runId, result);
    });
  }

  public takeComputer(runId: string): Promise<ComputerTakeoverReceipt> {
    return this.serial(async () => {
      await this.releaseExpiredTakeover();
      const timestamp = this.now().getTime();
      this.takeover ??= {
        startedAt: timestamp,
        expiresAt: timestamp + HUMAN_COMPUTER_LEASE_MS,
      };
      return this.takeoverReceipt(runId);
    });
  }

  public returnComputer(runId: string): Promise<ComputerTakeoverReceipt> {
    return this.serial(async () => {
      if (this.teaching) throw new Error('stop or discard the demonstration before returning control');
      this.takeover = undefined;
      return this.takeoverReceipt(runId);
    });
  }

  public actOnComputer(runId: string, action: HumanBrowserAction): Promise<ComputerSnapshot> {
    return this.serial(async () => {
      await this.requireTakeover();
      const command = parseHumanBrowserAction(action);
      if (
        this.teaching &&
        this.now().getTime() - this.teaching.startedAt >= TEACH_DEMONSTRATION_MAXIMUM_MS
      ) throw new Error('the demonstration reached ten minutes; stop and save or discard it');
      if (this.teaching && this.teaching.steps.length >= MAX_TEACH_STEPS) {
        throw new Error(`a demonstration is limited to ${MAX_TEACH_STEPS} browser actions`);
      }
      await this.backend.execute(command);
      if (this.teaching) {
        this.teaching.steps.push(redactedTeachStep(command, this.teaching.steps));
      }
      this.renewTakeover();
      const observed = await this.backend.execute({ type: 'observe', includeScreenshot: true });
      return this.snapshot(runId, observed);
    });
  }

  public startTeaching(runId: string, input: TeachRecordingInput): Promise<ComputerSnapshot> {
    return this.serial(async () => {
      await this.requireTakeover();
      if (this.teaching) throw new Error('a demonstration is already recording');
      const name = boundedString(input.name, 120, 'name');
      const goal = input.goal === undefined
        ? undefined
        : boundedString(input.goal, 4_000, 'goal');
      const recordingId = randomUUID();
      this.teaching = {
        runId,
        recordingId,
        name,
        ...(goal ? { goal } : {}),
        startedAt: this.now().getTime(),
        steps: [],
      };
      this.renewTakeover();
      const observed = await this.backend.execute({ type: 'observe', includeScreenshot: true });
      return this.snapshot(runId, observed);
    });
  }

  public stopTeaching(discard: boolean): Promise<TeachRecordingResult> {
    return this.serial(async () => {
      await this.requireTakeover();
      const teaching = this.teaching;
      if (!teaching) throw new Error('no demonstration is recording');
      if (!discard && teaching.steps.length === 0) {
        throw new Error('demonstrate at least one browser action before saving a draft');
      }
      const stoppedAt = this.now();
      this.teaching = undefined;
      this.renewTakeover();
      return {
        version: '1',
        recordingId: teaching.recordingId,
        name: teaching.name,
        startedAt: new Date(teaching.startedAt).toISOString(),
        stoppedAt: stoppedAt.toISOString(),
        demonstratedSteps: teaching.steps.length,
        discarded: discard,
        ...(discard ? {} : { draft: teachDraft(teaching) }),
      };
    });
  }

  public close(): Promise<void> {
    return this.serial(async () => {
      this.teaching = undefined;
      await this.backend.close();
    });
  }

  private snapshot(runId: string, result: BrowserBackendResult): ComputerSnapshot {
    assertBoundedText(result.text);
    if (!result.imageDataUrl) throw new Error('browser did not return a screen image');
    assertBoundedImage(result.imageDataUrl);
    const page = parsePageState(result.text);
    return {
      version: '1',
      runId,
      available: true,
      control: this.takeover ? 'human' : 'agent',
      viewport: COMPUTER_VIEWPORT,
      observedAt: this.now().toISOString(),
      page,
      imageDataUrl: result.imageDataUrl,
      ...(this.takeover ? { takeover: takeoverWindow(this.takeover) } : {}),
      teach: this.teaching ? {
        state: 'recording',
        recordingId: this.teaching.recordingId,
        name: this.teaching.name,
        startedAt: new Date(this.teaching.startedAt).toISOString(),
        maximumDurationMs: TEACH_DEMONSTRATION_MAXIMUM_MS,
        demonstratedSteps: this.teaching.steps.length,
      } : { state: 'idle' },
    };
  }

  private takeoverReceipt(runId: string): ComputerTakeoverReceipt {
    return {
      version: '1',
      runId,
      control: this.takeover ? 'human' : 'agent',
      ...(this.takeover ? { takeover: takeoverWindow(this.takeover) } : {}),
    };
  }

  private async requireTakeover(): Promise<void> {
    await this.releaseExpiredTakeover();
    if (!this.takeover) throw new Error('take temporary control before interacting with the browser');
  }

  private renewTakeover(): void {
    if (this.takeover) this.takeover.expiresAt = this.now().getTime() + HUMAN_COMPUTER_LEASE_MS;
  }

  private async releaseExpiredTakeover(): Promise<void> {
    if (!this.takeover || this.takeover.expiresAt > this.now().getTime()) return;
    this.teaching = undefined;
    this.takeover = undefined;
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.operation.then(work, work);
    this.operation = result.then(() => undefined, () => undefined);
    return result;
  }
}

function toolResponse(result: BrowserBackendResult): BrowserToolResponse {
  assertBoundedText(result.text);
  const contentItems: BrowserToolResponse['contentItems'] = [
    { type: 'inputText', text: result.text },
  ];
  if (result.imageDataUrl) {
    assertBoundedImage(result.imageDataUrl);
    contentItems.push({ type: 'inputImage', imageUrl: result.imageDataUrl });
  }
  return { success: true, contentItems };
}

function parseHumanBrowserAction(action: HumanBrowserAction): BrowserCommand {
  if (!isRecord(action) || typeof action.type !== 'string') {
    throw new Error('browser action is invalid');
  }
  switch (action.type) {
    case 'navigate': return parseBrowserCommand('navigate', { url: action.url });
    case 'click': return parseBrowserCommand('click', {
      ...(action.ref !== undefined ? { ref: action.ref } : {}),
      ...(action.x !== undefined ? { x: action.x } : {}),
      ...(action.y !== undefined ? { y: action.y } : {}),
    });
    case 'type': return parseBrowserCommand('type', {
      ...(action.ref !== undefined ? { ref: action.ref } : {}),
      text: action.text,
      ...(action.clear !== undefined ? { clear: action.clear } : {}),
      ...(action.submit !== undefined ? { submit: action.submit } : {}),
    });
    case 'press': return parseBrowserCommand('press', { key: action.key });
    case 'select': return parseBrowserCommand('select', {
      ref: action.ref,
      value: action.value,
    });
    case 'scroll': return parseBrowserCommand('scroll', {
      ...(action.deltaX !== undefined ? { deltaX: action.deltaX } : {}),
      deltaY: action.deltaY,
    });
    case 'wait': return parseBrowserCommand('wait', { milliseconds: action.milliseconds });
    case 'back': return parseBrowserCommand('back', {});
    default: throw new Error('browser action is not available to human control');
  }
}

function redactedTeachStep(
  command: BrowserCommand,
  previous: HumanBrowserAction[],
): HumanBrowserAction {
  const parameter = () => {
    const index = previous.filter((step) => step.type === 'type' || step.type === 'select').length + 1;
    return `{{input_${index}}}`;
  };
  switch (command.type) {
    case 'navigate': {
      const url = new URL(command.url);
      url.search = '';
      url.hash = '';
      return { type: 'navigate', url: url.toString() };
    }
    case 'click': return command.ref
      ? { type: 'click', ref: command.ref }
      : { type: 'click', x: command.x as number, y: command.y as number };
    case 'type': return {
      type: 'type',
      ...(command.ref ? { ref: command.ref } : {}),
      text: parameter(),
      clear: command.clear,
      submit: command.submit,
    };
    case 'press': return { type: 'press', key: command.key };
    case 'select': return { type: 'select', ref: command.ref, value: parameter() };
    case 'scroll': return { type: 'scroll', deltaX: command.deltaX, deltaY: command.deltaY };
    case 'wait': return { type: 'wait', milliseconds: command.milliseconds };
    case 'back': return { type: 'back' };
    default: throw new Error('only interactive browser actions can become demonstration steps');
  }
}

function teachDraft(teaching: {
  runId: string;
  recordingId: string;
  name: string;
  goal?: string;
  steps: HumanBrowserAction[];
}): NonNullable<TeachRecordingResult['draft']> {
  const steps = teaching.steps.map((step, index) => `${index + 1}. ${JSON.stringify(step)}`);
  return {
    version: '1',
    name: teaching.name,
    goal: [
      teaching.goal ?? `Repeat the demonstrated browser workflow named "${teaching.name}".`,
      '',
      'Use the isolated browser and reproduce these demonstrated actions in order:',
      ...steps,
      '',
      'Treat {{input_N}} values as required runtime inputs. Never infer or persist demonstrated values.',
      'Use current element observations when recorded refs or coordinates no longer match, then verify the final page state.',
    ].join('\n'),
    trigger: { kind: 'manual' },
    agent: {
      driver: 'codex',
      sandbox: 'danger-full-access',
      capabilities: { networkAccess: true, computerUse: 'browser' },
    },
    metadata: {
      createdBy: 'teach-by-demonstration',
      sourceRunId: teaching.runId,
      recordingId: teaching.recordingId,
      demonstratedActions: teaching.steps.length,
      redactedInputs: teaching.steps.filter((step) => step.type === 'type' || step.type === 'select').length,
    },
  };
}

function parsePageState(text: string): { url: string; title: string } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('browser returned invalid page state');
  }
  if (!isRecord(value) || typeof value.url !== 'string' || typeof value.title !== 'string') {
    throw new Error('browser returned invalid page state');
  }
  return {
    url: value.url.slice(0, 4_096),
    title: value.title.slice(0, 1_000),
  };
}

function takeoverWindow(takeover: { startedAt: number; expiresAt: number }): {
  startedAt: string;
  expiresAt: string;
} {
  return {
    startedAt: new Date(takeover.startedAt).toISOString(),
    expiresAt: new Date(takeover.expiresAt).toISOString(),
  };
}

interface PendingBrowserCommand {
  resolve(value: BrowserBackendResult): void;
  reject(error: Error): void;
  removeAbort?: () => void;
}

interface BrowserHostMessage {
  id: number;
  result?: BrowserBackendResult;
  error?: string;
}

export class BrowserHostBackend implements BrowserBackend {
  private child: ChildProcess | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, PendingBrowserCommand>();
  private closed = false;

  public constructor(private readonly options: BrowserHostBackendOptions = {}) {}

  public execute(command: BrowserCommand, signal?: AbortSignal): Promise<BrowserBackendResult> {
    if (this.closed) return Promise.reject(new Error('browser session is closed'));
    if (signal?.aborted) return Promise.reject(new Error('browser command was cancelled'));
    const child = this.process();
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.terminate(new Error('browser command was cancelled'));
      };
      if (signal) signal.addEventListener('abort', abort, { once: true });
      this.pending.set(id, {
        resolve,
        reject,
        ...(signal ? { removeAbort: () => signal.removeEventListener('abort', abort) } : {}),
      });
      child.send?.({ id, command }, (error) => {
        if (!error) return;
        const waiter = this.pending.get(id);
        if (!waiter) return;
        this.pending.delete(id);
        waiter.removeAbort?.();
        waiter.reject(new Error('browser host could not accept the command'));
      });
    });
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const child = this.child;
    if (!child) return;
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        child.kill('SIGTERM');
        resolve();
      }, 5_000);
      child.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
      child.send?.({ type: 'close' }, (error) => {
        if (error) child.kill('SIGTERM');
      });
    });
    this.terminate(new Error('browser session is closed'));
  }

  private process(): ChildProcess {
    if (this.child?.connected) return this.child;
    const entry = process.env.BROWSER_HOST_ENTRY ?? '/opt/agent-runtime/browser-host.mjs';
    const identity = browserHostIdentity();
    const child = fork(entry, [], {
      env: browserHostEnvironment(this.options.artifactRoot),
      execArgv: [],
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      ...identity,
    });
    this.child = child;
    child.on('message', (raw) => this.handleMessage(raw));
    child.once('error', () => {
      this.terminate(new Error('browser host failed to start'));
    });
    child.once('exit', (code, signal) => {
      this.terminate(new Error(
        `browser host exited unexpectedly (${code ?? signal ?? 'unknown'})`,
      ));
    });
    return child;
  }

  private handleMessage(raw: unknown): void {
    if (!isRecord(raw) || !Number.isInteger(raw.id)) return;
    const message = raw as unknown as BrowserHostMessage;
    const waiter = this.pending.get(message.id);
    if (!waiter) return;
    this.pending.delete(message.id);
    waiter.removeAbort?.();
    if (typeof message.error === 'string') {
      waiter.reject(new Error(message.error.slice(0, 1_000)));
      return;
    }
    if (!isBrowserBackendResult(message.result)) {
      waiter.reject(new Error('browser host returned an invalid result'));
      return;
    }
    waiter.resolve(message.result);
  }

  private terminate(error: Error): void {
    const child = this.child;
    this.child = undefined;
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    for (const waiter of this.pending.values()) {
      waiter.removeAbort?.();
      waiter.reject(error);
    }
    this.pending.clear();
  }
}

export function browserDynamicTools(): Array<Record<string, unknown>> {
  return [{
    type: 'namespace',
    name: BROWSER_TOOL_NAMESPACE,
    description: 'Control an isolated headless browser on the public web. Observe after navigation or interaction to get current element refs.',
    tools: [
      tool('navigate', 'Open an HTTP or HTTPS URL and return the visible page state.', {
        type: 'object',
        properties: { url: { type: 'string', description: 'Absolute HTTP or HTTPS URL.' } },
        required: ['url'],
        additionalProperties: false,
      }),
      tool('observe', 'Read visible text and interactive elements. Optionally include a screenshot.', {
        type: 'object',
        properties: { includeScreenshot: { type: 'boolean', default: false } },
        additionalProperties: false,
      }),
      tool('screenshot', 'Save a browser screenshot into the durable Rat Things artifact outbox and return a visual preview.', {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Relative artifact path ending in .png, .jpg, or .jpeg.',
          },
          fullPage: {
            type: 'boolean',
            default: false,
            description: 'Capture the full document, up to the browser safety limit.',
          },
        },
        required: ['path'],
        additionalProperties: false,
      }),
      tool('record_start', 'Start a bounded WebM recording of browser navigation and save it into the durable Rat Things artifact outbox.', {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Relative artifact path ending in .webm.',
          },
          fps: {
            type: 'integer',
            minimum: 1,
            maximum: 10,
            default: 5,
            description: 'Capture rate. Recordings are capped at 60 seconds and 300 frames.',
          },
        },
        required: ['path'],
        additionalProperties: false,
      }),
      tool('record_stop', 'Finalize the active browser recording so it can be published or returned as an artifact.', {
        type: 'object',
        additionalProperties: false,
      }),
      tool('click', 'Click an element ref from observe, or viewport coordinates for visual-only controls.', {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'Element ref such as r12.' },
          x: { type: 'number', minimum: 0, maximum: 1280 },
          y: { type: 'number', minimum: 0, maximum: 720 },
        },
        anyOf: [{ required: ['ref'] }, { required: ['x', 'y'] }],
        additionalProperties: false,
      }),
      tool('type', 'Type text into a focused control or an element ref.', {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'Optional input element ref.' },
          text: { type: 'string' },
          clear: { type: 'boolean', default: true },
          submit: { type: 'boolean', default: false },
        },
        required: ['text'],
        additionalProperties: false,
      }),
      tool('press', 'Press a keyboard key in the current page, such as Enter, Escape, or Tab.', {
        type: 'object',
        properties: { key: { type: 'string' } },
        required: ['key'],
        additionalProperties: false,
      }),
      tool('select', 'Select an option value in a select element.', {
        type: 'object',
        properties: { ref: { type: 'string' }, value: { type: 'string' } },
        required: ['ref', 'value'],
        additionalProperties: false,
      }),
      tool('scroll', 'Scroll the current viewport.', {
        type: 'object',
        properties: {
          deltaX: { type: 'number', minimum: -5000, maximum: 5000, default: 0 },
          deltaY: { type: 'number', minimum: -5000, maximum: 5000 },
        },
        required: ['deltaY'],
        additionalProperties: false,
      }),
      tool('wait', 'Wait briefly for page activity to settle.', {
        type: 'object',
        properties: { milliseconds: { type: 'integer', minimum: 0, maximum: 10000 } },
        required: ['milliseconds'],
        additionalProperties: false,
      }),
      tool('back', 'Navigate back one page in browser history.', {
        type: 'object',
        additionalProperties: false,
      }),
    ],
  }];
}

function tool(
  name: string,
  description: string,
  inputSchema: Record<string, unknown>,
): Record<string, unknown> {
  return { type: 'function', name, description, inputSchema };
}

function parseBrowserCommand(toolName: string, value: JsonValue): BrowserCommand {
  const input = recordValue(value, 'browser tool arguments');
  switch (toolName) {
    case 'navigate': return { type: 'navigate', url: webUrl(input.url) };
    case 'observe': return {
      type: 'observe',
      includeScreenshot: optionalBoolean(input.includeScreenshot, false, 'includeScreenshot'),
    };
    case 'screenshot': return {
      type: 'screenshot',
      path: artifactPath(input.path, ['.png', '.jpg', '.jpeg'], 'screenshot'),
      fullPage: optionalBoolean(input.fullPage, false, 'fullPage'),
    };
    case 'record_start': return {
      type: 'record_start',
      path: artifactPath(input.path, ['.webm'], 'recording'),
      fps: optionalInteger(input.fps, 1, 10, 5, 'fps'),
    };
    case 'record_stop': return { type: 'record_stop' };
    case 'click': {
      const ref = optionalRef(input.ref);
      const x = optionalNumber(input.x, 0, 1280, 'x');
      const y = optionalNumber(input.y, 0, 720, 'y');
      const hasCoordinates = x !== undefined && y !== undefined;
      if ((ref !== undefined) === hasCoordinates) {
        throw new Error('click requires either ref or both x and y');
      }
      if (x !== undefined && y === undefined || x === undefined && y !== undefined) {
        throw new Error('click coordinates require both x and y');
      }
      return { type: 'click', ...(ref ? { ref } : { x: x as number, y: y as number }) };
    }
    case 'type': {
      const ref = optionalRef(input.ref);
      return {
        type: 'type',
        ...(ref ? { ref } : {}),
        text: boundedString(input.text, 20_000, 'text', true),
        clear: optionalBoolean(input.clear, true, 'clear'),
        submit: optionalBoolean(input.submit, false, 'submit'),
      };
    }
    case 'press': return {
      type: 'press',
      key: boundedString(input.key, 64, 'key'),
    };
    case 'select': return {
      type: 'select',
      ref: requiredRef(input.ref),
      value: boundedString(input.value, 2_000, 'value', true),
    };
    case 'scroll': return {
      type: 'scroll',
      deltaX: optionalNumber(input.deltaX, -5_000, 5_000, 'deltaX') ?? 0,
      deltaY: requiredNumber(input.deltaY, -5_000, 5_000, 'deltaY'),
    };
    case 'wait': return {
      type: 'wait',
      milliseconds: requiredInteger(input.milliseconds, 0, 10_000, 'milliseconds'),
    };
    case 'back': return { type: 'back' };
    default: throw new Error(`browser tool ${toolName} is not available`);
  }
}

export interface BrowserHostBackendOptions {
  artifactRoot?: string;
}

export function browserHostEnvironment(artifactRoot?: string): NodeJS.ProcessEnv {
  const names = [
    'PATH',
    'HOME',
    'LANG',
    'LC_ALL',
    'TMPDIR',
    'NODE_ENV',
    'BROWSER_PROFILE_ROOT',
    'CHROMIUM_PACK_DIR',
  ];
  const environment = Object.fromEntries(
    names
      .map((name) => [name, process.env[name]] as const)
      .filter((entry): entry is readonly [string, string] => entry[1] !== undefined),
  );
  if (artifactRoot !== undefined) {
    if (!isAbsolute(artifactRoot)) throw new Error('browser artifact root must be absolute');
    environment.BROWSER_ARTIFACT_ROOT = artifactRoot;
  }
  return environment;
}

function browserHostIdentity(): { uid: number; gid: number } | undefined {
  const rawUid = process.env.RUN_AGENT_UID;
  const rawGid = process.env.RUN_AGENT_GID;
  if (!rawUid && !rawGid) return undefined;
  const uid = Number(rawUid);
  const gid = Number(rawGid);
  if (!Number.isInteger(uid) || uid < 1 || !Number.isInteger(gid) || gid < 1) {
    throw new Error('RUN_AGENT_UID and RUN_AGENT_GID must both be positive integers');
  }
  return { uid, gid };
}

function recordValue(value: JsonValue, label: string): { [key: string]: JsonValue } {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value as { [key: string]: JsonValue };
}

function webUrl(value: JsonValue | undefined): string {
  const raw = boundedString(value, 4_096, 'url');
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('url must be an absolute HTTP or HTTPS URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('url must be an absolute HTTP or HTTPS URL without embedded credentials');
  }
  return parsed.toString();
}

function optionalRef(value: JsonValue | undefined): string | undefined {
  if (value === undefined) return undefined;
  return requiredRef(value);
}

function requiredRef(value: JsonValue | undefined): string {
  const ref = boundedString(value, 16, 'ref');
  if (!/^r[1-9][0-9]{0,4}$/.test(ref)) throw new Error('ref is invalid');
  return ref;
}

function boundedString(
  value: JsonValue | undefined,
  maximum: number,
  label: string,
  allowEmpty = false,
): string {
  if (typeof value !== 'string' || (!allowEmpty && !value) || value.length > maximum) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function optionalBoolean(
  value: JsonValue | undefined,
  fallback: boolean,
  label: string,
): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean`);
  return value;
}

function optionalNumber(
  value: JsonValue | undefined,
  minimum: number,
  maximum: number,
  label: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function requiredNumber(
  value: JsonValue | undefined,
  minimum: number,
  maximum: number,
  label: string,
): number {
  const result = optionalNumber(value, minimum, maximum, label);
  if (result === undefined) throw new Error(`${label} is required`);
  return result;
}

function requiredInteger(
  value: JsonValue | undefined,
  minimum: number,
  maximum: number,
  label: string,
): number {
  const result = requiredNumber(value, minimum, maximum, label);
  if (!Number.isInteger(result)) throw new Error(`${label} must be an integer`);
  return result;
}

function optionalInteger(
  value: JsonValue | undefined,
  minimum: number,
  maximum: number,
  fallback: number,
  label: string,
): number {
  if (value === undefined) return fallback;
  return requiredInteger(value, minimum, maximum, label);
}

function artifactPath(
  value: JsonValue | undefined,
  extensions: readonly string[],
  label: string,
): string {
  const path = boundedString(value, 512, 'path');
  try {
    validateArtifactPath(path);
  } catch {
    throw new Error(`${label} path is invalid`);
  }
  if (!extensions.some((extension) => path.toLowerCase().endsWith(extension))) {
    throw new Error(`${label} path must end in ${extensions.join(', ')}`);
  }
  return path;
}

function assertBoundedText(value: string): void {
  if (typeof value !== 'string' || Buffer.byteLength(value) > MAX_BROWSER_TEXT_BYTES) {
    throw new Error('browser output is invalid or too large');
  }
}

function assertBoundedImage(value: string): void {
  if (!/^data:image\/(?:jpeg|png);base64,/.test(value) || Buffer.byteLength(value) > MAX_BROWSER_IMAGE_BYTES) {
    throw new Error('browser screenshot is invalid or too large');
  }
}

function isBrowserBackendResult(value: unknown): value is BrowserBackendResult {
  return isRecord(value) && typeof value.text === 'string' &&
    (value.imageDataUrl === undefined || typeof value.imageDataUrl === 'string');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
