import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const tsx = resolve('node_modules/tsx/dist/cli.mjs');
const cli = resolve('src/cli.ts');

describe('local-first CLI', () => {
  it.each(['submit', 'chat', 'computer', 'conversations', 'get', 'publish'])('rejects retired %s commands before executing a prompt', (command) => {
    const result = spawnSync(process.execPath, [tsx, cli, command, '--driver', 'mock'], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('This command was removed');
  });
  it('routes an unqualified prompt to the local runtime', () => {
    const output = execFileSync(
      process.execPath,
      [tsx, cli, 'local-first-marker', '--driver', 'mock'],
      { encoding: 'utf8' },
    );

    expect(output).toContain('mock-agent: local-first-marker');
  });

  it('advertises canonical Sessions and explicit local work', () => {
    const output = execFileSync(process.execPath, [tsx, cli, 'help'], { encoding: 'utf8' });

    expect(output).toContain('rat-things sessions create|list|get|send');
    expect(output).toContain('rat-things local [--driver codex|mock]');
    expect(output).toContain('Use sessions for durable work in AWS.');
    expect(output).not.toContain('handoff --thread');
  });

  it.each([
    [['--thread', 'cloud-thread'], '--thread is not valid for local'],
    [['--json'], '--json is not valid for local'],
    [['--attach', 'evidence.txt'], '--attach is not valid for local'],
  ])('rejects cloud options %j before executing locally', (options, diagnostic) => {
    const result = spawnSync(process.execPath, [tsx, cli, '--driver', 'mock', ...options, 'Do work'], {
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(diagnostic);
  });
});
