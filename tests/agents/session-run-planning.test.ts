import { describe, expect, it } from 'vitest';
import type { AgentSession } from '../../src/domain/agents-api.js';
import { sessionAgent } from '../../src/core/session-planning.js';
import { planSessionRun, sessionMessageText } from '../../src/core/session-run-planning.js';

const session: AgentSession = {
  id: 'sess', object: 'agent.session', agent: sessionAgent({ model: 'fixture' }, 'agent', 0),
  environment: { type: 'none' }, created_at: 0, last_active_at: 0, status: 'idle', error: null,
  required_actions: [], usage: null, vault_ids: [], metadata: {},
};

const hosted = (access: 'enabled' | 'disabled' | 'restricted'): AgentSession['environment'] => ({
  type: 'openai_hosted', id: 'env', network: { access, allowed_domains: [] },
  capability_directories: [], files: [], packages: { npm: [], python: [], system: [] }, plugins: [], skills: [],
});

describe('Session Run planning', () => {
  it.each<[AgentSession['environment'], string, boolean]>([
    [{ type: 'none' }, 'read-only', false],
    [{ type: 'self_hosted', id: 'env', workspace_directory: '/workspace', capability_directories: [], remote_url: 'https://relay.example/env' }, 'danger-full-access', true],
    ...(['disabled', 'restricted', 'enabled'] as const).map<[AgentSession['environment'], string, boolean]>(access => [
      hosted(access),
      access === 'enabled' ? 'danger-full-access' : 'workspace-write', access === 'enabled',
    ]),
  ])('preserves the capability envelope for %j', (environment, sandbox, networkAccess) => {
    const value = { ...session, environment };
    const before = structuredClone(value);
    const request = planSessionRun(value, 'ec2', []);
    expect(request).toMatchObject({ prompt: '[Empty user input]', execution: { backend: 'ec2', timeoutSeconds: 28000 },
      agent: { driver: 'codex', sandbox, capabilities: { networkAccess, webSearch: 'disabled', computerUse: 'disabled' } } });
    expect(value).toEqual(before);
  });

  it('retains source identity but clones a repository only for a hosted workspace', () => {
    const origin = { id: 'origin', text: '', source: { kind: 'api' as const },
      actor: { kind: 'human' as const, id: 'actor', provider: 'api' as const }, credentialSubject: { kind: 'actor' as const, id: 'subject' },
      repository: { provider: 'github' as const, url: 'https://github.com/example/repo.git' } };
    expect(planSessionRun(session, 'microvm', [], origin)).not.toHaveProperty('repository');
    const managed: AgentSession = { ...session, environment: hosted('enabled') };
    expect(planSessionRun(managed, 'microvm', [], origin)).toMatchObject({ repository: origin.repository, source: origin.source });
  });

  it('preserves blank input, image markers, and explicit disabled search', () => {
    expect(sessionMessageText([{ role: 'user', content: [{ type: 'input_text', text: '' }] }])).toBe('[Empty user input]');
    expect(sessionMessageText([{ role: 'user', content: [{ type: 'input_text', text: '0' }, { type: 'input_image', image_url: 'https://example.com/image.png' }] }])).toBe('0\n\n[Attached image]');
    const value = { ...session, agent: sessionAgent({ model: 'fixture', tools: [{ type: 'web_search', mode: 'disabled' }] }, 'agent', 0) };
    expect(planSessionRun(value, 'microvm', []).agent?.capabilities?.webSearch).toBe('disabled');
  });
});
