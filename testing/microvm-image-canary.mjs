import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, rm } from 'node:fs/promises';

if (typeof process.getuid === 'function' && process.getuid() !== 10001) {
  throw new Error('browser canary must run as the untrusted agent UID');
}

const artifactRoot = '/tmp/rat-things-browser-artifacts';
await rm(artifactRoot, { recursive: true, force: true });
await mkdir(artifactRoot, { recursive: true, mode: 0o700 });

const child = fork('/opt/agent-runtime/browser-host.mjs', [], {
  execArgv: [],
  stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  env: {
    PATH: process.env.PATH,
    HOME: '/home/agent',
    CHROMIUM_PACK_DIR: '/opt/chromium-pack',
    BROWSER_PROFILE_ROOT: '/tmp/rat-things-browser-e2e',
    BROWSER_ARTIFACT_ROOT: artifactRoot,
  },
});

let nextId = 0;

try {
  const formUrl = process.env.MICROVM_E2E_BROWSER_FIXTURE_URL ??
    'https://www.selenium.dev/selenium/web/web-form.html';
  const navigation = await request({ type: 'navigate', url: formUrl });
  let state = JSON.parse(navigation.text);
  if (
    state.title !== 'Web form' ||
    !state.visibleText.includes('Text input') ||
    state.elements.length < 10
  ) {
    throw new Error('Chromium did not render the interactive public form into an observable state');
  }

  const observation = await request({ type: 'observe', includeScreenshot: true });
  if (
    !observation.imageDataUrl?.startsWith('data:image/jpeg;base64,') ||
    observation.imageDataUrl.length < 1_000
  ) {
    throw new Error('Chromium did not capture a bounded JPEG screenshot');
  }

  await request({
    type: 'record_start',
    path: 'browser/navigation.webm',
    fps: 5,
  });
  const marker = 'rat-things-browser-canary-append';
  state = resultState(await request({
    type: 'type',
    ref: element(state, 'Text input', 'text').ref,
    text: 'rat-things-browser-canary',
    clear: true,
    submit: false,
  }));
  state = resultState(await request({
    type: 'type',
    ref: element(state, 'Text input', 'text').ref,
    text: '-append',
    clear: false,
    submit: false,
  }));
  state = resultState(await request({ type: 'press', key: 'Tab' }));
  state = resultState(await request({
    type: 'select',
    ref: element(state, 'Dropdown (select)').ref,
    value: '2',
  }));
  const selected = element(state, 'Dropdown (select)');
  if (selected.value !== '2' || selected.selectedText !== 'Two') {
    throw new Error('browser select did not expose its selected value and label');
  }
  const checkbox = element(state, 'Default checkbox', 'checkbox');
  state = resultState(await request({
    type: 'click',
    x: checkbox.box.x + checkbox.box.width / 2,
    y: checkbox.box.y + checkbox.box.height / 2,
  }));
  if (element(state, 'Default checkbox', 'checkbox').checked !== true) {
    throw new Error('coordinate click did not expose the updated checkbox state');
  }
  const fullPageScreenshot = await request({
    type: 'screenshot',
    path: 'browser/form-filled.png',
    fullPage: true,
  });
  state = resultState(fullPageScreenshot);
  const submitted = resultState(await request({
    type: 'click',
    ref: element(state, 'Submit').ref,
  }));
  const submittedUrl = new URL(submitted.url);
  if (
    submitted.title !== 'Web form - target page' ||
    !submitted.visibleText.includes('Received!') ||
    submittedUrl.searchParams.get('my-text') !== marker ||
    submittedUrl.searchParams.get('my-select') !== '2' ||
    submittedUrl.searchParams.getAll('my-check').length !== 2
  ) throw new Error('browser form interactions did not reach the expected submitted state');
  await request({ type: 'wait', milliseconds: 800 });
  const screenshot = await request({
    type: 'screenshot',
    path: 'browser/final.jpg',
    fullPage: false,
  });
  state = resultState(await request({ type: 'back' }));
  if (state.title !== 'Web form') throw new Error('browser back did not restore the form');
  const resubmitted = resultState(await request({
    type: 'type',
    ref: element(state, 'Text input', 'text').ref,
    text: 'rat-things-submit-with-enter',
    clear: true,
    submit: true,
  }));
  if (
    resubmitted.title !== 'Web form - target page' ||
    new URL(resubmitted.url).searchParams.get('my-text') !== 'rat-things-submit-with-enter'
  ) throw new Error('browser type-and-submit did not submit the form');
  state = resultState(await request({
    type: 'navigate',
    url: 'https://www.selenium.dev/selenium/web/longContentPage.html',
  }));
  state = resultState(await request({ type: 'scroll', deltaX: 0, deltaY: 600 }));
  if (state.viewport.scrollY <= 0) throw new Error('browser scroll did not move the long page viewport');
  state = resultState(await request({ type: 'wait', milliseconds: 800 }));
  state = resultState(await request({ type: 'back' }));
  if (state.title !== 'Web form - target page') {
    throw new Error('browser back did not return from the long page to the submitted form');
  }
  const recording = await request({ type: 'record_stop' });
  const fullPageArtifact = resultState(fullPageScreenshot).artifact;
  const screenshotArtifact = JSON.parse(screenshot.text).artifact;
  const recordingArtifact = JSON.parse(recording.text).artifact;
  const [fullPageBytes, screenshotBytes, recordingBytes] = await Promise.all([
    readFile(`${artifactRoot}/browser/form-filled.png`),
    readFile(`${artifactRoot}/browser/final.jpg`),
    readFile(`${artifactRoot}/browser/navigation.webm`),
  ]);
  if (
    fullPageArtifact?.mediaType !== 'image/png' ||
    fullPageArtifact.bytes !== fullPageBytes.byteLength ||
    !fullPageBytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) throw new Error('saved full-page browser screenshot is not a catalogable PNG');
  if (
    screenshotArtifact?.mediaType !== 'image/jpeg' ||
    screenshotArtifact.bytes !== screenshotBytes.byteLength ||
    screenshotBytes[0] !== 0xff ||
    screenshotBytes[1] !== 0xd8 ||
    screenshotBytes[2] !== 0xff
  ) throw new Error('saved browser screenshot is not a catalogable JPEG');
  if (
    recordingArtifact?.mediaType !== 'video/webm' ||
    recordingArtifact.bytes !== recordingBytes.byteLength ||
    recordingArtifact.frames < 3 ||
    recordingBytes.byteLength < 1_000 ||
    !recordingBytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) ||
    !recordingBytes.includes(Buffer.from('V_VP8'))
  ) throw new Error('saved browser recording is not a finalized VP8 WebM');

  let privateBlocked = false;
  try {
    await request({ type: 'navigate', url: 'http://127.0.0.1:8080/' });
  } catch (error) {
    privateBlocked = error instanceof Error &&
      error.message.includes('private network destinations is blocked');
  }
  if (!privateBlocked) throw new Error('browser private-address protection did not reject loopback');

  process.stdout.write(`${JSON.stringify({
    title: submitted.title,
    url: submitted.url,
    visibleTextBytes: Buffer.byteLength(submitted.visibleText, 'utf8'),
    elements: resultState(navigation).elements.length,
    screenshotBytes: observation.imageDataUrl.length,
    fullPageScreenshotBytes: fullPageBytes.byteLength,
    savedScreenshotBytes: screenshotBytes.byteLength,
    recordingBytes: recordingBytes.byteLength,
    recordingFrames: recordingArtifact.frames,
    recordingDurationMs: recordingArtifact.durationMs,
    navigatedTo: resultState(screenshot).url,
    formText: submittedUrl.searchParams.get('my-text'),
    formSelect: submittedUrl.searchParams.get('my-select'),
    checkedValues: submittedUrl.searchParams.getAll('my-check').length,
    typedSubmit: new URL(resubmitted.url).searchParams.get('my-text'),
    privateBlocked,
  })}\n`);
} finally {
  if (child.connected) child.send({ type: 'close' });
  if (child.exitCode === null) {
    await Promise.race([
      once(child, 'exit'),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
  }
  if (child.exitCode === null) child.kill('SIGTERM');
  if (process.env.MICROVM_E2E_PRESERVE_BROWSER_ARTIFACTS !== 'true') {
    await rm(artifactRoot, { recursive: true, force: true });
  }
}

function resultState(result) {
  return JSON.parse(result.text);
}

function element(state, label, type) {
  const found = state.elements.find((candidate) => (
    candidate.label.includes(label) && (type === undefined || candidate.type === type)
  ));
  if (!found) throw new Error(`browser state did not expose ${label}`);
  return found;
}

function request(command) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      child.off('message', listener);
      reject(new Error('browser canary timed out'));
    }, 45_000);
    const listener = (message) => {
      if (message?.id !== id) return;
      clearTimeout(timer);
      child.off('message', listener);
      if (message.error) reject(new Error(message.error));
      else resolve(message.result);
    };
    child.on('message', listener);
    child.send({ id, command });
  });
}
