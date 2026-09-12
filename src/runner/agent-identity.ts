export interface AgentProcessIdentity {
  uid: number;
  gid: number;
}

export function agentProcessIdentity(
  rawUid: string | undefined,
  rawGid: string | undefined,
): AgentProcessIdentity | undefined {
  if (!rawUid && !rawGid) return undefined;
  const uid = Number(rawUid);
  const gid = Number(rawGid);
  if (!Number.isInteger(uid) || uid < 1 || !Number.isInteger(gid) || gid < 1) {
    throw new Error('RUN_AGENT_UID and RUN_AGENT_GID must both be positive integers');
  }
  return { uid, gid };
}
