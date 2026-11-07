import { performanceCount } from '../core/performance.js';

export interface HydrationCacheOptions { enabled?: boolean; maxEntries?: number; maxBytes?: number; maxEntryBytes?: number }

/** Process-local cache for writer-owned immutable JSON references only. */
export class ImmutableHydrationCache {
  private readonly entries = new Map<string, { value: unknown; bytes: number }>();
  private readonly pending = new Map<string, Promise<unknown>>();
  private bytes = 0;
  private readonly enabled: boolean;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly maxEntryBytes: number;
  public constructor(options: HydrationCacheOptions = {}) {
    this.enabled = options.enabled ?? true;
    this.maxEntries = options.maxEntries ?? 128;
    this.maxBytes = options.maxBytes ?? 4 * 1024 * 1024;
    this.maxEntryBytes = options.maxEntryBytes ?? 512 * 1024;
  }
  public async get<T>(key: string, load: () => Promise<T>): Promise<T> {
    if (!this.enabled || this.maxEntries < 1 || this.maxBytes < 1 || this.maxEntryBytes < 1) { performanceCount('HydrationCacheMisses'); return load(); }
    const cached = this.entries.get(key);
    if (cached) { this.entries.delete(key); this.entries.set(key, cached); performanceCount('HydrationCacheHits'); this.reportBytes(); return structuredClone(cached.value) as T; }
    const existing = this.pending.get(key);
    if (existing) { performanceCount('HydrationCacheCoalesced'); this.reportBytes(); return structuredClone(await existing) as T; }
    performanceCount('HydrationCacheMisses'); this.reportBytes();
    const fetch = load(); this.pending.set(key, fetch);
    try {
      const value = await fetch;
      const bytes = Buffer.byteLength(JSON.stringify(value));
      if (Number.isFinite(bytes) && bytes <= this.maxEntryBytes && bytes <= this.maxBytes) {
        while (this.entries.size >= this.maxEntries || this.bytes + bytes > this.maxBytes) {
          const oldest = this.entries.keys().next().value as string | undefined;
          if (oldest === undefined) break;
          this.bytes -= this.entries.get(oldest)!.bytes; this.entries.delete(oldest); performanceCount('HydrationCacheEvictions');
        }
        this.entries.set(key, { value: structuredClone(value), bytes }); this.bytes += bytes;
      }
      this.reportBytes();
      return structuredClone(value);
    } finally { if (this.pending.get(key) === fetch) this.pending.delete(key); }
  }
  public get currentBytes() { return this.bytes; }
  private reportBytes() { performanceCount('HydrationCacheBytes', this.bytes); }
}
