import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { rename, rm, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createLocalServices, LOCAL_OWNER } from './app/local-composition.js';
import { routeAgentsRequest, agentsErrorResponse, requestBody, queryParameters } from './lambdas/agents-router.js';
import { iamApiPrincipal } from './domain/api-permissions.js';
import { AgentsApiError } from './domain/agents-api-validation.js';
import { localWorkspaceDirectory } from './local-workspace.js';
import { localServiceIdentity } from './domain/local-service.js';

export async function startLocalServer(options: {
  directory?: string; port?: number; model?: string; maxSessions?: number;
  execution?: Parameters<typeof createLocalServices>[0]['execution'];
  runtime?: Parameters<typeof createLocalServices>[0]['runtime'];
  hostCodex?: Parameters<typeof createLocalServices>[0]['hostCodex'];
  native?: Parameters<typeof createLocalServices>[0]['native'];
  pi?: Parameters<typeof createLocalServices>[0]['pi'];
} = {}) {
  const services = createLocalServices({ ...options, directory: options.directory ?? localWorkspaceDirectory() });
  const service = localServiceIdentity(options.native?.requirements);
  const token = randomBytes(32).toString('hex');
  let baseURL = '';
  let stopping = false;
  const requests = new Set<Promise<void>>();
  const server = createServer({ requestTimeout: 30_000, maxHeaderSize: 16_384 }, (incoming, outgoing) => {
    if (stopping) { outgoing.writeHead(503, { connection: 'close' }); outgoing.end(); return; }
    const handle = async () => {
      const abort = new AbortController();
      outgoing.once('close', () => abort.abort());
      try {
        const endpoint = new URL(baseURL);
        const authorization = Buffer.from(incoming.headers.authorization ?? '');
        const expected = Buffer.from(`Bearer ${token}`);
        if (incoming.headers.host !== endpoint.host || incoming.headers.origin !== undefined ||
          authorization.length !== expected.length || !timingSafeEqual(authorization, expected)) {
          throw new AgentsApiError(403, 'Private local workspace authentication required.', 'forbidden');
        }
        const url = new URL(incoming.url ?? '/', endpoint);
        if (url.origin !== endpoint.origin || !url.pathname.startsWith('/v1/')) throw new AgentsApiError(404, 'Route not found.', 'resource_not_found');
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of incoming) {
          size += chunk.length;
          if (size > 1024 * 1024) throw new AgentsApiError(413, 'Local request exceeds 1 MiB.', 'invalid_request');
          chunks.push(Buffer.from(chunk));
        }
        const headers = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) if (typeof value === 'string') headers.set(name, value);
        const method = incoming.method ?? 'GET';
        const request = new Request(url, { method, headers, signal: abort.signal,
          ...(!['GET', 'HEAD'].includes(method) ? { body: Buffer.concat(chunks) } : {}) });
        let response: Response;
        if (url.pathname === '/v1/workspace' && method === 'GET') {
          response = Response.json({ kind: 'local', name: 'This computer', directory: services.directory,
            service,
            max_sessions: services.maxSessions, environment: 'managed_local', model_execution: 'subscription', harness: services.harness, harnesses: ['codex', 'pi'],
            capabilities: ['agents', 'sessions', 'streaming', 'function_tools', 'web_search', 'managed_environments', 'subscription_login'] });
        } else if (url.pathname === '/v1/workspace/health' && method === 'GET') {
          const [subscription, runtime] = await Promise.all([
            services.runtimeReady() ? services.subscription.status().catch(() => ({ error: 'ChatGPT account status is unavailable. Try checking setup again.' }))
              : Promise.resolve({ state: 'waiting_for_runtime' }),
            services.runtimeStatus().catch(() => ({ error: 'Local runtime status is unavailable. Try checking setup again.' })),
          ]);
          response = Response.json({ subscription, runtime });
        } else if (url.pathname === '/v1/workspace/runtime' && method === 'GET') {
          response = Response.json(await services.runtimeStatus());
        } else if (['/v1/workspace/runtime/setup', '/v1/workspace/runtime/rollback'].includes(url.pathname) && method === 'POST') {
          if (!services.runtimeChanges) throw new AgentsApiError(404, 'Native runtime changes are unavailable.', 'resource_not_found');
          const action = url.pathname.endsWith('/setup') ? 'setup' : 'rollback';
          const submission = await services.runtimeChanges.createChange(action, await requestBody(request));
          response = submission.kind === 'accepted' ? Response.json(submission.change, { status: 202 })
            : Response.json({ error: { code: submission.reason, type: 'invalid_request_error', param: 'id',
              message: submission.reason === 'change_active' ? 'A runtime change is already active.' : 'This request ID belongs to a different runtime action.',
              current_change_id: submission.currentChangeId } }, { status: 409 });
        } else if (/^\/v1\/workspace\/runtime\/changes\/[^/]+$/.test(url.pathname) && method === 'GET') {
          if (!services.runtimeChanges) throw new AgentsApiError(404, 'Native runtime changes are unavailable.', 'resource_not_found');
          response = Response.json(await services.runtimeChanges.retrieveChange(url.pathname.split('/').at(-1)!));
        } else if (url.pathname === '/v1/workspace/subscription' && method === 'GET') {
          response = Response.json(await services.subscription.status());
        } else if (url.pathname === '/v1/workspace/subscription/login' && method === 'POST') {
          const input: unknown = chunks.length ? await request.json() : {};
          if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => key !== 'id')
            || ('id' in input && typeof input.id !== 'string')) throw new AgentsApiError(400, 'Supply a sign-in request ID.', 'invalid_request', 'id');
          response = Response.json(await services.subscription.signIn('id' in input ? input.id as string : undefined));
        } else if (/^\/v1\/workspace\/subscription\/login\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(url.pathname) && method === 'DELETE') {
          await services.subscription.cancelSignIn(url.pathname.split('/').at(-1)!);
          response = new Response(null, { status: 204 });
        } else if (url.pathname === '/v1/workspace/transfers/models' && method === 'POST') {
          response = Response.json(await services.transfers.models(await requestBody(request)));
        } else if (url.pathname === '/v1/workspace/transfers' && method === 'GET') {
          response = Response.json(await services.transfers.list(queryParameters(url.searchParams)));
        } else if (url.pathname === '/v1/workspace/transfers' && method === 'POST') {
          response = Response.json(await services.transfers.create(await request.json()), { status: 202 });
        } else if (/^\/v1\/workspace\/transfers\/[a-f0-9-]{36}$/.test(url.pathname) && ['GET', 'POST'].includes(method)) {
          const id = url.pathname.split('/').at(-1)!;
          response = Response.json(method === 'GET' ? await services.transfers.retrieve(id) : await services.transfers.execute(id));
        } else {
          const models = url.pathname === '/v1/models' && url.searchParams.get('runtime') !== 'pi' ? await services.models() : undefined;
          response = await routeAgentsRequest(request, iamApiPrincipal(LOCAL_OWNER), { ...services, models });
        }
        const responseHeaders: Record<string, string> = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
        response.headers.forEach((value, name) => { responseHeaders[name] = value; });
        outgoing.writeHead(response.status, responseHeaders);
        if (response.body) await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), outgoing);
        else outgoing.end();
      } catch (error) {
        if (outgoing.headersSent) { outgoing.destroy(); return; }
        const response = agentsErrorResponse(error);
        outgoing.writeHead(response.status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        outgoing.end(await response.text());
      }
    };
    const pending = handle().catch(() => { outgoing.destroy(); }).finally(() => { requests.delete(pending); });
    requests.add(pending);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.port ?? 0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Local workspace has no address.');
    baseURL = `http://127.0.0.1:${address.port}/v1`;
    const temporary = `${services.connectionPath}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify({ baseURL, token }), { mode: 0o600 });
    await rename(temporary, services.connectionPath);
    services.start();
  } catch (error) { server.close(); await services.close(); throw error; }
  let closed: Promise<void> | undefined;
  return {
    baseURL, token, directory: services.directory,
    close(): Promise<void> {
      closed ??= (async () => {
        stopping = true;
        services.stop();
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
        await Promise.allSettled(requests);
        const failures: unknown[] = [];
        try { await rm(services.connectionPath, { force: true }); } catch (error) { failures.push(error); }
        try { await services.close(); } catch (error) { failures.push(error); }
        if (failures.length) throw new AggregateError(failures, 'Local server shutdown did not complete.');
      })();
      return closed;
    },
  };
}
