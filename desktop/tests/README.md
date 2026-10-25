# Desktop acceptance harnesses

The ordinary console tests use local fixtures. `local_pi_e2e.rs` is an explicitly
opt-in journey through the production Rust widgets, production console proxy,
live ChatGPT subscription inference, and the isolated Linux KVM worker.
It is ignored by ordinary `cargo test` runs.

## Live local Pi journey

Build the current development KVM runtime and start the local service using the
[local workspace instructions](../../docs/local-workspace.md). Sign in to ChatGPT
before running this harness. The existing profile and `connection.json` must be
private, the runtime must report ready, and no other managed Session may occupy
the worker. The harness does not sign in, prepare the runtime, or select AWS.

From the repository root:

```sh
LOCAL_E2E_CONSOLE=true \
LOCAL_E2E_REAL_PI=true \
RAT_THINGS_LOCAL_DIR="$HOME/.rat-things/local" \
cargo test --manifest-path desktop/Cargo.toml --test local_pi_e2e \
  -- --ignored --nocapture --test-threads=1
```

This uses the signed-in account's live `gpt-6-luna` allowance. Both opt-in flags
are required. `LOCAL_E2E_TIMEOUT_MS` optionally changes the five-minute deadline
for each turn. Install the normal repository and desktop build dependencies
before running it; rendering also requires a working wgpu graphics adapter.

The harness uses `egui_kittest` to create a saved Pi Agent through the runtime and
model pickers, choose **Linux on this computer**, submit a task, expand a real
command result, reopen `ConsoleApp`, and send a second turn to the same Session.
The model must write, read, and list a unique workspace file and execute argument
arrays as guest UID 10001. The second turn must read the first turn's file before
replacing and verifying its content. API reads verify durable records and the
workspace file listing; they do not create the Agent, Session, or turns.

Rendered PNGs and a sanitized `evidence.json` are written under
`test-results/local-pi-ui/<unique-name>/`. They record the actual Rust widget
frames and identifiers, without connection tokens or account details. The
harness deletes its own Session and Agent afterward and closes only its console
proxy. If cleanup fails, its unique name is printed for manual cleanup through
the console. This checks the real widget, HTTP, model, and VM path; it does not
claim operating-system window or input automation.

To compile or confirm the opt-in gate without contacting the local service:

```sh
cargo test --manifest-path desktop/Cargo.toml --test local_pi_e2e --no-run
cargo test --manifest-path desktop/Cargo.toml --test local_pi_e2e
```
