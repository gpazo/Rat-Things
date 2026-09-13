import { getAgentsApiServices } from './app/composition.js';
import { requiredEnv } from './adapters/executors.js';
import { createAgentsHttpServer } from './adapters/agents-http-server.js';
import { agentsErrorResponse, routeAgentsRequest } from './lambdas/agents-router.js';

const services = getAgentsApiServices();
const baseURL = requiredEnv('AGENTS_PUBLIC_BASE_URL');
const server = createAgentsHttpServer({ baseURL, issuerURL: requiredEnv('AGENTS_TOKEN_ISSUER_URL'),
  authenticate: (authorization) => services.tokens.authenticate(authorization, baseURL),
  route: (request, owner, id) => routeAgentsRequest(request, owner, services, id), error: agentsErrorResponse,
});
server.listen(Number(process.env.PORT ?? 8080), '0.0.0.0');
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => { server.close(); server.closeAllConnections(); });
