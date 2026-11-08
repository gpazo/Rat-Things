export type StartupMode = 'fixture' | 'bedrock';
export type StartupSide = 'before' | 'after' | 'diagnostic';
export interface StartupImage { side: StartupSide; version: string; sourceZip: string }
export interface StartupSamplePlan { pair: number | null; image: StartupImage }

export const startupLimits = {
  requestsPerVm: 1,
  requestBytes: 65_536,
  maxOutputTokens: 128,
  forwardTimeoutMs: 30_000,
  responseBytes: 1_048_576,
  requestMaxRetries: 0,
  streamMaxRetries: 0,
} as const;

export function planStartup(input: {
  mode: string;
  beforeVersion?: string;
  beforeZip?: string;
  afterVersion?: string;
  afterZip?: string;
  diagnosticVersion?: string;
  diagnosticZip?: string;
  pairs?: string;
}): { mode: StartupMode; images: StartupImage[]; samples: StartupSamplePlan[]; maximumInferenceUsd: number } {
  if (input.mode !== 'fixture' && input.mode !== 'bedrock') throw new Error('STARTUP_MODE must be fixture or bedrock');
  const image = (side: StartupSide, version: string | undefined, sourceZip: string | undefined): StartupImage => {
    if (!version || !/^\d+(?:\.\d+)?$/.test(version) || !sourceZip) throw new Error('Each image requires a numeric version and its local source ZIP');
    return { side, version, sourceZip };
  };
  let images: StartupImage[];
  let samples: StartupSamplePlan[];
  if (input.diagnosticVersion !== undefined || input.diagnosticZip !== undefined) {
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
  // Use the model's entire context limit and higher long-context prices as the
  // spend bound. The byte cap is stricter but is not a tokenizer measurement.
  const maximumInferenceUsd = input.mode === 'fixture' ? 0 : samples.length * (1_050_000 * 0.55 + startupLimits.maxOutputTokens * 1.98) / 1e6;
  if (maximumInferenceUsd > 1.20) throw new Error('Inference budget exceeds $1.20');
  return { mode: input.mode, images, samples, maximumInferenceUsd };
}

export function validateStartupManifest(value: unknown, mode: StartupMode): asserts value is {
  schema: string; mode: StartupMode; model: string; proxySha256: string; limits: typeof startupLimits;
} {
  if (!isRecord(value) || value.schema !== 'rat-things.startup-responses-proxy.v1' || value.mode !== mode
    || value.listenHost !== '127.0.0.1' || value.listenPort !== 43188 || value.endpointPath !== '/openai/v1/responses'
    || !['openai.gpt-5.6-luna', 'gpt-5.6-luna'].includes(String(value.model))
    || value.forwardURL !== (mode === 'bedrock' ? 'https://bedrock-mantle.us-west-2.api.aws/openai/v1/responses' : null)
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

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
