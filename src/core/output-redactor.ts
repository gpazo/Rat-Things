import { redactOutput, secretRedactionPatterns } from '../domain/output-redaction.js';
import { emitMetric } from './metrics.js';

export interface OutputRedactor {
  <T>(value: T): T;
  remember(secrets: readonly string[]): void;
}

export function createOutputRedactor(secrets: readonly string[], options: { keys?: boolean; component?: string } = {}): OutputRedactor {
  const known = new Set(secrets);
  const compile = () => secretRedactionPatterns([...known].map(secret => ({ secret, replacement: '[REDACTED]' })));
  let patterns = compile();
  const redact = <T>(value: T): T => {
    const result = redactOutput(value, patterns, { trailingPrefixes: true, ...(options.keys ? { keys: true } : {}) });
    if (result.count) emitMetric(options.component ?? 'runner', 'OutputRedactions', result.count, 'Count');
    return result.value;
  };
  return Object.assign(redact, { remember: (values: readonly string[]) => {
    const added = values.filter(value => !known.has(value));
    if (!added.length) return;
    for (const value of added) known.add(value);
    patterns = compile();
  } });
}
