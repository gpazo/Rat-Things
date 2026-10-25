import { Type } from 'typebox';
import AjvModule from 'ajv';
import { templateConfiguration } from '../domain/environment-planning.js';
import type { SessionLaunch } from '../domain/session-execution.js';

export const LOCAL_PI_POLICY_PATH = '/run/rat-things/pi-effects.json';
export interface LocalPiEffectPolicy {
  version: 1; sessionId: string; environmentId: string; generation: string;
  network: Extract<SessionLaunch['environment'], { type: 'openai_hosted' }>['network'];
  environment: Record<string, string>;
}
const validate = new AjvModule.default({ strict: false }).compile(Type.Object({
  version: Type.Literal(1), sessionId: Type.String({ pattern: '^sess_[a-zA-Z0-9_-]+$' }),
  environmentId: Type.String({ pattern: '^env_[a-zA-Z0-9]+$' }), generation: Type.String({ minLength: 1, maxLength: 100 }),
  network: Type.Object({ access: Type.Union([Type.Literal('disabled'), Type.Literal('restricted'), Type.Literal('enabled')]),
    allowed_domains: Type.Array(Type.String({ maxLength: 253, pattern: '^[a-zA-Z0-9.-]+$' }), { maxItems: 100 }) }, { additionalProperties: false }),
  environment: Type.Record(Type.String(), Type.String()),
}, { additionalProperties: false }));

export function localPiEffectPolicy(value: unknown): LocalPiEffectPolicy {
  if (!validate(value)) throw new Error('Invalid local Pi worker policy');
  const policy = value as LocalPiEffectPolicy;
  templateConfiguration({ network: policy.network, env: policy.environment });
  return policy;
}
