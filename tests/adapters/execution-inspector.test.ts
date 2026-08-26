import { LambdaMicrovmsClient } from '@aws-sdk/client-lambda-microvms';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MicrovmExecutionInspector } from '../../src/adapters/executors.js';

const execution = {
  backend: 'microvm' as const,
  id: 'microvm-1',
  generation: 'a'.repeat(64),
};

describe('MicroVM execution inspection', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('proves a running MicroVM owns the exact root-supervised worker generation', async () => {
    const send = vi.fn().mockImplementation((command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'GetMicrovmCommand') {
        return Promise.resolve({ state: 'RUNNING', endpoint: 'runtime.example' });
      }
      return Promise.resolve({ authToken: { 'X-aws-proxy-auth': 'probe-token' } });
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify({
        runId: 'run-1',
        generation: execution.generation,
        active: true,
        workerConnected: true,
      })),
    });
    vi.stubGlobal('fetch', fetchMock);
    const inspector = new MicrovmExecutionInspector(
      { send } as unknown as LambdaMicrovmsClient,
    );

    await expect(inspector.inspect('run-1', execution)).resolves.toEqual({ kind: 'active' });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://runtime.example/agent-runtime/v1/runs/run-1/health',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          'x-aws-proxy-auth': 'probe-token',
          'x-aws-proxy-port': '8080',
        }),
      }),
    );
  });

  it('quarantines a different worker generation instead of treating the VM as healthy', async () => {
    const send = vi.fn().mockImplementation((command: { constructor: { name: string } }) =>
      command.constructor.name === 'GetMicrovmCommand'
        ? Promise.resolve({ state: 'RUNNING', endpoint: 'runtime.example' })
        : Promise.resolve({ authToken: { 'X-aws-proxy-auth': 'probe-token' } }),
    );
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify({
        runId: 'run-1',
        generation: 'b'.repeat(64),
        active: true,
        workerConnected: true,
      })),
    }));
    const inspector = new MicrovmExecutionInspector(
      { send } as unknown as LambdaMicrovmsClient,
    );

    await expect(inspector.inspect('run-1', execution)).resolves.toMatchObject({
      kind: 'conflict',
    });
  });

  it('classifies a terminated or missing backend without probing its endpoint', async () => {
    const terminated = new MicrovmExecutionInspector({
      send: vi.fn().mockResolvedValue({ state: 'TERMINATED' }),
    } as unknown as LambdaMicrovmsClient);
    await expect(terminated.inspect('run-1', execution)).resolves.toEqual({
      kind: 'terminal',
      reason: 'the attached MicroVM is terminated',
    });

    const missing = new MicrovmExecutionInspector({
      send: vi.fn().mockRejectedValue(Object.assign(new Error('gone'), {
        name: 'ResourceNotFoundException',
      })),
    } as unknown as LambdaMicrovmsClient);
    await expect(missing.inspect('run-1', execution)).resolves.toEqual({
      kind: 'absent',
      reason: 'the attached MicroVM no longer exists',
    });
  });
});
