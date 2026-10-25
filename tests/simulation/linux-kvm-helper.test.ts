import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

it.runIf(process.platform === 'linux' || process.platform === 'darwin')('enforces Linux helper disk ownership, control authentication and process cleanup', async () => {
  await expect(promisify(execFile)('python3', ['runtime/linux-kvm/test_helper.py'], { timeout: 15_000 })).resolves.toMatchObject({ stdout: '' });
});
