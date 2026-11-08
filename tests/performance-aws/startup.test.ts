import { describe, expect, it } from 'vitest';
import { hasUnconditionalInferenceDeny, planStartup, sourceArtifactLocation, startupLimits, validateStartupManifest } from '../../testing/performance-aws/startup-planning.js';

const images = { beforeVersion: '1.0', beforeZip: '/before.zip', afterVersion: '2.0', afterZip: '/after.zip' };
const manifest = {
  schema: 'rat-things.startup-responses-proxy.v1', mode: 'fixture',
  listenHost: '127.0.0.1', listenPort: 43188, endpointPath: '/openai/v1/responses',
  model: 'openai.gpt-5.6-luna', forwardURL: null, proxySha256: 'a'.repeat(64), limits: startupLimits,
  requestPolicy: { tools: 'forced_empty', toolChoice: 'none' }, responsePolicy: 'message_or_reasoning_items_only',
  nativeRetryConfiguration: 'built_in_amazon_bedrock_override_rejected', proxyRetries: 0,
};

describe('startup measurement plan', () => {
  it('alternates fixture samples and permits no inference spend', () => {
    const plan = planStartup({ mode: 'fixture', ...images });
    expect(plan.samples.map(sample => sample.image.side)).toEqual(['before', 'after', 'after', 'before', 'before', 'after', 'after', 'before', 'before', 'after']);
    expect(plan.maximumInferenceUsd).toBe(0);
  });

  it('limits a live comparison to two one-request workers', () => {
    const plan = planStartup({ mode: 'bedrock', ...images });
    expect(plan.samples).toHaveLength(2);
    expect(plan.maximumInferenceUsd).toBeGreaterThan(1.15);
    expect(plan.maximumInferenceUsd).toBeLessThan(1.20);
    expect(() => planStartup({ mode: 'bedrock', ...images, pairs: '2' })).toThrow();
  });

  it('allows a single diagnostic without inventing a second image', () => {
    expect(planStartup({ mode: 'fixture', diagnosticVersion: '3.0', diagnosticZip: '/diagnostic.zip' }).samples)
      .toEqual([{ pair: null, image: { side: 'diagnostic', version: '3.0', sourceZip: '/diagnostic.zip' } }]);
    expect(() => planStartup({ mode: 'fixture', ...images, diagnosticVersion: '3.0', diagnosticZip: '/diagnostic.zip' })).toThrow();
  });

  it.each(['0', '6', '1.5', 'NaN'])('rejects invalid fixture pair count %s', pairs => {
    expect(() => planStartup({ mode: 'fixture', ...images, pairs })).toThrow();
  });

  it('rejects same-version comparisons and missing sources', () => {
    expect(() => planStartup({ mode: 'fixture', ...images, afterVersion: images.beforeVersion })).toThrow();
    expect(() => planStartup({ mode: 'fixture', beforeVersion: '1.0', afterVersion: '2.0' })).toThrow();
  });
});

describe('deployed startup source bounds', () => {
  it('requires a role-wide unconditional deny for both inference providers', () => {
    const deny = { Effect: 'Deny', Action: ['bedrock:*', 'bedrock-mantle:*', 'sagemaker:InvokeEndpoint*'], Resource: '*' };
    expect(hasUnconditionalInferenceDeny({ Statement: [deny] })).toBe(true);
    expect(hasUnconditionalInferenceDeny({ Statement: [{ ...deny, Effect: 'Allow' }] })).toBe(false);
    expect(hasUnconditionalInferenceDeny({ Statement: [{ ...deny, Condition: { StringEquals: { Example: 'value' } } }] })).toBe(false);
    expect(hasUnconditionalInferenceDeny({ Statement: [{ ...deny, Resource: 'arn:one-model' }] })).toBe(false);
    expect(hasUnconditionalInferenceDeny({ Statement: [{ ...deny, Action: ['bedrock:*'] }] })).toBe(false);
    expect(hasUnconditionalInferenceDeny({ Statement: [{ ...deny, Action: ['bedrock:*', 'sagemaker:InvokeEndpoint*'] }] })).toBe(false);
    expect(hasUnconditionalInferenceDeny(null)).toBe(false);
  });
  it('requires the requested mode and all fixed proxy limits', () => {
    expect(() => validateStartupManifest(manifest, 'fixture')).not.toThrow();
    expect(() => validateStartupManifest(manifest, 'bedrock')).toThrow();
    for (const key of Object.keys(startupLimits)) {
      expect(() => validateStartupManifest({ ...manifest, limits: { ...startupLimits, [key]: 999_999 } }, 'fixture')).toThrow();
    }
    expect(() => validateStartupManifest({ ...manifest, model: 'openai.gpt-6-astra' }, 'fixture')).toThrow();
    expect(() => validateStartupManifest({ ...manifest, listenHost: '0.0.0.0' }, 'fixture')).toThrow();
    expect(() => validateStartupManifest({ ...manifest, forwardURL: 'https://example.com' }, 'fixture')).toThrow();
  });

  it('only reads source objects from the named disposable deployment', () => {
    expect(sourceArtifactLocation('s3://rat-things-fo1108a-mvm-src-ac2245ef2368/microvm/source.zip', 'fo1108a'))
      .toEqual({ Bucket: 'rat-things-fo1108a-mvm-src-ac2245ef2368', Key: 'microvm/source.zip' });
    expect(() => sourceArtifactLocation('s3://rat-things-prod-mvm-src-ac2245ef2368/source.zip', 'fo1108a')).toThrow();
    expect(() => sourceArtifactLocation('https://example.com/source.zip', 'fo1108a')).toThrow();
  });
});
