/** Deployment configuration only. Public callers cannot set their own limits. */
export function ownerRateLimits(raw?: string): (ownerId: string) => number {
  const value: unknown = raw ? JSON.parse(raw) : { default: 60, owners: {} };
  if (!record(value) || Object.keys(value).some(key => !['default', 'owners'].includes(key))
    || value.owners !== undefined && !record(value.owners)) throw new Error('Invalid OWNER_RATE_LIMITS_JSON');
  const defaults = value.default ?? 60;
  const owners = new Map(Object.entries(value.owners ?? {}));
  for (const count of [defaults, ...owners.values()]) {
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) throw new Error('Owner rate limits must be nonnegative integers');
  }
  return owner => (owners.get(owner) ?? defaults) as number;
}
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
