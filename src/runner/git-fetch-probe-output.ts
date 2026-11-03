import { isIP } from 'node:net';

const statuses = new Set<unknown>(['ok', 'budget_exhausted', 'unavailable', 'not_owned_child', 'target_exited', 'identity_lost']);
const minimalStatuses = new Set<unknown>(['invalid_input', 'unsupported_platform', 'internal_error']);
const accessStatuses = new Set<unknown>(['ok', 'denied', 'missing', 'unavailable', 'empty', 'too_large', 'malformed', 'changed', 'not_sampled', 'not_applicable', 'running', 'not_in_syscall']);
const waits = new Set<unknown>(['nfs_io', 'sunrpc', 'page_cache', 'page_fault', 'file_backed_fault', 'instruction_fault', 'data_fault', 'io_uring', 'event_poll', 'file_lock', 'futex', 'pipe_io', 'socket_io', 'runnable', 'unknown', 'child_wait', 'poll', 'socket_connect', 'sleep']);
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const integer = (value: unknown, min: number, max: number) => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
const waitArray = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0 && value.length <= waits.size &&
  value.every((item, index) => waits.has(item) && (index === 0 || value[index - 1] < item)) &&
  (!value.includes('unknown') || value.length === 1);

export function sanitizeGitFetchProbeOutput(bytes: unknown) {
  if (!Buffer.isBuffer(bytes) || bytes.length > 8192) return null;
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { return null; }
  if (!record(value) || value.v !== 1 || value.kind !== 'git_fetch' || !Array.isArray(value.processes) || value.processes.length > 16) return null;
  if (minimalStatuses.has(value.status) && value.processes.length === 0) return { v: 1, kind: 'git_fetch', status: value.status, processes: [] };
  if (!statuses.has(value.status) || !['aarch64', 'x86_64', 'unsupported'].includes(value.arch as string) ||
      !record(value.identity) || !accessStatuses.has(value.identity.before) || !accessStatuses.has(value.identity.after) ||
      !accessStatuses.has(value.proc_access) || !accessStatuses.has(value.tcp_access) || !accessStatuses.has(value.tcp6_access) || typeof value.capped !== 'boolean') return null;
  const processes = [];
  for (const item of value.processes) {
    if (!record(item) || !integer(item.pid, 1, 2147483647) || !integer(item.parent, 0, 2147483647) ||
        !(item.state === null || (typeof item.state === 'string' && /^[RSDZTtXxKWPI]$/.test(item.state))) ||
        !(item.state === null ? item.state_stable === null : typeof item.state_stable === 'boolean') ||
        !waitArray(item.waits) || !record(item.access) ||
        !Array.isArray(item.sockets) || item.sockets.length > 8) return null;
    const access: Record<string, unknown> = {};
    for (const field of ['stat', 'wchan', 'syscall', 'stack', 'fd']) {
      if (!accessStatuses.has(item.access[field])) return null;
      access[field] = item.access[field];
    }
    const sockets = [];
    for (const socket of item.sockets) {
      if (!record(socket) || (socket.family !== 4 && socket.family !== 6) ||
          typeof socket.address !== 'string' || socket.address.length > 45 || socket.address.includes('%') || isIP(socket.address) !== socket.family ||
          !integer(socket.port, 0, 65535) || !integer(socket.state, 1, 12)) return null;
      sockets.push({ family: socket.family, address: socket.address, port: socket.port, state: socket.state });
    }
    processes.push({ pid: item.pid, parent: item.parent, state: item.state, state_stable: item.state_stable, waits: item.waits.slice(), access, sockets });
  }
  return { v: 1, kind: 'git_fetch', status: value.status, arch: value.arch,
    identity: { before: value.identity.before, after: value.identity.after }, proc_access: value.proc_access,
    tcp_access: value.tcp_access, tcp6_access: value.tcp6_access, capped: value.capped, processes };
}
