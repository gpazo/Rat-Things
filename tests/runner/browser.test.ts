import { describe, expect, it, vi } from 'vitest';
import {
  browserHostEnvironment,
  BrowserToolSession,
  type BrowserBackend,
  type BrowserCommand,
} from '../../src/runner/browser.js';

describe('browser dynamic tools', () => {
  it('exposes a browser namespace and returns text plus screenshots', async () => {
    const execute = vi.fn(async (_command: BrowserCommand) => ({
      text: JSON.stringify({ url: 'https://example.com/', title: 'Example Domain' }),
      imageDataUrl: 'data:image/jpeg;base64,YWJj',
    }));
    const backend: BrowserBackend = { execute, close: vi.fn(async () => undefined) };
    const session = new BrowserToolSession(backend);

    expect(session.tools).toEqual([
      expect.objectContaining({
        type: 'namespace',
        name: 'rat_browser',
        tools: expect.arrayContaining([
          expect.objectContaining({ name: 'navigate' }),
          expect.objectContaining({ name: 'observe' }),
          expect.objectContaining({ name: 'screenshot' }),
          expect.objectContaining({ name: 'record_start' }),
          expect.objectContaining({ name: 'record_stop' }),
          expect.objectContaining({ name: 'click' }),
          expect.objectContaining({ name: 'type' }),
        ]),
      }),
    ]);

    await expect(session.call({
      namespace: 'rat_browser',
      tool: 'navigate',
      arguments: { url: 'https://example.com' },
    })).resolves.toEqual({
      success: true,
      contentItems: [
        { type: 'inputText', text: JSON.stringify({ url: 'https://example.com/', title: 'Example Domain' }) },
        { type: 'inputImage', imageUrl: 'data:image/jpeg;base64,YWJj' },
      ],
    });
    expect(execute).toHaveBeenCalledWith(
      { type: 'navigate', url: 'https://example.com/' },
      undefined,
    );
  });

  it('normalizes artifact capture commands and bounded recording defaults', async () => {
    const execute = vi.fn(async (_command: BrowserCommand) => ({ text: '{}' }));
    const session = new BrowserToolSession({ execute, close: vi.fn(async () => undefined) });

    await session.call({
      namespace: 'rat_browser',
      tool: 'screenshot',
      arguments: { path: 'browser/final.jpg' },
    });
    await session.call({
      namespace: 'rat_browser',
      tool: 'record_start',
      arguments: { path: 'browser/navigation.webm' },
    });
    await session.call({
      namespace: 'rat_browser',
      tool: 'record_stop',
      arguments: {},
    });

    expect(execute.mock.calls.map(([command]) => command)).toEqual([
      { type: 'screenshot', path: 'browser/final.jpg', fullPage: false },
      { type: 'record_start', path: 'browser/navigation.webm', fps: 5 },
      { type: 'record_stop' },
    ]);
  });

  it('validates browser actions before sending them to the host', async () => {
    const execute = vi.fn(async () => ({ text: '{}' }));
    const session = new BrowserToolSession({ execute, close: vi.fn(async () => undefined) });

    await expect(session.call({
      namespace: 'rat_browser',
      tool: 'navigate',
      arguments: { url: 'file:///etc/passwd' },
    })).rejects.toThrow('HTTP or HTTPS');
    await expect(session.call({
      namespace: 'rat_browser',
      tool: 'click',
      arguments: { ref: 'r2', x: 10, y: 20 },
    })).rejects.toThrow('either ref or both x and y');
    await expect(session.call({
      namespace: 'rat_browser',
      tool: 'wait',
      arguments: { milliseconds: 10_001 },
    })).rejects.toThrow('milliseconds is invalid');
    await expect(session.call({
      namespace: 'rat_browser',
      tool: 'screenshot',
      arguments: { path: '../outside.jpg' },
    })).rejects.toThrow('screenshot path is invalid');
    await expect(session.call({
      namespace: 'rat_browser',
      tool: 'record_start',
      arguments: { path: 'browser/navigation.mp4' },
    })).rejects.toThrow('recording path must end in .webm');
    await expect(session.call({
      namespace: 'rat_browser',
      tool: 'record_start',
      arguments: { path: 'browser/navigation.webm', fps: 11 },
    })).rejects.toThrow('fps is invalid');
    expect(execute).not.toHaveBeenCalled();
  });

  it('passes only the explicit artifact root and browser-safe host environment', () => {
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'must-not-cross-browser-boundary');
    vi.stubEnv('PATH', '/safe/bin');
    try {
      expect(browserHostEnvironment('/workspace/run/.rat-things/artifacts')).toMatchObject({
        PATH: '/safe/bin',
        BROWSER_ARTIFACT_ROOT: '/workspace/run/.rat-things/artifacts',
      });
      expect(browserHostEnvironment('/workspace/run/.rat-things/artifacts')).not.toHaveProperty(
        'AWS_SECRET_ACCESS_KEY',
      );
      expect(() => browserHostEnvironment('relative/artifacts')).toThrow(
        'browser artifact root must be absolute',
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('executes interactive actions autonomously once browser use is admitted', async () => {
    const execute = vi.fn(async () => ({ text: '{}' }));
    const session = new BrowserToolSession({ execute, close: vi.fn(async () => undefined) });

    await expect(session.call({
      namespace: 'rat_browser',
      tool: 'click',
      arguments: { ref: 'r1' },
    })).resolves.toMatchObject({ success: true });
    expect(execute).toHaveBeenCalledWith({ type: 'click', ref: 'r1' }, undefined);
  });

  it('gives the human a bounded exclusive browser lease without widening browser actions', async () => {
    const execute = vi.fn(async (command: BrowserCommand) => ({
      text: JSON.stringify({ url: 'https://example.com/', title: command.type }),
      ...(command.type === 'observe' && command.includeScreenshot
        ? { imageDataUrl: 'data:image/jpeg;base64,YWJj' }
        : {}),
    }));
    const session = new BrowserToolSession(
      { execute, close: vi.fn(async () => undefined) },
      () => new Date('2026-08-26T12:00:00.000Z'),
    );

    await expect(session.takeComputer('run-1')).resolves.toMatchObject({
      runId: 'run-1',
      control: 'human',
      takeover: { expiresAt: '2026-08-26T12:15:00.000Z' },
    });
    await expect(session.call({
      namespace: 'rat_browser',
      tool: 'click',
      arguments: { ref: 'r1' },
    })).rejects.toThrow('temporary human control');
    await expect(session.actOnComputer('run-1', { type: 'click', x: 640, y: 360 }))
      .resolves.toMatchObject({ control: 'human', page: { title: 'observe' } });
    await expect(session.returnComputer('run-1')).resolves.toMatchObject({ control: 'agent' });
  });

  it('turns a demonstration into an unpublished, redacted Thing draft', async () => {
    const execute = vi.fn(async (command: BrowserCommand) => ({
      text: JSON.stringify({ url: 'https://example.com/account?token=secret', title: command.type }),
      ...(command.type === 'observe' && command.includeScreenshot
        ? { imageDataUrl: 'data:image/jpeg;base64,YWJj' }
        : {}),
    }));
    let tick = 0;
    const session = new BrowserToolSession(
      { execute, close: vi.fn(async () => undefined) },
      () => new Date(Date.parse('2026-08-26T12:00:00.000Z') + tick++ * 1_000),
    );
    await session.takeComputer('run-1');
    await session.startTeaching('run-1', {
      name: 'Update account',
      goal: 'Update the account setting shown by the operator.',
    });
    await session.actOnComputer('run-1', {
      type: 'navigate',
      url: 'https://example.com/account?token=secret#private',
    });
    await session.actOnComputer('run-1', {
      type: 'type',
      ref: 'r2',
      text: 'super-secret-value',
      clear: true,
    });
    const saved = await session.stopTeaching(false);

    expect(saved).toMatchObject({
      discarded: false,
      demonstratedSteps: 2,
      draft: {
        name: 'Update account',
        trigger: { kind: 'manual' },
        agent: { capabilities: { computerUse: 'browser', networkAccess: true } },
      },
    });
    expect(JSON.stringify(saved.draft)).not.toContain('super-secret-value');
    expect(saved.draft?.goal).toContain('{{input_1}}');
    expect(saved.draft?.goal).not.toContain('token=secret');
    expect(saved.draft?.metadata).toMatchObject({
      createdBy: 'teach-by-demonstration',
      demonstratedActions: 2,
    });
  });

  it('forgets an active action demonstration when it is discarded', async () => {
    const execute = vi.fn(async (command: BrowserCommand) => ({
      text: JSON.stringify({ url: 'about:blank', title: command.type }),
      ...(command.type === 'observe' && command.includeScreenshot
        ? { imageDataUrl: 'data:image/jpeg;base64,YWJj' }
        : {}),
    }));
    const session = new BrowserToolSession({ execute, close: vi.fn(async () => undefined) });
    await session.takeComputer('run-1');
    await session.startTeaching('run-1', { name: 'Disposable example' });

    await expect(session.stopTeaching(true)).resolves.toMatchObject({
      discarded: true,
      demonstratedSteps: 0,
    });
    expect(execute).not.toHaveBeenCalledWith({ type: 'record_stop' });
  });
});
