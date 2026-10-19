import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sessionAgent } from '../../src/core/session-planning.js';
import { resolveRuntime } from '../../src/domain/session-runtime.js';
import type { SessionLaunch } from '../../src/domain/session-execution.js';
import type { RunRequest } from '../../src/domain/contracts.js';
import type { AgentDriverControl } from '../../src/runner/agent-driver.js';
import { piCatalog } from '../../src/runner/pi/provider.js';

const fixture = vi.hoisted(() => ({ fork: vi.fn(), execute: vi.fn(), close: vi.fn() }));
vi.mock('node:child_process', async importOriginal => ({ ...await importOriginal<typeof import('node:child_process')>(), fork: fixture.fork }));
vi.mock('../../src/runner/agent-planning.js', () => ({ planCodexLaunch: () => ({ identity: { uid: 10001, gid: 10001 } }) }));
vi.mock('../../src/runner/pi-effect-broker.js', () => ({ createPiEffectBroker: async () => ({ tools: [], execute: fixture.execute, close: fixture.close }) }));
import { executePiWorker } from '../../src/runner/pi-host.js';

afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

describe('Pi host IPC ordering', () => {
  it('serves storage while token and effect requests wait for sequential replay', async () => {
    const trace: string[] = [];
    const responses: Record<string, unknown>[] = [];
    class Child extends EventEmitter {
      public connected = true;
      public initializeId = '';
      public send(message: Record<string, unknown>): void {
        if (message.kind === 'response') {
          responses.push(message);
          trace.push(`response:${message.id}`);
          if (message.id === 'load') this.emit('message', { kind: 'result', id: this.initializeId, ok: true });
          if (responses.some(response => response.id === 'token') && responses.some(response => response.id === 'effect')) this.emit('message', { kind: 'finished' });
          return;
        }
        trace.push(`command:${message.method}`);
        if (message.method === 'initialize') {
          this.initializeId = String(message.id);
          this.emit('message', { kind: 'request', id: 'token', method: 'token' });
          this.emit('message', { kind: 'request', id: 'effect', method: 'effect', value: { kind: 'managed', name: 'read_file', arguments: { path: 'README.md' }, callId: 'pi_call_3', taskId: 3, conversationId: 1 } });
          this.emit('message', { kind: 'request', id: 'load', method: 'load' });
          return;
        }
        setImmediate(() => this.emit('message', { kind: 'result', id: message.id, ok: true }));
      }
      public kill(): boolean { this.connected = false; setImmediate(() => this.emit('exit', null, 'SIGTERM')); return true; }
    }
    fixture.fork.mockReturnValue(new Child());
    fixture.execute.mockImplementation(async () => { trace.push('broker'); return { output: [], isError: false }; });
    fixture.close.mockImplementation(async () => { trace.push('close'); });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const launch: SessionLaunch = { runtime: resolveRuntime({ rat_things_runtime: 'pi' }, null, piCatalog(['amazon.nova-micro-v1:0'], 'us-east-1')),
      sessionId: 'session', turnId: 'turn', agent: sessionAgent({ model: 'amazon.nova-micro-v1:0' }, 'agent', 1), environment: { type: 'none' }, input: [],
      replay: [{ type: 'cancel', turnId: 'one' }, { type: 'cancel', turnId: 'two' }] };
    await executePiWorker({ metadata: {} } as RunRequest, '/tmp', 5000, { session: launch } as AgentDriverControl, {
      allowedModelIds: ['amazon.nova-micro-v1:0'],
      lease: { assertActive: async () => { trace.push('active'); }, load: async () => { trace.push('load'); return { head: null, highWater: 1, commits: [] }; },
        reserveIds: async () => ({ first: 2, last: 2 }), commit: async change => ({ seq: change.seq, commitId: change.commitId, digest: 'a'.repeat(64) }) },
      token: async () => { trace.push('token'); return 'bearer'; }, changed: async () => {},
    });
    expect(trace.slice(0, 7)).toEqual(['active', 'command:initialize', 'load', 'response:load', 'command:replay', 'command:replay', 'command:resume']);
    expect(trace.filter(event => event === 'active')).toHaveLength(3);
    expect(trace.indexOf('token')).toBeGreaterThan(trace.indexOf('command:resume'));
    expect(trace.indexOf('broker')).toBeGreaterThan(trace.indexOf('command:resume'));
    expect(trace.at(-1)).toBe('close');
    expect(responses.find(response => response.id === 'effect')).toEqual({ kind: 'response', id: 'effect', ok: true, value: { output: [], isError: false } });
  });
});
