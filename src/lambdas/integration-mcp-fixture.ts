/** Protocol-only plans for the opt-in deployment fixture. All credentials here are synthetic. */
interface FixtureReply { status: number; body: unknown; audit?: Record<string, unknown> }

export function planOAuthFixture(deployment: string, authorization: string, body: string): FixtureReply {
  const denied = { status: 401, body: { error: 'invalid_client' } };
  if (body.length > 16_384 || !authorization.startsWith('Basic ')) return denied;
  const basic = Buffer.from(authorization.slice(6), 'base64').toString('utf8');
  const separator = basic.indexOf(':');
  if (separator < 0) return denied;
  const decode = (value: string) => new URLSearchParams(`value=${value}`).get('value');
  const proof = decode(basic.slice(0, separator));
  if (!proof || !/^mcp-[a-f0-9-]{36}$/.test(proof) || decode(basic.slice(separator + 1)) !== `oauth-${deployment}`) return denied;
  const form = new URLSearchParams(body);
  if (form.get('grant_type') !== 'refresh_token' || ![`refresh-${deployment}`, `rotated-${deployment}`].includes(form.get('refresh_token') ?? '')) {
    return { status: 400, body: { error: 'invalid_grant' } };
  }
  return { status: 200, body: { access_token: `beta-${deployment}`, token_type: 'Bearer', expires_in: 3600, refresh_token: `rotated-${deployment}` },
    audit: { version: '1', operation: 'oauth.refresh', proof, account: 'beta' } };
}

export function planMcpFixture(account: 'alpha' | 'beta', method: string, message: Record<string, unknown> | undefined): FixtureReply {
  if (method !== 'POST') return { status: 405, body: null };
  if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return { status: 400, body: { error: 'invalid_request' } };
  const params = record(message.params) ? message.params : {};
  const result = (value: unknown): FixtureReply => ({ status: 200, body: { jsonrpc: '2.0', id: message.id, result: value } });
  if (message.id === undefined) return { status: 202, body: null };
  if (message.method === 'initialize') return result({ protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'Rat Things AWS proof', version: '1' } });
  if (message.method === 'tools/list') return result({ tools: [{ name: 'fixture_lookup', description: 'Look up the authenticated test account. Returns its name and the supplied query.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false } }] });
  if (message.method === 'tools/call' && params.name === 'fixture_lookup') {
    const args = record(params.arguments) ? params.arguments : {};
    if (typeof args.query !== 'string' || args.query.length > 256) return result({ isError: true, content: [{ type: 'text', text: 'Invalid query' }] });
    const metadata = record(params._meta) ? params._meta : {};
    return { ...result({ content: [{ type: 'text', text: JSON.stringify({ account, query: args.query, metadata }) }] }),
      ...(typeof metadata.proof === 'string' && /^mcp-[a-f0-9-]{36}$/.test(metadata.proof)
        ? { audit: { version: '1', operation: 'mcp.lookup', proof: metadata.proof, account, query: args.query } } : {}) };
  }
  return { status: 200, body: { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } } };
}

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
