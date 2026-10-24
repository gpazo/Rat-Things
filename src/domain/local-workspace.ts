export interface LocalWorkspaceIdentity {
  version: 1;
  sessionId: string;
  generation: string;
  setupDigest: string;
}

export interface LocalWorkspaceIntent { kind: 'create' | 'resume'; identity: LocalWorkspaceIdentity }
export interface LocalSetupJournal { phase: 'started' | 'complete'; identity: LocalWorkspaceIdentity }

export function localWorkspaceIdentity(value: unknown): LocalWorkspaceIdentity {
  if (!record(value) || value.version !== 1 || typeof value.sessionId !== 'string' || !/^sess_[a-zA-Z0-9]+$/.test(value.sessionId)
    || typeof value.generation !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.generation)
    || typeof value.setupDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.setupDigest)) {
    throw new Error('Local workspace identity is unverified. Retain its files and start a new Session.');
  }
  return { version: 1, sessionId: value.sessionId, generation: value.generation, setupDigest: value.setupDigest };
}

export function sameLocalWorkspace(left: LocalWorkspaceIdentity, right: LocalWorkspaceIdentity): boolean {
  return left.version === right.version && left.sessionId === right.sessionId && left.generation === right.generation && left.setupDigest === right.setupDigest;
}

export function localSetupAction(intent: LocalWorkspaceIntent, journal: unknown): 'prepare' | 'preserve' {
  if (intent.kind === 'create') {
    if (journal !== undefined) throw new Error('A new local workspace already has setup state.');
    return 'prepare';
  }
  if (!record(journal) || !sameLocalWorkspace(localWorkspaceIdentity(journal.identity), intent.identity)) {
    throw new Error('The saved workspace does not match this Session. Retain its files and start a new Session.');
  }
  if (journal.phase !== 'complete') throw new Error('Local setup was interrupted. Its effects are uncertain; start a new Session without replaying setup.');
  return 'preserve';
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
