import { CodexRpcClient } from '../adapters/codex-rpc.js';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { planCodexLaunch } from './agent-planning.js';
import { AgentsApiError } from '../domain/agents-api-validation.js';
import { developmentLocalCodexHost, localCodexArguments, localCodexEnvironment, type LocalCodexHostProvider } from './local-codex.js';
import type { ModelAccount, ModelAccountStatus } from '../core/harness-ports.js';
import { validateCodexAuthJson } from './chatgpt-auth.js';

/** Codex owns login and refresh. Subscription credentials stay inside the trusted local host. */
export class LocalSubscription implements ModelAccount {
  private login: { readonly id: string; readonly rpc: CodexRpcClient; readonly started: Promise<{ id: string; url: string }> } | undefined;
  private expiry: NodeJS.Timeout | undefined;
  private refreshing: Promise<string> | undefined;
  public constructor(private readonly directory: string,
    private readonly hostCodex: LocalCodexHostProvider = developmentLocalCodexHost(directory)) {}
  private client(onComplete?: () => void) {
    const host = this.hostCodex();
    const plan = planCodexLaunch({ version: '1', prompt: '', agent: { sandbox: 'read-only' } }, this.directory, 30_000,
      localCodexEnvironment(this.directory, { ...host.environment, CODEX_BINARY: host.binary }));
    return new CodexRpcClient({ binary: plan.binary, binaryArguments: localCodexArguments(plan.binaryArguments!), cwd: this.directory, environment: plan.environment,
      onEvent: event => { if (event.method === 'account/login/completed') onComplete?.(); } });
  }
  public async status(): Promise<ModelAccountStatus> {
    const rpc = this.client();
    try {
      await rpc.initialize();
      const result = await rpc.call('account/read', { refreshToken: false }) as { account?: { type?: string; email?: string; planType?: string } | null };
      return { harness: 'codex', provider: 'chatgpt', signed_in: result.account?.type === 'chatgpt', account_type: result.account?.type ?? null,
        email: result.account?.email ?? null, plan: result.account?.planType ?? null };
    } catch { throw new AgentsApiError(503, 'Codex account status is unavailable. Check that Codex is installed and available to the local service, then retry.', 'codex_unavailable'); }
    finally { await rpc.close(); }
  }
  /** Only the Pi inference adapter receives this token; API responses expose status alone. */
  public accessToken(): Promise<string> {
    this.refreshing ??= (async () => {
      const rpc = this.client();
      try {
        await rpc.initialize();
        const account = await rpc.call('account/read', { refreshToken: true }) as { account?: { type?: string } | null };
        if (account.account?.type !== 'chatgpt') throw new Error('Subscription sign-in required');
        const auth: unknown = JSON.parse(validateCodexAuthJson(await readFile(join(this.directory, 'codex', 'auth.json'), 'utf8')));
        if (!auth || typeof auth !== 'object' || !('tokens' in auth) || !auth.tokens || typeof auth.tokens !== 'object'
          || !('access_token' in auth.tokens) || typeof auth.tokens.access_token !== 'string' || !auth.tokens.access_token) throw new Error('Subscription token unavailable');
        return auth.tokens.access_token;
      } catch { throw new AgentsApiError(503, 'Sign in to ChatGPT in this local workspace before using Pi.', 'subscription_required'); }
      finally { await rpc.close(); }
    })().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }
  public async signIn(id: string = randomUUID()): Promise<{ id: string; url: string }> {
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)) throw new AgentsApiError(400, 'Sign-in requires a UUID.', 'invalid_request', 'id');
    if (this.login) {
      if (this.login.id === id) return this.login.started;
      throw new AgentsApiError(409, 'A ChatGPT sign-in is already open. Complete or cancel it before starting another.', 'login_active');
    }
    const rpc = this.client(() => { void this.cancelSignIn(id).catch(() => {}); });
    const started = Promise.resolve().then(async () => {
      try {
        await rpc.initialize();
        const result = await rpc.call('account/login/start', { type: 'chatgpt' }) as { authUrl?: string };
        const url = new URL(result.authUrl ?? '');
        if (url.protocol !== 'https:' || url.hostname !== 'auth.openai.com') throw new Error('Unexpected Codex sign-in URL');
        if (this.login?.id !== id) throw new Error('ChatGPT sign-in was cancelled.');
        this.expiry = setTimeout(() => { void this.cancelSignIn(id).catch(() => {}); }, 10 * 60_000);
        this.expiry.unref();
        return { id, url: url.href };
      } catch (error) { await this.cancelSignIn(id); throw error; }
    });
    this.login = { id, rpc, started };
    return started;
  }
  public async cancelSignIn(id: string) { if (this.login?.id === id) await this.close(); }
  public async close() { clearTimeout(this.expiry); const login = this.login; this.login = undefined; await login?.rpc.close(); await this.refreshing?.catch(() => {}); }
}
