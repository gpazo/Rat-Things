import { afterEach, describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { developmentAssetIdentity, developmentProfile, parseDevelopmentShareArguments } from '../../testing/local-runtime/development-share.js';

const optIn = { RAT_DEVELOPMENT_SHARE_ACCEPTANCE: '1', AWS_E2E_REAL_CODEX: 'true' };
const args = ['--directory', '/private/source', '--assets', '/private/assets', '--model', 'gpt-6-astra'];
const profiles: string[] = [];
afterEach(async () => { for (const profile of profiles.splice(0)) await rm(profile, { recursive: true, force: true }); });
async function profile() {
  const path = await mkdtemp(join(tmpdir(), 'development-share-'));
  await chmod(path, 0o700);
  profiles.push(path);
  return path;
}

describe('development Share inputs', () => {
  it('requires both live operation gates and explicit source, assets, and model', () => {
    expect(parseDevelopmentShareArguments(args, optIn)).toEqual({ directory: '/private/source', assets: '/private/assets', model: 'gpt-6-astra' });
    expect(() => parseDevelopmentShareArguments(args, {})).toThrow('Set RAT_DEVELOPMENT_SHARE_ACCEPTANCE');
    expect(() => parseDevelopmentShareArguments(args, { RAT_DEVELOPMENT_SHARE_ACCEPTANCE: '1' })).toThrow();
    expect(() => parseDevelopmentShareArguments(args, { AWS_E2E_REAL_CODEX: 'true' })).toThrow();
    expect(() => parseDevelopmentShareArguments(args.slice(0, -2), optIn)).toThrow('Supply');
    expect(() => parseDevelopmentShareArguments([...args.slice(0, -1), 'bad model'], optIn)).toThrow('explicit model');
    expect(() => parseDevelopmentShareArguments([...args, '--app', '/Applications/Rat Things.app'], optIn)).toThrow();
  });

  it('allows a private source profile but refuses existing connections and installed storage', async () => {
    const path = await profile();
    expect(await developmentProfile(path)).toBeTruthy();
    await writeFile(join(path, 'connection.json'), '{}');
    await expect(developmentProfile(path)).rejects.toThrow('Stop the source');
    await rm(join(path, 'connection.json'));
    await mkdir(join(path, 'runtime'));
    await expect(developmentProfile(path)).rejects.toThrow('cannot reopen an installed');
    await rm(join(path, 'runtime'), { recursive: true });
    await mkdir(join(path, 'native-workspaces'));
    await expect(developmentProfile(path)).rejects.toThrow('cannot reopen an installed');
  });

  it('rejects nonprivate profiles and dangling installed-marker links', async () => {
    const path = await profile();
    await chmod(path, 0o755);
    await expect(developmentProfile(path)).rejects.toThrow('private source profile');
    await chmod(path, 0o700);
    await symlink(join(path, 'missing-selection'), join(path, 'runtime'));
    await expect(developmentProfile(path)).rejects.toThrow('cannot reopen an installed');
  });

  it('records the development guest identity without claiming signed or current-source provenance', () => {
    const manifest = { prototype: true, initrdSha256: '1'.repeat(64), kernelSha256: '2'.repeat(64), helperSha256: '3'.repeat(64),
      fingerprint: '4'.repeat(64), sourceImage: `sha256:${'5'.repeat(64)}`, packages: ['unreported-package-list'] };
    expect(developmentAssetIdentity(manifest)).toEqual({ provenance: 'development-assets', initrdSha256: manifest.initrdSha256,
      kernelSha256: manifest.kernelSha256, helperSha256: manifest.helperSha256, fingerprint: manifest.fingerprint, sourceImage: manifest.sourceImage });
    expect(() => developmentAssetIdentity({ ...manifest, prototype: false })).toThrow('native-proof');
    expect(() => developmentAssetIdentity({ ...manifest, initrdSha256: 'bad' })).toThrow('incomplete');
  });
});
