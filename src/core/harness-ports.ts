import type { ModelCatalog } from './model-catalog.js';
import type { SessionExecution } from './session-ports.js';

/**
 * A harness owns the turn loop and native thread state. The model account it signs in with is a
 * separate axis: one harness can support several providers, and a provider can serve several harnesses.
 */
export type HarnessId = 'codex' | 'pi';

/** Public account state only. Tokens and refresh stay inside the host-side harness adapter. */
export interface ModelAccountStatus {
  harness: HarnessId;
  provider: string;
  signed_in: boolean;
  account_type: string | null;
  email: string | null;
  plan: string | null;
}

export interface ModelAccount {
  status(): Promise<ModelAccountStatus>;
  signIn(id?: string): Promise<{ id: string; url: string }>;
  cancelSignIn(id: string): Promise<void>;
  close(): Promise<void>;
}

/** Managed commands run in the isolated worker; the harness and its credentials stay on the host. */
export interface LocalHarness {
  readonly id: HarnessId;
  readonly account: ModelAccount;
  readonly execution: SessionExecution & { shutdown(): Promise<void> };
  models(): Promise<ModelCatalog | undefined>;
  /** Settles discovery and sign-in work; execution shutdown is separate. */
  close(): Promise<void>;
}
