import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Match the common environment Terraform supplies so module-level Lambda
// initialization is exercised without making any AWS requests.
process.env.AWS_REGION ||= 'us-west-2';
process.env.RUNS_TABLE_NAME ||= 'bundle-smoke-runs';
process.env.CONVERSATIONS_TABLE_NAME ||= 'bundle-smoke-conversations';
process.env.ARTIFACT_BUCKET ||= 'bundle-smoke-artifacts';
process.env.RUN_QUEUE_URL ||= 'https://sqs.us-west-2.amazonaws.com/000000000000/bundle-smoke-runs';
process.env.CONVERSATION_QUEUE_URL ||= 'https://sqs.us-west-2.amazonaws.com/000000000000/bundle-smoke-conversations';
process.env.EVENT_BUS_NAME ||= 'bundle-smoke-runs';

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

process.stdout.write(`smoke-tested ${lambdaNames.length} Lambda bundles\n`);
