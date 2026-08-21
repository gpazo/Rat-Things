import {
  GetMicrovmCommand,
  LambdaMicrovmsClient,
  ListMicrovmsCommand,
  TerminateMicrovmCommand,
} from '@aws-sdk/client-lambda-microvms';

const [region, imageArn] = process.argv.slice(2);
if (!region || !imageArn) process.exit(0);

const client = new LambdaMicrovmsClient({ region });
const touched = new Set();
const deadline = Date.now() + 90_000;
let emptyPasses = 0;

while (Date.now() < deadline) {
  const active = (await listImageMicrovms()).filter((microvm) => (
    microvm.microvmId && !['TERMINATED'].includes(microvm.state ?? '')
  ));
  if (active.length === 0) {
    emptyPasses += 1;
    if (emptyPasses >= 2) break;
    await delay(2_000);
    continue;
  }
  emptyPasses = 0;
  for (const microvm of active) {
    if (!microvm.microvmId) continue;
    touched.add(microvm.microvmId);
    if (microvm.state !== 'TERMINATING') {
      await sendWithTransientRetry(new TerminateMicrovmCommand({ microvmIdentifier: microvm.microvmId }));
    } else {
      // Read the exact instance as well as the list projection while AWS is
      // transitioning it; ResourceNotFound is equivalent to terminated.
      try {
        await sendWithTransientRetry(new GetMicrovmCommand({ microvmIdentifier: microvm.microvmId }));
      } catch (error) {
        if (error?.name !== 'ResourceNotFoundException') throw error;
      }
    }
  }
  await delay(2_000);
}

const remaining = (await listImageMicrovms()).filter((microvm) => (
  microvm.microvmId && microvm.state !== 'TERMINATED'
));
if (remaining.length > 0) {
  throw new Error(`MicroVM termination timed out: ${remaining
    .map((microvm) => `${microvm.microvmId}:${microvm.state}`)
    .join(', ')}`);
}

if (touched.size > 0) {
  process.stdout.write(`terminated ${touched.size} MicroVM instance(s)\n`);
}

async function listImageMicrovms() {
  const items = [];
  let nextToken;
  do {
    const page = await sendWithTransientRetry(new ListMicrovmsCommand({
      imageIdentifier: imageArn,
      maxResults: 50,
      ...(nextToken ? { nextToken } : {}),
    }));
    items.push(...(page.items ?? []));
    nextToken = page.nextToken;
  } while (nextToken);
  return items;
}

async function sendWithTransientRetry(command) {
  const maxAttempts = 6;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await client.send(command);
    } catch (error) {
      if (!isTransientAwsError(error) || attempt === maxAttempts) throw error;
      const status = error?.$metadata?.httpStatusCode ?? error?.name ?? 'network error';
      const backoffMilliseconds = Math.min(1_000 * (2 ** (attempt - 1)), 10_000);
      process.stderr.write(
        `Lambda MicroVM control plane returned ${status}; retrying in ${backoffMilliseconds}ms (${attempt}/${maxAttempts})\n`,
      );
      await delay(backoffMilliseconds);
    }
  }
  throw new Error('unreachable transient-retry state');
}

function isTransientAwsError(error) {
  const status = error?.$metadata?.httpStatusCode;
  return status === 429
    || (typeof status === 'number' && status >= 500)
    || error?.$retryable === true
    || ['TimeoutError', 'NetworkingError', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN'].includes(
      error?.name ?? error?.code ?? '',
    );
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
