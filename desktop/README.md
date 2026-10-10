# Native Rat Things console

The console uses Rust, egui and eframe to render a desktop window. It manages
Sessions, Agents, environment templates and Vaults through the existing Agents API.
There is no browser engine or web frontend. Spotifast's use of egui inspired this
choice; this app uses released egui crates rather than Spotifast's application code.
The interface uses bundled Inter 4.1 fonts with compact 13-point body text and
neutral dark surfaces adapted from Linear's public site. Font files and their
SIL Open Font License are in `assets/fonts/`; no font download is needed at runtime.

## Build and launch

Install Node 22.20 or newer and Rust 1.95 or newer. On Linux, install the development
packages for a C compiler, pkg-config, X11, xkbcommon, Wayland and OpenGL. The native
file dialog uses the desktop portal on Linux.

```sh
npm ci
npm run console:build
RAT_THINGS_AGENTS_API_URL=https://your-api.example/v1 AWS_REGION=us-west-2 \
  npm run console:serve
```

`rat-things console` opens the native window. It uses your AWS credential chain,
including `AWS_PROFILE`. `--no-wait` detaches after the window opens. The optional
`--port` chooses the private helper's preferred port; occupied ports fall back to
a free port. By default each launch uses a free port.

`npm run console:build` builds the JavaScript distribution and a release desktop
binary in `dist/`. On macOS it also creates `dist/Rat Things.app` with its Node helper
runtime. Launch through the CLI to inherit your API endpoint, region and profile.
Local macOS bundles use an ad-hoc signature; they are not notarized for distribution.
Lambda packaging remains independent of desktop builds.
Run the desktop build again after `npm run build`, which replaces `dist/`.

## Use the console

Sessions occupy the main sidebar; Agents, Templates and Vaults are in its Workspace
section. Use Command/Ctrl+K to focus search, then Enter to open the first matching
session. Search includes older pages. Command/Ctrl+N opens a new session in the main
pane. A new-session draft is retained when you visit another session during the same
app run. Common actions use forms: describe a task and model for a Session, save an Agent's instructions,
configure environment packages and network access, or add a private credential.
The Model picker loads the authenticated deployment catalog when the form opens.
It shows exact model IDs, so the selection matches the model sent to the API.
It selects an advertised default for a new draft and keeps existing selections.
The Environment dropdown offers saved templates and No environment. Selecting a
hosted template sends its ID to the API, which applies its configuration and
permitted inline overrides. You can also choose Start session from a template's
detail page. The session labels managed environments as Rat Things managed and
separately connected executors as Connected worker. The upstream API value
`openai_hosted` remains a compatibility field; Rat Things provisions managed
compute in your AWS account. Hover over the label for its environment ID, or
right-click to copy it. Model and environment information are available in the
session header's Details menu. Advanced JSON retains the API's environment fields.
Use Refresh models to reload the list. If a saved model is no longer listed, choose
an available replacement before saving the form; it is never changed silently.
Advanced JSON exposes the remaining API request fields and preserves changes when
switching back to the form. The API derives ownership from your authenticated identity.
Choose an Agent to start a Session with its saved configuration. Resource IDs and
deletion are available in the Actions menu.

Sessions show durable messages, tool activity, required function results and saved
artifacts. Send another message to continue or steer work. Cancel turn interrupts
active work. Function results can be successful or failed, and empty output is valid.
Generated files stay behind the session header's Files count. Open it to inspect
or save a file; Escape or clicking outside returns to the conversation. New files
update the count without opening the list or shifting the transcript.
The desktop refreshes saved session state while a session is open, including after
connection failures. Active turns refresh frequently; idle sessions refresh less often.
Manual refresh is available in the sidebar's list options menu. Refresh keeps the current content and drafts visible until
updated data arrives. Small loading indicators appear only after a request takes
300 ms; a failed refresh preserves the last successful view. Clicking the current
section or selected row leaves its view intact. Reopen a Session to retrieve its saved history.

Browser automation uses explicitly declared Agent tools. The
[Playwright MCP example](../examples/browser/README.md) connects an isolated
browser in the execution environment; completed tool activity appears in the
conversation and retained screenshots appear in Files. The desktop does not
provide live browser viewing or takeover.

The sidebar uses compact single-line rows. Long names truncate visually and remain
available on hover. Status and model details stay in the conversation header and
row tooltip. Pin and rename sessions through the row's context menu or the selected
session's Actions menu. Pins are saved in metadata as `rat_things_pinned: "true"`.
Pinned sessions appear ahead of other sessions, including pins from older pages.
A new Session with no supplied name uses the opening user message;
older unnamed Sessions show a neutral label until their loaded history provides
a title. Loading history does not rename the saved Session.
Right-click a Session row and choose Archive session to hide it from the active
list. Archived sessions opens the archive; right-click a row there to unarchive it.
Archiving preserves history and does not cancel running work. Archive state is
stored in Session metadata as `rat_things_archived: "true"`, so it survives app
restarts; unarchiving removes that key while preserving other metadata. The archive
notification offers Undo without shifting the conversation or composer.

Vault credential values are write-only. The console clears credential drafts when
the editor closes. It does not persist transcripts, credential drafts or API tokens
in a desktop state file. Artifact downloads use a native save dialog.

## Authentication boundary

The native process starts one Node helper with a fresh random token. The helper
binds only to loopback, requires that token on every request, rejects browser origins
and serves only `/api/v1/` requests. It reuses `src/agents-client.ts` for IAM signing,
bearer issuance and renewal. The token is passed through environment and headers,
never a URL. Closing the app closes the helper; losing the parent pipe also closes it.

The helper rejects redirects except owner-authorized private artifact downloads.
It fetches those artifacts without forwarding the API's credentials. Production API
endpoints require HTTPS. Unsigned mode is restricted to local loopback fixtures.

## Contribute

The Rust library owns native controls, presentation state and background requests.
The executable owns the helper process and window lifecycle. The backend's domain
and core services remain in TypeScript. See [native console verification](../testing/native-console/README.md)
for local rendered tests and optional AWS validation.
