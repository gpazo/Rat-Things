import { CodexRpcClient } from '../adapters/codex-rpc.js';
import { mkdir } from 'node:fs/promises';
import { warmImageStorageUtilities } from './image-storage-warmup.js';

const binary = process.env.CODEX_BINARY;
const home = process.env.HOME;
const codexHome = process.env.CODEX_HOME;

if (!binary || !home || !codexHome) throw new Error('Image validation environment is incomplete');
console.info('rat-validation:preparing');
await mkdir(codexHome, { recursive: true, mode: 0o700 });
await warmImageStorageUtilities(home);

const client = new CodexRpcClient({
  binary,
  cwd: home,
  environment: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: home, CODEX_HOME: codexHome },
});

try {
  console.info('rat-validation:initializing');
  await client.initialize(120_000);
  console.info('rat-validation:initialized');
} finally {
  await client.close();
  console.info('rat-validation:closed');
}
