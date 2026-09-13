export function trustedRunnerOptions({ uid, gid, environment }) {
  if (!Number.isInteger(uid) || uid < 1) throw new Error('untrusted runtime UID is invalid');
  if (!Number.isInteger(gid) || gid < 1) throw new Error('untrusted runtime GID is invalid');
  if (!environment || typeof environment !== 'object') {
    throw new Error('untrusted runtime environment is invalid');
  }
  return {
    cwd: '/opt/agent-runtime',
    env: { ...environment, RUN_AGENT_UID: String(uid), RUN_AGENT_GID: String(gid) },
    // The trusted runner reads credentials and commits fenced state. It drops
    // Codex and repository commands to the separate identity above.
    uid: 0,
    gid: 0,
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
  };
}
