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
process.env.MICROVM_IMAGE_PARAMETER_NAME ||= '/bundle-smoke/microvm/image';
process.env.MICROVM_IMAGE_VERSION_PARAMETER_NAME ||= '/bundle-smoke/microvm/version';
process.env.MICROVM_EXECUTION_ROLE_ARN ||=
  'arn:aws:iam::000000000000:role/bundle-smoke-microvm-execution';
process.env.MICROVM_LOG_GROUP_NAME ||= '/bundle-smoke/microvms';
process.env.INTEGRATIONS_TABLE_NAME ||= 'bundle-smoke-integrations';
process.env.DEPLOYMENT_ID ||= 'bundle-smoke';
process.env.AUDIT_QUEUE_URL ||= 'https://sqs.us-west-2.amazonaws.com/000000000000/bundle-smoke-audit';
process.env.THINGS_TABLE_NAME ||= 'bundle-smoke-things';
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

process.stdout.write(`smoke-tested ${lambdaNames.length} Lambda bundles\n`);
