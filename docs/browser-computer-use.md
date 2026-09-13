# Browser capabilities

Browser automation for an Agent must be supplied through a declared function or
MCP tool and enforced by the deployment's fixed capability policy. Creating a
standard Session does not inject browser tools or grant browser authority.

The former Run-scoped browser viewing, takeover and teaching routes and CLI
commands are removed. The Session console displays saved messages, tool activity,
function-result requests and artifacts; it does not provide a browser-control pane.

Rat Things retains its private Chromium helper and process/network isolation code
for local execution. Applications can expose browser capabilities through their
declared tools. An application that exposes browser tools
must implement their declared interface and preserve ownership, bounded operations,
network enforcement and separation from host credentials.

Browser screenshots or recordings produced in a managed environment can become
Session Artifacts when saved beneath `/workspace/outputs`. Use
[durable files](durable-files.md) for retention and [sharing work](sharing-work.md)
for explicit publication.
