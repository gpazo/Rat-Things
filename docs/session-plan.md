# Session Plans

A Session Plan is the agent's current, ordered account of the work it intends to
do and the feedback it has handled. The Plan belongs to one Session. It is
separate from the accepted input log: receiving or dispatching a message never
changes a Plan item or marks work complete.

Open **Plan** in the workspace, or select the Plan summary above the message
composer. Select an item to read its explanation, see the contributors' source
messages and open linked results. **History** shows earlier revisions; **Current
Plan** returns to the agent's latest account.

The agent creates and updates the checklist. To challenge an interpretation,
reopen a question or add feedback, follow up in the conversation. Collaborators
can contribute through their existing roles; viewers can read the Plan and its
sources. Resolving an artifact discussion does not complete a Plan item.

Each item has a stable ID, a short description and one of these states:

- `next`: work the agent intends to take up.
- `working`: work currently in progress.
- `addressed`: the agent reports that it handled the item.
- `deferred`: the agent reports that it is postponing the item.
- `reopened`: work that needs another pass.
- `needs_discussion`: work that needs a decision or clarification.

Items marked `addressed`, `deferred` or `needs_discussion` include an explanation.
These states record the agent's account; they do not independently prove that a
change is correct or complete.

The agent is instructed to keep independent requests and verification checks in
separate items, preserving their IDs as work progresses. A completed edit should
not mark an unfinished check as addressed. For addressed items, the explanation
should say how that specific requirement was verified. Follow up in chat when
an item combines work with different outcomes or overstates the evidence.

## Updates and references

New Sessions admit the reserved `rat_things_plan_update` function before their
first worker starts. A running Session keeps the capabilities fixed at launch,
so Sessions created before Plan support do not gain this tool when they resume.
The Plan function is available in both Codex and Pi Sessions. It replaces the
complete ordered item list and supplies the current `expected_revision`. The
host commits each valid update as an immutable revision, stamps the agent, Turn,
time and receipt references, and returns the saved revision to the agent. A
replayed function call returns its original result; a stale revision receives
the current head so the agent can retry against it.

An item may refer to accepted message IDs from the same Session. Rat Things
resolves those IDs to the receipt that accepted them. Results may point to an
exact saved artifact version or to an activity item from the same Session.
When an agent refers to a file under `/workspace/outputs/`, Rat Things captures
that requested path for the current function call and resolves it to the exact
saved artifact ID and SHA-256 version. A missing capture cannot be replaced by a
later file at the same path. Links cannot name arbitrary URLs or people.

Plans are bounded to 50 items and 64 KiB per current snapshot. `activity.plan`
contains the current head when Plan is admitted. Read older revisions with
`GET /v1/rat/sessions/{session_id}/plan/revisions?after=<revision>&limit=<1..50>`.
The endpoint returns revisions in ascending order and follows the Session's
existing read authorization. Plan updates have no public HTTP write endpoint.
They are observed only from the admitted root Turn, and do not grant tools,
permissions or broader execution authority.

## Session lineage and transfer

A fork creates a new Session and starts with an empty Plan; its lineage points to
the source Session, which retains its Plan and history. A Share transfers the same
Session identity, preserving the current Plan and every revision while remapping
receipt IDs for imported inputs. Plan history must fit within 2 MiB and 10,000
revisions to transfer; a larger history prevents sharing rather than being
silently truncated. Plan references remain tied to the Session that owns them.
