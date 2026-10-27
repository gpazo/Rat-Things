import { expect, it } from 'vitest';
import { verifyManagedCodexPolicy } from '../../src/adapters/codex-managed-policy.js';
import { managedCodexConfiguration, managedCodexPolicyMatches, managedCodexRequirementsSafe, type ManagedCodexPolicy } from '../../src/domain/codex-managed-policy.js';

const policy: ManagedCodexPolicy = { workspace: '/workspace', network: { access: 'disabled', allowed_domains: [] }, credentialProxy: false };

it('keeps no-egress intent independent from the upstream proxy-enabled bit', () => {
  const config = managedCodexConfiguration({ ...policy, credentialProxy: true });
  expect(config.permissions.rat_managed.network).toMatchObject({ enabled: true, domains: {}, allow_upstream_proxy: false, allow_local_binding: false });
  expect(config.features.network_proxy).toEqual({ enabled: true, credential_broker: false });
  expect(managedCodexPolicyMatches({ config }, { requirements: null }, policy)).toBe(true);
});

it.each([
  null, {}, { allowedLoginMethods: null }, { allowedLoginMethods: [] },
  { allowedLoginMethods: ['api'] }, { allowedLoginMethods: ['chatgpt'] }, { allowedLoginMethods: ['api', 'chatgpt'] },
  { allowedLoginMethods: ['chatgpt'], network: null, allowedPermissionProfiles: null, modelProvider: null, hooks: null },
])('accepts absent execution requirements and authentication-only restrictions: %j', requirements => {
  const response = { supportsIndependentSpeedModes: true, requirements };
  expect(managedCodexRequirementsSafe(response)).toBe(true);
  expect(managedCodexPolicyMatches({ config: managedCodexConfiguration(policy) }, response, policy)).toBe(true);
});

it.each([
  { allowedLoginMethods: 'chatgpt' }, { allowedLoginMethods: ['saml'] }, { allowedLoginMethods: ['Chatgpt'] },
  { allowedLoginMethods: ['chatgpt', 'chatgpt'] }, { allowedLoginMethods: [null] },
  { allowedLoginMethods: ['chatgpt'], network: { allowedDomains: ['example.com'] } },
  { allowedLoginMethods: ['chatgpt'], allowedPermissionProfiles: {} },
  { allowedLoginMethods: ['chatgpt'], allowLoginShell: false },
  { allowedLoginMethods: ['chatgpt'], unknownAuthority: null },
  { allowedLoginMethods: ['chatgpt'], unknownAuthority: true },
])('rejects malformed authentication or additional requirements: %j', requirements => {
  expect(managedCodexRequirementsSafe({ requirements })).toBe(false);
  expect(managedCodexPolicyMatches({ config: managedCodexConfiguration(policy) }, { requirements }, policy)).toBe(false);
});

it.each([{}, { requirements: [] }, { requirements: null, supportsIndependentSpeedModes: 'true' }, { requirements: null, unknownAuthority: null }])(
  'rejects an unknown or malformed requirements response: %j', response => {
    expect(managedCodexRequirementsSafe(response)).toBe(false);
  },
);

it.each([
  { name: 'managed requirements', requirements: { requirements: { network: { allowedDomains: ['example.com'] } } } },
  { name: 'authentication mixed with execution requirements', requirements: { requirements: { allowedLoginMethods: ['chatgpt'], network: { allowedDomains: ['example.com'] } } } },
  { name: 'authentication mixed with unknown requirements', requirements: { requirements: { allowedLoginMethods: ['chatgpt'], unknownAuthority: null } } },
  { name: 'missing requirements response', requirements: {} },
  { name: 'missing policy-layer inventory' },
  { name: 'unknown effective grants', extend: { permissions: { rat_managed: { filesystem: { '/': 'write' } } } } },
  { name: 'unknown policy layer', layer: { name: { type: 'enterpriseManaged' }, config: {} } },
  { name: 'unexpected system config', layer: { name: { type: 'system', file: '/etc/codex/config.toml' }, config: { features: { network_proxy: true } } } },
])('refuses $name before running a command', async test => {
  const methods: string[] = [];
  const config = { ...managedCodexConfiguration(policy), ...('extend' in test ? test.extend : {}) };
  await expect(verifyManagedCodexPolicy({ policy, call: async method => {
    methods.push(method);
    if (method === 'config/read') return { config, layers: 'layer' in test ? [test.layer] : [] };
    if (method === 'configRequirements/read') return 'requirements' in test ? test.requirements : { requirements: null };
    throw new Error('Execution must not start');
  } })).rejects.toThrow('Refusing to expose execution tools');
  expect(methods).toEqual(['config/read', 'configRequirements/read']);
});
