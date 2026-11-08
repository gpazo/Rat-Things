import { getAgentsApiServices, getTeamAuthentication, agentsApiDiscovery } from './app/composition.js';
import { requiredEnv } from './adapters/executors.js';
import { parseHttpListenAddress } from './adapters/agents-http-config.js';
import { createAgentsHttpServer } from './adapters/agents-http-server.js';
import { agentsErrorResponse, routeAgentsRequest } from './lambdas/agents-router.js';

const services = getAgentsApiServices();
const webFunction = process.env.AWS_LAMBDA_HTTP_ENDPOINT !== undefined;
const baseURL = webFunction ? undefined : requiredEnv('AGENTS_PUBLIC_BASE_URL');
const region = webFunction ? requiredEnv('AWS_REGION') : undefined;
const discoveryBaseURL = baseURL ?? process.env.AGENTS_PUBLIC_BASE_URL ?? 'https://lambda-web.invalid/v1';
const server = createAgentsHttpServer({ ...(baseURL ? { baseURL } : {}), ...(region ? { webFunctionRegion: region } : {}), issuerURL: requiredEnv('AGENTS_TOKEN_ISSUER_URL'), discovery: agentsApiDiscovery(discoveryBaseURL),
  authenticate: (authorization, audience) => getTeamAuthentication()?.verifier.authenticate(authorization) ?? services.tokens.authenticate(authorization, audience),
  route: (request, owner, id) => routeAgentsRequest(request, owner, services, id), error: agentsErrorResponse,
});
const address = parseHttpListenAddress(process.env.AWS_LAMBDA_HTTP_ENDPOINT ??
  (process.env.PORT ? `0.0.0.0:${process.env.PORT}` : undefined));
server.listen(address.port, address.host);

let shuttingDown = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close();
  server.closeIdleConnections();
  const forceClose = setTimeout(() => server.closeAllConnections(), webFunction ? 750 : 8_000);
  forceClose.unref();
  server.once('close', () => clearTimeout(forceClose));
});
