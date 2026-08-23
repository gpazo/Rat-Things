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
  return {
    version: '1',
    service: 'rat-things',
    deployment: {
      operation: 'independent',
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
      docs: docsUrl ?? 'https://gpazo.github.io/Rat-Things/docs/',
      agentDocs: 'https://gpazo.github.io/Rat-Things/llms.txt',
      health: '/health',
    },
    authentication: {
      controlApi: 'aws-sigv4',
      service: 'execute-api',
      note: 'Alternative transport adapters may replace SigV4 but must provide a trusted principal.',
    },
    capabilities: {
      consumers: ['operator', 'embedded-product'],
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
        hostedOAuthCallbacks: false,
        automaticTokenRefresh: false,
      },
      agent: {
        browserComputerUse: true,
        interactiveEvents: true,
        steering: true,
        interruption: true,
        approvals: true,
        skills: true,
        apps: true,
        mcp: true,
      },
    },
  };
}
