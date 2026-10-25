import { join } from 'node:path';
import { LocalNativeInstallation } from '../adapters/local-native-installation.js';
import { LocalNativeRuntime } from '../adapters/local-native-runtime.js';
import type { AgentResource, AgentsStore } from '../core/agents-ports.js';
import type { NativeBundleVerifier, NativeCopyLimits, NativeInstallationLease, NativeInstallationStatus, NativeReleaseProbe, PinnedNativeRelease } from '../core/native-installation-ports.js';
import { AgentsApiError } from '../domain/agents-api-validation.js';
import { decodeNativeRuntimeChangeRecord, decodeNativeRuntimeChangeRequest, nativeRuntimeChangeId, nativeRuntimeChangeView,
  reconcileNativeRuntimeChange, type NativeRuntimeChangeAction, type NativeRuntimeChangeRecord, type NativeRuntimeChangeSubmission } from '../domain/local-native-change.js';
import type { LocalRuntimeStatus, NativeRuntimeInstallationView } from '../domain/local-runtime.js';
import type { NativeCompatibilityRequirements } from '../domain/native-release.js';
import { planLocalCodexEnvironment, type LocalCodexHost } from '../runner/local-codex.js';

export interface LocalNativeServiceOptions {
  readonly bundledRuntimePath: string;
  readonly verifier: NativeBundleVerifier;
  readonly probe: (runtime: LocalNativeRuntime) => NativeReleaseProbe;
  readonly requirements: NativeCompatibilityRequirements;
  readonly limits: NativeCopyLimits;
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
}

type ServiceState =
  | { readonly kind: 'checking' | 'needs_setup' | 'failed' | 'stopping' }
  | { readonly kind: 'ready'; readonly release: PinnedNativeRelease; readonly host: LocalCodexHost };

const CHANGES = 'local_native_changes';

export class LocalNativeService {
  readonly runtime: LocalNativeRuntime;
  private readonly installation: LocalNativeInstallation;
  private readonly probe: NativeReleaseProbe;
  private readonly environment: Readonly<NodeJS.ProcessEnv>;
  private state: ServiceState = { kind: 'checking' };
  private startup: Promise<void> | undefined;
  private submissions: Promise<void> = Promise.resolve();
  private active: { readonly id: string; readonly work: Promise<void> } | undefined;
  private stopped: Promise<void> | undefined;
  private closed: Promise<void> | undefined;

  constructor(lease: NativeInstallationLease, options: LocalNativeServiceOptions,
    private readonly persistence?: { readonly store: AgentsStore; readonly owner: string }) {
    this.environment = Object.freeze(planLocalCodexEnvironment(lease.profileDirectory, options.environment ?? process.env));
    this.runtime = new LocalNativeRuntime(lease.profileDirectory, () => ({ kind: 'trusted-release', release: this.selected().release }));
    this.probe = options.probe(this.runtime);
    this.installation = new LocalNativeInstallation({ ...options, lease, probe: this.probe });
  }

  readonly hostCodex = (): LocalCodexHost => this.selected().host;
  ready(): boolean { return this.state.kind === 'ready'; }

  start(): void {
    if (this.startup || this.state.kind === 'stopping') return;
    this.startup = this.installation.startup().then(status => this.serialize(async () => {
      await this.reconcile(status);
      this.pin(status);
    })).catch(() => { if (this.state.kind !== 'stopping') this.state = { kind: 'failed' }; });
  }

  createChange(action: NativeRuntimeChangeAction, raw: unknown): Promise<NativeRuntimeChangeSubmission> {
    let id: string;
    try { id = decodeNativeRuntimeChangeRequest(raw).id; }
    catch { return Promise.reject(new AgentsApiError(400, 'Supply only a UUID in the id field.', 'invalid_request', 'id')); }
    if (this.state.kind === 'stopping') return Promise.reject(new AgentsApiError(503, 'The local workspace is stopping.', 'local_runtime_stopping'));
    if (!this.startup) return Promise.reject(new AgentsApiError(503, 'The local runtime has not started.', 'local_runtime_starting'));
    return this.serialize(async () => {
      const { store, owner } = this.storage();
      const existing = await store.get<unknown>(owner, CHANGES, id);
      if (existing) {
        const record = await this.reconciledReceipt(id, decodeNativeRuntimeChangeRecord(existing.value));
        if (record.id !== id) throw new Error('Runtime change identity differs from its receipt.');
        return record.action === action ? { kind: 'accepted', change: nativeRuntimeChangeView(record) }
          : { kind: 'conflict', reason: 'request_id_reused', currentChangeId: id };
      }
      if (this.active) return { kind: 'conflict', reason: 'change_active', currentChangeId: this.active.id };
      const now = Math.floor(Date.now() / 1000);
      const record: NativeRuntimeChangeRecord = { schemaVersion: 1, id, action, createdAt: now, updatedAt: now, intent: null, state: { status: 'queued' } };
      await store.put({ ownerId: owner, collection: CHANGES, id, createdAt: now, revision: 1, value: record }, 0);
      const work = this.runChange(id).finally(() => { this.active = undefined; });
      this.active = { id, work };
      void work.catch(() => {});
      return { kind: 'accepted', change: nativeRuntimeChangeView(record) };
    });
  }

  async retrieveChange(rawId: string) {
    let id: string;
    try { id = nativeRuntimeChangeId(rawId); }
    catch { throw new AgentsApiError(400, 'Supply a runtime change UUID.', 'invalid_request', 'id'); }
    return this.serialize(async () => nativeRuntimeChangeView(await this.reconciledReceipt(id, (await this.required(id)).value)));
  }

  status(): LocalRuntimeStatus {
    const { selection, change, selected } = this.installation.status();
    const installation: NativeRuntimeInstallationView = {
      state: this.state.kind, active: selection.active, previous: selection.previous,
      pending: selection.pending?.release ?? null, generation: selection.generation,
      failure: change.kind === 'failed' ? change.failure.kind : null,
    };
    const messages: Record<ServiceState['kind'], string> = {
      checking: 'Checking the local runtime.', needs_setup: 'Set up the local runtime to start working on this computer.',
      ready: 'The local runtime is selected for this workspace.', failed: 'The local runtime could not start. Check setup and retry.',
      stopping: 'The local workspace is stopping.',
    };
    return { ready: this.ready(), engine: 'unknown', platform: 'linux/arm64', image: selected ? `native:${selected.id}` : 'native:unselected',
      installation, checks: [{ id: 'installation', ready: this.ready(), message: messages[this.state.kind] }] };
  }

  stop(): Promise<void> {
    this.state = { kind: 'stopping' };
    this.stopped ??= (async () => {
      await this.submissions;
      await this.startup;
      await this.active?.work;
    })();
    return this.stopped;
  }

  close(): Promise<void> {
    this.closed ??= this.stop().then(() => this.probe.close());
    return this.closed;
  }

  private pin(status: NativeInstallationStatus): void {
    if (this.state.kind === 'stopping' || this.state.kind === 'ready') return;
    if (status.selected) {
      const release = status.selected;
      const companionRoot = join(release.bundlePath, 'Contents/Resources/codex');
      const environment = Object.freeze({ ...this.environment, CODEX_BINARY: release.hostCodexPath,
        PATH: [join(companionRoot, 'codex-path'), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':') });
      this.state = { kind: 'ready', release, host: Object.freeze({ binary: release.hostCodexPath, environment }) };
    } else this.state = { kind: status.change.kind === 'failed' ? 'failed' : 'needs_setup' };
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const pending = this.submissions.then(work);
    this.submissions = pending.then(() => {}, () => {});
    return pending;
  }

  private async runChange(id: string): Promise<void> {
    try {
      await this.startup;
      const { value } = await this.required(id);
      const status = await this.installation[value.action]({
        beforeMutation: intent => this.update(id, record => ({ ...record, intent })),
        progress: phase => this.update(id, record => ({ ...record, state: { status: 'working', phase } })),
      });
      if (!this.ready()) await this.serialize(async () => { await this.reconcile(status); this.pin(status); });
      await this.update(id, record => status.change.kind === 'failed'
        ? { ...record, state: { status: 'failed', failure: status.change.failure.kind } }
        : reconcileNativeRuntimeChange(record, status.selection, Math.floor(Date.now() / 1000)));
    } catch {
      if (this.state.kind !== 'ready' && this.state.kind !== 'stopping') this.state = { kind: 'failed' };
      try {
        const status = this.installation.status();
        await this.update(id, record => {
          const reconciled = status.selectionKnown ? reconcileNativeRuntimeChange(record, status.selection, Math.floor(Date.now() / 1000)) : record;
          return ['complete', 'awaiting_restart'].includes(reconciled.state.status) ? reconciled
            : { ...record, state: { status: 'failed', failure: 'storage' } };
        });
      } catch {}
    }
  }

  private storage() {
    if (!this.persistence) throw new AgentsApiError(404, 'Native runtime changes are unavailable.', 'resource_not_found');
    return this.persistence;
  }

  private async required(id: string): Promise<AgentResource<NativeRuntimeChangeRecord>> {
    const { store, owner } = this.storage();
    const resource = await store.get<unknown>(owner, CHANGES, id);
    if (!resource) throw new AgentsApiError(404, 'Runtime change not found.', 'resource_not_found');
    const value = decodeNativeRuntimeChangeRecord(resource.value);
    if (value.id !== id) throw new Error('Runtime change identity differs from its receipt.');
    return { ...resource, value };
  }

  private async update(id: string, change: (record: NativeRuntimeChangeRecord) => NativeRuntimeChangeRecord): Promise<void> {
    const resource = await this.required(id);
    await this.storage().store.put({ ...resource, revision: resource.revision + 1,
      value: { ...change(resource.value), updatedAt: Math.max(resource.value.updatedAt, Math.floor(Date.now() / 1000)) } }, resource.revision);
  }

  private async reconciledReceipt(id: string, record: NativeRuntimeChangeRecord): Promise<NativeRuntimeChangeRecord> {
    if (id === this.active?.id || this.state.kind === 'checking' || this.state.kind === 'stopping') return record;
    const status = this.installation.status();
    if (!status.selectionKnown) return record;
    const reconciled = reconcileNativeRuntimeChange(record, status.selection, Math.floor(Date.now() / 1000));
    if (reconciled !== record) await this.update(id, () => reconciled);
    return reconciled;
  }

  private async reconcile(status: NativeInstallationStatus): Promise<void> {
    if (!this.persistence || !status.selectionKnown) return;
    const { store, owner } = this.persistence;
    let after: string | undefined;
    do {
      const page = await store.list<unknown>(owner, CHANGES, { limit: 100, ...(after ? { after } : {}) });
      for (const resource of page.data) {
        if (resource.id === this.active?.id) continue;
        const record = decodeNativeRuntimeChangeRecord(resource.value);
        const reconciled = reconcileNativeRuntimeChange(record, status.selection, Math.floor(Date.now() / 1000));
        if (reconciled !== record) await store.put({ ...resource, revision: resource.revision + 1, value: reconciled }, resource.revision);
      }
      after = page.has_more ? page.data.at(-1)?.id : undefined;
    } while (after);
  }

  private selected(): Extract<ServiceState, { kind: 'ready' }> {
    if (this.state.kind !== 'ready') throw new AgentsApiError(503, 'The local runtime is not ready. Check runtime setup.', 'local_runtime_starting');
    return this.state;
  }
}
