import openApi from '../../spec/openapi.json' with { type: 'json' };
import agentsSchema from '../../spec/schemas/agents-api.schema.json' with { type: 'json' };

export const RAT_THINGS_OPENAPI = openApi;

export const RAT_THINGS_SCHEMAS: Readonly<Record<string, unknown>> = {
  '/schemas/agents-api.schema.json': agentsSchema,
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
      schemas: { agents: '/schemas/agents-api.schema.json' },
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
      recommendedFacade: 'agents',
      authorization: {
        model: 'fixed-before-launch',
        insideEnvelope: 'autonomous',
        midRunApproval: false,
      },
      agents: { sessions: true, turns: true, items: true, vaults: true, environmentTemplates: true },
      schedules: { backend: 'amazon-eventbridge-scheduler', targets: 'agents', overlap: ['allow', 'skip'] },
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
