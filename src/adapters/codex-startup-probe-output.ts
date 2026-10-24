const statuses = new Set<unknown>(['ok', 'budget_exhausted', 'unavailable', 'not_owned_child', 'target_exited', 'identity_lost']);
const minimalStatuses = new Set<unknown>(['invalid_input', 'unsupported_platform', 'internal_error']);
const accessStatuses = new Set<unknown>(['ok', 'denied', 'missing', 'unavailable', 'empty', 'too_large', 'malformed', 'changed', 'not_sampled', 'not_applicable', 'running', 'not_in_syscall']);
const waits = new Set<unknown>(['nfs_io', 'sunrpc', 'page_cache', 'page_fault', 'file_backed_fault', 'instruction_fault', 'data_fault', 'io_uring', 'event_poll', 'file_lock', 'futex', 'pipe_io', 'socket_io', 'runnable', 'unknown']);
const roles = new Set<unknown>(['launcher', 'codex_main', 'tokio_worker', 'sqlite_worker', 'other']);
const descriptors = new Set<unknown>(['installation_id', 'sqlite', 'rollout', 'codex_home_other', 'local_tmp', 'pipe', 'socket', 'other']);
const architectures = new Set<unknown>(['aarch64', 'x86_64', 'unsupported']);
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const integer = (value: unknown, min: number, max = Number.MAX_SAFE_INTEGER) => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
const waitArray = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0 && value.length <= waits.size &&
  value.every((item, index) => waits.has(item) && (index === 0 || value[index - 1] < item)) &&
  (!value.includes('unknown') || value.length === 1);

export function sanitizeProbeOutput(bytes: unknown) {
  if (!Buffer.isBuffer(bytes) || bytes.length > 8192) return null;
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { return null; }
  if (!record(value) || value.v !== 2 || !Array.isArray(value.threads) || value.threads.length > 32) return null;
  if (minimalStatuses.has(value.status) && value.threads.length === 0) return { v: 2, status: value.status, threads: [] };
  if (!statuses.has(value.status) || !architectures.has(value.arch) || !record(value.identity) ||
      !accessStatuses.has(value.identity.before) || !accessStatuses.has(value.identity.after) ||
      !accessStatuses.has(value.task_access) || typeof value.capped !== 'boolean') return null;
  const threads = [];
  for (const item of value.threads) {
    if (!record(item) || !integer(item.tid, 1, 2147483647) || !roles.has(item.role) ||
        !(item.state === null || (typeof item.state === 'string' && /^[RSDZTtXxKWPI]$/.test(item.state))) ||
        !(item.state === null ? item.state_stable === null : typeof item.state_stable === 'boolean') ||
        !(item.cpu_ticks === null || (Array.isArray(item.cpu_ticks) && item.cpu_ticks.length === 2 && item.cpu_ticks.every((number) => integer(number, 0)))) ||
        !(item.syscall === null || integer(item.syscall, -1, 2147483647)) ||
        !waitArray(item.waits) || !(item.fd === null || descriptors.has(item.fd)) || !record(item.access)) return null;
    const access: Record<string, unknown> = {};
    for (const field of ['stat', 'wchan', 'syscall', 'stack', 'fd']) {
      if (!accessStatuses.has(item.access[field])) return null;
      access[field] = item.access[field];
    }
    threads.push({ tid: item.tid, role: item.role, state: item.state, state_stable: item.state_stable,
      cpu_ticks: item.cpu_ticks?.slice() ?? null, syscall: item.syscall, waits: item.waits.slice(), fd: item.fd, access });
  }
  return { v: 2, status: value.status, arch: value.arch, identity: { before: value.identity.before, after: value.identity.after }, task_access: value.task_access, capped: value.capped, threads };
}
