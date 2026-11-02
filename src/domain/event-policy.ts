export interface SourceEventPolicy {
  mode: 'explicit' | 'candidate' | 'ignore';
  actors?: { allow?: string[]; deny?: string[] };
  channels?: string[];
  semantic?: { policies: string[]; maxCandidatesPerHour: number };
}

export interface SourceEventFacts {
  mentioned: boolean;
  actorId: string;
  channelId?: string;
  repositoryComment?: boolean;
  bot?: boolean;
  selfLoop?: boolean;
}

export function validateSourceEventPolicy(policy: SourceEventPolicy): void {
  if (!record(policy) || Object.keys(policy).some(key => !['mode', 'actors', 'channels', 'semantic'].includes(key)) || !['explicit', 'candidate', 'ignore'].includes(policy.mode)) throw new Error('Source event policy mode or fields are invalid');
  if (policy.actors !== undefined && (!record(policy.actors) || Object.keys(policy.actors).some(key => !['allow', 'deny'].includes(key)))) throw new Error('Source actors must contain allow or deny lists');
  for (const values of [policy.actors?.allow, policy.actors?.deny, policy.channels]) {
    if (values !== undefined && (!Array.isArray(values) || values.length > 256 || values.some(value => typeof value !== 'string' || !value.trim() || value.length > 512))) throw new Error('Source event policy lists require bounded nonempty identifiers');
  }
  if (policy.semantic !== undefined) {
    if (!record(policy.semantic) || Object.keys(policy.semantic).some(key => !['policies', 'maxCandidatesPerHour'].includes(key))) throw new Error('Semantic filtering fields are invalid');
    const { policies, maxCandidatesPerHour } = policy.semantic;
    if (!Array.isArray(policies) || policies.length < 1 || policies.length > 16 || policies.some(value => typeof value !== 'string' || !value.trim() || value.length > 2_000)) throw new Error('Semantic filtering requires 1 to 16 policies of at most 2000 characters');
    if (!Number.isInteger(maxCandidatesPerHour) || maxCandidatesPerHour < 1 || maxCandidatesPerHour > 1_000) throw new Error('maxCandidatesPerHour must be between 1 and 1000');
  }
  if (policy.mode === 'candidate' && !policy.semantic) throw new Error('Candidate mode requires semantic policies and an hourly cap');
}

const record = (value: unknown): boolean => typeof value === 'object' && value !== null && !Array.isArray(value);
