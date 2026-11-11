import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, rename, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SharedBrowserWorker, requestSharedBrowser } from '../../src/runner/shared-browser-worker.js';
import { startSharedBrowser } from '../../src/runner/shared-browser-host.js';
import source from '../../src/runner/shared-browser-worker-source.json' with { type: 'json' };
import { withBrowserEffects } from '../../src/runner/pi-browser-effects.js';
import { browserCommand, browserFrame } from '../../src/domain/shared-browser.js';
import { resetPersistentWorkspace } from '../../src/runner/workspace.js';

it('rejects commands that could smuggle navigation, code execution or stale coordinates', () => {
  for (const operation of [{ action: 'evaluate', code: '1' }, { action: 'navigate', url: 'file:///etc/passwd' },
    { action: 'navigate', url: 'https://name:password@example.com' }, { action: 'click', x: NaN, y: .5 },
    { action: 'click', x: 1.1, y: 0 }, { action: 'type', text: 'ok', actor: 'admin' }]) {
    expect(() => browserCommand({ command_id: 'id', epoch: 'epoch', revision: 1, operation })).toThrow();
  }
  expect(() => browserCommand({ command_id: 'id', operation: { action: 'click', x: 0, y: 0 } })).toThrow();
  expect(() => browserFrame({ image: 'not a real frame' })).toThrow();
});

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

it('clears browser caches during workspace reset while preserving their bind mount directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rat-browser-reset-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const profile = join(directory, '.rat-things', 'browser');
  await mkdir(profile, { recursive: true });
  await writeFile(join(profile, 'cache'), 'old browser state');
  const before = await stat(profile);
  await resetPersistentWorkspace(directory, true);
  expect((await stat(profile)).ino).toBe(before.ino);
  await expect(stat(join(profile, 'cache'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('rejects a broken browser installation before admitting agent work and removes its socket', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rat-browser-missing-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const socketPath = join(directory, 'browser.sock');
  await expect(startSharedBrowser({ directory, socketPath, network: { access: 'disabled', allowed_domains: [] }, codexBinary: 'unused-fixture',
    identity: { uid: process.getuid!(), gid: process.getgid!() },
    environment: { PATH: process.env.PATH, HOME: directory, RAT_BROWSER_BINARY: join(directory, 'chrome-headless-shell') },
    launch: { binary: process.execPath, args: ['--input-type=module', '-e', source] },
  })).rejects.toThrow('ENOENT');
  await expect(stat(socketPath)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('settles an early browser exit without an unhandled pipe error or reusing partial initialization', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rat-browser-exit-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const binary = join(directory, 'chrome-headless-shell');
  await writeFile(binary, '#!/bin/sh\nprintf "browser startup fixture failed\\n" >&2\nexit 23\n', { mode: 0o700 });
  const browser = new SharedBrowserWorker({ binary, directory, network: { access: 'disabled' } });
  cleanups.push(() => browser.close());
  await expect(browser.execute({ command_id: 'first', operation: { action: 'snapshot' } })).rejects.toThrow(/Browser (process exited|command pipe closed)/);
  await expect(browser.execute({ command_id: 'second', operation: { action: 'snapshot' } })).rejects.toThrow('Browser closed');
});

it('allows cold browser initialization to exceed the interactive command deadline', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rat-browser-cold-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const binary = join(directory, 'chrome-headless-shell');
  // A real pipe peer delays target creation, like a cold image paging in Chromium.
  await writeFile(binary, `#!${process.execPath}
const fs = require('node:fs');
let input = '';
fs.createReadStream(null, { fd: 3 }).on('data', chunk => {
  input += chunk.toString(); let end;
  while ((end = input.indexOf('\\0')) >= 0) {
    const request = JSON.parse(input.slice(0, end)); input = input.slice(end + 1);
    const result = request.method === 'Target.createTarget' ? { targetId: 'page' }
      : request.method === 'Target.attachToTarget' ? { sessionId: 'attached' }
      : request.method === 'Runtime.evaluate' ? { result: { value: JSON.stringify({ url: 'about:blank', title: '', text: '' }) } }
      : request.method === 'Page.captureScreenshot' ? { data: 'fixture' } : {};
    setTimeout(() => fs.writeSync(4, JSON.stringify({ id: request.id, result }) + '\\0'), request.method === 'Target.createTarget' ? 11000 : 0);
  }
});
`, { mode: 0o700 });
  const browser = new SharedBrowserWorker({ binary, directory, network: { access: 'disabled' } });
  cleanups.push(() => browser.close());
  const frame = await browser.execute({ command_id: 'cold', operation: { action: 'snapshot' } });
  expect(frame.url).toBe('about:blank');
  expect((await browser.execute({ command_id: 'warm', operation: { action: 'snapshot' } })).epoch).toBe(frame.epoch);
}, 20000);

it.skipIf(!process.env.RAT_BROWSER_TEST_BINARY)('shares one real browser, fences competing clicks, preserves captured pages, and confines generated HTML', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rat-browser-test-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  await mkdir(join(directory, 'outputs'));
  await writeFile(join(directory, 'outputs/index.html'), '<title>Team direction</title><body style="margin:0"><button style="width:300px;height:200px" onclick="document.querySelector(\'p\').textContent=++window.count">Vote</button><p>0</p><script>window.count=0</script></body>');
  await writeFile(join(directory, 'outside.txt'), 'OUTSIDE_OUTPUTS');
  await symlink(join(directory, 'outside.txt'), join(directory, 'outputs/link.txt'));
  const browser = new SharedBrowserWorker({ binary: process.env.RAT_BROWSER_TEST_BINARY!, directory, network: { access: 'disabled' } });
  cleanups.push(() => browser.close());
  let next = 0;
  const snapshot = () => browser.execute({ command_id: `frame_${++next}`, operation: { action: 'snapshot' } });
  const first = await snapshot();
  await browser.execute({ command_id: 'navigate', epoch: first.epoch, revision: first.revision, operation: { action: 'navigate', url: 'https://rat-artifacts.invalid/index.html' } }).catch(error => { throw new Error(`Initial page: ${error.message}`); });
  let page = await snapshot();
  for (let i = 0; i < 20 && !page.text.includes('Vote'); i++) { await new Promise(resolve => setTimeout(resolve, 50)); page = await snapshot(); }
  expect(browserFrame(page).text).toContain('Vote');
  const command = { command_id: 'designer_click', epoch: page.epoch, revision: page.revision, operation: { action: 'click', x: .1, y: .1 } };
  const [designer, engineer] = await Promise.allSettled([browser.execute(command), browser.execute({ ...command, command_id: 'engineer_click' })]);
  expect(designer.status).toBe('fulfilled'); expect(engineer.status).toBe('rejected');
  expect(await browser.execute(command)).toEqual(designer.status === 'fulfilled' ? designer.value : undefined);
  const after = await snapshot(); expect(after.text).toMatch(/Vote\s+1/);
  const captured = await browser.execute({ command_id: 'qa_capture', operation: { action: 'capture', frame_id: page.frame_id } });
  expect(captured.image).toBe(page.image); expect(captured.text).toMatch(/Vote\s+0/);
  await expect(browser.execute({ command_id: 'external', epoch: after.epoch, revision: after.revision, operation: { action: 'navigate', url: 'https://example.com' } })).rejects.toThrow('network policy');
  const current = await snapshot();
  await browser.execute({ command_id: 'symlink', epoch: current.epoch, revision: current.revision, operation: { action: 'navigate', url: 'https://rat-artifacts.invalid/link.txt' } }).catch(error => { throw new Error(`Symlink navigation: ${error.message}`); });
  expect((await snapshot()).text).not.toContain('OUTSIDE_OUTPUTS');
  await rename(join(directory, 'outputs'), join(directory, 'saved-outputs'));
  await symlink(directory, join(directory, 'outputs'));
  const moved = await snapshot();
  await browser.execute({ command_id: 'symlink_root', epoch: moved.epoch, revision: moved.revision, operation: { action: 'navigate', url: 'https://rat-artifacts.invalid/outside.txt' } });
  expect((await snapshot()).text).not.toContain('OUTSIDE_OUTPUTS');
}, 30000);

it.skipIf(!process.env.RAT_BROWSER_TEST_BINARY)('keeps a worker-owned browser across independent clients and Pi tool calls without model inference', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rat-browser-owner-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const socketPath = join(directory, 'browser.sock');
  const owner = await startSharedBrowser({ directory, socketPath, network: { access: 'disabled', allowed_domains: [] }, codexBinary: 'unused-fixture',
    identity: { uid: process.getuid!(), gid: process.getgid!() },
    environment: { PATH: process.env.PATH, HOME: directory, RAT_BROWSER_BINARY: process.env.RAT_BROWSER_TEST_BINARY },
    launch: { binary: process.execPath, args: ['--input-type=module', '-e', source] },
  });
  cleanups.push(() => owner.close());
  const first = await owner.execute({ command_id: 'first', operation: { action: 'snapshot' } });
  const second = await requestSharedBrowser({ command_id: 'second', operation: { action: 'snapshot' } }, socketPath);
  expect(second.epoch).toBe(first.epoch);
  // Each request closes its own connection; the owner continues to serve the same browser.
  const third = await requestSharedBrowser({ command_id: 'third', operation: { action: 'snapshot' } }, socketPath);
  expect(third.epoch).toBe(first.epoch);
  const effects = withBrowserEffects({ tools: [], execute: async () => { throw new Error('Unexpected effect'); }, close: async () => {} }, owner.execute);
  const result = await effects.execute({ kind: 'managed', name: 'rat_things_browser', arguments: { command_id: 'pi', operation: { action: 'snapshot' } }, callId: 'pi_1', taskId: 1, conversationId: 1 }, new AbortController().signal);
  expect(result.isError).toBe(false); expect(result.output).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'image' })]));
  expect(JSON.parse(result.output?.[0]?.type === 'text' ? result.output[0].text : '{}').epoch).toBe(first.epoch);
}, 30000);
