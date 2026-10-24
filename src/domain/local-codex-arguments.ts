/** Disable ambient host integrations before app-server initialization can start them. */
export function isolatedCodexArguments(args: string[]): string[] {
  return ['-c', 'features.plugins=false', '-c', 'features.apps=false', '-c', 'features.hooks=false', '-c', 'notify=[]', ...args];
}
