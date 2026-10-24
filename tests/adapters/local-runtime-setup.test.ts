import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { LocalContainerRuntime } from '../../src/adapters/local-container-runtime.js';
import type { LocalRuntimeStatus } from '../../src/domain/local-runtime.js';
import { localWorkerNames } from '../../src/domain/local-runtime.js';

vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), spawn: vi.fn() }));
afterEach(() => vi.restoreAllMocks());

const missing: LocalRuntimeStatus = { ready: false, engine: 'orbstack', endpoint: 'unix:///fixture.sock', image: 'fixture', install: 'build',
  checks: [{ id: 'engine', ready: true, message: 'Ready' }, { id: 'image', ready: false, message: 'Image missing' }] };

it.each(['ready', 'missing', 'changed'] as const)('rechecks installation and pins the build endpoint: %s', async outcome => {
  const runtime = new LocalContainerRuntime('0123456789abcdef');
  const installed = outcome === 'missing' ? missing : { ...missing, ready: true, endpoint: outcome === 'changed' ? 'unix:///another.sock' : missing.endpoint!, checks: [] };
  const probe = vi.spyOn(runtime, 'status').mockResolvedValueOnce(missing).mockResolvedValueOnce(installed);
  vi.mocked(spawn).mockImplementation(() => {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('exit', 0));
    return child as ReturnType<typeof spawn>;
  });
  const result = runtime.setup();
  if (outcome === 'ready') await expect(result).resolves.toEqual(installed);
  else await expect(result).rejects.toThrow(outcome === 'missing' ? 'Image missing' : 'engine changed');
  expect(probe).toHaveBeenCalledTimes(2);
  const options = vi.mocked(spawn).mock.calls.at(-1)![2]!;
  expect(options).toMatchObject({ shell: false, env: { DOCKER_HOST: missing.endpoint } });
  expect(options.env).not.toHaveProperty('DOCKER_CONTEXT');
});

it('awaits the workspace claim before creating volumes or removing a container', async () => {
  const runtime = new LocalContainerRuntime('0123456789abcdef');
  vi.spyOn(runtime, 'status').mockResolvedValue({ ...missing, ready: true, checks: [] });
  const commands: string[][] = [];
  Reflect.set(runtime, 'command', async (args: string[]) => {
    commands.push(args);
    if (args[0] === 'volume' && args[1] === 'ls') return '';
    throw new Error('Unexpected storage effect');
  });
  const { startRequest, gate } = await import('../simulation/native-runtime-fixtures.js');
  const paused = gate();
  const claim = vi.fn(async () => { await paused.promise; throw new Error('Claim failed'); });
  const starting = runtime.start(startRequest(), claim);
  const failure = expect(starting).rejects.toThrow('Claim failed');
  await vi.waitFor(() => expect(claim).toHaveBeenCalledOnce());
  expect(commands).toEqual([['volume', 'ls', '--format', '{{.Name}}']]);
  paused.release(); await failure;
  expect(commands).toHaveLength(1);
  expect(spawn).not.toHaveBeenCalled();
  await runtime.close();
});

it.each(['stop', 'close', 'snapshot'] as const)('fails %s when inspection cannot confirm shutdown', async operation => {
  const workspaceId = '0123456789abcdef';
  const sessionId = 'sess_fixture';
  const runtime = new LocalContainerRuntime(workspaceId);
  const { name, volume } = localWorkerNames(workspaceId, sessionId);
  Reflect.set(runtime, 'endpoint', 'unix:///fixture.sock');
  const active = Reflect.get(runtime, 'active') as Set<string>;
  active.add(name);
  const command = vi.fn(async (args: string[]) => {
    if (args[0] === 'volume' && args[1] === 'ls') return `${volume}\n${volume}-state`;
    if (args[0] === 'volume' && args[1] === 'inspect') return JSON.stringify([{ Labels: { 'rat-things.workspace': workspaceId } }]);
    if (args[0] === 'container') return name;
    if (args[0] === 'inspect') throw new Error('Engine connection timed out');
    throw new Error('Unexpected storage effect');
  });
  Reflect.set(runtime, 'command', command);
  const result = operation === 'close' ? runtime.close() : runtime[operation](sessionId);
  await expect(result).rejects.toThrow(operation === 'close' ? 'Local workers failed to stop' : 'Engine connection timed out');
  expect(command.mock.calls.some(([args]) => args[0] === 'rm')).toBe(false);
  expect(active.has(name)).toBe(true);
});

it.each(['unavailable', 'malformed', 'absent', 'present'] as const)('requires confirmed container absence or removal: %s', async state => {
  const workspaceId = '0123456789abcdef';
  const sessionId = 'sess_fixture';
  const runtime = new LocalContainerRuntime(workspaceId);
  const { name } = localWorkerNames(workspaceId, sessionId);
  Reflect.set(runtime, 'endpoint', 'unix:///fixture.sock');
  const command = vi.fn(async (args: string[]) => {
    if (args[0] === 'container') {
      if (state === 'unavailable') throw new Error('Engine unavailable');
      return state === 'absent' ? '' : name;
    }
    if (args[0] === 'inspect') return state === 'malformed' ? 'invalid JSON' : JSON.stringify([{ Config: { Labels: { 'rat-things.workspace': workspaceId } } }]);
    if (args[0] === 'rm') return name;
    throw new Error('Unexpected storage effect');
  });
  Reflect.set(runtime, 'command', command);
  if (state === 'unavailable' || state === 'malformed') await expect(runtime.stop(sessionId)).rejects.toThrow();
  else await expect(runtime.stop(sessionId)).resolves.toBeUndefined();
  expect(command.mock.calls.filter(([args]) => args[0] === 'rm')).toEqual(state === 'present' ? [[['rm', '--force', name]]] : []);
});
