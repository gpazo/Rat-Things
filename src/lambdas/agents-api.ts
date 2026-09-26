import { iamApiPrincipal } from '../domain/api-permissions.js';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { getAgentsApiServices, getApiTokenService } from '../app/composition.js';
import { AgentsApiError } from '../domain/agents-api-validation.js';
import { agentsErrorResponse, routeAgentsRequest } from './agents-router.js';
import { principal } from './runtime.js';

/** Function URLs support native SSE and derive the owner from verified AWS IAM identity. */
// AWS SDK invocation tracking can create this namespace outside the Lambda runtime.
const lambdaRuntime = globalThis.awslambda;
export const handler = typeof lambdaRuntime?.streamifyResponse !== 'function' ? unavailableOutsideLambda : lambdaRuntime.streamifyResponse<APIGatewayProxyEventV2>(async (event, output, context) => {
  const abort = new AbortController();
  output.once('close', () => abort.abort());
  const timer = setTimeout(() => abort.abort(), Math.max(1, context.getRemainingTimeInMillis() - 1000));
  let response: Response;
  try {
    let ownerId: string;
    try { ownerId = principal(event); } catch { throw new AgentsApiError(401, 'Authentication required.', 'invalid_api_key'); }
    const method = event.requestContext.http.method;
    const request = new Request(`https://agents.invalid${event.rawPath}${event.rawQueryString ? `?${event.rawQueryString}` : ''}`, {
      method, signal: abort.signal,
      headers: Object.fromEntries(Object.entries(event.headers).filter((entry): entry is [string, string] => entry[1] !== undefined)),
      ...(event.body && method !== 'GET' && method !== 'HEAD' ? { body: event.isBase64Encoded ? Buffer.from(event.body, 'base64') : event.body } : {}),
    });
    if (method === 'POST' && event.rawPath === '/v1/auth/tokens') {
      const audience = process.env.AGENTS_PUBLIC_BASE_URL;
      if (!audience) throw new AgentsApiError(503, 'The streaming API is not configured.', 'service_unavailable');
      response = Response.json(await getApiTokenService().issue(ownerId, audience, await request.json().catch(() => { throw new AgentsApiError(400, 'Expected a JSON token request.', 'invalid_request'); })), { headers: { 'cache-control': 'no-store', 'x-request-id': context.awsRequestId } });
    } else {
      if (process.env.AGENTS_TOKEN_ISSUER_ONLY === 'true') throw new AgentsApiError(404, 'Route not found.', 'not_found');
      response = await routeAgentsRequest(request, iamApiPrincipal(ownerId), getAgentsApiServices(), context.awsRequestId);
    }
  } catch (error) { response = agentsErrorResponse(error, context.awsRequestId); }
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => { headers[key] = value; });
  const stream = lambdaRuntime.HttpResponseStream.from(output, { statusCode: response.status, headers });
  try {
    if (response.body) await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream<Uint8Array>), stream);
    else stream.end();
  } finally { clearTimeout(timer); abort.abort(); }
});

async function unavailableOutsideLambda(): Promise<never> { throw new Error('The Agents API streaming entry point requires the AWS Lambda runtime'); }
