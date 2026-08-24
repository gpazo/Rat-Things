import { describe, expect, it, vi } from 'vitest';
import { CredentialBroker } from '../../src/credentials/broker.js';
import { TeamsIngressAdapter } from '../../src/ingress/providers/teams.js';
import type { IngressWork } from '../../src/ingress/types.js';

describe('Teams ingress adapter', () => {
  it('immediately acknowledges that the asynchronous reply will follow', () => {
    const adapter = new TeamsIngressAdapter(
      new CredentialBroker({ get: vi.fn() }),
      { webhookSecretArn: 'secret:teams-webhook' },
    );

    expect(adapter.acknowledge(
      { runId: 'run-1' },
      {} as IngressWork,
    )).toEqual({
      statusCode: 200,
      body: {
        type: 'message',
        text: "Rat Things request received. I'll reply when run run-1 finishes.",
      },
    });
  });
});
