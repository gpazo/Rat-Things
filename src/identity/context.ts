import type {
  RunActorContext,
  RunCredentialSubjectContext,
  RunSource,
} from '../domain/contracts.js';

export type ProviderKind = Exclude<RunSource['kind'], 'api'>;

export type ActorContext = RunActorContext;

export interface OwnerContext {
  id: string;
}

export type CredentialSubjectContext = RunCredentialSubjectContext;

export interface IngressContext {
  actor: ActorContext;
  owner: OwnerContext;
  source: RunSource;
  credentialSubject: CredentialSubjectContext;
}

export function providerIngressContext(input: {
  ownerId: string;
  actorId: string;
  actorKind?: ActorContext['kind'];
  source: Exclude<RunSource, { kind: 'api' }>;
}): IngressContext {
  return {
    owner: { id: requiredIdentity(input.ownerId, 'owner') },
    actor: {
      kind: input.actorKind ?? 'human',
      id: requiredIdentity(input.actorId, 'actor'),
      provider: input.source.kind,
    },
    source: input.source,
    // Provider clone/notify credentials are deployment-owned. Attribution does not grant them.
    credentialSubject: { kind: 'runtime', id: `runtime:${input.source.kind}` },
  };
}

export function apiIngressContext(
  ownerId: string,
  requestId?: string,
): IngressContext & { source: Extract<RunSource, { kind: 'api' }> } {
  const id = requiredIdentity(ownerId, 'owner');
  return {
    owner: { id },
    actor: { kind: 'human', id, provider: 'api' },
    source: requestId ? { kind: 'api', requestId } : { kind: 'api' },
    credentialSubject: { kind: 'actor', id },
  };
}

function requiredIdentity(value: string, label: string): string {
  if (!value.trim()) throw new Error(`${label} identity is required`);
  if (Buffer.byteLength(value, 'utf8') > 1_024) throw new Error(`${label} identity is too large`);
  return value;
}
