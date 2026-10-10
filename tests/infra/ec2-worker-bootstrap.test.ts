import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execute = promisify(execFile);
const image = '123456789012.dkr.ecr.us-west-2.amazonaws.com/worker@sha256:' + 'a'.repeat(64);

describe('EC2 worker bootstrap', () => {
  it('starts a prepared worker from the exact cached ARM64 image without network preparation', async () => {
    const result = await runBootstrap(true);
    expect(result.code).toBe(0);
    expect(result.log).toContain('docker run --pull=never --rm --privileged');
    expect(result.log).not.toMatch(/dnf |aws |docker login|docker pull/);
  });

  it('fails closed when the prepared image is missing or does not match', async () => {
    const missing = await runBootstrap(true, { present: false });
    const wrongArchitecture = await runBootstrap(true, { architecture: 'amd64' });
    const wrongDigest = await runBootstrap(true, { digest: image.replace(/a/g, 'b') });
    expect([missing.code, wrongArchitecture.code, wrongDigest.code]).toEqual([1, 1, 1]);
    expect(missing.log).not.toContain('docker run ');
    expect(wrongArchitecture.log).not.toContain('docker run ');
    expect(wrongDigest.log).not.toContain('docker run ');
  });

  it('keeps the cold bootstrap path when prepared mode is disabled', async () => {
    const result = await runBootstrap(false);
    expect(result.code).toBe(0);
    expect(result.log).toContain('dnf install -y docker iptables');
    expect(result.log).toContain('aws ecr get-login-password --region us-west-2');
    expect(result.log).toContain(`docker pull ${image}`);
    expect(result.log).toContain('docker run --rm --privileged');
  });
});

async function runBootstrap(prepared: boolean, overrides: { present?: boolean; architecture?: string; digest?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'rat-worker-bootstrap-'));
  try {
    const bin = join(root, 'bin');
    const configurationDirectory = join(root, 'configuration');
    const log = join(root, 'commands.log');
    await mkdir(bin);
    await writeStubs(bin);
    const template = await readFile(join(process.cwd(), 'infra/modules/agent-runner/ec2-worker.sh.tftpl'), 'utf8');
    const script = render(template, {
      prepared: String(prepared),
      region: 'us-west-2',
      image,
      registry: '123456789012.dkr.ecr.us-west-2.amazonaws.com',
      log_group: '/rat-things/test/session-worker',
      configuration_directory: configurationDirectory,
      configuration: Buffer.from('{}').toString('base64'),
    }, prepared);
    const scriptPath = join(root, 'bootstrap.sh');
    await writeFile(scriptPath, script, { mode: 0o700 });
    let code = 0;
    try {
      await execute('bash', [scriptPath], { env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        STUB_LOG: log,
        DOCKER_IMAGE_PRESENT: String(overrides.present ?? true),
        DOCKER_ARCHITECTURE: overrides.architecture ?? 'arm64',
        DOCKER_DIGEST: overrides.digest ?? image,
      } });
    } catch (error) {
      code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'number' ? error.code : 1;
    }
    return { code, log: await readFile(log, 'utf8').catch(() => '') };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function render(template: string, values: Record<string, string>, prepared: boolean): string {
  const conditionals = template
    .replace(/%\{ if prepared ~\}([\s\S]*?)%\{ else ~\}([\s\S]*?)%\{ endif ~\}/g, (_match, yes: string, no: string) => prepared ? yes : no)
    .replace(/%\{ if prepared \}([\s\S]*?)%\{ endif \}/g, (_match, body: string) => prepared ? body : '');
  return conditionals.replace(/\$\{([a-z_]+)\}/g, (_match, name: string) => {
    const value = values[name];
    if (value === undefined) throw new Error(`Unknown template variable ${name}`);
    return value;
  });
}

async function writeStubs(bin: string) {
  const dispatch = join(bin, 'dispatch');
  await writeFile(dispatch, `#!/bin/bash
set -euo pipefail
name="$(basename "$0")"
printf '%s %s\\n' "$name" "$*" >> "$STUB_LOG"
case "$name" in
  timeout) shift; exec "$@" ;;
  aws) printf 'token\\n' ;;
  docker)
    if [[ "$1 $2" == "image inspect" && " $* " != *" --format "* ]] && [[ "$DOCKER_IMAGE_PRESENT" != true ]]; then exit 1; fi
    if [[ " $* " == *" --format {{.Architecture}} "* ]]; then printf '%s\\n' "$DOCKER_ARCHITECTURE"; fi
    if [[ " $* " == *" --format {{range .RepoDigests}}{{println .}}{{end}} "* ]]; then printf '%s\\n' "$DOCKER_DIGEST"; fi
    if [[ "$1" == login ]]; then cat >/dev/null; fi
    ;;
esac
`, { mode: 0o700 });
  for (const name of ['timeout', 'aws', 'docker', 'dnf', 'systemctl', 'iptables', 'shutdown']) await symlink(dispatch, join(bin, name));
}
