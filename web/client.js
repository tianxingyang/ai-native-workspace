/** Transport boundary shared by the browser demo and a future desktop host.
 * Credentials never enter URLs, persistent storage, logs, or DOM attributes. */
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
  async snapshot(scope) {
    const query = new URLSearchParams({ conversationId: scope.conversationId, threadId: scope.threadId });
    const [messages, runs] = await Promise.all([this.request(`/messages?${query}`), this.request(`/runs?${query}`)]);
    return { messages: messages.messages, runs: runs.runs };
  }
  send(scope, text, clientEventId) { return this.request('/messages', { conversationId: scope.conversationId, threadId: scope.threadId, text, clientEventId }); }
  cancel(runId) { return this.request(`/runs/${encodeURIComponent(runId)}/cancel`, {}); }
}
export function errorText(error) {
  if (error instanceof ApiError) {
    if (error.status === 401) return '凭据无效或已失效，请重新连接。';
    if (error.status === 403) return '授权已到期、被撤销或无权访问。请联系管理员核对后重新连接。';
    if (error.status === 409) return '状态发生变化，请刷新记录后核对；不要重复创建研究。';
    if (error.status === 507) return '演示数据容量已满，请联系管理员处理。';
    if (error.status === 429) return '操作超过当前预算，请稍后核对状态。';
    return `服务暂时无法处理请求（${error.status}），请重试。`;
  }
  return '连接中断或请求超时，结果尚未确认。恢复连接后可安全重试。';
}
