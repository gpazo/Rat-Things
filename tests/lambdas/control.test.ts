import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  handler,
} from '../../src/lambdas/control.js';
import { ValidationError } from '../../src/domain/validation.js';
import { errorResponse } from '../../src/lambdas/runtime.js';
import { IntegrationProviderUnavailableError } from '../../src/plugins/integration-types.js';

describe('control API discovery', () => {
  it.each(['/v1/runs', '/v1/runs/run_old/events', '/v1/conversations', '/v1/conversations/old/artifacts'])('returns 404 for retired route %s', async (path) => {
    const request = event(path);
    Object.assign(request.requestContext, { authorizer: { iam: { userArn: 'arn:aws:iam::000000000000:user/test' } } });
    const result = await invoke(handler, request);
    expect(result.statusCode).toBe(404);
  });
  it('serves discovery, OpenAPI, and Agents schemas without an authenticated principal', async () => {
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
        schemas: { agents: '/schemas/agents-api.schema.json' },
      },
      capabilities: {
        consumers: ['operator', 'embedded-product', 'agent', 'cli', 'provider-event'],
        recommendedFacade: 'agents',
        authorization: {
          model: 'fixed-before-launch',
          insideEnvelope: 'autonomous',
          midRunApproval: false,
        },
        agents: { sessions: true, turns: true },
        integrations: {
          multipleAccounts: true,
          credentialOnboarding: 'manifest-driven',
          credentialVerification: 'before-persistence',
          providerIdentity: 'derived',
        },
        outputs: { durableFiles: true, publications: ['file', 'site', 'video'] },
      },
    });

    const openapi = await invoke(handler, event('/openapi.json'));
    expect(openapi.statusCode).toBe(200);
    expect(JSON.parse(openapi.body ?? '{}')).toMatchObject({
      openapi: '3.1.0',
      paths: { '/v1/agents': expect.any(Object), '/v1/schedules': expect.any(Object) },
    });

    const schema = await invoke(handler, event('/schemas/agents-api.schema.json'));
    expect(schema.statusCode).toBe(200);
    expect(schema.headers?.['content-type']).toContain('application/schema+json');
    expect(JSON.parse(schema.body ?? '{}')).toMatchObject({
      definitions: expect.any(Object),
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
