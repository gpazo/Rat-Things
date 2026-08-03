import type { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { getWebhookIngressService } from '../app/composition.js';
import type { ProviderKind } from '../identity/context.js';
import type { WebhookIngressService } from '../ingress/service.js';
import { errorResponse, rawBody, response } from './runtime.js';

export function createWebhookHandler(
  provider: ProviderKind,
  service: () => WebhookIngressService = getWebhookIngressService,
): APIGatewayProxyHandlerV2 {
  return async (event) => {
    try {
      const result = await service().receive(provider, {
        body: rawBody(event),
        headers: event.headers,
      });
      return response(result.statusCode, result.body);
    } catch (error) {
      return errorResponse(error);
    }
  };
}
