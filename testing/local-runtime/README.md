# Local Linux worker harness

This opt-in harness starts real ARM64 workers in the local VM. It uses a local
Responses-protocol fixture for inference, so it makes no provider requests and
does not need subscription credentials. It does not provision AWS resources.

```bash
npm run runtime:local:build
npm run test:e2e:local-runtime
```

The checked Codex artifact must already exist; follow the runtime artifact section
in [the main harness guide](../README.md). Docker Desktop, Colima or OrbStack must
be running on an Apple silicon Mac.

The harness exercises native remote command execution, UID 10001, absence of host
mounts and login credentials, disabled command networking, setup-once behavior,
the file protocol, service restart, persistent volumes and snapshot export. It
removes its own container and paired workspace/state volumes afterward. Ordinary `npm run check`
does not launch this harness.

## Installed native runtime acceptance

This opt-in harness exercises a packaged, signed Rat Things app on an Apple silicon Mac. It
starts the real disposable Linux probe during setup. It makes no model inference, sign-in,
token-refresh or cloud requests. Node 22.20 or newer runs the harness controller; the child
commands use the app's `Contents/MacOS/rat-things` launcher and bundled Node.

```sh
RAT_INSTALLED_RUNTIME_ACCEPTANCE=1 node testing/local-runtime/installed-runtime.mjs \
  --app "/Applications/Rat Things.app" \
  --directory "$HOME/rat-installed-acceptance"
```

Choose an absent profile whose parent already exists, or an empty private directory owned by
your user. The harness rejects a populated profile and never removes it. It canonicalizes the
app and profile paths, including macOS `/tmp` and `/var` aliases. The profile contains a private
home, temporary directory and working directory for every child command. Children receive a
fixed system-only `PATH` and no inherited account, AWS, proxy, Node or executable-selection
settings. Run the command directly; the app needs no checkout, external Node, Docker or compiler
on its child `PATH`.

The harness first verifies that the actual launcher rejects executable overrides. It then runs
fresh runtime status and setup as separate CLI-owned service lifetimes, requiring an unselected
profile followed by a complete setup receipt. Successful setup on this empty profile includes
the real native file-command probe. It compares the copied payload, exact manifest and signature
metadata with the app's included release, requires exactly that selected release, and checks
that staging and probe directories are empty.

Two packaged `serve` lifetimes exercise native service identity, the manifest's protocol
compatibility, ready status through the packaged CLI, public unsigned ChatGPT account status,
and the durable setup receipt. Each service must stop gracefully and remove its connection
record. The second start must preserve selection, copied bytes and filesystem identities. The
harness reads the private loopback token only to authenticate these fixed local status routes;
it never prints or saves that token, reads `auth.json`, or copies account files.

Sanitized observations are saved to `installed-runtime-acceptance/evidence.json` within the
profile. Child stdout and stderr are bounded and retained only in memory. The profile and
evidence remain available for follow-up after success or failure. A passing run establishes
fresh-profile behavior on this host under the restricted child environment. It does not
establish behavior on a clean physical machine, notarization, login or token refresh,
subscription inference, rollback, abrupt failure recovery, or cloud transfer. Ordinary tests
do not run this harness.

## Installed live subscription acceptance

This harness uses the actual packaged launcher, public local API and an existing private Rat Things
Things profile with a ChatGPT subscription login. It makes real subscription inference requests.
Node 22.20 or newer runs the controller. Each child uses the app's bundled Node and selected native
runtime. Run setup and complete sign-in through the packaged CLI before starting, then stop any
service using that profile. The harness requires the app's included release to be selected and
ready; it does not install a runtime or start a sign-in flow.

```sh
RAT_INSTALLED_SUBSCRIPTION_ACCEPTANCE=1 node testing/local-runtime/installed-subscription.mjs \
  --app "/Applications/Rat Things.app" \
  --directory "$HOME/rat-private-subscription"
```

The app and profile paths are explicit and canonicalized. The profile must already exist, be
private and belong to your user. Its contents are retained. The controller creates a private home,
temporary directory and working directory inside it. Packaged child commands receive a fixed
system-only `PATH` and no inherited Codex, API-key, AWS, proxy, Node or executable overrides. The
controller reads only the private loopback connection token needed for fixed authenticated local
requests. It never reads or copies `auth.json`, account caches or private application storage.

Before creating a Session, the harness requires native service identity, ready status through the
packaged CLI, and public signed-in ChatGPT account status. It chooses the account catalog's default
model; use `--model MODEL_ID` for another available model. It asks the model to run an injected
verification program, stops its own packaged service gracefully, starts the same service again,
and asks a second Turn to resume the same Session and workspace. Each Turn must finish and contain
one successful `command_execution` item for the exact requested command, including its normal
shell wrapper when present. Assistant text cannot satisfy the proof.

The verification program asserts UID 10001, Linux, absence of the guest auth file, host profile
path and engine socket, a refused guest-loopback network request, and setup output containing
exactly `once`. Its structured output binds these observations and file hashes to a fresh nonce.
The controller compares the script hash with the injected program, checks the first proof hash
after restart, and verifies file names and sizes through the environment file-list API. Both
Turns run with the environment's disabled-network policy; the network assertion itself probes
one loopback address.

Sanitized evidence is saved under `installed-subscription-acceptance-*/evidence.json` in the profile.
It retains the Session, environment, model, Turn and command IDs and the expected workspace hashes
for a subsequent transfer acceptance. File contents, hashes, isolation and setup count are
**command-observed**. The installed API does not expose a workspace snapshot read, so this harness
does not claim independent host snapshot verification. An actual transfer exercises the existing
snapshot boundary and can verify restored files in the destination. The source-based cloud harness
below is not an installed-runtime controller and must not be used to reopen this native profile.

The profile, Session, workspace and evidence remain after success or failure. Child output is
bounded and never copied into evidence. This harness does not explicitly refresh the account,
exercise revoked-login recovery, abrupt failure, AWS transfer, notarization, or a clean physical
machine. Inference may perform the account refresh normally managed by Codex. Ordinary tests do
not run this harness.

## Validate installed transfer to AWS

Run installed subscription acceptance first. Use its evidence file with the same app and private
profile, then stop the profile service. Choose a deployed Agents API endpoint and an explicit
destination model. This command makes real uploads and requests cloud inference through the
normal host AWS credential chain.

```sh
RAT_INSTALLED_CLOUD_ACCEPTANCE=1 node testing/local-runtime/installed-cloud-transfer.mjs \
	--app "/Applications/Rat Things.app" \
	--directory "$HOME/rat-private-subscription" \
	--evidence "$HOME/rat-private-subscription/installed-subscription-acceptance-RANDOM/evidence.json" \
	--endpoint https://your-agents-endpoint/v1 --region us-west-2 --model YOUR_CLOUD_MODEL
```

Replace the evidence path with the path printed by subscription acceptance. The controller
starts its own packaged service and uses the packaged CLI for Session and transfer operations.
It verifies the installed release, source command proofs, complete ordered history, and stable
Session settings before creating a transfer plan. After the copy, it restarts the service and
requires status and retry of the same transfer ID to return the completed receipt.

The destination must remain idle until the controller sends an ordinary message. Its command
checks the four subscription proof files by length and SHA256, requires setup-count to remain
`once`, and writes a new proof file. Acceptance requires exact command arguments, successful
typed command output, the selected destination model, and unchanged local history and settings.

Inspect `installed-cloud-transfer-*/evidence.json` inside the profile for the result and retained
resource IDs. Both Sessions and uploaded parts remain for deployment cleanup. The controller
stops only its own processes. It does not read account files or host snapshots, and evidence
contains no connection tokens or AWS credential values.

This check proves completed-transfer retry after graceful restart. It does not inject an
interrupted upload, lost import acknowledgement, or abrupt shutdown. The separate source-based
test below covers its own lost-ack injection and must not reopen an installed native profile.

## Source-based live subscription validation

The opt-in acceptance harness uses the private Rat Things ChatGPT subscription login and the normal
host inference path. Prepare the [native worker proof](native-vm/worker/README.md), then sign in
to a dedicated Rat Things profile:

```bash
export RAT_THINGS_LOCAL_DIR="$PWD/.runtime/local-subscription-acceptance"
export CODEX_BINARY="$PWD/node_modules/.bin/codex"
npm run rat-things -- login
RAT_LIVE_SUBSCRIPTION=1 npm run test:e2e:local-subscription -- \
  --directory "$RAT_THINGS_LOCAL_DIR"
```

Complete the browser sign-in before starting the acceptance command. This profile is separate
from the Codex app's account. Do not copy credential files between them. The harness checks
public ChatGPT account status before creating a VM or requesting inference. Local Codex launches
exclude inherited API keys and force ChatGPT authentication; they retain approved proxy and CA
settings. There is no API-key fallback.

The harness selects the account catalog's default model; use `--model MODEL_ID` to select another
available model. Use `--runtime container` to exercise the existing engine-backed adapter instead
of the native proof. The test makes real subscription requests: it asks a model to run a workspace
verification program, restarts the service gracefully, and asks a second Turn to read the same
workspace. It requires completed command output, checks the resulting files independently in a
snapshot, and checks UID, host isolation, disabled command networking and setup-once behavior.

A passing run writes `subscription-acceptance-*.json` inside the selected profile. Evidence omits
account identifiers, credentials and raw model traffic. The profile and Session remain available
for inspection. The harness does not exercise token refresh, revoked/expired login recovery,
abrupt VM failure or AWS transfer; those remain separate acceptance work. The fixture harness
above verifies execution behavior without verifying subscription access.

To request a real account refresh and verify authenticated rate-limit access without reading
credential contents, run:

```sh
RAT_LIVE_SUBSCRIPTION=1 node --import tsx testing/local-runtime/account-refresh.ts \
  --directory "$RAT_THINGS_LOCAL_DIR"
```

The cloud harness requires a real deployed Agents endpoint and the normal AWS credential
chain. It makes real uploads and requests destination inference. Pass a successful local
subscription evidence file and an explicit destination model:

```sh
RAT_LIVE_CLOUD=1 node --import tsx testing/local-runtime/cloud.ts \
  --directory "$RAT_THINGS_LOCAL_DIR" --evidence /path/to/subscription-acceptance.json \
  --endpoint https://your-agents-endpoint/v1 --region us-west-2 --model YOUR_CLOUD_MODEL
```

It deliberately loses the response after a successful import, reopens local services, and
checks that retry returns the same destination without uploading again. A new cloud command
then verifies transferred hashes and setup output. The harness does not provision or destroy
the endpoint; use the scoped AWS E2E scripts when testing a disposable stack.

The planned Pi Durable adapter has the same requirement from its first live local prototype.
Its upstream Cloudflare example's API-key configuration is not the Rat Things development setup.
