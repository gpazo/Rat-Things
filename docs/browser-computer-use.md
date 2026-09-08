# Browser computer use

If a Run has no browser capability, the console explains that browser access is unavailable and
stops retrying the screen endpoint. Activity and Sources remain available. Start a new conversation
with **Isolated browser** enabled when browser access is needed. A retained terminal frame labels
completed, failed, and intentionally stopped work separately.

Rat Things provides an isolated public-web browser inside remote Lambda MicroVM Runs. The agent
can use it autonomously within the Run's fixed capability envelope. The owner can view the screen,
temporarily take control, or turn a redacted demonstration into an unpublished Thing draft.

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

In the console, open **Work details**, then select **Browser** to place the isolated screen beside
the conversation in a resizable context pane. Work details opens Activity by default and remains
available after completion; it does not start another VM. `Browser`,
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

# Take exclusive browser control, send typed allowlisted actions, then hand it back.
rat-things computer takeover RUN_ID
rat-things computer navigate RUN_ID https://example.com
rat-things computer click RUN_ID --ref r3
rat-things computer type RUN_ID --ref r4 --clear --submit "quarterly revenue"
rat-things computer type RUN_ID -- --literal-leading-dash
rat-things computer press RUN_ID Enter
rat-things computer scroll RUN_ID --delta-y 600
rat-things computer back RUN_ID
rat-things computer release RUN_ID

# Record a demonstration. Stop creates an unpublished draft Thing; discard deletes the recording.
rat-things computer teach start RUN_ID --name "Submit weekly report" --goal "Submit the prepared report"
rat-things computer teach stop RUN_ID
# or: rat-things computer teach discard RUN_ID
```

The typed namespace covers `navigate`, `click`, `type`, `press`, `select`, `scroll`, `wait`, and
`back`. For generated actions, `rat-things computer act RUN_ID --file browser-action.json` still
accepts the installed OpenAPI `HumanBrowserAction` schema. The console is the ergonomic surface for
point-and-click use; the CLI is intentionally scriptable.

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
- a supported guarantee that authenticated browser profiles and cookies survive replacement
  MicroVMs;
- file chooser uploads, managed downloads, clipboard, multiple tabs/windows, and popup workflows;
- hover, drag/drop, double/right click, iframe and shadow-DOM hardening, permission dialogs, and
  other long-tail browser interactions;
- an outbound origin policy, DNS-rebinding defense, content DLP, and an independent browser-escape
  and cross-owner security review;
- guaranteed browser crash recovery or sustained high-concurrency operation; and
- graphical desktop or native application control. Shell and filesystem tools exist, but there is
  no general remote desktop.

The live viewer and human takeover operate only while a browser-enabled Run is active. At terminal
state the console stops browser polling, disables interaction controls, and displays the last
captured frame if one is available. That frame is a local view, not a durable browser session.
The viewer and takeover are not
a persistent desktop between turns, do not expose arbitrary guest windows, and do not yet support
passkeys, native permission dialogs, or host-side secret injection. Treat takeover as interaction,
not as a secure credential broker.

Video encoding can take longer than capture and delays finalization. Keep recordings short when
a prompt response matters.

See [the capability envelope](capability-envelope.md) before enabling browser use for sensitive
work. Assume the agent can exercise every admitted browser action against every destination allowed
by egress and the browser URL policy.
