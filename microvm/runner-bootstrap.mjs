import { writeFileSync, readFileSync } from 'node:fs';
// No runner code, credentials, or subprocesses execute before joining the freezer.
const group = process.env.RAT_CHECKPOINT_CGROUP;
if (!group || !/^\/sys\/fs\/cgroup\/rat-checkpoints\/[a-f0-9]{64}$/.test(group)) throw new Error('Checkpoint cgroup is invalid');
writeFileSync(`${group}/cgroup.procs`, '0');
if (!readFileSync(`${group}/cgroup.procs`, 'utf8').split('\n').includes(String(process.pid))) throw new Error('Runner did not join checkpoint cgroup');
delete process.env.RAT_CHECKPOINT_CGROUP;
await import('./runner.mjs');
