# Local workspace flow review

```sh
node testing/local-runtime/flow-review/serve.mjs
```

Open `http://127.0.0.1:4318`. The preview server exposes only the explicit review
files, shared brand tokens, fonts and artwork. Set `RAT_FLOW_PORT` to choose
another loopback port.

This is a clickable design artifact, not the desktop implementation. Every
screen is labeled as simulated. It opens no real account login, runs no model,
installs no environment and provisions no cloud resources. Limits and destinations
remain in memory and reset on reload. It uses the repository brand assets and
palette; the production console remains native Rust/egui.

Review the normal path from welcome through ChatGPT sign-in, local preparation,
setup progress, first job and settings. Then connect an example AWS destination,
review the idle Session copy, simulate interruption and retry. The screen picker
also exposes each state independently. Setup failure controls cover interrupted
downloads, insufficient disk, boot failure and expired sign-in.

## Review checks

- Welcome makes This computer the primary path and leaves AWS optional.
- Account setup offers ChatGPT subscription sign-in, with credentials on the host.
- CPU/memory/concurrency edits update the proposed maximum allocation.
- Finish later preserves the simulated progress within the tab.
- Settings update the example Session summary; invalid numeric values are rejected.
- The AWS copy review displays the entered destination, preserves the local original,
  explains credential and billing differences, and leaves the destination idle.
- Each failure has a direct recovery action and keeps the original workspace.
- Desktop and narrow layouts retain readable controls and keyboard focus.

Image sizes, disk requirements, destination compatibility and installation progress
must come from real runtime operations when these flows move into the console.
The preview deliberately makes no estimate of cloud pricing or image size.
