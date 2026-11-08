import { CodexRpcClient } from '../adapters/codex-rpc.js';
import { mkdir } from 'node:fs/promises';

const binary = process.env.CODEX_BINARY;
const home = process.env.HOME;
const codexHome = process.env.CODEX_HOME;

if (!binary || !home || !codexHome) throw new Error('Image validation environment is incomplete');
await mkdir(codexHome, { recursive: true, mode: 0o700 });

const client = new CodexRpcClient({
  binary,
  cwd: home,
  environment: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: home, CODEX_HOME: codexHome },
});

try {
  await client.initialize(120_000);
} finally {
  await client.close();
}
