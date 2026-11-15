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
    { action: 'click', x: 1.1, y: 0 }, { action: 'type', text: 'ok', actor: 'admin' },
    { action: 'resize', width: 319, height: 844 }, { action: 'resize', width: 390.5, height: 844 },
    { action: 'resize', width: 1280, height: 1441 }, { action: 'resize', width: 390 }]) {
    expect(() => browserCommand({ command_id: 'id', epoch: 'epoch', revision: 1, operation })).toThrow();
  }
  expect(() => browserCommand({ command_id: 'id', operation: { action: 'click', x: 0, y: 0 } })).toThrow();
  expect(() => browserFrame({ image: 'not a real frame' })).toThrow();
});

it('validates bounded browser elements at the worker boundary', () => {
  const frame = { epoch: 'epoch', revision: 1, frame_id: 'a'.repeat(64), width: 390, height: 844, image: 'aW1hZ2U=', url: 'about:blank', title: 'Page', text: 'Heading' };
  const element = { id: 'element_0', text: 'Heading', x: 0, y: 0, width: .5, height: .1 };
  expect(browserFrame({ ...frame, elements: [element] }).elements).toEqual([element]);
  for (const elements of [[{ ...element, x: .9 }], [{ ...element, width: 0 }], [{ ...element, text: 'x'.repeat(501) }], [element, element], Array.from({ length: 257 }, (_, i) => ({ ...element, id: `element_${i}` }))]) {
    expect(() => browserFrame({ ...frame, elements })).toThrow();
  }
  for (const dimensions of [{ width: 319, height: 844 }, { width: 390, height: 1441 }, { width: 390.5, height: 844 }]) {
    expect(() => browserFrame({ ...frame, ...dimensions })).toThrow();
  }
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
  expect(page.elements).toContainEqual(expect.objectContaining({ text: 'Vote', x: 0, y: 0, width: 300 / 1280, height: 200 / 800 }));
  const command = { command_id: 'designer_click', epoch: page.epoch, revision: page.revision, operation: { action: 'click', x: .1, y: .1 } };
  const [designer, engineer] = await Promise.allSettled([browser.execute(command), browser.execute({ ...command, command_id: 'engineer_click' })]);
  expect(designer.status).toBe('fulfilled'); expect(engineer.status).toBe('rejected');
  expect(await browser.execute(command)).toEqual(designer.status === 'fulfilled' ? designer.value : undefined);
  const after = await snapshot(); expect(after.text).toMatch(/Vote\s+1/);
  const captured = await browser.execute({ command_id: 'qa_capture', operation: { action: 'capture', frame_id: page.frame_id } });
  expect(captured.image).toBe(page.image); expect(captured.text).toMatch(/Vote\s+0/);
  expect(captured.elements).toEqual(page.elements);
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

it.skipIf(!process.env.RAT_BROWSER_TEST_BINARY)('navigates Taco Cometa links and resizes the shared viewport with normalized coordinates and immutable captures', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rat-browser-taco-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  await mkdir(join(directory, 'outputs'));
  await writeFile(join(directory, 'outputs/index.html'), '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Taco Cometa</title><style>body{margin:0;font:16px sans-serif}.hero{min-height:800px;padding:40px}nav{position:fixed;top:0;background:white}a{display:inline-block;padding:12px}.content{height:1000px;padding:40px}</style><nav><a href="#visit">Visit</a></nav><main class="hero"><h1>Taco Cometa</h1><a href="#menu">Explore the menu</a></main><section class="content" id="menu"><h2>Menu</h2></section><section class="content" id="visit"><h2>Visit</h2></section>');
  const browser = new SharedBrowserWorker({ binary: process.env.RAT_BROWSER_TEST_BINARY!, directory, network: { access: 'disabled' } });
  cleanups.push(() => browser.close());
  let next = 0;
  const snapshot = () => browser.execute({ command_id: `taco_frame_${++next}`, operation: { action: 'snapshot' } });
  const initial = await snapshot();
  const opened = await browser.execute({ command_id: 'taco_open', epoch: initial.epoch, revision: initial.revision,
    operation: { action: 'navigate', url: 'https://rat-artifacts.invalid/index.html' } });
  let desktop = opened;
  for (let i = 0; i < 20 && !desktop.elements?.some(element => element.text.includes('Explore the menu')); i++) {
    await new Promise(resolve => setTimeout(resolve, 50)); desktop = await snapshot();
  }
  expect(desktop).toMatchObject({ width: 1280, height: 800 });
  const cta = desktop.elements?.find(element => element.text.includes('Explore the menu'));
  expect(cta).toBeDefined();
  const clicked = await browser.execute({ command_id: 'taco_cta', epoch: desktop.epoch, revision: desktop.revision,
    operation: { action: 'click', x: cta!.x + cta!.width / 2, y: cta!.y + cta!.height / 2 } });
  expect(clicked.url).toBe('https://rat-artifacts.invalid/index.html#menu');
  expect(jpegDimensions(clicked.image)).toEqual({ width: 1280, height: 800 });

  const capture = await browser.execute({ command_id: 'taco_capture_before_resize', operation: { action: 'capture', frame_id: clicked.frame_id } });
  const resize = { command_id: 'taco_phone', epoch: clicked.epoch, revision: clicked.revision, operation: { action: 'resize', width: 390, height: 844 } } as const;
  const competing = { command_id: 'stale_taco_click', epoch: clicked.epoch, revision: clicked.revision, operation: { action: 'click', x: .5, y: .5 } } as const;
  const [resized, stale] = await Promise.allSettled([browser.execute(resize), browser.execute(competing)]);
  expect(resized.status).toBe('fulfilled');
  expect(stale).toMatchObject({ status: 'rejected', reason: expect.objectContaining({ message: 'The shared browser changed. Refresh before interacting.' }) });
  if (resized.status !== 'fulfilled') throw resized.reason;
  const phone = resized.value;
  expect(phone).toMatchObject({ width: 390, height: 844 });
  expect(jpegDimensions(phone.image)).toEqual({ width: 390, height: 844 });
  expect(await browser.execute(resize)).toEqual(phone);
  expect(await browser.execute({ command_id: 'taco_capture_after_resize', operation: { action: 'capture', frame_id: capture.frame_id } })).toEqual(capture);
  const visit = phone.elements?.find(element => element.text === 'Visit');
  expect(visit).toBeDefined();
  const phoneClick = await browser.execute({ command_id: 'taco_phone_visit', epoch: phone.epoch, revision: phone.revision,
    operation: { action: 'click', x: visit!.x + visit!.width / 2, y: visit!.y + visit!.height / 2 } });
  expect(phoneClick.url).toBe('https://rat-artifacts.invalid/index.html#visit');
  expect(phoneClick).toMatchObject({ width: 390, height: 844 });
}, 30000);

function jpegDimensions(image: string) {
  const bytes = Buffer.from(image, 'base64');
  for (let offset = 2; offset + 9 < bytes.length;) {
    if (bytes[offset] !== 0xff) return undefined;
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++]!;
    if (marker === 0xd9 || marker === 0xda) return undefined;
    const length = bytes.readUInt16BE(offset);
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      return { height: bytes.readUInt16BE(offset + 3), width: bytes.readUInt16BE(offset + 5) };
    }
    offset += length;
  }
  return undefined;
}

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
  const modelFrame = JSON.parse(result.output?.[0]?.type === 'text' ? result.output[0].text : '{}');
  expect(modelFrame.epoch).toBe(first.epoch);
  expect(modelFrame).not.toHaveProperty('elements');
}, 30000);
