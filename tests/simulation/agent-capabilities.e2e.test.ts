import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CredentialBroker } from '../../src/credentials/broker.js';
import type {
  CredentialVault,
  IntegrationCredentialBinding,
  IntegrationCredentialValue,
} from '../../src/credentials/types.js';
import type {
  ConnectionGrant,
  ConnectionSet,
  IntegrationConnection,
  SourceCapabilityBinding,
} from '../../src/domain/capabilities.js';
import type { JsonValue } from '../../src/domain/contracts.js';
import { ConnectionService } from '../../src/plugins/connection-service.js';
import { IntegrationPluginRegistry } from '../../src/plugins/integration-registry.js';
import { IntegrationRuntime } from '../../src/plugins/integration-runtime.js';
import type { IntegrationStore } from '../../src/plugins/integration-types.js';
import { createSlackIntegrationPlugin } from '../../src/plugins/integrations/slack.js';
import type {
  BrowserBackend,
  BrowserBackendResult,
  BrowserCommand,
} from '../../src/runner/browser.js';
import { BrowserToolSession } from '../../src/runner/browser.js';
import { runCodexAppServer } from '../../src/runner/codex-app-server.js';
import { createDynamicToolRequestHandler } from '../../src/runner/dynamic-tools.js';

describe('simulated agent capability loop', () => {
  it('runs App Server through multi-account grants, approvals, secret brokering, and browser tools', async () => {
    const ownerId = 'api:small-business-owner';
    const state = memoryIntegrationState();
    const vault = memoryVault();
    const outbound: Array<{ url: string; authorization: string; body?: string }> = [];
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const headers = new Headers(init?.headers);
      const url = new URL(String(input));
      outbound.push({
        url: String(input),
        authorization: headers.get('authorization') ?? '',
        ...(typeof init?.body === 'string' ? { body: init.body } : {}),
      });
      if (url.pathname === '/api/auth.test') {
        const business = headers.get('authorization')?.includes('business');
        return new Response(JSON.stringify({
          ok: true,
          team: business ? 'Business' : 'Personal',
          user: 'Rat',
          team_id: business ? 'T-BUSINESS' : 'T-PERSONAL',
          user_id: business ? 'U-BUSINESS' : 'U-PERSONAL',
        }), { headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        ok: true,
        endpoint: new URL(String(input)).pathname,
      }), { headers: { 'content-type': 'application/json' } });
    });
    const registry = new IntegrationPluginRegistry([
      createSlackIntegrationPlugin({ fetch: fetcher }),
    ]);
    let sequence = 0;
    const connections = new ConnectionService({
      store: state.store,
      vault: vault.vault,
      registry,
      credentialNamePrefix: 'rat-things/connections',
      ids: { random: () => `sim-${++sequence}` },
      clock: { now: () => new Date('2026-08-20T12:00:00.000Z') },
    });

    const personal = await connections.create({
      ownerId,
      pluginId: 'slack',
      alias: 'slack-personal',
      authScheme: 'oauth2',
      credential: { access_token: 'xoxp-personal-secret' },
      grant: { preset: 'read-only' },
    });
    const business = await connections.create({
      ownerId,
      pluginId: 'slack',
      alias: 'slack-business',
      authScheme: 'oauth2',
      credential: { access_token: 'xoxb-business-secret' },
      grant: {
        preset: 'read-write',
        resourceConstraints: { channel: ['C-SUPPORT'] },
      },
    });
    const connectionSet = await connections.createSet({
      ownerId,
      name: 'shop-operations',
      connections: ['slack-personal', 'slack-business'],
      defaults: { messaging: 'slack-business' },
    });

    expect(JSON.stringify({ personal, business, connectionSet })).not.toContain('secret');
    expect(state.connections).toHaveLength(2);
    expect(state.bindings).toHaveLength(2);

    const integrationApproval = vi.fn().mockResolvedValue(true);
    const integrations = await new IntegrationRuntime({
      registry,
      store: state.store,
      credentials: new CredentialBroker(vault.reader),
    }).prepare({
      ownerId,
      request: { connectionSet: 'shop-operations' },
      approve: integrationApproval,
      maximumIntegrationAccess: 'read-write',
    });
    const postTool = integrations.tools[0]?.tools.find((tool) => tool.name === 'messages_post');
    expect(postTool?.inputSchema).toMatchObject({
      properties: { account: { default: 'slack-business' } },
      required: ['input'],
    });
    const browserBackend = new SimulatedBrowserBackend();
    const browserApproval = vi.fn().mockResolvedValue(true);
    const browser = new BrowserToolSession(browserBackend, browserApproval, true);
    const dynamicTools = [
      ...integrations.tools.map((tool) => ({ ...tool })),
      ...browser.tools,
    ];
    const events: Array<{ method: string; params: Record<string, unknown> }> = [];
    const directory = await mkdtemp(join(tmpdir(), 'rat-agent-loop-'));
    const fakeServer = join(directory, 'simulated-app-server.mjs');
    await writeFile(fakeServer, SIMULATED_APP_SERVER);
    try {
      const execution = await runCodexAppServer({
        binary: process.execPath,
        binaryArguments: [fakeServer],
        workspace: directory,
        environment: process.env,
        timeoutMs: 5_000,
        prompt: 'Search personal Slack, reply from business Slack, then inspect the browser.',
        sandbox: 'danger-full-access',
        persistent: false,
        modelProvider: 'openai',
        networkAccess: true,
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
        dynamicTools,
        onEvent: (event) => { events.push(event); },
        onServerRequest: createDynamicToolRequestHandler({ browser, integrations }),
      });

      expect(execution.fullText).toBe('agent-loop-complete');
      const results = events.find((event) => event.method === 'test/toolResults')?.params.results;
      const toolResults = results as Array<Record<string, unknown>>;
      expect(toolResults).toHaveLength(15);
      expect(toolResults[1]).toEqual(expect.objectContaining({
        success: false,
        contentItems: [expect.objectContaining({ text: expect.stringContaining('not authorized') })],
      }));
      for (const [index, result] of toolResults.entries()) {
        if (index !== 1) expect(result).toEqual(expect.objectContaining({ success: true }));
      }
      expect(integrationApproval).toHaveBeenCalledOnce();
      expect(integrationApproval).toHaveBeenCalledWith(expect.objectContaining({
        connectionAlias: 'slack-business',
        approval: 'always',
        input: { channel: 'C-SUPPORT', text: 'Customer issue resolved.' },
      }));
      expect(browserApproval).toHaveBeenCalledTimes(4);
      expect(browserApproval.mock.calls.map(([request]) => request.tool)).toEqual([
        'type',
        'press',
        'select',
        'click',
      ]);
      expect(browserBackend.commands).toEqual([
        { type: 'navigate', url: 'https://example.com/' },
        { type: 'observe', includeScreenshot: true },
        { type: 'record_start', path: 'browser/navigation.webm', fps: 5 },
        { type: 'type', ref: 'r1', text: 'Rat Things', clear: true, submit: false },
        { type: 'press', key: 'Tab' },
        { type: 'select', ref: 'r2', value: '2' },
        { type: 'click', x: 320, y: 240 },
        { type: 'scroll', deltaX: 0, deltaY: 400 },
        { type: 'wait', milliseconds: 800 },
        { type: 'screenshot', path: 'browser/final.png', fullPage: true },
        { type: 'back' },
        { type: 'record_stop' },
      ]);
      expect(outbound).toEqual([
        expect.objectContaining({
          url: 'https://slack.com/api/auth.test',
          authorization: 'Bearer xoxp-personal-secret',
        }),
        expect.objectContaining({
          url: 'https://slack.com/api/auth.test',
          authorization: 'Bearer xoxb-business-secret',
        }),
        expect.objectContaining({
          url: 'https://slack.com/api/search.messages?query=invoice',
          authorization: 'Bearer xoxp-personal-secret',
        }),
        expect.objectContaining({
          url: 'https://slack.com/api/chat.postMessage',
          authorization: 'Bearer xoxb-business-secret',
          body: JSON.stringify({ channel: 'C-SUPPORT', text: 'Customer issue resolved.' }),
        }),
      ]);
      expect(vault.reads).toHaveLength(2);
      expect(execution.events.toString('utf8')).not.toContain('xoxp-personal-secret');
      expect(execution.events.toString('utf8')).not.toContain('xoxb-business-secret');
    } finally {
      await browser.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

class SimulatedBrowserBackend implements BrowserBackend {
  public readonly commands: BrowserCommand[] = [];

  public async execute(command: BrowserCommand): Promise<BrowserBackendResult> {
    this.commands.push(structuredClone(command));
    return {
      text: JSON.stringify({
        url: 'https://example.com/',
        title: 'Example Domain',
        visibleText: 'Example Domain',
        elements: [{ ref: 'r1', tag: 'a', label: 'More information' }],
      }),
    };
  }

  public async close(): Promise<void> {}
}

function memoryVault(): {
  vault: CredentialVault;
  reader: { get(reference: string): Promise<string> };
  reads: string[];
} {
  const secrets = new Map<string, IntegrationCredentialValue>();
  const reads: string[] = [];
  return {
    reads,
    vault: {
      create: async (name, value) => {
        const reference = `memory-secret:${name}`;
        secrets.set(reference, structuredClone(value));
        return reference;
      },
      replace: async (reference, value) => {
        if (!secrets.has(reference)) throw new Error('secret not found');
        secrets.set(reference, structuredClone(value));
      },
      revoke: async (reference) => { secrets.delete(reference); },
    },
    reader: {
      get: async (reference) => {
        reads.push(reference);
        const value = secrets.get(reference);
        if (!value) throw new Error('secret not found');
        return JSON.stringify(value);
      },
    },
  };
}

function memoryIntegrationState(): {
  store: IntegrationStore;
  connections: IntegrationConnection[];
  grants: ConnectionGrant[];
  bindings: IntegrationCredentialBinding[];
} {
  const connections: IntegrationConnection[] = [];
  const grants: ConnectionGrant[] = [];
  const bindings: IntegrationCredentialBinding[] = [];
  const sets: ConnectionSet[] = [];
  const sourceBindings: SourceCapabilityBinding[] = [];
  const upsert = <T>(items: T[], value: T, matches: (candidate: T) => boolean) => {
    const index = items.findIndex(matches);
    if (index === -1) items.push(structuredClone(value));
    else items[index] = structuredClone(value);
  };
  const store: IntegrationStore = {
    listConnections: async (ownerId) => connections.filter((item) => item.ownerId === ownerId),
    getConnection: async (ownerId, selector) => connections.find((item) => (
      item.ownerId === ownerId && (item.connectionId === selector || item.alias === selector)
    )),
    putConnection: async (value) => {
      upsert(connections, value, (item) => item.connectionId === value.connectionId);
    },
    putConnectionBundle: async (connection, binding, grant) => {
      connections.push(structuredClone(connection));
      bindings.push(structuredClone(binding));
      grants.push(structuredClone(grant));
    },
    putCredentialBinding: async (value) => {
      upsert(bindings, value, (item) => item.connectionId === value.connectionId);
    },
    getCredentialBinding: async (ownerId, connectionId) => bindings.find((item) => (
      item.ownerId === ownerId && item.connectionId === connectionId
    )),
    putGrant: async (value) => {
      upsert(grants, value, (item) => item.connectionId === value.connectionId);
    },
    getGrant: async (ownerId, connectionId) => grants.find((item) => (
      item.ownerId === ownerId && item.connectionId === connectionId
    )),
    putConnectionSet: async (value) => { sets.push(structuredClone(value)); },
    getConnectionSet: async (ownerId, selector) => sets.find((item) => (
      item.ownerId === ownerId && (item.connectionSetId === selector || item.name === selector)
    )),
    listConnectionSets: async (ownerId) => sets.filter((item) => item.ownerId === ownerId),
    putSourceBinding: async (value) => { sourceBindings.push(structuredClone(value)); },
    listSourceBindings: async (ownerId) => sourceBindings.filter((item) => item.ownerId === ownerId),
    matchingSourceBindings: async (sourceKind) => sourceBindings.filter(
      (item) => item.sourceKind === sourceKind,
    ),
  };
  return { store, connections, grants, bindings };
}

const SIMULATED_APP_SERVER = String.raw`
import { createInterface } from 'node:readline';

const input = createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
const calls = [
  {
    namespace: 'slack',
    tool: 'messages_search',
    arguments: { account: 'slack-personal', input: { query: 'invoice' } },
  },
  {
    namespace: 'slack',
    tool: 'messages_post',
    arguments: {
      account: 'slack-personal',
      input: { channel: 'C-SUPPORT', text: 'This must be denied.' },
    },
  },
  {
    namespace: 'slack',
    tool: 'messages_post',
    arguments: {
      input: { channel: 'C-SUPPORT', text: 'Customer issue resolved.' },
    },
  },
  {
    namespace: 'rat_browser',
    tool: 'navigate',
    arguments: { url: 'https://example.com/' },
  },
  {
    namespace: 'rat_browser',
    tool: 'observe',
    arguments: { includeScreenshot: true },
  },
  {
    namespace: 'rat_browser',
    tool: 'record_start',
    arguments: { path: 'browser/navigation.webm' },
  },
  {
    namespace: 'rat_browser',
    tool: 'type',
    arguments: { ref: 'r1', text: 'Rat Things', clear: true, submit: false },
  },
  {
    namespace: 'rat_browser',
    tool: 'press',
    arguments: { key: 'Tab' },
  },
  {
    namespace: 'rat_browser',
    tool: 'select',
    arguments: { ref: 'r2', value: '2' },
  },
  {
    namespace: 'rat_browser',
    tool: 'click',
    arguments: { x: 320, y: 240 },
  },
  {
    namespace: 'rat_browser',
    tool: 'scroll',
    arguments: { deltaY: 400 },
  },
  {
    namespace: 'rat_browser',
    tool: 'wait',
    arguments: { milliseconds: 800 },
  },
  {
    namespace: 'rat_browser',
    tool: 'screenshot',
    arguments: { path: 'browser/final.png', fullPage: true },
  },
  {
    namespace: 'rat_browser',
    tool: 'back',
    arguments: {},
  },
  {
    namespace: 'rat_browser',
    tool: 'record_stop',
    arguments: {},
  },
];
const results = [];
let next = 0;
const requestNext = () => {
  if (next < calls.length) {
    send({ id: 'tool-' + next, method: 'item/tool/call', params: calls[next] });
    return;
  }
  send({ method: 'test/toolResults', params: { results } });
  send({ method: 'item/completed', params: {
    threadId: 'thread-simulation',
    turnId: 'turn-simulation',
    item: { type: 'agentMessage', text: 'agent-loop-complete' },
  } });
  send({ method: 'turn/completed', params: {
    threadId: 'thread-simulation',
    turn: { id: 'turn-simulation', status: 'completed' },
  } });
};

input.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({ id: message.id, result: { userAgent: 'simulated' } });
    return;
  }
  if (message.method === 'thread/start') {
    send({ id: message.id, result: { thread: { id: 'thread-simulation' } } });
    return;
  }
  if (message.method === 'turn/start') {
    send({ id: message.id, result: {
      turn: { id: 'turn-simulation', status: 'inProgress', items: [] },
    } });
    requestNext();
    return;
  }
  if (message.id === 'tool-' + next && (message.result || message.error)) {
    results.push(message.result ?? { error: message.error });
    next += 1;
    requestNext();
  }
});
`;
