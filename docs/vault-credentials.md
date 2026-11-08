# Use Vault credentials from a managed workspace

Attach a Vault when workspace commands need to authenticate to an HTTPS service.
The command receives an environment variable containing a placeholder. The trusted
host replaces that placeholder with the credential only in HTTPS request headers
sent to an allowed host.

This guide uses a managed AWS environment. Local workspaces, `none` environments,
do not support this environment-credential path.

## Create and attach the credential

Connect a trusted application with the [Agents client](agents-api.md#connect).
Use an identity with Vault write, Agent write, and inference permissions. Load the
secret into that application's `SERVICE_TOKEN` environment variable from your
secret store. Do not put its value in Agent instructions or a checked-in file.

Replace `api.example.com` with the service's exact hostname. Credential hosts do
not accept URL schemes, paths, ports, or wildcards. Use a credential with at least
eight characters and only the provider permissions this Agent needs. Limited networking
accepts one to sixteen unique hostnames or IPv4 addresses.

```ts
const vault = await client.beta.agents.vaults.create({ name: 'Service access' });
const credential = await client.beta.agents.vaults.credentials.create(vault.id, {
	name: 'Service token',
	auth: {
		type: 'environment_variable',
		secret_name: 'SERVICE_TOKEN',
		secret_value: process.env.SERVICE_TOKEN!,
		networking: { type: 'limited', allowed_hosts: ['api.example.com'] },
	},
});

const session = await client.beta.agents.sessions.create({
	agent_id: 'agent_example',
	vault_ids: [vault.id],
	environment: {
		type: 'openai_hosted',
		network: { access: 'restricted', allowed_domains: ['api.example.com'] },
	},
	input: 'Read the service status using SERVICE_TOKEN in the Authorization header.',
});
```

Use the ID of an Agent you own. Save the returned Vault and credential IDs for
administration. Credential reads and lists return metadata without secret values.

Every credential host must also be allowed by the environment when its network
access is restricted. Each attached environment credential needs a distinct
`secret_name`. Do not also define that name in the environment template's `env`.

For provider-created Sessions, set `vaultIds` on the [source binding](schedules.md#provider-bindings).
The Agents API uses `vault_ids`; the control API binding uses `vaultIds`.

## Use the placeholder in a request

A workspace command can use the variable as a bearer header:

```bash
curl --fail --silent --show-error \
	-H "Authorization: Bearer $SERVICE_TOKEN" \
	https://api.example.com/status
```

The workspace's `SERVICE_TOKEN` value starts with `rat_secret_`; it is not the
credential itself. Keep the injected proxy and certificate settings so the HTTP
client uses the host's authenticated HTTPS path. Substitution supports ports 443
and 8443. It does not substitute credentials in URLs, request bodies, files, or
arbitrary process protocols.

For an environment stdio MCP tool, list `SERVICE_TOKEN` in its transport's
`env_vars` to inherit the placeholder. Do not put the raw value in the tool's
inline `env`. Service-side MCP credentials use the separate MCP authentication
types in the Vault API.

Literal `${NAME}` strings and hand-written `rat_secret_…` values are not Vault
references. Only the placeholder generated for an attached credential is substituted.

## Rotate a credential

Load the replacement value into the trusted application's environment, then update
the credential:

```ts
await client.beta.agents.vaults.credentials.update(credential.id, {
	vault_id: vault.id,
	auth: { type: 'environment_variable', secret_value: process.env.SERVICE_TOKEN! },
});
```

New Sessions use the replacement value. Existing Sessions retain their credential
snapshot. Rotation cannot change the credential's name, allowed hosts, or
authentication type. Create a new credential and a new Session for those changes.
If a credential is compromised, revoke it at the provider and stop affected
Sessions; changing the Vault alone does not revoke an existing snapshot.

## Handle rejected requests

- If template creation rejects a credential-like key, move the value to a Vault.
  Populated names such as `SERVICE_TOKEN`, `API_KEY`, and names containing `SECRET`
  are rejected in plain environment and inline MCP configuration.
  The name check permits `PUBLIC_KEY`, `SSH_PUBLIC_KEY`, `GPG_KEY`, `TERMINFO_KEY`,
  `SORT_KEY` and `PARTITION_KEY`; these exceptions do not make a secret value safe.
- If Session preparation rejects network policy, allow every credential host in
  the environment and keep network access enabled.
- If the service returns an authentication error, check the credential's provider
  permissions, expiration, and header format. The host substitutes the value; it
  does not add a header or grant provider access.
- If an authenticated response uses an unsupported content encoding or upgrades to
  a WebSocket, the proxy rejects it rather than forwarding an unprotected response.

The host scrubs supported raw and encoded credential echoes from responses and
known secrets from saved and delivered output. This is an additional defense, not
a substitute for host restrictions or narrow provider grants. Model-authentication
credentials have separate guest-readable bridges. Read [secret handling](security.md#secret-handling)
before running untrusted repository code.
