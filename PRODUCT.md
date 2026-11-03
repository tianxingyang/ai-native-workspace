# CoSeat client context

## Platform
Reusable team IM interface, now hosted in a Tauri Windows installer as explicitly requested. The browser remains a supplemental local verification host. The desktop slice is a disposable local mock, not a production authentication or remote service client.

## Product truth
People and agents are equal team members with different permissions. Conversations and messages are the primary workspace. Research runs appear beside their source message and return their result to the same authorized thread. Capability, role, WorkMode and Grant remain separate.

## Stack
Native HTML, CSS and browser modules, with a replaceable transport module. Tauri 2 provides the Windows window, tray and notification adapter. The packaged Node 24 runtime starts the existing private control service and outbound Worker; they remain authoritative.

## Constraints
Local synthetic identities only. No production credentials, real model calls, deployment or persistent grants. Browser credentials live in page memory; desktop credentials remain in the disposable backend process, never reaching the renderer. Reload requires reconnecting to the same bounded demo. Existing server authorization applies to every operation. Source fixtures and stop acknowledgements must be described honestly.

## Design assumptions
Chinese-first work chat used on a desktop in ordinary office light, with narrow-screen support. Familiar conversation navigation is explicitly requested; visual details are implementation assumptions, not a new brand commitment.

## Open decisions
Real authentication/session lifecycle, remote connection, live research provider, attachments, direct messages, unread receipts and dynamically created threads remain outside this slice. Windows native interactions must be reported with their actual verification status.
