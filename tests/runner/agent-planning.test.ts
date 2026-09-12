import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunRequest, SandboxMode } from '../../src/domain/contracts.js';
import { planCodexLaunch } from '../../src/runner/agent-planning.js';

afterEach(() => vi.unstubAllEnvs());

const request: RunRequest = { version: '1', prompt: 'work' };

describe('Codex launch planning', () => {
  it('uses only supplied deployment values, with ChatGPT and a read-only sandbox as defaults', () => {
    vi.stubEnv('CODEX_AUTH_MODE', 'invalid');
    vi.stubEnv('CODEX_BINARY', '/ambient/binary');
    vi.stubEnv('AGENT_PUBLICATION_ENABLED', 'true');
    const plan = planCodexLaunch(request, '/workspace', 30_000, Object.freeze({}));

    expect(plan).toMatchObject({
      binary: 'codex', binaryArguments: ['-c', 'cli_auth_credentials_store=file', 'app-server'],
      workspace: '/workspace', timeoutMs: 30_000, sandbox: 'read-only',
      modelProvider: 'openai', persistent: false, networkAccess: false,
    });
    expect(plan.environment).toEqual({ RAT_THINGS_ARTIFACT_DIR: '/workspace/.rat-things/artifacts' });
    expect(plan.prompt).toMatch(/User request:\n\nwork$/);
    expect(plan.prompt).not.toContain('share.json');
    for (const field of ['model', 'identity', 'resumeThreadId', 'signal', 'dynamicTools', 'onEvent']) {
      expect(plan).not.toHaveProperty(field);
    }
  });

  it.each<[SandboxMode, boolean, SandboxMode]>([
    ['read-only', false, 'read-only'],
    ['read-only', true, 'read-only'],
    ['workspace-write', false, 'workspace-write'],
    ['workspace-write', true, 'workspace-write'],
    ['danger-full-access', false, 'workspace-write'],
    ['danger-full-access', true, 'danger-full-access'],
  ])('resolves %s with network access %s to %s', (sandbox, networkAccess, expected) => {
    const plan = planCodexLaunch({
      ...request, agent: { sandbox, capabilities: { networkAccess } },
    }, '/workspace', 0, { CODEX_TOOL_NETWORK_ACCESS: String(!networkAccess) });
    expect(plan.sandbox).toBe(expected);
    expect(plan.networkAccess).toBe(networkAccess);
  });

  it('narrows a deployment default sandbox using deployment network settings', () => {
    const deployment = { DEFAULT_SANDBOX_MODE: 'danger-full-access', CODEX_TOOL_NETWORK_ACCESS: 'true' };
    expect(planCodexLaunch(request, '/workspace', 0, deployment).sandbox).toBe('danger-full-access');
    expect(planCodexLaunch(request, '/workspace', 0, { ...deployment, CODEX_TOOL_NETWORK_ACCESS: 'TRUE' }))
      .toMatchObject({ sandbox: 'workspace-write', networkAccess: false });
  });

  it('selects the authentication-specific model and lets explicit empty models suppress defaults', () => {
    const deployment = { CODEX_CHATGPT_MODEL: 'chat-default', DEFAULT_MODEL: 'bedrock-default' };
    expect(planCodexLaunch(request, '/workspace', 0, deployment).model).toBe('chat-default');
    const bedrock = planCodexLaunch(request, '/workspace', 0, { ...deployment, CODEX_AUTH_MODE: 'bedrock' });
    expect(bedrock).toMatchObject({ model: 'bedrock-default', modelProvider: 'amazon-bedrock' });
    expect(bedrock).not.toHaveProperty('binaryArguments');
    expect(planCodexLaunch({ ...request, agent: { model: 'chosen-model' } }, '/workspace', 0, deployment).model).toBe('chosen-model');
    expect(planCodexLaunch({ ...request, agent: { model: '' } }, '/workspace', 0, deployment)).not.toHaveProperty('model');
    expect(planCodexLaunch(request, '/workspace', 0, { DEFAULT_MODEL: 'bedrock-only' })).not.toHaveProperty('model');
  });

  it('preserves an empty binary, prompt, and zero timeout without changing their defaults', () => {
    const plan = planCodexLaunch({ ...request, prompt: '' }, '/workspace', 0, {
      CODEX_BINARY: '', CODEX_CHATGPT_MODEL: '', AGENT_THREAD_ID: '',
    });
    expect(plan.binary).toBe('');
    expect(plan.timeoutMs).toBe(0);
    expect(plan.prompt).toMatch(/User request:\n\n$/);
    expect(plan).not.toHaveProperty('model');
    expect(plan).not.toHaveProperty('resumeThreadId');
  });

  it('requires an exactly enabled persistent session to resume a nonempty thread', () => {
    for (const persistent of [undefined, '', 'false', 'TRUE']) {
      expect(() => planCodexLaunch(request, '/workspace', 0, {
        PERSISTENT_SESSION: persistent, AGENT_THREAD_ID: 'thread-1',
      })).toThrow('Codex thread resume requires a persistent MicroVM session');
    }
    expect(planCodexLaunch(request, '/workspace', 0, { PERSISTENT_SESSION: 'true', AGENT_THREAD_ID: 'thread-1' }))
      .toMatchObject({ persistent: true, resumeThreadId: 'thread-1' });
  });

  it('preserves identity coercion while rejecting partial or nonpositive identities', () => {
    expect(planCodexLaunch(request, '/workspace', 0, { RUN_AGENT_UID: '0x64', RUN_AGENT_GID: ' 101 ' }).identity)
      .toEqual({ uid: 100, gid: 101 });
    expect(planCodexLaunch(request, '/workspace', 0, { RUN_AGENT_UID: '', RUN_AGENT_GID: '' })).not.toHaveProperty('identity');
    for (const [uid, gid] of [['0', '1'], ['1', ''], ['1.5', '2'], ['invalid', '2'], ['1', undefined]]) {
      expect(() => planCodexLaunch(request, '/workspace', 0, { RUN_AGENT_UID: uid, RUN_AGENT_GID: gid }))
        .toThrow('RUN_AGENT_UID and RUN_AGENT_GID must both be positive integers');
    }
  });

  it('retains capability and schema references without mutating caller-owned inputs', () => {
    const configured: RunRequest = {
      ...request,
      agent: {
        reasoningEffort: 'high', reasoningSummary: 'concise', personality: 'pragmatic',
        outputSchema: { type: 'object', required: ['summary'] },
        capabilities: { webSearch: 'disabled', skills: [], apps: ['app-1'], mcpServers: [] },
      },
    };
    const before = structuredClone(configured);
    Object.freeze(configured.agent!.capabilities!.skills);
    Object.freeze(configured.agent!.capabilities!.apps);
    Object.freeze(configured.agent!.capabilities!.mcpServers);
    Object.freeze(configured.agent!.capabilities);
    Object.freeze(configured.agent!.outputSchema);
    Object.freeze(configured.agent);
    Object.freeze(configured);
    const plan = planCodexLaunch(configured, '/workspace', 0, {});

    expect(plan).toMatchObject({ reasoningEffort: 'high', reasoningSummary: 'concise', personality: 'pragmatic', webSearch: 'disabled' });
    expect(plan.outputSchema).toBe(configured.agent!.outputSchema);
    expect(plan.skills).toBe(configured.agent!.capabilities!.skills);
    expect(plan.apps).toBe(configured.agent!.capabilities!.apps);
    expect(plan.mcpServers).toBe(configured.agent!.capabilities!.mcpServers);
    expect(configured).toEqual(before);
  });
});

describe('agent child environment', () => {
  it('copies only allowed values, preserving empty strings and excluding host credentials by default', () => {
    const allowed = {
      PATH: '/bin', HOME: '/agent', CODEX_HOME: '/agent/codex', LANG: '', LC_ALL: 'C', TMPDIR: '/tmp',
      AWS_REGION: 'us-west-2', AWS_DEFAULT_REGION: 'us-east-1', AWS_EC2_METADATA_DISABLED: 'true',
      AWS_STS_REGIONAL_ENDPOINTS: 'regional',
    };
    const deployment = Object.freeze({
      ...allowed, HOST_SECRET: 'private', CODEX_ACCESS_TOKEN: 'account-token',
      AWS_ACCESS_KEY_ID: 'access-key', AWS_SECRET_ACCESS_KEY: 'secret-key', AWS_SESSION_TOKEN: 'session-token',
      AWS_CONTAINER_CREDENTIALS_FULL_URI: 'http://credentials.invalid', AWS_BEARER_TOKEN_BEDROCK: 'bedrock-token',
    });
    const child = planCodexLaunch(request, '/workspace', 0, deployment).environment;
    expect(child).toEqual({ ...allowed, RAT_THINGS_ARTIFACT_DIR: '/workspace/.rat-things/artifacts' });
    child.PATH = 'changed';
    expect(deployment.PATH).toBe('/bin');
    expect(planCodexLaunch(request, '/workspace', 0, deployment).environment.PATH).toBe('/bin');
  });

  it('forwards the Bedrock bearer token only for Bedrock unless explicitly included by deployment passthrough', () => {
    const deployment = { AWS_BEARER_TOKEN_BEDROCK: 'bedrock-token' };
    expect(planCodexLaunch(request, '/workspace', 0, deployment).environment).not.toHaveProperty('AWS_BEARER_TOKEN_BEDROCK');
    expect(planCodexLaunch(request, '/workspace', 0, { ...deployment, CODEX_AUTH_MODE: 'bedrock' }).environment.AWS_BEARER_TOKEN_BEDROCK)
      .toBe('bedrock-token');
    expect(planCodexLaunch(request, '/workspace', 0, { ...deployment, AGENT_PASSTHROUGH_ENV: 'AWS_BEARER_TOKEN_BEDROCK' }).environment.AWS_BEARER_TOKEN_BEDROCK)
      .toBe('bedrock-token');
  });

  it('requires exact deployment opt-in before exposing the AWS credential chain', () => {
    const credentials = {
      AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/role', AWS_CONTAINER_CREDENTIALS_FULL_URI: 'http://role.invalid',
      AWS_CONTAINER_AUTHORIZATION_TOKEN: 'role-token', AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE: '/role/token',
      AWS_WEB_IDENTITY_TOKEN_FILE: '/role/web', AWS_ROLE_ARN: 'arn:role', AWS_ROLE_SESSION_NAME: 'session',
      AWS_PROFILE: 'agent', AWS_SHARED_CREDENTIALS_FILE: '/role/credentials', AWS_CONFIG_FILE: '/role/config',
      AWS_ACCESS_KEY_ID: 'access-key', AWS_SECRET_ACCESS_KEY: 'secret-key', AWS_SESSION_TOKEN: 'session-token',
    };
    for (const setting of [undefined, '', 'false', 'TRUE']) {
      expect(planCodexLaunch(request, '/workspace', 0, { ...credentials, ALLOW_AGENT_AWS_CREDENTIAL_CHAIN: setting }).environment)
        .toEqual({ RAT_THINGS_ARTIFACT_DIR: '/workspace/.rat-things/artifacts' });
    }
    expect(planCodexLaunch(request, '/workspace', 0, { ...credentials, ALLOW_AGENT_AWS_CREDENTIAL_CHAIN: 'true' }).environment)
      .toEqual({ ...credentials, RAT_THINGS_ARTIFACT_DIR: '/workspace/.rat-things/artifacts' });
  });

  it('trims and deduplicates passthrough names, drops missing values, and keeps the computed artifact directory', () => {
    const deployment = {
      AGENT_PASSTHROUGH_ENV: ' CUSTOM, ,CUSTOM,EMPTY,MISSING,RAT_THINGS_ARTIFACT_DIR ',
      CUSTOM: 'selected', EMPTY: '', RAT_THINGS_ARTIFACT_DIR: '/override',
    };
    expect(planCodexLaunch(request, '/workspace/', 0, deployment).environment).toEqual({
      CUSTOM: 'selected', EMPTY: '', RAT_THINGS_ARTIFACT_DIR: '/workspace//.rat-things/artifacts',
    });
  });
});
