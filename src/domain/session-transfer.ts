import type { AgentSessionItem, SessionCreateParams } from './agents-api.js';

/** Portable application state. No provider credentials, runtime IDs or active operations. */
export interface SessionImport {
  version: 1;
  transfer_id: string;
  source_session_id: string;
  session: SessionCreateParams;
  history: AgentSessionItem[];
}
export interface SessionImportCapabilities { version: 1; max_history_bytes: number; credentials: 'destination'; execution: 'on_next_message' }
