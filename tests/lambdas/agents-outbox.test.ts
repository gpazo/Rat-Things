import { ChangeMessageVisibilityCommand, SendMessageCommand } from '@aws-sdk/client-sqs';
import { marshall } from '@aws-sdk/util-dynamodb';
import type { DynamoDBStreamEvent, SQSEvent } from 'aws-lambda';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentsResourceConflictError } from '../../src/domain/agents-api-validation.js';

const f = vi.hoisted(() => ({ send: vi.fn(), reconcile: vi.fn(), reconcilePreparation: vi.fn(), dispatch: vi.fn(), completeReadyTurns: vi.fn() }));
vi.mock('../../src/adapters/aws-runtime.js', () => ({ createAwsClients: () => ({ sqs: { send: f.send } }) }));
vi.mock('../../src/app/composition.js', () => ({
  getAgentsApiServices: () => ({ tools: { reconcile: f.reconcile, reconcilePreparation: f.reconcilePreparation }, sessions: { dispatch: f.dispatch, completeReadyTurns: f.completeReadyTurns } }),
  getSessionIntegrationService: vi.fn(), getScheduleService: vi.fn(),
}));
const { handler } = await import('../../src/lambdas/agents-outbox.js');
const job = { type: 'tool_cleanup', ownerId: 'alice', id: 'attempt-1' };
const queueEvent = { Records: [{ body: JSON.stringify(job), receiptHandle: 'receipt', messageId: 'message-1' }] } as SQSEvent;
beforeEach(() => { vi.resetAllMocks(); vi.stubEnv('AGENTS_QUEUE_URL', 'https://sqs.example/agents'); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it('releases a Session FIFO promptly after a rejected write and acknowledges successful redelivery', async () => {
  f.dispatch.mockRejectedValueOnce(new AgentsResourceConflictError()).mockResolvedValueOnce(undefined);
  const event = { Records: [{ ...queueEvent.Records[0]!, body: JSON.stringify({ type: 'dispatch', ownerId: 'alice', id: 'session' }) }] } as SQSEvent;
  expect(await handler(event)).toEqual({ batchItemFailures: [{ itemIdentifier: 'message-1' }] });
  expect(f.completeReadyTurns).not.toHaveBeenCalled();
  expect(f.send.mock.calls[0]![0]).toBeInstanceOf(ChangeMessageVisibilityCommand);
  expect(f.send.mock.calls[0]![0].input).toEqual({ QueueUrl: 'https://sqs.example/agents', ReceiptHandle: 'receipt', VisibilityTimeout: 5 });
  expect(await handler(event)).toEqual({ batchItemFailures: [] });
  expect(f.dispatch).toHaveBeenCalledTimes(2);
  expect(f.completeReadyTurns).toHaveBeenCalledOnce();
  expect(f.send).toHaveBeenCalledOnce();
});

describe('credential cleanup outbox delivery', () => {
  it('queues a durable attempt from its index without including credential payloads', async () => {
    const index = { ownerId: 'alice', id: 'attempt-1', key: 'root', collection: 'session_tool_attempts', revision: 1 };
    const event = { Records: [{ eventID: 'event-1', dynamodb: { NewImage: marshall(index), SequenceNumber: 'sequence-1' } }] } as DynamoDBStreamEvent;
    expect(await handler(event)).toEqual({ batchItemFailures: [] });
    expect(f.send.mock.calls[0]![0]).toBeInstanceOf(SendMessageCommand);
    expect(JSON.parse(f.send.mock.calls[0]![0].input.MessageBody)).toEqual(job);
  });

  it('defers active preparation and acknowledges completed reconciliation on redelivery', async () => {
    f.reconcile.mockResolvedValueOnce({ status: 'waiting', retryAfterSeconds: 300 }).mockResolvedValueOnce({ status: 'cleaned' });
    expect(await handler(queueEvent)).toEqual({ batchItemFailures: [{ itemIdentifier: 'message-1' }] });
    expect(f.send.mock.calls[0]![0]).toBeInstanceOf(ChangeMessageVisibilityCommand);
    expect(f.send.mock.calls[0]![0].input).toMatchObject({ ReceiptHandle: 'receipt', VisibilityTimeout: 300 });
    expect(await handler(queueEvent)).toEqual({ batchItemFailures: [] });
    expect(f.reconcile).toHaveBeenCalledWith('alice', 'attempt-1');
    expect(f.dispatch).not.toHaveBeenCalled();
  });

  it('retains failed cleanup for retry without logging confidential error text', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    f.reconcile.mockRejectedValue(new Error('Bearer private-value'));
    expect(await handler(queueEvent)).toEqual({ batchItemFailures: [{ itemIdentifier: 'message-1' }] });
    expect(warn).toHaveBeenCalledOnce();
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private-value');
  });
});


describe('Session preparation cleanup outbox delivery', () => {
  it('queues preparation changes separately from execution and waits within SQS visibility limits', async () => {
    const preparationJob = { ...job, type: 'preparation_cleanup', id: 'sess_pending' };
    const index = { ownerId: 'alice', id: 'sess_pending', key: 'root', collection: 'session_preparations', revision: 1 };
    await handler({ Records: [{ eventID: 'preparation-1', dynamodb: { NewImage: marshall(index), SequenceNumber: 'sequence-1' } }] } as DynamoDBStreamEvent);
    expect(JSON.parse(f.send.mock.calls[0]![0].input.MessageBody)).toEqual(preparationJob);
    f.reconcilePreparation.mockResolvedValueOnce({ status: 'waiting', retryAfterSeconds: 86_400 }).mockResolvedValueOnce({ status: 'created' });
    const event = { Records: [{ ...queueEvent.Records[0]!, body: JSON.stringify(preparationJob) }] } as SQSEvent;
    expect(await handler(event)).toEqual({ batchItemFailures: [{ itemIdentifier: 'message-1' }] });
    expect(f.send.mock.calls[1]![0].input.VisibilityTimeout).toBe(3600);
    expect(await handler(event)).toEqual({ batchItemFailures: [] });
    expect(f.reconcilePreparation).toHaveBeenCalledWith('alice', 'sess_pending');
    expect(f.dispatch).not.toHaveBeenCalled();
  });
});
