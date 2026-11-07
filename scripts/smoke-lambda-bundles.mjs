import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
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
const listenPort = await unusedPort();
const webHost = 'bcdfghjklmnpqrst.b7t.lambda-web.us-west-2.on.aws';
const webProcess = spawn(process.execPath, [resolve('dist/agents-server.mjs')], {
  env: {
    ...process.env,
    AWS_REGION: 'us-west-2',
    AWS_LAMBDA_HTTP_ENDPOINT: `127.0.0.1:${listenPort}`,
    AWS_LAMBDA_NODEJS_ENTRYPOINT: 'agents-server.mjs',
    AGENTS_TOKEN_ISSUER_URL: 'https://abc123.execute-api.us-west-2.amazonaws.com/v1/auth/tokens',
    AGENTS_PUBLIC_BASE_URL: '',
    AGENTS_TABLE_NAME: 'bundle-smoke-agents',
    INTEGRATION_CREDENTIAL_NAME_PREFIX: 'bundle-smoke/',
    INTEGRATION_CREDENTIAL_KMS_KEY_ARN: 'arn:aws:kms:us-west-2:000000000000:key/bundle-smoke',
  },
  stdio: ['ignore', 'ignore', 'pipe'],
});
const processExit = new Promise(resolvePromise => webProcess.once('exit', resolvePromise));
let webStderr = '';
webProcess.stderr.setEncoding('utf8').on('data', chunk => { webStderr += chunk; });
try {
  const baseURL = `https://${webHost}/v1`;
  const health = await untilReady(async () => fetch(`http://127.0.0.1:${listenPort}/health`, { headers: { host: webHost } }));
  assert.equal(health.status, 200, `Web Function health must respond: ${webStderr}`);
  const discovery = await fetch(`http://127.0.0.1:${listenPort}/.well-known/agents-api`, {
    headers: { host: webHost, 'x-forwarded-host': 'attacker.example', 'x-forwarded-proto': 'http' },
  });
  assert.equal((await discovery.json()).base_url, baseURL, 'discovery must use validated endpoint Host');
  assert.equal((await fetch(`http://127.0.0.1:${listenPort}/.well-known/agents-api`, { headers: { host: 'attacker.example' } })).status, 400,
    'Web Function must reject a Host outside its regional endpoint domain');
  assert.ok((await stat(webArchive)).size > 0, 'Web Function archive must be packaged');
} finally {
  webProcess.kill('SIGTERM');
  await processExit;
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

async function untilReady(request) {
  const deadline = Date.now() + 10_000;
  let lastError;
  while (Date.now() < deadline) {
    try { return await request(); } catch (error) { lastError = error; await new Promise(resolvePromise => setTimeout(resolvePromise, 100)); }
  }
  throw new Error(`Web Function process did not become ready: ${lastError ?? webStderr}`);
}
