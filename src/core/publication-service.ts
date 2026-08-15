import { basename } from 'node:path';
import { MAX_ARTIFACT_FILES, validateArtifactPath } from '../domain/artifacts.js';
import type {
  BlobReference,
  PublicationDiagnostic,
  PublicationFile,
  PublicationKind,
  PublicationManifest,
  PublicationSpec,
  Result,
} from '../domain/publications.js';
import {
  PublicationError,
  validateBlobReference,
  validatePublicationId,
  validatePublicationManifest,
} from '../domain/publications.js';

export interface PublicationSourceFile {
  path: string;
  blob: BlobReference;
}

export type PlannedPublicationFile =
  | {
      source: 'blob';
      path: string;
      blob: BlobReference;
    }
  | {
      source: 'generated';
      path: string;
      bytes: Uint8Array;
      mediaType: string;
    };

export interface PublicationPlan {
  kind: PublicationKind;
  entrypoint: 'index.html';
  primaryPath?: string;
  files: PlannedPublicationFile[];
}

export interface PublicationBuilder {
  readonly kind: PublicationKind;
  readonly name: string;
  plan(
    spec: PublicationSpec,
    files: readonly PublicationSourceFile[],
  ): Promise<Result<PublicationPlan, PublicationDiagnostic[]>>;
}

export interface PublicationObjectStore {
  stageBlob(input: {
    ownerId: string;
    publicationId: string;
    path: string;
    source: BlobReference;
  }): Promise<BlobReference>;
  stageBytes(input: {
    ownerId: string;
    publicationId: string;
    path: string;
    bytes: Uint8Array;
    mediaType: string;
  }): Promise<BlobReference>;
  commit(input: {
    ownerId: string;
    manifest: PublicationManifest;
  }): Promise<BlobReference>;
}

export interface PublishInput {
  ownerId: string;
  publicationId: string;
  spec: PublicationSpec;
  files: readonly PublicationSourceFile[];
  runId: string;
  conversationId?: string;
  createdAt?: string;
}

export interface PublishedPublication {
  manifest: PublicationManifest;
  manifestBlob: BlobReference;
}

export class PublicationBuilderRegistry {
  private readonly builders = new Map<PublicationKind, PublicationBuilder>();

  public constructor(builders: readonly PublicationBuilder[]) {
    for (const builder of builders) {
      if (this.builders.has(builder.kind)) {
        throw new Error(`duplicate publication builder for ${builder.kind}`);
      }
      this.builders.set(builder.kind, builder);
    }
  }

  public get(kind: PublicationKind): PublicationBuilder {
    const builder = this.builders.get(kind);
    if (!builder) throw new PublicationError('unsupported_media', `no publication builder for ${kind}`);
    return builder;
  }
}

export class PublicationService {
  public constructor(
    private readonly store: PublicationObjectStore,
    private readonly builders = defaultPublicationBuilders(),
  ) {}

  public async publish(input: PublishInput): Promise<PublishedPublication> {
    validatePublicationId(input.publicationId);
    for (const file of input.files) validateBlobReference(file.blob);
    const builder = this.builders.get(input.spec.kind);
    const planned = await builder.plan(input.spec, input.files);
    if (!planned.ok) {
      throw new PublicationError(
        planned.error[0]?.code ?? 'invalid_request',
        planned.error[0]?.message ?? 'publication could not be planned',
        { diagnostics: planned.error },
      );
    }

    validatePublicationPlan(planned.value, input.spec, input.files);

    const materialized: PublicationFile[] = [];
    for (const file of planned.value.files) {
      let blob: BlobReference;
      try {
        blob = file.source === 'blob'
          ? await this.store.stageBlob({
              ownerId: input.ownerId,
              publicationId: input.publicationId,
              path: file.path,
              source: file.blob,
            })
          : await this.store.stageBytes({
              ownerId: input.ownerId,
              publicationId: input.publicationId,
              path: file.path,
              bytes: file.bytes,
              mediaType: file.mediaType,
            });
      } catch (error) {
        throw storageError(`could not stage publication path ${file.path}`, error);
      }
      materialized.push({ path: file.path, blob });
    }

    const manifest: PublicationManifest = {
      version: '1',
      publicationId: input.publicationId,
      kind: planned.value.kind,
      entrypoint: planned.value.entrypoint,
      ...(planned.value.primaryPath ? { primaryPath: planned.value.primaryPath } : {}),
      files: materialized.sort((left, right) => left.path.localeCompare(right.path)),
      provenance: {
        runId: input.runId,
        ...(input.conversationId ? { conversationId: input.conversationId } : {}),
        builder: builder.name,
        createdAt: input.createdAt ?? new Date().toISOString(),
      },
    };
    validatePublicationManifest(manifest);
    // The manifest is the ready marker and must be committed after every referenced object.
    let manifestBlob: BlobReference;
    try {
      manifestBlob = await this.store.commit({ ownerId: input.ownerId, manifest });
    } catch (error) {
      throw storageError('could not commit publication manifest', error);
    }
    return { manifest, manifestBlob };
  }
}

function storageError(message: string, cause: unknown): PublicationError {
  return new PublicationError(
    'storage',
    message,
    cause instanceof Error ? { cause } : undefined,
  );
}

function validatePublicationPlan(
  plan: PublicationPlan,
  spec: PublicationSpec,
  sources: readonly PublicationSourceFile[],
): void {
  if (plan.kind !== spec.kind || plan.entrypoint !== 'index.html' || plan.files.length === 0) {
    throw new PublicationError('invalid_request', 'publication builder returned an invalid plan');
  }
  if (plan.files.length > MAX_ARTIFACT_FILES) {
    throw new PublicationError('invalid_request', `publication exceeds ${MAX_ARTIFACT_FILES} files`);
  }
  const paths = new Set<string>();
  const sourceBlobs = new Set(sources.map((source) => blobIdentity(source.blob)));
  for (const file of plan.files) {
    try {
      validateArtifactPath(file.path);
    } catch (error) {
      throw new PublicationError(
        'invalid_path',
        `publication builder returned invalid path ${JSON.stringify(file.path)}`,
        error instanceof Error ? { cause: error } : undefined,
      );
    }
    if (file.path === '_rat' || file.path.startsWith('_rat/')) {
      throw new PublicationError(
        'invalid_path',
        `publication path ${file.path} uses the reserved _rat namespace`,
      );
    }
    if (paths.has(file.path)) {
      throw new PublicationError('path_collision', `duplicate publication path ${file.path}`);
    }
    paths.add(file.path);
    if (file.source === 'blob') {
      validateBlobReference(file.blob);
      if (!sourceBlobs.has(blobIdentity(file.blob))) {
        throw new PublicationError('invalid_request', 'publication builder selected an unknown source blob');
      }
    } else if (
      !(file.bytes instanceof Uint8Array) ||
      typeof file.mediaType !== 'string' ||
      !file.mediaType ||
      file.mediaType.length > 128 ||
      /[\r\n]/.test(file.mediaType)
    ) {
      throw new PublicationError('invalid_request', 'publication builder returned invalid generated bytes');
    }
  }
  if (!paths.has(plan.entrypoint)) {
    throw new PublicationError('invalid_request', 'publication plan does not contain its entrypoint');
  }
  if (plan.primaryPath !== undefined && !paths.has(plan.primaryPath)) {
    throw new PublicationError('invalid_request', 'publication plan does not contain its primary path');
  }
}

function blobIdentity(blob: BlobReference): string {
  return [blob.id, blob.digest, String(blob.size), blob.mediaType].join('\0');
}

export function defaultPublicationBuilders(): PublicationBuilderRegistry {
  return new PublicationBuilderRegistry([
    new FilePublicationBuilder(),
    new SitePublicationBuilder(),
    new VideoPublicationBuilder(),
  ]);
}

class FilePublicationBuilder implements PublicationBuilder {
  public readonly kind = 'file';
  public readonly name = 'rat-things/file@1';

  public async plan(
    spec: PublicationSpec,
    files: readonly PublicationSourceFile[],
  ): Promise<Result<PublicationPlan, PublicationDiagnostic[]>> {
    if (spec.kind !== this.kind) return mismatch(this.kind, spec.kind);
    const file = findFile(files, spec.path);
    if (!file) return missing(spec.path);
    const assetPath = `assets/${basename(file.path)}`;
    return success({
      kind: this.kind,
      entrypoint: 'index.html',
      primaryPath: assetPath,
      files: [
        { source: 'generated', path: 'index.html', bytes: fileViewer(spec.title, file, assetPath), mediaType: 'text/html; charset=utf-8' },
        { source: 'blob', path: assetPath, blob: file.blob },
      ],
    });
  }
}

class VideoPublicationBuilder implements PublicationBuilder {
  public readonly kind = 'video';
  public readonly name = 'rat-things/video@1';

  public async plan(
    spec: PublicationSpec,
    files: readonly PublicationSourceFile[],
  ): Promise<Result<PublicationPlan, PublicationDiagnostic[]>> {
    if (spec.kind !== this.kind) return mismatch(this.kind, spec.kind);
    const video = findFile(files, spec.path);
    if (!video) return missing(spec.path);
    if (!video.blob.mediaType.startsWith('video/')) {
      return failure('unsupported_media', `${spec.path} is not a supported video`, spec.path);
    }
    const videoPath = `assets/${basename(video.path)}`;
    const poster = spec.poster ? findFile(files, spec.poster) : undefined;
    if (spec.poster && !poster) return missing(spec.poster);
    if (poster && !poster.blob.mediaType.startsWith('image/')) {
      return failure('unsupported_media', `${spec.poster} is not a supported poster image`, spec.poster);
    }
    const posterPath = poster ? `assets/${basename(poster.path)}` : undefined;
    if (posterPath === videoPath) {
      return failure('path_collision', 'video and poster resolve to the same publication path', video.path);
    }
    return success({
      kind: this.kind,
      entrypoint: 'index.html',
      primaryPath: videoPath,
      files: [
        {
          source: 'generated',
          path: 'index.html',
          bytes: videoViewer(spec.title, video, videoPath, posterPath),
          mediaType: 'text/html; charset=utf-8',
        },
        { source: 'blob', path: videoPath, blob: video.blob },
        ...(poster && posterPath ? [{ source: 'blob' as const, path: posterPath, blob: poster.blob }] : []),
      ],
    });
  }
}

class SitePublicationBuilder implements PublicationBuilder {
  public readonly kind = 'site';
  public readonly name = 'rat-things/site@1';

  public async plan(
    spec: PublicationSpec,
    files: readonly PublicationSourceFile[],
  ): Promise<Result<PublicationPlan, PublicationDiagnostic[]>> {
    if (spec.kind !== this.kind) return mismatch(this.kind, spec.kind);
    const prefix = spec.root ? `${spec.root}/` : '';
    const selected = files
      .filter((file) => !prefix || file.path.startsWith(prefix))
      .map((file) => ({ file, path: prefix ? file.path.slice(prefix.length) : file.path }))
      .filter((file) => file.path);
    if (selected.length === 0) return missing(spec.root ?? 'index.html');
    const entrypoint = spec.entrypoint ?? 'index.html';
    const sourceEntrypoint = `${prefix}${entrypoint}`;
    if (!findFile(files, sourceEntrypoint)) return missing(sourceEntrypoint);

    const planned: PlannedPublicationFile[] = selected.map(({ file, path }) => ({
      source: 'blob',
      path,
      blob: file.blob,
    }));
    if (entrypoint !== 'index.html') {
      if (planned.some((file) => file.path === 'index.html')) {
        return failure('path_collision', 'site already has index.html but declares another entrypoint', sourceEntrypoint);
      }
      planned.push({
        source: 'generated',
        path: 'index.html',
        bytes: redirectViewer(spec.title, entrypoint),
        mediaType: 'text/html; charset=utf-8',
      });
    }
    return success({ kind: this.kind, entrypoint: 'index.html', files: planned });
  }
}

function findFile(files: readonly PublicationSourceFile[], path: string): PublicationSourceFile | undefined {
  return files.find((file) => file.path === path);
}

function success(value: PublicationPlan): Result<PublicationPlan, PublicationDiagnostic[]> {
  const paths = new Set<string>();
  for (const file of value.files) {
    if (paths.has(file.path)) return failure('path_collision', `duplicate publication path ${file.path}`, file.path);
    paths.add(file.path);
  }
  return { ok: true, value };
}

function missing(path: string): Result<PublicationPlan, PublicationDiagnostic[]> {
  return failure('not_found', `publication source ${path} was not found`, path);
}

function mismatch(expected: PublicationKind, actual: PublicationKind): Result<PublicationPlan, PublicationDiagnostic[]> {
  return failure('invalid_request', `${expected} builder cannot publish ${actual}`);
}

function failure(
  code: PublicationDiagnostic['code'],
  message: string,
  path?: string,
): Result<PublicationPlan, PublicationDiagnostic[]> {
  return { ok: false, error: [{ code, message, ...(path ? { path } : {}) }] };
}

function fileViewer(title: string | undefined, file: PublicationSourceFile, assetPath: string): Uint8Array {
  const name = title ?? basename(file.path);
  const href = encodePath(assetPath);
  let preview = `<a class="download" href="${href}" download>Download ${escapeHtml(basename(file.path))}</a>`;
  if (file.blob.mediaType.startsWith('image/')) {
    preview = `<img src="${href}" alt="${escapeHtml(name)}">${preview}`;
  } else if (file.blob.mediaType.startsWith('audio/')) {
    preview = `<audio src="${href}" controls preload="metadata"></audio>${preview}`;
  } else if (file.blob.mediaType === 'application/pdf') {
    preview = `<iframe src="${href}" title="${escapeHtml(name)}"></iframe>${preview}`;
  }
  return htmlDocument(name, preview);
}

function videoViewer(
  title: string | undefined,
  video: PublicationSourceFile,
  videoPath: string,
  posterPath?: string,
): Uint8Array {
  const name = title ?? basename(video.path);
  const poster = posterPath ? ` poster="${encodePath(posterPath)}"` : '';
  return htmlDocument(
    name,
    `<video src="${encodePath(videoPath)}"${poster} controls playsinline preload="metadata"></video>` +
      `<a class="download" href="${encodePath(videoPath)}" download>Download ${escapeHtml(basename(video.path))}</a>`,
  );
}

function redirectViewer(title: string | undefined, entrypoint: string): Uint8Array {
  const href = encodePath(entrypoint);
  const name = title ?? 'Published site';
  return Buffer.from(`<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta http-equiv="refresh" content="0;url=${escapeHtml(href)}">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${escapeHtml(name)}</title></head><body>` +
    `<a href="${escapeHtml(href)}">Open ${escapeHtml(name)}</a></body></html>`);
}

function htmlDocument(title: string, body: string): Uint8Array {
  return Buffer.from(`<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${escapeHtml(title)}</title><style>` +
    `:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;background:#101014;color:#f5f5f7;font:16px system-ui,sans-serif;display:grid;place-items:center}` +
    `main{width:min(1120px,100%);padding:24px;display:grid;gap:20px;text-align:center}h1{font-size:clamp(1.2rem,3vw,2rem);margin:0;overflow-wrap:anywhere}` +
    `img,video,iframe{display:block;max-width:100%;max-height:78vh;margin:auto;border:0;border-radius:12px;background:#08080a}iframe{width:100%;height:78vh}` +
    `audio{width:min(720px,100%);margin:auto}.download{color:#9dccff}</style></head>` +
    `<body><main><h1>${escapeHtml(title)}</h1>${body}</main></body></html>`);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character] as string);
}

function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}
