import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  artifactUrlTtlSeconds,
  apiRunSubmissionBody,
  apiRequestBody,
  handler,
} from '../../src/lambdas/control.js';
import { ValidationError } from '../../src/domain/validation.js';
import { errorResponse } from '../../src/lambdas/runtime.js';
import { IntegrationProviderUnavailableError } from '../../src/plugins/integration-types.js';

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

  it('turns an owner-scoped thread key into optional continuity on the same Run', () => {
    const result = apiRunSubmissionBody(
      {
        version: '1',
        prompt: 'Continue the release.',
        thread: { key: 'release', delivery: 'defer' },
      },
      { kind: 'api' },
      'api:owner-1',
      'release-message-1',
    );

    expect(result.request).toEqual({
      version: '1',
      prompt: 'Continue the release.',
      source: { kind: 'api' },
    });
    expect(result.thread).toMatchObject({
      conversationId: expect.stringMatching(/^api:[a-f0-9]{32}:release$/),
      messageId: 'release-message-1',
      delivery: 'defer',
    });
  });

  it('requires idempotency before accepting threaded work', () => {
    expect(() => apiRunSubmissionBody(
      { version: '1', prompt: 'test', thread: { key: 'release' } },
      { kind: 'api' },
      'api:owner-1',
    )).toThrow('Idempotency-Key must be 1-200 safe ASCII characters');
  });
});

describe('control API discovery', () => {
  it('serves discovery, OpenAPI, and Thing schemas without an authenticated principal', async () => {
    const discovery = await invoke(handler, event('/.well-known/rat-things'));
    expect(discovery.statusCode).toBe(200);
    expect(JSON.parse(discovery.body ?? '{}')).toMatchObject({
      version: '1',
      service: 'rat-things',
      deployment: {
        operation: 'independent',
        maturity: 'engineering-preview',
        oauthApplications: 'bring-your-own',
      },
      api: {
        openapi: '/openapi.json',
        agentGuide: 'https://gpazo.github.io/Rat-Things/docs/agents/',
        agentDocs: 'https://gpazo.github.io/Rat-Things/llms.txt',
        agentDocsFull: 'https://gpazo.github.io/Rat-Things/llms-full.txt',
        schemas: { thing: '/schemas/thing-v1.json' },
      },
      capabilities: {
        consumers: ['operator', 'embedded-product', 'agent', 'cli', 'provider-event'],
        recommendedFacade: 'things',
        things: { immutableRevisions: true, explain: true },
        integrations: {
          multipleAccounts: true,
          credentialOnboarding: 'manifest-driven',
          credentialVerification: 'before-persistence',
          providerIdentity: 'derived',
        },
        runs: { asynchronous: true, liveEvents: true, approvals: true },
        conversations: { durable: true, replacementCompute: true },
        outputs: { durableFiles: true, publications: ['file', 'site', 'video'] },
      },
    });

    const openapi = await invoke(handler, event('/openapi.json'));
    expect(openapi.statusCode).toBe(200);
    expect(JSON.parse(openapi.body ?? '{}')).toMatchObject({
      openapi: '3.1.0',
      paths: { '/v1/things': expect.any(Object) },
    });

    const schema = await invoke(handler, event('/schemas/thing-v1.json'));
    expect(schema.statusCode).toBe(200);
    expect(schema.headers?.['content-type']).toContain('application/schema+json');
    expect(JSON.parse(schema.body ?? '{}')).toMatchObject({
      title: 'Rat Things ThingSpec v1',
      required: ['version', 'name', 'goal', 'trigger'],
    });
  });
});

describe('control API errors', () => {
  it('returns a stable retry classification and correlation ID', () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(JSON.parse(errorResponse(
      new ValidationError('invalid Thing fixture'),
      'trace-test-1',
    ).body ?? '{}')).toEqual({
      error: {
        code: 'invalid_request',
        message: 'invalid Thing fixture',
        retryable: false,
        traceId: 'trace-test-1',
      },
    });
    expect(JSON.parse(errorResponse(
      new IntegrationProviderUnavailableError('Fixture CRM'),
      'trace-provider',
    ).body ?? '{}')).toEqual({
      error: {
        code: 'integration_unavailable',
        message: 'Fixture CRM credential verification is temporarily unavailable',
        retryable: true,
        traceId: 'trace-provider',
      },
    });
    expect(JSON.parse(errorResponse(new Error('secret internal detail'), 'trace-test-2').body ?? '{}'))
      .toEqual({
        error: {
          code: 'internal_error',
          message: 'internal server error',
          retryable: true,
          traceId: 'trace-test-2',
        },
      });
    expect(errorLog).toHaveBeenCalledOnce();
    errorLog.mockRestore();
  });
});

async function invoke(
  candidate: unknown,
  input: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  return await (candidate as (value: APIGatewayProxyEventV2) => Promise<APIGatewayProxyStructuredResultV2>)(input);
}

function event(path: string): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: `GET ${path}`,
    rawPath: path,
    rawQueryString: '',
    headers: {},
    requestContext: {
      accountId: '000000000000',
      apiId: 'test',
      domainName: 'example.test',
      domainPrefix: 'example',
      http: {
        method: 'GET',
        path,
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'vitest',
      },
      requestId: randomUUID(),
      routeKey: `GET ${path}`,
      stage: '$default',
      time: new Date().toISOString(),
      timeEpoch: Date.now(),
    },
    isBase64Encoded: false,
  };
}
