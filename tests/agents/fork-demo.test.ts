import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ForkDemoController,
  type DemoBackend,
} from '../../testing/fork-demo/controller.js';
import { allThemes, type Theme } from '../../testing/fork-demo/directions.js';
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
async function fixture(themes?: readonly Theme[]) {
  const dir = await mkdtemp(join(tmpdir(), 'fork-demo-'));
  directories.push(dir);
  const file = join(dir, 'state.json');
  const backend = {
    createAgent: vi.fn(async () => 'agent-demo'),
    createSource: vi.fn(async () => 'source'),
    fork: vi.fn(async (_source: string, theme: string) => `child-${theme}`),
    wait: vi.fn(async () => {}),
    preview: vi.fn(async (id: string) => `<html>${id}</html>`),
    deleteSession: vi.fn(async (_id: string) => {}),
    deleteAgent: vi.fn(async (_id: string) => {}),
  } satisfies DemoBackend;
  return {
    backend,
    file,
    controller: new ForkDemoController(backend, file, 'deployment-a', themes),
  };
}
describe('Fork studio live resource ownership', () => {
  it.each(allThemes)('keeps %s among five forks and deletes every other child', async winner => {
    const { controller, backend, file } = await fixture(allThemes);
    await controller.action('start');
    await controller.action('fork');
    expect(backend.fork.mock.calls).toEqual(allThemes.map(key => ['source', key]));
    await controller.action('choose', winner);
    expect(backend.deleteSession.mock.calls).toEqual(allThemes.filter(key => key !== winner).map(key => [`child-${key}`]));
    expect(controller.state.winner).toBe(winner);
    expect(controller.state.branches.filter(branch => !branch.discarded)).toHaveLength(1);
    // Restoration uses the recorded inventory even if the default configuration has two paths.
    const restored = new ForkDemoController(backend, file, 'deployment-a');
    await restored.restore();
    await restored.action('cleanup');
    expect(backend.deleteSession.mock.calls.map(([id]) => id).sort()).toEqual([...allThemes.map(key => `child-${key}`), 'source'].sort());
    expect(restored.state.phase).toBe('empty');
  });
  it('persists each discarded child when deletion stops partway through five forks', async () => {
    const { controller, backend, file } = await fixture(allThemes);
    await controller.action('start');
    await controller.action('fork');
    backend.deleteSession.mockResolvedValueOnce().mockRejectedValueOnce(new Error('Temporary disconnect'));
    await controller.action('choose', 'index');
    expect(controller.state.phase).toBe('error');
    expect(controller.state.branches.find(branch => branch.key === 'paper')?.discarded).toBe(true);
    expect(controller.state.branches.find(branch => branch.key === 'index')?.html).toContain('index');
    const restored = new ForkDemoController(backend, file, 'deployment-a');
    await restored.restore();
    await restored.action('cleanup');
    expect(backend.deleteSession.mock.calls.filter(([id]) => id === 'child-paper')).toHaveLength(1);
    expect(restored.state.phase).toBe('empty');
  });
  it.each(['paper', 'midnight'])(
    'keeps %s, deletes only its sibling, and restores ownership for cleanup',
    async (winner) => {
      const { controller, backend, file } = await fixture();
      await controller.action('start');
      await controller.action('fork');
      expect(backend.fork.mock.calls).toEqual([
        ['source', 'paper'],
        ['source', 'midnight'],
      ]);
      await controller.action('choose', winner);
      expect(backend.deleteSession.mock.calls).toEqual([
        [`child-${winner === 'paper' ? 'midnight' : 'paper'}`],
      ]);
      expect(controller.state.winner).toBe(winner);
      expect(
        controller.state.branches.find((branch) => branch.key === winner)?.html,
      ).toContain(winner);
      const restored = new ForkDemoController(backend, file, 'deployment-a');
      await restored.restore();
      await restored.action('cleanup');
      expect(
        backend.deleteSession.mock.calls.map((call) => call[0]).sort(),
      ).toEqual(['child-midnight', 'child-paper', 'source']);
      expect(backend.deleteAgent).toHaveBeenCalledWith('agent-demo');
      expect(restored.state.phase).toBe('empty');
    },
  );
  it('fences concurrent starts and rejects arbitrary branch IDs without effects', async () => {
    const { controller, backend } = await fixture();
    let release!: () => void;
    backend.wait.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const first = controller.action('start');
    await expect(controller.action('start')).rejects.toThrow('already running');
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    release();
    await first;
    await expect(
      controller.action('choose', 'another-users-session'),
    ).rejects.toThrow('Choose');
    expect(backend.createAgent).toHaveBeenCalledTimes(1);
    expect(backend.deleteSession).not.toHaveBeenCalled();
  });
  it('rejects a known direction that is not part of the recorded comparison', async () => {
    const { controller, backend } = await fixture();
    await controller.action('start');
    await controller.action('fork');
    await expect(controller.action('choose', 'studio')).rejects.toThrow('Choose');
    expect(backend.deleteSession).not.toHaveBeenCalled();
    expect(controller.state.phase).toBe('comparing');
  });
  it('retains partial creation after failure and retries interrupted cleanup', async () => {
    const { controller, backend, file } = await fixture();
    await controller.action('start');
    backend.fork.mockRejectedValueOnce(new Error('Fork unavailable'));
    await controller.action('fork');
    expect(controller.state.error).toBe('Fork unavailable');
    backend.deleteSession.mockRejectedValueOnce(
      new Error('Temporary disconnect'),
    );
    await controller.action('cleanup');
    expect(controller.state.source?.sessionId).toBe('source');
    const record = JSON.parse(await readFile(file, 'utf8'));
    record.state.busy = true;
    await writeFile(file, JSON.stringify(record));
    const restored = new ForkDemoController(backend, file, 'deployment-a');
    await restored.restore();
    expect(restored.state.error).toContain('server stopped');
    expect(restored.state.busy).toBe(false);
    await restored.action('cleanup');
    expect(restored.state.phase).toBe('empty');
    expect(backend.deleteAgent).toHaveBeenCalledTimes(1);
  });
  it('refuses to restore a resource inventory against another deployment', async () => {
    const { controller, backend, file } = await fixture();
    await controller.action('start');
    await expect(
      new ForkDemoController(backend, file, 'deployment-b').restore(),
    ).rejects.toThrow('another deployment');
    expect(backend.deleteSession).not.toHaveBeenCalled();
  });
});

describe('Fork studio managed startup', () => {
  it('retries an explicitly rejected fork conflict without duplicating the returned child', async () => {
    const { AgentsForkDemoBackend } = await import('../../testing/fork-demo/backend.js');
    const post = vi.fn()
      .mockRejectedValueOnce({ status: 409, code: 'conflict' })
      .mockResolvedValueOnce({ id: 'child-studio' });
    const backend = new AgentsForkDemoBackend({ post } as unknown as import('openai').default, 'model');
    await expect(backend.fork('source', 'studio')).resolves.toBe('child-studio');
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[0]).toEqual(post.mock.calls[1]);
  });
  it('does not retry a fork creation after an ambiguous transport failure', async () => {
    const { AgentsForkDemoBackend } = await import('../../testing/fork-demo/backend.js');
    const post = vi.fn().mockRejectedValue(new Error('Connection lost'));
    const backend = new AgentsForkDemoBackend({ post } as unknown as import('openai').default, 'model');
    await expect(backend.fork('source', 'studio')).rejects.toThrow('Connection lost');
    expect(post).toHaveBeenCalledTimes(1);
  });
  it('waits through the managed environment connection state until its Turn completes', async () => {
    const { AgentsForkDemoBackend } = await import(
      '../../testing/fork-demo/backend.js'
    );
    let requests = 0;
    const api = {
      beta: {
        agents: {
          sessions: {
            retrieve: vi.fn(async () =>
              requests === 0
                ? {
                    status: 'requires_action',
                    error: null,
                    required_actions: [{ type: 'environment_connection' }],
                  }
                : { status: 'idle', error: null, required_actions: [] },
            ),
            turns: {
              list: async function* () {
                if (++requests === 2)
                  yield { subagent_id: null, status: 'completed' };
              },
            },
          },
        },
      },
    };
    const backend = new AgentsForkDemoBackend(
      api as unknown as import('openai').default,
      'model',
    );
    await backend.wait('source');
    expect(requests).toBe(2);
  });
});
