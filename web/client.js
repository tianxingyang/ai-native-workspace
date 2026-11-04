/** Transport boundary shared by the browser demo and a future desktop host.
 * Credentials never enter URLs, persistent storage, logs, or DOM attributes. */
import { text as t } from './presentation.js';

export class ApiError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}
export class Client {
  #token;
  #controllers = new Set();
  constructor(token) { this.#token = token; }
  close() { this.#token = ''; for (const controller of this.#controllers) controller.abort(); }
  async request(path, body) {
    if (window.__TAURI__) {
      const response = await window.__TAURI__.core.invoke('desktop_request', { path, ...(body === undefined ? {} : { body }) });
      if (response.status >= 400) throw new ApiError(response.status, response.value.error ?? 'remote_error');
      return response.value;
    }
    const controller = new AbortController();
    this.#controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST',
        headers: { authorization: `Bearer ${this.#token}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        cache: 'no-store', credentials: 'omit', redirect: 'error', signal: controller.signal });
      const value = await response.json();
      if (!response.ok) throw new ApiError(response.status, value.error ?? 'remote_error');
      return value;
    } finally { clearTimeout(timeout); this.#controllers.delete(controller); }
  }
  session() { return this.request('/session'); }
  conversationOptions() { return this.request('/conversations/options'); }
  memberships(scope) { return this.request(`/memberships?${new URLSearchParams({ conversationId: scope.conversationId, threadId: scope.threadId })}`); }
  snapshot(scope, cursor) {
    const query = new URLSearchParams({ conversationId: scope.conversationId, threadId: scope.threadId });
    if (cursor !== undefined) query.set('cursor', cursor);
    return this.request(`/sync?${query}`);
  }
  markRead(scope, messageId) { return this.request('/read-position', { conversationId: scope.conversationId, threadId: scope.threadId, messageId, expectedMembershipGeneration: scope.membershipGeneration ?? 'initial' }); }
  receipt(scope, clientEventId) {
    const query = new URLSearchParams({ conversationId: scope.conversationId, threadId: scope.threadId, clientEventId });
    return this.request(`/messages/receipt?${query}`);
  }
  send(scope, text, clientEventId, replyToMessageId) { return this.request('/messages', { conversationId: scope.conversationId, threadId: scope.threadId, text, clientEventId, expectedMembershipGeneration: scope.membershipGeneration ?? 'initial', ...(replyToMessageId ? { replyToMessageId } : {}) }); }
  cancel(runId) { return this.request(`/runs/${encodeURIComponent(runId)}/cancel`, {}); }
  changeReceipt(scope, clientEventId) {
    const query = new URLSearchParams({ conversationId: scope.conversationId, threadId: scope.threadId, clientEventId });
    return this.request(`/messages/change-receipt?${query}`);
  }
  change(messageId, kind, expectedRevision, clientEventId, text, expectedMembershipGeneration = 'initial') {
    return this.request(`/messages/${encodeURIComponent(messageId)}/${kind}`, { expectedRevision, clientEventId, expectedMembershipGeneration, ...(kind === 'edit' ? { text } : {}) });
  }
}
export function errorText(error) {
  if (error instanceof ApiError) {
    if (error.code === 'demo_expired') return t('error.demoExpired');
    if (error.code === 'credential_expired') return t('error.credentialExpired');
    if (error.status === 401) return t('error.unauthenticated');
    if (error.status === 403) return t('error.forbidden');
    if (error.status === 409) return t('error.conflict');
    if (error.status === 507) return t('error.capacity');
    if (error.status === 429) return t('error.budget');
    return t('error.remote', { status: error.status });
  }
  return t('error.connection');
}
