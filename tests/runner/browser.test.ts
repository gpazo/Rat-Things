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

  it('fails closed on interactive actions when approval policy requires a reviewer', async () => {
    const execute = vi.fn(async () => ({ text: '{}' }));
    const approve = vi.fn().mockResolvedValue(false);
    const session = new BrowserToolSession(
      { execute, close: vi.fn(async () => undefined) },
      approve,
      true,
    );

    await expect(session.call({
      namespace: 'rat_browser',
      tool: 'click',
      arguments: { ref: 'r1' },
    })).rejects.toThrow('browser interaction was not approved');
    expect(approve).toHaveBeenCalledWith({
      tool: 'click',
      command: { type: 'click', ref: 'r1' },
    });
    expect(execute).not.toHaveBeenCalled();
  });
});
