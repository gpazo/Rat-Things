import { rm } from 'node:fs/promises';
import { build } from 'esbuild';

const lambdaEntries = {
  control: 'src/lambdas/control.ts',
  'conversation-completion': 'src/lambdas/conversation-completion.ts',
  'conversation-coordinator': 'src/lambdas/conversation-coordinator.ts',
  dispatcher: 'src/lambdas/dispatcher.ts',
  notifier: 'src/lambdas/notifier.ts',
  reconciler: 'src/lambdas/reconciler.ts',
  'state-stream': 'src/lambdas/state-stream.ts',
  'webhook-github': 'src/lambdas/webhook-github.ts',
  'webhook-gitlab': 'src/lambdas/webhook-gitlab.ts',
  'webhook-teams': 'src/lambdas/webhook-teams.ts',
  'webhook-slack': 'src/lambdas/webhook-slack.ts',
};

await rm('dist', { recursive: true, force: true });

await Promise.all([
  ...Object.entries(lambdaEntries).map(([name, entry]) =>
    bundle(entry, `dist/lambdas/${name}/index.mjs`),
  ),
  bundle('src/runner/entry.ts', 'dist/runner.mjs'),
  bundle('src/runner/terminate-microvm.ts', 'dist/terminate-microvm.mjs'),
  bundle('src/cli.ts', 'dist/cli.mjs'),
]);

async function bundle(entry, outfile, options = {}) {
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'esm',
    // Several AWS SDK v3 packages still contain CommonJS modules that load
    // Node built-ins dynamically. ESM bundles do not expose `require` unless
    // we provide it, which otherwise makes every Lambda fail during init.
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
    },
    sourcemap: false,
    legalComments: 'none',
    treeShaking: true,
    logLevel: 'info',
    ...options,
  });
}
