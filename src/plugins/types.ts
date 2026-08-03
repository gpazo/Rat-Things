import type { ProviderKind } from '../identity/context.js';
import type { DeliveryAdapter } from '../delivery/types.js';
import type { WebhookIngressAdapter } from '../ingress/types.js';

export interface RuntimePluginManifest {
  name: string;
  version: '1';
  description: string;
  provider: ProviderKind;
}

export interface RuntimePlugin {
  manifest: RuntimePluginManifest;
  ingress?: WebhookIngressAdapter;
  delivery?: DeliveryAdapter;
}
