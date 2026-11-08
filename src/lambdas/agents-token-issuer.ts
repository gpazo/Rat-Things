import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { getApiTokenService } from '../app/composition.js';
import { AgentsApiError } from '../domain/agents-api-validation.js';
import { errorResponse, iamPrincipal, rawBody, response } from './runtime.js';

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  try {
    if (event.requestContext.http.method !== 'POST' || event.rawPath !== '/v1/auth/tokens') {
      throw new AgentsApiError(404, 'Route not found.', 'not_found');
    }
    let ownerId: string;
    try { ownerId = iamPrincipal(event); }
    catch { throw new AgentsApiError(401, 'IAM authentication required.', 'invalid_api_key'); }
    const audience = process.env.AGENTS_PUBLIC_BASE_URL;
    if (!audience) throw new AgentsApiError(503, 'The Agents API is not configured.', 'service_unavailable');
    let input: unknown;
    try { input = JSON.parse(rawBody(event)); }
    catch { throw new AgentsApiError(400, 'Expected a JSON token request.', 'invalid_request'); }
    return response(200, await getApiTokenService().issue(ownerId, audience, input), {
      'x-request-id': event.requestContext.requestId,
    });
  } catch (error) { return errorResponse(error, event.requestContext.requestId); }
}
