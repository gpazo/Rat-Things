import { CodexRpcClient } from '../adapters/codex-rpc.js';

const binary = process.env.CODEX_BINARY;
const home = process.env.HOME;
const codexHome = process.env.CODEX_HOME;

if (!binary || !home || !codexHome) throw new Error('Image validation environment is incomplete');

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
