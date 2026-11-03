import { access, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { SQSEvent } from 'aws-lambda';
import { GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SecurityProof } from '../../testing/aws/super-security-proof.js';
import { agentsJobGroup } from '../../src/core/agents-outbox-planning.js';

const { invoke, delay } = vi.hoisted(() => ({ invoke: vi.fn(), delay: vi.fn() }));
vi.mock('node:timers/promises', () => ({ setTimeout: delay }));
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  return { ...actual, execFile: Object.assign(() => {}, { [promisify.custom]: invoke }) };
});

afterEach(() => { vi.unstubAllEnvs(); vi.resetAllMocks(); });

function response(body: string, metadata = { StatusCode: 200, FunctionError: undefined as string | undefined }) {
  vi.stubEnv('AWS_E2E_WATCHDOG_FUNCTION_NAME', 'rat-things-test-watchdog');
  let path = '';
  invoke.mockImplementation(async (_command: string, args: string[]) => {
    path = args[args.indexOf('--cli-binary-format') + 2]!;
    await writeFile(path, body);
    return { stdout: JSON.stringify(metadata), stderr: '' };
  });
  return {
    tick: () => SecurityProof.prototype.tick.call({ region: 'us-west-2' } as SecurityProof),
    path: () => path,
  };
}

describe('live watchdog invocation evidence', () => {
  it.each([
    { candidates: 0, reports: 0, errors: 0, partial: false },
    { candidates: 1, reports: 0, errors: 0, partial: true },
    { candidates: 1, reports: 0, errors: 1, partial: false },
  ])('retains scan completion and error evidence %j', async scan => {
    const f = response(JSON.stringify(scan));
    expect(await f.tick()).toEqual(scan);
    expect(invoke.mock.calls[0]?.[0]).toBe('aws');
    await expect(access(f.path())).rejects.toThrow();
  });

  it.each(['', '{}', 'null', '{"partial":false,"candidates":0,"reports":0,"errors":-1}', '{"partial":"false","candidates":0,"reports":0,"errors":0}', 'x'.repeat(4097)])('rejects invalid or oversized response %#', async body => {
    const f = response(body);
    await expect(f.tick()).rejects.toThrow();
    await expect(access(f.path())).rejects.toThrow();
  });

  it('rejects a Lambda function error even when the transport succeeds', async () => {
    const f = response('{}', { StatusCode: 200, FunctionError: 'Unhandled' });
    await expect(f.tick()).rejects.toThrow('deployed watchdog invocation');
    await expect(access(f.path())).rejects.toThrow();
  });
});

function deliveryReplay(body: string | readonly string[] = '{"batchItemFailures":[]}', metadata = { StatusCode: 200, FunctionError: undefined as string | undefined }) {
  const region = 'us-west-2';
  const account = '123456789012';
  const deployment = 'test-replay';
  const prefix = `rat-things-${deployment}`;
  const functionName = `${prefix}-agents-outbox`;
  const functionArn = `arn:aws:lambda:${region}:${account}:function:${functionName}`;
  const queueArn = `arn:aws:sqs:${region}:${account}:${prefix}-agents.fifo`;
  const queueUrl = `https://sqs.${region}.amazonaws.com/${account}/${prefix}-agents.fifo`;
  const owner = `api:arn:aws:iam::${account}:user/proof`;
  const sessionId = 'sess_owned';
  const turnId = 'turn_retry';
  const configuration = { FunctionArn: functionArn, Timeout: 60, Environment: { Variables: { AGENTS_QUEUE_URL: queueUrl } } };
  const tags = { Ephemeral: 'true', DeploymentId: deployment, Purpose: 'live-e2e-validation' };
  const mapping = { UUID: 'owned-mapping', State: 'Disabled', FunctionArn: functionArn, EventSourceArn: queueArn };
  const turns = [{ turn: { id: 'turn_seed', status: 'failed' } }, { turn: { id: turnId, status: 'completed' } }];
  const inputs = [{ turnId: 'turn_seed', deliveryProcessed: true }, { turnId, deliveryProcessed: true }];
  const state = { ownerId: owner, value: { session: { id: sessionId }, turns } };
  const store = { get: vi.fn(async (_owner: string, collection: string) => collection === 'sessions' ? state : { value: { inputs } }) };
  const sqs = { send: vi.fn(async (_command: GetQueueAttributesCommand) => ({ Attributes: { QueueArn: queueArn } as Record<string, string> })) };
  const calls: Array<{ args: string[]; event: SQSEvent; output: string }> = [];
  vi.stubEnv('AWS_E2E_AGENTS_OUTBOX_FUNCTION_NAME', functionName);
  invoke.mockImplementation(async (_command: string, args: string[]) => {
    if (args[1] === 'get-function') return { stdout: JSON.stringify({ Configuration: configuration, Tags: tags }) };
    if (args[1] === 'get-event-source-mapping') return { stdout: JSON.stringify(mapping) };
    if (args[1] !== 'invoke') throw new Error('Unexpected AWS operation');
    const output = args[args.indexOf('--cli-binary-format') + 2]!;
    calls.push({ args, event: JSON.parse(args[args.indexOf('--payload') + 1]!) as SQSEvent, output });
    await writeFile(output, typeof body === 'string' ? body : body[calls.length - 1]!);
    return { stdout: JSON.stringify(metadata) };
  });
  const proof = Object.create(SecurityProof.prototype) as SecurityProof;
  Object.assign(proof, {
    region, account, deployment, prefix, owner, proofId: 'proof-owned', sessions: new Set([sessionId]),
    mapping: { ...mapping }, store, sqs,
  });
  return { run: () => proof.replaySessionDelivery(sessionId, turnId), proof, configuration, tags, mapping, inputs, turns, state, sqs, calls, functionArn, queueArn, queueUrl, owner, sessionId };
}

describe('completed Session delivery replay evidence', () => {
  it('invokes the exact owned delivery job twice after draining the disabled consumer without requiring an empty queue', async () => {
    const f = deliveryReplay();
    f.sqs.send.mockResolvedValue({ Attributes: { QueueArn: f.queueArn, ApproximateNumberOfMessages: '12', ApproximateNumberOfMessagesNotVisible: '6' } });
    let finishDrain!: () => void;
    delay.mockReturnValue(new Promise<void>(resolve => { finishDrain = resolve; }));
    const replay = f.run();
    await vi.waitFor(() => expect(delay).toHaveBeenCalledExactlyOnceWith(65_000));
    expect(f.calls).toHaveLength(0);
    finishDrain();
    const evidence = await replay;
    expect(f.sqs.send).toHaveBeenCalledOnce();
    expect(f.sqs.send.mock.calls[0]?.[0]).toBeInstanceOf(GetQueueAttributesCommand);
    expect((f.sqs.send.mock.calls[0]?.[0] as GetQueueAttributesCommand).input).toEqual({ QueueUrl: f.queueUrl, AttributeNames: ['QueueArn'] });
    expect(f.calls).toHaveLength(2);
    expect(f.calls[0]!.event).toEqual(f.calls[1]!.event);
    expect(f.calls[0]!.event.Records).toHaveLength(1);
    const record = f.calls[0]!.event.Records[0]!;
    const job = { type: 'delivery' as const, ownerId: f.owner, id: f.sessionId };
    expect(JSON.parse(record.body)).toEqual(job);
    expect(record).toMatchObject({ eventSourceARN: f.queueArn, awsRegion: 'us-west-2', eventSource: 'aws:sqs', md5OfBody: createHash('md5').update(record.body).digest('hex') });
    expect(record.attributes.MessageGroupId).toBe(createHash('sha256').update(agentsJobGroup(job)).digest('hex'));
    for (const call of f.calls) {
      expect(call.args.slice(0, 6)).toEqual(['lambda', 'invoke', '--function-name', f.functionArn, '--invocation-type', 'RequestResponse']);
      await expect(access(call.output)).rejects.toThrow();
    }
    expect(evidence).toEqual({ functionArn: f.functionArn, queueArn: f.queueArn, job, messageId: record.messageId, invocationCount: 2, batchItemFailureCounts: [0, 0], consumerDrainSeconds: 65 });
  });

  it.each([
    ['function name', (f: ReturnType<typeof deliveryReplay>) => vi.stubEnv('AWS_E2E_AGENTS_OUTBOX_FUNCTION_NAME', `${f.proof.prefix}-watchdog`)],
    ['function ARN', (f: ReturnType<typeof deliveryReplay>) => { f.configuration.FunctionArn = f.functionArn.replace('123456789012', '999999999999'); }],
    ['function tags', (f: ReturnType<typeof deliveryReplay>) => { f.tags.DeploymentId = 'another-stack'; }],
    ['queue URL', (f: ReturnType<typeof deliveryReplay>) => { f.configuration.Environment.Variables.AGENTS_QUEUE_URL = f.queueUrl.replace('us-west-2', 'us-east-1'); }],
    ['queue ARN', (f: ReturnType<typeof deliveryReplay>) => { f.sqs.send.mockResolvedValue({ Attributes: { QueueArn: `${f.queueArn}-foreign` } }); }],
    ['mapping ownership', (f: ReturnType<typeof deliveryReplay>) => { f.mapping.EventSourceArn = `${f.queueArn}-foreign`; }],
    ['handler timeout', (f: ReturnType<typeof deliveryReplay>) => { f.configuration.Timeout = 300; }],
    ['unowned Session', (f: ReturnType<typeof deliveryReplay>) => { f.proof.sessions.clear(); }],
    ['persisted owner', (f: ReturnType<typeof deliveryReplay>) => { f.state.ownerId = 'another-owner'; }],
    ['incomplete Turn', (f: ReturnType<typeof deliveryReplay>) => { f.turns[1]!.turn.status = 'in_progress'; }],
    ['unprocessed receipt', (f: ReturnType<typeof deliveryReplay>) => { f.inputs[1]!.deliveryProcessed = false; }],
    ['missing retry receipt', (f: ReturnType<typeof deliveryReplay>) => { f.inputs.pop(); }],
  ] as const)('refuses replay for %s', async (_label, mutate) => {
    const f = deliveryReplay();
    mutate(f);
    await expect(f.run()).rejects.toThrow('Live security proof failed');
    expect(f.calls).toHaveLength(0);
  });

  it.each(['', '{}', 'null', '{"batchItemFailures":null}', '{"batchItemFailures":{}}', '{"batchItemFailures":[{"itemIdentifier":"retry"}]}', 'x'.repeat(4097)])('rejects unsuccessful or invalid handler acknowledgement %#', async body => {
    const f = deliveryReplay(body);
    await expect(f.run()).rejects.toThrow();
    expect(f.calls).toHaveLength(1);
    await expect(access(f.calls[0]!.output)).rejects.toThrow();
  });

  it.each([
    { StatusCode: 200, FunctionError: 'Unhandled' },
    { StatusCode: 202, FunctionError: undefined },
  ])('rejects invocation failure %j', async metadata => {
    const f = deliveryReplay('{"batchItemFailures":[]}', metadata);
    await expect(f.run()).rejects.toThrow('deployed outbox replay invocation');
    expect(f.calls).toHaveLength(1);
    await expect(access(f.calls[0]!.output)).rejects.toThrow();
  });

  it('rejects a failed second replay after the first replay was acknowledged', async () => {
    const f = deliveryReplay(['{"batchItemFailures":[]}', '{"batchItemFailures":[{"itemIdentifier":"retry"}]}']);
    await expect(f.run()).rejects.toThrow('outbox replay acknowledges the exact owned delivery job');
    expect(f.calls).toHaveLength(2);
    for (const call of f.calls) await expect(access(call.output)).rejects.toThrow();
  });
});
