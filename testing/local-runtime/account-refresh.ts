import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { CodexRpcClient } from '../../src/adapters/codex-rpc.js';
import { localCodexArguments, localCodexEnvironment } from '../../src/runner/local-codex.js';

if (process.env.RAT_LIVE_SUBSCRIPTION !== '1') throw new Error('Set RAT_LIVE_SUBSCRIPTION=1 for account refresh acceptance');
const { values } = parseArgs({ options: { directory: { type: 'string' } } });
assert(values.directory, 'Choose the signed-in Rat Things directory');
const directory = resolve(values.directory);
const rpc = new CodexRpcClient({ binary: process.env.CODEX_BINARY ?? 'codex', binaryArguments: localCodexArguments(['app-server']),
  cwd: directory, environment: localCodexEnvironment(directory) });
try {
  await rpc.initialize();
  const before = await rpc.call('account/read', { refreshToken: false }) as { account?: { type?: string } };
  assert.equal(before.account?.type, 'chatgpt');
  const refreshed = await rpc.call('account/read', { refreshToken: true }) as { account?: { type?: string } };
  assert.equal(refreshed.account?.type, 'chatgpt');
  await rpc.call('account/rateLimits/read', {});
  await writeFile(join(directory, 'account-refresh-acceptance.json'), JSON.stringify({
    provider: 'chatgpt', refreshRequested: true, signedInAfter: true, authenticatedBackendReadAfter: true,
    tokenRotation: 'owned by Codex; credential contents not inspected', revokedLoginRecovery: 'not_exercised',
  }, null, 2), { mode: 0o600 });
  console.log('Explicit subscription refresh and subsequent authenticated backend read passed');
} finally { await rpc.close(); }
