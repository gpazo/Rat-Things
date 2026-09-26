import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const tsx = resolve('node_modules/tsx/dist/cli.mjs');
const cli = resolve('src/cli.ts');

describe('local-first CLI', () => {
  it('captures OTLP locally without AWS or a collector and omits prompt content', () => {
    const root = mkdtempSync(join(tmpdir(), 'rat-local-trace-'));
    const target = join(root, 'trace.json');
    try {
      execFileSync(process.execPath, [tsx, cli, 'local', '--driver', 'mock', '--trace-output', target, 'PRIVATE_PROMPT'], { encoding: 'utf8' });
      const text = readFileSync(target, 'utf8');
      const spans = JSON.parse(text).resourceSpans[0].scopeSpans[0].spans;
      expect(spans).toHaveLength(1);
      expect(spans[0].status.code).toBe(1);
      expect(text).not.toContain('PRIVATE_PROMPT');
      expect(statSync(target).mode & 0o777).toBe(0o600);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

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
    [['--thread', 'cloud-thread'], 'unknown option --thread'],
    [['--json'], '--json is not valid for local'],
    [['--attach', 'evidence.txt'], 'unknown option --attach'],
  ])('rejects cloud options %j before executing locally', (options, diagnostic) => {
    const result = spawnSync(process.execPath, [tsx, cli, '--driver', 'mock', ...options, 'Do work'], {
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(diagnostic);
  });
});
