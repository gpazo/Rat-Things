import { expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalServices } from '../../src/app/local-composition.js';
import { classifyLocalEngine, localEngineEndpoint, localIsolation, planWorkerImageInstall, workerPlatform } from '../../src/domain/local-runtime.js';

const digest = `sha256:${'a'.repeat(64)}`;

it('admits only this computer’s engine endpoint', () => {
  expect(localEngineEndpoint('unix:///Users/me/.colima/default/docker.sock', 'darwin')).toBe(true);
  expect(localEngineEndpoint('npipe:////./pipe/docker_engine', 'win32')).toBe(true);
  expect(localEngineEndpoint('npipe:////remote-host/pipe/docker_engine', 'win32')).toBe(false);
  expect(localEngineEndpoint('npipe:////./pipe/docker_engine', 'darwin')).toBe(false);
  expect(localEngineEndpoint('tcp://127.0.0.1:2375', 'linux')).toBe(false);
  expect(localEngineEndpoint('ssh://builder', 'linux')).toBe(false);
  expect(localEngineEndpoint(undefined, 'darwin')).toBe(false);
  expect(classifyLocalEngine('npipe:////./pipe/docker_engine', 'win32')).toBe('docker-desktop');
  expect(classifyLocalEngine('npipe:////./pipe/podman-machine-default', 'win32')).toBe('podman');
  expect(classifyLocalEngine('unix:///home/me/.docker/desktop/docker.sock', 'linux')).toBe('docker-desktop');
  expect(classifyLocalEngine('unix:///var/run/docker.sock', 'linux')).toBe('native-linux');
});

it('requires a boundary below each worker and keeps unverified platforms in preview', () => {
  const arm = workerPlatform('aarch64');
  expect(arm).toBe('linux/arm64');
  expect(workerPlatform('x86_64')).toBe('linux/amd64');
  expect(workerPlatform('riscv64')).toBeUndefined();
  expect(localIsolation({ platform: 'darwin', engine: 'orbstack', runtimes: [], workerPlatform: arm })).toEqual({ boundary: 'engine_vm', preview: false });
  expect(localIsolation({ platform: 'darwin', engine: 'docker-desktop', runtimes: [], workerPlatform: 'linux/amd64' })).toEqual({ boundary: 'engine_vm', preview: true });
  expect(localIsolation({ platform: 'win32', engine: 'docker-desktop', runtimes: [], workerPlatform: 'linux/amd64' })).toEqual({ boundary: 'engine_vm', preview: true });
  expect(localIsolation({ platform: 'linux', engine: 'native-linux', runtimes: ['runc', 'runsc'], workerPlatform: 'linux/amd64' })).toEqual({ boundary: 'gvisor', runtime: 'runsc', preview: true });
  // A native Linux engine without gVisor would put danger-full-access on the host kernel.
  expect(localIsolation({ platform: 'linux', engine: 'native-linux', runtimes: ['runc'], workerPlatform: 'linux/amd64' })).toMatchObject({ action: expect.stringContaining('gVisor') });
  expect(localIsolation({ platform: 'darwin', engine: 'podman', runtimes: [], workerPlatform: arm })).toHaveProperty('action');
  expect(localIsolation({ platform: 'darwin', engine: 'unknown', runtimes: [], workerPlatform: arm })).toHaveProperty('action');
});

it('installs a digest-pinned published image before falling back to a checkout build', () => {
  const published = { version: 1 as const, images: { 'linux/amd64': `ghcr.io/example/rat-things-worker@${digest}` } };
  expect(planWorkerImageInstall({ platform: 'linux/amd64', manifest: published, checkout: false })).toEqual({ kind: 'pull', reference: published.images['linux/amd64'] });
  expect(planWorkerImageInstall({ platform: 'linux/arm64', manifest: published, checkout: true })).toEqual({ kind: 'build' });
  expect(planWorkerImageInstall({ platform: 'linux/arm64', manifest: published, checkout: false })).toMatchObject({ kind: 'unavailable' });
  expect(planWorkerImageInstall({ platform: 'linux/amd64', manifest: { version: 1, images: {} }, checkout: true })).toMatchObject({ kind: 'unavailable' });
  expect(planWorkerImageInstall({ platform: undefined, manifest: published, checkout: true })).toMatchObject({ kind: 'unavailable' });
  for (const reference of ['ghcr.io/example/worker:latest', `example/worker:1@${digest}`, `worker@${digest}`, `ghcr.io/Example/worker@${digest}`]) {
    expect(() => planWorkerImageInstall({ platform: 'linux/arm64', manifest: { version: 1, images: { 'linux/arm64': reference } }, checkout: true })).toThrow();
  }
});

it('selects a harness before opening the workspace store', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rat-harness-'));
  try { expect(() => createLocalServices({ directory, harness: 'pi' })).toThrow(/pi harness/); }
  finally { await rm(directory, { recursive: true, force: true }); }
});
