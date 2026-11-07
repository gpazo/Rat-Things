import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ calls: [] as string[], identityFailure: false }));
vi.mock('../../testing/aws/team-identities.js', () => ({
  createTeamIdentities: async (_fixture: unknown, _region: string, labels: string[]) => {
    if (fixture.identityFailure) throw new Error('PRIVATE_PROVIDER_ERROR');
    return { users: labels.map(label => ({ subject: label, issuer: 'fixture-issuer', accessTokenForRequest: async () => 'PRIVATE_ACCESS_TOKEN' })),
      close: async () => { fixture.calls.push('identities.close'); } };
  },
}));
vi.mock('../../src/agents-client.js', () => ({ createAgentsClient: () => ({ withOptions: () => ({ post: async () => ({ id: 'space-fixture' }) }) }) }));
vi.mock('openai', () => ({ default: class {
  beta = { agents: {
    create: async () => ({ id: 'agent-fixture' }),
    delete: async () => { fixture.calls.push('agent.delete'); },
    sessions: {
      create: async () => ({ id: 'session-fixture' }),
      delete: async () => { fixture.calls.push('session.delete'); throw new Error('PRIVATE_DELETE_ERROR'); },
    },
  } };
} }));

import { parseArguments, run } from '../../testing/performance-aws/controller.js';

const environment = {
  AWS_E2E: 'true', AWS_E2E_SHARED_SESSIONS: 'true', AWS_E2E_REAL_CODEX: 'true', AWS_REGION: 'us-west-2',
  SHARED_AGENTS_API_BASE_URL: 'https://fixture.lambda-url.us-west-2.on.aws/api/v1',
  RAT_THINGS_AGENTS_API_URL: 'https://operator.lambda-url.us-west-2.on.aws/api/v1', AWS_E2E_CODEX_MODEL_ID: 'openai.gpt-6-luna',
  TEAM_OIDC_FIXTURE_JSON: '{}',
};
afterEach(() => { vi.unstubAllGlobals(); fixture.calls.length = 0; fixture.identityFailure = false; });

it('retains rejected samples and safe diagnostics while closing streams and attempting every cleanup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'aws-performance-flow-'));
  let submissions = 0; let stopped = false;
  const snapshot = { cursor: 'fixture-cursor', session: { id: 'session-fixture' }, turns: [{ id: 'baseline-turn', status: 'completed', usage: null }], inputs: [], items: [] };
  vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit) => {
    if (url.endsWith('/activity/events')) return new Response(new ReadableStream({ start(controller) {
      options.signal!.addEventListener('abort', () => { stopped = true; controller.close(); }, { once: true });
    } }));
    if (url.endsWith('/activity')) return new Response(JSON.stringify(snapshot));
    if (url.endsWith('/events')) {
      if (String(options.body).includes('agent.session.input.cancel')) { fixture.calls.push('cancel'); return new Response(null, { status: 204 }); }
      submissions += 1;
      return new Response('PRIVATE_REJECTED_BODY', { status: 429 });
    }
    if (/\/bindings$|\/execution-roles\/default$|\/workload$/.test(url)) return new Response(null, { status: 204 });
    throw new Error('No network is permitted in this test.');
  }));
  try {
    const output = join(directory, 'evidence.json');
    const result = await run(parseArguments(['--output', output, '--scenario', '1x1', '--timeout-ms', '1000']), environment);
    expect(submissions).toBe(1);
    expect(stopped).toBe(true);
    expect(fixture.calls).toEqual(['cancel', 'session.delete', 'agent.delete', 'identities.close']);
    expect(result.status).toBe('failed');
    expect(result.scenarios[0]?.summary).toMatchObject({ accepted: 0, rejected: 1, censoredPeerInputs: 1, censoredProgress: 1 });
    expect(result.scenarios[0]?.cleanup).toMatchObject({ observers: 'complete', cancel: 'complete', drain: 'complete', session: 'failed', agent: 'complete' });
    expect(result.cleanup.identities).toBe('complete');
    const saved = await readFile(output, 'utf8');
    expect(JSON.parse(saved).phase).toBe('finished');
    expect(saved).not.toContain('PRIVATE_');
    expect(result.scenarios[0]?.finishedAt).not.toBeNull();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('writes unconfirmed identity cleanup after setup fails before a cleanup handle exists', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'aws-performance-identities-'));
  fixture.identityFailure = true;
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No network is permitted in this test.'); }));
  try {
    const output = join(directory, 'evidence.json');
    const result = await run(parseArguments(['--output', output, '--scenario', '1x1']), environment);
    expect(result.status).toBe('failed');
    expect(result.cleanup.identities).toBe('unconfirmed');
    expect(result.scenarios).toHaveLength(0);
    expect(result).toMatchObject({ plannedSubmissions: 1, attemptedSubmissions: 0, notStartedSubmissions: 1 });
    expect(await readFile(output, 'utf8')).not.toContain('PRIVATE_PROVIDER_ERROR');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
