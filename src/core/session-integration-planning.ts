import { createHash } from 'node:crypto';
import { canonicalJson } from '../domain/json.js';
import { AgentsApiError } from '../domain/agents-api-validation.js';
import type { SessionIntegrationInput, SessionIntegrationState, SessionIntegrationTarget, ThreadSubscription } from '../domain/session-integrations.js';

export const integrationDigest = (value: unknown): string => createHash('sha256').update(canonicalJson(value)).digest('hex');
export const integrationInputDigest = ({ admission: _admission, ...input }: SessionIntegrationInput): string => integrationDigest(input);
export const integrationSessionId = (bindingId: string, threadId: string): string => `sess_${integrationDigest([bindingId, threadId]).slice(0, 32)}`;

export function integrationInputText(input: SessionIntegrationInput): string {
  return input.admission === 'candidate'
    ? `An event filter admitted the following untrusted event. Respond only if there is something useful to contribute. A completed Turn with an empty final response sends no channel reply.\n\n${input.text}`
    : input.text;
}

/** Arrival order is persisted by the caller's conditional write, never by queue arrival order. */
export function acceptIntegrationInput(previous: SessionIntegrationState | undefined, target: SessionIntegrationTarget, input: SessionIntegrationInput): SessionIntegrationState {
  const digest = integrationInputDigest(input);
  const receipt = previous?.inputs.find((entry) => entry.id === input.id);
  if (receipt) {
    if (receipt.digest !== digest) throw new AgentsApiError(409, 'This provider occurrence was already accepted with different input.', 'idempotency_conflict');
    return previous!;
  }
  return { ...previous, target: previous?.target ?? structuredClone(target), inputs: [...previous?.inputs ?? [], { ...structuredClone(input), digest }] };
}

export const MAX_THREAD_INPUTS = 128;
export const threadSubscriptionId = (bindingId: string, threadKey: string): string => integrationDigest([bindingId, threadKey]);
export const integrationOccurrenceId = (bindingId: string, inputId: string): string => integrationDigest([bindingId, inputId]);

export function planThreadAdmission(input: {
  bindingId: string;
  threadKey: string;
  subscription?: ThreadSubscription;
  integration?: SessionIntegrationState;
  sessionDeleted: boolean;
  target: SessionIntegrationTarget;
  occurrence: SessionIntegrationInput;
}) {
  const { bindingId, threadKey, subscription, integration, target, occurrence } = input;
  const active = subscription?.subscribers.find(subscriber => subscriber.state === 'active');
  const previousId = subscription?.subscribers[0]?.sessionId ?? (integration ? integrationSessionId(bindingId, threadKey) : undefined);
  const headChanged = occurrence.repositoryHeadChanged === true && occurrence.repository?.ref !== integration?.inputs[0]?.repository?.ref;
  const rotate = previousId !== undefined && ((subscription !== undefined && !active) || input.sessionDeleted || headChanged || (integration?.inputs.length ?? 0) >= MAX_THREAD_INPUTS);
  const epoch = (subscription?.epoch ?? 0) + (rotate ? 1 : 0);
  const sessionId = integrationSessionId(bindingId, epoch === 0 ? threadKey : `${threadKey}#${epoch}`);
  const state = acceptIntegrationInput(rotate ? undefined : integration, target, occurrence);
  return {
    sessionId,
    subscription: { bindingId, threadKey, epoch, subscribers: [{ sessionId, state: 'active' as const }] },
    integration: { ...state, threadSubscriptionId: threadSubscriptionId(bindingId, threadKey), threadKey, epoch,
      ...(rotate && previousId ? { previousSessionId: previousId } : {}),
    },
    ...(rotate && previousId ? { supersededSessionId: previousId } : {}),
  };
}

export function releaseThreadSubscription(subscription: ThreadSubscription, sessionId: string, reason: string): ThreadSubscription {
  if (!subscription.subscribers.some(subscriber => subscriber.sessionId === sessionId && subscriber.state === 'active')) return subscription;
  return { ...subscription, subscribers: subscription.subscribers.map(subscriber => subscriber.sessionId === sessionId ? { ...subscriber, state: 'released', reason } : subscriber) };
}
