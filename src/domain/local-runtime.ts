import type { NativeAdmission } from './local-native-admission.js';
import type { NativeInstallationFailure, NativeReleaseId } from './native-release.js';

/** Engine classification ported from Cua's container/engine.rs. See THIRD_PARTY_NOTICES.md. */
export type LocalEngine = 'colima' | 'docker-desktop' | 'orbstack' | 'podman' | 'native-linux' | 'unknown';
export type WorkerPlatform = 'linux/arm64' | 'linux/amd64';
/** `engine_vm` is the engine's shared Linux VM; `gvisor` is a user-space kernel per worker on a native Linux host. */
export type IsolationBoundary = 'engine_vm' | 'gvisor';
export interface LocalIsolation { boundary: IsolationBoundary; runtime?: 'runsc'; preview: boolean }
export interface LocalRuntimeIssue { message: string; action: string }

export function classifyLocalEngine(uri: string, platform: string): LocalEngine {
  if (uri.startsWith('npipe://')) {
    if (uri.includes('podman')) return 'podman';
    return uri.includes('docker_engine') || uri.includes('dockerDesktop') ? 'docker-desktop' : 'unknown';
  }
  const path = uri.replace(/^unix:\/\//, '');
  if (path.includes('/.colima/')) return 'colima';
  if (path.includes('/.orbstack/')) return 'orbstack';
  if (path.includes('podman')) return 'podman';
  if (path.includes('/.docker/run/docker.sock') || path.includes('/.docker/desktop/docker.sock') || path.includes('docker.raw.sock') || uri.includes('dockerDesktop')) return 'docker-desktop';
  if (platform === 'linux' && ['/var/run/docker.sock', '/run/docker.sock'].includes(path)) return 'native-linux';
  return 'unknown';
}

/** Only this computer's engine is admitted: a Unix socket, or a local named pipe on Windows. */
export function localEngineEndpoint(uri: string | undefined, platform: string): boolean {
  if (!uri) return false;
  if (uri.startsWith('unix://')) return platform !== 'win32';
  return platform === 'win32' && /^npipe:\/\/\/\/\.\/pipe\/[A-Za-z0-9_.-]+$/.test(uri);
}

export function workerPlatform(architecture: string | undefined): WorkerPlatform | undefined {
  if (architecture === 'aarch64' || architecture === 'arm64') return 'linux/arm64';
  if (architecture === 'x86_64' || architecture === 'amd64') return 'linux/amd64';
  return undefined;
}

/**
 * Workers run `danger-full-access` inside their container, so each host needs a boundary below it.
 * Apple silicon Macs are the supported platform; the others stay preview until their boundary,
 * packaging and recovery are verified.
 */
export function localIsolation(input: { platform: string; engine: LocalEngine; runtimes: string[]; workerPlatform: WorkerPlatform | undefined }): LocalIsolation | LocalRuntimeIssue {
  const { platform, engine } = input;
  if (engine === 'podman') return { message: 'Podman is not supported yet.', action: 'Use Docker Desktop, Colima or OrbStack.' };
  let isolation: LocalIsolation | undefined;
  if (platform === 'darwin' && ['docker-desktop', 'colima', 'orbstack'].includes(engine)) isolation = { boundary: 'engine_vm', preview: input.workerPlatform !== 'linux/arm64' };
  else if (platform === 'win32' && engine === 'docker-desktop') isolation = { boundary: 'engine_vm', preview: true };
  else if (platform === 'linux' && engine === 'docker-desktop') isolation = { boundary: 'engine_vm', preview: true };
  else if (platform === 'linux' && engine === 'native-linux') {
    if (!input.runtimes.includes('runsc')) return { message: 'Docker on Linux shares the host kernel, so local workers require gVisor.', action: 'Install gVisor, register the runsc runtime with Docker, then run rat-things runtime doctor.' };
    isolation = { boundary: 'gvisor', runtime: 'runsc', preview: true };
  }
  if (!isolation) {
    return platform === 'win32' ? { message: 'A local Linux VM is required.', action: 'Start Docker Desktop with the WSL 2 backend.' }
      : platform === 'linux' ? { message: 'A local container engine is required.', action: 'Start Docker with the gVisor runsc runtime, or Docker Desktop.' }
        : { message: 'A supported local Linux VM is required.', action: 'Start Docker Desktop, Colima, or OrbStack on this Mac.' };
  }
  return isolation;
}

/** Published worker images are pinned by digest; the engine verifies content on pull. */
export interface WorkerImageManifest { version: 1; images: Partial<Record<WorkerPlatform, string>> }
export type WorkerImageInstall = { kind: 'pull'; reference: string } | { kind: 'build' } | { kind: 'unavailable'; message: string };
const PINNED_IMAGE = /^[a-z0-9]+(?:[.-][a-z0-9]+)*(?::\d{1,5})?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+@sha256:[a-f0-9]{64}$/;

export function planWorkerImageInstall(input: { platform: WorkerPlatform | undefined; manifest: WorkerImageManifest; checkout: boolean }): WorkerImageInstall {
  if (!input.platform) return { kind: 'unavailable', message: 'This Linux VM architecture is not supported.' };
  const reference = input.manifest.images[input.platform];
  if (reference !== undefined) {
    if (!PINNED_IMAGE.test(reference)) throw new Error(`Invalid worker image reference for ${input.platform}`);
    return { kind: 'pull', reference };
  }
  if (input.checkout && input.platform === 'linux/arm64') return { kind: 'build' };
  return { kind: 'unavailable', message: `No published Rat Things worker image exists for ${input.platform} yet.` };
}

export interface NativeRuntimeInstallationView {
  readonly state: 'checking' | 'needs_setup' | 'ready' | 'failed' | 'stopping';
  readonly active: NativeReleaseId | null;
  readonly previous: NativeReleaseId | null;
  readonly pending: NativeReleaseId | null;
  readonly generation: number;
  readonly failure: NativeInstallationFailure['kind'] | null;
}

export interface LocalRuntimeStatus {
  ready: boolean;
  engine: LocalEngine;
  endpoint?: string;
  platform?: WorkerPlatform;
  isolation?: LocalIsolation;
  image: string;
  install?: WorkerImageInstall['kind'];
  native?: { configuredCapacity: number; effectiveCapacity: 0 | 1; occupied: boolean; admission: NativeAdmission };
  installation?: NativeRuntimeInstallationView;
  checks: Array<{ id: string; ready: boolean; message: string; action?: string }>;
}

export type LocalRuntimeSetupPlan =
  | { kind: 'ready' }
  | { kind: 'blocked'; message: string }
  | { kind: 'install'; method: 'pull' | 'build' };

export function planLocalRuntimeSetup(status: LocalRuntimeStatus): LocalRuntimeSetupPlan {
  const unavailable = status.checks.filter(check => !check.ready && check.id !== 'image');
  if (unavailable.length) return { kind: 'blocked', message: unavailable.map(check => `${check.message} ${check.action ?? ''}`.trim()).join(' ') };
  if (status.ready) return { kind: 'ready' };
  if (status.install === 'pull' || status.install === 'build') return { kind: 'install', method: status.install };
  return { kind: 'blocked', message: status.checks.find(check => check.id === 'image')?.action ?? 'No Rat Things worker image is available for this computer.' };
}

export const LOCAL_WORKER_IMAGE = 'docker.io/library/rat-things-local:1';

/** Names and mounts are derived from trusted workspace and Session identities only. */
export function localWorkerNames(workspaceId: string, sessionId: string) {
  if (!/^[a-f0-9]{16}$/.test(workspaceId) || !/^sess_[a-zA-Z0-9_-]+$/.test(sessionId) || sessionId.length > 100) throw new Error('Invalid local worker identity');
  const name = `rat-${workspaceId}-${sessionId}`;
  return { name, volume: `${name}-workspace` };
}
