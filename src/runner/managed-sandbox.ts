import { randomUUID } from 'node:crypto';
import { chown, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

type Execute = (method: string, params: unknown, timeoutMs?: number) => Promise<unknown>;

// Test the same command path used by tools. An unsupported or ignored permission profile must
// never turn into an unsandboxed executor. Both canaries are disposable, host-owned inputs.
const PROBE = `const fs=require('node:fs');const [allowed,denied,marker]=process.argv.slice(1);
fs.writeFileSync(allowed,marker);
try{fs.writeFileSync(denied,'escaped');process.exit(91);}catch(e){if(!['EACCES','EPERM','EROFS'].includes(e.code))throw e;}
process.stdout.write(marker);`;

export async function verifyManagedSandbox(options: {
  call: Execute; workspace: string; home: string; identity?: { uid: number; gid: number };
}) {
  const marker = randomUUID();
  const directory = await mkdtemp(join(options.workspace, '.rat-sandbox-probe-'));
  const allowed = join(directory, 'allowed');
  const denied = join(options.home, `sandbox-canary-${marker}`);
  try {
    await writeFile(denied, marker, { flag: 'wx', mode: 0o600 });
    if (options.identity) {
      await chown(directory, options.identity.uid, options.identity.gid);
      await chown(denied, options.identity.uid, options.identity.gid);
    }
    const response = await options.call('command/exec', {
      command: [process.execPath, '-e', PROBE, allowed, denied, marker],
      cwd: options.workspace, permissionProfile: 'rat_managed', timeoutMs: 5000, outputBytesCap: 4096,
    }, 6000);
    if (!response || typeof response !== 'object' || !('exitCode' in response) || response.exitCode !== 0
      || !('stdout' in response) || response.stdout !== marker
      || await readFile(allowed, 'utf8') !== marker || await readFile(denied, 'utf8') !== marker) throw new Error();
  } catch {
    throw new Error('Managed sandbox enforcement could not be verified. Refusing to expose execution tools.');
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(denied, { force: true });
  }
}
