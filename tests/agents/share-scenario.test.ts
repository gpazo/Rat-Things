import { beforeEach, expect, it, vi } from 'vitest';
import { TeamConnectionStore } from '../../src/client-connections.js';
import { createTeamIdentities } from '../../testing/aws/team-identities.js';
import { shareScenario } from '../../testing/local-runtime/share-scenario.js';

vi.mock('../../testing/aws/team-identities.js', () => ({ createTeamIdentities: vi.fn() }));
vi.mock('../../src/agents-client.js', () => ({ createAgentsClient: () => ({ withOptions: () => ({
  post: async () => { throw new Error('Operator setup failed.'); },
}) }) }));
beforeEach(() => { vi.clearAllMocks(); });

const options = { source: { sessionId: 'sess_proof', model: 'proof', files: [] },
  endpoint: 'https://shared.example/v1', region: 'us-west-2', operatorEndpoint: 'https://operator.example/v1',
  fixture: { user_pool_id: 'us-west-2_test', issuer: 'https://issuer.example', client_id: 'test', login_origin: 'https://login.example', redirect_uri: 'http://127.0.0.1:1455/callback' },
  store: new TeamConnectionStore('/unused-proof-store') };
function ports() {
  const observations: Record<string, unknown> = {};
  return { observations, start: vi.fn(), stop: vi.fn(), localResponse: vi.fn(), signal: new AbortController().signal,
    record: async (name: string, value: unknown) => { observations[name] = value; } };
}

it('records unconfirmed identity cleanup when provider setup fails before returning its handle', async () => {
  vi.mocked(createTeamIdentities).mockRejectedValue(new Error('Could not remove partially created users.'));
  const effects = ports();
  await expect(shareScenario(options, effects)).rejects.toThrow('partially created');
  expect(effects.observations.shareCleanup).toEqual({ service: 'complete', connection: 'complete', identities: 'unconfirmed' });
  expect(effects.start).not.toHaveBeenCalled();
});

it('attempts identity cleanup and records every result even when service shutdown fails', async () => {
  const close = vi.fn().mockRejectedValue(new Error('Identity cleanup failed.'));
  const user = { issuer: 'https://issuer.example', subject: 'subject', username: 'username', loginPassword: 'memory-only',
    accessToken: 'memory-only', idToken: 'memory-only', accessTokenForRequest: async () => 'memory-only' };
  vi.mocked(createTeamIdentities).mockResolvedValue({ users: [user, user, user], close });
  const effects = ports();
  effects.stop.mockRejectedValue(new Error('Shutdown failed.'));
  await expect(shareScenario(options, effects)).rejects.toThrow('Share cleanup could not be confirmed');
  expect(close).toHaveBeenCalledOnce();
  expect(effects.observations.shareCleanup).toEqual({ service: 'failed', connection: 'complete', identities: 'failed' });
});
