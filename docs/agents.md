# Connect an agent to Rat Things

Rat Things implements the OpenAI Agents API while keeping the backend, harness,
environments and durable state in the host's AWS account. It is an engineering
preview. Use the host's deployed contract and [Agents API guide](agents-api.md).

Discover the installation with `GET /.well-known/rat-things`. The control endpoint
uses AWS SigV4. The Agents HTTP endpoint accepts scoped bearer credentials issued
by the host's authenticated token endpoint; the Rat Things SDK transport obtains
and refreshes these credentials. Never supply a different owner in a request.

Create an Agent with a model allowed by the deployment, instructions and explicit
tools. Create a Session referencing that Agent, an environment and initial input.
Save the Session ID. Read Items for history and Turns for completion; subscribe to
Session events for live progress. Send subsequent input or cancellation through
Session events. An active root Turn accepts new input as steering.

Agents own reusable behavior. Environment templates own setup, files, skills and
network settings. Vaults hold credentials. [Schedules and provider bindings](schedules.md)
reference those resources without defining another kind of executable agent.

Authority is fixed before launch. Rat Things has no mid-Turn human approval flow.
Inside the allowed capabilities the agent acts autonomously. A denied operation
stays denied; the agent cannot obtain broader authority through an approval request.

Use [connections](plugins.md) for provider installation and delivery grants.
Declare agent-facing tools explicitly on the Agent. A notification connection does
not automatically expose that provider's operations as model tools.

The former Thing and Routine APIs and CLI commands have been removed. Their saved
tables are retained pending an explicit decision about old data. Remaining private
execution and publication integrations are described in the repository's migration
plan; use Agents and Sessions for new execution workflows.
