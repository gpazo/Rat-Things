import openApi from '../../spec/openapi.json' with { type: 'json' };
import thingCreateSchema from '../../spec/schemas/thing-create-v1.json' with { type: 'json' };
import thingSchema from '../../spec/schemas/thing-v1.json' with { type: 'json' };
import thingVersionSchema from '../../spec/schemas/thing-version-v1.json' with { type: 'json' };

export const RAT_THINGS_OPENAPI = openApi;

export const RAT_THINGS_SCHEMAS: Readonly<Record<string, unknown>> = {
  '/schemas/thing-v1.json': thingSchema,
  '/schemas/thing-create-v1.json': thingCreateSchema,
  '/schemas/thing-version-v1.json': thingVersionSchema,
};

/** Relative links keep discovery valid for every independently operated deployment. */
export function ratThingsDiscovery(docsUrl?: string): Record<string, unknown> {
  const documentationRoot = withTrailingSlash(
    docsUrl ?? 'https://gpazo.github.io/Rat-Things/docs/',
  );
  return {
    version: '1',
    service: 'rat-things',
    deployment: {
      operation: 'independent',
      maturity: 'engineering-preview',
      tenancy: 'host-defined',
      identity: 'host-authenticated principal',
      oauthApplications: 'bring-your-own',
    },
    api: {
      version: 'v1',
      openapi: '/openapi.json',
      schemas: {
        thing: '/schemas/thing-v1.json',
        createThing: '/schemas/thing-create-v1.json',
        createThingVersion: '/schemas/thing-version-v1.json',
      },
      docs: documentationRoot,
      agentGuide: `${documentationRoot}agents/`,
      agentDocs: 'https://gpazo.github.io/Rat-Things/llms.txt',
      agentDocsFull: 'https://gpazo.github.io/Rat-Things/llms-full.txt',
      health: '/health',
    },
    authentication: {
      controlApi: 'aws-sigv4',
      service: 'execute-api',
      note: 'Direct v1 control routes use SigV4. A host backend may wrap them while preserving a trusted principal.',
    },
    capabilities: {
      consumers: ['operator', 'embedded-product', 'agent', 'cli', 'provider-event'],
      recommendedFacade: 'things',
      authorization: {
        model: 'fixed-before-launch',
        insideEnvelope: 'autonomous',
        midRunApproval: false,
      },
      things: {
        specVersions: ['1'],
        triggers: ['manual', 'schedule:rate', 'schedule:cron'],
        scheduleBackend: 'amazon-eventbridge-scheduler',
        scheduleTimezones: 'iana',
        lifecycle: ['draft', 'active', 'paused', 'archived'],
        draftAndActiveRevisions: true,
        immutableRevisions: true,
        explain: true,
      },
      integrations: {
        multipleAccounts: true,
        connectionSets: true,
        credentialOnboarding: 'manifest-driven',
        credentialVerification: 'before-persistence',
        providerIdentity: 'derived',
        permissionPresets: ['read-only', 'read-write', 'full', 'custom'],
        providerAndBrokerEnforcement: true,
        bringYourOwnOAuth: true,
        hostedOAuthCallbacks: true,
        automaticTokenRefresh: true,
        identityPreservingReconnect: true,
        scheduledHealthChecks: true,
      },
      agent: {
        browserComputerUse: true,
        liveComputerView: true,
        humanComputerTakeover: true,
        teachByDemonstration: true,
        teachCreatesDraftThings: true,
        interactiveEvents: true,
        steering: true,
        interruption: true,
        approvals: false,
        skills: true,
        apps: true,
        mcp: true,
      },
      runs: {
        asynchronous: true,
        liveEvents: true,
        approvals: false,
        steering: true,
        interruption: true,
      },
      conversations: {
        durable: true,
        replacementCompute: true,
        cursorPagedTranscript: true,
        serverSearch: ['messages', 'files'],
        organization: ['pin', 'hide', 'read-state'],
      },
      outputs: {
        durableFiles: true,
        publications: ['file', 'site', 'video'],
      },
    },
  };
}

function withTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}
