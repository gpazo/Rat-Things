import { describe, expect, it } from 'vitest';
import {
  artifactUrlTtlSeconds,
  apiConversationRequestBody,
  apiRequestBody,
  publicationShareLandingPage,
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

describe('publication share landing page', () => {
  it('sets a browser fallback for all CloudFront cookies before opening the publication', () => {
    const html = publicationShareLandingPage('https://publication.content.example/', [
      'CloudFront-Policy=policy; Path=/; Secure; HttpOnly; SameSite=Lax',
      'CloudFront-Signature=signature; Path=/; Secure; HttpOnly; SameSite=Lax',
      'CloudFront-Key-Pair-Id=K12345678; Path=/; Secure; HttpOnly; SameSite=Lax',
    ]);

    expect(html).toContain('document.cookie = cookie');
    expect(html).toContain('CloudFront-Key-Pair-Id=K12345678; Path=/; Secure; SameSite=Lax');
    expect(html).not.toContain('HttpOnly');
    expect(html).toContain('window.location.replace("https://publication.content.example/")');
  });

  it('escapes values embedded in its inline bootstrap', () => {
    const html = publicationShareLandingPage('https://publication.content.example/', [
      'CloudFront-Policy=</script><script>alert(1)</script>; Path=/; Secure; HttpOnly',
      'CloudFront-Signature=signature; Path=/; Secure; HttpOnly',
      'CloudFront-Key-Pair-Id=K12345678; Path=/; Secure; HttpOnly',
    ]);

    expect(html).not.toContain('</script><script>alert(1)</script>');
    expect(html).toContain('CloudFront-Policy=\\u003c/script>');
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
