import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const tsx = resolve('node_modules/tsx/dist/cli.mjs');
const cli = resolve('src/cli.ts');

describe('local-first CLI', () => {
  it('routes an unqualified prompt to the local runtime', () => {
    const output = execFileSync(
      process.execPath,
      [tsx, cli, 'local-first-marker', '--driver', 'mock'],
      { encoding: 'utf8' },
    );

    expect(output).toContain('mock-agent: local-first-marker');
  });

  it('advertises explicit cloud handoff separately from local work', () => {
    const output = execFileSync(process.execPath, [tsx, cli, 'help'], { encoding: 'utf8' });

    expect(output).toContain('rat-things "Work with your signed-in local Codex"');
    expect(output).toContain('rat-things handoff --thread NAME "Delegate to the cloud"');
    expect(output).toContain('Local is the default. Use handoff or chat for a durable cloud thread.');
  });
});
