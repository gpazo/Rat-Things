import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

it('refuses teardown before touching credentials, workers or Terraform when an observer is active', () => {
  const root = mkdtempSync(join(tmpdir(), 'rat-observer-teardown-'));
  try {
    const scripts = join(root, 'scripts'), bin = join(root, 'bin'), state = join(root, '.aws-e2e', 'proof');
    for (const path of [scripts, bin, state]) mkdirSync(path, { recursive: true });
    for (const name of ['aws-e2e-common.sh', 'aws-e2e-destroy.sh']) copyFileSync(`scripts/${name}`, join(scripts, name));
    writeFileSync(join(state, 'runtime.env'), 'export AWS_E2E_CALLER_ACCOUNT=123456789012\n');
    writeFileSync(join(state, 'terraform.tfstate'), JSON.stringify({ outputs: { validation_observer: { value: { cluster_arn: 'test-cluster' } } } }));
    writeFileSync(join(bin, 'aws'), `#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FAKE_AWS_LOG"
case "$1 $2" in
  'sts get-caller-identity') echo 123456789012 ;;
  'ecs list-tasks') echo 1 ;;
  *) echo 'Unexpected AWS operation' >&2; exit 91 ;;
esac
`, { mode: 0o700 });
    writeFileSync(join(bin, 'terraform'), '#!/usr/bin/env bash\necho terraform >> "$FAKE_AWS_LOG"\nexit 92\n', { mode: 0o700 });
    const log = join(root, 'calls.log');
    const result = spawnSync('bash', [join(scripts, 'aws-e2e-destroy.sh'), 'proof'], {
      encoding: 'utf8', env: { PATH: `${bin}:${process.env.PATH}`, AWS_REGION: 'us-west-2', FAKE_AWS_LOG: log },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('An AWS validation observer is active');
    expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual([
      'sts get-caller-identity --query Account --output text',
      'ecs list-tasks --region us-west-2 --cluster test-cluster --family rat-things-proof-observer --desired-status RUNNING --query length(taskArns) --output text',
    ]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
