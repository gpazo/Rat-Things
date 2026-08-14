import { describe, expect, it } from 'vitest';
import {
  apiConversationRequestBody,
  apiRequestBody,
} from '../../src/lambdas/control.js';

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
  it('accepts only durable execution policy fields', () => {
    expect(apiConversationRequestBody({
      version: '1',
      prompt: 'Inspect the workspace with shell tools.',
      agent: {
        driver: 'codex',
        model: 'openai.gpt-5.6-terra',
        sandbox: 'workspace-write',
        reasoningEffort: 'low',
      },
    })).toEqual({
      version: '1',
      prompt: 'Inspect the workspace with shell tools.',
      agent: {
        driver: 'codex',
        model: 'openai.gpt-5.6-terra',
        sandbox: 'workspace-write',
        reasoningEffort: 'low',
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
