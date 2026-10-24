import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { sanitizeProbeOutput } from '../../src/adapters/codex-startup-probe-output.js';

const access = { stat: 'ok', wchan: 'ok', syscall: 'not_in_syscall', stack: 'ok', fd: 'not_applicable' };
const thread = { tid: 42, role: 'codex_main', state: 'D', state_stable: true, cpu_ticks: [10, 20], syscall: -1,
  waits: ['page_cache', 'page_fault'], fd: null, access };
const observation = { v: 2, status: 'ok', arch: 'aarch64', identity: { before: 'ok', after: 'ok' },
  task_access: 'ok', capped: false, threads: [thread] };
const sanitize = (value: unknown) => sanitizeProbeOutput(Buffer.from(JSON.stringify(value)));

it('runs the inert Python proc fixtures through the normal test suite', async () => {
  await expect(promisify(execFile)('python3', ['-B', '-I', '-S', 'testing/microvm/test_startup_probe.py'], { timeout: 15_000 }))
    .resolves.toMatchObject({ stdout: '' });
});

it('accepts the actual Python encoder output from inert proc fixtures', async () => {
  const program = `
import runpy
fixture = runpy.run_path("testing/microvm/test_startup_probe.py")
case = fixture["ProbeTests"]()
case.setUp()
try:
    path = fixture["thread"](case.root, tid=43, number=999, symbol="folio_wait_bit_common", state="D", comm="codex-main")
    (path / "stack").write_text("filemap_fault+0x1/0x2\\nel0_ia+0x1/0x2\\n")
    print(case.probe._encode(case.probe._sample(42, 7, "aarch64")), end="")
finally:
    case.doCleanups()
`;
  const { stdout, stderr } = await promisify(execFile)('python3', ['-B', '-I', '-S', '-c', program], { timeout: 15_000 });
  expect(stderr).toBe('');
  const result = sanitizeProbeOutput(Buffer.from(stdout));
  expect(result).toEqual(JSON.parse(stdout));
  expect(result?.threads).toMatchObject([{ role: 'launcher' }, { role: 'codex_main', state_stable: true, waits: ['file_backed_fault', 'instruction_fault', 'page_cache', 'page_fault'] }]);
});

it('retains fixed v2 roles, mixed contexts and both state comparison results', () => {
  expect(sanitize(observation)).toEqual(observation);
  for (const state_stable of [true, false]) {
    expect(sanitize({ ...observation, threads: [{ ...thread, state_stable }] })?.threads[0]).toMatchObject({ state_stable });
  }
  for (const role of ['launcher', 'codex_main', 'tokio_worker', 'sqlite_worker', 'other']) {
    expect(sanitize({ ...observation, threads: [{ ...thread, role }] })?.threads[0]).toMatchObject({ role });
  }
  const waits = ['data_fault', 'event_poll', 'file_backed_fault', 'file_lock', 'futex', 'instruction_fault', 'io_uring', 'nfs_io', 'page_cache', 'page_fault', 'pipe_io', 'runnable', 'socket_io', 'sunrpc'];
  expect(sanitize({ ...observation, threads: [{ ...thread, waits }] })?.threads[0]).toMatchObject({ waits });
});

it('retains unavailable observations without inventing a state comparison', () => {
  const unavailable = { ...thread, role: 'other', state: null, state_stable: null, cpu_ticks: null, syscall: null,
    waits: ['unknown'], access: { ...access, stat: 'denied', stack: 'malformed' } };
  expect(sanitize({ ...observation, threads: [unavailable] })?.threads).toEqual([unavailable]);
});

it.each(['invalid_input', 'unsupported_platform', 'internal_error'])('accepts bounded minimal v2 status %s', status => {
  expect(sanitize({ v: 2, status, threads: [], raw: 'secret' })).toEqual({ v: 2, status, threads: [] });
  expect(sanitize({ v: 2, status, threads: [thread] })).toBeNull();
});

it('reconstructs every nesting level and discards raw names, symbols, paths, pointers and arguments', () => {
  const secret = 'secret-token';
  const unsafe = { ...observation, raw: secret, identity: { ...observation.identity, raw: secret }, threads: [{
    ...thread, comm: secret, wchan: secret, stack: secret, target: `/tmp/${secret}`, pointer: secret, argv: secret, wait: secret,
    access: { ...access, raw: secret },
  }] };
  const result = sanitize(unsafe);
  expect(result).toEqual(observation);
  expect(JSON.stringify(result)).not.toContain(secret);
});

it.each([
  [], ['unknown', 'sunrpc'], ['sunrpc', 'sunrpc'], ['sunrpc', 'nfs_io'], ['secret_symbol'],
  ['filemap_fault'], 'page_cache', null, Array(13).fill('unknown'),
])('rejects an unsafe or noncanonical waits array %j', waits => {
  expect(sanitize({ ...observation, threads: [{ ...thread, waits }] })).toBeNull();
});

it.each([
  { role: 'secret-token' }, { role: undefined }, { state_stable: 'secret-token' }, { state_stable: 0 },
  { state_stable: undefined }, { state_stable: null }, { state: null, state_stable: true },
  { tid: 0 }, { tid: 2147483648 }, { state: 'secret-token' },
  { cpu_ticks: [-1, 0] }, { cpu_ticks: [Number.MAX_SAFE_INTEGER + 1, 0] }, { syscall: -2 },
  { fd: '/secret/path' }, { access: { ...access, stack: 'secret-token' } },
])('rejects malformed fixed fields %j', fields => {
  expect(sanitize({ ...observation, threads: [{ ...thread, ...fields }] })).toBeNull();
});

it('rejects v1 and out-of-bounds output', () => {
  expect(sanitize({ ...observation, v: 1 })).toBeNull();
  const compactThread = { ...thread, tid: 1, role: 'other', cpu_ticks: [0, 0], syscall: 0, waits: ['unknown'],
    access: { stat: 'ok', wchan: 'ok', syscall: 'ok', stack: 'ok', fd: 'ok' } };
  const tooMany = { ...observation, threads: Array(33).fill(compactThread) };
  expect(Buffer.byteLength(JSON.stringify(tooMany))).toBeLessThan(8192);
  expect(sanitize(tooMany)).toBeNull();
  expect(sanitize({ ...observation, threads: Array(32).fill(compactThread) })?.threads).toHaveLength(32);
  expect(sanitizeProbeOutput(Buffer.alloc(8193))).toBeNull();
  expect(sanitizeProbeOutput('secret')).toBeNull();
  expect(sanitizeProbeOutput(Buffer.from('secret'))).toBeNull();
  const bytes = Buffer.from(JSON.stringify(observation));
  expect(sanitizeProbeOutput(Buffer.concat([bytes, Buffer.alloc(8192 - bytes.length, ' ')]))).toEqual(observation);
});
