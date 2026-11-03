import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { sanitizeGitFetchProbeOutput } from '../../src/runner/git-fetch-probe-output.js';

const access = { stat: 'ok', wchan: 'ok', syscall: 'ok', stack: 'ok', fd: 'ok' };
const socket = { family: 4, address: '20.29.134.23', port: 443, state: 2 };
const member = { pid: 42, parent: 7, state: 'S', state_stable: true, waits: ['child_wait'], access, sockets: [socket] };
const observation = { v: 1, kind: 'git_fetch', status: 'ok', arch: 'aarch64', identity: { before: 'ok', after: 'ok' },
  proc_access: 'ok', tcp_access: 'ok', tcp6_access: 'ok', capped: false, processes: [member] };
const sanitize = (value: unknown) => sanitizeGitFetchProbeOutput(Buffer.from(JSON.stringify(value)));

it('runs the inert Python Git fixtures through the normal test suite', async () => {
  await expect(promisify(execFile)('python3', ['-B', '-I', '-S', 'testing/microvm/test_git_fetch_probe.py'], { timeout: 15_000 }))
    .resolves.toMatchObject({ stdout: '' });
}, 20_000);

it('accepts the actual Git helper output from inert proc fixtures', async () => {
  const program = `
import runpy
fixture = runpy.run_path("testing/microvm/test_git_fetch_probe.py")
case = fixture["GitProbeTests"]()
case.setUp()
try:
    print(case.probe._encode(case.probe._sample_git(42, 7, "aarch64")), end="")
finally:
    case.doCleanups()
`;
  const { stdout, stderr } = await promisify(execFile)('python3', ['-B', '-I', '-S', '-c', program], { timeout: 15_000 });
  expect(stderr).toBe('');
  expect(sanitizeGitFetchProbeOutput(Buffer.from(stdout))).toEqual(JSON.parse(stdout));
}, 20_000);

it('reconstructs all nested fields without passing raw helper data', () => {
  const raw = 'secret-token';
  const unsafe = { ...observation, raw, identity: { ...observation.identity, raw }, processes: [{
    ...member, comm: raw, wchan: raw, argv: raw, env: raw, pointer: raw, fd: raw,
    access: { ...access, raw }, sockets: [{ ...socket, path: raw, hostname: raw }],
  }] };
  expect(sanitize(unsafe)).toEqual(observation);
  expect(JSON.stringify(sanitize(unsafe))).not.toContain(raw);
});

it.each([
  { address: 'secret.example.com' }, { address: 'fe80::1%secret' }, { address: '2001:db8::1' },
  { port: -1 }, { port: 65536 }, { state: 'SYN_SENT' }, { state: 0 }, { state: 13 }, { family: 5 },
])('rejects invalid TCP endpoints %j', fields => {
  expect(sanitize({ ...observation, processes: [{ ...member, sockets: [{ ...socket, ...fields }] }] })).toBeNull();
});

it.each([
  { waits: ['secret'] }, { waits: ['child_wait', 'child_wait'] }, { waits: ['unknown', 'poll'] }, { waits: [] },
  { pid: 0 }, { pid: 2147483648 }, { parent: -1 }, { state: 'secret' }, { state_stable: null },
  { access: { ...access, stat: 'secret' } }, { sockets: Array(9).fill(socket) },
])('rejects invalid process fields %j', fields => {
  expect(sanitize({ ...observation, processes: [{ ...member, ...fields }] })).toBeNull();
});

it('accepts explicit missing data and numeric IPv6 destinations', () => {
  const value = { ...observation, tcp_access: 'denied', processes: [{ ...member, state: null, state_stable: null,
    waits: ['unknown'], sockets: [{ family: 6, address: '2001:db8::1', port: 443, state: 1 }] }] };
  expect(sanitize(value)).toEqual(value);
});

it('caps input bytes and process arrays and rejects malformed helpers', () => {
  expect(sanitize({ ...observation, processes: Array(17).fill(member) })).toBeNull();
  expect(sanitize({ ...observation, v: 2 })).toBeNull();
  expect(sanitize({ ...observation, identity: null })).toBeNull();
  expect(sanitize({ ...observation, tcp_access: 'secret' })).toBeNull();
  expect(sanitizeGitFetchProbeOutput(Buffer.alloc(8193))).toBeNull();
  expect(sanitizeGitFetchProbeOutput(Buffer.from('secret'))).toBeNull();
  expect(sanitizeGitFetchProbeOutput('secret')).toBeNull();
  for (const status of ['invalid_input', 'unsupported_platform', 'internal_error']) {
    const value = { v: 1, kind: 'git_fetch', status, processes: [] };
    expect(sanitize({ ...value, raw: 'secret' })).toEqual(value);
    expect(sanitize({ ...value, processes: [member] })).toBeNull();
  }
});
