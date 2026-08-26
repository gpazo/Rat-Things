# Browser computer use

Rat Things has built-in, agent-controlled browser use in remote Lambda MicroVM runs. It is an
**engineering preview**: the complete implemented browser surface passed a historical real-Codex
live-AWS canary under the former approval bridge. The current autonomous fixed-envelope revision is
locally validated and still needs a fresh live-AWS rerun. This is headless public-web automation,
not unrestricted desktop computer control.

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
artifact path. Screenshots are capped at 10,000 document pixels. Recordings are capped at 60
seconds, 300 frames, and 64 MiB.

Those controls do not make an attacker-controlled public site trustworthy. Public egress can still
exfiltrate data, Chromium can have vulnerabilities, and the browser profile is not a secret boundary
from the model because both Chromium and Codex run under UID 10001. Do not enter reusable passwords
or API credentials. Prefer brokered integrations, where the model never receives the credential
value.

## What “full computer use” does not mean yet

Do not describe the current feature as unrestricted or production-hardened full computer use. Rat
Things still lacks:

- a user-visible live browser viewer with take-over and return-control for passwords, passkeys,
  two-factor authentication, CAPTCHAs, payments, and other human checkpoints;
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

Video finalization is also an engineering-preview path: the live 5 fps canary produced a valid
23.8-second WebM, but finalization took 168 seconds in that MicroVM. Keep evidence segments short
until the recorder is replaced or optimized.

## Live proof

On 2026-08-21, a real Codex turn in a disposable ARM64 Lambda MicroVM exercised every implemented
browser command: `navigate`, `observe`, `record_start`, `type`, `press`, `select`, coordinate and
reference `click`, `screenshot`, `wait`, `back`, `scroll`, and `record_stop`. That historical canary
used the former approval bridge; the current contract executes the same statically admitted browser
surface autonomously and will be revalidated in the next live-AWS run.

The test verified submitted form values, retained a 59,298-byte PNG and 10,746-byte JPEG, and
produced a 1,547,168-byte, 1280x720, 5 fps VP8 WebM. It created three isolated publication hosts,
loaded each generated viewer, fetched byte-identical media, and matched all SHA-256 digests. The
screenshots and representative video frames were visually inspected. See the complete
[validation record](status-and-roadmap.md) and [security model](security.md).

See [the capability envelope](capability-envelope.md) before enabling browser use for sensitive
work. Assume the agent can exercise every admitted browser action against every destination allowed
by egress and the browser URL policy.
