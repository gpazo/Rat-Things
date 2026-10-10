# Optional browser tool

`tool.json` connects Microsoft's Playwright MCP provider through the existing
environment tool transport. Add its object to an Agent's `tools` array, including
through the native console's Advanced JSON editor. It grants six browser tools;
it does not add shell execution, arbitrary browser code, or page-defined WebMCP tools.
The browser runs in the execution environment, not on the console user's desktop.

Provision the provider and Chromium in the execution image before using this
declaration. The image needs Node and Chromium's platform-specific libraries.
For a compatible image, install the pinned provider and its matching browser:

```sh
npm install --prefix /opt/rat-browser --save-exact @playwright/mcp@0.0.83
PLAYWRIGHT_BROWSERS_PATH=/opt/rat-browser/browsers \
  node /opt/rat-browser/node_modules/@playwright/mcp/cli.js install-browser chromium
PLAYWRIGHT_BROWSERS_PATH=/opt/rat-browser/browsers node --input-type=module <<'NODE'
import { createRequire } from 'node:module';
import { symlinkSync } from 'node:fs';
const require = createRequire('/opt/rat-browser/node_modules/@playwright/mcp/package.json');
symlinkSync(require('playwright-core').chromium.executablePath(), '/opt/rat-browser/chromium');
NODE
```

Run these as image build steps, with the resulting files readable/executable by
the worker UID. Installing the repository's development dependencies does not
provision a deployed worker. The stock Rat Things MicroVM image has not been
changed to include Chromium; verify the image's OS libraries and sandbox support
before deploying this example. Do not disable the browser sandbox to hide an
incompatible environment.

Use an `openai_hosted` execution environment for automatic artifact capture, and
give it an explicit network policy for the task's sites. Add an instruction such as:

> Use browser snapshots to locate controls. Save requested screenshots as
> `outputs/browser.png`. Report browser failures rather than claiming success.

Explicit screenshot filenames are relative to `/workspace`; `outputs/browser.png`
is therefore captured beneath `/workspace/outputs`. Automatic accessibility
snapshots stay in `/workspace/.browser`. Screenshots are retained before the Turn
completes and appear in the native console's Files menu. Self-hosted execution
does not automatically capture its filesystem as Session artifacts.

Each MCP connection starts with an isolated browser profile. Cookies are not
imported from the user's browser, and browser close/restart loses that profile.
The deployment's network controls enforce egress; Playwright's origin filters are
additional guardrails, not an isolation boundary. The console currently exposes
tool results and downloadable screenshots, not live browser viewing or takeover.

For the real Chromium integration journey, see
[the native browser harness](../../testing/native-console/README.md#real-browser-journey).
Provider options are documented in the
[pinned upstream README](https://github.com/microsoft/playwright-mcp/blob/v0.0.83/README.md).
