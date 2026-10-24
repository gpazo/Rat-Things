import { createHash } from 'node:crypto';
import { AgentsApiError } from '../domain/agents-api-validation.js';
import type { AgentsClock, AgentsStore } from './agents-ports.js';

export interface OwnerRateLimit {
  admit(ownerId: string, operationId: string, requests?: number): Promise<void>;
}

/** Admission receipts and the owner's counter commit together across all API instances. */
export class OwnerRateLimiter implements OwnerRateLimit {
  public constructor(private readonly store: AgentsStore,
    private readonly limit: (ownerId: string) => number = () => 60,
    private readonly clock: AgentsClock = { now: () => Math.floor(Date.now() / 1000) }) {}

  public async admit(ownerId: string, operationId: string, requests = 1): Promise<void> {
    const maximum = this.limit(ownerId);
    if (!Number.isSafeInteger(maximum) || maximum < 0 || !Number.isSafeInteger(requests) || requests < 1) throw new Error('Invalid owner rate limit');
    const id = createHash('sha256').update(operationId).digest('hex');
    const same = (previous: number) => {
      if (previous !== requests) throw new AgentsApiError(409, 'Admission changed on retry.', 'idempotency_conflict');
    };
    for (let attempt = 0; attempt < 20; attempt++) {
      const receipt = await this.store.get<number>(ownerId, 'rate_admissions', id);
      if (receipt) { same(receipt.value); return; }
      const now = this.clock.now();
      const previous = await this.store.get<{ minute: number; requests: number }>(ownerId, 'rate_limits', 'current');
      // Clock skew must not reset a newer counter backwards.
      const minute = Math.max(Math.floor(now / 60), previous?.value.minute ?? 0);
      const total = (previous?.value.minute === minute ? previous.value.requests : 0) + requests;
      if (total > maximum) throw new AgentsApiError(429, 'The owner execution rate limit is exhausted. Retry later.', 'owner_rate_limit_exceeded', null, (minute + 1) * 60 - now);
      try {
        await this.store.commit([
          { resource: { ownerId, collection: 'rate_limits', id: 'current', createdAt: previous?.createdAt ?? now,
            revision: (previous?.revision ?? 0) + 1, value: { minute, requests: total } }, expectedRevision: previous?.revision ?? 0 },
          { resource: { ownerId, collection: 'rate_admissions', id, createdAt: now, revision: 1, value: requests }, expectedRevision: 0 },
        ]);
        return;
      } catch (error) {
        const committed = await this.store.get<number>(ownerId, 'rate_admissions', id);
        if (committed) { same(committed.value); return; }
        if (!(error instanceof AgentsApiError) || error.code !== 'conflict' || attempt === 19) throw error;
      }
    }
  }
}
