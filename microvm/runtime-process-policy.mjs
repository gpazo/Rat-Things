export function untrustedChildOptions({ uid, gid, environment }) {
  if (!Number.isInteger(uid) || uid < 1) throw new Error('untrusted runtime UID is invalid');
  if (!Number.isInteger(gid) || gid < 1) throw new Error('untrusted runtime GID is invalid');
  if (!environment || typeof environment !== 'object') {
    throw new Error('untrusted runtime environment is invalid');
  }
  return {
    cwd: '/workspace',
    env: environment,
    uid,
    gid,
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
  };
}
