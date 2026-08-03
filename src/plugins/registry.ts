import type { ProviderKind } from '../identity/context.js';
import type { DeliveryAdapter } from '../delivery/types.js';
import type { WebhookIngressAdapter } from '../ingress/types.js';
import type { RuntimePlugin } from './types.js';

const PLUGIN_NAME = /^[a-z][a-z0-9-]{0,63}$/;

export class RuntimePluginRegistry {
  private readonly plugins = new Map<string, RuntimePlugin>();
  private readonly ingress = new Map<ProviderKind, WebhookIngressAdapter>();
  private readonly delivery = new Map<ProviderKind, DeliveryAdapter>();

  public constructor(plugins: RuntimePlugin[]) {
    for (const plugin of plugins) this.register(plugin);
  }

  public list(): RuntimePlugin[] {
    return [...this.plugins.values()];
  }

  public ingressFor(provider: ProviderKind): WebhookIngressAdapter {
    const adapter = this.ingress.get(provider);
    if (!adapter) throw new Error(`ingress plugin ${provider} is not enabled`);
    return adapter;
  }

  public deliveryFor(provider: ProviderKind): DeliveryAdapter {
    const adapter = this.delivery.get(provider);
    if (!adapter) throw new Error(`delivery plugin ${provider} is not enabled`);
    return adapter;
  }

  private register(plugin: RuntimePlugin): void {
    const { manifest } = plugin;
    if (!PLUGIN_NAME.test(manifest.name)) throw new Error(`invalid plugin name ${manifest.name}`);
    if (this.plugins.has(manifest.name)) throw new Error(`duplicate plugin name ${manifest.name}`);
    if (plugin.ingress) {
      if (plugin.ingress.provider !== manifest.provider) {
        throw new Error(`plugin ${manifest.name} ingress provider does not match its manifest`);
      }
      if (this.ingress.has(manifest.provider)) {
        throw new Error(`duplicate ingress provider ${manifest.provider}`);
      }
      this.ingress.set(manifest.provider, plugin.ingress);
    }
    if (plugin.delivery) {
      if (plugin.delivery.provider !== manifest.provider) {
        throw new Error(`plugin ${manifest.name} delivery provider does not match its manifest`);
      }
      if (this.delivery.has(manifest.provider)) {
        throw new Error(`duplicate delivery provider ${manifest.provider}`);
      }
      this.delivery.set(manifest.provider, plugin.delivery);
    }
    this.plugins.set(manifest.name, plugin);
  }
}
