import { fixtureInstallation } from './native-installation.js';

const [profile, bundle, point, action] = process.argv.slice(2);
if (!profile || !bundle || !point) throw new Error('Missing fixture arguments');
const installation = fixtureInstallation(profile, bundle, { checkpoint: async current => { if (current === point) process.exit(73); } });
const started = await installation.startup();
if (action !== 'startup') {
  if (started.change.kind === 'failed') throw new Error(JSON.stringify(started.change));
  const result = await installation.setup();
  if (result.change.kind === 'failed') throw new Error(JSON.stringify(result.change));
}
process.exit(0);
