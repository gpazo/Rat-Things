import { describe, expect, it } from 'vitest';
import { terminalNotificationError } from '../../src/runner/codex-app-server.js';

describe('Codex app-server notifications', () => {
  it('lets app-server recover from retryable stream errors', () => {
    expect(terminalNotificationError({
      error: { message: 'Reconnecting... 1/5' },
      willRetry: true,
      threadId: 'thread-1',
      turnId: 'turn-1',
    })).toBeUndefined();
  });

  it('surfaces terminal turn errors', () => {
    expect(terminalNotificationError({
      error: { message: 'model access is not enabled' },
      willRetry: false,
      threadId: 'thread-1',
      turnId: 'turn-1',
    })?.message).toBe('model access is not enabled');
  });
});
