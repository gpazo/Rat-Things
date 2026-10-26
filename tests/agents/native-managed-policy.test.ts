import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { CodexRpcClient } from '../../src/adapters/codex-rpc.js';
import { verifyManagedCodexPolicy } from '../../src/adapters/codex-managed-policy.js';
import { hostedCodexArguments } from '../../src/runner/hosted-environment-planning.js';
import type { ManagedCodexPolicy } from '../../src/domain/codex-managed-policy.js';
import { localCodexArguments } from '../../src/runner/local-codex.js';

it.each(['clean', 'restricted-uppercase', 'untrusted-project', 'inherited-domain', 'inherited-filesystem', 'inherited-credential-broker', 'private-rules'] as const)(
  'checks the actual official executor policy before tools: %s', async mode => {
    const root = await mkdtemp(join(tmpdir(), 'rat-native-policy-'));
    const home = join(root, 'home'), workspace = join(root, 'workspace');
    await mkdir(home); await mkdir(workspace);
    const policy: ManagedCodexPolicy = { workspace, network: mode === 'restricted-uppercase'
      ? { access: 'restricted', allowed_domains: ['API.Example.com'] } : { access: 'disabled', allowed_domains: [] }, credentialProxy: false };
    if (mode === 'untrusted-project') {
      await mkdir(join(workspace, '.codex', 'rules'), { recursive: true });
      await writeFile(join(home, 'config.toml'), `[projects.${JSON.stringify(workspace)}]\ntrust_level="trusted"\n`);
      await writeFile(join(workspace, '.codex', 'config.toml'), '[features.network_proxy.domains]\n"1.1.1.1"="allow"\n');
      await writeFile(join(workspace, '.codex', 'rules', 'default.rules'), 'network_rule(host="1.1.1.1", protocol="http", decision="allow")\n');
    }
    if (mode === 'inherited-domain') await writeFile(join(home, 'config.toml'), '[features.network_proxy.domains]\n"1.1.1.1"="allow"\n');
    if (mode === 'inherited-filesystem') await writeFile(join(home, 'config.toml'), `[permissions.rat_managed.filesystem]\n${JSON.stringify(root)}="write"\n`);
    if (mode === 'inherited-credential-broker') await writeFile(join(home, 'config.toml'), '[features.network_proxy]\ncredential_broker=true\ndangerously_allow_all_unix_sockets=true\n');
    if (mode === 'private-rules') {
      await mkdir(join(home, 'rules'));
      await writeFile(join(home, 'rules', 'default.rules'), 'network_rule(host="1.1.1.1", protocol="http", decision="allow")\n');
    }
    const rpc = new CodexRpcClient({ binary: process.env.CODEX_CONFORMANCE_BINARY ?? resolve('node_modules/.bin/codex'),
      cwd: workspace, binaryArguments: hostedCodexArguments(undefined, policy.network, false, workspace),
      environment: { PATH: process.env.PATH, HOME: home, CODEX_HOME: home, CODEX_API_KEY: 'no-inference-policy-fixture' },
      onServerRequest: async () => { throw new Error('Unexpected approval'); },
    });
    try {
      await rpc.initialize();
      const verified = verifyManagedCodexPolicy({ call: rpc.call.bind(rpc), policy });
      if (mode === 'clean' || mode === 'restricted-uppercase' || mode === 'untrusted-project') await expect(verified).resolves.toBeUndefined();
      else await expect(verified).rejects.toThrow('Refusing to expose execution tools');
    } finally { await rpc.close(); await rm(root, { recursive: true, force: true }); }
  }, 15_000);

it.each(['chatgpt', 'api'] as const)('accepts the official %s login restriction with a separate guest workspace', async login => {
  const root = await mkdtemp(join(tmpdir(), 'rat-native-remote-policy-'));
  const home = join(root, 'home');
  // The host harness has no guest workspace mounted locally. Policy verification
  // must preserve its remote path rather than substituting the host process cwd.
  const workspace = join(root, 'absent-guest-workspace');
  await mkdir(home);
  const policy: ManagedCodexPolicy = { workspace, network: { access: 'disabled', allowed_domains: [] }, credentialProxy: false };
  const arguments_ = hostedCodexArguments(localCodexArguments(['app-server']), policy.network, false, workspace);
  // Keep the final override last: the production local arguments intentionally force ChatGPT.
  if (login === 'api') arguments_.splice(arguments_.length - 1, 0, '-c', 'forced_login_method="api"');
  const rpc = new CodexRpcClient({ binary: process.env.CODEX_CONFORMANCE_BINARY ?? resolve('node_modules/.bin/codex'),
    cwd: home, binaryArguments: arguments_, environment: { PATH: process.env.PATH, HOME: home, CODEX_HOME: home },
    onServerRequest: async () => { throw new Error('Unexpected approval'); },
  });
  try {
    await rpc.initialize();
    const requirements = await rpc.call('configRequirements/read', {});
    expect(requirements).toMatchObject({ requirements: { allowedLoginMethods: [login] } });
    await expect(verifyManagedCodexPolicy({ call: rpc.call.bind(rpc), policy })).resolves.toBeUndefined();
  } finally { await rpc.close(); await rm(root, { recursive: true, force: true }); }
}, 15_000);
