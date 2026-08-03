import {
  GetMicrovmCommand,
  LambdaMicrovmsClient,
  ListMicrovmsCommand,
  TerminateMicrovmCommand,
} from '@aws-sdk/client-lambda-microvms';

const [region, imageArn] = process.argv.slice(2);
if (!region || !imageArn) process.exit(0);

const client = new LambdaMicrovmsClient({ region });
const terminating = [];
let nextToken;
do {
  const page = await client.send(new ListMicrovmsCommand({ ...(nextToken ? { nextToken } : {}) }));
  for (const microvm of page.items ?? []) {
    if (
      microvm.imageArn === imageArn &&
      microvm.microvmId &&
      !['TERMINATED', 'TERMINATING'].includes(microvm.state ?? '')
    ) {
      await client.send(new TerminateMicrovmCommand({ microvmIdentifier: microvm.microvmId }));
      terminating.push(microvm.microvmId);
    } else if (microvm.imageArn === imageArn && microvm.microvmId && microvm.state === 'TERMINATING') {
      terminating.push(microvm.microvmId);
    }
  }
  nextToken = page.nextToken;
} while (nextToken);

const deadline = Date.now() + 60_000;
for (const microvmId of terminating) {
  while (Date.now() < deadline) {
    try {
      const current = await client.send(new GetMicrovmCommand({ microvmIdentifier: microvmId }));
      if (current.state === 'TERMINATED') break;
    } catch (error) {
      if (error?.name === 'ResourceNotFoundException') break;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

if (terminating.length > 0) {
  process.stdout.write(`terminated ${terminating.length} MicroVM instance(s)\n`);
}
