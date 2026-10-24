import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { LocalSubscription } from '../../src/runner/local-subscription.js';
import { developmentLocalCodexHost } from '../../src/runner/local-codex.js';

it('rejects overlapping sign-in and scopes cancellation to its own browser flow', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rat-login-owner-'));
  const binary = join(directory, 'fixture-codex');
  await writeFile(binary, `#!${process.execPath}
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
  const request=JSON.parse(line);if(request.id===undefined)return;
  const result=request.method==='account/login/start'?{authUrl:'https://auth.openai.com/fixture'}:{};
  process.stdout.write(JSON.stringify({id:request.id,result})+'\\n');
});
`, { mode: 0o700 });
  const account = new LocalSubscription(directory, developmentLocalCodexHost(directory, { CODEX_BINARY: binary, PATH: '/usr/bin:/bin' }));
  try {
    const first = await account.signIn();
    expect(await account.signIn(first.id)).toEqual(first);
    await expect(account.signIn()).rejects.toMatchObject({ code: 'login_active' });
    await account.cancelSignIn(first.id);
    const second = await account.signIn();
    expect(second.id).not.toBe(first.id);
    await account.cancelSignIn(first.id);
    await expect(account.signIn()).rejects.toMatchObject({ code: 'login_active' });
    await account.cancelSignIn(second.id);
    await expect(account.signIn()).resolves.toMatchObject({ url: 'https://auth.openai.com/fixture' });
  } finally { await account.close(); await rm(directory, { recursive: true, force: true }); }
});
