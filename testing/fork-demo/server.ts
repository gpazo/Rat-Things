import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createAgentsClient } from '../../src/agents-client.js';
import { AgentsForkDemoBackend } from './backend.js';
import { ForkDemoController } from './controller.js';

const live = process.argv.includes('--live');
const port = Number(process.env.FORK_DEMO_PORT ?? 4174);
const origin = `http://127.0.0.1:${port}`;
let controller: ForkDemoController | undefined;
if (live) {
  const baseURL = required('RAT_THINGS_AGENTS_API_URL'),
    region = required('AWS_REGION');
  controller = new ForkDemoController(
    new AgentsForkDemoBackend(
      createAgentsClient({ baseURL, region }),
      required('AGENT_MODEL'),
    ),
    resolve(
      process.env.FORK_DEMO_STATE_FILE ?? '.runtime/fork-demo/state.json',
    ),
    `${baseURL}|${region}`,
  );
  await controller.restore();
}
const files: Record<string, [string, string]> = {
  '/fork-demo/': ['site/fork-demo/index.html', 'text/html'],
  '/fork-demo/app.js': ['site/fork-demo/app.js', 'text/javascript'],
  '/fork-demo/themes.js': ['site/fork-demo/themes.js', 'text/javascript'],
  '/fork-demo/styles.css': ['site/fork-demo/styles.css', 'text/css'],
  '/favicon.svg': ['site/favicon.svg', 'image/svg+xml'],
};
const server = createServer(async (request, response) => {
  const json = (status: number, body: unknown) => {
    response.writeHead(status, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    response.end(JSON.stringify(body));
  };
  try {
    if (request.headers.host !== new URL(origin).host) {
      json(403, { error: 'Use the printed loopback URL.' });
      return;
    }
    const path = new URL(request.url ?? '/', origin).pathname;
    if (request.method === 'GET' && path === '/fork-demo/api/state') {
      json(
        controller ? 200 : 404,
        controller?.state ?? { error: 'Live mode is not enabled.' },
      );
      return;
    }
    if (request.method === 'POST' && path === '/fork-demo/api/action') {
      if (
        request.headers.origin !== origin ||
        request.headers['content-type'] !== 'application/json'
      ) {
        json(403, { error: 'Use the local demo page.' });
        return;
      }
      if (!controller) {
        json(400, { error: 'Live mode is not enabled.' });
        return;
      }
      if (controller.state.busy) {
        json(409, { error: 'A demo operation is already running.' });
        return;
      }
      let body = '';
      for await (const chunk of request) {
        body += String(chunk);
        if (body.length > 1024) {
          json(413, { error: 'Request too large.' });
          return;
        }
      }
      const input: unknown = JSON.parse(body);
      if (
        typeof input !== 'object' ||
        input === null ||
        !('action' in input) ||
        typeof input.action !== 'string' ||
        !['start', 'fork', 'choose', 'cleanup'].includes(input.action)
      ) {
        json(400, { error: 'Invalid demo action.' });
        return;
      }
      // Only the controller's recorded resources can be mutated. No caller-provided Session IDs.
      controller.validate(input.action, 'key' in input ? input.key : undefined);
      void controller
        .action(input.action, 'key' in input ? input.key : undefined)
        .catch((error: unknown) =>
          console.error(
            'Demo action stopped:',
            error instanceof Error ? error.message : 'Unknown error',
          ),
        );
      json(202, { accepted: true });
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      json(405, { error: 'Method not allowed.' });
      return;
    }
    if (path === '/') {
      response
        .writeHead(302, { location: `/fork-demo/${live ? '?mode=live' : ''}` })
        .end();
      return;
    }
    if (path === '/docs/session-fork-demo/') {
      response
        .writeHead(302, {
          location:
            'https://gpazo.github.io/Rat-Things/docs/session-fork-demo/',
        })
        .end();
      return;
    }
    const file = files[path];
    if (!file) {
      json(404, { error: 'Not found.' });
      return;
    }
    response.writeHead(200, {
      'content-type': file[1],
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy':
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; frame-src 'self' blob:; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    });
    response.end(
      request.method === 'HEAD' ? undefined : await readFile(file[0]),
    );
  } catch (error) {
    json(400, {
      error: error instanceof Error ? error.message : 'Request failed.',
    });
  }
});
server.listen(port, '127.0.0.1', () =>
  console.log(
    `Fork studio: ${origin}/fork-demo/${live ? '?mode=live' : ''}\n${live ? 'Live mode creates real AWS resources. Use Clean up demo sessions when finished; stopping this server preserves Sessions.' : 'Interactive walkthrough. No AWS calls or cloud resources.'}`,
  ),
);
function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required in --live mode.`);
  return value;
}
