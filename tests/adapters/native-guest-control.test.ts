import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

it('preserves long setup and bounded failure through the real guest control handler', async () => {
  await expect(promisify(execFile)('python3', ['-B', '-I', '-S', 'tests/fixtures/native-guest-control.py'], { timeout: 15_000 }))
    .resolves.toMatchObject({ stdout: '' });
});
