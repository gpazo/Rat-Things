import type { BrowserFrame } from '../domain/shared-browser.js';

/** Share expensive captures, never authorization. Callers revalidate access around each read. */
export class SharedBrowserFrames<Frame extends BrowserFrame = BrowserFrame> {
  private readonly entries = new Map<string, { expires: number; promise: Promise<Frame> }>();
  constructor(private readonly now: () => number = () => performance.now()) {}
  read(key: string, capture: () => Promise<Frame>): Promise<Frame> {
    const existing = this.entries.get(key);
    if (existing && existing.expires > this.now()) return existing.promise;
    if (this.entries.size >= 16) this.entries.delete(this.entries.keys().next().value!);
    const entry = { expires: Infinity, promise: Promise.resolve().then(capture) };
    this.entries.set(key, entry);
    void entry.promise.then(() => { entry.expires = this.now() + 400; }, () => { if (this.entries.get(key) === entry) this.entries.delete(key); });
    return entry.promise;
  }
  invalidate(key: string): void { this.entries.delete(key); }
}
