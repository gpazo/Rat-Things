import { describe, expect, it, vi } from 'vitest';
import { RuntimePluginRegistry } from '../../src/plugins/registry.js';
import type { RuntimePlugin } from '../../src/plugins/types.js';

function plugin(name = 'github'): RuntimePlugin {
  return {
    manifest: {
      name,
      version: '1',
      description: 'test plugin',
      provider: 'github',
    },
    ingress: {
      provider: 'github',
      receive: vi.fn(),
      acknowledge: vi.fn(),
    },
    delivery: {
      provider: 'github',
      deliver: vi.fn(),
    },
  };
}

describe('runtime plugin registry', () => {
  it('registers provider capabilities behind one manifest', () => {
    const github = plugin();
    const registry = new RuntimePluginRegistry([github]);

    expect(registry.list()).toEqual([github]);
    expect(registry.ingressFor('github')).toBe(github.ingress);
    expect(registry.deliveryFor('github')).toBe(github.delivery);
  });

  it('rejects duplicate names, duplicate providers, and invalid manifests', () => {
    expect(() => new RuntimePluginRegistry([plugin(), plugin()])).toThrow('duplicate plugin name github');
    expect(() => new RuntimePluginRegistry([plugin('github'), plugin('github-alt')]))
      .toThrow('duplicate ingress provider github');
    expect(() => new RuntimePluginRegistry([plugin('GitHub')])).toThrow('invalid plugin name GitHub');
  });
});
