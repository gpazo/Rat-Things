# Reproduce the Pi Durable recovery demo

The website's `demos/pi-durable/` page is a recorded run. Its controls inspect
saved steps; they do not run the engine or provide the command simulator's
verified replay, branching, or minimization.

The run uses Pi Durable 1.3.0 and the Rat Things engine, storage, and ownership
adapters. Two separate Node processes represent workers. The first is killed
with SIGKILL while a background helper waits for a function result. The host
process retains an in-memory store. Model replies come from Pi's faux provider.
There are no AWS calls, Bedrock inference requests, or workspace files.

From the repository root after `npm ci`, copy the recorded source into a local
output directory and run it:

```bash
mkdir -p .runtime/pi-recovery-demo
cp site/demos/pi-durable/run-source.txt .runtime/pi-recovery-demo/run.ts
node --import tsx .runtime/pi-recovery-demo/run.ts
```

The script asserts lost-acknowledgement recovery, worker termination, rejection
of an old owner's write, stable helper and function identities, duplicate-result
handling, rejection of conflicting results, consumption of the saved result,
and no rerun of the completed parent. It writes raw summaries, native commits,
model calls, and projections beside the script. Repeated runs replace those files.

Worker IDs, commit UUIDs, timestamps, and the proof token change on each run.
The scenario and assertions stay the same. Passing this scenario does not prove
all failure schedules, AWS durability, or model behavior.

The public page retains the original run's source commit and evidence. Refresh
its recording deliberately; do not describe a local run as live Bedrock testing.
For the controlled command scheduler, use the separate
[time-travel harness](../time-travel/README.md).
