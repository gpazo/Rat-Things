import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { gunzipSync } from 'node:zlib';

const hookPrefix = '/aws/lambda-microvms/runtime/v1';
const maximumHookBodyBytes = 16 * 1024;
const maximumRunPayloadBytes = 4 * 1024;
const runnerEntry = process.env.AGENT_RUNNER_ENTRY ?? '/opt/agent-runtime/runner.mjs';
const terminatorEntry = process.env.AGENT_TERMINATOR_ENTRY ?? '/opt/agent-runtime/terminate-microvm.mjs';

let activeRun;
let shuttingDown = false;
let serviceTerminationRequested = false;
let selfTerminationStarted = false;

const server = createServer(async (request, response) => {
  response.setHeader('cache-control', 'no-store');
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('x-content-type-options', 'nosniff');

  if (request.method !== 'POST') {
    send(response, 405, { error: 'method_not_allowed' });
    return;
  }

  const operation = request.url?.startsWith(`${hookPrefix}/`)
    ? request.url.slice(hookPrefix.length + 1)
    : undefined;
  if (!['ready', 'validate', 'run', 'resume', 'suspend', 'terminate'].includes(operation)) {
    send(response, 404, { error: 'not_found' });
    return;
  }

  try {
    const body = await readJsonBody(request);
    switch (operation) {
      case 'ready':
      case 'validate':
        validateImage();
        break;
      case 'run':
        startRun(parseRunHook(body));
        break;
      case 'resume':
      case 'suspend':
        // The child and open file descriptors are captured by the service. No
        // process-level action is required for suspend/resume in this batch runner.
        break;
      case 'terminate':
        serviceTerminationRequested = true;
        await terminateActiveRun();
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
  if (process.env.RUN_AGENT_UID !== '10001' || process.env.RUN_AGENT_GID !== '10001') {
    throw new Error('unprivileged agent UID/GID are not configured');
  }
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
  const region = requiredString(payload, 'region', 32, /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/);
  const timeoutSeconds = requiredInteger(payload, 'timeoutSeconds', 1, 28_500);
  const environment = {
    RUN_ID: runId,
    RUN_INPUT_BUCKET: requiredString(payload, 'inputBucket', 63, /^[a-z0-9][a-z0-9.-]+[a-z0-9]$/),
    RUN_INPUT_KEY: requiredString(payload, 'inputKey', 1024),
    RUNS_TABLE_NAME: requiredString(payload, 'runsTableName', 255),
    ARTIFACT_BUCKET: requiredString(payload, 'artifactBucket', 63, /^[a-z0-9][a-z0-9.-]+[a-z0-9]$/),
    AWS_DEFAULT_REGION: region,
    AWS_REGION: region,
    DEFAULT_EXECUTION_BACKEND: 'microvm',
    MICROVM_ID: microvmId,
    RUN_TIMEOUT_SECONDS: String(timeoutSeconds),
  };
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
  return { microvmId, runId, environment };
}

function startRun(run) {
  validateImage();
  if (activeRun) {
    if (activeRun.runId === run.runId && activeRun.microvmId === run.microvmId) return;
    throw new InvalidHookRequest('a different run is already active');
  }

  const child = spawn(process.execPath, [runnerEntry], {
    cwd: '/workspace',
    env: { ...process.env, ...run.environment },
    stdio: 'inherit',
  });
  activeRun = { ...run, child };
  log('info', 'agent runner started', { runId: run.runId, microvmId: run.microvmId, pid: child.pid });
  child.once('error', (error) => {
    log('error', 'agent runner process error', { runId: run.runId, error: error.message });
  });
  child.once('exit', (code, signal) => {
    log(code === 0 ? 'info' : 'error', 'agent runner exited', {
      runId: run.runId,
      code,
      signal,
    });
    if (!serviceTerminationRequested) selfTerminate(run);
  });
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

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('info', 'lifecycle server shutting down', { signal });
  server.close();
  await terminateActiveRun();
  process.exit(0);
}

async function readJsonBody(request) {
  const declaredLength = Number(request.headers['content-length'] ?? 0);
  if (!Number.isInteger(declaredLength) || declaredLength < 0 || declaredLength > maximumHookBodyBytes) {
    throw new InvalidHookRequest('invalid Content-Length');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximumHookBodyBytes) throw new InvalidHookRequest('lifecycle body is too large');
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
