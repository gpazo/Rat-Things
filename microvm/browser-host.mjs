import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import { dirname, isAbsolute, resolve, sep } from 'node:path';

const VIEWPORT = { width: 1280, height: 720, deviceScaleFactor: 1 };
const NAVIGATION_TIMEOUT_MS = 20_000;
const SNAPSHOT_TEXT_LIMIT = 20_000;
const SNAPSHOT_ELEMENT_LIMIT = 250;
const DNS_CACHE_TTL_MS = 30_000;
const MAX_SCREENSHOT_HEIGHT = 10_000;
const MAX_RECORDING_DURATION_MS = 60_000;
const MAX_RECORDING_FRAMES = 300;
const MAX_RECORDING_BYTES = 64 * 1024 * 1024;

let browser;
let page;
let recording;
let commandQueue = Promise.resolve();
let shuttingDown = false;
const dnsCache = new Map();

process.on('message', (message) => {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'close') {
    void shutdown(0);
    return;
  }
  if (!Number.isInteger(message.id) || !message.command || typeof message.command !== 'object') return;
  commandQueue = commandQueue.then(async () => {
    try {
      const result = await execute(message.command);
      process.send?.({ id: message.id, result });
    } catch (error) {
      process.send?.({ id: message.id, error: safeError(error) });
    }
  });
});

process.once('SIGTERM', () => { void shutdown(0); });
process.once('SIGINT', () => { void shutdown(0); });
process.once('disconnect', () => { void shutdown(0); });

async function execute(command) {
  const activePage = await ensurePage();
  switch (command.type) {
    case 'navigate':
      await assertPublicWebUrl(command.url);
      await activePage.goto(command.url, {
        waitUntil: 'domcontentloaded',
        timeout: NAVIGATION_TIMEOUT_MS,
      });
      return snapshot(activePage, false);
    case 'observe':
      return snapshot(activePage, command.includeScreenshot === true);
    case 'screenshot': {
      const artifact = await captureScreenshot(
        activePage,
        command.path,
        command.fullPage === true,
      );
      return snapshot(activePage, true, { artifact });
    }
    case 'record_start': {
      const activeRecording = await startRecording(activePage, command.path, command.fps);
      return snapshot(activePage, false, {
        recording: recordingMetadata(activeRecording),
      });
    }
    case 'record_stop': {
      const artifact = await finishRecording(activePage, true);
      return snapshot(activePage, false, { artifact });
    }
    case 'click':
      if (command.ref) {
        const element = await referencedElement(activePage, command.ref);
        await element.click();
      } else {
        await activePage.mouse.click(command.x, command.y);
      }
      await settle(activePage);
      return snapshot(activePage, false);
    case 'type': {
      if (command.ref) {
        const element = await referencedElement(activePage, command.ref);
        await element.focus();
        if (command.clear) {
          await element.evaluate((node) => {
            if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) {
              node.value = '';
              node.dispatchEvent(new Event('input', { bubbles: true }));
            }
          });
        }
      }
      await activePage.keyboard.type(command.text, { delay: 5 });
      if (command.submit) await activePage.keyboard.press('Enter');
      await settle(activePage);
      return snapshot(activePage, false);
    }
    case 'press':
      await activePage.keyboard.press(command.key);
      await settle(activePage);
      return snapshot(activePage, false);
    case 'select': {
      const element = await referencedElement(activePage, command.ref);
      await element.select(command.value);
      await settle(activePage);
      return snapshot(activePage, false);
    }
    case 'scroll':
      await activePage.mouse.wheel({ deltaX: command.deltaX, deltaY: command.deltaY });
      await settle(activePage);
      return snapshot(activePage, false);
    case 'wait':
      await delay(command.milliseconds);
      return snapshot(activePage, false);
    case 'back':
      await activePage.goBack({ waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
      return snapshot(activePage, false);
    default:
      throw new Error('browser command is not supported');
  }
}

async function ensurePage() {
  if (page && !page.isClosed()) return page;
  const [{ default: puppeteer }, { default: chromium }] = await Promise.all([
    import('puppeteer-core'),
    import('@sparticuz/chromium-min'),
  ]);
  const profileRoot = process.env.BROWSER_PROFILE_ROOT ?? '/tmp/rat-things-browser-profile';
  await mkdir(profileRoot, { recursive: true, mode: 0o700 });
  await chmod(profileRoot, 0o700);
  const executablePath = await chromium.executablePath(
    process.env.CHROMIUM_PACK_DIR ?? '/opt/chromium-pack',
  );
  const insecureArguments = new Set([
    '--allow-running-insecure-content',
    '--disable-site-isolation-trials',
    '--disable-web-security',
  ]);
  browser = await puppeteer.launch({
    args: chromium.args.filter((argument) => !insecureArguments.has(argument)),
    defaultViewport: VIEWPORT,
    executablePath,
    headless: 'shell',
    userDataDir: profileRoot,
  });
  page = (await browser.pages())[0] ?? await browser.newPage();
  await configurePage(page);
  browser.on('targetcreated', async (target) => {
    try {
      const createdPage = await target.page();
      if (createdPage && createdPage !== page) await createdPage.close();
    } catch {
      // A target can disappear before Puppeteer materializes it.
    }
  });
  return page;
}

async function configurePage(targetPage) {
  targetPage.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
  await targetPage.setViewport(VIEWPORT);
  await targetPage.setBypassServiceWorker(true);
  await targetPage.setRequestInterception(true);
  targetPage.on('request', (request) => {
    void handleRequest(request);
  });
  await targetPage.evaluateOnNewDocument(() => {
    Object.defineProperty(window, 'open', {
      configurable: false,
      value: () => null,
      writable: false,
    });
  });
  const cdp = await targetPage.createCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'deny' });
}

async function handleRequest(request) {
  try {
    if (request.isInterceptResolutionHandled?.()) return;
    const parsed = new URL(request.url());
    if (['data:', 'blob:', 'about:'].includes(parsed.protocol)) {
      await request.continue();
      return;
    }
    await assertPublicWebUrl(parsed.toString());
    await request.continue();
  } catch {
    if (!request.isInterceptResolutionHandled?.()) await request.abort('blockedbyclient');
  }
}

async function assertPublicWebUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('browser URL is invalid');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('browser permits only HTTP and HTTPS public-web URLs');
  }
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (
    !hostname ||
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname === 'metadata.google.internal'
  ) throw new Error('browser access to private network destinations is blocked');

  const cached = dnsCache.get(hostname);
  if (cached && cached.expiresAt > Date.now() && !cached.allowed) {
    throw new Error('browser access to private network destinations is blocked');
  }
  let addresses;
  if (isIP(hostname)) addresses = [hostname];
  else {
    try {
      addresses = (await lookup(hostname, { all: true, verbatim: true })).map(({ address }) => address);
    } catch {
      throw new Error('browser destination could not be resolved');
    }
  }
  const allowed = addresses.length > 0 && addresses.every(isPublicAddress);
  dnsCache.set(hostname, { allowed, expiresAt: Date.now() + DNS_CACHE_TTL_MS });
  if (!allowed) throw new Error('browser access to private network destinations is blocked');
}

export function isPublicAddress(address) {
  if (isIP(address) === 4) {
    const octets = address.split('.').map(Number);
    const [a, b, c] = octets;
    if (a === undefined || b === undefined || c === undefined) return false;
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 192 && b === 88 && c === 99) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (isIP(address) === 6) {
    const normalized = address.toLowerCase();
    if (normalized.startsWith('::ffff:')) {
      return isPublicAddress(normalized.slice('::ffff:'.length));
    }
    return !(
      normalized === '::' ||
      normalized === '::1' ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      /^fe[89ab]/.test(normalized) ||
      normalized.startsWith('ff') ||
      normalized.startsWith('2001:db8:')
    );
  }
  return false;
}

async function referencedElement(targetPage, ref) {
  if (!/^r[1-9][0-9]{0,4}$/.test(ref)) throw new Error('browser element ref is invalid');
  const element = await targetPage.$(`[data-rat-ref="${ref}"]`);
  if (!element) throw new Error('browser element ref is stale; observe the page again');
  return element;
}

async function snapshot(targetPage, includeScreenshot, additions = {}) {
  const state = await targetPage.evaluate(({ textLimit, elementLimit }) => {
    for (const prior of document.querySelectorAll('[data-rat-ref]')) {
      prior.removeAttribute('data-rat-ref');
    }
    const selector = [
      'a[href]',
      'button',
      'input',
      'textarea',
      'select',
      'summary',
      '[role="button"]',
      '[role="link"]',
      '[role="checkbox"]',
      '[role="menuitem"]',
      '[role="option"]',
      '[role="radio"]',
      '[role="switch"]',
      '[tabindex]:not([tabindex="-1"])',
      '[contenteditable="true"]',
    ].join(',');
    const elements = [];
    for (const element of document.querySelectorAll(selector)) {
      if (!(element instanceof HTMLElement)) continue;
      const rectangle = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      if (
        rectangle.width < 1 ||
        rectangle.height < 1 ||
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        Number(style.opacity) === 0
      ) continue;
      const ref = `r${elements.length + 1}`;
      element.setAttribute('data-rat-ref', ref);
      const input = element instanceof HTMLInputElement ? element : undefined;
      const textarea = element instanceof HTMLTextAreaElement ? element : undefined;
      const select = element instanceof HTMLSelectElement ? element : undefined;
      const control = input ?? textarea ?? select;
      const label = (
        element.getAttribute('aria-label') ||
        element.getAttribute('title') ||
        (control?.labels?.[0]?.textContent ?? '') ||
        element.textContent ||
        input?.placeholder ||
        ''
      ).replace(/\s+/g, ' ').trim().slice(0, 300);
      elements.push({
        ref,
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute('role') || undefined,
        type: input?.type || undefined,
        label,
        name: control?.name || undefined,
        ...(control && input?.type !== 'password' && control.value
          ? { value: control.value.slice(0, 300) }
          : {}),
        ...(input && ['checkbox', 'radio'].includes(input.type)
          ? { checked: input.checked }
          : {}),
        ...(select
          ? { selectedText: select.selectedOptions[0]?.textContent?.trim().slice(0, 300) ?? '' }
          : {}),
        disabled: 'disabled' in element && Boolean(element.disabled),
        box: {
          x: Math.round(rectangle.x),
          y: Math.round(rectangle.y),
          width: Math.round(rectangle.width),
          height: Math.round(rectangle.height),
        },
      });
      if (elements.length >= elementLimit) break;
    }
    const visibleText = (document.body?.innerText ?? '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      .slice(0, textLimit);
    return {
      url: location.href,
      title: document.title,
      visibleText,
      elements,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        scrollX: Math.round(window.scrollX),
        scrollY: Math.round(window.scrollY),
      },
    };
  }, { textLimit: SNAPSHOT_TEXT_LIMIT, elementLimit: SNAPSHOT_ELEMENT_LIMIT });
  const result = { text: JSON.stringify({ ...state, ...additions }) };
  if (includeScreenshot) {
    const screenshot = await targetPage.screenshot({
      type: 'jpeg',
      quality: 70,
      fullPage: false,
      encoding: 'base64',
    });
    result.imageDataUrl = `data:image/jpeg;base64,${screenshot}`;
  }
  return result;
}

async function captureScreenshot(targetPage, path, fullPage) {
  validateBrowserArtifactPath(path);
  if (!['.png', '.jpg', '.jpeg'].some((extension) => path.toLowerCase().endsWith(extension))) {
    throw new Error('browser screenshot path must end in .png, .jpg, or .jpeg');
  }
  if (fullPage) {
    const height = await targetPage.evaluate(() => Math.max(
      document.documentElement?.scrollHeight ?? 0,
      document.body?.scrollHeight ?? 0,
      window.innerHeight,
    ));
    if (!Number.isFinite(height) || height > MAX_SCREENSHOT_HEIGHT) {
      throw new Error(`full-page screenshot exceeds ${MAX_SCREENSHOT_HEIGHT} pixels`);
    }
  }
  const mediaType = path.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
  const screenshot = await targetPage.screenshot({
    type: mediaType === 'image/png' ? 'png' : 'jpeg',
    ...(mediaType === 'image/jpeg' ? { quality: 80 } : {}),
    fullPage,
    encoding: 'binary',
  });
  const bytes = Buffer.from(screenshot);
  await writeArtifact(path, bytes);
  return { path, mediaType, bytes: bytes.byteLength };
}

async function startRecording(targetPage, path, fps) {
  if (recording) throw new Error('a browser recording is already active');
  validateBrowserArtifactPath(path);
  if (!path.toLowerCase().endsWith('.webm')) {
    throw new Error('browser recording path must end in .webm');
  }
  if (!Number.isInteger(fps) || fps < 1 || fps > 10) {
    throw new Error('browser recording fps must be an integer from 1 through 10');
  }
  const destination = await artifactDestination(path);
  let handle;
  try {
    handle = await open(destination.temporary, 'wx', 0o600);
    const WebMWriter = await webMWriter();
    const writer = new WebMWriter({
      frameRate: fps,
      quality: 0.6,
      transparent: false,
    });
    const active = {
      path,
      mediaType: 'video/webm',
      fps,
      target: destination.target,
      temporary: destination.temporary,
      handle,
      writer,
      frames: 0,
      skippedFrames: 0,
      startedAt: Date.now(),
      capturePromise: Promise.resolve(),
      timer: undefined,
      limitReached: false,
      stopping: false,
    };
    recording = active;
    await captureRecordingFrame(targetPage, active);
    active.timer = setInterval(() => scheduleRecordingFrame(targetPage, active), 1_000 / fps);
    active.timer.unref?.();
    return active;
  } catch (error) {
    recording = undefined;
    try {
      await handle?.close();
    } catch {
      // Preserve the original recording error.
    }
    await rm(destination.temporary, { force: true });
    throw error;
  }
}

function scheduleRecordingFrame(targetPage, active) {
  if (recording !== active || active.stopping || recordingLimitReached(active)) return;
  active.capturePromise = active.capturePromise.then(async () => {
    if (recording !== active || active.stopping || recordingLimitReached(active)) return;
    try {
      await captureRecordingFrame(targetPage, active);
    } catch {
      // Navigation can briefly invalidate a screenshot. The next interval will
      // retry, and an explicit final frame is captured during record_stop.
      active.skippedFrames += 1;
    }
  });
}

async function captureRecordingFrame(targetPage, active) {
  if (recordingLimitReached(active)) return;
  const screenshot = await targetPage.screenshot({
    type: 'webp',
    quality: 60,
    fullPage: false,
    encoding: 'base64',
  });
  active.writer.addFrame({
    width: VIEWPORT.width,
    height: VIEWPORT.height,
    toDataURL: () => `data:image/webp;base64,${screenshot}`,
  });
  active.frames += 1;
  recordingLimitReached(active);
}

function recordingLimitReached(active) {
  const reached = active.frames >= MAX_RECORDING_FRAMES ||
    active.writer.getWrittenSize() >= MAX_RECORDING_BYTES ||
    Date.now() - active.startedAt >= MAX_RECORDING_DURATION_MS;
  if (reached && !active.limitReached) {
    active.limitReached = true;
    if (active.timer) clearInterval(active.timer);
  }
  return reached;
}

async function finishRecording(targetPage, captureFinalFrame) {
  const active = recording;
  if (!active) throw new Error('no browser recording is active');
  active.stopping = true;
  if (active.timer) clearInterval(active.timer);
  try {
    await active.capturePromise;
    if (captureFinalFrame && !recordingLimitReached(active)) {
      try {
        await captureRecordingFrame(targetPage, active);
      } catch {
        active.skippedFrames += 1;
      }
    }
    // webm-writer's Node fd backend expands Uint8Array views to their whole
    // backing ArrayBuffer before each positional write. That inserts padding
    // into EBML elements and produces a decodable but structurally malformed
    // WebM. Recordings are bounded to 64 MiB, so finalize through its in-memory
    // Blob backend and persist the exact byte range atomically instead.
    const completed = await active.writer.complete();
    if (!completed || typeof completed.arrayBuffer !== 'function') {
      throw new Error('browser recording encoder returned no finalized WebM');
    }
    const bytes = Buffer.from(await completed.arrayBuffer());
    if (bytes.byteLength > MAX_RECORDING_BYTES) {
      throw new Error(`browser recording exceeds ${MAX_RECORDING_BYTES} bytes`);
    }
    await active.handle.writeFile(bytes);
    await active.handle.sync();
    await active.handle.close();
    active.handle = undefined;
    await rename(active.temporary, active.target);
    await chmod(active.target, 0o600);
    const information = await stat(active.target);
    return {
      path: active.path,
      mediaType: active.mediaType,
      bytes: information.size,
      frames: active.frames,
      durationMs: Math.round(active.frames * 1_000 / active.fps),
      fps: active.fps,
      skippedFrames: active.skippedFrames,
      limitReached: active.limitReached,
    };
  } catch (error) {
    try {
      await active.handle?.close();
    } catch {
      // Preserve the original finalization error.
    }
    await rm(active.temporary, { force: true });
    throw error;
  } finally {
    recording = undefined;
  }
}

function recordingMetadata(active) {
  return {
    path: active.path,
    mediaType: active.mediaType,
    fps: active.fps,
    maximumDurationMs: MAX_RECORDING_DURATION_MS,
    maximumFrames: MAX_RECORDING_FRAMES,
    maximumBytes: MAX_RECORDING_BYTES,
  };
}

async function webMWriter() {
  if (globalThis.window === undefined) {
    globalThis.window = {
      atob: (value) => Buffer.from(value, 'base64').toString('binary'),
    };
  }
  const imported = await import('webm-writer');
  return imported.default;
}

async function writeArtifact(path, bytes) {
  const destination = await artifactDestination(path);
  let handle;
  try {
    handle = await open(destination.temporary, 'wx', 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(destination.temporary, destination.target);
    await chmod(destination.target, 0o600);
  } catch (error) {
    try {
      await handle?.close();
    } catch {
      // Preserve the original artifact write error.
    }
    await rm(destination.temporary, { force: true });
    throw error;
  }
}

async function artifactDestination(path) {
  validateBrowserArtifactPath(path);
  const root = process.env.BROWSER_ARTIFACT_ROOT;
  if (!root || !isAbsolute(root) || resolve(root) !== root) {
    throw new Error('browser artifact root is not configured');
  }
  await mkdir(root, { recursive: true, mode: 0o700 });
  const rootInformation = await lstat(root);
  if (!rootInformation.isDirectory() || rootInformation.isSymbolicLink()) {
    throw new Error('browser artifact root must be a regular directory');
  }
  const target = resolve(root, ...path.split('/'));
  if (target === root || !target.startsWith(`${root}${sep}`)) {
    throw new Error('browser artifact path escapes its directory');
  }
  const parent = dirname(target);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const [canonicalRoot, canonicalParent] = await Promise.all([realpath(root), realpath(parent)]);
  if (canonicalParent !== canonicalRoot && !canonicalParent.startsWith(`${canonicalRoot}${sep}`)) {
    throw new Error('browser artifact path crosses a symbolic link');
  }
  return {
    target,
    temporary: `${target}.rat-browser-${randomUUID()}`,
  };
}

export function validateBrowserArtifactPath(path) {
  if (
    typeof path !== 'string' ||
    !path ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path.split('/').some((part) => (
      !part || part === '.' || part === '..' || Buffer.byteLength(part, 'utf8') > 255
    )) ||
    Buffer.byteLength(path, 'utf8') > 512 ||
    /[\0-\x1f\x7f]/.test(path)
  ) throw new Error('browser artifact path is invalid');
}

async function settle(targetPage) {
  await Promise.race([
    targetPage.waitForNetworkIdle({ idleTime: 300, timeout: 2_000 }),
    delay(2_000),
  ]).catch(() => undefined);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function safeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/https?:\/\/\S+/gi, '[url]')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 1_000) || 'browser command failed';
}

async function shutdown(exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (recording) {
    try {
      await finishRecording(page, true);
    } catch {
      // An unfinished temporary recording is deleted by finishRecording.
    }
  }
  try {
    await browser?.close();
  } catch {
    // The browser may already have exited.
  }
  process.exit(exitCode);
}
