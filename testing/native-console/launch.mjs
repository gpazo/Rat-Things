import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';

const fixture = spawn(process.execPath, ['--import', 'tsx', 'testing/native-console/server.ts'], { stdio: ['pipe', 'pipe', 'inherit'] });
let app;
const stop = () => { app?.kill('SIGTERM'); fixture.kill('SIGTERM'); };
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
try {
  const lines = createInterface({ input: fixture.stdout });
  const port = await new Promise((resolvePort, reject) => {
    const timer = setTimeout(() => reject(new Error('Fixture startup timed out')), 10_000);
    lines.once('line', line => { clearTimeout(timer); try { resolvePort(JSON.parse(line).port); } catch (error) { reject(error); } });
    fixture.once('exit', () => { clearTimeout(timer); reject(new Error('Fixture exited before startup')); });
    fixture.once('error', reject);
  });
  console.log(`Local deterministic fixture: http://127.0.0.1:${port}`);
  const binary = process.env.RAT_THINGS_CONSOLE_BIN ?? resolve(`desktop/target/debug/rat-things-desktop${process.platform === 'win32' ? '.exe' : ''}`);
  app = spawn(binary, [], { env: { ...process.env, RAT_THINGS_AGENTS_API_URL: `http://127.0.0.1:${port}`, RAT_THINGS_CONSOLE_PORT: '0', AGENT_RUNTIME_UNSIGNED: 'true', RAT_THINGS_LOCAL_OWNER: 'console-owner' }, stdio: 'inherit' });
  await new Promise((resolveExit, reject) => { app.once('error', reject); app.once('exit', code => code === 0 ? resolveExit() : reject(new Error(`Native app exited with ${code}`))); });
} finally { stop(); }
