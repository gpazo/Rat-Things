export const AGENT_RESULT_MARKER = '<!-- rat-things:result -->';
const PREVIOUS_AGENT_RESULT_MARKER = '<!-- indubitably-agent-runtime:result -->';

export function isAgentResultMessage(body: string): boolean {
  return body.includes(AGENT_RESULT_MARKER) || body.includes(PREVIOUS_AGENT_RESULT_MARKER);
}
