import { readFile } from 'node:fs/promises';
import { ECSClient, RunTaskCommand } from '@aws-sdk/client-ecs';

const request = JSON.parse(await readFile(process.argv[2], 'utf8'));
if (!request.clientToken || request.clientToken !== request.startedBy || request.count !== 1) {
  throw new Error('An observer launch requires one task and a recorded idempotency identity.');
}
const client = new ECSClient({ region: process.env.AWS_REGION });
try {
  const response = await client.send(new RunTaskCommand(request));
  console.log(JSON.stringify(response));
  if (response.failures?.length || response.tasks?.length !== 1) process.exitCode = 1;
} finally { client.destroy(); }
