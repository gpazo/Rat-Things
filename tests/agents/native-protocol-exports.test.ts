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

// The CLI exports embedded bundles rather than reflecting compiled Rust types.
// Check the actual parity artifact so a successful build cannot hide stale bundles.
native.each([false, true])('exports the compiled protocol with experimental=%s', async experimental => {
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
      expect(errors).toEqual(expect.arrayContaining(['requestTimeout', 'creditBalanceExhausted']));
    }
    for (const value of ['requestTimeout', 'creditBalanceExhausted']) expect(errorTypes).toContain(`"${value}"`);

    if (experimental) {
      expect(checkpointRequests).toHaveLength(1);
      expect(checkpointRequests![0]).toMatchObject({ properties: {
        method: { enum: ['thread/checkpoint'] }, params: { $ref: '#/definitions/ThreadCheckpointParams' },
      } });
      expect(requestTypes).toContain('"method":"thread/checkpoint",id:RequestId,params:ThreadCheckpointParams,');
      const params = await schema(join(jsonDir, 'v2/ThreadCheckpointParams.json'));
      const response = await schema(join(jsonDir, 'v2/ThreadCheckpointResponse.json'));
      for (const value of [params, requests.definitions?.ThreadCheckpointParams, flatBundle.definitions?.ThreadCheckpointParams]) {
        expectObjectSchema(value, { threadId: { type: 'string' }, expectedThreadIds: { type: 'array', items: { type: 'string' } } });
      }
      for (const value of [response, flatBundle.definitions?.ThreadCheckpointResponse]) {
        expectObjectSchema(value, { threadId: { type: 'string' }, threadIds: { type: 'array', items: { type: 'string' } }, flushed: { type: 'boolean' } });
      }
      expect(compactTypeScript(await readFile(join(tsDir, 'v2/ThreadCheckpointParams.ts'), 'utf8')))
        .toBe('exporttypeThreadCheckpointParams={threadId:string,expectedThreadIds:Array<string>,};');
      expect(compactTypeScript(await readFile(join(tsDir, 'v2/ThreadCheckpointResponse.ts'), 'utf8')))
        .toBe('exporttypeThreadCheckpointResponse={threadId:string,threadIds:Array<string>,flushed:boolean,};');
    } else {
      expect(checkpointRequests).toEqual([]);
      for (const text of [JSON.stringify(requests), JSON.stringify(flatBundle), bundleText, requestTypes]) {
        for (const privateName of ['thread/checkpoint', 'ThreadCheckpointParams', 'ThreadCheckpointResponse']) expect(text).not.toContain(privateName);
      }
      for (const name of ['ThreadCheckpointParams', 'ThreadCheckpointResponse']) {
        await expect(readFile(join(jsonDir, `v2/${name}.json`))).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(readFile(join(tsDir, `v2/${name}.ts`))).rejects.toMatchObject({ code: 'ENOENT' });
      }
    }
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 45_000);

async function schema(path: string): Promise<Schema> {
  return JSON.parse(await readFile(path, 'utf8')) as Schema;
}

function expectObjectSchema(value: Schema | undefined, properties: Record<string, Schema>): void {
  expect(value?.type).toBe('object');
  expect(value?.properties).toEqual(properties);
  expect(value?.required ? [...value.required].sort() : undefined).toEqual(Object.keys(properties).sort());
}

function compactTypeScript(value: string): string {
  return value.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, '');
}
