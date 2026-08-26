import { describe, expect, it, vi } from 'vitest';
import type { AgentToolCallStore } from '../../src/core/ports.js';
import { createDynamicToolRequestHandler } from '../../src/runner/dynamic-tools.js';

const execution = {
  backend: 'microvm' as const,
  id: 'microvm-1',
  generation: 'a'.repeat(64),
};

describe('durable dynamic tool settlement', () => {
  it('records bounded identity before execution and settles success after it', async () => {
    const beginAgentToolCall = vi.fn(async (record) => record);
    const settleAgentToolCall = vi.fn(async (input) => ({ ...input, version: '1' as const }));
    const store = { beginAgentToolCall, settleAgentToolCall } as AgentToolCallStore;
    const call = vi.fn().mockResolvedValue({ records: [{ id: 'record-1' }] });
    const handler = createDynamicToolRequestHandler({
      integrations: { call },
      ledger: {
        store,
        runId: 'run-1',
        execution,
        admittedToolsDigest: 'b'.repeat(64),
        now: () => new Date('2026-08-24T21:00:00.000Z'),
      },
    });

    await expect(handler({
      requestId: 'tool-1',
      method: 'item/tool/call',
      params: {
        namespace: 'fixture_crm',
        tool: 'records_create',
        arguments: { name: 'bounded value' },
      },
    })).resolves.toMatchObject({ success: true });

    expect(beginAgentToolCall).toHaveBeenCalledBefore(call);
    expect(beginAgentToolCall).toHaveBeenCalledWith({
      version: '1',
      runId: 'run-1',
      requestId: 'tool-1',
      method: 'item/tool/call',
      executionId: 'microvm-1',
      executionGeneration: 'a'.repeat(64),
      namespace: 'fixture_crm',
      tool: 'records_create',
      argumentDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      admittedToolsDigest: 'b'.repeat(64),
      status: 'pending',
      startedAt: '2026-08-24T21:00:00.000Z',
    });
    expect(JSON.stringify(beginAgentToolCall.mock.calls)).not.toContain('bounded value');
    expect(settleAgentToolCall).toHaveBeenCalledAfter(call);
    expect(settleAgentToolCall).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-1',
      execution,
      requestId: 'tool-1',
      status: 'succeeded',
      resultDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
    expect(JSON.stringify(settleAgentToolCall.mock.calls)).not.toContain('record-1');
  });

  it('settles trusted-adapter failures without throwing a replayable server error', async () => {
    const store = {
      beginAgentToolCall: vi.fn(async (record) => record),
      settleAgentToolCall: vi.fn(async (input) => ({ ...input, version: '1' as const })),
    } as AgentToolCallStore;
    const handler = createDynamicToolRequestHandler({
      integrations: { call: vi.fn().mockRejectedValue(new Error('resource is denied')) },
      ledger: {
        store,
        runId: 'run-1',
        execution,
        admittedToolsDigest: 'b'.repeat(64),
      },
    });

    await expect(handler({
      requestId: 'tool-2',
      method: 'item/tool/call',
      params: { namespace: 'fixture_crm', tool: 'records_create', arguments: {} },
    })).resolves.toMatchObject({ success: false });
    expect(store.settleAgentToolCall).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed',
      error: 'resource is denied',
    }));
  });
});
