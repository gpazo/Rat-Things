import { readdir } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { managedCodexPolicyMatches, type ManagedCodexPolicy } from '../domain/codex-managed-policy.js';

type Call = (method: string, params: Record<string, unknown>, timeoutMs?: number) => Promise<unknown>;

/** Check the running executor before any thread or tool can use its merged policy. */
export async function verifyManagedCodexPolicy(options: { call: Call; policy: ManagedCodexPolicy }): Promise<void> {
  try {
    const config = await options.call('config/read', { cwd: options.policy.workspace, includeLayers: true });
    const requirements = await options.call('configRequirements/read', {});
    if (!managedCodexPolicyMatches(config, requirements, options.policy) || !record(config) || !Array.isArray(config.layers)) throw new Error();
    const inspected = new Set<string>();
    for (const layer of config.layers) {
      if (!record(layer) || !record(layer.name) || !record(layer.config)) throw new Error();
      if (typeof layer.disabledReason === 'string' && layer.disabledReason.length > 0) continue;
      if (layer.name.type === 'sessionFlags') { inspected.add('sessionFlags'); continue; }
      // Other managed layers and project policy are not part of the host-owned envelope.
      if (!['user', 'system'].includes(String(layer.name.type)) || typeof layer.name.file !== 'string' || !isAbsolute(layer.name.file)) throw new Error();
      if (layer.name.type === 'system' && Object.keys(layer.config).length) throw new Error();
      inspected.add(String(layer.name.type));
      // Native network_rule grants can widen the proxy without appearing in config/read.
      // Refuse unfamiliar rule files instead of trying to emulate the upstream policy parser.
      const directory = join(dirname(layer.name.file), 'rules');
      const entries = await readdir(directory).catch((error: unknown) => {
        if (record(error) && error.code === 'ENOENT') return [];
        throw error;
      });
      if (entries.some(name => name.endsWith('.rules'))) throw new Error();
    }
    if (!['sessionFlags', 'user', 'system'].every(source => inspected.has(source))) throw new Error();
  } catch {
    throw new Error('Managed executor policy could not be verified. Refusing to expose execution tools.');
  }
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
