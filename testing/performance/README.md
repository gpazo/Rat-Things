# Multiplayer performance harness

Run from the repository root with Node 22.20 or newer:

```sh
npx tsx testing/performance/multiplayer.ts --output /tmp/multiplayer-performance.json
npx tsx testing/performance/multiplayer.ts --output /tmp/multiplayer-desktop.json --viewers 20,50 --writers 20 --history-items 0,200 --rounds 2 --stream-mode desktop
```

The default matrix uses 1, 5, 10, 20 and 50 observers, 20 simultaneous contributors per burst, two bursts, and 0/200 pre-existing synthetic assistant history items. Each cell has a fresh private temporary database and space. Setup uses real public routes for saved Agent configuration, workload-role assignment, membership and Session creation. History is emitted by the deterministic executor before timing. It is not real model history.

The workload uses the production `createAgentsHttpServer`, `routeAgentsRequest`, space authorization, workload admission, owner rate limiter, Session orchestration, runtime journal, activity streams and encrypted SQLite WAL/FULL transactions. Upstream identity verification is replaced with fixture bearer subjects accepted only by the loopback server. Execution is an explicitly synthetic in-memory port that publishes typed, individually correlated assistant output after a configurable delay. A serialized in-process dispatch wakeup replaces the AWS outbox. No cloud, native VM, model, credentials, or external network service is used.

`--stream-mode persistent` keeps each activity stream connected. `desktop` plays back the current native client's network behavior: consume one activity event, reconnect after 50ms with its cursor, reset the cursor after a 20s idle request and wait 1s, request a cursorless snapshot on the next connection after 15s, and refresh `GET /v1/rat/spaces` every 2s. It does not run the native application. `both` adds both modes to the matrix. Stream and client CPU run in the same Node process as SQLite, so this measures combined local contention rather than an independently generated service ceiling.

Every writer/round and every writer/round/viewer pair appears in the JSON, including HTTP errors, timeouts, observations after the deadline and work not started. Input visibility requires the exact synthetic text, a message ID and the authenticated writer's matching receipt; a change in input count is insufficient. Assistant progress requires its own correlated typed output, never just acknowledgement. Same-key actor separation, same-actor idempotent replay, viewer write denial, revocation denial, input multiplicity, effect count and bounded cleanup are checked. `passed` fails if any expected observation is missing, a semantic check fails, or a provisional latency target fails.

Latency starts immediately before the HTTP submission and uses `performance.now()`. Submission ends after the HTTP acknowledgement body is consumed. Peer visibility and first synthetic output end when that viewer decodes the matching activity frame. Quantiles use nearest rank over observed samples and report all censored counts; missing observations force target failure. Per-viewer samples are correlated, and a small sample count cannot establish a reliable population p99. The provisional targets are p95/p99 submission 500/1500ms and peer visibility 1000/2000ms at 20 writers and 50 observers. They are goals, not guarantees.

Storage counters measure attempted `AgentsStore` calls at the SQLite adapter boundary, resource writes and conditional observations. They include permission reads and snapshot/event materialization. They do not represent internal SQL statements, DynamoDB RCUs/WCUs, or billed costs. The idle phase has connected viewers but no background dispatch polling. Its reported calls per viewer-second includes desktop authority refresh and reconnect work when selected. Stream byte counts are raw HTTP response body bytes received, including SSE framing and keepalives; initial and workload phases are separate. TLS, HTTP headers, compression and internet RTT are excluded.

The real default owner limit stays at 60 admissions per minute. Initial Session creation consumes one, so two default 20-writer bursts use 41 admissions. Extra rounds may produce 429s; the harness retains those results and does not raise the limit, invent retries or move the clock. Each round starts only when the preceding round has been observed or timed out. Actual burst-start offsets are recorded.

Options: `--output`, `--viewers` (comma-separated 1–50), `--writers` (1–20), `--history-items` (comma-separated 0–1000), `--rounds` (1–20), `--duration-ms` (global budget, default 180000, maximum 600000), `--timeout-ms` (sample/request bound, default 10000), `--idle-ms` (default 1500), `--stream-interval-ms` (server poll interval, default production 500), and `--synthetic-delay-ms` (default 10). The artifact records revision/dirty status, configuration, platform, wall-clock start/end, monotonic timings, all sample counts, diagnostics and explicit measurement boundaries. Matrices not started before the global deadline are recorded separately. Output should be outside the checkout so it does not itself make the next revision measurement dirty.

Focused validation:

```sh
npm test -- tests/performance/multiplayer.test.ts
npm run typecheck
```
