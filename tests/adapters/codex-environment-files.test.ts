import { chmod, lstat, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import { codexEnvironmentFiles } from '../../src/adapters/codex-environment-files.js';

it('executes one fixed file-worker batch in an empty private home without provider credentials or a model turn', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rat-file-probe-'));
  const binary = join(directory, 'candidate');
  const evidence = join(directory, 'evidence.json');
  const source = `#!${process.execPath}
const fs = require('node:fs');
const readline = require('node:readline');
const evidence = { arguments: process.argv.slice(2), environment: process.env, homeFiles: fs.readdirSync(process.env.CODEX_HOME), methods: [] };
let marker;
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  evidence.methods.push(request.method);
  fs.writeFileSync(${JSON.stringify(evidence)}, JSON.stringify(evidence));
  if (request.id === undefined) return;
  let result = {};
  if (request.method === 'thread/start') result = { thread: { id: 'thread_probe' } };
  if (request.method === 'mcpServer/tool/call') {
    const operation = request.params.arguments;
    if (operation.operation === 'write') marker = operation.data;
    result = { content: [{ type: 'text', text: JSON.stringify(operation.operation === 'write' ? { path: operation.path, size_bytes: 3 } : { data: marker, size_bytes: 3 }) }] };
  }
  process.stdout.write(JSON.stringify({ id: request.id, result }) + '\\n');
});
`;
  try {
    await writeFile(binary, source); await chmod(binary, 0o700);
    const result = await codexEnvironmentFiles({ binary, temporaryHomeParent: directory,
      environment: { PATH: dirname(process.execPath), OPENAI_API_KEY: 'must-not-pass', CODEX_API_KEY: 'must-not-pass', HOME: '/account/home' },
      registryURL: 'http://127.0.0.1:3211', environmentId: 'env_probe', harnessKey: 'ephemeral-harness', workspace: '/workspace',
      operation: [{ operation: 'write', path: '/workspace/marker', data: 'AAEC' }, { operation: 'read', path: '/workspace/marker', offset: 0, length: 3 }],
    });
    expect(result).toEqual([{ path: '/workspace/marker', size_bytes: 3 }, { data: 'AAEC', size_bytes: 3 }]);
    const observed = JSON.parse(await readFile(evidence, 'utf8'));
    expect(observed.methods).toEqual(['initialize', 'initialized', 'thread/start', 'mcpServer/tool/call', 'mcpServer/tool/call']);
    expect(observed.homeFiles).toEqual([]);
    expect(observed.environment.CODEX_HOME).toMatch(new RegExp(`^${directory}/rat-environment-files-`));
    expect(observed.environment.HOME).toBe(observed.environment.CODEX_HOME);
    expect(observed.environment.OPENAI_API_KEY).toBeUndefined(); expect(observed.environment.CODEX_API_KEY).toBeUndefined();
    expect(observed.arguments).toEqual(['-c', 'features.plugins=false', '-c', 'features.apps=false', '-c', 'features.hooks=false', '-c', 'notify=[]', '-c', 'cli_auth_credentials_store="file"', 'app-server']);
    await expect(lstat(observed.environment.CODEX_HOME)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readdir(directory)).sort()).toEqual(['candidate', 'evidence.json']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
