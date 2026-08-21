import { describe, expect, it, vi } from 'vitest';
import {
  addressKey,
  currentCgroupPath,
  ensureUntrustedUidCannotReachPort,
} from '../../microvm/runtime-network-policy.mjs';

describe('MicroVM runtime network policy', () => {
  it('encodes IPv4 and compressed IPv6 map keys in network byte order', () => {
    expect(addressKey('10.42.0.7')).toEqual({
      family: 4,
      bytes: [0x0a, 0x2a, 0x00, 0x07],
    });
    expect(addressKey('fd00::7')).toEqual({
      family: 6,
      bytes: [0xfd, 0x00, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 7],
    });
    expect(addressKey('fe80::1%eth0')).toEqual({
      family: 6,
      bytes: [0xfe, 0x80, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
    });
    expect(addressKey('not-an-address')).toBeUndefined();
  });

  it('resolves only a normalized cgroup v2 path', () => {
    expect(currentCgroupPath('0::/\n')).toBe('/sys/fs/cgroup');
    expect(currentCgroupPath('0::/runtime.slice/agent\n'))
      .toBe('/sys/fs/cgroup/runtime.slice/agent');
    expect(() => currentCgroupPath('2:cpu:/legacy\n')).toThrow('cgroup v2');
    expect(() => currentCgroupPath('0::/runtime/../escape\n')).toThrow('invalid');
  });

  it('updates local-address maps, attaches both UID policies, and verifies them', () => {
    let inspection = 0;
    const execute = vi.fn((command, args) => {
      if (command === 'mountpoint') return { status: 0, stdout: '', stderr: '' };
      if (command === 'bpftool' && args[0] === '--json') {
        inspection += 1;
        return {
          status: 0,
          stdout: inspection === 1 ? '[]' : JSON.stringify([
            { attach_type: 'cgroup_inet4_connect', name: 'rat_deny4' },
            { attach_type: 'cgroup_inet6_connect', name: 'rat_deny6' },
          ]),
          stderr: '',
        };
      }
      return { status: 0, stdout: '', stderr: '' };
    });
    const filesystem = {
      exists: vi.fn(() => true),
      read: vi.fn(() => '0::/runtime.slice/rat-things\n'),
      mkdir: vi.fn(),
      remove: vi.fn(),
    };

    ensureUntrustedUidCannotReachPort({
      uid: 10001,
      port: 8080,
      execute,
      filesystem,
      interfaces: {
        lo: [{ address: '127.0.0.1' }, { address: '::1' }],
        eth0: [{ address: '10.42.0.7' }],
      },
    });

    expect(execute).toHaveBeenCalledWith(
      'bpftool',
      expect.arrayContaining([
        'map', 'update', 'pinned', '/sys/fs/bpf/rat_things/maps/local_v4',
        'key', 'hex', '0a', '2a', '00', '07',
      ]),
      expect.objectContaining({ timeout: 10_000 }),
    );
    expect(execute).toHaveBeenCalledWith(
      'bpftool',
      [
        'cgroup', 'attach', '/sys/fs/cgroup/runtime.slice/rat-things',
        'cgroup_inet4_connect', 'pinned', '/sys/fs/bpf/rat_things/programs/rat_deny4',
      ],
      expect.any(Object),
    );
    expect(execute).toHaveBeenCalledWith(
      'bpftool',
      [
        'cgroup', 'attach', '/sys/fs/cgroup/runtime.slice/rat-things',
        'cgroup_inet6_connect', 'pinned', '/sys/fs/bpf/rat_things/programs/rat_deny6',
      ],
      expect.any(Object),
    );
  });

  it('fails closed if the compiled UID or port differs from runtime configuration', () => {
    expect(() => ensureUntrustedUidCannotReachPort({ uid: 10002, port: 8080 }))
      .toThrow('compiled for UID 10001');
    expect(() => ensureUntrustedUidCannotReachPort({ uid: 10001, port: 8081 }))
      .toThrow('compiled for UID 10001');
  });
});
