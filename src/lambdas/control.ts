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
import { AgentInteractionUnavailableError, requiredEnv } from '../adapters/executors.js';
import { apiConversationId } from '../app/conversation-submission.js';
import {
  RAT_THINGS_OPENAPI,
  RAT_THINGS_SCHEMAS,
  ratThingsDiscovery,
} from '../app/discovery.js';
import { explainThingEnvironment } from '../app/thing-explanation.js';
import {
  getConversationService,
  getAgentInteractionController,
  getConnectionService,
  getIntegrationPluginRegistry,
  getCapabilityProfileRegistry,
  getRoutineService,
  getRunSubmissionService,
  getThingService,
} from '../app/composition.js';
import { ConflictError, NotFoundError } from '../core/run-service.js';
import { publicRoutine } from '../core/routine-service.js';
import { publicThingSummary } from '../core/thing-service.js';
import {
  latestPublicationSourceRunId,
  PublicationPublisher,
  publicationTtlSeconds,
} from '../core/publication-publisher.js';
import { artifactIdForPath, validateArtifactCatalog } from '../domain/artifacts.js';
import type { ArtifactReference, JsonValue, RunRecord, RunRequest } from '../domain/contracts.js';
import type { ArtifactCatalog, PublishedArtifact } from '../domain/contracts.js';
import type { ConversationRecord } from '../domain/conversations.js';
import {
  AGENT_APPROVAL_DECISIONS,
  type AgentApprovalDecision,
  type AgentInteractionTarget,
} from '../domain/interaction.js';
import type { IntegrationCredentialValue } from '../credentials/types.js';
import {
  validateConnectionGrant,
  type ConnectionGrant,
  type IntegrationAuthScheme,
} from '../domain/capabilities.js';
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
    if (method === 'GET' && path === '/.well-known/rat-things') {
      return response(200, ratThingsDiscovery(process.env.RAT_THINGS_DOCS_URL), {
        'cache-control': 'public, max-age=300',
      });
    }
    if (method === 'GET' && path === '/openapi.json') {
      return response(200, RAT_THINGS_OPENAPI, {
        'cache-control': 'public, max-age=300',
      });
    }
    const schema = RAT_THINGS_SCHEMAS[path];
    if (method === 'GET' && schema) {
      return response(200, schema, {
        'cache-control': 'public, max-age=300',
        'content-type': 'application/schema+json; charset=utf-8',
      });
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
    // Most control-plane routes do not need execution control. Keep the
    // MicroVM executor lazy so integration, routine, conversation, and health
    // operations do not depend on MicroVM-only environment configuration.
    const service = () => getRunService(true);
    if (method === 'GET' && path === '/v1/integrations/plugins') {
      return response(200, {
        plugins: getIntegrationPluginRegistry().list().map((plugin) => plugin.manifest),
      });
    }
    if (method === 'GET' && path === '/v1/capability-profiles') {
      return response(200, { profiles: getCapabilityProfileRegistry().list() });
    }
    if (method === 'GET' && path === '/v1/integrations/connections') {
      return response(200, { connections: await getConnectionService().list(ownerId) });
    }
    if (method === 'POST' && path === '/v1/integrations/connections') {
      const input = createConnectionBody(jsonBody(event), ownerId);
      return response(201, await getConnectionService().create(input));
    }
    const integrationConnectionId = conversationPathParameter(event, 'connectionId', 256);
    if (
      method === 'POST' &&
      integrationConnectionId &&
      routeMatches(
        event,
        'POST /v1/integrations/connections/{connectionId}/grant',
        `/v1/integrations/connections/${integrationConnectionId}/grant`,
      )
    ) {
      return response(200, await getConnectionService().replaceGrant(
        ownerId,
        integrationConnectionId,
        grantPolicy(jsonBody(event)),
      ));
    }
    if (
      method === 'POST' &&
      integrationConnectionId &&
      routeMatches(
        event,
        'POST /v1/integrations/connections/{connectionId}/credential',
        `/v1/integrations/connections/${integrationConnectionId}/credential`,
      )
    ) {
      const body = strictBody(jsonBody(event), ['version', 'credential']);
      requireVersion(body.version);
      await getConnectionService().rotate(
        ownerId,
        integrationConnectionId,
        credentialValue(body.credential),
      );
      return response(200, { ok: true, connectionId: integrationConnectionId });
    }
    if (
      method === 'POST' &&
      integrationConnectionId &&
      routeMatches(
        event,
        'POST /v1/integrations/connections/{connectionId}/revoke',
        `/v1/integrations/connections/${integrationConnectionId}/revoke`,
      )
    ) {
      strictBody(jsonBody(event), []);
      return response(200, await getConnectionService().revoke(ownerId, integrationConnectionId));
    }
    if (method === 'GET' && path === '/v1/integrations/connection-sets') {
      return response(200, { connectionSets: await getConnectionService().listSets(ownerId) });
    }
    if (method === 'POST' && path === '/v1/integrations/connection-sets') {
      const body = strictBody(jsonBody(event), ['version', 'name', 'connections', 'defaults']);
      requireVersion(body.version);
      return response(201, await getConnectionService().createSet({
        ownerId,
        name: boundedText(body.name, 'name', 128),
        connections: stringArray(body.connections, 'connections', 128),
        ...(body.defaults !== undefined ? { defaults: stringRecord(body.defaults, 'defaults', 64) } : {}),
      }));
    }
    if (method === 'GET' && path === '/v1/integrations/source-bindings') {
      return response(200, {
        sourceBindings: await getConnectionService().listSourceBindings(ownerId),
      });
    }
    if (method === 'POST' && path === '/v1/integrations/source-bindings') {
      const body = strictBody(jsonBody(event), [
        'version',
        'sourceKind',
        'selector',
        'capabilityProfile',
        'connectionSetId',
      ]);
      requireVersion(body.version);
      const sourceKind = boundedText(body.sourceKind, 'sourceKind', 32);
      if (!['api', 'github', 'gitlab', 'teams', 'slack'].includes(sourceKind)) {
        throw new ValidationError('sourceKind is invalid');
      }
      const capabilityProfile = body.capabilityProfile === undefined
        ? undefined
        : boundedText(body.capabilityProfile, 'capabilityProfile', 256);
      if (capabilityProfile) {
        try {
          getCapabilityProfileRegistry().profile(capabilityProfile);
        } catch {
          throw new ValidationError(`capability profile ${capabilityProfile} is not installed`);
        }
      }
      return response(201, await getConnectionService().createSourceBinding({
        ownerId,
        sourceKind: sourceKind as 'api' | 'github' | 'gitlab' | 'teams' | 'slack',
        selector: stringRecord(body.selector, 'selector', 32),
        ...(capabilityProfile ? { capabilityProfile } : {}),
        ...(body.connectionSetId !== undefined
          ? { connectionSetId: boundedText(body.connectionSetId, 'connectionSetId', 256) }
          : {}),
      }));
    }
    if (method === 'GET' && path === '/v1/things') {
      return response(200, await getThingService().list(
        ownerId,
        parseLimit(event.queryStringParameters?.limit),
        event.queryStringParameters?.nextToken,
        event.queryStringParameters?.includeArchived === 'true',
      ));
    }
    if (method === 'POST' && path === '/v1/things') {
      const thing = await getThingService().create(ownerId, jsonBody(event));
      return response(201, publicThingSummary(thing), {
        location: `/v1/things/${thing.thingId}`,
      });
    }
    const thingId = pathParameter(event, 'thingId');
    if (
      method === 'GET' &&
      thingId &&
      routeMatches(event, 'GET /v1/things/{thingId}', `/v1/things/${thingId}`)
    ) {
      return response(200, await getThingService().getPublic(ownerId, thingId));
    }
    if (
      method === 'GET' &&
      thingId &&
      routeMatches(
        event,
        'GET /v1/things/{thingId}/versions',
        `/v1/things/${thingId}/versions`,
      )
    ) {
      return response(200, {
        versions: await getThingService().listVersions(ownerId, thingId),
      });
    }
    const thingRevision = numericPathParameter(event, 'revision');
    if (
      method === 'GET' &&
      thingId &&
      thingRevision &&
      routeMatches(
        event,
        'GET /v1/things/{thingId}/versions/{revision}',
        `/v1/things/${thingId}/versions/${thingRevision}`,
      )
    ) {
      return response(200, await getThingService().getVersion(ownerId, thingId, thingRevision));
    }
    if (
      method === 'GET' &&
      thingId &&
      routeMatches(
        event,
        'GET /v1/things/{thingId}/explain',
        `/v1/things/${thingId}/explain`,
      )
    ) {
      return response(200, await explainThingEnvironment(
        ownerId,
        await getThingService().explain(
          ownerId,
          thingId,
          thingExplanationTarget(event.queryStringParameters?.target),
        ),
        {
          profiles: getCapabilityProfileRegistry(),
          connections: getConnectionService(),
          plugins: getIntegrationPluginRegistry(),
        },
      ));
    }
    if (
      method === 'POST' &&
      thingId &&
      routeMatches(
        event,
        'POST /v1/things/{thingId}/versions',
        `/v1/things/${thingId}/versions`,
      )
    ) {
      return response(
        201,
        publicThingSummary(await getThingService().addVersion(ownerId, thingId, jsonBody(event))),
      );
    }
    if (
      method === 'POST' &&
      thingId &&
      routeMatches(
        event,
        'POST /v1/things/{thingId}/publish',
        `/v1/things/${thingId}/publish`,
      )
    ) {
      return response(200, publicThingSummary(
        await getThingService().publish(ownerId, thingId, jsonBody(event)),
      ));
    }
    for (const operation of ['pause', 'resume', 'archive'] as const) {
      if (
        method === 'POST' &&
        thingId &&
        routeMatches(
          event,
          `POST /v1/things/{thingId}/${operation}`,
          `/v1/things/${thingId}/${operation}`,
        )
      ) {
        strictBody(jsonBody(event), []);
        return response(200, publicThingSummary(
          operation === 'pause'
              ? await getThingService().pause(ownerId, thingId)
              : operation === 'resume'
                ? await getThingService().resume(ownerId, thingId)
                : await getThingService().archive(ownerId, thingId),
        ));
      }
    }
    if (
      method === 'POST' &&
      thingId &&
      routeMatches(event, 'POST /v1/things/{thingId}/test', `/v1/things/${thingId}/test`)
    ) {
      strictBody(jsonBody(event), []);
      const idempotencyKey = header(event.headers, 'idempotency-key');
      const run = await getThingService().test(
        ownerId,
        thingId,
        ...(idempotencyKey ? [requiredIdempotencyKey(idempotencyKey)] : []),
      );
      return response(202, publicRun(run), { location: `/v1/runs/${run.runId}` });
    }
    if (
      method === 'POST' &&
      thingId &&
      routeMatches(event, 'POST /v1/things/{thingId}/run', `/v1/things/${thingId}/run`)
    ) {
      strictBody(jsonBody(event), []);
      const idempotencyKey = header(event.headers, 'idempotency-key');
      const run = await getThingService().runNow(
        ownerId,
        thingId,
        ...(idempotencyKey ? [requiredIdempotencyKey(idempotencyKey)] : []),
      );
      return response(202, publicRun(run), { location: `/v1/runs/${run.runId}` });
    }
    if (method === 'GET' && path === '/v1/routines') {
      const result = await getRoutineService().list(
        ownerId,
        parseLimit(event.queryStringParameters?.limit),
        event.queryStringParameters?.nextToken,
      );
      return response(200, { ...result, items: result.items.map(publicRoutine) });
    }
    if (method === 'POST' && path === '/v1/routines') {
      const routine = await getRoutineService().create(ownerId, jsonBody(event));
      return response(201, publicRoutine(routine), {
        location: `/v1/routines/${routine.routineId}`,
      });
    }
    const routineId = pathParameter(event, 'routineId');
    if (
      method === 'GET' &&
      routineId &&
      routeMatches(event, 'GET /v1/routines/{routineId}', `/v1/routines/${routineId}`)
    ) {
      return response(200, publicRoutine(await getRoutineService().get(ownerId, routineId)));
    }
    for (const operation of ['pause', 'resume', 'delete'] as const) {
      if (
        method === 'POST' &&
        routineId &&
        routeMatches(
          event,
          `POST /v1/routines/{routineId}/${operation}`,
          `/v1/routines/${routineId}/${operation}`,
        )
      ) {
        strictBody(jsonBody(event), []);
        return response(200, publicRoutine(
          operation === 'pause'
            ? await getRoutineService().pause(ownerId, routineId)
            : operation === 'resume'
              ? await getRoutineService().resume(ownerId, routineId)
              : await getRoutineService().delete(ownerId, routineId),
        ));
      }
    }
    if (
      method === 'POST' &&
      routineId &&
      routeMatches(event, 'POST /v1/routines/{routineId}/run', `/v1/routines/${routineId}/run`)
    ) {
      strictBody(jsonBody(event), []);
      const idempotencyKey = header(event.headers, 'idempotency-key');
      const run = await getRoutineService().runNow(
        ownerId,
        routineId,
        ...(idempotencyKey ? [requiredIdempotencyKey(idempotencyKey)] : []),
      );
      return response(202, publicRun(run), { location: `/v1/runs/${run.runId}` });
    }
    const conversationKey = conversationPathParameter(event, 'conversationId');
    const messageId = conversationPathParameter(event, 'messageId', 200);
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
      const idempotencyKey = header(event.headers, 'idempotency-key');
      const submission = apiRunSubmissionBody(
        body,
        context.source,
        ownerId,
        idempotencyKey,
      );
      const run = await getRunSubmissionService().submit(ownerId, submission.request, {
        ...(idempotencyKey ? { idempotencyKey } : {}),
        traceId: event.requestContext.requestId,
        provenance: {
          actor: context.actor,
          credentialSubject: context.credentialSubject,
        },
        ...(submission.thread ? { thread: submission.thread } : {}),
      });
      return response(202, publicRun(run), { location: `/v1/runs/${run.runId}` });
    }
    if (method === 'GET' && path === '/v1/runs') {
      const limit = parseLimit(event.queryStringParameters?.limit);
      const result = await service().list(ownerId, limit, event.queryStringParameters?.nextToken);
      return response(200, { ...result, items: result.items.map(publicRun) });
    }
    const runId = pathParameter(event, 'runId');
    const agentRequestId = conversationPathParameter(event, 'requestId', 256);
    if (
      method === 'GET' &&
      runId &&
      routeMatches(
        event,
        'GET /v1/runs/{runId}/events',
        `/v1/runs/${runId}/events`,
      )
    ) {
      const target = await agentInteractionTarget(service(), ownerId, runId);
      return response(200, await getAgentInteractionController().events(
        target,
        nonNegativeInteger(event.queryStringParameters?.after, 'after', 0),
        boundedInteger(event.queryStringParameters?.limit, 'limit', 100, 1, 100),
      ));
    }
    if (
      method === 'POST' &&
      runId &&
      routeMatches(event, 'POST /v1/runs/{runId}/steer', `/v1/runs/${runId}/steer`)
    ) {
      const body = strictBody(jsonBody(event), ['prompt']);
      const prompt = boundedText(body.prompt, 'prompt', 12 * 1024);
      await getAgentInteractionController().steer(
        await agentInteractionTarget(service(), ownerId, runId),
        prompt,
      );
      return response(202, { ok: true, operation: 'steer' });
    }
    if (
      method === 'POST' &&
      runId &&
      routeMatches(event, 'POST /v1/runs/{runId}/interrupt', `/v1/runs/${runId}/interrupt`)
    ) {
      strictBody(jsonBody(event), []);
      await getAgentInteractionController().interrupt(
        await agentInteractionTarget(service(), ownerId, runId),
      );
      return response(202, { ok: true, operation: 'interrupt' });
    }
    if (
      method === 'POST' &&
      runId &&
      agentRequestId &&
      routeMatches(
        event,
        'POST /v1/runs/{runId}/approvals/{requestId}',
        `/v1/runs/${runId}/approvals/${agentRequestId}`,
      )
    ) {
      const body = strictBody(jsonBody(event), ['decision', 'reason']);
      const decision = boundedText(body.decision, 'decision', 32) as AgentApprovalDecision;
      if (!AGENT_APPROVAL_DECISIONS.includes(decision)) {
        throw new ValidationError('decision must be accept, accept-for-session, decline, or cancel');
      }
      const reason = body.reason === undefined ? undefined : boundedText(body.reason, 'reason', 1_000);
      await getAgentInteractionController().approve(
        await agentInteractionTarget(service(), ownerId, runId),
        agentRequestId,
        decision,
        reason,
      );
      return response(202, { ok: true, operation: 'approve' });
    }
    if (
      method === 'POST' &&
      runId &&
      agentRequestId &&
      routeMatches(
        event,
        'POST /v1/runs/{runId}/requests/{requestId}/respond',
        `/v1/runs/${runId}/requests/${agentRequestId}/respond`,
      )
    ) {
      const body = strictBody(jsonBody(event), ['result']);
      if (!Object.prototype.hasOwnProperty.call(body, 'result')) {
        throw new ValidationError('result is required');
      }
      await getAgentInteractionController().respond(
        await agentInteractionTarget(service(), ownerId, runId),
        agentRequestId,
        body.result as JsonValue,
      );
      return response(202, { ok: true, operation: 'respond' });
    }
    if (method === 'GET' && runId && path === `/v1/runs/${runId}`) {
      return response(200, publicRun(await service().get(ownerId, runId)));
    }
    if (method === 'GET' && runId && path === `/v1/runs/${runId}/artifacts`) {
      const run = await service().get(ownerId, runId);
      return response(200, { files: (run.result?.artifacts ?? []).map(artifactMetadata) });
    }
    const artifactName = pathParameter(event, 'artifact');
    if (method === 'GET' && runId && artifactName && path === `/v1/runs/${runId}/artifacts/${artifactName}`) {
      const run = await service().get(ownerId, runId);
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
      const run = await service().get(ownerId, runId);
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
      return response(202, publicRun(await service().cancel(ownerId, runId)));
    }
    return errorResponse(new NotFoundError('route not found'), event.requestContext.requestId);
  } catch (error) {
    if (error instanceof AgentInteractionUnavailableError) {
      return errorResponse(new ConflictError(error.message), event.requestContext.requestId);
    }
    return errorResponse(error, event.requestContext.requestId);
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

export function apiRunSubmissionBody(
  body: unknown,
  source: { kind: 'api' },
  ownerId: string,
  idempotencyKey?: string,
): { request: unknown; thread?: { conversationId: string; messageId: string; delivery?: 'interrupt' | 'defer' } } {
  if (!isRecord(body) || body.thread === undefined) {
    return { request: apiRequestBody(body, source) };
  }
  const { thread: rawThread, ...request } = body;
  const thread = strictBody(rawThread, ['key', 'delivery']);
  const key = boundedText(thread.key, 'thread.key', 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(key)) {
    throw new ValidationError('thread.key must be 1-128 safe ASCII characters');
  }
  const messageId = requiredIdempotencyKey(idempotencyKey);
  const delivery = thread.delivery === undefined
    ? undefined
    : boundedText(thread.delivery, 'thread.delivery', 16);
  if (delivery !== undefined && delivery !== 'interrupt' && delivery !== 'defer') {
    throw new ValidationError('thread.delivery must be interrupt or defer');
  }
  return {
    request: apiRequestBody(request, source),
    thread: {
      conversationId: apiConversationId(ownerId, key),
      messageId,
      ...(delivery ? { delivery } : {}),
    },
  };
}

function thingExplanationTarget(value: string | undefined): 'draft' | 'active' {
  if (value === undefined || value === 'draft') return 'draft';
  if (value === 'active') return 'active';
  throw new ValidationError('target must be draft or active');
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
  return value && value.length <= maximum && /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/.test(value)
    ? value
    : undefined;
}

function numericPathParameter(event: APIGatewayProxyEventV2, name: string): number | undefined {
  const value = event.pathParameters?.[name];
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
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

async function agentInteractionTarget(
  service: ReturnType<typeof getRunService>,
  ownerId: string,
  runId: string,
): Promise<AgentInteractionTarget> {
  const run = await service.get(ownerId, runId);
  if (!run.execution || !['dispatching', 'running', 'cancelling'].includes(run.status)) {
    throw new ConflictError('run does not have an active interactive execution');
  }
  return { runId: run.runId, execution: run.execution };
}

function strictBody(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!isRecord(value)) throw new ValidationError('request must be an object');
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw new ValidationError(`request contains unknown field ${unknown}`);
  return value;
}

function boundedText(value: unknown, label: string, maximumBytes: number): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ValidationError(`${label} must be a non-empty string`);
  }
  if (Buffer.byteLength(value, 'utf8') > maximumBytes) {
    throw new ValidationError(`${label} exceeds ${maximumBytes} bytes`);
  }
  return value;
}

function nonNegativeInteger(value: string | undefined, label: string, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ValidationError(`${label} must be a non-negative integer`);
  }
  return parsed;
}

function boundedInteger(
  value: string | undefined,
  label: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ValidationError(`${label} must be an integer from ${minimum} through ${maximum}`);
  }
  return parsed;
}

function createConnectionBody(body: unknown, ownerId: string) {
  const input = strictBody(body, [
    'version',
    'pluginId',
    'alias',
    'authScheme',
    'credential',
    'grant',
  ]);
  requireVersion(input.version);
  const authScheme = boundedText(input.authScheme, 'authScheme', 32);
  if (!['oauth2', 'api-key', 'session', 'basic'].includes(authScheme)) {
    throw new ValidationError('authScheme is invalid');
  }
  return {
    ownerId,
    pluginId: boundedText(input.pluginId, 'pluginId', 64),
    ...(input.alias !== undefined ? { alias: boundedText(input.alias, 'alias', 128) } : {}),
    authScheme: authScheme as IntegrationAuthScheme,
    credential: credentialValue(input.credential),
    grant: grantPolicy(input.grant),
  };
}

function credentialValue(value: unknown): IntegrationCredentialValue {
  const input = strictBody(value, Object.keys(isRecord(value) ? value : {}));
  const result: IntegrationCredentialValue = {};
  for (const [key, item] of Object.entries(input)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)) {
      throw new ValidationError(`credential field ${key} is invalid`);
    }
    result[key] = boundedText(item, `credential.${key}`, 32_768);
  }
  if (Object.keys(result).length === 0) throw new ValidationError('credential requires at least one field');
  return result;
}

function grantPolicy(
  value: unknown,
): Omit<ConnectionGrant, 'version' | 'grantId' | 'ownerId' | 'connectionId'> {
  const input = strictBody(value, [
    'version',
    'preset',
    'allowOperations',
    'denyOperations',
    'approvalOverrides',
    'resourceConstraints',
    'expiresAt',
  ]);
  requireVersion(input.version);
  const preset = boundedText(input.preset, 'preset', 32) as ConnectionGrant['preset'];
  if (!['read-only', 'read-write', 'full', 'custom'].includes(preset)) {
    throw new ValidationError('preset is invalid');
  }
  let validated: ConnectionGrant;
  try {
    validated = validateConnectionGrant({
      version: '1',
      grantId: 'validation-grant',
      ownerId: 'validation-owner',
      connectionId: 'validation-connection',
      preset,
      ...(input.allowOperations !== undefined
        ? { allowOperations: stringArray(input.allowOperations, 'allowOperations', 128) }
        : {}),
      ...(input.denyOperations !== undefined
        ? { denyOperations: stringArray(input.denyOperations, 'denyOperations', 128) }
        : {}),
      ...(input.approvalOverrides !== undefined
        ? { approvalOverrides: approvalOverrides(input.approvalOverrides) }
        : {}),
      ...(input.resourceConstraints !== undefined
        ? { resourceConstraints: resourceConstraints(input.resourceConstraints) }
        : {}),
      ...(input.expiresAt !== undefined
        ? { expiresAt: boundedText(input.expiresAt, 'expiresAt', 64) }
        : {}),
    });
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    throw new ValidationError(error instanceof Error ? error.message : 'grant policy is invalid');
  }
  const { version: _version, grantId: _grantId, ownerId: _ownerId, connectionId: _connectionId, ...policy } = validated;
  return policy;
}

function approvalOverrides(value: unknown): NonNullable<ConnectionGrant['approvalOverrides']> {
  if (!Array.isArray(value) || value.length > 128) {
    throw new ValidationError('approvalOverrides must be an array with at most 128 entries');
  }
  return value.map((candidate, index) => {
    const item = strictBody(candidate, ['operationId', 'approval']);
    const approval = boundedText(item.approval, `approvalOverrides[${index}].approval`, 32);
    if (!['never', 'on-request', 'always'].includes(approval)) {
      throw new ValidationError(`approvalOverrides[${index}].approval is invalid`);
    }
    return {
      operationId: boundedText(
        item.operationId,
        `approvalOverrides[${index}].operationId`,
        256,
      ),
      approval: approval as NonNullable<ConnectionGrant['approvalOverrides']>[number]['approval'],
    };
  });
}

function resourceConstraints(value: unknown): NonNullable<ConnectionGrant['resourceConstraints']> {
  if (!isRecord(value) || Object.keys(value).length > 64) {
    throw new ValidationError('resourceConstraints must be an object with at most 64 entries');
  }
  return Object.fromEntries(Object.entries(value).map(([field, allowed]) => [
    boundedText(field, 'resourceConstraints field', 256),
    stringArray(allowed, `resourceConstraints.${field}`, 256),
  ]));
}

function requireVersion(value: unknown): void {
  if (value !== '1') throw new ValidationError('version must be "1"');
}

function stringArray(value: unknown, label: string, maximum: number): string[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new ValidationError(`${label} must be an array with at most ${maximum} entries`);
  }
  return value.map((item, index) => boundedText(item, `${label}[${index}]`, 512));
}

function stringRecord(value: unknown, label: string, maximum: number): Record<string, string> {
  if (!isRecord(value) || Object.keys(value).length > maximum) {
    throw new ValidationError(`${label} must be an object with at most ${maximum} entries`);
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    boundedText(key, `${label} key`, 256),
    boundedText(item, `${label}.${key}`, 512),
  ]));
}

function publicRun<TRun extends RunRecord>(run: TRun): TRun {
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
