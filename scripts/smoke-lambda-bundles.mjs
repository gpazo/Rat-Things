import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Match the common environment Terraform supplies so module-level Lambda
// initialization is exercised without making any AWS requests.
process.env.AWS_REGION ||= 'us-west-2';
process.env.RUNS_TABLE_NAME ||= 'bundle-smoke-runs';
process.env.ARTIFACT_BUCKET ||= 'bundle-smoke-artifacts';
process.env.RUN_QUEUE_URL ||= 'https://sqs.us-west-2.amazonaws.com/000000000000/bundle-smoke-runs';
process.env.EVENT_BUS_NAME ||= 'bundle-smoke-runs';
process.env.MICROVM_IMAGE_PARAMETER_NAME ||= '/bundle-smoke/microvm/image';
process.env.MICROVM_IMAGE_VERSION_PARAMETER_NAME ||= '/bundle-smoke/microvm/version';
process.env.MICROVM_EXECUTION_ROLE_ARN ||=
  'arn:aws:iam::000000000000:role/bundle-smoke-microvm-execution';
process.env.MICROVM_LOG_GROUP_NAME ||= '/bundle-smoke/microvms';
process.env.INTEGRATIONS_TABLE_NAME ||= 'bundle-smoke-integrations';
process.env.DEPLOYMENT_ID ||= 'bundle-smoke';
process.env.AUDIT_QUEUE_URL ||= 'https://sqs.us-west-2.amazonaws.com/000000000000/bundle-smoke-audit';
process.env.DEFINITION_BUCKET ||= 'bundle-smoke-definitions';
process.env.THING_SCHEDULE_GROUP_NAME ||= 'bundle-smoke-things';
process.env.THING_SCHEDULE_TARGET_ARN ||= 'arn:aws:lambda:us-west-2:000000000000:function:bundle-smoke-thing-schedule';
process.env.THING_SCHEDULE_ROLE_ARN ||= 'arn:aws:iam::000000000000:role/bundle-smoke-thing-schedule';
const fixtureEnvironment = {
  RUNS_TABLE_NAME: 'bundle-smoke-runs', ARTIFACT_BUCKET: 'bundle-smoke-artifacts',
  RUN_QUEUE_URL: 'https://sqs.us-west-2.amazonaws.com/000000000000/bundle-smoke-runs',
  EVENT_BUS_NAME: 'bundle-smoke-runs', MICROVM_IMAGE_PARAMETER_NAME: '/bundle-smoke/microvm/image',
  MICROVM_IMAGE_VERSION_PARAMETER_NAME: '/bundle-smoke/microvm/version',
  MICROVM_EXECUTION_ROLE_ARN: 'arn:aws:iam::000000000000:role/bundle-smoke-microvm-execution',
  MICROVM_LOG_GROUP_NAME: '/bundle-smoke/microvms', INTEGRATIONS_TABLE_NAME: 'bundle-smoke-integrations',
  DEPLOYMENT_ID: 'bundle-smoke', AUDIT_QUEUE_URL: 'https://sqs.us-west-2.amazonaws.com/000000000000/bundle-smoke-audit',
  DEFINITION_BUCKET: 'bundle-smoke-definitions', THING_SCHEDULE_GROUP_NAME: 'bundle-smoke-things',
  THING_SCHEDULE_TARGET_ARN: 'arn:aws:lambda:us-west-2:000000000000:function:bundle-smoke-thing-schedule',
  THING_SCHEDULE_ROLE_ARN: 'arn:aws:iam::000000000000:role:bundle-smoke-thing-schedule',
};
const lambdaRoot = resolve('dist/lambdas');
const lambdaNames = (await readdir(lambdaRoot)).sort();

for (const name of lambdaNames) {
  const bundleUrl = pathToFileURL(resolve(lambdaRoot, name, 'index.mjs')).href;
  const bundle = await import(bundleUrl);
  assert.equal(typeof bundle.handler, 'function', `${name} bundle must export a handler`);

  if (name === 'control') {
    const result = await bundle.handler({
      rawPath: '/health',
      headers: {},
      requestContext: { http: { method: 'GET' } },
    });
    assert.equal(result.statusCode, 200, 'control bundle health handler must return 200');
    assert.equal(JSON.parse(result.body).status, 'ok');
  }
}

const webArchive = resolve('dist/agents-web.zip');
const webHost = 'bcdfghjklmnpqrst.b7t.lambda-web.us-west-2.on.aws';
const baseURL = `https://${webHost}/v1`;
const smokeProviders = JSON.stringify([{
  id: 'smoke', issuer: 'https://issuer.example', jwksUri: 'https://issuer.example/keys', clientId: 'smoke-client',
  audience: 'rat-things', profile: 'jwt_access', authorizationEndpoint: 'https://issuer.example/authorize',
  tokenEndpoint: 'https://issuer.example/token', redirectUri: 'https://app.example/callback', scopes: ['openid'],
}]);
for (const mode of ['operator', 'oidc']) {
  const listenPort = await unusedPort();
  const modeEnvironment = mode === 'oidc'
    ? { AGENTS_AUTH_MODE: 'oidc', TEAM_OIDC_PROVIDERS_JSON: smokeProviders }
    : { AGENTS_TOKEN_ISSUER_URL: 'https://abc123.execute-api.us-west-2.amazonaws.com/v1/auth/tokens' };
  const webProcess = spawn(process.execPath, [resolve('dist/agents-server.mjs')], {
    // Use a deliberately small fixture-only environment: no developer AWS credentials or profiles
    // are inherited, and this smoke exercises health and discovery without AWS network calls.
    env: {
      PATH: process.env.PATH ?? '',
      ...fixtureEnvironment,
      AWS_EC2_METADATA_DISABLED: 'true', AWS_SHARED_CREDENTIALS_FILE: '/dev/null', AWS_CONFIG_FILE: '/dev/null',
      AWS_REGION: 'us-west-2', AWS_LAMBDA_HTTP_ENDPOINT: `127.0.0.1:${listenPort}`,
      AWS_LAMBDA_NODEJS_ENTRYPOINT: 'agents-server.mjs', AGENTS_PUBLIC_BASE_URL: '',
      AGENTS_TABLE_NAME: 'bundle-smoke-agents', INTEGRATION_CREDENTIAL_NAME_PREFIX: 'bundle-smoke/',
      INTEGRATION_CREDENTIAL_KMS_KEY_ARN: 'arn:aws:kms:us-west-2:000000000000:key/bundle-smoke',
      ...modeEnvironment,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const processClose = new Promise(resolvePromise => webProcess.once('close', (code, signal) => resolvePromise({ code, signal })));
  let webStderr = '';
  webProcess.stderr.setEncoding('utf8').on('data', chunk => {
    webStderr = `${webStderr}${chunk}`.slice(-8_192);
  });
  try {
    const health = await untilReady(webProcess, processClose, () => webStderr, () => requestLocal(listenPort, '/health', { host: webHost }));
    assert.equal(health.status, 200, `${mode} Web Function health must respond: ${health.body}; stderr: ${webStderr || '(empty)'}`);
    const discovery = await requestLocal(listenPort, '/.well-known/agents-api', {
      headers: { host: webHost, 'x-forwarded-host': 'attacker.example', 'x-forwarded-proto': 'http' },
    });
    const discoveryBody = JSON.parse(discovery.body);
    assert.equal(discoveryBody.base_url, baseURL, `${mode} discovery must use validated endpoint Host`);
    if (mode === 'oidc') {
      assert.equal(discoveryBody.authentication, 'oidc', 'OIDC discovery must identify OIDC authentication');
      assert.equal(discoveryBody.login_providers[0].id, 'smoke');
      assert.equal('issuer_url' in discoveryBody, false, 'OIDC discovery must not require or publish a bearer token issuer');
    } else {
      assert.equal(discoveryBody.issuer_url, modeEnvironment.AGENTS_TOKEN_ISSUER_URL);
    }
    assert.equal((await requestLocal(listenPort, '/.well-known/agents-api', { headers: { host: 'attacker.example' } })).status, 400,
      'Web Function must reject a Host outside its regional endpoint domain');
    assert.ok((await stat(webArchive)).size > 0, 'Web Function archive must be packaged');
  } finally {
    await stopChild(webProcess, processClose);
  }
}

process.stdout.write(`smoke-tested ${lambdaNames.length} Lambda bundles\n`);

async function unusedPort() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => server.listen(0, '127.0.0.1', error => error ? reject(error) : resolvePromise()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not allocate a Web Function smoke port.');
  await new Promise(resolvePromise => server.close(resolvePromise));
  return address.port;
}

async function untilReady(child, processClose, stderr, request) {
  const deadline = Date.now() + 10_000;
  let lastError;
  while (Date.now() < deadline) {
    try { return await request(); } catch (error) {
      lastError = error;
      if (child.exitCode !== null || child.signalCode !== null) {
        const exit = await processClose;
        throw new Error(`Web Function process exited before readiness (${formatExit(exit)}); last request error: ${formatError(lastError)}; stderr: ${stderr() || '(empty)'}`);
      }
      await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
    }
  }
  throw new Error(`Web Function process did not become ready within 10 seconds; last request error: ${formatError(lastError)}; stderr: ${stderr() || '(empty)'}`);
}

async function stopChild(child, processClose) {
  if (child.exitCode !== null || child.signalCode !== null) return processClose;
  child.kill('SIGTERM');
  const closed = await Promise.race([processClose.then(() => true), new Promise(resolvePromise => setTimeout(() => resolvePromise(false), 2_000))]);
  if (!closed) child.kill('SIGKILL');
  return processClose;
}

function formatExit({ code, signal }) { return `code=${code}, signal=${signal}`; }
function formatError(error) { return error instanceof Error ? `${error.name}: ${error.message}` : String(error); }

function requestLocal(port, path, options) {
  return new Promise((resolvePromise, reject) => {
    const request = httpRequest({ hostname: '127.0.0.1', port, path, headers: options.headers ?? options }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolvePromise({ status: response.statusCode, body }));
    });
    request.once('error', reject);
    request.end();
  });
}
