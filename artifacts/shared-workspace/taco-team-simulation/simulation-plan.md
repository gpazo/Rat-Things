# Four-collaborator restaurant website simulation

Run four independent AI teammates through four actual ConsoleApp clients, backed
by one shared local Rat Things Session and one end-to-end coding agent. The client
lead, designer, engineer and QA must discover and discuss requirements in the
product, inspect the generated website, and provide independent experience reports.
No messages or website output are pre-scripted. Fictional client: Taco Cometa.

Use GPT-6 Luna for collaborators and the verified local subscription model. API
inference spend budget: $0; no fallback to API or a more expensive model. Shared
agent limits: 10 Turns, 400,000 observed tokens, 60 tool Items, 25 minutes. These
are observed ceilings, not provider-level token guarantees. Each collaborator:
2 work rounds, at most 3 submitted contributions total, then a no-send retrospective.
Delegation telemetry and subscription per-run cost unavailable; record usage when
reported. Local infrastructure only; preserve the existing sign-in profile.

All participant contributions use native composer/annotation controls through a
bounded test driver. The four client identities are fixture loopback identities,
not an OIDC-login test. The core Session, worker, browser, attribution, Plan and
artifacts are production services. The driver uses headless native components,
not operating-system windows. Four agents run in bounded waves because the host
has three child slots; four product clients remain connected throughout.

Preserve an event/action log, screenshots, submitted messages, final website bytes,
model usage and independent participant reports. Fix harness setup blockers only;
record product friction during the simulation before proposing fixes. No deployment,
no real restaurant facts, no orders/payments and no external messages.
