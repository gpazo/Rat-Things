import { chmod, chown, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Native command auth rereads a scoped bearer token; AWS credentials stay in the host. */
export async function installBedrockTokenFile(options: {
  token(): Promise<string>; onFailure(): void; gid?: number;
}): Promise<{ path: string; close(): Promise<void> }> {
  // TMPDIR belongs to the guest workspace. Use the image's root-owned sticky
  // /tmp so the guest cannot replace this directory through its parent.
  const directory = await mkdtemp('/tmp/rat-bedrock-auth-');
  const path = join(directory, 'token');
  const rotate = async () => {
    const token = await options.token();
    if (!token.trim() || /[\r\n]/.test(token)) throw new Error('Invalid Bedrock bearer token');
    const temporary = join(directory, 'next');
    await writeFile(temporary, token, { mode: 0o440, flag: 'wx' });
    if (options.gid !== undefined) await chown(temporary, process.getuid!(), options.gid);
    await rename(temporary, path);
  };
  try {
    await rotate();
    if (options.gid !== undefined) await chown(directory, process.getuid!(), options.gid);
    await chmod(directory, 0o750);
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  let pending: Promise<void> | undefined;
  // Mint 15-minute tokens every five minutes, ahead of the native reader's cache.
  const timer = setInterval(() => {
    if (pending) return;
    pending = rotate().catch(() => { clearInterval(timer); options.onFailure(); }).finally(() => { pending = undefined; });
  }, 300_000);
  timer.unref();
  return { path, close: async () => {
    clearInterval(timer);
    await pending;
    await rm(directory, { recursive: true, force: true });
  } };
}
