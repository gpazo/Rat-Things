import { iamApiPrincipal } from '../domain/api-permissions.js';
import { Readable, Transform } from 'node:stream';
import { PerformanceScope, performanceCount, performanceHeaders, requestPerformanceOperation, responsePerformanceOutcome, type PerformanceOutcome } from '../core/performance.js';
import { finished, pipeline } from 'node:stream/promises';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { getAgentsApiServices, getApiTokenService, getTeamAuthentication, agentsApiDiscovery } from '../app/composition.js';
import { AgentsApiError } from '../domain/agents-api-validation.js';
import { agentsErrorResponse, routeAgentsRequest } from './agents-router.js';
import { principal } from './runtime.js';

/** Function URLs select IAM or OIDC only through trusted deployment configuration. */
// AWS SDK invocation tracking can create this namespace outside the Lambda runtime.
const lambdaRuntime = globalThis.awslambda;
export const handler = typeof lambdaRuntime?.streamifyResponse !== 'function' ? unavailableOutsideLambda : lambdaRuntime.streamifyResponse<APIGatewayProxyEventV2>(async (event, output, context) => {
  const scope = new PerformanceScope(requestPerformanceOperation(event.requestContext.http.method, event.rawPath));
  await scope.run(async () => {
  const abort = new AbortController();
  output.once('close', () => abort.abort());
  const timer = setTimeout(() => abort.abort(), Math.max(1, context.getRemainingTimeInMillis() - 1000));
  let response: Response;
  try {
    const method = event.requestContext.http.method;
    const request = new Request(`https://agents.invalid${event.rawPath}${event.rawQueryString ? `?${event.rawQueryString}` : ''}`, {
      method, signal: abort.signal,
      headers: Object.fromEntries(Object.entries(event.headers).filter((entry): entry is [string, string] => entry[1] !== undefined)),
      ...(event.body && method !== 'GET' && method !== 'HEAD' ? { body: event.isBase64Encoded ? Buffer.from(event.body, 'base64') : event.body } : {}),
    });
    const team = getTeamAuthentication();
    if (method === 'GET' && event.rawPath === '/.well-known/agents-api') {
      // Function URL identity comes from AWS invocation context, never the Host header.
      const invocationBaseURL = team ? `https://${event.requestContext.domainName}/v1` : undefined;
      response = Response.json(agentsApiDiscovery(invocationBaseURL), { headers: { 'cache-control': 'no-store' } });
    } else if (team) {
      if (event.rawPath === '/v1/auth/tokens') throw new AgentsApiError(404, 'Route not found.', 'not_found');
      response = await routeAgentsRequest(request, await team.verifier.authenticate(request.headers.get('authorization')), getAgentsApiServices(), context.awsRequestId);
    } else {
      let ownerId: string;
      try { ownerId = principal(event); } catch { throw new AgentsApiError(401, 'Authentication required.', 'invalid_api_key'); }
      if (method === 'POST' && event.rawPath === '/v1/auth/tokens') {
        const audience = process.env.AGENTS_PUBLIC_BASE_URL;
        if (!audience) throw new AgentsApiError(503, 'The streaming API is not configured.', 'service_unavailable');
        response = Response.json(await getApiTokenService().issue(ownerId, audience, await request.json().catch(() => { throw new AgentsApiError(400, 'Expected a JSON token request.', 'invalid_request'); })), { headers: { 'cache-control': 'no-store', 'x-request-id': context.awsRequestId } });
      } else {
        if (process.env.AGENTS_TOKEN_ISSUER_ONLY === 'true' && !(method === 'POST' && event.rawPath === '/v1/rat/spaces')) throw new AgentsApiError(404, 'Route not found.', 'not_found');
        response = await routeAgentsRequest(request, iamApiPrincipal(ownerId), getAgentsApiServices(), context.awsRequestId);
      }
    }
  } catch (error) { response = agentsErrorResponse(error, context.awsRequestId); }
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => { headers[key] = value; });
  const stream = lambdaRuntime.HttpResponseStream.from(output, { statusCode: response.status, headers });
  performanceHeaders();
  let outcome: PerformanceOutcome = responsePerformanceOutcome(response.status);
  try {
    if (response.body) await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream<Uint8Array>), new Transform({ transform(chunk: Buffer, _encoding, callback) {
      performanceCount('ResponseBytes', chunk.length); callback(null, chunk);
    } }), stream);
    else {
      const completion = finished(stream, { readable: false });
      // AWS emits HTTP metadata on the first write, including a zero-byte write.
      stream.write(Buffer.alloc(0));
      stream.end();
      await completion;
    }
  } catch (error) { outcome = abort.signal.aborted ? 'aborted' : 'error'; throw error; }
  finally { clearTimeout(timer); abort.abort(); scope.finish(outcome); }
  });
});

async function unavailableOutsideLambda(): Promise<never> { throw new Error('The Agents API streaming entry point requires the AWS Lambda runtime'); }
