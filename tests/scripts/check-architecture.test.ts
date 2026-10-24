import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const execute = promisify(execFile);
const script = fileURLToPath(new URL('../../scripts/check-architecture.mjs', import.meta.url));

async function check(source: string, file = 'src/adapters/fixture.ts') {
  const directory = await mkdtemp(join(tmpdir(), 'rat-architecture-'));
  try {
    await mkdir(dirname(join(directory, file)), { recursive: true });
    await writeFile(join(directory, file), source);
    return await execute(process.execPath, [script], { cwd: directory, timeout: 5000 });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

it.each([
  "import { fixture } from '../../testing/fixture.js';",
  "import type { Fixture } from '../../testing/fixture.js';",
  "import '../../testing/fixture.js';",
  "export { fixture } from '../../testing/fixture.js';",
  "export type { Fixture } from '../../testing/fixture.js';",
  "export * from '../../testing/fixture.js';",
  "const fixture = await import('../../testing/fixture.js');",
  "const fixture = require('../../testing/fixture.js');",
])('rejects a production dependency on testing through %s', async source => {
  await expect(check(source)).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('(testing)') });
});

it('applies the testing boundary to source files outside a named layer', async () => {
  await expect(check("export * from '../testing/fixture.js';", 'src/fixture.ts')).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('(testing)') });
});

it('preserves the existing layer boundary checks', async () => {
  await expect(check("import { fixture } from '../adapters/fixture.js';", 'src/domain/fixture.ts')).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('(adapters)') });
});

it('permits adapter dependencies on core and domain', async () => {
  await expect(check("import { port } from '../core/port.js'; export type { Model } from '../domain/model.js';"))
    .resolves.toMatchObject({ stdout: 'Architecture boundaries are valid.\n', stderr: '' });
});
