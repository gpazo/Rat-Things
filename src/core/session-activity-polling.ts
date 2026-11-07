import type { SessionActivity } from './session-activity.js';

interface Poll { users: number; at: number; pending?: Promise<SessionActivity>; value?: SessionActivity; bytes: number }
/** Share projection reads within one service process; authorization stays with each subscriber. */
export class SessionActivityPolling {
  private readonly polls = new Map<string, Poll>();
  private bytes = 0;
  public subscribe(key: string, intervalMs: number, load: () => Promise<SessionActivity>) {
    let poll = this.polls.get(key);
    if (!poll && this.polls.size < 64) { poll = { users: 0, at: 0, bytes: 0 }; this.polls.set(key, poll); }
    if (poll) poll.users++;
    const shared = poll;
    let released = false;
    return {
      read: async () => {
        if (!shared) return load();
        if (shared.pending) return shared.pending;
        if (shared.value && Date.now() - shared.at < intervalMs) return shared.value;
        const pending = load(); shared.pending = pending;
        try {
          const value = await pending;
          const size = Buffer.byteLength(JSON.stringify(value));
          this.bytes -= shared.bytes; shared.bytes = 0; shared.value = undefined;
          if (!released && size <= 1024 * 1024 && this.bytes + size <= 8 * 1024 * 1024) {
            shared.value = value; shared.bytes = size; this.bytes += size;
          }
          shared.at = Date.now();
          return value;
        } finally { shared.pending = undefined; }
      },
      release: () => {
        if (released) return;
        released = true;
        if (shared && --shared.users === 0) { this.bytes -= shared.bytes; shared.bytes = 0; shared.value = undefined; this.polls.delete(key); }
      },
    };
  }
}
