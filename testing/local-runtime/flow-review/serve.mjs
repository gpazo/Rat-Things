import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../../../', import.meta.url);
const routes = new Map([
  ['/', ['testing/local-runtime/flow-review/index.html', 'text/html']],
  ['/review.css', ['testing/local-runtime/flow-review/review.css', 'text/css']],
  ['/review.js', ['testing/local-runtime/flow-review/review.js', 'text/javascript']],
  ['/brand.css', ['site/brand.css', 'text/css']],
  ['/mark.svg', ['assets/brand/rat-things-mark-flat.svg', 'image/svg+xml']],
  ['/rat.jpg', ['assets/rat-things-hero.jpg', 'image/jpeg']],
  ...['Regular', 'Medium', 'SemiBold'].map(weight => [`/Inter-${weight}.ttf`, [`desktop/assets/fonts/Inter-${weight}.ttf`, 'font/ttf']]),
]);
const server = createServer(async (request, response) => {
  const route = routes.get(request.url);
  if (!route || request.method !== 'GET') { response.writeHead(404).end(); return; }
  try {
    const body = await readFile(fileURLToPath(new URL(route[0], root)));
    response.writeHead(200, { 'content-type': route[1], 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    response.end(body);
  } catch { response.writeHead(500).end('Preview file unavailable'); }
});
server.listen(Number(process.env.RAT_FLOW_PORT ?? 4318), '127.0.0.1', () => console.log(`Flow review: http://127.0.0.1:${server.address().port}`));
