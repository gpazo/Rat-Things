import { constants, type Stats } from 'node:fs';
import { chmod, lstat, mkdir, open, opendir, rename, rmdir, unlink, type FileHandle } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  activateNativeSelection, decodeAuthenticatedNativeManifest, decodeNativeSelection, EMPTY_NATIVE_SELECTION,
  nativeCompatibility, nativeReleaseId, NATIVE_MANIFEST_PATH, NATIVE_SIGNATURE_PATHS,
  requestNativeSelection, type NativeCompatibilityRequirements, type NativeInstallationFailure,
  type NativeReleaseId, type NativeSelection, type NativeSelectionDecision,
} from '../domain/native-release.js';
import type {
  NativeBundleVerifier, NativeCopyLimits, NativeInstallCheckpoint, NativeInstallationChange,
  NativeInstallationHooks, NativeInstallationLease, NativeInstallationStatus, NativeReleaseProbe, PinnedNativeRelease,
} from '../core/native-installation-ports.js';
import type { NativeRuntimeChangePhase } from '../domain/local-native-change.js';
import { NATIVE_PROBE_LIMITS } from '../domain/native-probe.js';
import { inspectNativeProbeDirectory } from './local-native-probe-storage.js';

const probeMetadataLimits: NativeCopyLimits = Object.freeze({ entries: NATIVE_PROBE_LIMITS.entries,
  fileBytes: NATIVE_PROBE_LIMITS.metadataBytes, totalBytes: NATIVE_PROBE_LIMITS.metadataBytes + NATIVE_PROBE_LIMITS.logBytes,
  manifestBytes: NATIVE_PROBE_LIMITS.metadataBytes, depth: NATIVE_PROBE_LIMITS.depth, pathBytes: 1024 });

interface TreeEntry { readonly path: string; readonly stat: Stats }
interface InspectedBundle { readonly release: PinnedNativeRelease; readonly tree: readonly TreeEntry[]; readonly fingerprint: string }
interface ScanBudget { entries: number; bytes: number }

export class NativeInstallationError extends Error {
  public constructor(public readonly failure: NativeInstallationFailure) { super(failure.kind); }
}

/** One instance is owned by the service holding the SQLite profile lease. It never acquires a lock. */
export class LocalNativeInstallation {
  private readonly root: string;
  private readonly profile: string;
  private readonly source: string;
  private readonly uid: number;
  private selection: NativeSelection = EMPTY_NATIVE_SELECTION;
  private selectionKnown = false;
  private selected: PinnedNativeRelease | null = null;
  private change: NativeInstallationChange = { kind: 'none' };
  private lifecycle: 'new' | 'recovering' | 'recovered' = 'new';
  private progressCallback: NativeInstallationHooks['progress'];
  private operation: { readonly key: 'startup' | 'setup' | 'rollback'; readonly promise: Promise<NativeInstallationStatus> } | undefined;

  public constructor(private readonly options: {
    readonly lease: NativeInstallationLease;
    readonly bundledRuntimePath: string;
    readonly verifier: NativeBundleVerifier;
    readonly probe: NativeReleaseProbe;
    readonly requirements: NativeCompatibilityRequirements;
    readonly limits: NativeCopyLimits;
    /** Fixture fault injection only. Production composition must omit it. */
    readonly checkpoint?: (point: NativeInstallCheckpoint) => Promise<void>;
  }) {
    this.options = { ...options, limits: Object.freeze({ ...options.limits }), requirements: Object.freeze({ ...options.requirements }) };
    this.uid = process.getuid?.() ?? fail({ kind: 'filesystem', reason: 'Native installation requires POSIX ownership checks' });
    this.profile = absolute(options.lease.profileDirectory);
    this.source = absolute(options.bundledRuntimePath);
    this.root = join(this.profile, 'runtime');
    if (within(this.profile, this.source) || within(this.source, this.profile)) fail({ kind: 'filesystem', reason: 'Bundled source and profile ancestry must be disjoint' });
    for (const limit of ['entries', 'fileBytes', 'totalBytes', 'manifestBytes', 'depth', 'pathBytes'] as const) {
      const value = options.limits[limit];
      if (!Number.isSafeInteger(value) || value < 1) fail({ kind: 'bounds', limit });
    }
    if (options.limits.manifestBytes > options.limits.fileBytes || options.limits.fileBytes > options.limits.totalBytes
      || options.limits.entries > 65_536 || options.limits.depth > 32 || options.limits.pathBytes > 1024) fail({ kind: 'bounds', limit: 'configuration' });
  }

  public status(): NativeInstallationStatus {
    return Object.freeze({ selection: this.selection, selectionKnown: this.selectionKnown, selected: this.selected, change: this.change });
  }

  /** Call before constructing host Codex or admitting workers. A successful pin never changes in this instance. */
  public startup(): Promise<NativeInstallationStatus> {
    if (this.lifecycle === 'recovered' && !this.operation) return Promise.resolve(this.status());
    return this.perform('startup', async () => {
      this.lifecycle = 'recovering';
      await this.prepare();
      await this.recover();
      this.lifecycle = 'recovered';
      await this.readSelection();
      if (this.selection.pending) {
        try { await this.activate(this.selection.pending.release); return; }
        catch (error) {
          const failure = installationFailure(error);
          if (failure.kind === 'lease_lost') throw error;
          if (this.selection.active) {
            this.lifecycle = 'recovering';
            await this.recover();
            this.lifecycle = 'recovered';
            this.selected = (await this.inspectVersion(this.selection.active)).release;
            this.change = { kind: 'failed', failure };
            return;
          }
          throw error;
        }
      }
      if (this.selection.active) this.selected = (await this.inspectVersion(this.selection.active)).release;
      this.change = { kind: 'none' };
    });
  }

  public setup(hooks: NativeInstallationHooks = {}): Promise<NativeInstallationStatus> {
    return this.perform('setup', async () => {
      if (this.lifecycle === 'new') fail({ kind: 'not_started' });
      await this.prepare();
      if (this.lifecycle === 'recovering') { await this.recover(); this.lifecycle = 'recovered'; }
      await this.readSelection();
      const source = await this.inspect(this.source);
      const decision = requestNativeSelection(this.selection, 'setup', source.release.id);
      if (decision.kind === 'rejected') fail(decision.failure);
      await hooks.beforeMutation?.({ target: source.release.id, startingGeneration: this.selection.generation,
        requestedGeneration: decision.selection.generation });
      if (this.selection.active === source.release.id) {
        const installed = await this.inspectVersion(source.release.id);
        if (installed.fingerprint !== source.fingerprint) fail({ kind: 'version_collision', release: source.release.id });
        await this.commit(decision);
        this.selected ??= installed.release;
        this.change = { kind: 'none' };
        return;
      }
      await this.cleanOwnedDirectories('staging', /^stage-[a-f0-9-]{36}$/);
      await this.install(source);
      await this.commit(decision);
      if (!this.selected) await this.activate(source.release.id);
      else this.change = { kind: 'awaiting_restart', release: source.release.id };
    }, hooks);
  }

  public rollback(hooks: NativeInstallationHooks = {}): Promise<NativeInstallationStatus> {
    return this.perform('rollback', async () => {
      if (this.lifecycle === 'new') fail({ kind: 'not_started' });
      await this.prepare();
      if (this.lifecycle === 'recovering') { await this.recover(); this.lifecycle = 'recovered'; }
      await this.readSelection();
      if (!this.selection.previous) fail({ kind: 'no_previous' });
      const previous = await this.inspectVersion(this.selection.previous);
      const decision = requestNativeSelection(this.selection, 'rollback', previous.release.id);
      if (decision.kind === 'rejected') fail(decision.failure);
      await hooks.beforeMutation?.({ target: previous.release.id, startingGeneration: this.selection.generation,
        requestedGeneration: decision.selection.generation });
      await this.commit(decision);
      this.change = { kind: 'awaiting_restart', release: previous.release.id };
    }, hooks);
  }

  private perform(key: 'startup' | 'setup' | 'rollback', action: () => Promise<void>, hooks: NativeInstallationHooks = {}): Promise<NativeInstallationStatus> {
    if (this.operation) return this.operation.key === key ? this.operation.promise
      : Promise.resolve({ ...this.status(), change: { kind: 'failed', failure: { kind: 'busy', operation: this.operation.key } } });
    this.change = { kind: 'working', operation: key, phase: 'checking' };
    this.progressCallback = hooks.progress;
    let entered = false;
    let retained: Promise<void>;
    try { retained = this.options.lease.runWhileHeld(async () => { entered = true; this.assertLease(); await this.progress('checking'); await action(); }); }
    catch (error) { retained = Promise.reject(error); }
    const promise = retained.catch(error => {
      if (!entered) fail({ kind: 'lease_lost' });
      throw error;
    }).catch(error => {
      this.change = { kind: 'failed', failure: installationFailure(error) };
    }).then(() => this.status()).finally(() => { this.operation = undefined; this.progressCallback = undefined; });
    this.operation = { key, promise };
    return promise;
  }

  private assertLease(): void {
    try { this.options.lease.assertHeld(); } catch { fail({ kind: 'lease_lost' }); }
  }

  private async prepare(): Promise<void> {
    this.assertLease();
    await this.ancestry(this.profile);
    const profile = await lstat(this.profile);
    privateDirectory(profile, this.uid);
    for (const path of [this.root, join(this.root, 'versions'), join(this.root, 'staging'), join(this.root, 'probes')]) {
      await this.ancestry(dirname(path));
      this.assertLease();
      try { await mkdir(path, { mode: 0o700 }); await this.syncDirectory(dirname(path)); }
      catch (error) { if (code(error) !== 'EEXIST') throw error; }
      const directory = await lstat(path);
      privateDirectory(directory, this.uid);
      if (directory.dev !== profile.dev) fail({ kind: 'filesystem', reason: 'Runtime storage must share the profile filesystem' });
    }
  }

  private async recover(): Promise<void> {
    await this.progress('recovering');
    this.assertLease();
    const result = await this.options.probe.recover({ directory: join(this.root, 'probes') })
      .catch(error => fail({ kind: 'probe', reason: 'recovery', detail: failureDetail(error) }));
    if (result.kind === 'failed') fail(result.failure);
    const budget: ScanBudget = { entries: 0, bytes: 0 };
    await this.cleanOwnedDirectories('probes', /^probe-[a-f0-9-]{36}$/);
    await this.cleanOwnedDirectories('staging', /^stage-[a-f0-9-]{36}$/, budget);
    const names = await boundedNames(this.root, this.options.limits.entries);
    for (const name of names.filter(name => /^\.selection-[a-f0-9-]{36}\.tmp$/.test(name))) {
      const path = join(this.root, name);
      regularFile(await lstat(path), this.uid, 65_536);
      this.assertLease(); await unlink(path);
    }
    await this.syncDirectory(this.root);
  }

  private async readSelection(): Promise<void> {
    this.selectionKnown = false;
    const path = join(this.root, 'selection.json');
    await this.ancestry(this.root);
    let stat: Stats;
    try { stat = await lstat(path); }
    catch (error) { if (code(error) === 'ENOENT') { this.selection = EMPTY_NATIVE_SELECTION; this.selectionKnown = true; return; } throw error; }
    regularFile(stat, this.uid, 65_536);
    if ((stat.mode & 0o077) !== 0) fail({ kind: 'selection', reason: 'Selection must be private' });
    const bytes = await this.readFile(path, stat, 65_536);
    try { this.selection = decodeNativeSelection(JSON.parse(bytes.toString('utf8'))); }
    catch { fail({ kind: 'selection', reason: 'Selection record is malformed or incoherent' }); }
    this.selectionKnown = true;
  }

  private async commit(decision: NativeSelectionDecision): Promise<void> {
    if (decision.kind === 'rejected') fail(decision.failure);
    await this.progress('selecting');
    if (decision.kind === 'unchanged') return;
    await this.ancestry(this.root);
    privateDirectory(await lstat(this.root), this.uid);
    this.assertLease();
    const path = join(this.root, `.selection-${randomUUID()}.tmp`);
    const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await file.writeFile(`${JSON.stringify(decision.selection)}\n`);
      await file.sync();
    } finally { await file.close(); }
    await this.checkpoint('selection-file-synced');
    this.assertLease(); await this.ancestry(this.root);
    await rename(path, join(this.root, 'selection.json'));
    this.selection = decision.selection;
    await this.checkpoint('selection-renamed');
    await this.syncDirectory(this.root);
    await this.checkpoint('selection-parent-synced');
  }

  private async install(source: InspectedBundle): Promise<void> {
    const version = join(this.root, 'versions', source.release.id);
    try {
      await lstat(version);
      const existing = await this.inspectVersion(source.release.id, true);
      if (existing.fingerprint !== source.fingerprint) fail({ kind: 'version_collision', release: source.release.id });
      await this.sealVersion(version);
      return;
    } catch (error) { if (code(error) !== 'ENOENT') throw error; }
    const stage = join(this.root, 'staging', `stage-${randomUUID()}`);
    await this.ancestry(join(this.root, 'staging')); this.assertLease();
    await mkdir(stage, { mode: 0o700 });
    const destination = join(stage, 'Runtime.bundle');
    this.assertLease();
    await mkdir(destination, { mode: 0o700 });
    await this.progress('copying');
    for (const entry of source.tree) {
      const target = join(destination, entry.path);
      await this.ancestry(dirname(target)); this.assertLease();
      if (entry.stat.isDirectory()) await mkdir(target, { mode: 0o700 });
      else {
        await this.copyFile(join(source.release.bundlePath, entry.path), target, entry.stat);
        await this.checkpoint('copied-file');
      }
    }
    for (const path of [...source.tree.filter(entry => entry.stat.isDirectory()).map(entry => join(destination, entry.path)).reverse(), destination]) {
      this.assertLease(); await chmod(path, 0o555); await this.syncDirectory(path);
    }
    await this.syncDirectory(stage);
    await this.checkpoint('staging-synced');
    const copied = await this.inspect(destination);
    if (copied.release.id !== source.release.id || copied.fingerprint !== source.fingerprint) fail({ kind: 'inventory', reason: 'Copied bundle differs from authenticated source' });
    await this.checkpoint('copy-verified');
    this.assertLease(); await this.ancestry(dirname(version));
    try { await lstat(version); fail({ kind: 'version_collision', release: source.release.id }); }
    catch (error) { if (code(error) !== 'ENOENT') throw error; }
    await rename(stage, version);
    await this.checkpoint('version-renamed');
    await this.sealVersion(version);
    await this.syncDirectory(dirname(version));
    await this.syncDirectory(join(this.root, 'staging'));
    await this.checkpoint('version-parent-synced');
  }

  private async activate(id: NativeReleaseId): Promise<void> {
    if (this.selected) fail({ kind: 'selection', reason: 'This service already pinned a release' });
    const candidate = await this.inspectVersion(id);
    const path = join(this.root, 'probes', `probe-${randomUUID()}`);
    this.assertLease(); await this.ancestry(dirname(path)); await mkdir(path, { mode: 0o700 });
    this.assertLease();
    await this.progress('probing');
    const result = await this.options.probe.run({ release: candidate.release, directory: path })
      .catch(error => { this.lifecycle = 'recovering'; return fail({ kind: 'probe', reason: 'failed', detail: failureDetail(error) }); });
    let checked: InspectedBundle;
    try {
      if (result.kind === 'failed') fail(result.failure);
      await this.checkpoint('probe-ready');
      checked = await this.inspectVersion(id);
      if (checked.fingerprint !== candidate.fingerprint) fail({ kind: 'version_collision', release: id });
    } finally {
      try { await this.removeOwnedTree(path); }
      catch (error) { this.lifecycle = 'recovering'; throw error; }
    }
    await this.commit(activateNativeSelection(this.selection, id));
    this.assertLease();
    this.selected = checked.release;
    this.change = { kind: 'none' };
  }

  private async sealVersion(path: string): Promise<void> {
    // macOS requires a writable directory for rename. Seal the wrapper before selecting it.
    if (((await lstat(path)).mode & 0o222) === 0) return;
    this.assertLease(); await chmod(path, 0o555); await this.syncDirectory(path);
  }

  private async inspectVersion(id: NativeReleaseId, recoverPublication = false): Promise<InspectedBundle> {
    const path = join(this.root, 'versions', id);
    await this.ancestry(path);
    const stat = await lstat(path);
    const unreferenced = ![this.selection.active, this.selection.previous, this.selection.pending?.release].includes(id);
    const unfinishedPublication = recoverPublication && unreferenced && (stat.mode & 0o777) === 0o700;
    if (stat.uid !== this.uid || ((stat.mode & 0o222) !== 0 && !unfinishedPublication)) fail({ kind: 'filesystem', reason: 'Version directory is not immutable and profile-owned' });
    const result = await this.inspect(join(path, 'Runtime.bundle'));
    if ((await lstat(result.release.bundlePath)).mode & 0o222) fail({ kind: 'filesystem', reason: 'Installed bundle directory is writable' });
    if (result.release.id !== id) fail({ kind: 'version_collision', release: id });
    for (const entry of result.tree) {
      if (entry.stat.uid !== this.uid || (entry.stat.mode & 0o222) !== 0) fail({ kind: 'filesystem', reason: 'Installed payload is writable or not profile-owned' });
    }
    return result;
  }

  private async inspect(bundlePath: string): Promise<InspectedBundle> {
    await this.progress('verifying');
    this.assertLease();
    const tree = await this.tree(bundlePath);
    const authenticated = await this.options.verifier.verify({ bundlePath, limits: this.options.limits })
      .catch(error => fail({ kind: 'verifier_unavailable', reason: failureDetail(error) }));
    this.assertLease();
    if (authenticated.kind === 'rejected') fail(authenticated.failure);
    if (authenticated.manifestBytes.byteLength > this.options.limits.manifestBytes) fail({ kind: 'bounds', limit: 'manifestBytes' });
    let manifest;
    try { manifest = decodeAuthenticatedNativeManifest(JSON.parse(Buffer.from(authenticated.manifestBytes).toString('utf8'))); }
    catch (error) { fail({ kind: 'manifest', reason: error instanceof Error ? error.message : 'Cannot decode authenticated manifest' }); }
    const incompatible = nativeCompatibility(manifest, this.options.requirements);
    if (incompatible) fail(incompatible);
    const inventory = new Map(manifest.files.map(file => [String(file.path), file]));
    const executablePaths = manifest.files.filter(file => file.kind === 'host-executable').map(file => String(file.path)).sort();
    const verifiedPaths = [...authenticated.executablePaths].sort();
    if (JSON.stringify(executablePaths) !== JSON.stringify(verifiedPaths)) fail({ kind: 'inventory', reason: 'Every host executable needs independent signature validation' });
    const digest = hash(authenticated.manifestBytes);
    const fingerprint = createHash('sha256');
    const observed = new Set<string>();
    for (const entry of tree) {
      if (entry.stat.isDirectory()) continue;
      const file = inventory.get(entry.path);
      if (!file && entry.path !== NATIVE_MANIFEST_PATH && !NATIVE_SIGNATURE_PATHS.includes(entry.path)) fail({ kind: 'inventory', reason: 'File is absent from the sealed inventory', path: entry.path });
      const actual = await this.hashFile(join(bundlePath, entry.path), entry.stat);
      if (file && (file.bytes !== entry.stat.size || file.sha256 !== actual)) fail({ kind: 'inventory', reason: 'Payload size or digest differs', path: entry.path });
      const executable = (entry.stat.mode & 0o111) !== 0;
      if (executable !== (file?.kind === 'host-executable')) fail({ kind: 'inventory', reason: 'Executable mode differs from inventory', path: entry.path });
      if (entry.path === NATIVE_MANIFEST_PATH && actual !== digest) fail({ kind: 'inventory', reason: 'Verifier manifest differs from copied bytes', path: entry.path });
      observed.add(entry.path);
      fingerprint.update(`${entry.path}\0${entry.stat.size}\0${executable}\0${actual}\n`);
    }
    if (!observed.has(NATIVE_MANIFEST_PATH) || NATIVE_SIGNATURE_PATHS.some(path => !observed.has(path))
      || manifest.files.some(file => !observed.has(file.path))) fail({ kind: 'inventory', reason: 'Bundle is missing inventory or signature files' });
    const after = await this.tree(bundlePath);
    if (!sameTree(tree, after)) fail({ kind: 'filesystem', reason: 'Bundle changed while being authenticated' });
    const helper = manifest.files.find(file => file.kind === 'host-executable' && file.role === 'vm-helper')!;
    const codex = manifest.files.find(file => file.kind === 'host-executable' && file.role === 'host-codex')!;
    const release = Object.freeze({ id: nativeReleaseId(digest), bundlePath, manifest,
      helperPath: join(bundlePath, helper.path), hostCodexPath: join(bundlePath, codex.path) });
    return { release, tree, fingerprint: fingerprint.digest('hex') };
  }

  private async tree(root: string, budget: ScanBudget = { entries: 0, bytes: 0 }, temporaryWrapper = false,
    limits = this.options.limits, probeCleanup = false): Promise<readonly TreeEntry[]> {
    await this.ancestry(root);
    const rootStat = await lstat(root);
    const entries: TreeEntry[] = [];
    const names = new Set<string>();
    if (!temporaryWrapper) budget.entries++;
    if (budget.entries > limits.entries) fail({ kind: 'bounds', limit: 'entries' });
    const visit = async (directory: string, depth: number): Promise<void> => {
      if (depth > limits.depth + Number(temporaryWrapper)) fail({ kind: 'bounds', limit: 'depth' });
      const children = await boundedNames(directory, limits.entries - budget.entries);
      for (const name of children) {
        const path = join(directory, name); const inside = relative(root, path);
        if (!name || name === '.' || name === '..' || /[\\:\u0000-\u001f\u007f]/.test(name) || name.normalize('NFC') !== name) fail({ kind: 'filesystem', reason: 'Unsafe bundle path' });
        if (Buffer.byteLength(inside) > limits.pathBytes + (temporaryWrapper ? 'Runtime.bundle/'.length : 0)) fail({ kind: 'bounds', limit: 'pathBytes' });
        if (names.has(inside.toLowerCase())) fail({ kind: 'filesystem', reason: 'Case-aliased bundle path' });
        names.add(inside.toLowerCase());
        const stat = await lstat(path);
        const homeLink = probeCleanup && stat.isSymbolicLink() && /^rat-environment-files-[A-Za-z0-9]{6}\//.test(inside);
        if (stat.dev !== rootStat.dev || (stat.isSymbolicLink() ? !homeLink : (!stat.isDirectory() && !stat.isFile()))
          || ![0, this.uid].includes(stat.uid) || (!homeLink && (stat.mode & 0o7022) !== 0)) fail({ kind: 'filesystem', reason: 'Unsafe bundle ownership, mode, type or filesystem' });
        if (stat.isFile() || homeLink) {
          if (homeLink) {
            if (stat.nlink !== 1 || !Number.isSafeInteger(stat.size) || stat.size > limits.fileBytes) fail({ kind: 'filesystem', reason: 'Unsafe disposable home link' });
          } else regularFile(stat, stat.uid, limits.fileBytes);
          budget.bytes += stat.size;
          if (!Number.isSafeInteger(budget.bytes) || budget.bytes > limits.totalBytes) fail({ kind: 'bounds', limit: 'totalBytes' });
          if (inside === NATIVE_MANIFEST_PATH && stat.size > limits.manifestBytes) fail({ kind: 'bounds', limit: 'manifestBytes' });
        }
        entries.push({ path: inside, stat });
        budget.entries++;
        if (budget.entries > limits.entries) fail({ kind: 'bounds', limit: 'entries' });
        if (stat.isDirectory()) await visit(path, depth + 1);
      }
    };
    await visit(root, 1);
    return entries;
  }

  private async ancestry(path: string): Promise<void> {
    let current: string = sep;
    for (const part of absolute(path).split(sep).filter(Boolean)) {
      current = join(current, part);
      const stat = await lstat(current);
      const sharedSticky = stat.uid === 0 && (stat.mode & 0o1000) !== 0 && current !== path && !within(this.profile, current);
      const appSource = within(this.source, path) && nativeAppSourceAncestorAllowed(current, stat);
      if (!stat.isDirectory() || stat.isSymbolicLink() || ![0, this.uid].includes(stat.uid)
        || (stat.mode & 0o6000) !== 0 || ((stat.mode & 0o022) !== 0 && !sharedSticky && !appSource)) fail({ kind: 'filesystem', reason: 'Unsafe directory ancestry' });
    }
  }

  private async readFile(path: string, expected: Stats, bound: number): Promise<Buffer> {
    if (expected.size > bound) fail({ kind: 'bounds', limit: 'readBytes' });
    const chunks: Buffer[] = [];
    await this.consume(path, expected, chunk => { chunks.push(Buffer.from(chunk)); });
    return Buffer.concat(chunks);
  }

  private async hashFile(path: string, expected: Stats): Promise<string> {
    const digest = createHash('sha256');
    await this.consume(path, expected, chunk => { digest.update(chunk); });
    return digest.digest('hex');
  }

  private async consume(path: string, expected: Stats, consume: (chunk: Buffer) => void | Promise<void>): Promise<void> {
    await this.ancestry(dirname(path));
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!sameStat(expected, await file.stat())) fail({ kind: 'filesystem', reason: 'File changed before open' });
      const buffer = Buffer.allocUnsafe(256 * 1024);
      let size = 0;
      for (;;) {
        const read = await file.read(buffer, 0, Math.min(buffer.length, expected.size - size + 1), null);
        if (!read.bytesRead) break;
        size += read.bytesRead;
        if (size > expected.size) fail({ kind: 'filesystem', reason: 'File grew during read' });
        await consume(buffer.subarray(0, read.bytesRead));
      }
      if (size !== expected.size || !sameStat(expected, await file.stat()) || !sameStat(expected, await lstat(path))) fail({ kind: 'filesystem', reason: 'File changed during read' });
    } finally { await file.close(); }
  }

  private async copyFile(source: string, destination: string, expected: Stats): Promise<void> {
    this.assertLease();
    const file = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await this.consume(source, expected, async chunk => {
        this.assertLease();
        let offset = 0;
        while (offset < chunk.length) {
          const result = await file.write(chunk, offset, chunk.length - offset);
          if (!result.bytesWritten) fail({ kind: 'filesystem', reason: 'Copy did not advance' });
          offset += result.bytesWritten;
        }
      });
      this.assertLease(); await file.chmod((expected.mode & 0o111) !== 0 ? 0o555 : 0o444); await file.sync();
    } finally { await file.close(); }
  }

  private async cleanOwnedDirectories(name: 'staging' | 'probes', pattern: RegExp, budget: ScanBudget = { entries: 0, bytes: 0 }): Promise<void> {
    const root = join(this.root, name);
    await this.ancestry(root);
    const entries = await boundedNames(root, name === 'probes' ? NATIVE_PROBE_LIMITS.directories : this.options.limits.entries);
    for (const entry of entries) {
      if (!pattern.test(entry)) fail({ kind: 'filesystem', reason: 'Unrecognized temporary runtime directory' });
      await this.removeOwnedTree(join(root, entry), name === 'probes' ? undefined : budget);
    }
    await this.syncDirectory(root);
  }

  private async removeOwnedTree(path: string, budget?: ScanBudget): Promise<void> {
    if (![join(this.root, 'staging'), join(this.root, 'probes')].includes(dirname(path))) fail({ kind: 'filesystem', reason: 'Cleanup is outside temporary runtime storage' });
    const probe = dirname(path) === join(this.root, 'probes');
    if (probe) {
      await inspectNativeProbeDirectory(path);
      const disk = await lstat(join(path, 'workspace.raw')).catch(error => { if (code(error) !== 'ENOENT') throw error; return undefined; });
      if (disk) fail({ kind: 'probe', reason: 'recovery', detail: 'Native probe disk must be disposed under its inode lock before metadata cleanup' });
    }
    const entries = await this.tree(path, budget, true, probe ? probeMetadataLimits : this.options.limits, probe);
    const all = [{ path, stat: await lstat(path) }, ...entries.map(entry => ({ path: join(path, entry.path), stat: entry.stat }))];
    if (all.some(entry => entry.stat.uid !== this.uid)) fail({ kind: 'filesystem', reason: 'Cleanup found foreign-owned data' });
    for (const entry of all.filter(entry => entry.stat.isDirectory())) { this.assertLease(); await chmod(entry.path, 0o700); }
    for (const entry of [...all].reverse()) {
      this.assertLease();
      if (entry.stat.isDirectory()) await rmdir(entry.path); else await unlink(entry.path);
    }
    await this.syncDirectory(dirname(path));
  }

  private async syncDirectory(path: string): Promise<void> {
    this.assertLease(); await this.ancestry(path);
    let file: FileHandle | undefined;
    try { file = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); await file.sync(); }
    finally { await file?.close(); }
  }

  private async checkpoint(point: NativeInstallCheckpoint): Promise<void> { await this.options.checkpoint?.(point); }

  private async progress(phase: NativeRuntimeChangePhase): Promise<void> {
    if (this.change.kind === 'working') this.change = { ...this.change, phase };
    try { await this.progressCallback?.(phase); } catch {}
  }
}

/** macOS /Applications is root:admin 0775. This exception applies only while inspecting the bundled source. */
export function nativeAppSourceAncestorAllowed(path: string, stat: Pick<Stats, 'uid' | 'gid' | 'mode'>): boolean {
  return path === '/Applications' && stat.uid === 0 && stat.gid === 80 && (stat.mode & 0o7777) === 0o775;
}

function absolute(path: string): string {
  if (!isAbsolute(path) || resolve(path) !== path) fail({ kind: 'filesystem', reason: 'Paths must be absolute and normalized without link resolution' });
  return path;
}
function within(parent: string, child: string): boolean { return child === parent || child.startsWith(`${parent}${sep}`); }
function privateDirectory(stat: Stats, uid: number): void {
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o7077) !== 0) fail({ kind: 'filesystem', reason: 'Runtime storage must be a private profile-owned directory' });
}
function regularFile(stat: Stats, uid: number, bound: number): void {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== uid || (stat.mode & 0o7022) !== 0) fail({ kind: 'filesystem', reason: 'Unsafe file ownership, mode, type or hard link' });
  if (!Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > bound) fail({ kind: 'bounds', limit: 'fileBytes' });
}
function sameStat(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mode === b.mode && a.uid === b.uid
    && a.nlink === b.nlink && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}
function sameTree(a: readonly TreeEntry[], b: readonly TreeEntry[]): boolean {
  return a.length === b.length && a.every((entry, index) => entry.path === b[index]?.path && sameStat(entry.stat, b[index]!.stat));
}
function hash(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
async function boundedNames(path: string, limit: number): Promise<string[]> {
  const names: string[] = [];
  const directory = await opendir(path);
  for await (const entry of directory) {
    names.push(entry.name);
    if (names.length > limit) fail({ kind: 'bounds', limit: 'entries' });
  }
  return names.sort();
}
function code(error: unknown): string | undefined { return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined; }
function fail(failure: NativeInstallationFailure): never { throw new NativeInstallationError(failure); }
function installationFailure(error: unknown): NativeInstallationFailure {
  if (error instanceof NativeInstallationError) return error.failure;
  const errno = code(error);
  return { kind: 'filesystem', reason: failureDetail(error), ...(errno ? { code: errno } : {}) };
}
function failureDetail(error: unknown): string { return error instanceof Error ? error.message.slice(0, 512) : 'Installation failed'; }
