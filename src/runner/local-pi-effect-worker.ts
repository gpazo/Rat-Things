import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { dirname } from 'node:path';
import { createPiEffectBroker } from './pi-effect-broker.js';
import { piEffectChannel } from './pi-effect-channel.js';
import { LOCAL_PI_POLICY_PATH, localPiEffectPolicy } from './local-pi-effect-policy.js';
import { planCodexLaunch } from './agent-planning.js';
import { publicTemplate } from '../domain/environment-planning.js';
import { sessionAgent } from '../core/session-planning.js';

async function workerEffects() {
  if (process.platform !== 'linux' || process.getuid?.() !== 10001) throw new Error('Managed effects require the isolated worker identity');
  const directory = await lstat(dirname(LOCAL_PI_POLICY_PATH));
  if (!directory.isDirectory() || directory.uid !== 0 || directory.mode & 0o022) throw new Error('Untrusted Pi policy directory');
  const file = await open(LOCAL_PI_POLICY_PATH, constants.O_RDONLY | constants.O_NOFOLLOW);
  const policy = await (async () => {
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.uid !== 0 || stat.mode & 0o022 || stat.size > 1024 * 1024) throw new Error('Untrusted Pi worker policy');
      return localPiEffectPolicy(JSON.parse(await file.readFile('utf8')));
    } finally { await file.close(); }
  })();
  let stopped = false;
  const plan = planCodexLaunch({ version: '1', prompt: '', agent: { sandbox: 'workspace-write' } }, '/workspace', 120000, {
    CODEX_BINARY: '/opt/codex-runtime/bin/codex', PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/home/agent', CODEX_HOME: '/home/agent/.codex',
  });
  const effects = await createPiEffectBroker({ plan, lease: { assertActive: async () => { if (stopped) throw new Error('Pi effect connection closed'); } },
    launch: { sessionId: policy.sessionId, turnId: '', agent: sessionAgent({ model: 'unused' }, 'local-pi-effects', 0), input: [],
      environment: { ...publicTemplate({ network: policy.network }, { id: policy.environmentId, created_at: 0, updated_at: 0 }), type: 'openai_hosted', files: [], skills: [] },
      hostedConfiguration: { env: policy.environment },
    },
  });
  return { effects, policy, disconnect: () => { stopped = true; } };
}

export async function verifyLocalManagedSandbox() {
  const { effects } = await workerEffects();
  await effects.close();
}

export async function runLocalPiEffectWorker(arguments_: string[]) {
  const [runId, epochText] = arguments_;
  const epoch = Number(epochText);
  if (arguments_.length !== 2 || !runId || !/^[a-f0-9-]{36}$/.test(runId) || !Number.isSafeInteger(epoch) || epoch < 0) throw new Error('Invalid Pi effect owner');
  const { effects, policy, disconnect } = await workerEffects();
  const channel = piEffectChannel(effects, { runId, epoch, sessionId: policy.sessionId, environmentId: policy.environmentId, generation: policy.generation });
  const reader = createInterface({ input: process.stdin });
  const stop = async () => { disconnect(); await channel.close(); reader.close(); };
  const reply = (id: unknown, value: unknown) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result: value })}\n`);
  const fail = (id: unknown) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32603, message: 'Pi effect operation failed' } })}\n`);
  reader.on('line', line => {
    if (Buffer.byteLength(line) > 8 * 1024 * 1024) { void stop().finally(() => process.exit(1)); return; }
    void (async () => {
      const request = JSON.parse(line);
      if (request.id === undefined) return;
      try {
        if (request.method === 'initialize') return reply(request.id, { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'rat-pi-effects', version: '1' } });
        if (request.method === 'tools/list') return reply(request.id, { tools: [{ name: 'bridge', description: 'Private Pi managed effect channel.', inputSchema: { type: 'object' } }] });
        if (request.method === 'ping') return reply(request.id, {});
        if (request.method !== 'tools/call' || request.params.name !== 'bridge') throw new Error('Unknown Pi bridge method');
        const result = await channel.call(request.params.arguments);
        reply(request.id, { content: [{ type: 'text', text: JSON.stringify(result) }] });
      } catch { fail(request.id); }
    })().catch(() => { void stop().finally(() => process.exit(1)); });
  });
  reader.once('close', () => { void stop().then(() => process.exit(0), () => process.exit(1)); });
  process.once('SIGTERM', () => { void stop().then(() => process.exit(0), () => process.exit(1)); });
}
