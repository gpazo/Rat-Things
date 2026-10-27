import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import type { AgentSession, AgentSessionItem, SessionArtifact, Turn } from '../../src/domain/agents-api.js';

export const publicCanary = { host: '1.1.1.1', port: 443 } as const;
export const egressInputPath = '/workspace/egress-input.bin';
export const egressProgramPath = '/workspace/egress-probe.py';
export const egressProbeCommand = `python3 ${egressProgramPath}`;
const receiptPrefix = 'RAT_EGRESS_PROOF ';
export const receiptLimit = 8192;

export interface EgressProbeSpec {
  marker: string;
  bedrockHost: string;
  outputPath: string;
  networkAccess: 'disabled' | 'enabled';
}

export interface EgressReceipt {
  schema: 1;
  marker: string;
  uid: number;
  euid: number;
  input_sha256: string;
  program_sha256: string;
  network_namespace?: {
    id: string | null;
    devices: string | null;
    ipv4_routes: string | null;
    ipv6_routes: string | null;
    error: string | null;
  };
  public_tcp: { host: string; port: number; connected: boolean; error: string | null };
  bedrock: {
    host: string;
    port: number;
    resolved_ipv4: string[];
    address: string | null;
    tcp_connected: boolean;
    tls_connected: boolean;
    tls_version: string | null;
    error: string | null;
  };
}

export function egressProbeProgram(spec: EgressProbeSpec): string {
  const program = [
    'import hashlib, ipaddress, json, os, signal, socket, ssl',
    `config = json.loads(${JSON.stringify(JSON.stringify({ marker: spec.marker, bedrock_host: spec.bedrockHost, output_path: spec.outputPath, public_host: publicCanary.host, port: publicCanary.port }))})`,
    'def error_code(error):',
    '    return type(error).__name__ + ":" + str(getattr(error, "errno", None))',
    'def dns_timeout(signum, frame):',
    '    raise TimeoutError("DNS deadline")',
    'def private_ipv4(address):',
    '    return any(ipaddress.ip_address(address) in ipaddress.ip_network(network) for network in ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"])',
    'def network_file(path):',
    '    with open(path, "r", encoding="ascii") as source:',
    '        value = source.read(2049)',
    '    if len(value) > 2048:',
    '        raise ValueError("Network inventory exceeds its bound")',
    '    return value',
    'namespace = {"id": None, "devices": None, "ipv4_routes": None, "ipv6_routes": None, "error": None}',
    'try:',
    '    namespace["id"] = os.readlink("/proc/self/ns/net")',
    '    namespace["devices"] = network_file("/proc/net/dev")',
    '    namespace["ipv4_routes"] = network_file("/proc/net/route")',
    '    namespace["ipv6_routes"] = network_file("/proc/net/ipv6_route")',
    'except (OSError, ValueError) as error:',
    '    namespace["error"] = error_code(error)',
    'public = {"host": config["public_host"], "port": config["port"], "connected": False, "error": None}',
    'try:',
    '    with socket.create_connection((public["host"], public["port"]), timeout=4):',
    '        public["connected"] = True',
    'except OSError as error:',
    '    public["error"] = error_code(error)',
    'bedrock = {"host": config["bedrock_host"], "port": 443, "resolved_ipv4": [], "address": None, "tcp_connected": False, "tls_connected": False, "tls_version": None, "error": None}',
    'try:',
    '    signal.signal(signal.SIGALRM, dns_timeout)',
    '    signal.alarm(5)',
    '    try:',
    '        bedrock["resolved_ipv4"] = sorted(set(entry[4][0] for entry in socket.getaddrinfo(bedrock["host"], 443, socket.AF_INET, socket.SOCK_STREAM)))',
    '    finally:',
    '        signal.alarm(0)',
    '    if not bedrock["resolved_ipv4"] or not all(private_ipv4(address) for address in bedrock["resolved_ipv4"]):',
    '        raise ValueError("Bedrock DNS must resolve only to RFC1918 addresses")',
    '    bedrock["address"] = bedrock["resolved_ipv4"][0]',
    '    with socket.create_connection((bedrock["address"], 443), timeout=4) as connection:',
    '        bedrock["tcp_connected"] = True',
    '        with ssl.create_default_context().wrap_socket(connection, server_hostname=bedrock["host"]) as secure:',
    '            bedrock["tls_connected"] = True',
    '            bedrock["tls_version"] = secure.version()',
    'except (OSError, ValueError) as error:',
    '    bedrock["error"] = error_code(error)',
    `with open(${JSON.stringify(egressInputPath)}, "rb") as source:`,
    '    input_sha256 = hashlib.sha256(source.read()).hexdigest()',
    'with open(__file__, "rb") as source:',
    '    program_sha256 = hashlib.sha256(source.read()).hexdigest()',
    'receipt = {"schema": 1, "marker": config["marker"], "uid": os.getuid(), "euid": os.geteuid(), "input_sha256": input_sha256, "program_sha256": program_sha256, "network_namespace": namespace, "public_tcp": public, "bedrock": bedrock}',
    'serialized = json.dumps(receipt, sort_keys=True, separators=(",", ":"))',
    'os.makedirs("/workspace/outputs", exist_ok=True)',
    'with open(config["output_path"], "x") as output:',
    '    output.write(serialized + "\\n")',
    `print(${JSON.stringify(receiptPrefix)} + serialized, flush=True)`,
  ].join('\n');
  return `${program}\n`;
}

export function isEgressProbeCommand(command: string): boolean {
  return command === egressProbeCommand || ['/bin/bash', '/usr/bin/bash'].some(shell =>
    ['-c', '-lc'].some(flag => command === `${shell} ${flag} '${egressProbeCommand}'`));
}

export function egressTurnEvidence(input: {
  session: AgentSession;
  turn: Turn;
  items: readonly AgentSessionItem[];
  artifacts: readonly SessionArtifact[];
  artifactText: string;
  expected: EgressProbeSpec & { agentId: string; sessionId: string; inputSha256: string };
}) {
  const { session, turn, items, artifacts, artifactText, expected } = input;
  assert(session.id === expected.sessionId && session.agent.id === expected.agentId
    && turn.session_id === session.id && turn.agent_id === expected.agentId && turn.subagent_id === null,
  'Egress proof must belong to the expected Agent, Session, and root Turn');
  assert.equal(turn.status, 'completed', 'Egress proof root Turn must complete');
  assert.equal(session.environment.type, 'openai_hosted');
  if (session.environment.type !== 'openai_hosted') throw new Error('Hosted environment is required');
  const environment = session.environment;
  assert.equal(environment.network.access, expected.networkAccess, 'Effective network policy differs from the request');
  const commands = items.filter(item => item.turn_id === turn.id && item.type === 'command_execution');
  assert.equal(commands.length, 1, 'Exactly one root Turn command must execute the probe');
  const command = commands[0]!;
  assert.equal(command.type, 'command_execution');
  if (command.type !== 'command_execution') throw new Error('Command receipt is required');
  assert(isEgressProbeCommand(command.command), 'The probe command must execute verbatim');
  assert.equal(command.status, 'completed', 'The probe command must complete');
  assert.equal(command.exit_code, 0, 'The probe command must exit successfully');
  assert(command.output !== null && command.output.length <= receiptLimit, 'Command output is missing or oversized');
  const lines = command.output.split('\n').filter(line => line.startsWith(receiptPrefix));
  assert.equal(lines.length, 1, 'A single command receipt is required');
  assert(Buffer.byteLength(artifactText) <= receiptLimit, 'Artifact receipt is oversized');
  assert.equal(artifactText, `${lines[0]!.slice(receiptPrefix.length)}\n`, 'Artifact must match the command receipt exactly');
  const matches = artifacts.filter(artifact => artifact.session_id === session.id && artifact.turn_id === turn.id
    && artifact.environment_id === environment.id && artifact.path === expected.outputPath);
  assert.equal(matches.length, 1, 'A single immutable artifact from the exact environment and root Turn is required');
  const artifact = matches[0]!;
  assert.equal(artifact.size_bytes, Buffer.byteLength(artifactText));
  const receipt = parseReceipt(JSON.parse(artifactText));
  assert.equal(receipt.marker, expected.marker);
  assert.equal(receipt.uid, 10001, 'Probe must run as the isolated guest UID');
  assert.equal(receipt.euid, 10001, 'Probe must run as the isolated guest effective UID');
  assert.equal(receipt.input_sha256, expected.inputSha256, 'Uploaded bytes must reach the guest unchanged');
  assert.equal(receipt.program_sha256, createHash('sha256').update(egressProbeProgram(expected)).digest('hex'), 'The guest must execute the uploaded probe source unchanged');
  assert.equal(receipt.public_tcp.host, publicCanary.host);
  assert.equal(receipt.public_tcp.port, publicCanary.port);
  assert.equal(receipt.public_tcp.connected, false, 'Public TCP egress must be denied');
  assert(receipt.public_tcp.error, 'Public denial must include its socket error');
  assert.equal(receipt.bedrock.host, expected.bedrockHost);
  assert.equal(receipt.bedrock.port, 443);
  if (expected.networkAccess === 'enabled') {
    assert(receipt.bedrock.resolved_ipv4.length > 0 && receipt.bedrock.resolved_ipv4.every(privateIpv4), 'Bedrock must resolve only to private RFC1918 addresses');
    assert(receipt.bedrock.address !== null && receipt.bedrock.resolved_ipv4.includes(receipt.bedrock.address), 'Bedrock must connect to a resolved private address');
    assert.equal(receipt.bedrock.tcp_connected, true, 'Enabled guest must reach private Bedrock TCP');
    assert.equal(receipt.bedrock.tls_connected, true, 'Enabled guest must verify private Bedrock TLS');
    assert(receipt.bedrock.tls_version?.startsWith('TLSv'), 'Bedrock must negotiate TLS');
    assert.equal(receipt.bedrock.error, null);
  } else {
    assert(receipt.public_tcp.error === 'PermissionError:1' || receipt.public_tcp.error === 'PermissionError:13'
      || receipt.public_tcp.error === 'OSError:101' && isolatedNetworkNamespace(receipt.network_namespace),
    'Default guest network policy must explicitly deny the public numeric TCP probe or prove an isolated loopback namespace');
    assert.equal(receipt.bedrock.tcp_connected, false, 'Default guest private probe must not establish TCP');
    assert.equal(receipt.bedrock.tls_connected, false);
    assert(receipt.bedrock.error, 'Unsuccessful private probe must include its error');
  }
  return { sessionId: session.id, environmentId: environment.id, turnId: turn.id,
    commandId: command.id, command: command.command, commandOutput: command.output,
    artifactId: artifact.id, artifactPath: artifact.path, artifactBytes: artifact.size_bytes, receipt };
}

function privateIpv4(address: string): boolean {
  if (isIP(address) !== 4) return false;
  const [first, second] = address.split('.').map(Number);
  return first === 10 || first === 172 && second! >= 16 && second! <= 31 || first === 192 && second === 168;
}

// Stock Codex's proxy sandbox permits IP sockets inside an isolated namespace, so numeric
// TCP fails with ENETUNREACH. A missing outer route is insufficient: require the current
// kernel namespace's complete loopback-only interface and route inventories. /proc/net/dev
// remains readable when Codex's AF_NETLINK restriction denies socket.if_nameindex().
function isolatedNetworkNamespace(namespace: EgressReceipt['network_namespace']): boolean {
  if (!namespace || namespace.error !== null || namespace.id === null || !/^net:\[[1-9]\d*\]$/.test(namespace.id)
    || namespace.devices === null || namespace.ipv4_routes === null || namespace.ipv6_routes === null) return false;
  const devices = namespace.devices.trim().split('\n');
  if (devices.length !== 3 || devices[0]!.replace(/\s+/g, '') !== 'Inter-|Receive|Transmit'
    || devices[1]!.replace(/\s+/g, '') !== 'face|bytespacketserrsdropfifoframecompressedmulticast|bytespacketserrsdropfifocollscarriercompressed'
    || !/^\s*lo:\s+(?:\d+\s+){15}\d+\s*$/.test(devices[2]!)) return false;
  // A fresh namespace has no IPv4 routes. Any data row, including a default via lo,
  // is outside this proof rather than evidence we infer to be harmless.
  if (namespace.ipv4_routes.trim().split(/\s+/).join(' ')
    !== 'Iface Destination Gateway Flags RefCnt Use Metric Mask MTU Window IRTT') return false;
  return namespace.ipv6_routes.trim() === '' || namespace.ipv6_routes.trim().split('\n').every(line => {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 10 || ![0, 2, 4].every(index => /^[0-9a-f]{32}$/.test(fields[index]!))
      || ![1, 3].every(index => /^[0-9a-f]{2}$/.test(fields[index]!))
      || ![5, 6, 7, 8].every(index => /^[0-9a-f]{8}$/.test(fields[index]!))) return false;
    const [destination, prefix, source, sourcePrefix, gateway, , , , flags, device] = fields;
    const zero = '0'.repeat(32);
    if (device !== 'lo' || source !== zero || sourcePrefix !== '00' || gateway !== zero) return false;
    // Linux includes unreachable ::/0 sentinels (RTF_REJECT), even without IPv6 egress.
    // The only usable route accepted is ::1/128, with no gateway (RTF_GATEWAY).
    const bits = Number.parseInt(flags!, 16);
    return destination === zero && prefix === '00' && (bits & 0x200) !== 0
      || destination === `${'0'.repeat(31)}1` && prefix === '80' && (bits & 0x1) !== 0 && (bits & 0x2) === 0;
  });
}

function parseReceipt(value: unknown): EgressReceipt {
  assert(value !== null && typeof value === 'object', 'Receipt must be an object');
  const receipt = value as Record<string, unknown>;
  assert(receipt.schema === 1 && typeof receipt.marker === 'string' && typeof receipt.uid === 'number'
    && typeof receipt.euid === 'number' && typeof receipt.input_sha256 === 'string' && typeof receipt.program_sha256 === 'string', 'Invalid receipt identity');
  assert(receipt.public_tcp !== null && typeof receipt.public_tcp === 'object' && receipt.bedrock !== null && typeof receipt.bedrock === 'object', 'Missing probe results');
  const publicTcp = receipt.public_tcp as Record<string, unknown>;
  const bedrock = receipt.bedrock as Record<string, unknown>;
  assert(typeof publicTcp.host === 'string' && typeof publicTcp.port === 'number' && typeof publicTcp.connected === 'boolean'
    && nullableString(publicTcp.error), 'Invalid public TCP receipt');
  assert(typeof bedrock.host === 'string' && typeof bedrock.port === 'number'
    && Array.isArray(bedrock.resolved_ipv4) && bedrock.resolved_ipv4.every(address => typeof address === 'string')
    && nullableString(bedrock.address) && typeof bedrock.tcp_connected === 'boolean' && typeof bedrock.tls_connected === 'boolean'
    && nullableString(bedrock.tls_version) && nullableString(bedrock.error), 'Invalid Bedrock receipt');
  if (receipt.network_namespace !== undefined) {
    assert(receipt.network_namespace !== null && typeof receipt.network_namespace === 'object', 'Invalid network namespace receipt');
    const namespace = receipt.network_namespace as Record<string, unknown>;
    assert(['id', 'devices', 'ipv4_routes', 'ipv6_routes', 'error'].every(key => nullableString(namespace[key])), 'Invalid network namespace fields');
  }
  return value as EgressReceipt;
}

function nullableString(value: unknown): value is string | null { return value === null || typeof value === 'string'; }
