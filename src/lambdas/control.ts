import type { APIGatewayProxyEventV2, APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { createHash, randomBytes } from 'node:crypto';
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { cloudFrontSignedAccess } from '../adapters/cloudfront-publications.js';
import {
  createAwsClients,
  publicationShareObjectKey,
  S3PublicationGrantStore,
  S3PublicationObjectStore,
} from '../adapters/aws-runtime.js';
import { requiredEnv } from '../adapters/executors.js';
import { apiConversationId } from '../app/conversation-submission.js';
import {
  getConversationService,
  getConversationSubmissionService,
} from '../app/composition.js';
import { ConflictError, NotFoundError } from '../core/run-service.js';
import {
  latestPublicationSourceRunId,
  PublicationPublisher,
  publicationTtlSeconds,
} from '../core/publication-publisher.js';
import { artifactIdForPath, validateArtifactCatalog } from '../domain/artifacts.js';
import type { AgentInput, ArtifactReference, RunRecord } from '../domain/contracts.js';
import type { ArtifactCatalog, PublishedArtifact } from '../domain/contracts.js';
import type { ConversationRecord } from '../domain/conversations.js';
import type {
  PublicationDescriptor,
  PublicationShare,
  PublicationSpec,
  ShareGrant,
} from '../domain/publications.js';
import {
  parsePublicationSpec,
  validatePublicationId,
  validateShareGrant,
} from '../domain/publications.js';
import { isRecord, parseRunRequest, ValidationError } from '../domain/validation.js';
import { apiIngressContext } from '../identity/context.js';
import {
  errorResponse,
  getRunService,
  header,
  jsonBody,
  principal,
  response,
  secretValue,
} from './runtime.js';

const awsClients = createAwsClients();
const artifactClient = awsClients.s3;

interface LegacyArtifactShare {
  version: '1';
  artifact: ArtifactReference;
  published?: PublishedArtifact;
  fallbackName?: string;
  expiresAt: string;
}

type ArtifactShare = LegacyArtifactShare | PublicationShare;

let publicationPrivateKeyPromise: Promise<string> | undefined;

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    const method = event.requestContext.http.method;
    const path = event.rawPath;
    if (method === 'GET' && path === '/health') {
      return response(200, { status: 'ok', service: 'rat-things' });
    }
    const shareToken = sharePathParameter(event);
    if (
      method === 'GET' &&
      shareToken &&
      (
        routeMatches(event, 'GET /v1/shares/{token}', `/v1/shares/${shareToken}`) ||
        routeMatches(event, 'GET /__share/{token}', `/__share/${shareToken}`)
      )
    ) {
      return artifactShareResponse(shareToken);
    }

    const context = apiIngressContext(principal(event));
    const ownerId = context.owner.id;
    const service = getRunService(true);
    const conversationKey = conversationPathParameter(event, 'conversationId');
    const messageId = conversationPathParameter(event, 'messageId', 200);
    if (
      method === 'POST' &&
      conversationKey &&
      routeMatches(
        event,
        'POST /v1/conversations/{conversationId}/messages',
        `/v1/conversations/${conversationKey}/messages`,
      )
    ) {
      const request = apiConversationRequestBody(jsonBody(event));
      const idempotencyKey = requiredIdempotencyKey(header(event.headers, 'idempotency-key'));
      const receipt = await getConversationSubmissionService().submitApi({
        conversationKey,
        messageId: idempotencyKey,
        prompt: request.prompt,
        context,
        traceId: event.requestContext.requestId,
        executionPolicy: {
          ...request.agent,
          sandbox: request.agent?.sandbox ?? 'read-only',
        },
      });
      return response(receipt.status === 'appended' ? 202 : 200, receipt, {
        location: `/v1/conversations/${conversationKey}/messages/${receipt.messageId}`,
      });
    }
    if (
      method === 'GET' &&
      conversationKey &&
      messageId &&
      routeMatches(
        event,
        'GET /v1/conversations/{conversationId}/messages/{messageId}',
        `/v1/conversations/${conversationKey}/messages/${messageId}`,
      )
    ) {
      return response(200, await conversationMessageStatus(
        ownerId,
        conversationKey,
        messageId,
      ));
    }
    const conversationArtifactId = pathParameter(event, 'artifact');
    if (
      method === 'GET' &&
      conversationKey &&
      routeMatches(
        event,
        'GET /v1/conversations/{conversationId}/artifacts',
        `/v1/conversations/${conversationKey}/artifacts`,
      )
    ) {
      const catalog = await conversationArtifactCatalog(ownerId, conversationKey);
      return response(200, { files: catalog.files.map(artifactMetadata) });
    }
    if (
      method === 'GET' &&
      conversationKey &&
      conversationArtifactId &&
      routeMatches(
        event,
        'GET /v1/conversations/{conversationId}/artifacts/{artifact}',
        `/v1/conversations/${conversationKey}/artifacts/${conversationArtifactId}`,
      )
    ) {
      const catalog = await conversationArtifactCatalog(ownerId, conversationKey);
      const published = catalog.files.find((file) => file.id === conversationArtifactId);
      if (!published) throw new ConflictError(`artifact ${conversationArtifactId} is not available`);
      return response(200, await artifactDescriptor(event, ownerId, published.file, published));
    }
    if (
      method === 'POST' &&
      conversationKey &&
      routeMatches(
        event,
        'POST /v1/conversations/{conversationId}/publications',
        `/v1/conversations/${conversationKey}/publications`,
      )
    ) {
      const catalog = await conversationArtifactCatalog(ownerId, conversationKey);
      const spec = parsePublicationSpec(jsonBody(event));
      const sourceRunId = latestPublicationSourceRunId(catalog, spec);
      return response(201, await publishAndShare({
        ownerId,
        spec,
        catalog,
        runId: sourceRunId,
        conversationId: apiConversationId(ownerId, conversationKey),
      }));
    }
    if (method === 'POST' && path === '/v1/runs') {
      const body = jsonBody(event);
      const trustedBody = apiRequestBody(body, context.source);
      const idempotencyKey = header(event.headers, 'idempotency-key');
      const run = await service.submit(ownerId, trustedBody, {
        ...(idempotencyKey ? { idempotencyKey } : {}),
        traceId: event.requestContext.requestId,
        provenance: {
          actor: context.actor,
          credentialSubject: context.credentialSubject,
        },
      });
      return response(202, publicRun(run), { location: `/v1/runs/${run.runId}` });
    }
    if (method === 'GET' && path === '/v1/runs') {
      const limit = parseLimit(event.queryStringParameters?.limit);
      const result = await service.list(ownerId, limit, event.queryStringParameters?.nextToken);
      return response(200, { ...result, items: result.items.map(publicRun) });
    }
    const runId = pathParameter(event, 'runId');
    if (method === 'GET' && runId && path === `/v1/runs/${runId}`) {
      return response(200, publicRun(await service.get(ownerId, runId)));
    }
    if (method === 'GET' && runId && path === `/v1/runs/${runId}/artifacts`) {
      const run = await service.get(ownerId, runId);
      return response(200, { files: (run.result?.artifacts ?? []).map(artifactMetadata) });
    }
    const artifactName = pathParameter(event, 'artifact');
    if (method === 'GET' && runId && artifactName && path === `/v1/runs/${runId}/artifacts/${artifactName}`) {
      const run = await service.get(ownerId, runId);
      const published = run.result?.artifacts?.find((file) => file.id === artifactName);
      const artifact = published?.file ?? artifactFor(run, artifactName);
      if (!artifact) throw new ConflictError(`artifact ${artifactName} is not available`);
      return response(200, await artifactDescriptor(
        event,
        ownerId,
        artifact,
        published,
        artifactName,
        run.runId,
      ));
    }
    if (method === 'POST' && runId && path === `/v1/runs/${runId}/publications`) {
      const run = await service.get(ownerId, runId);
      const catalog: ArtifactCatalog = { version: '1', files: run.result?.artifacts ?? [] };
      const spec = parsePublicationSpec(jsonBody(event));
      return response(201, await publishAndShare({
        ownerId,
        spec,
        catalog,
        runId: run.runId,
      }));
    }
    if (method === 'POST' && runId && path === `/v1/runs/${runId}/cancel`) {
      return response(202, publicRun(await service.cancel(ownerId, runId)));
    }
    return response(404, { error: { code: 'not_found', message: 'route not found' } });
  } catch (error) {
    return errorResponse(error);
  }
};

export function apiRequestBody(body: unknown, source: { kind: 'api' } = { kind: 'api' }): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  return {
    ...(body as Record<string, unknown>),
    // API Gateway request IDs are per-attempt transport metadata. They remain
    // in the queue trace, not the canonical request used for idempotency.
    source,
  };
}

export interface ApiConversationMessageRequest {
  version: '1';
  prompt: string;
  agent?: Pick<AgentInput, 'driver' | 'model' | 'sandbox' | 'reasoningEffort'>;
}

export interface ApiConversationMessageStatus {
  conversationId: string;
  messageId: string;
  state: 'pending' | 'consumed' | 'dead_letter';
  delivery: 'interrupt' | 'defer';
  createdAt: string;
  consumedAt?: string;
  conversation: Pick<
    ConversationRecord,
    'status' | 'pendingCount' | 'createdAt' | 'updatedAt' | 'latestProgress' | 'session'
  >;
  run?: RunRecord;
}

export function apiConversationRequestBody(body: unknown): ApiConversationMessageRequest {
  if (!isRecord(body)) throw new ValidationError('request must be an object');
  const unknown = Object.keys(body).filter((key) => !['version', 'prompt', 'agent'].includes(key));
  if (unknown.length > 0) throw new ValidationError(`request contains unknown field ${unknown[0]}`);
  const parsed = parseRunRequest(body, {
    allowedSandboxModes: (process.env.ALLOWED_SANDBOX_MODES ?? 'read-only,workspace-write')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean) as NonNullable<AgentInput['sandbox']>[],
  });
  if (parsed.agent?.outputSchema) {
    throw new ValidationError('agent.outputSchema is not supported for durable conversations');
  }
  return {
    version: '1',
    prompt: parsed.prompt,
    ...(parsed.agent ? { agent: parsed.agent } : {}),
  };
}

async function conversationMessageStatus(
  ownerId: string,
  conversationKey: string,
  messageId: string,
): Promise<ApiConversationMessageStatus> {
  const runtimeConversationId = apiConversationId(ownerId, conversationKey);
  const conversations = getConversationService();
  const [conversation, message] = await Promise.all([
    conversations.get(runtimeConversationId),
    conversations.getMessage(runtimeConversationId, messageId),
  ]);
  if (!conversation || conversation.ownerId !== ownerId || !message) {
    throw new NotFoundError('conversation message not found');
  }
  const run = message.runId
    ? await getRunService(true).get(ownerId, message.runId)
    : undefined;
  return {
    conversationId: conversationKey,
    messageId,
    state: message.state,
    delivery: message.delivery,
    createdAt: message.createdAt,
    ...(message.consumedAt ? { consumedAt: message.consumedAt } : {}),
    conversation: {
      status: conversation.status,
      pendingCount: conversation.pendingCount,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
      ...(conversation.latestProgress ? { latestProgress: conversation.latestProgress } : {}),
      ...(conversation.session ? { session: conversation.session } : {}),
    },
    ...(run ? { run } : {}),
  };
}

function pathParameter(event: APIGatewayProxyEventV2, name: string): string | undefined {
  const value = event.pathParameters?.[name];
  return value && /^[A-Za-z0-9-]{1,128}$/.test(value) ? value : undefined;
}

function conversationPathParameter(
  event: APIGatewayProxyEventV2,
  name: string,
  maximum = 128,
): string | undefined {
  const value = event.pathParameters?.[name];
  return value && value.length <= maximum && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
    ? value
    : undefined;
}

function routeMatches(
  event: APIGatewayProxyEventV2,
  routeKey: string,
  decodedPath: string,
): boolean {
  return event.routeKey === routeKey || decodeURIComponent(event.rawPath) === decodedPath;
}

function requiredIdempotencyKey(value: string | undefined): string {
  if (!value || !/^[A-Za-z0-9._:-]{1,200}$/.test(value)) {
    throw new ValidationError('Idempotency-Key must be 1-200 safe ASCII characters');
  }
  return value;
}

function parseLimit(value: string | undefined): number {
  if (!value) return 25;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 25;
}

function publicRun(run: RunRecord): RunRecord {
  return run;
}

function artifactFor(run: RunRecord, name: string): ArtifactReference | undefined {
  if (name === 'input') return run.input;
  if (name === 'output') return run.result?.output;
  if (name === 'events') return run.result?.events;
  if (name === 'patch') return run.result?.workspacePatch;
  return undefined;
}

async function conversationArtifactCatalog(
  ownerId: string,
  conversationKey: string,
): Promise<ArtifactCatalog> {
  const conversation = await getConversationService().get(apiConversationId(ownerId, conversationKey));
  if (!conversation || conversation.ownerId !== ownerId) throw new NotFoundError('conversation not found');
  if (!conversation.artifacts) return { version: '1', files: [] };
  if (conversation.artifacts.bucket !== requiredEnv('ARTIFACT_BUCKET')) {
    throw new Error('conversation contains an artifact catalog outside the runtime bucket');
  }
  const result = await artifactClient.send(new GetObjectCommand({
    Bucket: conversation.artifacts.bucket,
    Key: conversation.artifacts.key,
  }));
  if (!result.Body) throw new Error('conversation artifact catalog is empty');
  const catalog = JSON.parse(await result.Body.transformToString('utf8')) as ArtifactCatalog;
  validateArtifactCatalog(catalog);
  return catalog;
}

async function artifactDescriptor(
  event: APIGatewayProxyEventV2,
  ownerId: string,
  artifact: ArtifactReference,
  published?: PublishedArtifact,
  fallbackName?: string,
  sourceRunId?: string,
) {
  const ownerHash = createHash('sha256').update(ownerId).digest('hex').slice(0, 32);
  if (
    artifact.bucket !== requiredEnv('ARTIFACT_BUCKET') ||
    !artifact.key.startsWith(`owners/${ownerHash}/`)
  ) {
    throw new Error('run contains an artifact outside the runtime bucket');
  }
  if (publicationDeliveryConfigured()) {
    const metadata = published ?? await publicationMetadataFor(
      artifact,
      fallbackName ?? 'artifact',
      sourceRunId ?? 'unknown-run',
    );
    const publication = await publishAndShare({
      ownerId,
      spec: { version: '1', kind: 'file', path: metadata.path },
      catalog: { version: '1', files: [metadata] },
      runId: metadata.sourceRunId,
    });
    return {
      ...(published ? artifactMetadata(published) : {
        name: fallbackName,
        mediaType: metadata.mediaType,
        bytes: metadata.bytes,
      }),
      ...publication,
      sha256: artifact.sha256,
    };
  }
  const expiresIn = artifactUrlTtlSeconds(process.env.ARTIFACT_URL_TTL_SECONDS);
  const name = published?.path ?? fallbackName ?? published?.id ?? 'artifact';
  const token = `${ownerHash}-${randomBytes(32).toString('hex')}`;
  const expiresAt = new Date(Date.now() + expiresIn * 1_000).toISOString();
  const share: ArtifactShare = {
    version: '1',
    artifact,
    ...(published ? { published } : {}),
    ...(fallbackName ? { fallbackName } : {}),
    expiresAt,
  };
  await artifactClient.send(new PutObjectCommand({
    Bucket: artifact.bucket,
    Key: publicationShareObjectKey(token),
    Body: JSON.stringify(share),
    ContentType: 'application/json',
    ServerSideEncryption: 'AES256',
  }));
  return {
    ...(published ? artifactMetadata(published) : { name: fallbackName }),
    url: `${apiBaseUrl(event)}/v1/shares/${token}`,
    sha256: artifact.sha256,
    expiresAt,
  };
}

async function publishAndShare(input: {
  ownerId: string;
  spec: PublicationSpec;
  catalog: ArtifactCatalog;
  runId: string;
  conversationId?: string;
}): Promise<PublicationDescriptor> {
  if (!publicationDeliveryConfigured()) {
    throw new ConflictError('publication delivery is not configured for this deployment');
  }
  const bucket = requiredEnv('ARTIFACT_BUCKET');
  return new PublicationPublisher(
    new S3PublicationObjectStore(artifactClient, bucket),
    new S3PublicationGrantStore(artifactClient, bucket),
    {
      artifactBucket: bucket,
      baseDomain: requiredEnv('PUBLICATION_BASE_DOMAIN'),
      ttlSeconds: publicationTtlSeconds(process.env.ARTIFACT_URL_TTL_SECONDS),
    },
  ).publish(input);
}

async function publicationMetadataFor(
  artifact: ArtifactReference,
  path: string,
  sourceRunId: string,
): Promise<PublishedArtifact> {
  const result = await artifactClient.send(new HeadObjectCommand({
    Bucket: artifact.bucket,
    Key: artifact.key,
  }));
  if (result.ContentLength === undefined) throw new Error('artifact size is unavailable');
  return {
    id: artifactIdForPath(path),
    path,
    mediaType: result.ContentType ?? 'application/octet-stream',
    bytes: result.ContentLength,
    createdAt: result.LastModified?.toISOString() ?? new Date().toISOString(),
    sourceRunId,
    file: artifact,
  };
}

function publicationDeliveryConfigured(): boolean {
  const values = [
    process.env.PUBLICATION_BASE_DOMAIN,
    process.env.PUBLICATION_KEY_PAIR_ID,
    process.env.PUBLICATION_PRIVATE_KEY_SECRET_ARN,
  ];
  const configured = values.filter((value) => Boolean(value?.trim())).length;
  if (configured !== 0 && configured !== values.length) {
    throw new Error('publication delivery configuration is incomplete');
  }
  return configured === values.length;
}

function publicationHost(publicationId: string, ownerHash: string): string {
  validatePublicationId(publicationId);
  if (!/^[a-f0-9]{32}$/.test(ownerHash)) throw new Error('publication owner hash is invalid');
  const domain = requiredEnv('PUBLICATION_BASE_DOMAIN').toLowerCase().replace(/^\.+|\.+$/g, '');
  if (
    domain.length > 253 ||
    !domain.includes('.') ||
    domain.split('.').some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  ) throw new Error('PUBLICATION_BASE_DOMAIN is invalid');
  return `${publicationId}-${ownerHash}.${domain}`;
}

async function publicationPrivateKey(): Promise<string> {
  publicationPrivateKeyPromise ??= loadPublicationPrivateKey().catch((error: unknown) => {
    publicationPrivateKeyPromise = undefined;
    throw error;
  });
  return publicationPrivateKeyPromise;
}

async function loadPublicationPrivateKey(): Promise<string> {
  const result = await awsClients.secrets.send(new GetSecretValueCommand({
    SecretId: requiredEnv('PUBLICATION_PRIVATE_KEY_SECRET_ARN'),
  }));
  const raw = result.SecretString ?? (
    result.SecretBinary ? Buffer.from(result.SecretBinary).toString('utf8') : undefined
  );
  if (!raw) throw new Error('publication signing key secret is empty');
  const privateKey = secretValue(raw, ['privateKey', 'private_key', 'key']);
  if (!privateKey.includes('BEGIN PRIVATE KEY') && !privateKey.includes('BEGIN RSA PRIVATE KEY')) {
    throw new Error('publication signing key secret does not contain a PEM private key');
  }
  return privateKey;
}

export function artifactUrlTtlSeconds(configured: string | undefined): number {
  return publicationTtlSeconds(configured);
}

async function artifactShareResponse(token: string) {
  const bucket = requiredEnv('ARTIFACT_BUCKET');
  let raw: string;
  try {
    const result = await artifactClient.send(new GetObjectCommand({
      Bucket: bucket,
      Key: publicationShareObjectKey(token),
    }));
    if (!result.Body) throw new NotFoundError('artifact share not found');
    raw = await result.Body.transformToString('utf8');
  } catch (error) {
    if (error instanceof NotFoundError) throw error;
    if (['NoSuchKey', 'NotFound'].includes(errorName(error))) {
      throw new NotFoundError('artifact share not found');
    }
    throw error;
  }
  const share = parseArtifactShare(raw, bucket, token);
  if (share.version === '2' && share.grant.revokedAt) {
    throw new NotFoundError('artifact share has been revoked');
  }
  const expiresAt = share.version === '2' ? share.grant.expiresAt : share.expiresAt;
  const remainingSeconds = Math.ceil((Date.parse(expiresAt) - Date.now()) / 1_000);
  if (remainingSeconds <= 0) throw new NotFoundError('artifact share has expired');
  if (share.version === '2') {
    const host = publicationHost(share.grant.publicationId, share.grant.ownerHash);
    const target = `https://${host}/`;
    const access = cloudFrontSignedAccess({
      grant: share.grant,
      resource: `https://${host}/*`,
      keyPairId: requiredEnv('PUBLICATION_KEY_PAIR_ID'),
      privateKey: await publicationPrivateKey(),
    }, target);
    return {
      statusCode: 302,
      headers: {
        'cache-control': 'private, no-store',
        location: access.url,
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
      },
      cookies: access.cookies,
      body: '',
    };
  }
  const name = share.published?.path ?? share.fallbackName ?? share.published?.id ?? 'artifact';
  const disposition = isInlineMedia(share.published?.mediaType) ? 'inline' : 'attachment';
  // Lambda role credentials rotate sooner than a 24-hour S3 signature can be
  // trusted to survive, so each share access receives a fresh short redirect.
  const url = await getSignedUrl(
    artifactClient,
    new GetObjectCommand({
      Bucket: share.artifact.bucket,
      Key: share.artifact.key,
      ResponseContentDisposition: `${disposition}; filename*=UTF-8''${encodeURIComponent(name)}`,
      ...(share.published ? { ResponseContentType: share.published.mediaType } : {}),
    }),
    { expiresIn: Math.min(60, remainingSeconds) },
  );
  return {
    statusCode: 302,
    headers: {
      'cache-control': 'private, no-store',
      location: url,
      'x-content-type-options': 'nosniff',
    },
    body: '',
  };
}

function parseArtifactShare(raw: string, bucket: string, token: string): ArtifactShare {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new NotFoundError('artifact share not found');
  }
  if (!isRecord(parsed) || !['1', '2'].includes(String(parsed.version))) {
    throw new NotFoundError('artifact share not found');
  }
  const ownerHash = token.slice(0, 32);
  if (parsed.version === '2') {
    if (
      !isRecord(parsed.grant) ||
      !['file', 'site', 'video'].includes(String(parsed.kind)) ||
      parsed.grant.id !== token ||
      parsed.grant.ownerHash !== ownerHash
    ) throw new NotFoundError('artifact share not found');
    try {
      validateShareGrant(parsed.grant as unknown as ShareGrant);
    } catch {
      throw new NotFoundError('artifact share not found');
    }
    return parsed as unknown as PublicationShare;
  }
  if (!isRecord(parsed.artifact)) throw new NotFoundError('artifact share not found');
  const artifact = parsed.artifact;
  if (
    artifact.bucket !== bucket ||
    typeof artifact.key !== 'string' ||
    !artifact.key.startsWith(`owners/${ownerHash}/`) ||
    typeof artifact.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
    typeof parsed.expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(parsed.expiresAt))
  ) throw new NotFoundError('artifact share not found');
  if (parsed.published !== undefined) {
    validateArtifactCatalog({ version: '1', files: [parsed.published] });
    const published = parsed.published as unknown as PublishedArtifact;
    if (
      published.file.bucket !== artifact.bucket ||
      published.file.key !== artifact.key ||
      published.file.sha256 !== artifact.sha256
    ) throw new NotFoundError('artifact share not found');
  }
  if (
    parsed.fallbackName !== undefined &&
    (typeof parsed.fallbackName !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(parsed.fallbackName))
  ) throw new NotFoundError('artifact share not found');
  return parsed as unknown as ArtifactShare;
}

function sharePathParameter(event: APIGatewayProxyEventV2): string | undefined {
  const token = event.pathParameters?.token;
  return token && /^[a-f0-9]{32}-[a-f0-9]{64}$/.test(token) ? token : undefined;
}

function apiBaseUrl(event: APIGatewayProxyEventV2): string {
  const domain = event.requestContext.domainName;
  if (!domain) throw new Error('API Gateway domain name is unavailable');
  const stage = event.requestContext.stage;
  return `https://${domain}${stage && stage !== '$default' ? `/${stage}` : ''}`;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : '';
}

function artifactMetadata(artifact: PublishedArtifact) {
  return {
    id: artifact.id,
    path: artifact.path,
    mediaType: artifact.mediaType,
    bytes: artifact.bytes,
    createdAt: artifact.createdAt,
    sourceRunId: artifact.sourceRunId,
    sha256: artifact.file.sha256,
  };
}

function isInlineMedia(mediaType: string | undefined): boolean {
  return Boolean(
    mediaType?.startsWith('image/') ||
    mediaType?.startsWith('video/') ||
    mediaType?.startsWith('audio/') ||
    mediaType === 'application/pdf',
  );
}
