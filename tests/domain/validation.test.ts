import { describe, expect, it } from 'vitest';

import { parseRunRequest, ValidationError } from '../../src/domain/validation.js';

const secretArn = 'arn:aws:secretsmanager:us-west-2:123456789012:secret:github/runtime-token-AbCd12';

describe('parseRunRequest', () => {
  it('requires network access when browser computer use is explicitly requested', () => {
    expect(() => parseRunRequest({
      version: '1',
      prompt: 'browse',
      agent: {
        capabilities: {
          computerUse: 'browser',
          networkAccess: false,
        },
      },
    })).toThrow('computerUse browser requires networkAccess');
  });

  it('accepts and normalizes a complete version 1 request', () => {
    const request = parseRunRequest(
      {
        version: '1',
        prompt: 'Review the checked-out change.',
        repository: {
          provider: 'github',
          url: 'https://git.example.test/acme/runtime.git',
          ref: 'feature/runtime-v2',
          baseRef: 'main',
          installationId: '42',
          credentialSecretArn: secretArn,
        },
        agent: {
          driver: 'codex',
          model: 'openai.gpt-5.6-terra',
          sandbox: 'read-only',
          reasoningEffort: 'high',
          reasoningSummary: 'concise',
          personality: 'pragmatic',
          capabilities: {
            profile: 'trusted-browser',
            approvalPolicy: 'on-request',
            approvalsReviewer: 'auto-review',
            networkAccess: true,
            webSearch: 'live',
            computerUse: 'browser',
            skills: ['outbound-copy-studio'],
            apps: ['gmail'],
            mcpServers: ['github'],
          },
          outputSchema: { type: 'object', required: ['summary'] },
        },
        integrations: {
          connectionSet: 'acme-operations',
          connections: [
            {
              connection: 'google-work',
              preset: 'custom',
              allowOperations: ['gmail.messages.search'],
              denyOperations: ['gmail.messages.delete'],
            },
          ],
        },
        execution: { backend: 'microvm', timeoutSeconds: 900 },
        source: {
          kind: 'github',
          deliveryId: 'delivery-1',
          event: 'pull_request',
          repository: 'acme/runtime',
          issueNumber: 17,
          installationId: '42',
        },
        destinations: [{ kind: 'source' }, { kind: 'teams', route: 'engineering' }],
        metadata: { attempt: 1, labels: ['runtime', 'review'], enabled: true },
        parentRunId: 'parent-run-1',
      },
      { allowedRepositoryHosts: ['GIT.EXAMPLE.TEST'] },
    );

    expect(request).toEqual({
      version: '1',
      prompt: 'Review the checked-out change.',
      repository: {
        provider: 'github',
        url: 'https://git.example.test/acme/runtime.git',
        ref: 'feature/runtime-v2',
        baseRef: 'main',
        installationId: '42',
        credentialSecretArn: secretArn,
      },
        agent: {
          driver: 'codex',
          model: 'openai.gpt-5.6-terra',
          sandbox: 'read-only',
          reasoningEffort: 'high',
          reasoningSummary: 'concise',
          personality: 'pragmatic',
          capabilities: {
            profile: 'trusted-browser',
            approvalPolicy: 'on-request',
            approvalsReviewer: 'auto-review',
            networkAccess: true,
            webSearch: 'live',
            computerUse: 'browser',
            skills: ['outbound-copy-studio'],
            apps: ['gmail'],
            mcpServers: ['github'],
          },
          outputSchema: { type: 'object', required: ['summary'] },
        },
        integrations: {
          connectionSet: 'acme-operations',
          connections: [
            {
              connection: 'google-work',
              preset: 'custom',
              allowOperations: ['gmail.messages.search'],
              denyOperations: ['gmail.messages.delete'],
            },
          ],
        },
      execution: { backend: 'microvm', timeoutSeconds: 900 },
      source: {
        kind: 'github',
        deliveryId: 'delivery-1',
        event: 'pull_request',
        repository: 'acme/runtime',
        issueNumber: 17,
        installationId: '42',
      },
      destinations: [{ kind: 'source' }, { kind: 'teams', route: 'engineering' }],
      metadata: { attempt: 1, labels: ['runtime', 'review'], enabled: true },
      parentRunId: 'parent-run-1',
    });
  });

  it.each([
    ['a non-object request', null, 'request must be an object'],
    ['an unsupported version', { version: '2', prompt: 'hello' }, 'version must be "1"'],
    ['a missing prompt', { version: '1' }, 'prompt must be a non-empty string'],
    ['a whitespace-only prompt', { version: '1', prompt: '  \n ' }, 'prompt cannot be empty'],
    [
      'an invalid execution timeout',
      { version: '1', prompt: 'hello', execution: { timeoutSeconds: 29 } },
      'execution.timeoutSeconds must be an integer from 30 to 28000',
    ],
    [
      'an invalid source discriminator',
      { version: '1', prompt: 'hello', source: { kind: 'email' } },
      'source.kind is invalid',
    ],
  ])('rejects %s', (_label, input, message) => {
    expect(() => parseRunRequest(input)).toThrowError(new ValidationError(message));
  });

  it('rejects unknown fields at the request and nested-object boundaries', () => {
    expect(() => parseRunRequest({ version: '1', prompt: 'hello', surprise: true })).toThrow(
      'unknown field: surprise',
    );
    expect(() =>
      parseRunRequest({
        version: '1',
        prompt: 'hello',
        agent: { driver: 'mock', command: 'arbitrary executable' },
      }),
    ).toThrow('unknown field: command');
    expect(() =>
      parseRunRequest({
        version: '1',
        prompt: 'hello',
        source: { kind: 'api', requestId: 'request-1', ownerId: 'attacker' },
      }),
    ).toThrow('unknown field: ownerId');
  });

  it('enforces byte limits for prompts, metadata, and output schemas', () => {
    expect(parseRunRequest({ version: '1', prompt: 'a'.repeat(100_000) }).prompt).toHaveLength(
      100_000,
    );
    expect(() => parseRunRequest({ version: '1', prompt: 'a'.repeat(100_001) })).toThrow(
      'prompt exceeds 100000 bytes',
    );
    expect(() =>
      parseRunRequest({ version: '1', prompt: 'hello', metadata: { value: 'x'.repeat(32_001) } }),
    ).toThrow('metadata exceeds 32000 bytes');
    expect(() =>
      parseRunRequest({
        version: '1',
        prompt: 'hello',
        agent: { outputSchema: { description: 'x'.repeat(32_001) } },
      }),
    ).toThrow('agent.outputSchema exceeds 32000 bytes');
  });

  it('uses a case-insensitive repository host allowlist', () => {
    const request = parseRunRequest(
      {
        version: '1',
        prompt: 'hello',
        repository: { provider: 'generic', url: 'https://CODE.EXAMPLE.TEST/acme/repo.git' },
      },
      { allowedRepositoryHosts: ['code.example.test'] },
    );
    expect(request.repository?.url).toBe('https://code.example.test/acme/repo.git');

    expect(() =>
      parseRunRequest(
        {
          version: '1',
          prompt: 'hello',
          repository: { provider: 'generic', url: 'https://evil.example/acme/repo.git' },
        },
        { allowedRepositoryHosts: ['code.example.test'] },
      ),
    ).toThrow('repository host evil.example is not allowed');

    expect(() =>
      parseRunRequest(
        {
          version: '1',
          prompt: 'hello',
          repository: { provider: 'generic', url: 'https://github.com/acme/repo.git' },
        },
        { allowedRepositoryHosts: [] },
      ),
    ).toThrow('repository host github.com is not allowed');
  });

  it.each([
    'http://github.com/acme/repo.git',
    'https://token@github.com/acme/repo.git',
    'https://github.com/acme/repo.git?token=secret',
    'https://github.com/acme/repo.git#main',
  ])('rejects unsafe repository URL %s', (url) => {
    expect(() =>
      parseRunRequest({
        version: '1',
        prompt: 'hello',
        repository: { provider: 'github', url },
      }),
    ).toThrow('repository.url must be credential-free HTTPS without query or fragment');
  });

  it.each(['../main', 'refs/heads/main/', 'main@{upstream}', '-unsafe']) (
    'rejects unsafe Git ref %s',
    (ref) => {
      expect(() =>
        parseRunRequest({
          version: '1',
          prompt: 'hello',
          repository: { provider: 'github', url: 'https://github.com/acme/repo.git', ref },
        }),
      ).toThrow('repository.ref is not a safe Git ref');
    },
  );

  it('rejects values that JSON would silently drop or rewrite', () => {
    expect(() => parseRunRequest({
      version: '1',
      prompt: 'hello',
      metadata: { missing: undefined },
    })).toThrow('metadata.missing must contain only JSON values');
    expect(() => parseRunRequest({
      version: '1',
      prompt: 'hello',
      metadata: { invalid: Number.POSITIVE_INFINITY },
    })).toThrow('metadata.invalid contains a non-finite number');
    expect(() => parseRunRequest({
      version: '1',
      prompt: 'hello',
      agent: { outputSchema: { transform: () => 'unsafe' } },
    })).toThrow('agent.outputSchema.transform must contain only JSON values');
  });

  it('enforces the deployment sandbox allowlist', () => {
    expect(() => parseRunRequest(
      { version: '1', prompt: 'hello', agent: { sandbox: 'danger-full-access' } },
      { allowedSandboxModes: ['read-only', 'workspace-write'] },
    )).toThrow('agent.sandbox danger-full-access is disabled by runtime policy');
  });

  it('rejects unsupported agent drivers', () => {
    expect(() => parseRunRequest({
      version: '1',
      prompt: 'hello',
      agent: { driver: 'claude-code' },
    })).toThrow('agent.driver must be codex or mock');
  });

  it('validates capability and multi-account integration requests', () => {
    expect(parseRunRequest({
      version: '1',
      prompt: 'hello',
      agent: { reasoningEffort: 'ultra', capabilities: { networkAccess: true } },
      integrations: {
        connections: [{ connection: 'google-work', preset: 'read-only' }],
      },
    })).toMatchObject({
      agent: { reasoningEffort: 'ultra', capabilities: { networkAccess: true } },
      integrations: {
        connections: [{ connection: 'google-work', preset: 'read-only' }],
      },
    });
    expect(() => parseRunRequest({
      version: '1',
      prompt: 'hello',
      integrations: {
        connections: [{ connection: 'google-work', preset: 'custom' }],
      },
    })).toThrow('custom integration access requires allowOperations');
    expect(() => parseRunRequest({
      version: '1',
      prompt: 'hello',
      agent: { capabilities: { apps: ['gmail', 'gmail'] } },
    })).toThrow('agent.capabilities.apps contains duplicate gmail');
  });
});
