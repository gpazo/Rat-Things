# Browser computer use

Rat Things has built-in, agent-controlled browser use in remote Lambda MicroVM runs. It is an
**engineering preview**: the complete implemented browser surface passed a historical real-Codex
live-AWS canary under the former approval bridge. A fresh real-Codex canary also passed the current
autonomous fixed-envelope revision, including live viewing, temporary human takeover, secret-
redacted teach-by-demonstration, draft-Thing creation, and return of browser control. This is a view
of the isolated public-web browser, not an unrestricted remote desktop.

## What works today

An enabled Codex turn can:

- navigate to public HTTP and HTTPS pages;
- observe bounded visible text, controls, element references, boxes, and an optional screenshot;
- click by element reference or viewport coordinates;
- type with clear, append, and Enter-to-submit behavior;
- press keys and select options;
- scroll, wait, go back, and inspect the resulting page state;
- retain bounded PNG or JPEG screenshots, including full-page capture; and
- record a bounded VP8 WebM and publish screenshots or video through time-bounded share URLs.

An authenticated owner can also:

- view the current 1280×720 browser screen without exposing Chromium or a VNC port;
- take a fifteen-minute, renewable, exclusive browser-control lease and return control to the agent;
- click, type, navigate, press keys, and scroll through the reference console or control API; and
- capture up to ten minutes/100 demonstrated browser actions, redact typed and selected values into
  `{{input_N}}` parameters, and save the result as an unpublished manual Thing draft.

Takeover transfers only browser interaction. It does not pause shell/integration reasoning, widen
IAM, change egress, add tools, or create an approval decision. While the lease is active, agent
browser calls fail closed. Closing the viewer returns control unless a recording is active. Saving
a demonstration never tests, publishes, schedules, or runs the resulting Thing.

The browser runs as a separate Chromium helper under the unprivileged agent UID inside the outer
Firecracker-backed MicroVM. When browser use and network access are admitted before launch, all
browser operations run autonomously. There is no interactive approval prompt.

## Enable it from the CLI

Browser use is remote-only. A trusted local `rat-things local` run deliberately does not start the
MicroVM browser helper.

```bash
rat-things chat \
  --thread browser-demo \
  --profile small-business \
  --browser \
  --network \
  "Open the Selenium web form, fill it out, and retain a screenshot"
```

`small-business` enables browser use and allows integrations only through read-write.
`microvm-full` enables browser use and full integration access. Both are autonomous; reserve broad
profiles for work whose external effects are already bounded. A request can narrow a
profile with `--no-browser` or `--no-network`, but it cannot widen the deployment policy ceiling.

Use the live control surface to inspect or interrupt work:

```bash
rat-things watch RUN_ID --follow
rat-things interrupt RUN_ID
```

The console keeps the browser beside the conversation in a resizable context pane. `Browser`,
`Sources`, and `Activity` tabs keep the live screen, collected links/files, and human-readable work
phases together. `Take control` grants the same renewable exclusive lease as the API; the client
shows the remaining lease time, enables click/wheel/keyboard/navigation controls only for the human,
and returns control when the pane or conversation closes. The screen can be zoomed or viewed full
screen without changing the MicroVM viewport.

![Live AWS Rat Things console with a durable conversation, active Run strip, and NVIDIA earnings page under a temporary human-control lease](../assets/conversation-console-live-browser.png)

The active-Run strip remains visible while the browser is open, so watching or taking control does
not hide elapsed time, phase, progress, steering, or stop controls. `Activity` favors grouped phases
for ordinary review and keeps raw event evidence in an explicit disclosure.

![Human-readable Activity phases beside the same live AWS NVIDIA earnings conversation](../assets/conversation-console-live-activity.png)

The same viewer and teaching lifecycle are available from the cohesive CLI namespace:

```bash
# Open the signed loopback console directly on an active Run or durable conversation.
rat-things computer open --run RUN_ID
rat-things computer open --thread THREAD_NAME

# Inspect state, optionally retaining the current JPEG locally.
rat-things computer watch RUN_ID --screenshot screen.jpg

# Take exclusive browser control, send allowlisted actions, then hand it back.
rat-things computer takeover RUN_ID
rat-things computer act RUN_ID --file browser-action.json
rat-things computer release RUN_ID

# Record a demonstration. Stop creates an unpublished draft Thing; discard deletes the recording.
rat-things computer teach start RUN_ID --name "Submit weekly report" --goal "Submit the prepared report"
rat-things computer teach stop RUN_ID
# or: rat-things computer teach discard RUN_ID
```

`browser-action.json` uses the `HumanBrowserAction` schema in the installed OpenAPI document. The
console is the ergonomic surface for point-and-click use; the CLI is intentionally scriptable. The
older top-level `computer`, `takeover`, `handback`, `computer-act`, and `teach-*` commands remain
compatible aliases.

## Enable it through the API or a webhook policy

The equivalent run request is:

```json
{
  "version": "1",
  "prompt": "Open the form, submit it, and retain a screenshot",
  "agent": {
    "driver": "codex",
    "sandbox": "danger-full-access",
    "capabilities": {
      "profile": "small-business",
      "networkAccess": true,
      "computerUse": "browser"
    }
  },
  "execution": {
    "backend": "microvm",
    "timeoutSeconds": 720
  },
  "destinations": [{ "kind": "none" }]
}
```

Signed webhook sources can select the same installed profile through an owner-scoped source
binding. That lets a verified repository, team, or channel receive browser capability without
trusting fields in the provider payload. See [provider plugins and source bindings](plugins.md) and
the [control API](api.md).

## Safety boundaries

The helper blocks loopback, private, link-local, and common metadata destinations, revalidates
redirects, rejects popups and downloads, bounds DOM/image output, and validates every retained
artifact path. Screenshots are capped at 10,000 document pixels. Agent-created video recordings
remain capped at 60 seconds, 300 frames, and 64 MiB. Teach mode records a bounded redacted action
journal for up to ten minutes/100 actions rather than video; discard forgets the journal, while save
embeds it in an unpublished Thing draft. This avoids retaining demonstrated secret values in a
video and avoids the current WebM finalization latency on long sessions.

Those controls do not make an attacker-controlled public site trustworthy. Public egress can still
exfiltrate data, Chromium can have vulnerabilities, and the browser profile is not a secret boundary
from the model because both Chromium and Codex run under UID 10001. Do not enter reusable passwords
or API credentials. Prefer brokered integrations, where the model never receives the credential
value.

## What “full computer use” does not mean yet

Do not describe the current feature as unrestricted or production-hardened full computer use. Rat
Things still lacks:

- secure credential entry or autofill that keeps reusable secrets out of model context;
- live-AWS proof that an authenticated browser profile and cookies survive both later turns and a
  replacement MicroVM;
- file chooser uploads, managed downloads, clipboard, multiple tabs/windows, and popup workflows;
- hover, drag/drop, double/right click, iframe and shadow-DOM hardening, permission dialogs, and
  other long-tail browser interactions;
- an outbound origin policy, DNS-rebinding defense, content DLP, and an independent browser-escape
  and cross-owner security review;
- browser crash recovery, high-concurrency and long-SPA testing, and live cancellation and
  interruption canaries; and
- graphical desktop or native application control. Shell and filesystem tools exist, but there is
  no general remote desktop.

The live viewer and human takeover operate only while a browser-enabled Run is active. They are not
a persistent desktop between turns, do not expose arbitrary guest windows, and do not yet support
passkeys, native permission dialogs, or host-side secret injection. Treat takeover as interaction,
not as a secure credential broker.

Video finalization is also an engineering-preview path: the live 5 fps canary produced a valid
23.8-second WebM, but finalization took 168 seconds in that MicroVM. Keep evidence segments short
until the recorder is replaced or optimized.

## Live proof

On 2026-08-26, fresh disposable stack `comp260826a` passed the owner-authenticated live-computer
journey in 174.4 seconds. A real Codex-on-Bedrock Run remained active in an ARM64 Lambda MicroVM
while the test loaded a 1280×720 JPEG, acquired the exclusive human lease, recorded two browser
actions, saved an unpublished Thing draft, returned control, and observed the agent's exact success
marker. The demonstrated URL contained a secret query value and fragment, and the typed value was
also secret; the saved Thing contained `{{input_1}}` and neither secret nor query key. All 234 stack
resources were destroyed afterward; the tagged-resource audit confirmed the remaining AWS
tombstones gone, terminal, or deleting.

Later that day, fresh disposable stack `ux260826a` passed a 2.8-minute client-view journey against
NVIDIA's official Q2 FY27 earnings release. The console opened a real Codex browser Run, showed the
resizable conversation/browser layout and active-Run strip, acquired and returned the exclusive
human-control lease, sent pointer and scroll actions, exposed the official page in Sources, grouped
the browser work into human-readable Activity phases, and rendered the sourced final summary in the
transcript. The recorded H.264 MP4 was visually inspected, and all 234 stack resources were destroyed
afterward.

On 2026-08-21, a real Codex turn in a disposable ARM64 Lambda MicroVM exercised every implemented
browser command: `navigate`, `observe`, `record_start`, `type`, `press`, `select`, coordinate and
reference `click`, `screenshot`, `wait`, `back`, `scroll`, and `record_stop`. That historical canary
used the former approval bridge. The current contract executes the same statically admitted browser
surface autonomously; the 2026-08-26 canary validates the new viewing, takeover, and teaching path,
while a fresh all-command recording/publication rerun remains separate follow-up coverage.

The test verified submitted form values, retained a 59,298-byte PNG and 10,746-byte JPEG, and
produced a 1,547,168-byte, 1280x720, 5 fps VP8 WebM. It created three isolated publication hosts,
loaded each generated viewer, fetched byte-identical media, and matched all SHA-256 digests. The
screenshots and representative video frames were visually inspected. See the complete
[validation record](status-and-roadmap.md) and [security model](security.md).

See [the capability envelope](capability-envelope.md) before enabling browser use for sensitive
work. Assume the agent can exercise every admitted browser action against every destination allowed
by egress and the browser URL policy.
