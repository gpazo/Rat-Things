export const MIN_SECRET_SCAN_LENGTH = 8;
export interface SecretReplacement { secret: string; replacement: string }
export interface RedactionPattern { value: string; replacement: string }

export function secretRedactionPatterns(secrets: readonly SecretReplacement[]): RedactionPattern[] {
  const patterns = new Map<string, string>();
  for (const { secret, replacement } of secrets) {
    if (secret.length < MIN_SECRET_SCAN_LENGTH) continue;
    const encoded = encodeURIComponent(secret);
    for (const value of [secret, Buffer.from(secret).toString('base64'), Buffer.from(secret).toString('base64url'), Buffer.from(secret).toString('base64').replace(/=+$/, ''), JSON.stringify(secret).slice(1, -1), encoded, encoded.replace(/%[0-9A-F]{2}/g, part => part.toLowerCase()), new URLSearchParams({ value: secret }).toString().slice(6)]) patterns.set(value, replacement);
  }
  return [...patterns].map(([value, replacement]) => ({ value, replacement })).sort((a, b) => b.value.length - a.value.length);
}

export function redactText(text: string, patterns: readonly RedactionPattern[], trailingPrefixes = false): { value: string; count: number } {
  if (!patterns.length) return { value: text, count: 0 };
  const replacements = new Map(patterns.map(pattern => [pattern.value, pattern.replacement]));
  const expression = new RegExp(patterns.map(pattern => pattern.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
  let count = 0;
  let value = text.replace(expression, match => { count++; return replacements.get(match)!; });
  if (trailingPrefixes) {
    const suffix = patterns.flatMap(pattern => {
      for (let length = Math.min(pattern.value.length - 1, text.length); length >= MIN_SECRET_SCAN_LENGTH; length--) {
        if (text.endsWith(pattern.value.slice(0, length))) return [{ length, replacement: pattern.replacement }];
      }
      return [];
    }).sort((a, b) => b.length - a.length)[0];
    if (suffix && value.endsWith(text.slice(-suffix.length))) { value = value.slice(0, -suffix.length) + suffix.replacement; count++; }
  }
  return { value, count };
}

/** JSON-shaped outputs retain their structure; credential values never become configuration. */
export function redactOutput<T>(input: T, patterns: readonly RedactionPattern[], options: { trailingPrefixes?: boolean; keys?: boolean } = {}): { value: T; count: number } {
  let count = 0;
  const visit = (value: unknown): unknown => {
    if (typeof value === 'string') { const result = redactText(value, patterns, options.trailingPrefixes); count += result.count; return result.value; }
    if (Array.isArray(value)) return value.map(visit);
    if (value !== null && typeof value === 'object') {
      const entries = new Map<string, unknown>();
      for (const [key, part] of Object.entries(value)) {
        const redacted = options.keys ? redactText(key, patterns) : { value: key, count: 0 };
        count += redacted.count;
        let name = redacted.value;
        for (let index = 1; entries.has(name); index++) name = `${redacted.value}[${index}]`;
        entries.set(name, visit(part));
      }
      return Object.fromEntries(entries);
    }
    return value;
  };
  return { value: visit(input) as T, count };
}
