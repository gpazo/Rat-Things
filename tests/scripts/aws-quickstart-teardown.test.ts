import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

const deployment = { startedAt: '2026-10-24T12:00:00.000Z', region: 'us-west-2', environment: 'quickstart' };
const targets = { imageArn: 'arn:aws:lambda:us-west-2:123456789012:microvm-image:quickstart', kmsKeyId: 'quickstart-key' };
const emptyState = { format_version: '1.0' };
const deployedState = {
  format_version: '1.0',
  values: { root_module: { child_modules: [{ child_modules: [{ resources: [
    { mode: 'data', type: 'aws_kms_key', values: { id: 'unrelated-key' } },
    { mode: 'data', type: 'awscc_lambda_microvm_image', values: { image_arn: 'unrelated-image' } },
    { mode: 'managed', type: 'aws_kms_key', values: { key_id: targets.kmsKeyId } },
    { mode: 'managed', type: 'awscc_lambda_microvm_image', values: { image_arn: targets.imageArn } },
  ] }] }] } },
};
const checkpoint = { version: 1, deployment, targets };
const roots: string[] = [];
let bundledCli: string;

beforeAll(async () => {
  const result = await build({
    entryPoints: ['scripts/aws-quickstart.ts'], bundle: true, platform: 'node', format: 'esm',
    packages: 'external', write: false,
    plugins: [{ name: 'quickstart-aws-boundaries', setup(builder) {
      builder.onResolve({ filter: /^@aws-sdk\/client-lambda-microvms$/ }, () => ({ path: 'microvms', namespace: 'fixture' }));
      builder.onResolve({ filter: /^\.\/ensure-worker-runtime\.mjs$/ }, () => ({ path: 'runtime', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path === 'runtime'
        ? 'export async function ensureWorkerRuntime() { return "fixture-runtime"; }'
        : `import { appendFileSync, readFileSync } from 'node:fs';
           import { join } from 'node:path';
           export class ListMicrovmsCommand { constructor(input) { this.input = input; } }
           export class ListManagedMicrovmImageVersionsCommand {}
           export class LambdaMicrovmsClient {
             async send(command) {
               if (!(command instanceof ListMicrovmsCommand)) throw new Error('unexpected AWS SDK call');
               const root = process.env.QUICKSTART_FIXTURE_ROOT;
               appendFileSync(join(root, 'trace.jsonl'), JSON.stringify({ action: 'list-microvms', input: command.input }) + '\\n');
               const control = JSON.parse(readFileSync(join(root, 'control.json'), 'utf8'));
               if (control.microvmFailure) throw new Error('MicroVM verification unavailable');
               return { items: [{ state: control.activeMicrovms ? 'RUNNING' : 'TERMINATED' }] };
             }
             destroy() {}
           }`,
      }));
    } }],
  });
  bundledCli = result.outputFiles[0]!.text;
});

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture(completed = true) {
  const root = await mkdtemp(join(tmpdir(), 'rat-quickstart-teardown-'));
  roots.push(root);
  const local = join(root, '.runtime', 'aws-quickstart');
  const scripts = join(root, 'scripts');
  const bin = join(root, 'bin');
  await Promise.all([mkdir(local, { recursive: true }), mkdir(scripts), mkdir(bin)]);
  await symlink(resolve('node_modules'), join(root, 'node_modules'));
  await writeFile(join(scripts, 'aws-quickstart.mjs'), bundledCli);
  await writeFile(join(root, 'control.json'), '{}');
  await writeFile(join(root, 'trace.jsonl'), '');
  await writeFile(join(local, 'context.json'), JSON.stringify({ version: 1, status: 'setup-started', ...deployment }));
  if (completed) await writeFile(join(local, 'result.json'), JSON.stringify({ version: 4, status: 'ready', ...deployment }));
  await writeFile(join(local, 'terraform.tfstate'), JSON.stringify(deployedState));
  await writeFile(join(local, 'quickstart.tfvars.json'), '{}');
  await writeFile(join(root, 'bootstrap.mjs'), `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { join } from 'node:path';
    const control = JSON.parse(fs.readFileSync(join(process.env.QUICKSTART_FIXTURE_ROOT, 'control.json'), 'utf8'));
    if (control.checkpointWriteFailure) {
      const writeFile = fs.promises.writeFile;
      fs.promises.writeFile = async (path, ...args) => {
        if (String(path).includes('teardown.json')) throw new Error('checkpoint filesystem unavailable');
        return writeFile(path, ...args);
      };
      syncBuiltinESMExports();
    }
    globalThis.fetch = async () => Response.json({ data: [{ id: 'openai.gpt-5.6-terra' }] });
  `);
  const command = `#!${process.execPath}
    import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
    import { basename, join } from 'node:path';
    const root = process.env.QUICKSTART_FIXTURE_ROOT;
    const local = join(root, '.runtime', 'aws-quickstart');
    const args = process.argv.slice(2);
    const name = basename(process.argv[1]);
    const control = JSON.parse(readFileSync(join(root, 'control.json'), 'utf8'));
    const action = name === 'terraform' ? args[1] : name === 'terminate-microvms.mjs' ? 'terminate-microvms' : name;
    const teardownPath = join(local, 'teardown.json');
    const saved = existsSync(teardownPath) ? JSON.parse(readFileSync(teardownPath, 'utf8')) : undefined;
    appendFileSync(join(root, 'trace.jsonl'), JSON.stringify({ action, args, checkpoint: saved }) + '\\n');
    if (args.includes('--version')) { console.log('fixture version'); process.exit(0); }
    if (name === 'terraform') {
      if (action === 'init') process.exit(0);
      if (action === 'show') {
        if (control.showFailure) { console.error('state read unavailable'); process.exit(1); }
        writeFileSync(1, readFileSync(join(local, 'terraform.tfstate'))); process.exit(0);
      }
      if (action === 'destroy') {
        if (control.destroyFailure) { console.error('destroy failed'); process.exit(1); }
        writeFileSync(join(local, 'terraform.tfstate'), JSON.stringify({ format_version: '1.0' })); process.exit(0);
      }
      if (action === 'state' && args[2] === 'list') {
        if (control.remainingState) console.log('aws_s3_bucket.artifacts');
        process.exit(0);
      }
    }
    if (name === 'terminate-microvms.mjs') {
      if (!saved) throw new Error('termination began without durable teardown identifiers');
      process.exit(0);
    }
    if (name === 'aws' && args[0] === 'kms') {
      if (control.kmsFailure) { console.error('KMS verification unavailable'); process.exit(1); }
      console.log(JSON.stringify({ KeyMetadata: { Enabled: control.kmsEnabled ?? false,
        KeyState: control.kmsEnabled ? 'Enabled' : 'PendingDeletion', DeletionDate: '2026-11-01T00:00:00Z' } })); process.exit(0);
    }
    if (name === 'aws' && args[0] === 'sts') {
      console.log(JSON.stringify({ Account: '123456789012', Arn: 'arn:aws:iam::123456789012:user/fixture' })); process.exit(0);
    }
    if (name === 'npm') { console.error('stop before packaging'); process.exit(1); }
    throw new Error('unexpected command ' + name + ' ' + args.join(' '));
  `;
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  for (const name of ['terraform', 'aws', 'git', 'npm']) await writeFile(join(bin, name), command, { mode: 0o755 });
  await writeFile(join(scripts, 'terminate-microvms.mjs'), command);
  return {
    root, local,
    async write(name: string, value: unknown) { await writeFile(join(local, name), JSON.stringify(value)); },
    async control(value: unknown) { await writeFile(join(root, 'control.json'), JSON.stringify(value)); },
    async read(name: string) { return JSON.parse(await readFile(join(local, name), 'utf8')) as Record<string, unknown>; },
    async trace() {
      return (await readFile(join(root, 'trace.jsonl'), 'utf8')).trim().split('\n').filter(Boolean)
        .map(line => JSON.parse(line) as { action: string; args: string[]; checkpoint?: unknown; input?: unknown });
    },
    async run(args = ['destroy', '--yes', '--json']) {
      try {
        const result = await promisify(execFile)(process.execPath, ['--import', join(root, 'bootstrap.mjs'), join(scripts, 'aws-quickstart.mjs'), ...args], {
          cwd: root,
          env: { PATH: bin, QUICKSTART_FIXTURE_ROOT: root, AWS_REGION: 'eu-central-1',
            AWS_ACCESS_KEY_ID: 'fixture', AWS_SECRET_ACCESS_KEY: 'fixture', AWS_EC2_METADATA_DISABLED: 'true' },
        });
        return { code: 0, ...result };
      } catch (error) {
        const failure = error as { code: number; stdout: string; stderr: string };
        return { code: failure.code, stdout: failure.stdout, stderr: failure.stderr };
      }
    },
  };
}

describe('AWS quickstart teardown recovery', () => {
  it('destroys a deployment whose state exceeds the default subprocess capture limit', async () => {
    const f = await fixture();
    const privateValue = `private-state-value-${'x'.repeat(2 * 1024 * 1024)}`;
    await f.write('terraform.tfstate', {
      ...deployedState,
      values: { ...deployedState.values, outputs: { private_value: { sensitive: true, value: privateValue } } },
    });
    const result = await f.run();
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: 'destroyed' });
    expect(await f.read('teardown.json')).toEqual(checkpoint);
    expect(await f.read('terraform.tfstate')).toEqual(emptyState);
    expect(result.stdout + result.stderr + await readFile(join(f.local, 'quickstart.log'), 'utf8'))
      .not.toContain('private-state-value-');
  });

  it('refuses state beyond the capture budget before destructive work', async () => {
    const f = await fixture();
    await f.write('terraform.tfstate', {
      ...deployedState,
      values: { ...deployedState.values, outputs: { private_value: {
        sensitive: true, value: `private-state-value-${'x'.repeat(20 * 1024 * 1024)}`,
      } } },
    });
    const result = await f.run();
    expect(result.code, result.stderr).toBe(1);
    expect(result.stderr).toContain('ENOBUFS');
    expect(await f.read('result.json')).toMatchObject({ status: 'ready' });
    expect((await f.trace()).map(event => event.action)).not.toContain('terminate-microvms');
    expect((await f.trace()).map(event => event.action)).not.toContain('destroy');
    expect(await readdir(f.local)).not.toContain('teardown.json');
    expect(result.stdout + result.stderr + await readFile(join(f.local, 'quickstart.log'), 'utf8'))
      .not.toContain('private-state-value-');
  });

  it.each(['kmsFailure', 'microvmFailure'])('retries with saved targets after destroy empties state and %s interrupts verification', async failure => {
    const f = await fixture();
    await f.control({ [failure]: true });
    const first = await f.run();
    expect(first.code, first.stderr).toBe(1);
    expect(first.stderr).toContain('verification unavailable');
    expect(await f.read('result.json')).toMatchObject({ status: 'ready' });
    expect(await f.read('terraform.tfstate')).toEqual(emptyState);
    expect(await f.read('teardown.json')).toEqual(checkpoint);
    expect((await stat(join(f.local, 'teardown.json'))).mode & 0o777).toBe(0o600);
    await f.control({});
    const retry = await f.run();
    expect(retry.code, retry.stderr).toBe(0);
    expect(JSON.parse(retry.stdout)).toMatchObject({ version: 4, status: 'destroyed', teardown: {
      terraformStateEntries: 0, listedMicrovms: 1, activeMicrovms: 0,
      kmsKey: { enabled: false, state: 'PendingDeletion' },
    } });
    const trace = await f.trace();
    expect(trace.filter(event => event.action === 'show')).toHaveLength(2);
    expect(trace.filter(event => event.action === 'terminate-microvms')).toEqual([
      expect.objectContaining({ args: [deployment.region, targets.imageArn], checkpoint }),
      expect.objectContaining({ args: [deployment.region, targets.imageArn], checkpoint }),
    ]);
    expect(trace.filter(event => event.action === 'destroy').every(event => JSON.stringify(event.checkpoint) === JSON.stringify(checkpoint))).toBe(true);
    expect(trace.filter(event => event.action === 'list-microvms').at(-1)?.input).toEqual({ imageIdentifier: targets.imageArn, maxResults: 50 });
    expect(trace.filter(event => event.action === 'aws').at(-1)?.args).toContain(targets.kmsKeyId);
    const calls = trace.length;
    expect((await f.run()).code).toBe(0);
    expect(await f.trace()).toHaveLength(calls);
  });

  it('recovers an interrupted apply from nested managed resources before outputs exist', async () => {
    const f = await fixture(false);
    const result = await f.run();
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ version: 3, recoveredFrom: 'interrupted-setup', teardown: {
      microvmImageResolved: true, listedMicrovms: 1, activeMicrovms: 0, kmsKey: { state: 'PendingDeletion' },
    } });
    expect(await f.read('teardown.json')).toEqual(checkpoint);
  });

  it('verifies the KMS key when setup stopped before creating an image', async () => {
    const f = await fixture(false);
    await f.write('terraform.tfstate', { values: { root_module: { resources: [
      { mode: 'managed', type: 'aws_kms_key', values: { id: targets.kmsKeyId } },
    ] } } });
    const result = await f.run();
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ teardown: {
      microvmImageResolved: false, activeMicrovms: 0, kmsKey: { state: 'PendingDeletion' },
    } });
    expect(await f.read('teardown.json')).toEqual({ ...checkpoint, targets: { kmsKeyId: targets.kmsKeyId } });
    expect((await f.trace()).map(event => event.action)).not.toContain('terminate-microvms');
  });

  it.each(['activeMicrovms', 'kmsEnabled', 'remainingState'])('does not accept an empty-state retry with %s still present', async failure => {
    const f = await fixture();
    await f.write('teardown.json', checkpoint);
    await f.write('terraform.tfstate', emptyState);
    await f.control({ [failure]: true });
    const result = await f.run();
    expect(result.code, result.stderr).toBe(1);
    expect(await f.read('result.json')).toMatchObject({ status: 'ready' });
  });

  it.each(['startedAt', 'region', 'environment'] as const)('rejects a checkpoint from a different %s before destructive work', async field => {
    const f = await fixture();
    await f.write('teardown.json', { ...checkpoint, deployment: { ...deployment, [field]: 'other' } });
    const result = await f.run();
    expect(result.code, result.stderr).toBe(1);
    expect(result.stderr).toContain('different deployment');
    expect((await f.trace()).map(event => event.action)).not.toContain('terminate-microvms');
    expect((await f.trace()).map(event => event.action)).not.toContain('destroy');
  });

  it.each(['imageArn', 'kmsKeyId'] as const)('rejects conflicting current and saved %s before destructive work', async field => {
    const f = await fixture();
    await f.write('teardown.json', { ...checkpoint, targets: { ...targets, [field]: 'other' } });
    const result = await f.run();
    expect(result.code, result.stderr).toBe(1);
    expect(result.stderr).toContain('conflicting');
    expect((await f.trace()).map(event => event.action)).not.toContain('terminate-microvms');
    expect((await f.trace()).map(event => event.action)).not.toContain('destroy');
  });

  it.each([null, { ...checkpoint, version: 2 }, { ...checkpoint, targets: null }, { ...checkpoint, targets: { imageArn: 42 } }])('rejects a malformed checkpoint %j', async saved => {
    const f = await fixture();
    await f.write('teardown.json', saved);
    const result = await f.run();
    expect(result.code, result.stderr).toBe(1);
    expect((await f.trace()).map(event => event.action)).not.toContain('terminate-microvms');
    expect((await f.trace()).map(event => event.action)).not.toContain('destroy');
  });

  it('refuses malformed JSON checkpoints before running Terraform', async () => {
    const f = await fixture();
    await writeFile(join(f.local, 'teardown.json'), '{');
    expect((await f.run()).code).toBe(1);
    expect(await f.trace()).toEqual([]);
  });

  it('refuses to destroy when it cannot save its checkpoint', async () => {
    const f = await fixture();
    await f.control({ checkpointWriteFailure: true });
    const result = await f.run();
    expect(result.code, result.stderr).toBe(1);
    expect(result.stderr).toContain('checkpoint filesystem unavailable');
    expect((await f.trace()).map(event => event.action)).not.toContain('terminate-microvms');
    expect((await f.trace()).map(event => event.action)).not.toContain('destroy');
    expect((await readdir(f.local)).filter(name => name.startsWith('teardown.json'))).toEqual([]);
  });

  it.each([true, false])('refuses unreadable Terraform state even with saved targets, completed=%s', async completed => {
    const f = await fixture(completed);
    await f.write('teardown.json', checkpoint);
    await f.control({ showFailure: true });
    const result = await f.run();
    expect(result.code, result.stderr).toBe(1);
    expect(result.stderr).toContain('state read unavailable');
    expect((await f.trace()).map(event => event.action)).not.toContain('terminate-microvms');
    expect((await f.trace()).map(event => event.action)).not.toContain('destroy');
  });

  it.each(['{', 'null', '{"values":{"root_module":{"resources":{}}}}'])('refuses invalid Terraform state %s', async state => {
    const f = await fixture(false);
    await writeFile(join(f.local, 'terraform.tfstate'), state);
    expect((await f.run()).code).toBe(1);
    expect((await f.trace()).map(event => event.action)).not.toContain('destroy');
  });

  it.each(['aws_kms_key', 'awscc_lambda_microvm_image'])('refuses ambiguous managed %s targets', async type => {
    const f = await fixture(false);
    await f.write('terraform.tfstate', { values: { root_module: { resources: [
      { mode: 'managed', type, values: { id: 'first' } },
      { mode: 'managed', type, values: { id: 'second' } },
    ] } } });
    const result = await f.run();
    expect(result.code, result.stderr).toBe(1);
    expect(result.stderr).toContain('conflicting');
    expect((await f.trace()).map(event => event.action)).not.toContain('terminate-microvms');
    expect((await f.trace()).map(event => event.action)).not.toContain('destroy');
  });

  it.each(['aws_kms_key', 'awscc_lambda_microvm_image'])('refuses an unidentified managed %s target', async type => {
    const f = await fixture(false);
    await f.write('terraform.tfstate', { values: { root_module: { resources: [{ mode: 'managed', type, values: {} }] } } });
    const result = await f.run();
    expect(result.code, result.stderr).toBe(1);
    expect(result.stderr).toContain('missing its identifier');
    expect((await f.trace()).map(event => event.action)).not.toContain('terminate-microvms');
    expect((await f.trace()).map(event => event.action)).not.toContain('destroy');
  });

  it.each([true, false])('refuses missing state when a checkpoint exists, completed=%s', async completed => {
    const f = await fixture(completed);
    await f.write('teardown.json', checkpoint);
    await rm(join(f.local, 'terraform.tfstate'));
    const result = await f.run();
    expect(result.code, result.stderr).toBe(1);
    expect(result.stderr).toContain('Terraform state is missing');
    expect(await f.trace()).toEqual([]);
  });

  it('still permits context-only recovery when setup stopped before any Terraform state existed', async () => {
    const f = await fixture(false);
    await rm(join(f.local, 'terraform.tfstate'));
    const result = await f.run();
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ version: 3, status: 'destroyed', teardown: { microvmImageResolved: false } });
    expect(await f.trace()).toEqual([]);
  });

  it('requires both targets for a completed setup with no checkpoint', async () => {
    const f = await fixture();
    await f.write('terraform.tfstate', emptyState);
    const result = await f.run();
    expect(result.code, result.stderr).toBe(1);
    expect(result.stderr).toContain('missing its MicroVM image or KMS key');
    expect((await f.trace()).map(event => event.action)).not.toContain('destroy');
  });

  it('clears the prior checkpoint after setup confirmation and before recording a new deployment', async () => {
    const f = await fixture();
    await f.write('result.json', { version: 4, status: 'destroyed', ...deployment });
    await f.write('teardown.json', checkpoint);
    const result = await f.run(['setup', '--yes', '--json', '--microvm-base-image-version', '7', '--region', deployment.region]);
    expect(result.code, result.stderr).toBe(1);
    expect(result.stderr).toContain('stop before packaging');
    expect(await readdir(f.local)).not.toContain('teardown.json');
    expect(await f.read('context.json')).toMatchObject({ status: 'setup-started', region: deployment.region });
    expect((await f.read('context.json')).startedAt).not.toBe(deployment.startedAt);
  });
});
