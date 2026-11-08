import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';
import type { createSource as CreateSource } from '../../testing/performance-share/source.js';
import type { ShareStageRequest, ShareStatus } from '../../src/core/session-share-types.js';

const fixture = vi.hoisted(() => ({ source: undefined as Awaited<ReturnType<typeof CreateSource>> | undefined, cleaned: false }));
vi.mock('../../testing/performance-share/source.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../testing/performance-share/source.js')>();
  return { ...actual, createSource: async (model: string) => { fixture.source = await actual.createSource(model); return fixture.source; } };
});
vi.mock('../../testing/aws/team-identities.js', () => ({ createTeamIdentities: async () => ({ users: [{ issuer: 'fixture', subject: 'manager', accessTokenForRequest: async () => 'PRIVATE_TOKEN' }], close: async () => { fixture.cleaned = true; } }) }));
vi.mock('../../src/agents-client.js', () => ({ createAgentsClient: () => ({ withOptions: () => ({ post: async () => ({ id: 'space_fixture' }) }) }) }));
import { run, parseArguments } from '../../testing/performance-share/controller.js';

const environment = { AWS_E2E: 'true', AWS_E2E_SHARED_SESSIONS: 'true', AWS_E2E_REAL_CODEX: 'true', AWS_REGION: 'us-west-2',
  SHARED_AGENTS_API_BASE_URL: 'https://fixture.a1.lambda-web.us-west-2.on.aws/v1', RAT_THINGS_API_URL: 'https://operator.execute-api.us-west-2.amazonaws.com',
  AWS_E2E_CODEX_MODEL_ID: 'openai.gpt-5.6-luna', TEAM_OIDC_FIXTURE_JSON: '{}' };
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); fixture.source = undefined; fixture.cleaned = false; });

it.each(['success', 'stage_failure', 'late_activation', 'upload_ack_lost', 'activation_ack_lost', 'activation_status_unknown'] as const)('retains evidence and cleans source/destination for %s', async outcome => {
  const failStage = outcome === 'stage_failure';
  const ambiguousActivation = outcome === 'activation_ack_lost' || outcome === 'activation_status_unknown';
  const directory = await mkdtemp(join(tmpdir(), 'share-controller-test-'));
  const uploaded = new Map<string, Buffer>(); const removed: string[] = [];
  let staged: ShareStageRequest | undefined;
  let remoteStatus: ShareStatus | undefined;
  let remoteSessionExists = false;
  let clientActivationAborted = false;
  let finishRemoteActivation: (() => void) | undefined;
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.stubGlobal('fetch', vi.fn(async (input: string | Request, init: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (init.method === 'DELETE') {
      removed.push(url.pathname);
      if (url.pathname.includes('/rat/shares/')) {
        const body = JSON.parse(String(init.body)) as { digest: string; session_id: string };
        remoteStatus = { id: url.pathname.split('/').at(-1)!, session_id: body.session_id, digest: body.digest, status: 'aborted' };
        return Response.json(remoteStatus);
      }
      if (url.pathname.includes('/agents/sessions/')) {
        const status = remoteSessionExists ? 204 : 404; remoteSessionExists = false;
        return new Response(null, { status });
      }
      if (url.pathname.includes('/files/')) uploaded.delete(url.pathname.split('/').at(-1)!);
      return new Response(null, { status: 204 });
    }
    if (url.pathname.includes('/rat/shares/') && init.method === 'GET') {
      return outcome === 'activation_status_unknown' ? new Response('PRIVATE_STATUS_ERROR', { status: 503 }) : Response.json(remoteStatus);
    }
    if (url.pathname.endsWith('/execution-roles/portable')) return new Response(null, { status: 204 });
    if (url.pathname.endsWith('/files')) {
      const file = (init.body as FormData).get('file') as File;
      const id = `file_fixture_${uploaded.size}`; uploaded.set(id, Buffer.from(await file.arrayBuffer()));
      if (outcome === 'upload_ack_lost') throw new Error('PRIVATE_ACK_ERROR');
      return Response.json({ id });
    }
    if (url.pathname.endsWith('/rat/shares')) {
      staged = JSON.parse(String(init.body)) as ShareStageRequest;
      if (failStage) return Response.json({ error: { message: 'PRIVATE_DESTINATION_ERROR' } }, { status: 503 });
      remoteStatus = { id: staged.manifest.operation_id, session_id: staged.manifest.session.id, digest: staged.digest, status: 'staged' };
      return Response.json(remoteStatus);
    }
    if (url.pathname.endsWith('/activate')) {
      remoteStatus = { ...remoteStatus!, status: 'activating' };
      if (ambiguousActivation) {
        // The admitted server operation survives the HTTP connection and can commit after cleanup's DELETE 404.
        finishRemoteActivation = () => { remoteStatus = { ...remoteStatus!, status: 'active' }; remoteSessionExists = true; };
        return new Promise<Response>((_resolve, reject) => {
          init.signal!.addEventListener('abort', () => { clientActivationAborted = true; reject(new Error('PRIVATE_ACTIVATION_DISCONNECT')); }, { once: true });
        });
      }
      if (outcome === 'late_activation') await delay(1100);
      remoteStatus = { ...remoteStatus!, status: 'active' }; remoteSessionExists = true;
      return Response.json(remoteStatus);
    }
    if (url.pathname.endsWith('/activity')) return Response.json(fixture.source!.history);
    if (url.pathname.endsWith('/content')) return new Response(uploaded.get(url.pathname.split('/').at(-2)!)!);
    throw new Error('No network is permitted in this test.');
  }));
  try {
    const output = join(directory, 'evidence.json');
    const result = await run(parseArguments(['--output', output, '--sizes-mib', '1', '--timeout-ms', outcome === 'late_activation' || ambiguousActivation ? '1000' : '600000']), environment);
    const cell = result.cells[0]!;
    expect(result.status).toBe(outcome === 'success' ? 'passed' : 'failed');
    expect(cell.payload?.bytes).toBe(1024 * 1024);
    expect(cell.uploadedFiles).toHaveLength(outcome === 'upload_ack_lost' ? 0 : 1);
    expect(fixture.cleaned).toBe(true);
    expect(cell.cleanup).toMatchObject({ shareService: 'complete', source: 'complete', destinationSession: ambiguousActivation ? 'unconfirmed' : 'complete',
      destinationAgent: ambiguousActivation ? 'unconfirmed' : 'complete', uploadedFiles: outcome === 'upload_ack_lost' || ambiguousActivation ? 'unconfirmed' : 'complete' });
    if (outcome !== 'upload_ack_lost' && !ambiguousActivation) expect(removed).toContain('/v1/files/file_fixture_0');
    if (ambiguousActivation) {
      expect(clientActivationAborted).toBe(true);
      expect(cell.destinationSessionDeleteStatus).toBe(404);
      expect(cell.destinationShare?.status).toBe(outcome === 'activation_status_unknown' ? 'unknown' : 'activating');
      expect(cell.cleanup.destinationActivation).toBe('unconfirmed');
      expect(removed).not.toContain('/v1/files/file_fixture_0');
      expect(uploaded.has('file_fixture_0')).toBe(true);
      expect(remoteSessionExists).toBe(false);
      finishRemoteActivation!();
      expect(remoteSessionExists).toBe(true);
      expect(uploaded.has('file_fixture_0')).toBe(true);
    } else if (failStage || outcome === 'upload_ack_lost') {
      expect(cell.error).toBe('share_failed'); expect(cell.transfer?.censoredMs).toBeGreaterThan(0);
      expect(cell.cleanup.pendingShareAbort).toBe('complete'); expect(cell.verification).toBeUndefined();
    } else if (outcome === 'late_activation') {
      expect(cell.error).toBe('timeout');
      expect(cell.transfer?.durationMs ?? cell.transfer?.censoredMs).toBeGreaterThanOrEqual(1000);
      expect(cell.verification).toBeUndefined();
    } else {
      expect(cell.transfer?.durationMs).toBeGreaterThan(0);
      expect(cell.verification).toMatchObject({ sameSession: true, sameAgent: true, sameHistory: true, sourceFenced: true, sourceExecutorClosed: true, archiveDownloaded: true });
      expect(cell.metrics[0]?.outcome).toBe('success');
    }
    await expect(access(cell.source!.directory)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(output, 'utf8')).not.toContain('PRIVATE_');
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 15_000);
