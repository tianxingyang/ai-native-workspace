# CoSeat client context

## Platform
Reusable team IM interface; browser is the local verification host for this slice. A Windows desktop client is requested as a product direction; the desktop framework and delivery scope remain undecided. This slice does not claim to deliver an installer.

## Product truth
People and agents are equal team members with different permissions. Conversations and messages are the primary workspace. Research runs appear beside their source message and return their result to the same authorized thread. Capability, role, WorkMode and Grant remain separate.

## Stack
The task delegates the lightest reasonable frontend choice within the existing Node 24 / TypeScript stack. Use native HTML, CSS and browser modules, with a replaceable HTTP client module and no new production dependency. The existing private control service and outbound Worker remain authoritative.

## Constraints
Local synthetic identities only. No production credentials, real model calls, deployment or new grants. Credentials live in page memory only; reload requires reconnecting. Existing server authorization applies to every operation. Source fixtures and stop acknowledgements must be described honestly.

## Design assumptions
Chinese-first work chat used on a desktop in ordinary office light, with narrow-screen support. Familiar conversation navigation is explicitly requested; visual details are implementation assumptions, not a new brand commitment.

## Open decisions
Desktop framework and packaging, real authentication/session lifecycle, live research provider, attachments, direct messages, unread receipts and dynamically created threads are outside this slice.
