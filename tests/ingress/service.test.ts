import { describe, expect, it, vi } from 'vitest';
import type { RunRecord } from '../../src/domain/contracts.js';
import { providerIngressContext } from '../../src/identity/context.js';
import { WebhookIngressService } from '../../src/ingress/service.js';
import { RuntimePluginRegistry } from '../../src/plugins/registry.js';

const source = {
  kind: 'github' as const,
  deliveryId: 'delivery-1',
  event: 'pull_request',
  repository: 'acme/runtime',
  issueNumber: 7,
};

describe('webhook ingress service', () => {
  it('binds trusted plugin identity and source before submission', async () => {
    const run = { runId: 'run-1' } as RunRecord;
    const submit = vi.fn().mockResolvedValue(run);
    const acknowledge = vi.fn().mockReturnValue({ statusCode: 202, body: { runId: run.runId } });
    const registry = new RuntimePluginRegistry([{
      manifest: {
        name: 'github',
        version: '1',
        description: 'test GitHub plugin',
        provider: 'github',
      },
      ingress: {
        provider: 'github',
        receive: vi.fn().mockResolvedValue({
          kind: 'run',
          work: {
            context: providerIngressContext({
              ownerId: 'github:installation-1',
              actorId: 'github:installation-1',
              actorKind: 'system',
              source,
            }),
            request: {
              version: '1',
              prompt: 'review this change',
              source: { kind: 'api', requestId: 'untrusted' },
            },
            submit: { idempotencyKey: 'github:delivery-1', traceId: 'delivery-1' },
          },
        }),
        acknowledge,
      },
    }]);
    const service = new WebhookIngressService(registry, { submit });

    await expect(service.receive('github', { body: '{}', headers: {} }))
      .resolves.toEqual({ statusCode: 202, body: { runId: 'run-1' } });
    expect(submit).toHaveBeenCalledWith(
      'github:installation-1',
      expect.objectContaining({ source }),
      {
        idempotencyKey: 'github:delivery-1',
        traceId: 'delivery-1',
        provenance: {
          actor: {
            kind: 'system',
            id: 'github:installation-1',
            provider: 'github',
          },
          credentialSubject: { kind: 'runtime', id: 'runtime:github' },
        },
      },
    );
    expect(acknowledge).toHaveBeenCalledWith(run, expect.any(Object));
  });
});
