import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NativeLease } from '../../src/core/session-native-store.js';
import { initialSessionRuntime } from '../../src/core/session-runtime-planning.js';
import { AgentsResourceConflictError } from '../../src/domain/agents-api-validation.js';
import type { SessionLaunch } from '../../src/domain/session-execution.js';
import type { RunRequest } from '../../src/domain/contracts.js';
import { resolveRuntime } from '../../src/domain/session-runtime.js';
import { sessionAgent } from '../../src/core/session-planning.js';
import { piCatalog } from '../../src/runner/pi/provider.js';
import type { AgentDriverControl } from '../../src/runner/agent-driver.js';

const fixture = vi.hoisted(() => ({ fork: vi.fn() }));
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, fork: fixture.fork };
});
vi.mock('../../src/runner/agent-planning.js', () => ({ planCodexLaunch: () => ({ identity: { uid: 10001, gid: 10001 } }) }));
vi.mock('../../src/runner/pi-effect-broker.js', () => ({ createPiEffectBroker: async () => ({ tools: [], execute: async () => undefined, close: async () => undefined }) }));

import { executePiWorker } from '../../src/runner/pi-host.js';

class FakeChild extends EventEmitter {
  public connected = true;
  public constructor(private readonly mode: 'operation_failures' | 'early_exit' | 'running_exit') { super(); }

  public send(message: Record<string, unknown>): void {
    if (message.kind !== 'command') return;
    const id = String(message.id);
    const result = () => this.emit('message', { kind: 'result', id, ok: true });
    if (message.method === 'initialize') {
      if (this.mode === 'early_exit') { setImmediate(() => this.exit(null, 'SIGSEGV')); return; }
      if (this.mode === 'operation_failures') {
        setImmediate(() => {
          this.emit('message', { kind: 'request', id: 'secret-load', method: 'load' });
          this.emit('message', { kind: 'request', id: 'secret-projection', method: 'projection', value: { snapshot: initialSessionRuntime('session', 'agent', 'root'), seq: 0 } });
          this.emit('message', { kind: 'request', id: 'token=host-secret', method: 'model context secret' });
          setTimeout(result, 5);
        });
        return;
      }
      setImmediate(result); return;
    }
    if (message.method === 'resume' && this.mode === 'running_exit') { setImmediate(() => this.exit(1, null)); return; }
    setImmediate(() => {
      result();
      if (message.method === 'resume') this.emit('message', { kind: 'finished' });
    });
  }

  public kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    setImmediate(() => this.exit(null, signal));
    return true;
  }

  private exit(code: number | null, signal: NodeJS.Signals | null): void {
    this.connected = false;
    this.emit('exit', code, signal);
  }
}

afterEach(() => vi.restoreAllMocks());

function launch(): SessionLaunch {
  const runtime = resolveRuntime({ rat_things_runtime: 'pi' }, null, piCatalog(['amazon.nova-micro-v1:0'], 'us-east-1'));
  if (runtime.kind !== 'pi') throw new Error('Pi fixture runtime expected');
  return { runtime, sessionId: 'session', turnId: 'turn', agent: sessionAgent({ model: 'amazon.nova-micro-v1:0' }, 'agent', 1), environment: { type: 'none' }, input: [] };
}

async function run(mode: 'operation_failures' | 'early_exit' | 'running_exit') {
  const child = new FakeChild(mode);
  fixture.fork.mockReturnValue(child as never);
  const secretError = new Error('Bearer token=host-secret; prompt=private user input');
  Object.defineProperty(secretError, 'stack', { value: 'host-secret stack and prompt context' });
  Object.defineProperty(secretError, 'cause', { value: new Error('nested credential material') });
  const lease: NativeLease = {
    load: async () => { throw secretError; },
    reserveIds: async () => ({ first: 1, last: 1 }),
    commit: async change => ({ seq: change.seq, commitId: change.commitId, digest: 'a'.repeat(64) }),
    assertActive: async () => {},
  };
  const dependencies = {
    lease, allowedModelIds: ['amazon.nova-micro-v1:0'], token: async () => 'host-secret-token',
    changed: async () => { throw new AgentsResourceConflictError(); },
  };
  const control = { session: launch() } as AgentDriverControl;
  const request = { prompt: 'private prompt text', metadata: {} } as RunRequest;
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const execution = executePiWorker(request, '/tmp', 5000, control, dependencies);
  if (mode === 'operation_failures') await execution;
  else await expect(execution).rejects.toThrow();
  const diagnostics = log.mock.calls.map(([value]) => JSON.parse(String(value)) as Record<string, unknown>);
  return diagnostics;
}

describe('trusted Pi host diagnostics', () => {
  it('records fixed operations and failure classes without serializing errors or child method text', async () => {
    const diagnostics = await run('operation_failures');
    expect(diagnostics).toEqual(expect.arrayContaining([
      { event: 'pi_operation_failed', operation: 'load', phase: 'initialize', failure: 'operation_failed' },
      { event: 'pi_operation_failed', operation: 'projection', phase: 'initialize', failure: 'resource_conflict' },
      { event: 'pi_operation_failed', operation: 'unsupported', phase: 'initialize', failure: 'operation_failed' },
      { event: 'pi_child_exit', phase: 'running', code: null, signal: 'SIGTERM' },
    ]));
    expect(JSON.stringify(diagnostics)).not.toContain('host-secret');
    expect(JSON.stringify(diagnostics)).not.toContain('private prompt');
    expect(JSON.stringify(diagnostics)).not.toContain('model context secret');
  });

  it.each([
    ['before initialization completes', 'early_exit', 'initialize', null, 'SIGSEGV'],
    ['while the child is running', 'running_exit', 'running', 1, null],
  ] as const)('records child exit metadata %s', async (_description, mode, phase, code, signal) => {
    const diagnostics = await run(mode);
    expect(diagnostics).toContainEqual({ event: 'pi_child_exit', phase, code, signal });
  });
});
