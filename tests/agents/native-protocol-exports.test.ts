import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const native = it.skipIf(process.env.CODEX_REQUIRE_PARITY !== 'true');
const binary = process.env.CODEX_CONFORMANCE_BINARY ?? resolve('node_modules/.bin/codex');
const execute = promisify(execFile);
type Schema = {
  definitions?: Record<string, Schema>;
  properties?: Record<string, Schema>;
  oneOf?: Schema[];
  anyOf?: Schema[];
  enum?: string[];
  required?: string[];
  type?: string;
  items?: Schema;
  $ref?: string;
};

native.each([false, true])('exports the official public protocol with experimental=%s', async experimental => {
  const home = await mkdtemp(join(tmpdir(), 'rat-native-protocol-exports-'));
  const jsonDir = join(home, 'json');
  const tsDir = join(home, 'typescript');
  const flags = experimental ? ['--experimental'] : [];
  try {
    for (const [command, directory] of [['generate-json-schema', jsonDir], ['generate-ts', tsDir]] as const) {
      await execute(binary, ['app-server', command, '--out', directory, ...flags], {
        cwd: home, env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: home },
        timeout: 15_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
      });
    }
    const requests = await schema(join(jsonDir, 'ClientRequest.json'));
    const notifications = await schema(join(jsonDir, 'ServerNotification.json'));
    const flatBundle = await schema(join(jsonDir, 'codex_app_server_protocol.v2.schemas.json'));
    const bundleText = await readFile(join(jsonDir, 'codex_app_server_protocol.schemas.json'), 'utf8');
    const requestTypes = compactTypeScript(await readFile(join(tsDir, 'ClientRequest.ts'), 'utf8'));
    const errorTypes = await readFile(join(tsDir, 'v2/CodexErrorInfo.ts'), 'utf8');
    const checkpointRequests = requests.oneOf?.filter(request => request.properties?.method?.enum?.includes('thread/checkpoint'));

    for (const errorSchema of [notifications.definitions?.CodexErrorInfo, flatBundle.definitions?.CodexErrorInfo]) {
      const errors = errorSchema?.anyOf?.flatMap(variant => variant.enum ?? []);
      expect(errors).toEqual(expect.arrayContaining(['usageLimitExceeded', 'contextWindowExceeded', 'other']));
      for (const privateError of ['requestTimeout', 'creditBalanceExhausted', 'executorVersionIncompatible']) expect(errors).not.toContain(privateError);
    }
    for (const value of ['usageLimitExceeded', 'contextWindowExceeded', 'other']) expect(errorTypes).toContain(`"${value}"`);
    const methods = requests.oneOf?.flatMap(request => request.properties?.method?.enum ?? []);
    expect(methods).toEqual(expect.arrayContaining(['model/list', 'thread/start', 'thread/read', 'thread/resume', 'thread/loaded/list', 'thread/turns/list', 'turn/start', 'turn/interrupt']));
    expect(checkpointRequests).toEqual([]);
    for (const text of [JSON.stringify(requests), JSON.stringify(flatBundle), bundleText, requestTypes]) {
      for (const privateName of ['thread/checkpoint', 'ThreadCheckpointParams', 'ThreadCheckpointResponse']) expect(text).not.toContain(privateName);
    }
    for (const name of ['ThreadCheckpointParams', 'ThreadCheckpointResponse']) {
      await expect(readFile(join(jsonDir, `v2/${name}.json`))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(join(tsDir, `v2/${name}.ts`))).rejects.toMatchObject({ code: 'ENOENT' });
    }
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 45_000);

async function schema(path: string): Promise<Schema> {
  return JSON.parse(await readFile(path, 'utf8')) as Schema;
}

function compactTypeScript(value: string): string {
  return value.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, '');
}
