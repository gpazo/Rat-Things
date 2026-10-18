import type { AgentsStore } from '../core/agents-ports.js';
import type { SessionState } from '../core/session-ports.js';
import { SessionRuntimeStore } from '../core/session-runtime-store.js';
import { nativeLease } from '../core/session-native-store.js';
import { openPiStorage } from '../runner/pi/storage.js';
import { projectPiStorage } from '../runner/pi/projection.js';

export function piProjectionRepair(store: AgentsStore) {
  return async (ownerId: string, sessionId: string): Promise<{ hasLiveTasks: boolean }> => {
    const state = (await store.get<SessionState>(ownerId, 'sessions', sessionId))?.value;
    const runtimes = new SessionRuntimeStore(store);
    const runtime = await runtimes.get(ownerId, sessionId);
    if (state?.runtime?.kind !== 'pi' || !runtime || runtime.value.closed || !runtime.value.native?.head) return { hasLiveTasks: false };
    const lease = nativeLease(store, ownerId, sessionId, runtime.value.runId, runtime.value.epoch ?? 0);
    const image = await lease.load();
    const storage = await openPiStorage({ ...lease, load: async () => image });
    const nativeSeq = image.head?.seq ?? 0;
    const { snapshot, hasLiveTasks } = await projectPiStorage(storage, { sessionId, turnId: state.turns.at(-1)?.turn.id ?? 'bootstrap',
      runtime: state.runtime, agent: state.session.agent, environment: state.session.environment, input: [] }, nativeSeq);
    if ((runtime.value.projectionSeq ?? -1) < nativeSeq) {
      await runtimes.publishNative(ownerId, sessionId, runtime.value.runId, nativeSeq, { ...snapshot,
        turns: snapshot.turns.map(binding => { const previous = runtime.value.snapshot?.turns.find(saved => saved.turn.id === binding.turn.id);
          return { ...binding, ...(previous?.artifacts ? { artifacts: previous.artifacts } : {}) }; }),
      });
    }
    return { hasLiveTasks };
  };
}
