# Native console copy review

These captures show the working Rust console with deterministic service fixtures.
They are not authored product mockups. `before/` contains captures from the prior
design pass; `after/` contains the corresponding current views and additional
wide and narrow states. Fixture names and model IDs are test data.

## Editorial changes

| Surface | Change |
| --- | --- |
| Welcome and navigation | Direct task heading and shorter starters; removed the promotional introduction, repeated section label and starter captions. |
| Creation forms | Removed descriptions that repeated the form's purpose; retained field labels, validation and secret-value handling. |
| Agents, templates and Vaults | Removed redundant section captions; shorter, role-neutral empty states. |
| Conversation and activity | Shorter composer hints, viewer state and recent-activity explanation. |
| Artifacts and browser feedback | One empty-state message; shorter annotation guidance; version/capture context remains beside feedback. |
| Workspace and account setup | Shorter local/AWS descriptions, connection boundaries and recovery instructions. |
| Copy, Share and team access | Direct transfer wording, current role guidance and actionable failure states. |
| Model and environment pickers | Shorter unavailable/empty states and runtime explanation. |

The pass also inspected confirmation, sign-in, loading, permission, provenance and
recovery copy. Information that changes a user's decision remains: where work runs,
what persists, which credentials stay local, fixed capabilities, verified authorship,
and the difference between connecting, copying and moving a Session.

`replacements.json` records the initial string substitutions. Structural removals
(such as starter captions and duplicate empty-state labels) are also reflected in
the native source. Prompt content, API requests and role enforcement were not
changed by this editorial pass.

Validation and fresh-eye review results are recorded in
[`REHEARSAL.md`](../../design/console-copy/REHEARSAL.md). No paid inference or AWS
deployment is needed to validate these presentation changes.
