import { spawn } from 'node:child_process';

type StorageUtilityCommand = Readonly<{
  executable: string;
  args: readonly string[];
}>;

type RunCommand = (
  command: StorageUtilityCommand,
  environment: Readonly<{ PATH: string; HOME: string }>,
  timeoutMs: number,
) => Promise<void>;

const STORAGE_UTILITY_COMMANDS = [
  { executable: '/usr/bin/findmnt', args: ['--version'] },
  { executable: '/usr/bin/mount', args: ['--version'] },
  { executable: '/sbin/mount.s3files', args: ['--version'] },
  { executable: '/sbin/mount.nfs4', args: ['-V'] },
  { executable: '/usr/bin/openssl', args: ['version'] },
  { executable: '/sbin/efs-proxy', args: ['--help'] },
] as const satisfies readonly StorageUtilityCommand[];

const STORAGE_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const WARMUP_DEADLINE_MS = 30_000;

export async function warmImageStorageUtilities(
  home: string,
  runCommand: RunCommand = executeCommand,
  now: () => number = () => performance.now(),
): Promise<void> {
  const deadline = now() + WARMUP_DEADLINE_MS;
  const environment = { PATH: STORAGE_PATH, HOME: home };

  for (const command of STORAGE_UTILITY_COMMANDS) {
    const remainingMs = deadline - now();
    if (remainingMs <= 0) throw new Error('Storage utility warmup exceeded its deadline');
    try {
      await runCommand(command, environment, remainingMs);
    } catch {
      throw new Error('Storage utility warmup failed');
    }
  }
}

function executeCommand(
  command: StorageUtilityCommand,
  environment: Readonly<{ PATH: string; HOME: string }>,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command.executable, [...command.args], {
      cwd: '/',
      env: environment,
      shell: false,
      stdio: 'ignore',
    });

    let settled = false;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error('Storage utility warmup timed out'));
    }, timeoutMs);

    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };

    child.once('error', () => finish(new Error('Storage utility warmup could not start')));
    child.once('exit', (code) => {
      if (code === 0) finish();
      else finish(new Error('Storage utility warmup command failed'));
    });
  });
}
