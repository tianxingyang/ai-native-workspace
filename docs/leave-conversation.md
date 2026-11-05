# Voluntary conversation departure

An authenticated member can leave their own dynamically created group or direct conversation. This only ends their membership; it does not grant an action on another member, delete messages, transfer management rights, or delete the conversation. The original direct pair remains fixed. Rejoining still requires an existing authorized manager and fresh explicit grants. Leaving the last manager may therefore leave no in-app manager able to add that member back.

Static configured scopes, including provisioning authorities, do not expose this operation. Their memberships remain governed by the configured administrative paths. A member's ability to leave a dynamic conversation does not depend on read, send, manage-resource, the original creator's continuing authority, or a still-enabled creation rule. A valid identity and the member's own membership are sufficient. Human and Agent identities use the same rule.

## API and persistence

`POST /memberships/leave` accepts exactly `conversationId`, `threadId`, `expectedMembershipGeneration`, and `clientEventId`. Identity comes from the credential; target-member fields and other extra body fields are rejected. Discovery adds `canLeave` to readable session scopes. No separate member directory or private content is exposed by departure.

The server verifies the requested scope belongs to the caller's configured/historical membership and is dynamic, then checks membership generation before looking up an exact prior receipt. A completed leave can be retried with the same ID after losing all read access, including after a server restart. A new request from an already removed member fails. A request from a former generation fails even if its ID previously succeeded, so it cannot remove or claim confirmation for a rejoined membership. Add, remove and leave share an actor-scoped request-ID conflict domain.

A new leave uses the current scope revision inside the transaction, so an unrelated membership change does not prevent departure. Simultaneous administrator removal and voluntary leave cannot both remove the same current membership. SQLite persistence failure rolls back membership, receipt, context and run changes together.

The existing membership invalidation path marks all old work in the scope stale, disables old rebuilds, and withdraws previously published derived results. The removed member's leased work stays `unknown` unless there is stop evidence; unstarted work can be marked stopped. An exact duplicate receipt never invalidates the context again. Old worker publications are rejected by the existing lease/grant/context guards. Ordinary member credentials retain their existing meaning; this is not a new process sandbox or run-only credential design.

## Shared UI and outcome boundaries

The member-details pane offers departure for readable dynamic conversations, including read-only members. A confirmation names the conversation and describes loss of access and rejoin requirements. The API also permits members with no read grant to leave; this increment does not add a UI directory for those invisible memberships.

On a confirmed response, the client clears the captured generation's message, attachment, draft, pending-send, read-position and management caches immediately. It invalidates pre-existing session requests so a stale response cannot restore the departed scope. A late success cannot evict a newly joined generation or steal its input focus. Other authorized conversations and independent provisioning authority remain available.

While the same connection and readable scope remain available, an unknown response keeps the original request ID for an explicit retry. Closing the dialog or connection, scope loss or generation change ends that in-memory retry state. In particular, after leaving the last readable scope a lost response may be followed by `no_readable_scope`: the UI clears content and states that the request was not confirmed. It does not equate an empty or denied session with that request's successful receipt. Durable recovery of a lost request ID remains part of the unfinished client-outbox work.

The dialog prevents background read advancement, respects known read deadlines offline, and keeps keyboard focus in the modal. Confirmed departure focuses the remaining conversation, management entry, or connection form. Both desktop bridge layers expose only the exact POST route; real Node-sidecar tests verify static-scope denial. Chromium and Rust tests do not substitute for an installed Windows WebView validation.

VIT-104 remains In Progress. Independent threads, persistent client outbox/cursors, broader attachment support and language choices are separate remaining work. No real model, deployment, OS permission change or credential persistence is introduced.
