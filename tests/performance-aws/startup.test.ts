import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { hasUnconditionalInferenceDeny, planStartup, sourceArtifactLocation, startupComparisonSide, startupLimits,
  startupSelectionFromLogEvents, startupSelectorVersion, validateStartupManifest, validateStartupOverlapManifest } from '../../testing/performance-aws/startup-planning.js';

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

  it('plans exactly 20 fixture samples against one randomized image', () => {
    const plan = planStartup({ mode: 'fixture', randomizedVersion: '4.0', randomizedZip: '/same.zip', randomizedSamples: '20' });
    expect(plan.images).toEqual([{ side: 'randomized', version: '4.0', sourceZip: '/same.zip' }]);
    expect(plan.samples).toHaveLength(20);
    expect(plan.samples.every(sample => sample.image === plan.images[0] && sample.pair === null)).toBe(true);
    expect(plan.maximumInferenceUsd).toBe(0);
    expect(() => planStartup({ mode: 'bedrock', randomizedVersion: '4.0', randomizedZip: '/same.zip' })).toThrow();
    expect(() => planStartup({ mode: 'fixture', randomizedVersion: '4.0', randomizedZip: '/same.zip', randomizedSamples: '19' })).toThrow();
    expect(() => planStartup({ mode: 'fixture', randomizedVersion: '4.0', randomizedZip: '/same.zip', ...images })).toThrow();
  });

  it('assigns sides from the observed Run ID final hexadecimal digit', () => {
    expect(startupComparisonSide('run-1234-8')).toBe('before');
    expect(startupComparisonSide('run-1234-9')).toBe('after');
    expect(startupComparisonSide('run-1234-F')).toBe('after');
    expect(() => startupComparisonSide('run-1234-z')).toThrow();
  });

  it('matches selector markers across multiple JSON lines in a host log event', () => {
    const marker = JSON.stringify({ message: 'startup comparison selected', runId: 'run-3', side: 'after', selectedAt: '2026-11-08T19:00:00.000Z' });
    expect(startupSelectionFromLogEvents([{ message: `${JSON.stringify({ message: 'other' })}\n${marker}`, logStreamName: 'stream', timestamp: 9 }], 'run-3', 'after'))
      .toMatchObject({ logGroupEvent: { logStreamName: 'stream', timestamp: 9 }, marker: { side: 'after', runId: 'run-3' } });
    expect(() => startupSelectionFromLogEvents([{ message: marker }], 'run-3', 'before')).toThrow();
  });

  it.each(['0', '6', '1.5', 'NaN'])('rejects invalid fixture pair count %s', pairs => {
    expect(() => planStartup({ mode: 'fixture', ...images, pairs })).toThrow();
  });

  it('rejects same-version comparisons and missing sources', () => {
    expect(() => planStartup({ mode: 'fixture', ...images, afterVersion: images.beforeVersion })).toThrow();
    expect(() => planStartup({ mode: 'fixture', beforeVersion: '1.0', afterVersion: '2.0' })).toThrow();
  });
});

describe('randomized startup provenance', () => {
  it('checks the actual runtime bytes and required branch code against the manifest', () => {
    const baseline = 'function startRun(run) { return run; }';
    const candidate = 'function startRun(run) { return run; }';
    const selector = `function startupComparisonSide(runId) {\n  const finalHex = /([0-9a-f])$/i.exec(runId)?.[1];\n  if (!finalHex) throw new Error('Run ID must end in a hexadecimal character');\n  return Number.parseInt(finalHex, 16) % 2 === 0 ? 'before' : 'after';\n}`;
    const wrapper = `function startRun(run) {\n  const side = startupComparisonSide(run.runId);\n  const selectedAt = new Date().toISOString();\n  log('info', 'startup comparison selected', { runId: run.runId, side, selectedAt });\n  if (side === 'before') return startSerialRun(run);\n  return startOverlapRun(run);\n}`;
    const comparisonCode = `${baseline.replace('function startRun', 'function startSerialRun')}\n\n${candidate.replace('function startRun', 'function startOverlapRun')}\n\n${selector}\n\n${wrapper}`;
    const runtime = Buffer.from(`${comparisonCode}\n\nfunction releaseStartupGate(stream) { return stream; }`);
    const manifest = { schema: 'rat-things.startup-overlap.v1', selectorVersion: startupSelectorVersion,
      baselineFunctionSha256: createHash('sha256').update(baseline).digest('hex'),
      candidateFunctionSha256: createHash('sha256').update(candidate).digest('hex'),
      baselineSourceZipSha256: 'c'.repeat(64), candidateSourceZipSha256: 'd'.repeat(64),
      comparisonCodeSha256: createHash('sha256').update(comparisonCode).digest('hex') };
    expect(() => validateStartupOverlapManifest(manifest, runtime)).not.toThrow();
    expect(() => validateStartupOverlapManifest({ ...manifest, comparisonCodeSha256: '0'.repeat(64) }, runtime)).toThrow();
    expect(() => validateStartupOverlapManifest({ ...manifest, selectorVersion: 'unknown' }, runtime)).toThrow();
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
