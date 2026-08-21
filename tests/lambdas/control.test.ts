import { describe, expect, it } from 'vitest';
import {
  artifactUrlTtlSeconds,
  apiConversationRequestBody,
  apiRequestBody,
} from '../../src/lambdas/control.js';

describe('artifact URL lifetime', () => {
  it('defaults to one day and bounds deployment configuration', () => {
    expect(artifactUrlTtlSeconds(undefined)).toBe(86_400);
    expect(artifactUrlTtlSeconds('60')).toBe(60);
    expect(artifactUrlTtlSeconds('7200')).toBe(7_200);
    expect(artifactUrlTtlSeconds('86401')).toBe(86_400);
    expect(artifactUrlTtlSeconds('invalid')).toBe(86_400);
  });
});

describe('control API request normalization', () => {
  it('uses stable trusted source metadata across idempotent API attempts', () => {
    const body = {
      version: '1',
      prompt: 'test',
      source: { kind: 'github', deliveryId: 'untrusted' },
    };

    expect(apiRequestBody(body)).toEqual({
      version: '1',
      prompt: 'test',
      source: { kind: 'api' },
    });
    expect(apiRequestBody(body)).toEqual(apiRequestBody(body));
  });
});

describe('control API conversation request normalization', () => {
  it('accepts durable capability and multi-account integration policy fields', () => {
    expect(apiConversationRequestBody({
      version: '1',
      prompt: 'Inspect the workspace with shell tools.',
      agent: {
        driver: 'codex',
        model: 'openai.gpt-5.6-terra',
        sandbox: 'workspace-write',
        reasoningEffort: 'low',
        reasoningSummary: 'concise',
        personality: 'pragmatic',
        capabilities: {
          approvalPolicy: 'on-request',
          approvalsReviewer: 'guardian-subagent',
          networkAccess: true,
          webSearch: 'live',
          computerUse: 'browser',
          skills: ['invoice-review'],
          apps: ['google-drive'],
          mcpServers: ['accounting'],
        },
      },
      integrations: {
        connectionSet: 'small-business',
        connections: [
          { connection: 'gmail-sales', preset: 'read-only' },
          { connection: 'stripe-live', preset: 'read-write' },
        ],
      },
    })).toEqual({
      version: '1',
      prompt: 'Inspect the workspace with shell tools.',
      agent: {
        driver: 'codex',
        model: 'openai.gpt-5.6-terra',
        sandbox: 'workspace-write',
        reasoningEffort: 'low',
        reasoningSummary: 'concise',
        personality: 'pragmatic',
        capabilities: {
          approvalPolicy: 'on-request',
          approvalsReviewer: 'guardian-subagent',
          networkAccess: true,
          webSearch: 'live',
          computerUse: 'browser',
          skills: ['invoice-review'],
          apps: ['google-drive'],
          mcpServers: ['accounting'],
        },
      },
      integrations: {
        connectionSet: 'small-business',
        connections: [
          { connection: 'gmail-sales', preset: 'read-only' },
          { connection: 'stripe-live', preset: 'read-write' },
        ],
      },
    });
  });

  it('rejects caller-selected provider and delivery context', () => {
    expect(() => apiConversationRequestBody({
      version: '1',
      prompt: 'test',
      source: { kind: 'teams' },
    })).toThrow('request contains unknown field source');
    expect(() => apiConversationRequestBody({
      version: '1',
      prompt: 'test',
      destinations: [{ kind: 'slack', route: 'arbitrary' }],
    })).toThrow('request contains unknown field destinations');
  });

  it('rejects output schemas because execution policy is fixed for the conversation', () => {
    expect(() => apiConversationRequestBody({
      version: '1',
      prompt: 'test',
      agent: { outputSchema: { type: 'object' } },
    })).toThrow('agent.outputSchema is not supported');
  });
});
