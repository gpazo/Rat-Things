import { describe, expect, it } from 'vitest';
import { planMcpFixture, planOAuthFixture } from '../../src/lambdas/integration-mcp-fixture.js';

const proof = 'mcp-11111111-1111-1111-1111-111111111111';
describe('deployment-owned MCP fixture', () => {
  it('requires the synthetic client grant and audits only the public proof identity', () => {
    const basic = `Basic ${Buffer.from(`${proof}:oauth-test`).toString('base64')}`;
    const form = 'grant_type=refresh_token&refresh_token=refresh-test';
    expect(planOAuthFixture('test', '', form).status).toBe(401);
    expect(planOAuthFixture('test', basic, `${form}-wrong`).status).toBe(400);
    const reply = planOAuthFixture('test', basic, form);
    expect(reply).toMatchObject({ status: 200, body: { access_token: 'beta-test', refresh_token: 'rotated-test' }, audit: { operation: 'oauth.refresh', proof } });
    expect(JSON.stringify(reply.audit)).not.toMatch(/oauth-test|refresh-test|beta-test/);
  });
  it('keeps requests immutable and carries falsey metadata through MCP output', () => {
    const input = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'fixture_lookup', arguments: { query: 'lookup' }, _meta: { proof, flag: false, count: 0 } } };
    const copy = structuredClone(input);
    const reply = planMcpFixture('beta', 'POST', input);
    expect(reply).toMatchObject({ status: 200, audit: { operation: 'mcp.lookup', proof, account: 'beta', query: 'lookup' } });
    expect(JSON.stringify(reply.body)).toContain('\\"flag\\":false');
    expect(input).toEqual(copy);
    expect(planMcpFixture('beta', 'GET', undefined)).toMatchObject({ status: 405 });
    expect(planMcpFixture('beta', 'POST', { jsonrpc: '2.0', method: 'notifications/initialized' })).toMatchObject({ status: 202 });
  });
});
