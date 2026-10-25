/** Deployment configuration only. Public callers cannot set their own limits. */
export function ownerRateLimits(raw?: string): (ownerId: string) => number {
  const value: unknown = raw ? JSON.parse(raw) : { default: 60, owners: {} };
  if (!record(value) || Object.keys(value).some(key => !['default', 'owners'].includes(key))
    || value.owners !== undefined && !record(value.owners)) throw new Error('Invalid OWNER_RATE_LIMITS_JSON');
  const defaults = rateLimitCount(value.default ?? 60);
  const owners = new Map<string, number>(
    Object.entries(value.owners ?? {}).map(([owner, count]) => [owner, rateLimitCount(count)]),
  );
  return owner => owners.get(owner) ?? defaults;
}
function rateLimitCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Owner rate limits must be nonnegative integers');
  return value;
}
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
