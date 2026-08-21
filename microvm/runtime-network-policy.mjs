import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const protectedUid = 10001;
const protectedPort = 8080;
const bpfRoot = '/sys/fs/bpf';
const policyRoot = join(bpfRoot, 'rat_things');
const programRoot = join(policyRoot, 'programs');
const mapRoot = join(policyRoot, 'maps');
const objectPath = process.env.RUNTIME_NETWORK_POLICY_OBJECT
  ?? '/opt/agent-runtime/runtime-network-policy.bpf.o';
const commandOptions = {
  encoding: 'utf8',
  timeout: 10_000,
};
const requiredPins = [
  join(programRoot, 'rat_deny4'),
  join(programRoot, 'rat_deny6'),
  join(mapRoot, 'local_v4'),
  join(mapRoot, 'local_v6'),
];

/**
 * Attach a cgroup connect policy that denies UID 10001 access to the trusted
 * lifecycle/control listener on every current guest address. Lambda invokes
 * hooks through a root-owned loopback proxy, so a UID-aware cgroup BPF policy
 * distinguishes that service traffic without relying on unavailable
 * netfilter modules. Public port 8080 destinations remain available.
 */
export function ensureUntrustedUidCannotReachPort({
  uid,
  port,
  execute = spawnSync,
  interfaces = networkInterfaces(),
  filesystem = defaultFilesystem,
} = {}) {
  if (uid !== protectedUid || port !== protectedPort) {
    throw new Error(`runtime network policy is compiled for UID ${protectedUid} and port ${protectedPort}`);
  }
  if (!filesystem.exists(objectPath)) throw new Error('compiled runtime network policy is missing');

  const cgroupPath = currentCgroupPath(filesystem.read('/proc/self/cgroup'));
  if (!filesystem.exists(cgroupPath)) throw new Error(`runtime cgroup does not exist: ${cgroupPath}`);

  filesystem.mkdir(bpfRoot);
  const mountpoint = execute('mountpoint', ['--quiet', bpfRoot], commandOptions);
  if (mountpoint.status !== 0) {
    requireSuccess(
      execute('mount', ['--types', 'bpf', 'bpf', bpfRoot], commandOptions),
      'mount the BPF filesystem',
    );
  }

  if (requiredPins.some((path) => !filesystem.exists(path))) {
    filesystem.remove(policyRoot);
    filesystem.mkdir(programRoot);
    filesystem.mkdir(mapRoot);
    requireSuccess(
      execute('bpftool', [
        'prog', 'loadall', objectPath, programRoot,
        'pinmaps', mapRoot,
      ], commandOptions),
      'load and pin the runtime cgroup programs',
    );
  }

  updateLocalAddressMaps({ execute, interfaces });
  attachMissingPrograms({ execute, cgroupPath });
  verifyPrograms({ execute, cgroupPath });
}

export function currentCgroupPath(raw) {
  const unified = String(raw).split(/\r?\n/).find((line) => line.startsWith('0::'));
  if (!unified) throw new Error('a unified cgroup v2 hierarchy is required');
  const relative = unified.slice(3);
  if (!relative.startsWith('/') || relative.includes('/../') || relative.endsWith('/..')) {
    throw new Error('runtime cgroup path is invalid');
  }
  return `/sys/fs/cgroup${relative === '/' ? '' : relative}`;
}

export function addressKey(address) {
  if (typeof address !== 'string') return undefined;
  const withoutZone = address.split('%', 1)[0].toLowerCase();
  const family = isIP(withoutZone);
  if (family === 4) {
    const bytes = withoutZone.split('.').map(Number);
    return { family: 4, bytes };
  }
  if (family !== 6) return undefined;
  return { family: 6, bytes: ipv6Bytes(withoutZone) };
}

function updateLocalAddressMaps({ execute, interfaces }) {
  const seen = new Set();
  for (const addresses of Object.values(interfaces)) {
    for (const entry of addresses ?? []) {
      const key = addressKey(entry?.address);
      if (!key) continue;
      const signature = `${key.family}:${key.bytes.join('.')}`;
      if (seen.has(signature)) continue;
      seen.add(signature);
      const map = join(mapRoot, key.family === 4 ? 'local_v4' : 'local_v6');
      requireSuccess(
        execute('bpftool', [
          'map', 'update', 'pinned', map,
          'key', 'hex', ...key.bytes.map(hexByte),
          'value', 'hex', '01',
          'any',
        ], commandOptions),
        `authorize the guest IPv${key.family} address map`,
      );
    }
  }
}

function attachMissingPrograms({ execute, cgroupPath }) {
  const attached = listAttachments({ execute, cgroupPath });
  for (const policy of [
    { attachType: 'cgroup_inet4_connect', name: 'rat_deny4' },
    { attachType: 'cgroup_inet6_connect', name: 'rat_deny6' },
  ]) {
    if (attached.some((entry) => entry.attach_type === policy.attachType && entry.name === policy.name)) {
      continue;
    }
    requireSuccess(
      execute('bpftool', [
        'cgroup', 'attach', cgroupPath, policy.attachType,
        'pinned', join(programRoot, policy.name),
      ], commandOptions),
      `attach the ${policy.name} runtime policy`,
    );
  }
}

function verifyPrograms({ execute, cgroupPath }) {
  const attached = listAttachments({ execute, cgroupPath });
  for (const [attachType, name] of [
    ['cgroup_inet4_connect', 'rat_deny4'],
    ['cgroup_inet6_connect', 'rat_deny6'],
  ]) {
    if (!attached.some((entry) => entry.attach_type === attachType && entry.name === name)) {
      throw new Error(`failed to verify the ${name} runtime policy`);
    }
  }
}

function listAttachments({ execute, cgroupPath }) {
  const result = execute('bpftool', ['--json', 'cgroup', 'show', cgroupPath], commandOptions);
  requireSuccess(result, 'inspect the runtime cgroup policies');
  try {
    const parsed = JSON.parse(result.stdout || '[]');
    if (!Array.isArray(parsed)) throw new Error('not an array');
    return parsed;
  } catch (error) {
    throw new Error(`failed to parse runtime cgroup policies: ${error.message}`);
  }
}

function ipv6Bytes(address) {
  const halves = address.split('::');
  if (halves.length > 2) throw new Error('IPv6 address is invalid');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) {
    throw new Error('IPv6 address is invalid');
  }
  const words = [...left, ...Array(missing).fill('0'), ...right];
  if (words.length !== 8) throw new Error('IPv6 address is invalid');
  return words.flatMap((word) => {
    const value = Number.parseInt(word || '0', 16);
    return [(value >> 8) & 0xff, value & 0xff];
  });
}

function hexByte(value) {
  return value.toString(16).padStart(2, '0');
}

function requireSuccess(result, operation) {
  if (result.status === 0) return;
  const diagnostic = `${result.error?.message ?? ''}\n${result.stderr ?? ''}\n${result.stdout ?? ''}`
    .trim()
    .slice(-1_000);
  throw new Error(`failed to ${operation}: ${diagnostic || 'no diagnostic output'}`);
}

const defaultFilesystem = {
  exists: existsSync,
  read: (path) => readFileSync(path, 'utf8'),
  mkdir: (path) => mkdirSync(path, { recursive: true }),
  remove: (path) => rmSync(path, { recursive: true, force: true }),
};
