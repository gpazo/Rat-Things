import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ForkDemoController,
  type DemoBackend,
} from '../../testing/fork-demo/controller.js';
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
async function fixture() {
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
    controller: new ForkDemoController(backend, file, 'deployment-a'),
  };
}
describe('Fork studio live resource ownership', () => {
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
