# A little help, right at home

Start with the computer you already own. Rat Things can keep Agents, Sessions,
Turns and conversation history locally, using the same API and desktop app as an
AWS workspace. You do not need AWS, Docker or Terraform for local conversations.

Local means the API, harness and saved conversation run on your computer. Model
requests use your ChatGPT subscription through Codex; this is not offline model inference.
Codex handles sign-in and refresh on the host. Subscription credentials never enter
the local Linux worker. Codex/ChatGPT is the first supported subscription provider.
Sign in once for Rat Things, even if you already use Codex. Rat Things keeps a separate
Codex home so your personal tools, plugins and hooks do not enter a Session.

Use this subscription sign-in flow when developing Rat Things locally too. Start with
`npm run rat-things -- login`; an OpenAI API key is not part of local workspace setup.

## Open your first workspace

From a checkout, install Node 22.20 or newer and Rust 1.95 or newer. The
[desktop guide](../desktop/README.md#build-and-launch) lists Linux build prerequisites.
Then run:

```bash
npm ci
npm run rat-things -- login
npm run console:build
npm run console:serve
```

Leave `RAT_THINGS_AGENTS_API_URL` and `RAT_THINGS_API_URL` unset to start locally.
The desktop starts a private local service, or connects to one already running.
**This computer** in the sidebar tells you where you are.

Choose **Untangle an idea**, pick a model, and create the Session. The model picker
reads your installed Codex model catalog. If it cannot load, check your login and
use **Refresh models**. `RAT_THINGS_MODEL` can select one exact model ID for the
local catalog; that model still needs to be available to your credentials.

Send a follow-up in the same Session. Close and reopen the desktop to find the
saved conversation. If the service stops during a Turn, the Turn is marked failed;
send a new message to continue. A crash never silently repeats an accepted Turn.

## Give your Session a Linux workspace

The first local worker supports **Apple silicon Macs** with Docker Desktop, Colima,
or OrbStack running a Linux ARM64 VM. The VM needs at least 2 GiB of memory per
active worker. Conversations with **No environment** do not require a VM.

Windows and Linux with Docker Desktop, Intel Macs, and native Linux Docker with the
gVisor `runsc` runtime are in preview. Set `RAT_THINGS_PREVIEW_PLATFORMS=1` to try
them. Native Linux Docker without gVisor is refused, because the worker would share
the host kernel. No worker image is published for x86-64 yet.

`runtime setup` downloads a published, digest-pinned worker image when one exists
for your platform. Otherwise it builds the image from a checkout. Build the checked
Linux ARM64 Codex artifact described in [the contributor harness](../testing/README.md),
then install the worker image:

```bash
npm run rat-things -- runtime doctor
npm run rat-things -- runtime setup
```

Setup does not install or start an external container engine. Open **This computer** to see setup checks and choose
**Sign in with ChatGPT**. After browser sign-in, choose **Check setup**. The CLI
alternative is `npm run rat-things -- login`.

When creating a Session, choose **Linux on this computer**, or select a saved
Template. The existing `openai_hosted` API discriminator still means a managed
Rat Things environment; the connected API endpoint determines where it runs:

```json
{
  "agent": { "model": "YOUR_MODEL" },
  "environment": {
    "type": "openai_hosted",
    "network": { "access": "disabled" },
    "files": [{ "type": "inline", "path": "/workspace/hello.txt", "data": "SGVsbG8h" }]
  },
  "input": "Read hello.txt and write a short reply in /workspace/reply.txt."
}
```

The worker has its own persistent workspace volume. Rat Things mounts no host
folders, login files, AWS credentials or container-engine socket into it. Commands
run as UID 10001. The host runs the Codex harness and talks to the worker through
Codex's authenticated, encrypted executor protocol over a loopback-only transport.
Packages, inline files, inline skills and network policy use the same
configuration contract as AWS. Setup runs once for a workspace; restarting a
worker retains its files. If initial provisioning or setup is interrupted, retain
the workspace files and start a new Session. Rat Things does not replay setup
when it cannot confirm which effects already happened. Local Vaults, plugins and MCP tools are not yet
supported. Local browser automation is not bundled in this image.

## Keep the service running separately

A desktop-owned service stops when the app closes. Run the service separately if
you want to close the window while work continues:

```bash
npm run rat-things -- serve
```

In another terminal, open the desktop or use the existing resource commands:

```bash
npm run console:serve
npm run rat-things -- sessions create --model YOUR_MODEL \
  --input "Help me plan a small project for this weekend." --stream
npm run rat-things -- sessions list
npm run rat-things -- sessions send SESSION_ID --input "What is the first step?"
```

Keep the computer awake and the service running. Stopping it retains saved work.
Two native Session harnesses can run at once by default; additional work stays
queued. Idle harnesses release their slots after 30 seconds. Use
`serve --max-sessions 4` to change the limit, or `--data-dir PATH` for a separate
workspace. Set `RAT_THINGS_LOCAL_DIR` to that path in clients too. The limit bounds both harnesses and Linux workers; it does not change subscription
quotas. Each Linux worker has a 2 GiB memory limit and a two-CPU quota. An environment
created without a Turn retains its slot until used or the Session is deleted.

## Use the same API from code

After `npm run build`, connect to the running local service:

```ts
import { createLocalAgentsClient, readLocalConnection } from './dist/local-workspace.mjs';

const client = createLocalAgentsClient(await readLocalConnection());
const session = await client.beta.agents.sessions.create({
  agent: { model: 'YOUR_MODEL' },
  environment: { type: 'none' },
  input: 'Help me turn an idea into a practical plan.',
});
```

The client exposes the same resource methods as the cloud client. Local credentials
are read from a private connection file, sent only to its loopback origin, and
rotated whenever the service starts. Browsers and unauthenticated callers cannot
use the local API. Request bodies are limited to 1 MiB.

## What fits at home today

| Capability | This computer | AWS workspace |
| --- | --- | --- |
| Agents, Sessions, Turns, Items and streaming | Available | Available |
| Saved history and follow-up Turns | Local disk | Cloud storage |
| Declared function tools and web search | Available | Available |
| Linux workspaces, package setup and inline capabilities | Apple silicon Mac + local VM | Available |
| Vaults, uploaded Files, plugins, MCP, schedules and provider webhooks | Not yet available | Available when configured |
| Continue while this computer is off | No | Yes |
| Copy an idle local Session into AWS | History, configuration and bounded workspace snapshot | Import supported |

**No environment** Sessions provide conversation tools without shell or filesystem
execution. Function tools execute in the client that supplies their results. The
separate `rat-things local` command remains available for one-shot coding work; it
does not create a durable Session.

## Give your work more room

You can stay local for as long as it fits. Use AWS when you need more concurrency,
connected services, schedules, or availability while your computer sleeps.

1. Follow the [AWS quickstart](quickstart.md) to deploy in your account. Update an
   existing deployment to include the Session import routes. Configure its model
   connection independently. The destination must admit the selected model ID.
   If it uses a different model from the local subscription, select that model
   with the CLI's `--model` option when preparing the copy.
2. Wait for your local Session to finish. Open **This computer**, enter the AWS
   Agents API URL and region, and choose **Review Session copy**.
3. Rat Things checks destination access, import support and the configured model,
   then stops the local worker briefly to save a consistent snapshot. Review the
   destination, file size and history count. Nothing is uploaded during review.
4. Choose **Copy to AWS**. Rat Things uploads workspace parts and imports an idle
   Session. Choose **Open cloud Session**, then send a new message to continue.
   The displayed cloud Session ID also works with the existing CLI and SDK.

The same workflow is available from the CLI while the local service runs:

```bash
npm run rat-things -- transfer plan SESSION_ID \
  --api-url https://your-api.example/v1 --region us-west-2
npm run rat-things -- transfer run TRANSFER_ID
npm run rat-things -- transfer status TRANSFER_ID
```

Add `--model DESTINATION_MODEL_ID` to `transfer plan` when changing models. The
plan reports `source_model` and `model` so you can review that change. Without the
option, Rat Things retains the local model ID. The selected model is checked before
snapshotting and again before uploading, then stays fixed through import retries.
This selection changes the copied Session only; it does not change the local
Session or rewrite its other agent settings. The desktop copy flow currently
retains the source model; use the CLI for a destination model change.

A retry reuses the saved snapshot and transfer identity, including after a service
restart. It resumes recorded uploads and recovers the same destination Session if
an import response was lost, even if the model catalog changes afterward. An
upload whose acknowledgement was lost can leave an
unused File at the destination; deleting that File is a separate operation.

The local original remains available. Changes made after review are not included;
prepare another transfer to capture them. This is application-state copying, not
live VM migration: active processes, ports, native execution IDs and reusable
subscription credentials do not move. The cloud worker restores `/workspace` and
uses destination model credentials. Original setup commands are not replayed.
The destination model catalog is a configuration check, not proof of subscription
entitlement; a completed Turn verifies actual model access.

The first transfer format accepts up to 10,000 filesystem entries, 100 MiB of
uncompressed workspace content, a 50 MiB archive, and 2 MiB of history. Regular
files, empty directories, executable permissions and internal relative symlinks
are preserved. External symlinks and special files are rejected. Credential-backed
tools need destination rebinding and are not accepted by this first import format.
Configured environment variables stay local; configure destination environment
values and tool credentials separately. The transfer contains workspace files and
conversation history, including any sensitive values you placed there, so review
that content before copying it.

**Connect AWS workspace** by itself only changes the active connection; it does not
copy a Session. Use **Use this computer** to return. Connection choices last for the
current app launch. `RAT_THINGS_AGENTS_API_URL` and `AWS_REGION` select AWS at launch;
the CLI otherwise uses the local connection.

## Where your work lives

The default directory is `~/.rat-things/local`. Its SQLite database stores encrypted
resource payloads alongside a private `storage.key`; both the key and connection
file are readable only by your OS user. Encryption does not protect against another
process running as that user. Keep the entire directory together when backing up. Linux workspaces live in
Session-owned container volumes and need a separate volume backup. Rat Things does
not encrypt those volumes itself; use device full-disk encryption.
Never discard the key while retaining the database.

Codex keeps its login and native thread history in the workspace's private `codex/`
directory, normally `~/.rat-things/local/codex`. This uses Codex's own storage
behavior and is not encrypted by Rat Things. The existing `~/.codex` login and
configuration are not used by durable local Sessions. Use device
full-disk encryption for protection at rest. This is a single-user workspace, not
a network service: the API always binds to `127.0.0.1` and has no public listen option.
