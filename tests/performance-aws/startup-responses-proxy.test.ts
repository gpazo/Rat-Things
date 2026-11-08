import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { chmodSync, copyFileSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { SessionRuntime } from '../../src/runner/session-runtime.js';
import { bedrockTokenArguments } from '../../src/runner/agent-planning.js';
import { planStartupResponsesRequest, startStartupResponsesProxy } from '../../testing/performance-aws/startup-responses-proxy.mjs';

it('caps the provider request and removes Codex executor tools before forwarding', () => {
  const input = { model: 'openai.gpt-5.6-luna', stream: true, tools: [{ type: 'function', name: 'apply_patch' }], tool_choice: 'auto',
    max_output_tokens: 1_000_000, input: [{ role: 'user', content: [{ type: 'input_text', text: 'Do not log this input.' }] }] };
  const plan = planStartupResponsesRequest({ method: 'POST', url: '/openai/v1/responses', headers: {}, body: Buffer.from(JSON.stringify(input)), count: 1 });
  expect(plan.ok).toBe(true);
  if (!plan.ok) return;
  expect(JSON.parse(plan.forwardedBody.toString('utf8'))).toMatchObject({ model: 'openai.gpt-5.6-luna', tools: [], tool_choice: 'none', max_output_tokens: 128,
    input: input.input });
});

it('adds the same bounded overlay without changing other source ZIP entries or modes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rat-startup-proxy-image-'));
  const source = join(directory, 'source');
  const sourceZip = join(directory, 'source.zip');
  const beforeZip = join(directory, 'before.zip');
  const afterZip = join(directory, 'after.zip');
  const fixtureZip = join(directory, 'fixture.zip');
  mkdirSync(source);
  mkdirSync(join(source, 'config'), { recursive: true });
  mkdirSync(join(source, 'codex-runtime', 'bin'), { recursive: true });
  copyFileSync(resolve('microvm/Dockerfile'), join(source, 'Dockerfile'));
  copyFileSync(resolve('microvm/runtime-server.mjs'), join(source, 'runtime-server.mjs'));
  copyFileSync(resolve('config/codex.toml'), join(source, 'config/codex.toml'));
  writeFileSync(join(source, 'codex-runtime', 'bin', 'codex'), 'pinned-native-binary-fixture');
  chmodSync(join(source, 'codex-runtime', 'bin', 'codex'), 0o555);
  for (const name of ['Dockerfile', 'runtime-server.mjs', 'config/codex.toml', 'codex-runtime/bin/codex']) {
    utimesSync(join(source, name), 946_684_800, 946_684_800);
  }
  execFileSync('zip', ['-q', '-r', '-X', sourceZip, '.'], { cwd: source });

  try {
    for (const output of [beforeZip, afterZip]) {
      execFileSync(process.execPath, [resolve('testing/performance-aws/startup-responses-proxy-image.mjs'), sourceZip, output, '--mode', 'bedrock']);
    }
    execFileSync(process.execPath, [resolve('testing/performance-aws/startup-responses-proxy-image.mjs'), sourceZip, fixtureZip, '--mode', 'fixture']);

    const names = (archive: string) => execFileSync('unzip', ['-Z1', archive], { encoding: 'utf8' }).trim().split('\n').sort();
    const originalNames = names(sourceZip);
    const overlayNames = names(beforeZip);
    expect(overlayNames.filter(name => name.startsWith('startup-responses-proxy'))).toEqual([
      'startup-responses-proxy-manifest.json', 'startup-responses-proxy.mjs',
    ]);
    expect(overlayNames.filter(name => !name.startsWith('startup-responses-proxy'))).toEqual(originalNames);

    for (const name of originalNames.filter(name => !['Dockerfile', 'runtime-server.mjs', 'config/codex.toml'].includes(name))) {
      expect(execFileSync('unzip', ['-p', sourceZip, name])).toEqual(execFileSync('unzip', ['-p', beforeZip, name]));
    }
    const proxy = execFileSync('unzip', ['-p', beforeZip, 'startup-responses-proxy.mjs']);
    const manifest = JSON.parse(execFileSync('unzip', ['-p', beforeZip, 'startup-responses-proxy-manifest.json'], { encoding: 'utf8' }));
    expect(manifest).toMatchObject({ schema: 'rat-things.startup-responses-proxy.v1', mode: 'bedrock', listenHost: '127.0.0.1', listenPort: 43188,
      endpointPath: '/openai/v1/responses', providerBaseUrl: 'http://127.0.0.1:43188/openai/v1',
      forwardURL: 'https://bedrock-mantle.us-west-2.api.aws/openai/v1/responses', model: 'openai.gpt-5.6-luna',
      limits: { requestsPerVm: 1, requestBytes: 65_536, maxOutputTokens: 128, forwardTimeoutMs: 30_000, responseBytes: 1_048_576,
        requestMaxRetries: null, streamMaxRetries: null }, proxyRetries: 0,
      requestPolicy: { tools: 'forced_empty', toolChoice: 'none' }, responsePolicy: 'message_or_reasoning_items_only',
      nativeRetryConfiguration: 'built_in_amazon_bedrock_override_rejected' });
    expect(manifest.proxySha256).toBe(createHash('sha256').update(proxy).digest('hex'));
    expect(execFileSync('unzip', ['-p', beforeZip, 'runtime-server.mjs'], { encoding: 'utf8' })).toContain("await startStartupResponsesProxy({ mode: 'bedrock' });");
    expect(execFileSync('unzip', ['-p', fixtureZip, 'runtime-server.mjs'], { encoding: 'utf8' })).toContain("await startStartupResponsesProxy({ mode: 'fixture' });");
    expect(execFileSync('unzip', ['-p', beforeZip, 'config/codex.toml'], { encoding: 'utf8' })).toContain('base_url = "http://127.0.0.1:43188/openai/v1"');
    expect(execFileSync('unzip', ['-p', beforeZip, 'config/codex.toml'], { encoding: 'utf8' })).not.toContain('request_max_retries');
    expect(execFileSync('unzip', ['-p', beforeZip, 'config/codex.toml'], { encoding: 'utf8' })).not.toContain('stream_max_retries');
    expect(execFileSync('unzip', ['-p', beforeZip, 'startup-responses-proxy-manifest.json'])).toEqual(
      execFileSync('unzip', ['-p', afterZip, 'startup-responses-proxy-manifest.json']));
    expect(execFileSync('unzip', ['-p', beforeZip, 'runtime-server.mjs'])).toEqual(execFileSync('unzip', ['-p', afterZip, 'runtime-server.mjs']));
    const fixtureManifest = JSON.parse(execFileSync('unzip', ['-p', fixtureZip, 'startup-responses-proxy-manifest.json'], { encoding: 'utf8' }));
    expect(fixtureManifest).toMatchObject({ mode: 'fixture', forwardURL: null, proxySha256: manifest.proxySha256 });
    const dockerfile = execFileSync('unzip', ['-p', beforeZip, 'Dockerfile'], { encoding: 'utf8' });
    const executableList = dockerfile.match(/&& chmod 0555 \\\n([\s\S]*?)\n\s*&& chown -R agent:agent/)?.[1];
    expect(executableList).toContain('/opt/agent-runtime/startup-responses-proxy.mjs');
    expect(executableList).not.toContain('startup-responses-proxy-manifest.json');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('runs the built-in Amazon Bedrock provider against a deterministic loopback Responses fixture', async () => {
  const summaries: string[] = [];
  const decisions: unknown[] = [];
  const proxy = await startStartupResponsesProxy({ mode: 'fixture', port: 0, log: line => summaries.push(line), onDecision: decision => decisions.push(decision) });
  const home = await mkdtemp(join(tmpdir(), 'rat-startup-proxy-native-'));
  const tokenFile = join(home, 'token');
  const codexHome = join(home, '.codex');
  await mkdir(codexHome);
  await writeFile(tokenFile, 'loopback-fixture-token', { mode: 0o600 });
  await writeFile(join(codexHome, 'config.toml'), `model_provider = "amazon-bedrock"\n\n[model_providers.amazon-bedrock]\nbase_url = "http://127.0.0.1:${proxy.port}/openai/v1"\n`);
  const model = 'openai.gpt-5.6-luna';
  const runtime = new SessionRuntime({ sessionId: 'session_proxy', agentId: 'agent_proxy', request: {
    binary: process.env.CODEX_CONFORMANCE_BINARY ?? resolve('node_modules/.bin/codex'),
    binaryArguments: bedrockTokenArguments(tokenFile),
    workspace: home,
    environment: { PATH: process.env.PATH, HOME: home, CODEX_HOME: codexHome, AWS_REGION: 'us-west-2', AWS_EC2_METADATA_DISABLED: 'true' },
    timeoutMs: 20_000, persistent: true, prompt: '', sandbox: 'read-only', networkAccess: false, environments: [],
    modelProvider: 'amazon-bedrock', model,
    sessionConfig: { 'features.multi_agent': false, 'features.multi_agent_v2': { enabled: false, max_concurrent_threads_per_session: 1 },
      'features.code_mode': false },
  } });

  try {
    await runtime.initialize();
    await runtime.start({ id: 'turn_proxy', object: 'agent.session.turn', session_id: 'session_proxy', agent_id: 'agent_proxy', subagent_id: null,
      status: 'queued', created_at: 1, started_at: null, completed_at: null, error: null, usage: null },
    [{ role: 'user', content: [{ type: 'input_text', text: 'Reply with exactly OK.' }] }]);
    for (let attempt = 0; attempt < 2_000; attempt += 1) {
      if (['completed', 'failed', 'cancelled', 'incomplete'].includes(runtime.snapshot().turns[0]?.turn.status ?? '')) break;
      await delay(10);
    }

    const state = runtime.snapshot();
    const turn = state?.turns[0]?.turn;
    expect(turn?.status, JSON.stringify({ summaries, decisions, error: turn?.error })).toBe('completed');
    expect(state?.turns[0]?.items).toContainEqual(expect.objectContaining({
      type: 'message', role: 'assistant', content: expect.arrayContaining([expect.objectContaining({ type: 'output_text', text: 'OK' })]),
    }));
    expect(turn?.usage).toMatchObject({ input_tokens: 1, output_tokens: 1, total_tokens: 2 });
    const summary = summaries.map(line => JSON.parse(line.slice('startup-responses-proxy '.length))).find(entry => entry.count === 1);
    expect(summary).toMatchObject({ mode: 'fixture', model, count: 1, cap: 128, status: 'success', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } });
    expect(decisions).toContainEqual(expect.objectContaining({ accepted: true, endpointMatch: true, model, stream: true, toolCount: 2, toolChoice: 'auto' }));
    expect(summaries.join('\n')).not.toContain('loopback-fixture-token');
    expect(summaries.join('\n')).not.toContain('Reply with exactly OK');
  } finally {
    await runtime.close().catch(() => undefined);
    await proxy.close();
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 30_000);
