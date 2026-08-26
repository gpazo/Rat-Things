import { describe, expect, it } from 'vitest';
import {
  CapabilityProfileRegistry,
  createBuiltinCapabilityProfiles,
  resolveAgentProfile,
} from '../../src/plugins/capability-profiles.js';

const registry = new CapabilityProfileRegistry(createBuiltinCapabilityProfiles());

describe('capability profiles', () => {
  it('uses a fixed pre-launch capability envelope for the small-business profile', () => {
    expect(resolveAgentProfile({
      sandbox: 'danger-full-access',
      capabilities: {
        profile: 'small-business',
        networkAccess: true,
        webSearch: 'live',
        computerUse: 'browser',
      },
    }, registry)).toEqual({
      agent: {
        sandbox: 'danger-full-access',
        capabilities: {
          profile: 'small-business',
          networkAccess: true,
          webSearch: 'live',
          computerUse: 'browser',
        },
      },
      maximumIntegrationAccess: 'read-write',
    });
  });

  it('prevents an explicit request from widening the read-only profile', () => {
    expect(resolveAgentProfile({
      sandbox: 'danger-full-access',
      capabilities: {
        profile: 'read-only',
        computerUse: 'browser',
      },
    }, registry)).toMatchObject({
      agent: {
        sandbox: 'read-only',
        capabilities: {
          computerUse: 'disabled',
        },
      },
      maximumIntegrationAccess: 'read-only',
    });
  });

  it('turns browser use off when a request narrows network access', () => {
    expect(resolveAgentProfile({
      capabilities: { profile: 'small-business', networkAccess: false },
    }, registry)).toMatchObject({
      agent: {
        capabilities: { networkAccess: false, computerUse: 'disabled' },
      },
    });
  });
});
