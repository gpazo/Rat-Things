import { describe, expect, it } from 'vitest';
import { watchdogAlarmNamesFromEnv } from '../../src/app/watchdog-composition.js';

describe('watchdog alarm configuration', () => {
  it('preserves exact deployment alarm names', () => {
    const names = ['rat-things-test-runs-dlq', 'rat-things-test-state-stream-failures'];
    expect(watchdogAlarmNamesFromEnv({ WATCHDOG_ALARM_NAMES_JSON: JSON.stringify(names) })).toEqual(names);
  });

  it.each([undefined, '', 'null', '{}', '[]', '[1]', '[""]', '[" "]', '["alarm","alarm"]', JSON.stringify(['x'.repeat(256)]), JSON.stringify(Array.from({ length: 101 }, (_, index) => `alarm-${index}`))])('rejects absent or invalid alarm configuration %s', value => {
    expect(() => watchdogAlarmNamesFromEnv({ WATCHDOG_ALARM_NAMES_JSON: value })).toThrow();
  });
});
