export const AGENT_ARTIFACT_DIRECTORY = '.rat-things/artifacts';

export function artifactPromptText(prompt: string): string {
  const instructions = [
    'Rat Things files:',
    `- Files available to this session are under ${AGENT_ARTIFACT_DIRECTORY}/.`,
    `- When write access is enabled, return or preserve a file by writing it under ${AGENT_ARTIFACT_DIRECTORY}/ using a clear relative filename.`,
    '- Local execution lists available files when it finishes. Abrupt termination can leave output incomplete.',
    '- Mention the relative filename in your response. Do not create credentials or secrets there.',
  ];
  return [...instructions, 'User request:', prompt].join('\n\n');
}
