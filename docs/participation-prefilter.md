# Opt-in participation prefilter (VIT-138)

This recovery implementation is based on main `44b11f3`. It reconstructs the
lost local change; it is not byte-identical to the prior unpushed commit.

`ControlConfig.participationSubscriptions` enables explicit per-member, per-scope
participation in actual development/private mock chat ingress. Omission preserves
legacy designated-worker behavior. An empty list is explicitly quiet. Subscription
fields are `memberId`, scope (`conversationId`, `threadId`), positive `revision`,
`enabled`, `joinedAt`, `membershipGeneration`, `responsibilities` (research and/or
source_verification), optional `maxMessages` (1–8, default 1), `maxChars` (1–8000,
default 8000). Private configuration validates and copies these fields.

Membership alone never authorizes access or work. Current read authority is checked
before inspecting message text; all existing claim/send/approval permissions remain
required. Rejoining requires a fresh subscription bound to the new membership
generation even after a new read grant. Messages at the join millisecond are
excluded conservatively because no finer join sequence exists.

History uses insertion order rather than random ID order, contains only valid chat
messages in the same scope, strictly after join and no later than the source, and
is count/text bounded. Attachment/result metadata is stripped from worker context.
Keyword participation remains the existing explicit-research heuristic, not a
semantic/model decision. Subscriptions expose both existing canonical task slots;
competing same-slot agents share one Task. Dev transport is limited to its single
configured runtime member, while private transport supports outbound member workers.

Claim stores a subscription digest and bounded history revisions on its Run. Read,
claim confirmation and publication revalidate those bindings without recording
candidate decisions for unrelated agents. Changing/disabling/deleting configuration
fails closed for bound runs; enabling opt-in also rejects legacy unbound runs.
Snapshots preserve bindings and candidate records. Explicit ingress records bounded,
deduplicated candidate decisions; read-side checks do not append candidate audit.

Lease-bearing private `/messages` reads require a run ID (as `/attachments` already
does). Valid bound reads get minimized history, and bound attachment reads fail.
**Normal member reads without worker headers retain scope authority. This is not
credential, process, or token isolation.** Existing workers share member credentials.

This is configuration-based opt-in, not a subscription lifecycle UI/API. Durable
catch-up, semantic participation, multi-controller arbitration, and live research
remain out of scope. Fake/pi-mock execution, synthetic-only sources and publication
validation are unchanged. No production/provider switch is enabled here.
