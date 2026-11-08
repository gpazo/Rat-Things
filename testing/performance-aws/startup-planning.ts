import { createHash } from 'node:crypto';

export type StartupMode = 'fixture' | 'bedrock';
export type StartupSide = 'before' | 'after' | 'diagnostic' | 'randomized';
export interface StartupImage { side: StartupSide; version: string; sourceZip: string }
export interface StartupSamplePlan { pair: number | null; image: StartupImage }

export const startupLimits = {
  requestsPerVm: 1,
  requestBytes: 65_536,
  maxOutputTokens: 128,
  forwardTimeoutMs: 30_000,
  responseBytes: 1_048_576,
  requestMaxRetries: null,
  streamMaxRetries: null,
} as const;

export function planStartup(input: {
  mode: string;
  beforeVersion?: string;
  beforeZip?: string;
  afterVersion?: string;
  afterZip?: string;
  diagnosticVersion?: string;
  diagnosticZip?: string;
  randomizedVersion?: string;
  randomizedZip?: string;
  randomizedSamples?: string;
  pairs?: string;
}): { mode: StartupMode; images: StartupImage[]; samples: StartupSamplePlan[]; maximumInferenceUsd: number } {
  if (input.mode !== 'fixture' && input.mode !== 'bedrock') throw new Error('STARTUP_MODE must be fixture or bedrock');
  const image = (side: StartupSide, version: string | undefined, sourceZip: string | undefined): StartupImage => {
    if (!version || !/^\d+(?:\.\d+)?$/.test(version) || !sourceZip) throw new Error('Each image requires a numeric version and its local source ZIP');
    return { side, version, sourceZip };
  };
  let images: StartupImage[];
  let samples: StartupSamplePlan[];
  if (input.randomizedVersion !== undefined || input.randomizedZip !== undefined || input.randomizedSamples !== undefined) {
    if (input.mode !== 'fixture' || input.beforeVersion || input.beforeZip || input.afterVersion || input.afterZip
      || input.diagnosticVersion || input.diagnosticZip || input.pairs) throw new Error('Randomized startup comparison requires fixture mode and cannot be combined with other modes');
    if (input.randomizedSamples !== undefined && input.randomizedSamples !== '20') throw new Error('Randomized startup comparison uses exactly 20 samples');
    images = [image('randomized', input.randomizedVersion, input.randomizedZip)];
    samples = Array.from({ length: 20 }, () => ({ pair: null, image: images[0]! }));
  } else if (input.diagnosticVersion !== undefined || input.diagnosticZip !== undefined) {
    if (input.beforeVersion || input.beforeZip || input.afterVersion || input.afterZip || input.pairs) throw new Error('A diagnostic cannot also be a comparison');
    images = [image('diagnostic', input.diagnosticVersion, input.diagnosticZip)];
    samples = [{ pair: null, image: images[0]! }];
  } else {
    images = [image('before', input.beforeVersion, input.beforeZip), image('after', input.afterVersion, input.afterZip)];
    if (images[0]!.version === images[1]!.version) throw new Error('A comparison needs distinct image versions');
    const pairs = Number(input.pairs ?? (input.mode === 'fixture' ? '5' : '1'));
    if (!Number.isSafeInteger(pairs) || pairs < 1 || pairs > (input.mode === 'fixture' ? 5 : 1)) throw new Error('Fixture comparisons allow 1–5 pairs; Bedrock allows one pair');
    samples = Array.from({ length: pairs }, (_, index) => (index % 2 ? [...images].reverse() : images)
      .map(selected => ({ pair: index + 1, image: selected }))).flat();
  }
  const maximumContextTokens = 1_050_000;
  const longContextInputUsdPerMillion = 0.55;
  const longContextOutputUsdPerMillion = 1.98;
  const maximumRequestUsd = (maximumContextTokens * longContextInputUsdPerMillion
    + startupLimits.maxOutputTokens * longContextOutputUsdPerMillion) / 1e6;
  const maximumInferenceUsd = input.mode === 'fixture' ? 0 : samples.length * maximumRequestUsd;
  if (maximumInferenceUsd > 1.20) throw new Error('Inference budget exceeds $1.20');
  return { mode: input.mode, images, samples, maximumInferenceUsd };
}

export const startupSelectorVersion = 'run-id-final-hex-parity.v1';

export function startupComparisonSide(runId: string): 'before' | 'after' {
  const finalHex = /([0-9a-f])$/i.exec(runId)?.[1];
  if (!finalHex) throw new Error('Run ID must end in a hexadecimal character');
  return Number.parseInt(finalHex, 16) % 2 === 0 ? 'before' : 'after';
}

export function startupSelectionFromLogEvents(
  events: Array<{ message?: string; logStreamName?: string; timestamp?: number }>, runId: string, side: 'before' | 'after',
): { logGroupEvent: { message?: string; logStreamName?: string; timestamp?: number }; marker: Record<string, unknown> } | undefined {
  const matches = events.flatMap(event => (event.message ?? '').split(/\r?\n/).flatMap(line => {
    try {
      const value: unknown = JSON.parse(line);
      return isRecord(value) && value.message === 'startup comparison selected' && value.runId === runId
        ? [{ event, value }] : [];
    } catch { return []; }
  }));
  if (!matches.length) return undefined;
  if (matches.length !== 1) throw new Error('Duplicate startup comparison selection host logs');
  const { event, value } = matches[0]!;
  if (value.side !== side || typeof value.selectedAt !== 'string' || !Number.isFinite(Date.parse(value.selectedAt))) {
    throw new Error('Host startup comparison log disagrees with observed Run ID selection');
  }
  return { logGroupEvent: event, marker: value };
}

export function validateStartupOverlapManifest(value: unknown, runtime: Uint8Array): asserts value is {
  schema: 'rat-things.startup-overlap.v1'; selectorVersion: string;
  baselineFunctionSha256: string; candidateFunctionSha256: string;
  baselineSourceZipSha256: string; candidateSourceZipSha256: string; comparisonCodeSha256: string;
} {
  if (!isRecord(value) || value.schema !== 'rat-things.startup-overlap.v1'
    || value.selectorVersion !== startupSelectorVersion
    || !['baselineFunctionSha256', 'candidateFunctionSha256', 'baselineSourceZipSha256', 'candidateSourceZipSha256', 'comparisonCodeSha256']
      .every(key => typeof value[key] === 'string' && /^[a-f0-9]{64}$/.test(value[key] as string))) {
    throw new Error('Deployed source does not contain valid randomized startup comparison provenance');
  }
  const source = Buffer.from(runtime).toString('utf8');
  if (!source.includes('function startSerialRun(run) {') || !source.includes('function startOverlapRun(run) {')
    || !source.includes("log('info', 'startup comparison selected'") || !source.includes('startupComparisonSide(run.runId)')) {
    throw new Error('Randomized startup runtime is missing its comparison branches or selector');
  }
  const baselineStart = source.indexOf('function startSerialRun(run) {');
  const baselineEnd = source.indexOf('\n\nfunction startOverlapRun(run)', baselineStart);
  const candidateStart = source.indexOf('function startOverlapRun(run) {');
  const candidateEnd = source.indexOf('\n\nfunction startupComparisonSide(runId)', candidateStart);
  const wrapperStart = source.indexOf('function startRun(run) {', candidateEnd);
  const comparisonEnd = source.indexOf('\n\nfunction releaseStartupGate(', wrapperStart);
  if (baselineEnd < 0 || candidateEnd < 0 || wrapperStart < 0 || comparisonEnd < 0
    || createSha256(Buffer.from(source.slice(baselineStart, comparisonEnd).trimEnd())) !== value.comparisonCodeSha256
    || createSha256(Buffer.from(source.slice(baselineStart, baselineEnd).trimEnd().replace(/^function startSerialRun\(run\)/, 'function startRun(run)'))) !== value.baselineFunctionSha256
    || createSha256(Buffer.from(source.slice(candidateStart, candidateEnd).trimEnd().replace(/^function startOverlapRun\(run\)/, 'function startRun(run)'))) !== value.candidateFunctionSha256) {
    throw new Error('Randomized startup functions differ from their manifest hashes');
  }
  const selectorSource = `function startupComparisonSide(runId) {\n  const finalHex = /([0-9a-f])$/i.exec(runId)?.[1];\n  if (!finalHex) throw new Error('Run ID must end in a hexadecimal character');\n  return Number.parseInt(finalHex, 16) % 2 === 0 ? 'before' : 'after';\n}`;
  if (!source.includes(selectorSource)) throw new Error('Randomized startup selector differs from its manifest version');
}

export function validateStartupManifest(value: unknown, mode: StartupMode): asserts value is {
  schema: string; mode: StartupMode; model: string; proxySha256: string; limits: typeof startupLimits;
} {
  if (!isRecord(value) || value.schema !== 'rat-things.startup-responses-proxy.v1' || value.mode !== mode
    || value.listenHost !== '127.0.0.1' || value.listenPort !== 43188 || value.endpointPath !== '/openai/v1/responses'
    || value.model !== 'openai.gpt-5.6-luna'
    || value.forwardURL !== (mode === 'bedrock' ? 'https://bedrock-mantle.us-west-2.api.aws/openai/v1/responses' : null)
    || !isRecord(value.requestPolicy) || value.requestPolicy.tools !== 'forced_empty' || value.requestPolicy.toolChoice !== 'none'
    || value.responsePolicy !== 'message_or_reasoning_items_only'
    || value.nativeRetryConfiguration !== 'built_in_amazon_bedrock_override_rejected' || value.proxyRetries !== 0
    || typeof value.proxySha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.proxySha256)
    || !isRecord(value.limits) || Object.keys(value.limits).length !== Object.keys(startupLimits).length
    || Object.entries(startupLimits).some(([key, expected]) => (value.limits as Record<string, unknown>)[key] !== expected)) {
    throw new Error('Deployed source does not contain the required startup proxy bounds');
  }
}

export function sourceArtifactLocation(uri: string | undefined, deployment: string) {
  const match = uri?.match(/^s3:\/\/([^/]+)\/(.+)$/);
  if (!match || !new RegExp(`^rat-things-${deployment}-mvm-src-[a-f0-9]{12}$`).test(match[1]!)) throw new Error('Image source must be in this disposable deployment artifact bucket');
  return { Bucket: match[1]!, Key: match[2]! };
}

export function hasUnconditionalInferenceDeny(policy: unknown): boolean {
  if (!isRecord(policy)) return false;
  const statements = Array.isArray(policy.Statement) ? policy.Statement : [policy.Statement];
  return ['bedrock:*', 'bedrock-mantle:*', 'sagemaker:InvokeEndpoint*'].every(action => statements.some(statement => {
    if (!isRecord(statement) || statement.Effect !== 'Deny' || statement.Condition !== undefined
      || statement.NotAction !== undefined || statement.NotResource !== undefined) return false;
    const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
    const resources = Array.isArray(statement.Resource) ? statement.Resource : [statement.Resource];
    return resources.includes('*') && (actions.includes('*') || actions.includes(action));
  }));
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const createSha256 = (value: Uint8Array): string => createHash('sha256').update(value).digest('hex');
