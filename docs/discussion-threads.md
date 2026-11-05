# Ordinary discussion threads

VIT-125 adds an independent message scope inside an existing conversation. This
does not replace replies: `replyToMessageId` still refers only to a message in the
same scope. Each new thread has a server-generated UUID, its parent's exact
`conversationId/threadId`, a title, revision 1, active lifecycle, creator and
creation time. An optional source message ID refers to the parent scope without
copying its body. Nested thread creation and private threads are not supported.

## Permission decision: parent-v1

VIT-101 records the user's delegation to choose initial product permission rules
provided they remain easy to change. VIT-125's restriction on *unconfirmed*
inheritance rules was an unresolved decision, not a permanent ban on using the
conversation's authority. The following decision resolves that item without
adding private audiences or independent member lists.

- Creation requires current parent `read` and `send`, and the caller's current
  membership generation. Management alone cannot create/read a thread.
- A child uses the parent's current audience and current Grants, evaluated anew
  for each of `read`, `send`, `claim`, `request_approval`, and `cancel`. Membership
  alone never grants access. Existing default-deny, disabled actions, explicit
  deny precedence, source-chain validity and grant expiry continue to apply.
- No Grant is copied or issued. Child scope management, permission issuance,
  external sending, permanent deletion and continuous execution are not enabled.
  Membership changes and voluntary exit happen at the parent conversation.
- Provisioning authority scopes cannot be used as parents. Existing configured
  conversation scopes and dynamically created group/direct scopes can be parents.

The rule is data in `THREAD_POLICY` in `src/control/threads.ts`, with a version and
source identifier. Thread metadata stores `parent-v1`; unknown rule identifiers
fail closed. The child authorization digest includes the rule, and work checks
that digest before execution and publication. A future change must update this
central rule and its version, review persisted thread migration, and re-run the
authorization matrix. This is a product policy, never authority to alter a host
device, production configuration or third-party permissions.

## Consistency and isolation

`POST /threads` accepts only parent scope, title, event ID, expected membership
generation, and optional source message ID. Current authorization is checked even
for an exact retry. The event identity binds all input fields; changed retries
conflict. Creation, receipt and metadata commit in the existing SQLite snapshot
transaction, and roll back together on failure. Source references must currently
exist in the parent scope and cannot be withdrawn/invalidated content.

Session discovery uses current read authorization. Child scopes reuse existing
message delivery, sync, read-position and per-scope UI state. A parent membership
change invalidates child run context, prevents old publication, and uses existing
cancellation reconciliation; uncertain stop remains unknown. Rejoining changes
the child generation and clears its old reading position. Parent and sibling
messages, replies and work routes remain separate. Creation never changes an
existing work route or hot-updates a runtime session.

The first slice supports creation and active threads; archival/deletion and
independent membership rules are not supplied. Installed Windows acceptance is
tracked in VIT-124. Validation evidence will be recorded for the final reviewed
commit; this design record alone is not a completion claim.
