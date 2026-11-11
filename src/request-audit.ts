import { randomUUID } from 'node:crypto';
import { ApiError, requireCondition } from './contracts.js';

export const REQUEST_AUDIT_LIMIT = 1000;
const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'CONNECT', 'TRACE', 'OTHER'] as const;
export type RequestMethod = typeof methods[number];
const routes = ['unknown', 'web_asset', 'health', 'session', 'attachments', 'conversation_options', 'conversations', 'conversation_rename',
  'threads', 'memberships', 'membership_leave', 'membership_remove', 'membership_add', 'sync', 'messages', 'message_receipt',
  'message_change_receipt', 'message_edit', 'message_retract', 'read_position', 'worker_poll', 'worker_events', 'worker_not_started',
  'tool_claim', 'tool_confirm_claim', 'tool_send', 'tool_request_approval', 'runs', 'run', 'run_cancel'] as const;
export type RequestRoute = typeof routes[number];
const staticRoutes: Readonly<Record<string, RequestRoute>> = Object.freeze({
  '/health': 'health', '/session': 'session', '/attachments': 'attachments', '/conversations/options': 'conversation_options',
  '/conversations': 'conversations', '/conversations/rename': 'conversation_rename', '/threads': 'threads', '/memberships': 'memberships',
  '/memberships/leave': 'membership_leave', '/memberships/remove': 'membership_remove', '/memberships/add': 'membership_add',
  '/sync': 'sync', '/messages': 'messages', '/messages/receipt': 'message_receipt', '/messages/change-receipt': 'message_change_receipt',
  '/read-position': 'read_position', '/worker/poll': 'worker_poll', '/worker/events': 'worker_events', '/worker/not-started': 'worker_not_started',
  '/tools/claim': 'tool_claim', '/tools/confirm-claim': 'tool_confirm_claim', '/tools/send': 'tool_send', '/tools/request-approval': 'tool_request_approval', '/runs': 'runs',
});
const assets = new Set(['/', '/app.js', '/client.js', '/style.css', '/presentation.js', '/locales/zh-CN.js', '/language-ui.js', '/locales/registry.js',
  '/conversation-management.js', '/attachments.js', '/leave-conversation.js', '/sync-store.js', '/pending-store.js', '/threads.js']);
/** Never returns a client-controlled path, ID, query, or URL. */
export function requestRoute(pathname: string): RequestRoute {
  if (Object.hasOwn(staticRoutes, pathname)) return staticRoutes[pathname]!;
  if (assets.has(pathname)) return 'web_asset';
  if (/^\/messages\/[^/]+\/edit$/.test(pathname)) return 'message_edit';
  if (/^\/messages\/[^/]+\/retract$/.test(pathname)) return 'message_retract';
  if (/^\/runs\/[^/]+\/cancel$/.test(pathname)) return 'run_cancel';
  if (/^\/runs\/[^/]+$/.test(pathname)) return 'run';
  return 'unknown';
}
const categories = ['authentication_required', 'invalid_identity', 'credential_expired', 'json_required', 'body_too_large', 'invalid_json',
  'identity_spoofing', 'authorization_denied', 'lease_rejected', 'protocol_rejected', 'invalid_request', 'not_found', 'conflict',
  'capacity_reached', 'storage_unavailable', 'internal_failure'] as const;
export type RejectionCategory = typeof categories[number];
const leaseCodes = new Set(['lease_denied', 'lease_not_executable', 'cannot_confirm_not_started']);
const protocolCodes = new Set(['protocol_mismatch', 'server_selects_assignment', 'route_is_bound', 'identity_and_route_are_bound',
  'event_binding_mismatch', 'event_conflict', 'event_sequence_gap', 'invalid_events', 'invalid_event_kind', 'invalid_event_status', 'invalid_request_target']);
function category(error: unknown): RejectionCategory {
  if (!(error instanceof ApiError)) return 'internal_failure';
  // Only these literals may cross into the ledger. ApiError.code is not trusted log text.
  if (error.code === 'authentication_required' || error.code === 'invalid_identity' || error.code === 'credential_expired' ||
    error.code === 'json_required' || error.code === 'body_too_large' || error.code === 'invalid_json') return error.code;
  if (error.code === 'identity_is_authenticated') return 'identity_spoofing';
  if (leaseCodes.has(error.code)) return 'lease_rejected';
  if (protocolCodes.has(error.code)) return 'protocol_rejected';
  if (error.status === 401) return 'invalid_identity';
  if (error.status === 403) return 'authorization_denied';
  if (error.status === 404) return 'not_found';
  if (error.status === 409) return 'conflict';
  if (error.status === 413 || error.status === 507) return 'capacity_reached';
  if (error.status === 503) return 'storage_unavailable';
  return error.status >= 500 ? 'internal_failure' : 'invalid_request';
}
export interface RequestAuditContext {
  readonly requestId: string;
  readonly method: RequestMethod;
  route: RequestRoute;
  /** Set only from a successful authenticate(), never from input claims. */
  actorId: string | null;
}
export interface RequestRejection {
  requestId: string; at: number; method: RequestMethod; route: RequestRoute; actorId: string | null;
  /** Original rejection, before any audit-I/O 503 response override. Not a rollback assertion. */
  status: number; category: RejectionCategory;
}
export interface RequestAuditStore { loadRequestAudit(): unknown; saveRequestAudit(entries: readonly RequestRejection[]): void }
export function requestContext(method: string | undefined): RequestAuditContext {
  return { requestId: randomUUID(), method: methods.includes(method as RequestMethod) ? method as RequestMethod : 'OTHER', route: 'unknown', actorId: null };
}
function actor(value: unknown): string | null { return typeof value === 'string' && value.length > 0 && value.length <= 128 ? value : null; }
function restore(value: unknown): RequestRejection[] {
  if (value === undefined) return [];
  requireCondition(Array.isArray(value), 500, 'request_audit_corrupt');
  return value.slice(-REQUEST_AUDIT_LIMIT).map(raw => {
    requireCondition(raw && typeof raw === 'object' && typeof raw.requestId === 'string' &&
      /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(raw.requestId) && Number.isSafeInteger(raw.at) && raw.at >= 0 &&
      methods.includes(raw.method) && routes.includes(raw.route) && categories.includes(raw.category) &&
      Number.isInteger(raw.status) && raw.status >= 400 && raw.status <= 599 && (raw.actorId === null || actor(raw.actorId) === raw.actorId), 500, 'request_audit_corrupt');
    // Project fixed fields, including on restart. Never retain unexpected persisted metadata.
    return { requestId: raw.requestId, at: raw.at, method: raw.method, route: raw.route, actorId: raw.actorId, status: raw.status, category: raw.category };
  });
}
/** Synchronous, bounded ledger. No unbounded queue, timers, network logs, or public read route. */
export class RequestRejectionAudit {
  private readonly entries: RequestRejection[];
  private dirty = false;
  constructor(private readonly store?: RequestAuditStore, private readonly now = Date.now) { this.entries = restore(store?.loadRequestAudit()); }
  snapshot(): RequestRejection[] { return this.entries.map(entry => ({ ...entry })); }
  record(context: RequestAuditContext, error: unknown): void {
    const reason = category(error);
    const status = error instanceof ApiError && Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 500;
    this.entries.push({ requestId: context.requestId, at: this.now(), method: methods.includes(context.method) ? context.method : 'OTHER', route: routes.includes(context.route) ? context.route : 'unknown',
      actorId: ['authentication_required', 'invalid_identity', 'credential_expired'].includes(reason) ? null : actor(context.actorId), status, category: reason });
    this.entries.splice(0, Math.max(0, this.entries.length - REQUEST_AUDIT_LIMIT));
    this.dirty = true;
    this.flush();
  }
  /** A later request must first persist pending audit facts, but never retries a business action. */
  flush(): void {
    if (!this.dirty) return;
    try { this.store?.saveRequestAudit(this.snapshot()); }
    catch { throw new ApiError(503, 'request_audit_persistence_failed'); }
    this.dirty = false;
  }
}
