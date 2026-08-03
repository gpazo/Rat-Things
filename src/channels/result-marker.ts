export const AGENT_RESULT_MARKER = '<!-- indubitably-agent-runtime:result -->';

export function isAgentResultMessage(body: string): boolean {
  return body.includes(AGENT_RESULT_MARKER);
}
