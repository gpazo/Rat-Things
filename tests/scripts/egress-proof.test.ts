import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import type { AgentSession, AgentSessionItem, SessionArtifact, Turn } from '../../src/domain/agents-api.js';
import { hostedCodexArguments } from '../../src/runner/hosted-environment-planning.js';
import { egressInputPath, egressProbeCommand, egressProbeProgram, egressProgramPath, egressTurnEvidence, isEgressProbeCommand, receiptLimit, type EgressReceipt, type EgressProbeSpec } from '../../testing/aws/egress-proof.js';

// Kernel snapshots captured under the official 0.164.0 rat_managed sandbox, UID 10001.
const loopbackDevices = 'Inter-|   Receive                                                |  Transmit\n'
  + ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n'
  + '    lo:       0       0    0    0    0     0          0         0        0       0    0    0    0     0       0          0\n';
const emptyIpv4Routes = 'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n';
const rejectedIpv6Default = '00000000000000000000000000000000 00 00000000000000000000000000000000 00 00000000000000000000000000000000 ffffffff 00000001 00000000 00200200       lo\n';
const localIpv6Route = '00000000000000000000000000000001 80 00000000000000000000000000000000 00 00000000000000000000000000000000 00000000 00000002 00000000 80200001       lo\n';
type Namespace = NonNullable<EgressReceipt['network_namespace']>;
const isolatedNamespace = (): Namespace => ({ id: 'net:[4026532974]', devices: loopbackDevices, ipv4_routes: emptyIpv4Routes,
  ipv6_routes: rejectedIpv6Default + localIpv6Route + rejectedIpv6Default, error: null });

function fixture(networkAccess: EgressProbeSpec['networkAccess'] = 'enabled') {
  const expected = { agentId: 'agent-proof', sessionId: 'session-proof', marker: 'unpredictable-marker', inputSha256: 'test-input-hash',
    bedrockHost: 'bedrock-runtime.us-west-2.amazonaws.com', outputPath: '/workspace/outputs/egress-proof.json', networkAccess };
  const session: AgentSession = { id: expected.sessionId, object: 'agent.session', created_at: 1, last_active_at: 1,
    error: null, status: 'idle', required_actions: [], metadata: {}, usage: null, vault_ids: [],
    agent: { id: expected.agentId, model: 'test-model', name: null, instructions: null, tools: [],
      multi_agent: { enabled: false, max_concurrent_subagents: null }, reasoning: { effort: null, summary: null },
      service_tier: 'auto', text: { format: { type: 'text' }, verbosity: 'low' } },
    environment: { id: 'environment-proof', type: 'openai_hosted', network: { access: networkAccess, allowed_domains: [] },
      files: [], capability_directories: [], packages: { python: [], npm: [], system: [] }, plugins: [], skills: [] } };
  const turn: Turn = { id: 'turn-proof', agent_id: expected.agentId, session_id: expected.sessionId, subagent_id: null,
    object: 'agent.session.turn', created_at: 1, started_at: 1, completed_at: 2, status: 'completed', error: null, usage: null };
  const receipt: EgressReceipt = { schema: 1, marker: expected.marker, uid: 10001, euid: 10001, input_sha256: expected.inputSha256,
    program_sha256: createHash('sha256').update(egressProbeProgram(expected)).digest('hex'),
    public_tcp: { host: '1.1.1.1', port: 443, connected: false, error: networkAccess === 'enabled' ? 'TimeoutError:None' : 'PermissionError:1' },
    bedrock: { host: expected.bedrockHost, port: 443, resolved_ipv4: networkAccess === 'enabled' ? ['10.0.1.5'] : [],
      address: networkAccess === 'enabled' ? '10.0.1.5' : null, tcp_connected: networkAccess === 'enabled', tls_connected: networkAccess === 'enabled',
      tls_version: networkAccess === 'enabled' ? 'TLSv1.3' : null, error: networkAccess === 'enabled' ? null : 'gaierror:-3' } };
  const artifactText = `${JSON.stringify(receipt)}\n`;
  const command: Extract<AgentSessionItem, { type: 'command_execution' }> = { id: 'command-proof', type: 'command_execution', turn_id: turn.id,
    command: `/bin/bash -lc '${egressProbeCommand}'`, cwd: '/workspace', duration_ms: 100, exit_code: 0,
    output: `RAT_EGRESS_PROOF ${artifactText}`, status: 'completed' };
  const artifact: SessionArtifact = { id: 'artifact-proof', object: 'agent.session.artifact', created_at: 2, environment_id: 'environment-proof',
    path: expected.outputPath, session_id: session.id, turn_id: turn.id, size_bytes: Buffer.byteLength(artifactText) };
  return { session, turn, items: [command] as AgentSessionItem[], artifacts: [artifact], artifactText, expected, receipt, command, artifact };
}

function changedReceipt(change: (receipt: EgressReceipt) => void, networkAccess: EgressProbeSpec['networkAccess'] = 'enabled') {
  const value = fixture(networkAccess);
  change(value.receipt);
  value.artifactText = `${JSON.stringify(value.receipt)}\n`;
  value.command.output = `RAT_EGRESS_PROOF ${value.artifactText}`;
  value.artifact.size_bytes = Buffer.byteLength(value.artifactText);
  return value;
}

describe('runtime egress receipt selection', () => {
  it.each(['disabled', 'enabled'] as const)('accepts exact command and immutable artifact evidence for %s without mutating inputs', access => {
    const value = fixture(access);
    const before = structuredClone(value);
    expect(egressTurnEvidence(value)).toMatchObject({ sessionId: value.session.id, turnId: value.turn.id,
      commandId: value.command.id, artifactId: value.artifact.id, receipt: value.receipt });
    expect(value).toEqual(before);
  });

  it('accepts Linux EACCES as an explicit denial for the default network policy', () => {
    const value = changedReceipt(receipt => { receipt.public_tcp.error = 'PermissionError:13'; }, 'disabled');
    expect(egressTurnEvidence(value).receipt).toEqual(value.receipt);
  });

  it('accepts ENETUNREACH only with complete kernel loopback namespace evidence', () => {
    const value = changedReceipt(receipt => { receipt.public_tcp.error = 'OSError:101'; receipt.network_namespace = isolatedNamespace(); }, 'disabled');
    const before = structuredClone(value);
    expect(egressTurnEvidence(value).receipt).toEqual(value.receipt);
    expect(value).toEqual(before);
  });

  it('accepts a readable empty IPv6 route inventory', () => {
    const value = changedReceipt(receipt => {
      receipt.public_tcp.error = 'OSError:101'; receipt.network_namespace = { ...isolatedNamespace(), ipv6_routes: '' };
    }, 'disabled');
    expect(egressTurnEvidence(value).receipt).toEqual(value.receipt);
  });

  it.each(['OSError:101', 'TimeoutError:None', 'ConnectionRefusedError:111', 'gaierror:-3'])(
    'rejects default public error %s despite matching output and artifact', error => {
      const value = changedReceipt(receipt => { receipt.public_tcp.error = error; }, 'disabled');
      expect(() => egressTurnEvidence(value)).toThrow();
    },
  );

  it.each(['TimeoutError:None', 'ConnectionRefusedError:111', 'gaierror:-3'])(
    'rejects %s even with complete loopback evidence', error => {
      const value = changedReceipt(receipt => { receipt.public_tcp.error = error; receipt.network_namespace = isolatedNamespace(); }, 'disabled');
      expect(() => egressTurnEvidence(value)).toThrow();
    },
  );

  it.each([
    ['unreadable inventory', (namespace: Namespace) => { namespace.error = 'PermissionError:13'; }],
    ['missing namespace ID', (namespace: Namespace) => { namespace.id = null; }],
    ['malformed namespace ID', (namespace: Namespace) => { namespace.id = 'net:[unknown]'; }],
    ['missing devices', (namespace: Namespace) => { namespace.devices = null; }],
    ['missing IPv4 routes', (namespace: Namespace) => { namespace.ipv4_routes = null; }],
    ['missing IPv6 routes', (namespace: Namespace) => { namespace.ipv6_routes = null; }],
    ['eth0 without routes', (namespace: Namespace) => { namespace.devices += loopbackDevices.split('\n')[2]!.replace('lo:', 'eth0:') + '\n'; }],
    ['no loopback device', (namespace: Namespace) => { namespace.devices = loopbackDevices.replace('lo:', 'eth0:'); }],
    ['malformed device counters', (namespace: Namespace) => { namespace.devices = loopbackDevices.replace('lo:       0', 'lo:       unknown'); }],
    ['truncated device inventory', (namespace: Namespace) => { namespace.devices = loopbackDevices.split('\n').slice(2).join('\n'); }],
    ['empty IPv4 inventory', (namespace: Namespace) => { namespace.ipv4_routes = ''; }],
    ['IPv4 external route', (namespace: Namespace) => { namespace.ipv4_routes += 'eth0 00000000 0100000A 0003 0 0 0 00000000 0 0 0\n'; }],
    ['IPv4 loopback default', (namespace: Namespace) => { namespace.ipv4_routes += 'lo 00000000 00000000 0001 0 0 0 00000000 0 0 0\n'; }],
    ['malformed IPv4 inventory', (namespace: Namespace) => { namespace.ipv4_routes = 'Iface Destination Gateway\n'; }],
    ['IPv6 external interface', (namespace: Namespace) => { namespace.ipv6_routes = localIpv6Route.replace('lo', 'eth0'); }],
    ['IPv6 usable default', (namespace: Namespace) => { namespace.ipv6_routes = rejectedIpv6Default.replace('00200200', '00000001'); }],
    ['IPv6 global destination', (namespace: Namespace) => { namespace.ipv6_routes = localIpv6Route.replace(/^0{31}1/, '20010db8000000000000000000000001'); }],
    ['IPv6 gateway', (namespace: Namespace) => { namespace.ipv6_routes = localIpv6Route.replace('00 00000000000000000000000000000000 00000000', '00 00000000000000000000000000000001 00000000'); }],
    ['IPv6 gateway flag', (namespace: Namespace) => { namespace.ipv6_routes = localIpv6Route.replace('80200001', '80200003'); }],
    ['IPv6 source route', (namespace: Namespace) => { namespace.ipv6_routes = localIpv6Route.replace('80 00000000000000000000000000000000 00', '80 20010db8000000000000000000000000 40'); }],
    ['IPv6 invalid hex', (namespace: Namespace) => { namespace.ipv6_routes = rejectedIpv6Default.replace('00200200', 'not-hex!'); }],
    ['IPv6 truncated fields', (namespace: Namespace) => { namespace.ipv6_routes = '00000000000000000000000000000000 00 lo\n'; }],
    ['wrong inventory type', (namespace: Namespace) => { Reflect.set(namespace, 'devices', ['lo']); }],
  ] as const)('rejects ENETUNREACH with %s', (_name, mutate) => {
    const value = changedReceipt(receipt => {
      receipt.public_tcp.error = 'OSError:101'; receipt.network_namespace = isolatedNamespace(); mutate(receipt.network_namespace);
    }, 'disabled');
    expect(() => egressTurnEvidence(value)).toThrow();
  });

  it('accepts the captured Codex bash command shape and rejects appended shell work', () => {
    expect(isEgressProbeCommand("/bin/bash -lc 'python3 /workspace/egress-probe.py'")).toBe(true);
    expect(isEgressProbeCommand(egressProbeCommand)).toBe(true);
    expect(isEgressProbeCommand(`${egressProbeCommand}; echo forged`)).toBe(false);
    expect(isEgressProbeCommand(`/bin/bash -lc '${egressProbeCommand}; echo forged'`)).toBe(false);
    expect(isEgressProbeCommand(`echo '${egressProbeCommand}'`)).toBe(false);
  });

  it.each([
    ['Session', (value: ReturnType<typeof fixture>) => { value.session.id = 'other'; }],
    ['Agent', (value: ReturnType<typeof fixture>) => { value.turn.agent_id = 'other'; }],
    ['root Turn', (value: ReturnType<typeof fixture>) => { value.turn.subagent_id = 'child'; }],
    ['command Turn', (value: ReturnType<typeof fixture>) => { value.command.turn_id = 'other'; }],
    ['artifact Turn', (value: ReturnType<typeof fixture>) => { value.artifact.turn_id = 'other'; }],
    ['artifact environment', (value: ReturnType<typeof fixture>) => { value.artifact.environment_id = 'other'; }],
    ['artifact Session', (value: ReturnType<typeof fixture>) => { value.artifact.session_id = 'other'; }],
    ['artifact path', (value: ReturnType<typeof fixture>) => { value.artifact.path = '/workspace/outputs/unrelated.json'; }],
    ['artifact bytes', (value: ReturnType<typeof fixture>) => { value.artifactText += ' '; }],
    ['artifact size', (value: ReturnType<typeof fixture>) => { value.artifact.size_bytes++; }],
    ['exit code', (value: ReturnType<typeof fixture>) => { value.command.exit_code = 1; }],
    ['command completion', (value: ReturnType<typeof fixture>) => { value.command.status = 'in_progress'; }],
    ['Turn completion', (value: ReturnType<typeof fixture>) => { value.turn.status = 'in_progress'; }],
    ['exact command', (value: ReturnType<typeof fixture>) => { value.command.command = 'echo RAT_EGRESS_PROOF'; }],
    ['duplicate commands', (value: ReturnType<typeof fixture>) => { value.items.push({ ...value.command, id: 'duplicate' }); }],
    ['duplicate artifacts', (value: ReturnType<typeof fixture>) => { value.artifacts.push({ ...value.artifact, id: 'duplicate' }); }],
    ['bounded output', (value: ReturnType<typeof fixture>) => { value.command.output = 'x'.repeat(receiptLimit + 1); }],
  ] as const)('rejects mismatched %s', (_name, mutate) => {
    const value = fixture();
    mutate(value);
    expect(() => egressTurnEvidence(value)).toThrow();
  });

  it('rejects assistant prose without a managed command receipt', () => {
    const value = fixture();
    value.items = [{ id: 'model-prose', type: 'message', turn_id: value.turn.id, role: 'assistant', phase: 'final_answer', status: 'completed',
      content: [{ type: 'output_text', text: value.command.output! }] }];
    expect(() => egressTurnEvidence(value)).toThrow('Exactly one root Turn command');
  });

  it.each([
    ['public success', (receipt: EgressReceipt) => { receipt.public_tcp.connected = true; }],
    ['wrong canary', (receipt: EgressReceipt) => { receipt.public_tcp.host = '127.0.0.1'; }],
    ['private public address', (receipt: EgressReceipt) => { receipt.bedrock.resolved_ipv4 = ['1.1.1.1']; }],
    ['private loopback address', (receipt: EgressReceipt) => { receipt.bedrock.resolved_ipv4 = ['127.0.0.1']; }],
    ['missing TLS', (receipt: EgressReceipt) => { receipt.bedrock.tls_connected = false; }],
    ['unresolved peer', (receipt: EgressReceipt) => { receipt.bedrock.address = '10.0.9.9'; }],
    ['guest UID', (receipt: EgressReceipt) => { receipt.uid = 0; }],
    ['input hash', (receipt: EgressReceipt) => { receipt.input_sha256 = 'changed'; }],
    ['program hash', (receipt: EgressReceipt) => { receipt.program_sha256 = 'changed'; }],
    ['proof marker', (receipt: EgressReceipt) => { receipt.marker = 'other'; }],
  ] as const)('rejects %s despite matching output and artifact', (_name, mutate) => {
    expect(() => egressTurnEvidence(changedReceipt(mutate))).toThrow();
  });

  it('requires an unsuccessful private probe for the default policy and validates the reported effective policy', () => {
    expect(() => egressTurnEvidence(changedReceipt(receipt => { receipt.bedrock.tcp_connected = true; }, 'disabled'))).toThrow();
    const value = fixture('disabled');
    value.expected.networkAccess = 'enabled';
    expect(() => egressTurnEvidence(value)).toThrow('Effective network policy');
  });
});

// Opt in only inside a disposable worker image: no provider or inference request is made.
const native = process.env.CODEX_EGRESS_NATIVE_E2E === 'true' ? it : it.skip;
native('executes the uploaded probe through the stock managed sandbox and proves namespace isolation', async () => {
  expect(process.getuid?.()).toBe(10001);
  const value = fixture('disabled');
  const input = randomBytes(64);
  value.expected.marker = `stock-egress-${randomUUID()}`;
  value.expected.inputSha256 = createHash('sha256').update(input).digest('hex');
  value.expected.outputPath = `/workspace/outputs/${value.expected.marker}.json`;
  value.artifact.path = value.expected.outputPath;
  const created: string[] = [];
  try {
    const outerNamespace = await readlink('/proc/self/ns/net');
    const outerDevices = await readFile('/proc/net/dev', 'utf8');
    const outerIpv4Routes = await readFile('/proc/net/route', 'utf8');
    expect(outerDevices).toMatch(/\beth0:/);
    expect(outerIpv4Routes).toMatch(/\beth0\s/);
    await mkdir('/workspace/outputs', { recursive: true });
    for (const [path, bytes] of [[egressInputPath, input], [egressProgramPath, egressProbeProgram(value.expected)]] as const) {
      await writeFile(path, bytes, { flag: 'wx' }); created.push(path);
    }
    const result = await promisify(execFile)('/opt/codex-runtime/bin/codex', hostedCodexArguments(
      ['sandbox', '--permission-profile', 'rat_managed', '--', 'python3', egressProgramPath], { access: 'disabled', allowed_domains: [] }), {
      cwd: '/workspace', timeout: 30_000, maxBuffer: receiptLimit, env: { HOME: '/home/agent', PATH: '/usr/local/bin:/usr/bin:/bin' },
    });
    created.push(value.expected.outputPath);
    value.command.output = result.stdout;
    value.artifactText = await readFile(value.expected.outputPath, 'utf8');
    value.artifact.size_bytes = Buffer.byteLength(value.artifactText);
    const evidence = egressTurnEvidence(value);
    expect(evidence.receipt.public_tcp.error).toBe('OSError:101');
    expect(evidence.receipt.network_namespace?.id).not.toBe(outerNamespace);
    expect(evidence.receipt.network_namespace?.error).toBeNull();
    console.log(JSON.stringify({ stockManagedSandbox: { outerNamespace, outerDevices, outerIpv4Routes, receipt: evidence.receipt } }));
  } finally { await Promise.all(created.map(path => rm(path, { force: true }))); }
}, 40_000);
