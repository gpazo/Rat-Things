# Native console test harness

Install the repository's Node dependencies and the Rust toolchain specified by
`desktop/Cargo.toml`, then run:

```sh
npm ci
cargo test --manifest-path desktop/Cargo.toml --test console_e2e -- --nocapture
```

The test launches the local TypeScript fixture and the production console proxy
on ephemeral loopback ports. It drives the real `ConsoleApp` using egui's
AccessKit test harness: controls receive clicks, keyboard events, and text input.
It never assigns application state to skip a user interaction. The test checks
requests and durable service records as well as the visible interface.

The fixture uses the production Agents router and Agent, Session, Vault, and
Environment Template services. Storage, secret persistence, and worker execution
use deterministic in-memory ports. It does not provision AWS resources or run a
model. The proxy retains its normal bearer-token authentication and owner
resolution. Child processes are stopped when the test exits, including after an
assertion fails.

The session journey covers creation, steering, an empty tool result, completion,
app recreation with saved output, a second turn, and cancellation. Configuration
coverage includes saved-agent pagination and editing, starting from a saved
agent, environment-template CRUD, write-only credential creation and rotation,
revocation, editor clearing, and request errors.

Files remain hidden until the header's Files control is opened. The journey checks
keyboard opening and Escape focus restoration, viewport fit, pointer interaction
inside the popover, draft preservation, and dismissal across navigation.

Model picker checks cover advertised defaults, explicit selection and persisted
model IDs, catalogs without a default, empty lists, failed requests and retry,
and saved models removed from the catalog. Agent edits also verify that switching
between partial Advanced JSON and the form preserves an existing nondefault model.

Session, Vault and credential creation use the native forms. Template checks
exercise comma-separated package entry and switching between the form and
Advanced JSON without losing fields. Password checks verify that typed secrets
are masked and absent from the accessibility tree.

Rendered PNGs are written to `test-results/native-console/` at 1280×850 and
900×650. These are real wgpu renders for visual inspection; the test does not
claim pixel-golden comparison. The artifact check verifies the visible save
control, supplies a temporary
destination to the production save method, and checks the downloaded bytes and
file permissions. The headless harness does not test operating system window
management or the native file-picker interaction. Those require a
separate desktop smoke check.

To exercise the actual desktop window against the same local fixture:

```sh
cargo build --locked --manifest-path desktop/Cargo.toml
node testing/native-console/launch.mjs
```

Create a Session, open its artifact with the Save control, and choose a destination
in the operating system's file dialog. Closing the window stops its helper and
the fixture. To exercise the packaged macOS bundle, run `npm run console:build`
and set `RAT_THINGS_CONSOLE_BIN` to
`dist/Rat Things.app/Contents/MacOS/rat-things-desktop` when starting the fixture
launcher.

When running from a separate worktree, `RAT_THINGS_TEST_ROOT` can point to the
repository containing the TypeScript fixture and installed `node_modules`.
`NODE` can select the Node executable. Neither variable changes the application
request protocol.

## Real browser journey

```sh
npm ci
npx playwright install chromium
npm run test:e2e:browser
```

This optional test launches the pinned Microsoft Playwright MCP provider and a
real isolated Chromium process. It drives the native New session form, declares
the [example browser tool](../../examples/browser/tool.json), and runs MCP calls
through the production environment bridge. Navigation opens a loopback test page;
typing and clicking submit a unique value that the page server records. The
resulting browser snapshot must contain that value. An undeclared code-execution
tool must fail without reaching its target page.

The production artifact capture service copies the real PNG into an in-memory
object store before completion. The live output directory is removed; the native
Files menu must still download those retained bytes, with private permissions.
The app is recreated and must restore the result and Files count. Evidence and
screenshots are saved under `test-results/native-console/browser-*`.

The model's choices and the execution VM are deterministic local adapters. This
test does not call a model, deploy AWS, test a remote worker's sandbox, or provide
a live browser-control pane. The repository's installed test Chromium is passed
explicitly to the provider; `RAT_BROWSER_EXECUTABLE` can choose another installed
binary. Normal `console:check` leaves this browser-dependent test ignored; CI
installs Chromium and runs it explicitly.

## Opted-in AWS probe

`console_live` is an ignored test. The deployment harness can invoke it with:

```sh
AWS_E2E_CONSOLE=true AWS_E2E_REAL_CODEX=true \
  cargo test --manifest-path desktop/Cargo.toml --test console_live \
  -- --ignored --test-threads=1
```

It also requires `RAT_THINGS_AGENTS_API_URL`, `AWS_REGION`, and
`AWS_E2E_CODEX_MODEL_ID`, plus the AWS credentials for that deployment. It starts
the production signed proxy, creates one Session through the native controls,
waits for two real completed Turns, recreates the app to verify saved assistant
output, and deletes the Session. `AWS_E2E_TIMEOUT_MS` sets the per-Turn timeout
(default 420000). Both explicit opt-ins are checked before starting any process.
Ordinary test commands leave this test ignored and make no AWS or model calls.
