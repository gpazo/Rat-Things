import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { setTimeout as delay } from 'node:timers/promises';
import { commandArguments, commandProof, cloudCommand, historyContent, installedEnvironment, parseAcceptanceArguments,
  packagedProcesses, cliDocuments, subscriptionEvidence, transferPlan, transferScenario, allItems, runInstalledCloudTransfer } from '../../testing/local-runtime/installed-cloud-transfer.mjs';
import { commandProof as subscriptionCommandProof, expectedProof, verificationProgram } from '../../testing/local-runtime/installed-subscription.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const nonce = '11111111-2222-4333-8444-555555555555';
const cloudNonce = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const transferId = '12345678-2222-4333-8444-555555555555';
const binding = { app: '/Applications/Rat Things.app', directory: '/private/profile', releaseId: '1'.repeat(64) };
const destination = { endpoint: 'https://example.execute-api.us-west-2.amazonaws.com/v1', region: 'us-west-2', model: 'explicit-cloud-model' };
const commandLine = ['--app', binding.app, '--directory', binding.directory, '--evidence', '/private/profile/evidence.json',
  '--endpoint', destination.endpoint, '--region', destination.region, '--model', destination.model];
const program = verificationProgram(nonce, binding.directory);
function acceptanceEvidence() {
  const first = expectedProof(nonce, program, 'first'); const resumed = expectedProof(nonce, program, 'resume');
  return { ...binding, version: 2, status: 'passed', runtime: 'installed-native', nonce, sessionId: 'sess_source', environmentId: 'env_source', model: 'explicit-local-model',
    local: { firstTurnId: 'turn_first', resumedTurnId: 'turn_resumed', firstCommandId: 'cmd_first', resumedCommandId: 'cmd_resumed',
      restart: 'graceful', fileContentSource: 'command_execution.output', proofSha256: first.files.find(file => file.path === 'live-proof.json').sha256, programSha256: sha256(program) },
    observations: { firstCommand: { commandId: 'cmd_first', turnId: 'turn_first', source: 'command_execution.output', proof: first },
      resumeCommand: { commandId: 'cmd_resumed', turnId: 'turn_resumed', source: 'command_execution.output', proof: resumed } } };
}
const source = () => subscriptionEvidence(acceptanceEvidence(), binding);
function scenarioFixture(change = {}) {
  const selected = source(); const command = cloudCommand(cloudNonce, selected); const calls = []; const records = {};
  let sent = false; let restarted = false;
  const sourceItems = selected.commands.map((entry, index) => ({ id: entry.commandId, type: 'command_execution', turn_id: entry.turnId,
    status: 'completed', exit_code: 0, command: `node /workspace/rat-acceptance.cjs ${index ? 'resume' : 'first'}`,
    output: `RAT_INSTALLED_SUBSCRIPTION_PROOF ${JSON.stringify(entry.proof)}\n` }));
  const localSession = { id: selected.sessionId, object: 'agent.session', status: 'idle', required_actions: [], vault_ids: [], metadata: { acceptance: 'local' },
    agent: { id: 'agent_source', name: null, model: selected.model, instructions: 'Keep instructions', reasoning: { effort: 'medium' }, multi_agent: { enabled: false, max_concurrent_subagents: null }, tools: [], service_tier: 'auto' },
    environment: { type: 'openai_hosted', id: selected.environmentId } };
  const cloudSession = { ...localSession, id: 'sess_cloud', agent: { ...localSession.agent, id: 'agent_cloud', model: destination.model }, environment: { type: 'openai_hosted', id: 'env_cloud' } };
  const planned = { id: transferId, source_session_id: selected.sessionId, source_model: selected.model, model: destination.model,
    destination: { baseURL: destination.endpoint, region: destination.region }, status: 'ready', files: 4,
    bytes: selected.files.reduce((sum, file) => sum + file.bytes, 0), history_items: sourceItems.length, uploaded_parts: 0, total_parts: 1, destination_session_id: null, error: null };
  const complete = { ...planned, status: 'complete', uploaded_parts: 1, destination_session_id: 'sess_cloud' };
  const cloudItem = { id: 'cmd_cloud', type: 'command_execution', turn_id: 'turn_cloud', status: 'completed', exit_code: 0, command: command.command, output: command.output };
  const list = data => ({ object: 'list', data, has_more: false });
  const cli = async (scope, args) => {
    calls.push([scope, args]);
    const replacement = change.cli?.({ scope, args, sent, restarted, localSession, cloudSession, sourceItems, cloudItem, planned, complete });
    if (replacement !== undefined) return replacement;
    if (args[0] === 'transfer') {
      if (args[1] === 'plan') return planned;
      return complete;
    }
    if (args[1] === 'get') return scope === 'local' ? localSession : cloudSession;
    if (args[1] === 'items') return list(scope === 'local' ? sourceItems : [...sourceItems.map(item => ({ ...item, id: `copy_${item.id}`, turn_id: `copy_${item.turn_id}`, session_id: 'sess_cloud', created_at: 17 })), ...(sent ? [cloudItem] : [])]);
    if (args[1] === 'turns') return list(sent ? [{ id: 'turn_cloud', status: 'completed' }] : []);
    if (args[1] === 'send') { sent = true; return; }
    throw new Error('Unexpected fake CLI call');
  };
  const run = () => transferScenario({ source: selected, ...destination, nonce: cloudNonce }, { cli,
    restart: async () => { restarted = true; }, record: async (name, value) => { records[name] = value; }, signal: new AbortController().signal,
    sleep: async () => { throw new Error('Unexpected fixture delay'); } });
  return { run, calls, records, sourceItems, cloudItem, planned, complete };
}

describe('installed cloud transfer inputs and evidence', () => {
  it('requires opt-in and all explicit destination fields before reading files or starting services', async () => {
    expect(() => parseAcceptanceArguments(commandLine, {})).toThrow('RAT_INSTALLED_CLOUD_ACCEPTANCE');
    expect(() => parseAcceptanceArguments(commandLine.slice(0, -2), { RAT_INSTALLED_CLOUD_ACCEPTANCE: '1' })).toThrow('Explicit');
    const previous = process.env.RAT_INSTALLED_CLOUD_ACCEPTANCE;
    delete process.env.RAT_INSTALLED_CLOUD_ACCEPTANCE;
    try { await expect(runInstalledCloudTransfer({})).rejects.toThrow('RAT_INSTALLED_CLOUD_ACCEPTANCE'); }
    finally { if (previous === undefined) delete process.env.RAT_INSTALLED_CLOUD_ACCEPTANCE; else process.env.RAT_INSTALLED_CLOUD_ACCEPTANCE = previous; }
  });

  it('canonicalizes only valid HTTPS Agents endpoints and rejects embedded credentials and unknown flags', () => {
    expect(parseAcceptanceArguments(commandLine, { RAT_INSTALLED_CLOUD_ACCEPTANCE: '1' }).endpoint).toBe(destination.endpoint);
    for (const endpoint of ['http://localhost:1/v1', 'https://user:password@example.com/v1', 'https://example.com/v1?secret=value', 'https://example.com/other']) {
      const args = [...commandLine]; args[7] = endpoint;
      expect(() => parseAcceptanceArguments(args, { RAT_INSTALLED_CLOUD_ACCEPTANCE: '1' })).toThrow();
    }
    expect(() => parseAcceptanceArguments([...commandLine, '--resume', transferId], { RAT_INSTALLED_CLOUD_ACCEPTANCE: '1' })).toThrow();
  });

  it('passes only named AWS chain inputs without ambient model, source, account, or executable overrides', () => {
    const environment = installedEnvironment('/profile', '/temp', 'us-west-2', { HOME: '/home', AWS_PROFILE: 'fixture', AWS_ACCESS_KEY_ID: 'fixture-key',
      AWS_SECRET_ACCESS_KEY: 'fixture-secret', AWS_DEFAULT_REGION: 'wrong', PATH: '/untrusted', NODE_OPTIONS: '--require evil', CODEX_HOME: '/auth',
      OPENAI_API_KEY: 'do-not-inherit', RAT_THINGS_API_URL: 'https://wrong.invalid', RAT_NATIVE_HELPER: '/evil', HTTP_PROXY: 'http://proxy.invalid' });
    expect(environment.HOME).toBe('/home'); expect(environment.AWS_PROFILE).toBe('fixture'); expect(environment.AWS_SECRET_ACCESS_KEY).toBe('fixture-secret');
    expect(environment.PATH).toBe('/usr/bin:/bin:/usr/sbin:/sbin'); expect(environment.AWS_DEFAULT_REGION).toBe('us-west-2');
    for (const name of ['NODE_OPTIONS', 'CODEX_HOME', 'OPENAI_API_KEY', 'RAT_THINGS_API_URL', 'RAT_NATIVE_HELPER']) expect(environment).not.toHaveProperty(name);
  });

  it('binds subscription proof to the installed release and exact nonce-bound file content', () => {
    expect(source().files).toHaveLength(4);
    for (const edit of [value => { value.releaseId = '2'.repeat(64); }, value => { value.directory = '/other'; },
      value => { value.status = 'running'; }, value => { value.observations.resumeCommand.proof.files[0].sha256 = '2'.repeat(64); },
      value => { value.local.resumedTurnId = value.local.firstTurnId; }]) {
      const value = acceptanceEvidence(); edit(value); expect(() => subscriptionEvidence(value, binding)).toThrow();
    }
  });

  it('reads bounded concatenated transfer JSON without accepting error JSON or arbitrary text as a successful receipt', () => {
    const fixture = scenarioFixture();
    const output = `${JSON.stringify({ ...fixture.planned, status: 'preparing' }, null, 2)}\n${JSON.stringify(fixture.planned, null, 2)}\nReview the destination and snapshot above. Copy with: rat-things transfer run ${transferId}\n`;
    expect(cliDocuments(output, true)).toHaveLength(2);
    expect(() => cliDocuments(`${output}extra`, true)).toThrow();
    expect(() => cliDocuments('{"id":"unfinished', true)).toThrow();
    expect(() => cliDocuments('x'.repeat(8 * 1024 ** 2 + 1))).toThrow('limit');
    expect(() => transferPlan({ error: { message: 'secret backend detail' } }, source(), destination)).toThrow('receipt');
    expect(transferPlan({ ...fixture.planned, status: 'failed', error: 'secret backend detail' }, source(), destination)).not.toHaveProperty('error');
  });
});

describe('real cloud command proof contract', () => {
  it('accepts the exact argv directly or in one shell wrapper and rejects added commands or expansion', () => {
    const expected = cloudCommand(cloudNonce, source());
    expect(commandArguments(expected.command)).toEqual(expected.argv);
    const wrapper = `/bin/sh -lc '${expected.command.replaceAll("'", "'\"'\"'")}'`;
    expect(commandArguments(wrapper)).toEqual(expected.argv);
    for (const command of [`${expected.command}; echo forgery`, `${expected.command}\necho forgery`, 'node -e "$PROGRAM"', 'node -e `echo forgery`', 'node -e *', "node -e 'unterminated"]) {
      expect(() => commandArguments(command)).toThrow();
    }
  });

  it('runs the requested proof against an inert fake filesystem and checks all four contents and setup once', () => {
    const selected = source(); const command = cloudCommand(cloudNonce, selected);
    const proof = JSON.stringify({ nonce, uid: 10001, platform: 'linux', auth: false, socket: false, host: false, networkBlocked: true });
    const values = new Map([['rat-acceptance.cjs', program], ['live-proof.json', proof], ['setup-count', 'once'], ['live-resumed.json', JSON.stringify({ nonce, originalSha256: sha256(proof) })]]);
    let stdout = '';
    const fs = { readFileSync: (path, encoding) => { const value = values.get(path.replace('/workspace/', '')); if (value === undefined) throw new Error('missing'); return encoding ? value : Buffer.from(value); },
      writeFileSync: (path, bytes, options) => { expect(options.flag).toBe('wx'); const key = path.replace('/workspace/', ''); expect(values.has(key)).toBe(false); values.set(key, bytes.toString()); } };
    const require = name => { if (name === 'node:fs') return fs; if (name === 'node:crypto') return { createHash }; if (name === 'node:assert/strict') return { equal: (a, b) => expect(a).toBe(b), deepEqual: (a, b) => expect(JSON.parse(JSON.stringify(a))).toEqual(JSON.parse(JSON.stringify(b))) }; throw new Error('Unexpected module'); };
    const execute = () => runInNewContext(command.argv[2], { require, Buffer, console: { log: value => { stdout += `${value}\n`; } } }, { timeout: 1000 });
    execute(); expect(stdout).toBe(command.output); expect(sha256(values.get(command.file.path))).toBe(command.file.sha256);
    values.set('setup-count', 'onceonce'); expect(execute).toThrow();
  });

  it('requires typed command output from the new completed Turn with exact argv and stdout', () => {
    const expected = cloudCommand(cloudNonce, source()); const item = scenarioFixture().cloudItem;
    expect(commandProof([item], 'turn_cloud', expected).stdoutSha256).toBe(sha256(expected.output));
    for (const changed of [{ ...item, type: 'message' }, { ...item, turn_id: 'turn_old' }, { ...item, exit_code: 1 },
      { ...item, output: `${item.output}\n` }, { ...item, command: `echo '${expected.output}'` }]) {
      expect(() => commandProof([changed], 'turn_cloud', expected)).toThrow();
    }
    expect(() => commandProof([item, item], 'turn_cloud', expected)).toThrow();
  });
});

describe('public transfer orchestration', () => {
  it.each(['/usr/bin/sh', '/usr/bin/bash'])('copies a source accepted by subscription proof with %s', async shell => {
    const fixture = scenarioFixture();
    for (const [index, item] of fixture.sourceItems.entries()) {
      item.command = `${shell} -lc '${item.command}'`;
      expect(subscriptionCommandProof({ data: fixture.sourceItems }, item.turn_id, nonce, program, index ? 'resume' : 'first').commandId).toBe(item.id);
    }
    expect(await fixture.run()).toMatchObject({ sourceSessionId: 'sess_source', destinationSessionId: 'sess_cloud' });
  });

  it('copies once, restarts its service, reuses the completed transfer ID, and continues only the cloud Session', async () => {
    const fixture = scenarioFixture();
    expect(await fixture.run()).toEqual({ transferId, sourceSessionId: 'sess_source', destinationSessionId: 'sess_cloud', turnId: 'turn_cloud' });
    expect(fixture.calls.filter(([, args]) => args[0] === 'transfer' && args[1] === 'plan')).toHaveLength(1);
    expect(fixture.calls.filter(([, args]) => args[0] === 'transfer' && args[1] === 'run').map(([, args]) => args[2])).toEqual([transferId, transferId]);
    expect(fixture.calls.filter(([, args]) => args[1] === 'send').map(([scope, args]) => [scope, args[2], args[4]])).toEqual([['cloud', 'sess_cloud', cloudNonce]]);
    expect(fixture.records.retry).toMatchObject({ completedReceiptReused: true, serviceRestart: 'graceful' });
    expect(fixture.records.sourceRetained).toMatchObject({ model: 'explicit-local-model', idle: true, historyUnchanged: true });
    expect(fixture.records.import).toMatchObject({ model: destination.model, idle: true, turns: 0 });
    expect(JSON.stringify(fixture.records)).not.toContain('secret backend detail');
  });

  it('rejects a busy or changed source before creating a transfer', async () => {
    for (const update of [{ status: 'in_progress' }, { agent: { model: 'changed' } }, { required_actions: [{ type: 'function_call' }] }]) {
      const fixture = scenarioFixture({ cli: ({ scope, args, localSession }) => scope === 'local' && args[1] === 'get' ? { ...localSession, ...update } : undefined });
      await expect(fixture.run()).rejects.toThrow('idle');
      expect(fixture.calls.some(([, args]) => args[0] === 'transfer')).toBe(false);
    }
  });

  it('rejects changed subscription command output before transfer', async () => {
    const fixture = scenarioFixture({ cli: ({ scope, args, sourceItems }) => scope === 'local' && args[1] === 'items'
      ? { object: 'list', data: sourceItems.map(item => ({ ...item, output: 'assistant-only forgery' })), has_more: false } : undefined });
    await expect(fixture.run()).rejects.toThrow('proof');
    expect(fixture.calls.some(([, args]) => args[0] === 'transfer')).toBe(false);
  });

  it('rejects destination drift or an incompatible snapshot before upload', async () => {
    for (const update of [{ model: 'unexpected' }, { destination: { baseURL: 'https://wrong.invalid/v1', region: destination.region } }, { history_items: 99 }]) {
      const fixture = scenarioFixture({ cli: ({ args, planned }) => args[0] === 'transfer' && args[1] === 'plan' ? { ...planned, ...update } : undefined });
      await expect(fixture.run()).rejects.toThrow();
      expect(fixture.calls.some(([, args]) => args[0] === 'transfer' && args[1] === 'run')).toBe(false);
    }
  });

  it('stops on failed transfer or changed retry identity without sending cloud input', async () => {
    for (const retryOnly of [false, true]) {
      const fixture = scenarioFixture({ cli: ({ args, restarted, complete }) => args[0] === 'transfer' && args[1] !== 'plan' && (!retryOnly || restarted)
        ? { ...complete, ...(retryOnly ? { destination_session_id: 'sess_other' } : { status: 'failed', error: 'secret backend detail' }) } : undefined });
      await expect(fixture.run()).rejects.toThrow();
      expect(fixture.calls.some(([, args]) => args[1] === 'send')).toBe(false);
      expect(JSON.stringify(fixture.records)).not.toContain('secret backend detail');
    }
  });

  it('accepts changed history envelopes but rejects changed history content and stable settings', async () => {
    expect(historyContent([{ id: 'one', turn_id: 'turn1', type: 'message', content: [{ text: 'kept' }] }])).toEqual(historyContent([{ id: 'two', turn_id: 'turn2', created_at: 2, type: 'message', content: [{ text: 'kept' }] }]));
    for (const field of ['history', 'settings']) {
      const fixture = scenarioFixture({ cli: ({ scope, args, cloudSession, sourceItems }) => scope === 'cloud'
        ? field === 'settings' && args[1] === 'get' ? { ...cloudSession, metadata: { lost: 'original' } }
          : field === 'history' && args[1] === 'items' ? { object: 'list', data: sourceItems.map(item => ({ ...item, output: 'changed' })), has_more: false } : undefined : undefined });
      await expect(fixture.run()).rejects.toThrow('history content or stable');
      expect(fixture.calls.some(([, args]) => args[1] === 'send')).toBe(false);
    }
  });

  it('requires import to remain idle without automatic execution', async () => {
    const fixture = scenarioFixture({ cli: ({ scope, args }) => scope === 'cloud' && args[1] === 'turns'
      ? { object: 'list', data: [{ id: 'unexpected_turn', status: 'completed' }], has_more: false } : undefined });
    await expect(fixture.run()).rejects.toThrow('before an ordinary message');
    expect(fixture.calls.some(([, args]) => args[1] === 'send')).toBe(false);
  });

  it.each(['failed', 'cancelled'])('records the request and %s Turn identity without resubmitting', async status => {
    const fixture = scenarioFixture({ cli: ({ scope, args, sent }) => scope === 'cloud' && args[1] === 'turns' && sent
      ? { object: 'list', data: [{ id: 'failed_turn', status, error: { message: 'secret backend detail' } }], has_more: false } : undefined });
    await expect(fixture.run()).rejects.toThrow('failed or was cancelled');
    expect(fixture.records.commandRequest).toMatchObject({ sessionId: 'sess_cloud', idempotencyKey: cloudNonce });
    expect(fixture.records.cloudTurn).toEqual({ id: 'failed_turn', status });
    expect(JSON.stringify(fixture.records)).not.toContain('secret backend detail');
    expect(fixture.calls.filter(([, args]) => args[1] === 'send')).toHaveLength(1);
    expect(fixture.calls.some(([, args]) => ['cancel', 'delete'].includes(args[1]))).toBe(false);
  });

  it('bounds pagination and rejects non-advancing cursors', async () => {
    const calls = []; const cli = async (_scope, args) => { calls.push(args); return { object: 'list', data: [{ id: 'same' }], has_more: true }; };
    await expect(allItems(cli, 'local', 'items', 'sess_fixture')).rejects.toThrow('advance');
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain('--after');
  });
});

describe('bounded child process boundary', () => {
  it('uses argument arrays and explicit environment while withholding stderr from captured evidence', async () => {
    const controller = new AbortController();
    const children = packagedProcesses(process.execPath, process.cwd(), { PATH: '/usr/bin:/bin', FIXTURE: 'accepted' }, controller.signal);
    try {
      const result = await children.command(['-e', 'process.stderr.write("fixture credential must not be captured");process.stdout.write(JSON.stringify({value:process.env.FIXTURE,ambient:process.env.OPENAI_API_KEY??null,args:process.argv.slice(1)}))', '--', 'literal; $(not-executed)']);
      expect(result.code).toBe(0); expect(result.failed).toBe(false);
      expect(JSON.parse(result.output)).toEqual({ value: 'accepted', ambient: null, args: ['literal; $(not-executed)'] });
      expect(result.output).not.toContain('credential');
    } finally { await children.close(); }
  });

  it('stops only its owned fake service and prevents new children after interruption', async () => {
    const controller = new AbortController(); const children = packagedProcesses(process.execPath, process.cwd(), {}, controller.signal);
    try {
      const state = children.start(['-e', 'process.on("SIGTERM",()=>process.exit(0));process.stdout.write("ready");setInterval(()=>{},1000)']);
      for (let attempt = 0; attempt < 100 && state.bytes === 0; attempt++) await delay(10);
      expect(state.bytes).toBeGreaterThan(0); await children.stop(state); expect(state.result.code).toBe(0);
      controller.abort(); expect(() => children.start(['-e', ''])).toThrow();
    } finally { await children.close(); }
  });

  it('bounds stdout and stderr without saving backend error text', async () => {
    const controller = new AbortController(); const children = packagedProcesses(process.execPath, process.cwd(), {}, controller.signal);
    try {
      const result = await children.command(['-e', 'process.stderr.write("x".repeat(9*1024*1024));']);
      expect(result.failed).toBe(true); expect(result.output).toBe('');
    } finally { await children.close(); }
  });
});
