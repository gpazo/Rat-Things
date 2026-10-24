import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const tsx = resolve('node_modules/tsx/dist/cli.mjs');
const cli = resolve('src/cli.ts');

describe('local-first CLI', () => {
  it('starts login with the private ChatGPT profile and no inherited billing credentials', () => {
    const root = mkdtempSync(join(tmpdir(), 'rat-login-env-'));
    const binary = join(root, 'codex-fixture');
    const audit = join(root, 'launch.json');
    const signedIn = join(root, 'fixture-signed-in');
    try {
      writeFileSync(binary, `#!${process.execPath}
const fs=require('node:fs');
fs.writeFileSync(${JSON.stringify(audit)},JSON.stringify({args:process.argv.slice(2),home:process.env.CODEX_HOME,mode:process.env.CODEX_AUTH_MODE,billing:!!(process.env.OPENAI_API_KEY||process.env.CODEX_API_KEY||process.env.AWS_ACCESS_KEY_ID),endpoint:process.env.OPENAI_BASE_URL}));
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
  const request=JSON.parse(line); if(request.id===undefined)return;
  let result={};
  if(request.method==='account/read')result={account:fs.existsSync(${JSON.stringify(signedIn)})?{type:'chatgpt',planType:'fixture'}:null};
  if(request.method==='account/login/start'){fs.writeFileSync(${JSON.stringify(signedIn)},'fixture');result={authUrl:'https://auth.openai.com/fixture'};}
  process.stdout.write(JSON.stringify({id:request.id,result})+'\\n');
});
`, { mode: 0o700 });
      const output = execFileSync(process.execPath, [tsx, cli, 'login', '--no-browser', '--json'], { encoding: 'utf8', timeout: 30_000, env: { ...process.env,
        RAT_THINGS_LOCAL_DIR: root, CODEX_BINARY: binary, OPENAI_API_KEY: 'billing-sentinel', CODEX_API_KEY: 'codex-sentinel',
        AWS_ACCESS_KEY_ID: 'aws-sentinel', OPENAI_BASE_URL: 'https://billing.example' } });
      const launch = JSON.parse(readFileSync(audit, 'utf8'));
      expect(launch).toMatchObject({ home: join(root, 'codex'), billing: false });
      expect(launch).not.toHaveProperty('endpoint');
      expect(launch.args).toContain('app-server');
      expect(launch.args).toContain('forced_login_method="chatgpt"');
      expect(JSON.parse(output.trim().split('\n').at(-1)!)).toMatchObject({ signed_in: true, account_type: 'chatgpt' });
      expect(statSync(join(root, 'codex')).mode & 0o777).toBe(0o700);
    } finally { rmSync(root, { recursive: true, force: true }); }
  // Several private RPC processes start during login; the subprocess owns the
  // 30-second deadline. Leave room for that deadline and fixture cleanup.
  }, 35_000);

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
    expect(output).toContain('Use sessions for durable work on this computer or in AWS.');
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
