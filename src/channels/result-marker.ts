export const AGENT_RESULT_MARKER = '<!-- rat-things:result -->';
const LEGACY_AGENT_RESULT_MARKER = '<!-- indubitably-agent-runtime:result -->';

export function isAgentResultMessage(body: string): boolean {
  return body.includes(AGENT_RESULT_MARKER) || body.includes(LEGACY_AGENT_RESULT_MARKER);
}
