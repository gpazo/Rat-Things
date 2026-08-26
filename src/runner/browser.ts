import { fork, type ChildProcess } from 'node:child_process';
import { isAbsolute } from 'node:path';
import type { JsonValue } from '../domain/contracts.js';
import { validateArtifactPath } from '../domain/artifacts.js';

// `browser` is reserved by the Responses runtime, so host-provided dynamic
// tools use a Rat Things-specific namespace.
export const BROWSER_TOOL_NAMESPACE = 'rat_browser';
const MAX_BROWSER_TEXT_BYTES = 64 * 1024;
const MAX_BROWSER_IMAGE_BYTES = 4 * 1024 * 1024;

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

  public constructor(private readonly backend: BrowserBackend = new BrowserHostBackend()) {}

  public async call(call: BrowserToolCall, signal?: AbortSignal): Promise<BrowserToolResponse> {
    if (call.namespace !== BROWSER_TOOL_NAMESPACE) {
      throw new Error(`browser tool namespace must be ${BROWSER_TOOL_NAMESPACE}`);
    }
    const command = parseBrowserCommand(call.tool, call.arguments);
    const result = await this.backend.execute(command, signal);
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

  public close(): Promise<void> {
    return this.backend.close();
  }
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
