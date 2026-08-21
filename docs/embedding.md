# Embed and self-host Rat Things

Rat Things is a headless automation backend. It can sit behind a small-business operator console,
a CLI, another agent, or a SaaS product without requiring a Rat-operated control plane. The same
deployment can serve one person or many authenticated users; the host decides that product model.

The integration boundary is intentionally flexible and narrow:

- the host authenticates people and services;
- Rat derives an owner from the trusted principal and scopes all control data to it;
- the host supplies its own OAuth applications and consent UI;
- Rat stores provider credentials and enforces grants after a connection is created; and
- every consumer uses the same documented API—there is no privileged console-only path.

## Discover a deployment

Start with an unauthenticated discovery request:

```http
GET /.well-known/rat-things HTTP/1.1
Accept: application/json
```

It returns relative links so reverse proxies, custom domains, and independent deployments work
without a central registry. Important entries are:

```json
{
  "version": "1",
  "service": "rat-things",
  "deployment": {
    "operation": "independent",
    "tenancy": "host-defined",
    "identity": "host-authenticated principal",
    "oauthApplications": "bring-your-own"
  },
  "api": {
    "openapi": "/openapi.json",
    "schemas": {
      "thing": "/schemas/thing-v1.json"
    }
  }
}
```

The published [OpenAPI contract](../spec/openapi.json) describes every installed HTTP route and its
request contract, including Things, integrations, runs, conversations, routines, publications,
discovery, and optional provider webhooks. JSON Schemas are suitable for editor completion, form
generation, agent tool definitions, CI fixtures, and validation before a network call. Centrally
hosted agent-readable navigation is available at
`https://gpazo.github.io/Rat-Things/llms.txt`; a deployment's discovery document links to the
canonical documentation but never sends runtime data there.

Schema validation is preflight, not authority: the runtime remains authoritative for UTF-8 byte
limits, deployment allowlists, installed profiles/plugins, owner scope, and current external state.

## Two supported consumer shapes

### Operator or small-business console

Build a UI that calls the API on behalf of its signed-in principal:

1. show installed profiles and integration plugin manifests;
2. create connections through the host's own OAuth or API-key flow;
3. group accounts into connection sets;
4. create a draft Thing from a validated ThingSpec form;
5. render `explain` diagnostics and operation permissions before enabling;
6. submit an explicit run and follow its events; and
7. display files/publications through the owner-checked artifact APIs.

The console must use an authenticated backend-for-frontend when the deployed control API uses AWS
IAM. Do not expose AWS signing credentials, provider tokens, S3 coordinates, or MicroVM proxy tokens
to browser JavaScript.

### Embedded product or SaaS

Keep customer/product state in the host application. Store only Rat IDs needed to associate that
state with connections, Things, conversations, and runs. The host can map every authenticated
tenant or end user to a distinct principal, or intentionally map a group to a shared principal.
Rat does not implement signup, organizations, seats, billing, or invitations and does not infer
them from request bodies.

A typical server-side flow is:

```text
host session/service identity
          |
          v
backend-for-frontend or worker -- SigV4 --> Rat control API
          |                                  |
          |                                  +--> owner-scoped metadata
          |                                  +--> encrypted definitions/credentials
          |                                  +--> isolated agent run
          v
host database stores Rat IDs and product presentation state
```

## Identity contract

The included AWS API Gateway adapter accepts an IAM authorizer's `userArn`/`callerId` or a JWT
authorizer's `sub`, then prefixes it into Rat's identity namespace. Callers cannot submit an
`ownerId`. Local testing may set `ALLOW_OWNER_HEADER=true`; production deployments must keep that
escape hatch disabled.

If a host replaces API Gateway authorization, its transport adapter must still produce one trusted,
stable principal before invoking core services. Keep these identities distinct:

| Identity | Meaning |
| --- | --- |
| actor | Human or system responsible for the request |
| owner | Isolation boundary for Things, connections, runs, and artifacts |
| source | Verified API/provider context that caused work |
| destination | Explicit result-delivery target |
| credential subject | Runtime or actor whose credential policy applies |

Do not silently use a provider sender as an owner or let a request choose another tenant's
credential subject.

## Bring your own OAuth

Rat Things does not register a universal OAuth client. The host owns provider developer accounts,
redirect URLs, consent copy, PKCE/state verification, token exchange, refresh policy, and provider
review obligations. After successful consent, the host submits the resulting credential over the
authenticated connection-create API and immediately discards its plaintext copy where possible.

Connection metadata records the provider authorization separately from the Rat grant. This permits
a broad upstream token to be exposed as read-only for one account selection, while accurately
showing when enforcement is broker-only because the provider has coarse scopes. Rotation and
revocation remain explicit owner-authenticated operations.

Never put access tokens in a Thing, run request, DynamoDB record, webhook payload, log, URL, or CLI
argument. JSON credential files used by the CLI should be short-lived and protected by the host OS.

## Webhooks and outbound events

Provider webhooks are separate from the control API. Each unauthenticated route verifies the exact
provider signature before parsing or enqueueing. A host may place a reverse proxy in front, but it
must preserve the raw signed body and required headers.

For an embedded product that wants completion events, consume the configured EventBridge stream or
poll owner-scoped run state. Do not treat provider result delivery as an application event bus: it
has side-effect fencing and provider-specific retry semantics. Generic signed Thing webhooks and a
public SDK are planned facade work, not current v1 behavior.

## Installation boundary

The repository Terraform module installs the runtime into the operator's AWS account. It creates
private encrypted data stores, queues, Lambda control functions, and optional MicroVM/publication
resources. It does not create a central Rat account or phone home. Start with
[development and deployment](development-and-deployment.md), then run:

```bash
npm ci
npm run package
terraform -chdir=infra init
terraform -chdir=infra apply

export RAT_THINGS_API_URL="$(terraform -chdir=infra output -raw api_endpoint)"
export AWS_REGION="<deployment-region>"
rat-things doctor --json
```

`doctor` tests local prerequisites, public health/discovery, and an authenticated control request.
Use [diagnostics](diagnostics.md) for the repair sequence and [security](security.md) for the trust
boundary before putting real customer data into a deployment.
