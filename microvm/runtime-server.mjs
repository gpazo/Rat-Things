import {
  chownSync,
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  rmSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { ensureUntrustedUidCannotReachPort } from './runtime-network-policy.mjs';
import { untrustedChildOptions } from './runtime-process-policy.mjs';

const hookPrefix = '/aws/lambda-microvms/runtime/v1';
const maximumHookBodyBytes = 16 * 1024;
const maximumControlBodyBytes = 32 * 1024;
const maximumRunPayloadBytes = 4 * 1024;
const maximumControlEvents = 512;
const maximumControlEventBytes = 64 * 1024;
const controlCommandTimeoutMs = 25_000;
const controlChannel = 'rat-things-agent-control';
const s3FilesMountTimeoutMs = 50_000;
const runnerEntry = process.env.AGENT_RUNNER_ENTRY ?? '/opt/agent-runtime/runner.mjs';
const terminatorEntry = process.env.AGENT_TERMINATOR_ENTRY ?? '/opt/agent-runtime/terminate-microvm.mjs';
const agentUid = Number(process.env.RUN_AGENT_UID ?? 10001);
const agentGid = Number(process.env.RUN_AGENT_GID ?? 10001);

// Codex and Chromium run under `agentUid`. Even with inner full access they
// must not call the root lifecycle/control plane or mutate their own capability envelope.
ensureUntrustedUidCannotReachPort({ uid: agentUid, port: 8080 });

let activeRun;
let shuttingDown = false;
let serviceTerminationRequested = false;
let selfTerminationStarted = false;
let persistentMicrovmId;
let persistentStorage;
let mountWatchdog;
let transientRunState;

const server = createServer(async (request, response) => {
  response.setHeader('cache-control', 'no-store');
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('x-content-type-options', 'nosniff');

  const controlRoute = parseControlRoute(request.url);
  if (controlRoute) {
    try {
      await handleControlRequest(request, response, controlRoute);
    } catch (error) {
      const invalid = error instanceof InvalidHookRequest;
      const conflict = error instanceof RuntimeConflict;
      log('warn', 'agent control operation failed', {
        operation: controlRoute.operation,
        error: error instanceof Error ? error.message : String(error),
      });
      send(response, invalid ? 400 : conflict ? 409 : 500, {
        error: invalid
          ? 'invalid_control_request'
          : conflict
            ? 'agent_control_unavailable'
            : 'agent_control_failed',
        message: error instanceof Error ? error.message.slice(0, 1_000) : 'agent control failed',
      });
    }
    return;
  }

  if (request.method !== 'POST') {
    send(response, 405, { error: 'method_not_allowed' });
    return;
  }

  const isSessionRun = request.url === '/agent-runtime/v1/runs';
  const operation = request.url?.startsWith(`${hookPrefix}/`)
    ? request.url.slice(hookPrefix.length + 1)
    : undefined;
  if (!isSessionRun && !['ready', 'validate', 'run', 'resume', 'suspend', 'terminate'].includes(operation)) {
    send(response, 404, { error: 'not_found' });
    return;
  }

  try {
    const body = await readJsonBody(request);
    if (isSessionRun) {
      if (!persistentMicrovmId) throw new InvalidHookRequest('this MicroVM is not a persistent session');
      startRun(parseRunHook({ microvmId: persistentMicrovmId, ...body }));
      send(response, 202, { ok: true, operation: 'session-run' });
      return;
    }
    switch (operation) {
      case 'ready':
      case 'validate':
        validateImage();
        break;
      case 'run':
        startRun(parseRunHook(body));
        break;
      case 'resume':
        if (persistentStorage) ensureS3FilesMounted(persistentStorage);
        break;
      case 'suspend':
        syncPersistentStorage();
        break;
      case 'terminate':
        serviceTerminationRequested = true;
        await terminateActiveRun();
        syncPersistentStorage();
        break;
    }
    send(response, 200, { ok: true, operation });
  } catch (error) {
    const invalid = error instanceof InvalidHookRequest;
    log('warn', 'lifecycle operation failed', {
      operation,
      error: error instanceof Error ? error.message : String(error),
    });
    send(response, invalid ? 400 : 500, {
      error: invalid ? 'invalid_lifecycle_request' : 'lifecycle_operation_failed',
    });
  }
});

server.on('clientError', (_error, socket) => {
  socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
});

server.listen(8080, '0.0.0.0', () => {
  log('info', 'Lambda MicroVM lifecycle server listening', { port: 8080 });
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    void shutdown(signal);
  });
}

function validateImage() {
  if (typeof process.getuid === 'function' && process.getuid() !== 0) {
    throw new Error('lifecycle server must run as root');
  }
  if (!existsSync(runnerEntry)) throw new Error('bundled runner is missing');
  if (!existsSync(terminatorEntry)) throw new Error('bundled MicroVM terminator is missing');
  if (!existsSync('/sbin/mount.s3files') && !existsSync('/usr/sbin/mount.s3files')) {
    throw new Error('amazon-efs-utils 3.x S3 Files mount helper is missing');
  }
  if (process.env.RUN_AGENT_UID !== '10001' || process.env.RUN_AGENT_GID !== '10001') {
    throw new Error('unprivileged agent UID/GID are not configured');
  }
  ensureUntrustedUidCannotReachPort({ uid: agentUid, port: 8080 });
}

function parseRunHook(body) {
  const microvmId = requiredString(body, 'microvmId', 256, /^[A-Za-z0-9._:-]+$/);
  const encoded = requiredString(body, 'runHookPayload', maximumRunPayloadBytes);
  let decoded = encoded;
  if (encoded.startsWith('gzip-base64:')) {
    try {
      decoded = gunzipSync(Buffer.from(encoded.slice('gzip-base64:'.length), 'base64'), {
        maxOutputLength: 16 * 1024,
      }).toString('utf8');
    } catch {
      throw new InvalidHookRequest('compressed runHookPayload is invalid');
    }
  }

  let payload;
  try {
    payload = JSON.parse(decoded);
  } catch {
    throw new InvalidHookRequest('runHookPayload must be valid JSON');
  }
  if (!isRecord(payload) || (payload.version !== 1 && payload.version !== '1')) {
    throw new InvalidHookRequest('unsupported runHookPayload version');
  }

  const runId = requiredString(payload, 'runId', 128, /^[A-Za-z0-9-]+$/);
  const generation = requiredString(payload, 'executionGeneration', 64, /^[a-f0-9]{64}$/);
  const region = requiredString(payload, 'region', 32, /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/);
  const timeoutSeconds = requiredInteger(payload, 'timeoutSeconds', 1, 28_500);
  const environment = {
    RUN_ID: runId,
    EXECUTION_GENERATION: generation,
    RUN_INPUT_BUCKET: requiredString(payload, 'inputBucket', 63, /^[a-z0-9][a-z0-9.-]+[a-z0-9]$/),
    RUN_INPUT_KEY: requiredString(payload, 'inputKey', 1024),
    RUNS_TABLE_NAME: requiredString(payload, 'runsTableName', 255),
    INTEGRATIONS_TABLE_NAME: requiredString(payload, 'integrationsTableName', 255),
    ARTIFACT_BUCKET: requiredString(payload, 'artifactBucket', 63, /^[a-z0-9][a-z0-9.-]+[a-z0-9]$/),
    AWS_DEFAULT_REGION: region,
    AWS_REGION: region,
    DEFAULT_EXECUTION_BACKEND: 'microvm',
    MICROVM_ID: microvmId,
    RUN_TIMEOUT_SECONDS: String(timeoutSeconds),
    RUN_HEARTBEAT_INTERVAL_MS: String(requiredInteger(payload, 'heartbeatIntervalMs', 10, 300_000)),
  };
  if (typeof payload.persistentSession !== 'boolean') {
    throw new InvalidHookRequest('persistentSession must be a boolean');
  }
  environment.PERSISTENT_SESSION = String(payload.persistentSession);
  let storage;
  if (payload.persistentSession && payload.s3FilesFileSystemId !== undefined) {
    const storageKey = requiredString(
      payload,
      'conversationStorageKey',
      64,
      /^[a-f0-9]{64}$/,
    );
    storage = {
      fileSystemId: requiredString(payload, 's3FilesFileSystemId', 64, /^fs-[A-Za-z0-9]+$/),
      accessPointId: requiredString(payload, 's3FilesAccessPointId', 64, /^fsap-[A-Za-z0-9]+$/),
      mountTargetIp: requiredString(payload, 's3FilesMountTargetIp', 45, /^[0-9a-fA-F:.]+$/),
      mountRoot: process.env.S3_FILES_MOUNT_ROOT ?? '/mnt/rat-things-state',
      storageKey,
    };
    environment.S3_FILES_ENABLED = 'true';
    environment.CONVERSATION_STORAGE_KEY = storageKey;
  }
  optionalEnvironment(environment, 'AGENT_THREAD_ID', payload.agentThreadId, 256, /^[A-Za-z0-9._:-]+$/);
  optionalEnvironment(environment, 'TRACE_ID', payload.traceId, 256);
  optionalEnvironment(environment, 'EVENT_BUS_NAME', payload.eventBusName, 256);
  optionalEnvironment(
    environment,
    'BEDROCK_API_KEY_SECRET_ARN',
    payload.bedrockApiKeySecretArn,
    2048,
    /^arn:[A-Za-z0-9-]+:secretsmanager:/,
  );
  const repositoryHosts = csvValues(
    requiredString(payload, 'allowedRepositoryHosts', 2048),
    'allowedRepositoryHosts',
  );
  if (repositoryHosts.some((host) => !/^[A-Za-z0-9.-]+$/.test(host))) {
    throw new InvalidHookRequest('allowedRepositoryHosts is invalid');
  }
  environment.ALLOWED_REPOSITORY_HOSTS = repositoryHosts.join(',');

  const sandboxModes = csvValues(
    requiredString(payload, 'allowedSandboxModes', 128),
    'allowedSandboxModes',
  );
  if (sandboxModes.some((mode) =>
    !['read-only', 'workspace-write', 'danger-full-access'].includes(mode))) {
    throw new InvalidHookRequest('allowedSandboxModes is invalid');
  }
  environment.ALLOWED_SANDBOX_MODES = sandboxModes.join(',');

  const defaultSandboxMode = requiredString(payload, 'defaultSandboxMode', 32);
  if (!sandboxModes.includes(defaultSandboxMode)) {
    throw new InvalidHookRequest('defaultSandboxMode must be enabled by allowedSandboxModes');
  }
  environment.DEFAULT_SANDBOX_MODE = defaultSandboxMode;
  if (typeof payload.defaultAgentNetworkAccess !== 'boolean') {
    throw new InvalidHookRequest('defaultAgentNetworkAccess must be a boolean');
  }
  environment.CODEX_TOOL_NETWORK_ACCESS = String(payload.defaultAgentNetworkAccess);

  const driver = requiredString(payload, 'defaultAgentDriver', 32);
  if (!['mock', 'codex'].includes(driver)) {
    throw new InvalidHookRequest('defaultAgentDriver is invalid');
  }
  environment.DEFAULT_AGENT_DRIVER = driver;
  optionalEnvironment(environment, 'DEFAULT_MODEL', payload.defaultModel, 256);
  if (typeof payload.allowAgentAwsCredentialChain !== 'boolean') {
    throw new InvalidHookRequest('allowAgentAwsCredentialChain must be a boolean');
  }
  environment.ALLOW_AGENT_AWS_CREDENTIAL_CHAIN = String(payload.allowAgentAwsCredentialChain);
  return { microvmId, runId, generation, persistentSession: payload.persistentSession, environment, storage };
}

function startRun(run) {
  const startupStartedAt = Date.now();
  let storageMountDurationMs = 0;
  let storagePreparationDurationMs = 0;
  let storageAlreadyMounted = false;
  validateImage();
  if (activeRun) {
    if (activeRun.runId === run.runId && activeRun.microvmId === run.microvmId) return;
    throw new InvalidHookRequest('a different run is already active');
  }
  if (persistentMicrovmId && persistentMicrovmId !== run.microvmId) {
    throw new InvalidHookRequest('persistent session MicroVM ID changed');
  }
  if (run.persistentSession) persistentMicrovmId = run.microvmId;
  if (run.storage) {
    const mount = ensureS3FilesMounted(run.storage);
    storageMountDurationMs = mount.durationMs;
    storageAlreadyMounted = mount.alreadyMounted;
    const preparationStartedAt = Date.now();
    const stateRoot = join(run.storage.mountRoot, run.storage.storageKey);
    prepareConversationState(stateRoot);
    prepareTransientRunState(stateRoot, run.runId);
    storagePreparationDurationMs = Date.now() - preparationStartedAt;
    run.environment.CONVERSATION_STATE_ROOT = stateRoot;
    run.environment.CODEX_HOME = join(stateRoot, 'codex-home');
    run.environment.BROWSER_PROFILE_ROOT = join(stateRoot, 'codex-home', 'browser-profile');
    run.environment.WORKSPACE_ROOT = stateRoot;
    persistentStorage = run.storage;
  }

  const child = spawn(process.execPath, [runnerEntry], untrustedChildOptions({
    uid: agentUid,
    gid: agentGid,
    environment: { ...process.env, ...run.environment },
  }));
  activeRun = {
    ...run,
    child,
    control: {
      events: [],
      pendingRequests: new Map(),
      commandWaiters: new Map(),
      nextSequence: 1,
      ready: false,
    },
  };
  child.on('message', (message) => handleRunnerControlMessage(run.runId, message));
  log('info', 'agent runner started', {
    runId: run.runId,
    microvmId: run.microvmId,
    pid: child.pid,
    startupDurationMs: Date.now() - startupStartedAt,
    storageMountDurationMs,
    storagePreparationDurationMs,
    storageAlreadyMounted,
  });
  child.once('error', (error) => {
    log('error', 'agent runner process error', { runId: run.runId, error: error.message });
  });
  child.once('exit', (code, signal) => {
    log(code === 0 ? 'info' : 'error', 'agent runner exited', {
      runId: run.runId,
      code,
      signal,
    });
    rejectControlWaiters(activeRun, new Error('agent runner exited'));
    activeRun = undefined;
    if (!serviceTerminationRequested && !run.persistentSession) selfTerminate(run);
  });
}

function parseControlRoute(rawUrl) {
  if (typeof rawUrl !== 'string') return undefined;
  const url = new URL(rawUrl, 'http://agent-runtime.internal');
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts[0] !== 'agent-runtime' || parts[1] !== 'v1' || parts[2] !== 'runs') return undefined;
  if (parts.length < 5) return undefined;
  const runId = parts[3];
  if (!/^[A-Za-z0-9-]{1,128}$/.test(runId)) return undefined;
  if (parts.length === 5 && ['events', 'health', 'steer', 'interrupt', 'computer'].includes(parts[4])) {
    return { runId, operation: parts[4], query: url.searchParams };
  }
  if (parts.length === 6 && parts[4] === 'computer' && ['takeover', 'action', 'teach'].includes(parts[5])) {
    return { runId, operation: `computer_${parts[5]}`, query: url.searchParams };
  }
  if (parts.length === 7 && parts[4] === 'requests' && parts[6] === 'respond') {
    return { runId, operation: 'respond', requestId: decodeControlId(parts[5]), query: url.searchParams };
  }
  return undefined;
}

async function handleControlRequest(request, response, route) {
  const run = activeRun;
  if (route.operation === 'health') {
    if (request.method !== 'GET') {
      send(response, 405, { error: 'method_not_allowed' });
      return;
    }
    if (!run) {
      send(response, 410, { error: 'execution_inactive' });
      return;
    }
    if (run.runId !== route.runId) {
      send(response, 409, { error: 'execution_identity_conflict' });
      return;
    }
    send(response, 200, {
      runId: run.runId,
      generation: run.generation,
      active: true,
      workerConnected: run.child.connected,
    });
    return;
  }
  if (!run || run.runId !== route.runId) {
    throw new RuntimeConflict(`run ${route.runId} is not active in this MicroVM`);
  }
  if (route.operation === 'events') {
    if (request.method !== 'GET') {
      send(response, 405, { error: 'method_not_allowed' });
      return;
    }
    const after = boundedQueryInteger(route.query.get('after'), 'after', 0, Number.MAX_SAFE_INTEGER, 0);
    const limit = boundedQueryInteger(route.query.get('limit'), 'limit', 1, 100, 100);
    const events = run.control.events.filter((event) => event.sequence > after).slice(0, limit);
    send(response, 200, {
      runId: run.runId,
      active: true,
      ready: run.control.ready,
      oldestSequence: run.control.events[0]?.sequence ?? run.control.nextSequence,
      nextSequence: run.control.nextSequence,
      events,
      pendingRequests: [...run.control.pendingRequests.values()],
      ...(run.control.turn ? { turn: run.control.turn } : {}),
    });
    return;
  }
  if (route.operation === 'computer') {
    if (request.method !== 'GET') {
      send(response, 405, { error: 'method_not_allowed' });
      return;
    }
    send(response, 200, await sendControlCommand(run, { type: 'computer_snapshot' }));
    return;
  }
  if (request.method !== 'POST') {
    send(response, 405, { error: 'method_not_allowed' });
    return;
  }
  const body = await readJsonBody(request, maximumControlBodyBytes);
  switch (route.operation) {
    case 'steer': {
      const prompt = requiredString(body, 'prompt', 12 * 1024);
      await sendControlCommand(run, { type: 'steer', prompt });
      break;
    }
    case 'interrupt':
      await sendControlCommand(run, { type: 'interrupt' });
      break;
    case 'respond':
      if (!route.requestId || !run.control.pendingRequests.has(route.requestId)) {
        throw new RuntimeConflict(`server request ${route.requestId ?? ''} is not pending`);
      }
      if (!Object.prototype.hasOwnProperty.call(body, 'result')) {
        throw new InvalidHookRequest('response result is required');
      }
      await sendControlCommand(run, {
        type: 'respond',
        requestId: route.requestId,
        result: body.result,
      });
      run.control.pendingRequests.delete(route.requestId);
      break;
    case 'computer_takeover': {
      const control = requiredString(body, 'control', 16);
      if (!['human', 'agent'].includes(control)) {
        throw new InvalidHookRequest('computer control must be human or agent');
      }
      const result = await sendControlCommand(run, {
        type: control === 'human' ? 'computer_takeover_start' : 'computer_takeover_stop',
      });
      send(response, 200, result);
      return;
    }
    case 'computer_action': {
      if (!isRecord(body.action) || typeof body.action.type !== 'string') {
        throw new InvalidHookRequest('computer action is invalid');
      }
      const result = await sendControlCommand(run, {
        type: 'computer_action',
        action: body.action,
      });
      send(response, 200, result);
      return;
    }
    case 'computer_teach': {
      const action = requiredString(body, 'action', 16);
      if (action === 'start') {
        const result = await sendControlCommand(run, {
          type: 'teach_start',
          name: requiredString(body, 'name', 120),
          ...(body.goal === undefined ? {} : { goal: requiredString(body, 'goal', 4_000) }),
        });
        send(response, 200, result);
        return;
      }
      if (action === 'stop') {
        if (typeof body.discard !== 'boolean') {
          throw new InvalidHookRequest('demonstration discard must be boolean');
        }
        const result = await sendControlCommand(run, {
          type: 'teach_stop',
          discard: body.discard,
        });
        send(response, 200, result);
        return;
      }
      throw new InvalidHookRequest('demonstration action must be start or stop');
    }
    default:
      throw new InvalidHookRequest('control operation is invalid');
  }
  send(response, 202, { ok: true, operation: route.operation });
}

function handleRunnerControlMessage(runId, message) {
  const run = activeRun;
  if (
    !run ||
    run.runId !== runId ||
    !isRecord(message) ||
    message.channel !== controlChannel ||
    message.runId !== runId ||
    typeof message.type !== 'string'
  ) return;
  switch (message.type) {
    case 'event':
      appendControlEvent(run, message.event);
      break;
    case 'server-request': {
      const request = normalizedServerRequest(message.request);
      if (request) run.control.pendingRequests.set(request.requestId, request);
      break;
    }
    case 'turn-ready':
      if (
        isRecord(message.turn) &&
        typeof message.turn.threadId === 'string' &&
        typeof message.turn.turnId === 'string'
      ) {
        run.control.ready = true;
        run.control.turn = {
          threadId: message.turn.threadId.slice(0, 256),
          turnId: message.turn.turnId.slice(0, 256),
        };
      }
      break;
    case 'command-result': {
      if (typeof message.commandId !== 'string') break;
      const waiter = run.control.commandWaiters.get(message.commandId);
      if (!waiter) break;
      run.control.commandWaiters.delete(message.commandId);
      clearTimeout(waiter.timer);
      if (message.ok === true) waiter.resolve(message.result);
      else waiter.reject(new RuntimeConflict(
        typeof message.error === 'string' ? message.error.slice(0, 1_000) : 'agent rejected control command',
      ));
      break;
    }
  }
}

function appendControlEvent(run, value) {
  if (!isRecord(value) || typeof value.method !== 'string') return;
  const normalized = jsonClone({
    sequence: run.control.nextSequence,
    occurredAt: new Date().toISOString(),
    method: value.method.slice(0, 256),
    params: isRecord(value.params) ? value.params : {},
    ...(typeof value.requestId === 'string' || typeof value.requestId === 'number'
      ? { requestId: String(value.requestId).slice(0, 256) }
      : {}),
  });
  const encoded = JSON.stringify(normalized);
  const event = Buffer.byteLength(encoded) <= maximumControlEventBytes
    ? normalized
    : {
      sequence: run.control.nextSequence,
      occurredAt: new Date().toISOString(),
      method: value.method.slice(0, 256),
      params: { truncated: true },
    };
  run.control.nextSequence += 1;
  run.control.events.push(event);
  if (run.control.events.length > maximumControlEvents) run.control.events.shift();
}

function normalizedServerRequest(value) {
  if (
    !isRecord(value) ||
    (typeof value.requestId !== 'string' && typeof value.requestId !== 'number') ||
    typeof value.method !== 'string'
  ) return undefined;
  return jsonClone({
    requestId: String(value.requestId).slice(0, 256),
    method: value.method.slice(0, 256),
    params: isRecord(value.params) ? value.params : {},
    receivedAt: new Date().toISOString(),
  });
}

function sendControlCommand(run, command) {
  if (!run.child.connected) throw new RuntimeConflict('agent control channel is not connected');
  const commandId = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      run.control.commandWaiters.delete(commandId);
      reject(new RuntimeConflict('agent control command timed out'));
    }, controlCommandTimeoutMs);
    run.control.commandWaiters.set(commandId, { resolve, reject, timer });
    run.child.send(
      { channel: controlChannel, runId: run.runId, commandId, ...command },
      (error) => {
        if (!error) return;
        const waiter = run.control.commandWaiters.get(commandId);
        if (!waiter) return;
        run.control.commandWaiters.delete(commandId);
        clearTimeout(waiter.timer);
        reject(new RuntimeConflict(`agent control send failed: ${error.message}`));
      },
    );
  });
}

function rejectControlWaiters(run, error) {
  if (!run?.control) return;
  for (const waiter of run.control.commandWaiters.values()) {
    clearTimeout(waiter.timer);
    waiter.reject(error);
  }
  run.control.commandWaiters.clear();
}

function selfTerminate(run) {
  if (selfTerminationStarted) return;
  selfTerminationStarted = true;
  const terminator = spawn(process.execPath, [terminatorEntry], {
    cwd: '/opt/agent-runtime',
    env: {
      ...process.env,
      AWS_DEFAULT_REGION: run.environment.AWS_REGION,
      AWS_REGION: run.environment.AWS_REGION,
      MICROVM_ID: run.microvmId,
    },
    stdio: 'inherit',
  });
  terminator.once('error', (error) => {
    log('error', 'failed to launch MicroVM self-terminator', { runId: run.runId, error: error.message });
  });
  terminator.once('exit', (code, signal) => {
    if (code !== 0) {
      log('error', 'MicroVM self-terminator exited unsuccessfully', { runId: run.runId, code, signal });
    }
  });
}

async function terminateActiveRun() {
  const run = activeRun;
  if (!run || run.child.exitCode !== null || run.child.signalCode !== null) return;
  run.child.kill('SIGTERM');
  const exited = await Promise.race([
    new Promise((resolve) => run.child.once('exit', () => resolve(true))),
    new Promise((resolve) => setTimeout(() => resolve(false), 10_000)),
  ]);
  if (!exited) run.child.kill('SIGKILL');
}

function ensureS3FilesMounted(storage) {
  const startedAt = Date.now();
  mkdirSync(storage.mountRoot, { recursive: true, mode: 0o755 });
  // Require the state directory itself to be a mount point. `findmnt -T`
  // reports the parent filesystem (normally `/`) for an unmounted directory,
  // which would silently keep persistent state on the MicroVM's local disk.
  const mounted = spawnSync('findmnt', ['--mountpoint', storage.mountRoot, '--noheadings'], {
    encoding: 'utf8',
    timeout: 5_000,
  });
  if (mounted.status === 0 && mounted.stdout.trim()) {
    return { alreadyMounted: true, durationMs: Date.now() - startedAt };
  }

  ensureMountWatchdogRunning();

  const options = [
    `accesspoint=${storage.accessPointId}`,
    `mounttargetip=${storage.mountTargetIp}`,
  ].join(',');
  const result = spawnSync(
    'mount',
    ['-t', 's3files', '-o', options, storage.fileSystemId, storage.mountRoot],
    { encoding: 'utf8', timeout: s3FilesMountTimeoutMs },
  );
  if (result.status !== 0) {
    const diagnostic = `${result.error?.message ?? ''}\n${result.stderr ?? ''}\n${result.stdout ?? ''}`
      .trim()
      .slice(-2_000);
    throw new Error(`S3 Files mount failed (${result.status ?? 'signal'}): ${diagnostic || 'no diagnostic output'}`);
  }
  log('info', 'S3 Files conversation state mounted', {
    fileSystemId: storage.fileSystemId,
    accessPointId: storage.accessPointId,
    mountRoot: storage.mountRoot,
    durationMs: Date.now() - startedAt,
  });
  return { alreadyMounted: false, durationMs: Date.now() - startedAt };
}

function ensureMountWatchdogRunning() {
  if (mountWatchdog && mountWatchdog.exitCode === null && mountWatchdog.signalCode === null) return;
  const executable = [
    '/usr/bin/amazon-efs-mount-watchdog',
    '/sbin/amazon-efs-mount-watchdog',
  ].find((candidate) => existsSync(candidate));
  if (!executable) throw new Error('amazon-efs-utils mount watchdog is missing');

  mountWatchdog = spawn(executable, [], { stdio: 'inherit' });
  mountWatchdog.once('error', (error) => {
    log('error', 'S3 Files mount watchdog failed to start', { error: error.message });
  });
  mountWatchdog.once('exit', (code, signal) => {
    if (!shuttingDown) {
      log('warn', 'S3 Files mount watchdog exited', { code, signal });
    }
  });
}

function prepareConversationState(stateRoot) {
  const uid = Number(process.env.RUN_AGENT_UID ?? 10001);
  const gid = Number(process.env.RUN_AGENT_GID ?? 10001);
  const codexHome = join(stateRoot, 'codex-home');
  const workspace = join(stateRoot, 'workspace');
  for (const directory of [stateRoot, codexHome, workspace]) {
    ensureOwnedDirectory(directory, uid, gid);
  }
  const config = join(codexHome, 'config.toml');
  if (!existsSync(config)) {
    const template = process.env.CODEX_CONFIG_TEMPLATE ?? '/opt/agent-runtime/config/codex.toml';
    copyFileSync(template, config);
    chownSync(config, uid, gid);
    chmodSync(config, 0o600);
  }
}

function prepareTransientRunState(stateRoot, runId) {
  const uid = Number(process.env.RUN_AGENT_UID ?? 10001);
  const gid = Number(process.env.RUN_AGENT_GID ?? 10001);
  const root = join(process.env.RUN_EPHEMERAL_ROOT ?? '/tmp/rat-things-runs', runId);
  const codexHome = join(stateRoot, 'codex-home');
  const workspace = join(stateRoot, 'workspace');
  const directories = [
    ['codex-dot-tmp', join(codexHome, '.tmp')],
    ['codex-tmp', join(codexHome, 'tmp')],
    ['codex-cache', join(codexHome, 'cache')],
    ['plugin-cache', join(codexHome, 'plugins', 'cache')],
    ['artifacts', join(workspace, '.rat-things', 'artifacts')],
  ];

  if (
    transientRunState &&
    transientRunState.targets.length === directories.length &&
    transientRunState.targets.every((target, index) =>
      target === directories[index][1] && isMountTarget(target))
  ) {
    log('info', 'ephemeral agent directories reused', {
      runId,
      directoryCount: directories.length,
    });
    return;
  }

  for (const target of transientRunState?.targets ?? directories.map(([, target]) => target)) {
    unmountBindTarget(target);
  }
  if (transientRunState?.root) rmSync(transientRunState.root, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chownSync(root, uid, gid);

  const mounted = [];
  try {
    for (const [name, target] of directories) {
      const source = join(root, name);
      ensureOwnedDirectory(join(target, '..'), uid, gid);
      rmSync(target, { recursive: true, force: true });
      ensureOwnedDirectory(source, uid, gid);
      ensureOwnedDirectory(target, uid, gid);
      const result = spawnSync('mount', ['--bind', source, target], {
        encoding: 'utf8',
        timeout: 5_000,
      });
      if (result.status !== 0) {
        const diagnostic = `${result.error?.message ?? ''}\n${result.stderr ?? ''}\n${result.stdout ?? ''}`
          .trim()
          .slice(-1_000);
        throw new Error(`ephemeral bind mount failed for ${name}: ${diagnostic || 'no diagnostic output'}`);
      }
      mounted.push(target);
    }
  } catch (error) {
    for (const target of mounted.reverse()) unmountBindTarget(target);
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  transientRunState = { root, targets: directories.map(([, target]) => target) };
  log('info', 'ephemeral agent directories mounted', {
    runId,
    directoryCount: directories.length,
  });
}

function ensureOwnedDirectory(directory, uid, gid) {
  if (existsSync(directory)) {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      rmSync(directory, { recursive: true, force: true });
    }
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chownSync(directory, uid, gid);
  chmodSync(directory, 0o700);
}

function unmountBindTarget(target) {
  if (!isMountTarget(target)) return;
  const result = spawnSync('umount', [target], { encoding: 'utf8', timeout: 5_000 });
  if (result.status !== 0) {
    const diagnostic = `${result.stderr ?? ''}\n${result.stdout ?? ''}`.trim().slice(-1_000);
    throw new Error(`ephemeral bind unmount failed: ${diagnostic || 'no diagnostic output'}`);
  }
}

function isMountTarget(target) {
  if (!existsSync(target)) return false;
  const mounted = spawnSync('findmnt', ['--mountpoint', target, '--noheadings'], {
    encoding: 'utf8',
    timeout: 5_000,
  });
  return mounted.status === 0 && Boolean(mounted.stdout.trim());
}

function syncPersistentStorage() {
  if (!persistentStorage) return;
  const result = spawnSync('sync', ['-f', persistentStorage.mountRoot], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (result.status !== 0) {
    log('warn', 'S3 Files sync failed', {
      error: `${result.stderr ?? ''}\n${result.stdout ?? ''}`.trim().slice(-1_000),
    });
  }
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('info', 'lifecycle server shutting down', { signal });
  server.close();
  await terminateActiveRun();
  if (mountWatchdog && mountWatchdog.exitCode === null && mountWatchdog.signalCode === null) {
    mountWatchdog.kill('SIGTERM');
  }
  process.exit(0);
}

async function readJsonBody(request, maximumBytes = maximumHookBodyBytes) {
  const declaredLength = Number(request.headers['content-length'] ?? 0);
  if (!Number.isInteger(declaredLength) || declaredLength < 0 || declaredLength > maximumBytes) {
    throw new InvalidHookRequest('invalid Content-Length');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximumBytes) throw new InvalidHookRequest('request body is too large');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!isRecord(value)) throw new Error('not an object');
    return value;
  } catch {
    throw new InvalidHookRequest('lifecycle body must be a JSON object');
  }
}

function requiredString(value, key, maximumLength, pattern) {
  const result = value[key];
  if (typeof result !== 'string' || result.length === 0 || result.includes('\0') || Buffer.byteLength(result) > maximumLength) {
    throw new InvalidHookRequest(`${key} must be a bounded non-empty string`);
  }
  if (pattern && !pattern.test(result)) throw new InvalidHookRequest(`${key} has an invalid format`);
  return result;
}

function requiredInteger(value, key, minimum, maximum) {
  const result = value[key];
  if (!Number.isInteger(result) || result < minimum || result > maximum) {
    throw new InvalidHookRequest(`${key} must be an integer from ${minimum} through ${maximum}`);
  }
  return result;
}

function boundedQueryInteger(value, label, minimum, maximum, fallback) {
  if (value === null || value === '') return fallback;
  const result = Number(value);
  if (!Number.isInteger(result) || result < minimum || result > maximum) {
    throw new InvalidHookRequest(`${label} query parameter is invalid`);
  }
  return result;
}

function optionalString(value, label, maximumLength) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.includes('\0') || Buffer.byteLength(value) > maximumLength) {
    throw new InvalidHookRequest(`${label} is invalid`);
  }
  return value;
}

function decodeControlId(value) {
  try {
    const decoded = decodeURIComponent(value);
    if (!decoded || decoded.length > 256 || decoded.includes('\0') || decoded.includes('/')) return undefined;
    return decoded;
  } catch {
    return undefined;
  }
}

function jsonClone(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return { invalid: true };
  }
}

function csvValues(value, label) {
  const values = value.split(',').map((item) => item.trim()).filter(Boolean);
  if (values.length === 0 || new Set(values).size !== values.length) {
    throw new InvalidHookRequest(`${label} must be a non-empty comma-separated set`);
  }
  return values;
}

function optionalEnvironment(environment, name, value, maximumLength, pattern) {
  if (value === undefined || value === null || value === '') return;
  if (typeof value !== 'string' || value.includes('\0') || Buffer.byteLength(value) > maximumLength || (pattern && !pattern.test(value))) {
    throw new InvalidHookRequest(`${name} has an invalid value`);
  }
  environment[name] = value;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function send(response, status, value) {
  response.statusCode = status;
  response.end(JSON.stringify(value));
}

function log(level, message, fields = {}) {
  process.stdout.write(`${JSON.stringify({ level, message, ...fields })}\n`);
}

class InvalidHookRequest extends Error {}
class RuntimeConflict extends Error {}
