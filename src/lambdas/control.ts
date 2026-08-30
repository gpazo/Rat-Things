import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyHandlerV2,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import { createHash } from 'node:crypto';
import { GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
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
  MAX_CONVERSATION_UPLOAD_FILES,
  MAX_CONVERSATION_UPLOAD_FILE_BYTES,
  MAX_CONVERSATION_UPLOAD_TOTAL_BYTES,
} from '../conversation/service.js';
import {
  RAT_THINGS_OPENAPI,
  RAT_THINGS_SCHEMAS,
  ratThingsDiscovery,
} from '../app/discovery.js';
import { explainThingEnvironment } from '../app/thing-explanation.js';
import {
  getConversationService,
  getAgentInteractionController,
  getConnectionConsumerService,
  getConnectionService,
  getIntegrationPluginRegistry,
  getCapabilityProfileRegistry,
  getOAuthAuthorizationService,
  getRoutineService,
  getRunSubmissionService,
  getThingService,
} from '../app/composition.js';
import { ConflictError, NotFoundError } from '../core/run-service.js';
import {
  projectPublicConversation,
  projectPublicConversationDetail,
  projectPublicConversationSearchHit,
  type PublicConversationSummary,
} from '../core/conversation-projection.js';
import { projectPublicRun, type PublicRunRecord } from '../core/run-projection.js';
import { projectPublicAgentRuntime } from '../core/agent-activity-projection.js';
import { publicRoutine } from '../core/routine-service.js';
import { publicThingSummary } from '../core/thing-service.js';
import {
  latestPublicationSourceRunId,
  PublicationPublisher,
  publicationTtlSeconds,
} from '../core/publication-publisher.js';
import { artifactIdForPath, validateArtifactCatalog } from '../domain/artifacts.js';
import type { ArtifactReference, JsonValue, RunRecord } from '../domain/contracts.js';
import type { ArtifactCatalog, PublishedArtifact } from '../domain/contracts.js';
import type { ConversationRecord } from '../domain/conversations.js';
import { CONVERSATION_REACTION_EMOJIS, type ConversationReactionEmoji } from '../domain/conversations.js';
import type { AgentInteractionTarget, HumanBrowserAction } from '../domain/interaction.js';
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
import { parseOAuthApplicationSecretArns } from '../plugins/oauth.js';
import {
  parsePublicationSpec,
  validateShareGrant,
  validatePublicationId,
} from '../domain/publications.js';
import {
  isRecord,
  rejectUnknown,
  requiredRecord,
  ValidationError,
} from '../domain/validation.js';
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
    if (method === 'GET' && path === '/v1/integrations/oauth/callback') {
      try {
        await getOAuthAuthorizationService().complete({
          state: event.queryStringParameters?.state ?? '',
          ...(event.queryStringParameters?.code
            ? { code: event.queryStringParameters.code }
            : {}),
          ...(event.queryStringParameters?.error
            ? { providerError: event.queryStringParameters.error }
            : {}),
        });
        return oauthCallbackResponse(true, event.requestContext.requestId);
      } catch (error) {
        console.warn(JSON.stringify({
          level: 'warn',
          message: 'OAuth callback failed',
          error: error instanceof Error ? { name: error.name, message: error.message.slice(0, 500) } : {},
          requestId: event.requestContext.requestId,
        }));
        return oauthCallbackResponse(false, event.requestContext.requestId);
      }
    }
    const shareToken = sharePathParameter(event);
    if (
      method === 'GET' &&
      shareToken &&
      routeMatches(event, 'GET /__share/{token}', `/__share/${shareToken}`)
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
      const oauthApplicationSecretArns = parseOAuthApplicationSecretArns(
        process.env.INTEGRATION_OAUTH_APP_SECRET_ARNS,
      );
      const callbackUrl = oauthCallbackUrl(event);
      return response(200, {
        plugins: getIntegrationPluginRegistry().list().map((plugin) => ({
          ...plugin.manifest,
          ...(plugin.manifest.authentication.some((authentication) => authentication.oauth2)
            ? {
              oauthInstallation: {
                status: oauthApplicationSecretArns[plugin.manifest.id]
                  ? 'configured'
                  : 'host-required',
                callbackUrl,
              },
            }
            : {}),
        })),
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
    if (method === 'POST' && path === '/v1/integrations/oauth/authorizations') {
      const body = strictBody(jsonBody(event), ['version', 'pluginId', 'alias', 'grant']);
      requireVersion(body.version);
      return response(201, await getOAuthAuthorizationService().start({
        ownerId,
        pluginId: boundedText(body.pluginId, 'pluginId', 64),
        callbackUrl: oauthCallbackUrl(event),
        grant: grantPolicy(body.grant),
        ...(body.alias !== undefined ? { alias: boundedText(body.alias, 'alias', 128) } : {}),
      }));
    }
    const integrationConnectionId = conversationPathParameter(event, 'connectionId', 256);
    if (
      method === 'GET' &&
      integrationConnectionId &&
      routeMatches(
        event,
        'GET /v1/integrations/connections/{connectionId}',
        `/v1/integrations/connections/${integrationConnectionId}`,
      )
    ) {
      return response(200, await getConnectionService().get(ownerId, integrationConnectionId));
    }
    if (
      method === 'PATCH' &&
      integrationConnectionId &&
      routeMatches(
        event,
        'PATCH /v1/integrations/connections/{connectionId}',
        `/v1/integrations/connections/${integrationConnectionId}`,
      )
    ) {
      const body = strictBody(jsonBody(event), ['version', 'displayName']);
      requireVersion(body.version);
      return response(200, await getConnectionService().rename(
        ownerId,
        integrationConnectionId,
        boundedText(body.displayName, 'displayName', 256),
      ));
    }
    if (
      method === 'POST' &&
      integrationConnectionId &&
      routeMatches(
        event,
        'POST /v1/integrations/connections/{connectionId}/test',
        `/v1/integrations/connections/${integrationConnectionId}/test`,
      )
    ) {
      strictBody(jsonBody(event), []);
      return response(200, await getConnectionService().test(ownerId, integrationConnectionId));
    }
    if (
      method === 'GET' &&
      integrationConnectionId &&
      routeMatches(
        event,
        'GET /v1/integrations/connections/{connectionId}/consumers',
        `/v1/integrations/connections/${integrationConnectionId}/consumers`,
      )
    ) {
      return response(200, await getConnectionConsumerService().list(ownerId, integrationConnectionId));
    }
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
        'POST /v1/integrations/connections/{connectionId}/oauth/reconnect',
        `/v1/integrations/connections/${integrationConnectionId}/oauth/reconnect`,
      )
    ) {
      const body = strictBody(jsonBody(event), ['version']);
      requireVersion(body.version);
      return response(201, await getOAuthAuthorizationService().startReconnect({
        ownerId,
        connectionIdOrAlias: integrationConnectionId,
        callbackUrl: oauthCallbackUrl(event),
      }));
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
      return response(200, await getConnectionService().rotate(
        ownerId,
        integrationConnectionId,
        credentialValue(body.credential),
      ));
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
      conversationArtifactId &&
      routeMatches(
        event,
        'GET /v1/conversations/{conversationId}/artifacts/{artifact}/content',
        `/v1/conversations/${conversationKey}/artifacts/${conversationArtifactId}/content`,
      )
    ) {
      const { catalog } = await conversationArtifactContext(ownerId, conversationKey);
      const published = catalog.files.find((file) => file.id === conversationArtifactId);
      if (!published) throw new ConflictError(`artifact ${conversationArtifactId} is not available`);
      const descriptor = await artifactDescriptor(ownerId, published.file, published) as { url?: string };
      if (!descriptor.url) throw new ConflictError('artifact does not have a private viewer URL');
      return {
        statusCode: 302,
        headers: {
          'cache-control': 'private, no-store',
          location: descriptor.url,
          'referrer-policy': 'no-referrer',
          'x-content-type-options': 'nosniff',
        },
        body: '',
      };
    }
    if (
      method === 'GET' &&
      conversationKey &&
      routeMatches(
        event,
        'GET /v1/conversations/{conversationId}/artifacts',
        `/v1/conversations/${conversationKey}/artifacts`,
      )
    ) {
      const { catalog } = await conversationArtifactContext(ownerId, conversationKey);
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
      const { catalog } = await conversationArtifactContext(ownerId, conversationKey);
      const published = catalog.files.find((file) => file.id === conversationArtifactId);
      if (!published) throw new ConflictError(`artifact ${conversationArtifactId} is not available`);
      return response(200, await artifactDescriptor(ownerId, published.file, published));
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
      const { catalog, conversation } = await conversationArtifactContext(ownerId, conversationKey);
      const spec = parsePublicationSpec(jsonBody(event));
      const sourceRunId = latestPublicationSourceRunId(catalog, spec);
      return response(201, await publishAndShare({
        ownerId,
        spec,
        catalog,
        runId: sourceRunId,
        conversationId: conversation.conversationId,
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
    if (method === 'GET' && path === '/v1/conversations') {
      const limit = parseLimit(event.queryStringParameters?.limit);
      const result = await getConversationService().list(
        ownerId,
        limit,
        event.queryStringParameters?.nextToken,
        conversationVisibility(event.queryStringParameters?.visibility),
      );
      return response(200, {
        ...result,
        items: result.items.map(projectPublicConversation),
      });
    }
    if (method === 'GET' && path === '/v1/conversations/search') {
      const query = boundedText(event.queryStringParameters?.q, 'q', 512);
      const hits = await getConversationService().search(
        ownerId,
        query,
        boundedInteger(event.queryStringParameters?.limit, 'limit', 20, 1, 50),
      );
      return response(200, {
        query,
        items: hits.map(projectPublicConversationSearchHit),
      });
    }
    const publicConversationId = pathParameter(event, 'conversationId');
    if (
      method === 'POST' &&
      publicConversationId &&
      messageId &&
      routeMatches(
        event,
        'POST /v1/conversations/{conversationId}/messages/{messageId}/reactions',
        `/v1/conversations/${publicConversationId}/messages/${messageId}/reactions`,
      )
    ) {
      const body = strictBody(jsonBody(event), ['emoji', 'reacted']);
      const emoji = boundedText(body.emoji, 'emoji', 16) as ConversationReactionEmoji;
      if (!CONVERSATION_REACTION_EMOJIS.includes(emoji)) {
        throw new ValidationError('emoji must be one of 👍, ❤️, 🎉, or 👀');
      }
      if (typeof body.reacted !== 'boolean') throw new ValidationError('reacted must be a boolean');
      const found = await getConversationService().setReaction(
        ownerId,
        publicConversationId,
        messageId,
        emoji,
        body.reacted,
      );
      if (!found) throw new NotFoundError('conversation not found');
      return response(200, { emoji, reacted: body.reacted });
    }
    if (
      method === 'POST' &&
      publicConversationId &&
      routeMatches(
        event,
        'POST /v1/conversations/{conversationId}/organization',
        `/v1/conversations/${publicConversationId}/organization`,
      )
    ) {
      const updated = await getConversationService().updateOrganization(
        ownerId,
        publicConversationId,
        conversationOrganizationUpdate(jsonBody(event)),
      );
      if (!updated) throw new NotFoundError('conversation not found');
      return response(200, projectPublicConversation(updated));
    }
    if (
      method === 'GET' &&
      publicConversationId &&
      routeMatches(
        event,
        'GET /v1/conversations/{conversationId}',
        `/v1/conversations/${publicConversationId}`,
      )
    ) {
      const detail = await getConversationService().getPublicDetail(ownerId, publicConversationId, {
        limit: boundedInteger(event.queryStringParameters?.limit, 'limit', 50, 1, 100),
        ...(event.queryStringParameters?.nextToken
          ? { nextToken: event.queryStringParameters.nextToken }
          : {}),
      });
      if (!detail) throw new NotFoundError('conversation not found');
      return response(200, projectPublicConversationDetail(
        detail.conversation,
        detail.checkpoint,
        detail.transcript,
        detail.activeTurn,
      ));
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
      return response(200, projectPublicAgentRuntime(
        await getAgentInteractionController().events(
          target,
          nonNegativeInteger(event.queryStringParameters?.after, 'after', 0),
          boundedInteger(event.queryStringParameters?.limit, 'limit', 100, 1, 100),
        ),
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
    if (
      method === 'GET' &&
      runId &&
      routeMatches(event, 'GET /v1/runs/{runId}/computer', `/v1/runs/${runId}/computer`)
    ) {
      return response(200, await getAgentInteractionController().computer(
        await agentInteractionTarget(service(), ownerId, runId),
      ));
    }
    if (
      method === 'POST' &&
      runId &&
      routeMatches(
        event,
        'POST /v1/runs/{runId}/computer/takeover',
        `/v1/runs/${runId}/computer/takeover`,
      )
    ) {
      const body = strictBody(jsonBody(event), ['control']);
      if (body.control !== 'human' && body.control !== 'agent') {
        throw new ValidationError('control must be human or agent');
      }
      const controller = getAgentInteractionController();
      const target = await agentInteractionTarget(service(), ownerId, runId);
      return response(200, body.control === 'human'
        ? await controller.takeComputer(target)
        : await controller.returnComputer(target));
    }
    if (
      method === 'POST' &&
      runId &&
      routeMatches(
        event,
        'POST /v1/runs/{runId}/computer/action',
        `/v1/runs/${runId}/computer/action`,
      )
    ) {
      const body = strictBody(jsonBody(event), ['action']);
      return response(200, await getAgentInteractionController().actOnComputer(
        await agentInteractionTarget(service(), ownerId, runId),
        humanBrowserAction(body.action),
      ));
    }
    if (
      method === 'POST' &&
      runId &&
      routeMatches(
        event,
        'POST /v1/runs/{runId}/computer/teach',
        `/v1/runs/${runId}/computer/teach`,
      )
    ) {
      const body = strictBody(jsonBody(event), ['action', 'name', 'goal', 'discard']);
      if (body.action === 'start') {
        strictBody(body, ['action', 'name', 'goal']);
        return response(200, await getAgentInteractionController().startTeaching(
          await agentInteractionTarget(service(), ownerId, runId),
          {
            name: boundedText(body.name, 'name', 120),
            ...(body.goal === undefined ? {} : { goal: boundedText(body.goal, 'goal', 4_000) }),
          },
        ));
      }
      if (body.action === 'stop') {
        strictBody(body, ['action', 'discard']);
        if (typeof body.discard !== 'boolean') {
          throw new ValidationError('discard must be boolean');
        }
        const recording = await getAgentInteractionController().stopTeaching(
          await agentInteractionTarget(service(), ownerId, runId),
          body.discard,
        );
        if (!recording.draft) return response(200, { recording });
        const { draft, ...recordingSummary } = recording;
        const created = await getThingService().create(ownerId, draft);
        return response(201, {
          recording: recordingSummary,
          thing: await getThingService().getPublic(ownerId, created.thingId),
        });
      }
      throw new ValidationError('action must be start or stop');
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
): {
  request: unknown;
  thread?: {
    conversationId: string;
    messageId: string;
    delivery?: 'interrupt' | 'defer';
    attachments?: Array<{ name: string; mediaType: string; bytes: Uint8Array; sha256: string }>;
    replyToMessageId?: string;
  };
} {
  if (!isRecord(body) || body.thread === undefined) {
    return { request: apiRequestBody(body, source) };
  }
  const { thread: rawThread, ...request } = body;
  const thread = strictBody(rawThread, ['key', 'delivery', 'attachments', 'replyToMessageId']);
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
  const attachments = parseConversationAttachments(thread.attachments);
  const replyToMessageId = thread.replyToMessageId === undefined
    ? undefined
    : boundedText(thread.replyToMessageId, 'thread.replyToMessageId', 512);
  return {
    request: apiRequestBody(request, source),
    thread: {
      conversationId: apiConversationId(ownerId, key),
      messageId,
      ...(delivery ? { delivery } : {}),
      ...(attachments.length ? { attachments } : {}),
      ...(replyToMessageId ? { replyToMessageId } : {}),
    },
  };
}

function parseConversationAttachments(
  value: unknown,
): Array<{ name: string; mediaType: string; bytes: Uint8Array; sha256: string }> {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_CONVERSATION_UPLOAD_FILES) {
    throw new ValidationError(`thread.attachments must contain at most ${MAX_CONVERSATION_UPLOAD_FILES} files`);
  }
  let totalBytes = 0;
  return value.map((candidate, index) => {
    const input = strictBody(candidate, ['name', 'mediaType', 'base64', 'sha256']);
    const name = boundedText(input.name, `thread.attachments[${index}].name`, 255);
    if (name === '.' || name === '..' || /[\\/\0-\x1f\x7f]/.test(name)) {
      throw new ValidationError(`thread.attachments[${index}].name is invalid`);
    }
    const mediaType = boundedText(
      input.mediaType ?? 'application/octet-stream',
      `thread.attachments[${index}].mediaType`,
      128,
    ).toLowerCase();
    if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mediaType)) {
      throw new ValidationError(`thread.attachments[${index}].mediaType is invalid`);
    }
    const base64 = boundedText(
      input.base64,
      `thread.attachments[${index}].base64`,
      Math.ceil(MAX_CONVERSATION_UPLOAD_FILE_BYTES * 4 / 3) + 8,
    );
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) {
      throw new ValidationError(`thread.attachments[${index}].base64 is invalid`);
    }
    const bytes = Buffer.from(base64, 'base64');
    if (bytes.byteLength > MAX_CONVERSATION_UPLOAD_FILE_BYTES) {
      throw new ValidationError(`thread.attachments[${index}] exceeds ${MAX_CONVERSATION_UPLOAD_FILE_BYTES} bytes`);
    }
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_CONVERSATION_UPLOAD_TOTAL_BYTES) {
      throw new ValidationError(`thread.attachments exceed ${MAX_CONVERSATION_UPLOAD_TOTAL_BYTES} bytes`);
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (input.sha256 !== undefined && input.sha256 !== sha256) {
      throw new ValidationError(`thread.attachments[${index}].sha256 does not match its content`);
    }
    return { name, mediaType, bytes, sha256 };
  });
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
    PublicConversationSummary,
    'status' | 'pendingCount' | 'createdAt' | 'updatedAt' | 'latestProgress' | 'session'
  >;
  run?: PublicRunRecord;
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
  const projected = projectPublicConversation(conversation);
  return {
    conversationId: conversationKey,
    messageId,
    state: message.state,
    delivery: message.delivery,
    createdAt: message.createdAt,
    ...(message.consumedAt ? { consumedAt: message.consumedAt } : {}),
    conversation: {
      status: projected.status,
      pendingCount: projected.pendingCount,
      createdAt: projected.createdAt,
      updatedAt: projected.updatedAt,
      ...(projected.latestProgress ? { latestProgress: projected.latestProgress } : {}),
      ...(projected.session ? { session: projected.session } : {}),
    },
    ...(run ? { run: projectPublicRun(run) } : {}),
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

function conversationVisibility(value: string | undefined): 'visible' | 'hidden' | 'all' {
  if (value === undefined || value === 'visible') return 'visible';
  if (value === 'hidden' || value === 'all') return value;
  throw new ValidationError('visibility must be visible, hidden, or all');
}

function conversationOrganizationUpdate(
  value: unknown,
): { pinned?: boolean; hidden?: boolean; read?: boolean } {
  const body = strictBody(value, ['pinned', 'hidden', 'read']);
  const update: { pinned?: boolean; hidden?: boolean; read?: boolean } = {};
  for (const key of ['pinned', 'hidden', 'read'] as const) {
    if (!(key in body)) continue;
    if (typeof body[key] !== 'boolean') throw new ValidationError(`${key} must be a boolean`);
    update[key] = body[key];
  }
  if (Object.keys(update).length === 0) {
    throw new ValidationError('organization update requires pinned, hidden, or read');
  }
  return update;
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
  const input = requiredRecord(value, 'request');
  rejectUnknown(input, allowed, 'request');
  return input;
}

function oauthCallbackUrl(event: APIGatewayProxyEventV2): string {
  const domain = event.requestContext.domainName;
  if (
    typeof domain !== 'string' ||
    !/^[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/.test(domain) ||
    domain.includes('..')
  ) throw new ValidationError('OAuth callback host is invalid');
  return `https://${domain}/v1/integrations/oauth/callback`;
}

function oauthCallbackResponse(
  succeeded: boolean,
  requestId: string,
): APIGatewayProxyStructuredResultV2 {
  const title = succeeded ? 'Connection installed' : 'Connection not installed';
  const detail = succeeded
    ? 'The provider account is connected to this Rat Things deployment. You can close this window and return to the console.'
    : 'Rat Things could not complete this authorization. Close this window, verify the OAuth application configuration, and try again.';
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>:root{color-scheme:dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0c0f0c;color:#edf2e8;font:16px/1.55 system-ui,sans-serif}.card{width:min(560px,calc(100vw - 40px));padding:32px;border:1px solid #30382f;border-radius:16px;background:#151a15;box-shadow:0 28px 80px #0008}.mark{display:grid;width:44px;height:44px;place-items:center;margin-bottom:24px;border-radius:12px;background:#b9df68;color:#11170d;font-weight:850}h1{margin:0 0 10px;color:#edf2e8;font-size:24px}p{margin:0;color:#aab3a4}.request{margin-top:20px;color:#7f897a;font:12px ui-monospace,monospace}</style></head><body><main class="card"><div class="mark">R</div><h1>${title}</h1><p>${detail}</p><p class="request">Request ${requestId.replace(/[^A-Za-z0-9-]/g, '').slice(0, 128)}</p></main></body></html>`;
  return {
    statusCode: succeeded ? 200 : 400,
    headers: {
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      'content-type': 'text/html; charset=utf-8',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
    },
    body,
  };
}

function humanBrowserAction(value: unknown): HumanBrowserAction {
  const action = strictBody(value, browserActionFields(value));
  switch (action.type) {
    case 'navigate':
      return { type: 'navigate', url: boundedText(action.url, 'action.url', 4_096) };
    case 'click':
      return {
        type: 'click',
        ...(action.ref === undefined ? {} : { ref: boundedText(action.ref, 'action.ref', 16) }),
        ...(action.x === undefined ? {} : { x: boundedNumber(action.x, 'action.x', 0, 1_280) }),
        ...(action.y === undefined ? {} : { y: boundedNumber(action.y, 'action.y', 0, 720) }),
      };
    case 'type':
      return {
        type: 'type',
        ...(action.ref === undefined ? {} : { ref: boundedText(action.ref, 'action.ref', 16) }),
        text: textValue(action.text, 'action.text', 20_000),
        ...(action.clear === undefined ? {} : { clear: booleanValue(action.clear, 'action.clear') }),
        ...(action.submit === undefined ? {} : { submit: booleanValue(action.submit, 'action.submit') }),
      };
    case 'press':
      return { type: 'press', key: boundedText(action.key, 'action.key', 64) };
    case 'select':
      return {
        type: 'select',
        ref: boundedText(action.ref, 'action.ref', 16),
        value: textValue(action.value, 'action.value', 2_000),
      };
    case 'scroll':
      return {
        type: 'scroll',
        ...(action.deltaX === undefined
          ? {}
          : { deltaX: boundedNumber(action.deltaX, 'action.deltaX', -5_000, 5_000) }),
        deltaY: boundedNumber(action.deltaY, 'action.deltaY', -5_000, 5_000),
      };
    case 'wait':
      return {
        type: 'wait',
        milliseconds: boundedNumber(action.milliseconds, 'action.milliseconds', 0, 10_000, true),
      };
    case 'back':
      return { type: 'back' };
    default:
      throw new ValidationError('action.type is not an available human browser action');
  }
}

function browserActionFields(value: unknown): string[] {
  if (!isRecord(value) || typeof value.type !== 'string') {
    throw new ValidationError('action must be an object with a type');
  }
  const fields: Record<string, string[]> = {
    navigate: ['type', 'url'],
    click: ['type', 'ref', 'x', 'y'],
    type: ['type', 'ref', 'text', 'clear', 'submit'],
    press: ['type', 'key'],
    select: ['type', 'ref', 'value'],
    scroll: ['type', 'deltaX', 'deltaY'],
    wait: ['type', 'milliseconds'],
    back: ['type'],
  };
  return fields[value.type] ?? ['type'];
}

function boundedNumber(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
  integer = false,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    (integer && !Number.isInteger(value)) ||
    value < minimum ||
    value > maximum
  ) throw new ValidationError(`${label} is invalid`);
  return value;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new ValidationError(`${label} must be boolean`);
  return value;
}

function textValue(value: unknown, label: string, maximumBytes: number): string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > maximumBytes) {
    throw new ValidationError(`${label} is invalid`);
  }
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

function publicRun(run: RunRecord) {
  return projectPublicRun(run);
}

function artifactFor(run: RunRecord, name: string): ArtifactReference | undefined {
  if (name === 'input') return run.input;
  if (name === 'output') return run.result?.output;
  if (name === 'events') return run.result?.events;
  if (name === 'patch') return run.result?.workspacePatch;
  return undefined;
}

async function conversationArtifactContext(
  ownerId: string,
  conversationSelector: string,
): Promise<{ catalog: ArtifactCatalog; conversation: ConversationRecord }> {
  const publicConversation = /^[a-f0-9]{64}$/.test(conversationSelector)
    ? await getConversationService().getByPublicId(ownerId, conversationSelector)
    : undefined;
  const conversation = publicConversation ?? await getConversationService().get(
    apiConversationId(ownerId, conversationSelector),
  );
  if (!conversation || conversation.ownerId !== ownerId) throw new NotFoundError('conversation not found');
  if (!conversation.artifacts) return { catalog: { version: '1', files: [] }, conversation };
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
  return { catalog, conversation };
}

async function artifactDescriptor(
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
  const metadata = published ?? await publicationMetadataFor(
    artifact,
    fallbackName ?? 'artifact',
    sourceRunId ?? 'unknown-run',
  );
  if (publicationDeliveryConfigured()) {
    const publication = await publishAndShare({
      ownerId,
      spec: { version: '1', kind: 'file', path: metadata.path },
      catalog: { version: '1', files: [metadata] },
      runId: metadata.sourceRunId,
    });
    return {
      ...artifactMetadata(metadata),
      ...publication,
    };
  }
  const expiresIn = 60;
  const disposition = isInlineMedia(metadata.mediaType) ? 'inline' : 'attachment';
  const url = await getSignedUrl(
    artifactClient,
    new GetObjectCommand({
      Bucket: artifact.bucket,
      Key: artifact.key,
      ResponseContentDisposition: `${disposition}; filename*=UTF-8''${encodeURIComponent(metadata.path)}`,
      ResponseContentType: metadata.mediaType,
    }),
    { expiresIn },
  );
  return {
    ...artifactMetadata(metadata),
    url,
    expiresAt: new Date(Date.now() + expiresIn * 1_000).toISOString(),
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
  const share = parseArtifactShare(raw, token);
  if (share.grant.revokedAt) {
    throw new NotFoundError('artifact share has been revoked');
  }
  const remainingSeconds = Math.ceil((Date.parse(share.grant.expiresAt) - Date.now()) / 1_000);
  if (remainingSeconds <= 0) throw new NotFoundError('artifact share has expired');
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

function parseArtifactShare(raw: string, token: string): PublicationShare {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new NotFoundError('artifact share not found');
  }
  if (!isRecord(parsed) || parsed.version !== '2') {
    throw new NotFoundError('artifact share not found');
  }
  const ownerHash = token.slice(0, 32);
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

function sharePathParameter(event: APIGatewayProxyEventV2): string | undefined {
  const token = event.pathParameters?.token;
  return token && /^[a-f0-9]{32}-[a-f0-9]{64}$/.test(token) ? token : undefined;
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

function isInlineMedia(mediaType: string): boolean {
  return mediaType.startsWith('image/') ||
    mediaType.startsWith('video/') ||
    mediaType.startsWith('audio/') ||
    mediaType === 'application/pdf';
}
