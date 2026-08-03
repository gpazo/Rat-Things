import type { CredentialBroker } from '../credentials/broker.js';
import { GitHubDeliveryAdapter } from '../delivery/providers/github.js';
import { GitLabDeliveryAdapter } from '../delivery/providers/gitlab.js';
import { SlackDeliveryAdapter } from '../delivery/providers/slack.js';
import { TeamsDeliveryAdapter } from '../delivery/providers/teams.js';
import type { TeamsDeliveryMode } from '../delivery/providers/teams.js';
import { GitHubIngressAdapter } from '../ingress/providers/github.js';
import { GitLabIngressAdapter } from '../ingress/providers/gitlab.js';
import { SlackIngressAdapter } from '../ingress/providers/slack.js';
import { TeamsIngressAdapter } from '../ingress/providers/teams.js';
import type { RuntimePlugin } from './types.js';

export interface BuiltinPluginOptions {
  github: {
    webhookSecretArn?: string | undefined;
    cloneTokenSecretArn?: string | undefined;
    notifyTokenSecretArn?: string | undefined;
    commentTrigger: string;
    apiBaseUrl: string;
  };
  gitlab: {
    webhookSecretArn?: string | undefined;
    cloneTokenSecretArn?: string | undefined;
    notifyTokenSecretArn?: string | undefined;
    commentTrigger: string;
    apiBaseUrl: string;
  };
  teams: {
    webhookSecretArn?: string | undefined;
    deliveryMode: TeamsDeliveryMode;
    workflowUrlSecretArn?: string | undefined;
    replyGatewayUrlSecretArn?: string | undefined;
    routes: Record<string, string>;
  };
  slack: {
    signingSecretArn?: string | undefined;
    botTokenSecretArn?: string | undefined;
  };
}

export function createBuiltinPlugins(
  credentials: CredentialBroker,
  options: BuiltinPluginOptions,
): RuntimePlugin[] {
  return [
    {
      manifest: {
        name: 'github',
        version: '1',
        description: 'GitHub webhook ingress and pull-request result delivery',
        provider: 'github',
      },
      ingress: new GitHubIngressAdapter(credentials, options.github),
      delivery: new GitHubDeliveryAdapter(credentials, {
        tokenSecretArn: options.github.notifyTokenSecretArn,
        apiBaseUrl: options.github.apiBaseUrl,
      }),
    },
    {
      manifest: {
        name: 'gitlab',
        version: '1',
        description: 'GitLab webhook ingress and merge-request result delivery',
        provider: 'gitlab',
      },
      ingress: new GitLabIngressAdapter(credentials, options.gitlab),
      delivery: new GitLabDeliveryAdapter(credentials, {
        tokenSecretArn: options.gitlab.notifyTokenSecretArn,
        apiBaseUrl: options.gitlab.apiBaseUrl,
      }),
    },
    {
      manifest: {
        name: 'teams',
        version: '1',
        description: 'Microsoft Teams mention ingress with Workflow or threaded gateway delivery',
        provider: 'teams',
      },
      ingress: new TeamsIngressAdapter(credentials, options.teams),
      delivery: new TeamsDeliveryAdapter(credentials, {
        mode: options.teams.deliveryMode,
        workflowUrlSecretArn: options.teams.workflowUrlSecretArn,
        replyGatewayUrlSecretArn: options.teams.replyGatewayUrlSecretArn,
        routes: options.teams.routes,
      }),
    },
    {
      manifest: {
        name: 'slack',
        version: '1',
        description: 'Optional Slack Events ingress and thread delivery',
        provider: 'slack',
      },
      ingress: new SlackIngressAdapter(credentials, options.slack),
      delivery: new SlackDeliveryAdapter(credentials, {
        botTokenSecretArn: options.slack.botTokenSecretArn,
      }),
    },
  ];
}
