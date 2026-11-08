import { CodexRpcClient } from '../adapters/codex-rpc.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { warmImageStorageUtilities } from './image-storage-warmup.js';

const binary = process.env.CODEX_BINARY;
const home = process.env.HOME;
const codexHome = process.env.CODEX_HOME;

if (!binary || !home || !codexHome) throw new Error('Image validation environment is incomplete');
console.info('rat-validation:preparing');
await mkdir(codexHome, { recursive: true, mode: 0o700 });
await writeFile(`${codexHome}/config.toml`, [
  'model = "rat-image-warmup"',
  'model_provider = "rat-image-warmup"',
  '',
  '[model_providers.rat-image-warmup]',
  'name = "Rat image warmup"',
  'base_url = "http://127.0.0.1:9/v1"',
  'wire_api = "responses"',
  'requires_openai_auth = false',
  '',
].join('\n'), { mode: 0o600 });
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
  const started = await client.call('thread/start', {
    cwd: home,
    model: 'rat-image-warmup',
    modelProvider: 'rat-image-warmup',
    approvalPolicy: 'never',
    sandbox: 'read-only',
    ephemeral: true,
    selectedCapabilityRoots: [],
    dynamicTools: [],
    config: {
      'features.shell_tool': false,
      'features.view_image': false,
      web_search: 'disabled',
      'features.default_mode_request_user_input': false,
      'tools.experimental_request_user_input.enabled': false,
      'orchestrator.skills.enabled': false,
      'skills.bundled.enabled': false,
      'features.goals': false,
    },
  }, 30_000);
  if (!isRecord(started) || !isRecord(started.thread) || typeof started.thread.id !== 'string' || !started.thread.id.trim()) {
    throw new Error('Image validation could not start its ephemeral Codex thread');
  }
} finally {
  await client.close();
  console.info('rat-validation:closed');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
