import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { ApiError, objectValue, requireCondition } from './contracts.js';
import { requestContext, requestRoute, type RequestAuditContext, type RequestRejectionAudit } from './request-audit.js';

export async function jsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  requireCondition(request.headers['content-type']?.split(';')[0] === 'application/json', 415, 'json_required');
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    requireCondition(length <= 65536, 413, 'body_too_large');
    chunks.push(Buffer.from(chunk));
  }
  try { return objectValue(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
  catch (error) { if (error instanceof ApiError) throw error; throw new ApiError(400, 'invalid_json'); }
}
export function bearer(request: IncomingMessage): string {
  const value = request.headers.authorization;
  requireCondition(value && value.startsWith('Bearer '), 401, 'authentication_required');
  return value.slice(7);
}
export function respond(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}
export function server(handler: (request: IncomingMessage, response: ServerResponse, url: URL, context: RequestAuditContext) => Promise<void>, audit?: RequestRejectionAudit) {
  return createServer((request, response) => {
    const context = requestContext(request.method);
    void (async () => {
      let url: URL;
      try { url = new URL(request.url ?? '/', 'http://localhost'); }
      catch { throw new ApiError(400, 'invalid_request_target'); }
      context.route = requestRoute(url.pathname);
      audit?.flush();
      await handler(request, response, url, context);
    })().catch(error => {
      // A completed response or disconnected peer is not a new request rejection. In
      // particular, a response failure cannot roll back an already committed action.
      if (response.headersSent || response.writableEnded || response.destroyed) return;
      try { audit?.record(context, error); }
      catch { error = new ApiError(503, 'request_audit_persistence_failed'); }
      const known = error instanceof ApiError;
      respond(response, known ? error.status : 500, { error: known ? error.code : 'internal_error' });
    });
  });
}
export async function listen(service: ReturnType<typeof server>, port = 0): Promise<string> {
  await new Promise<void>((resolve, reject) => { service.once('error', reject); service.listen(port, '127.0.0.1', resolve); });
  const address = service.address();
  if (!address || typeof address === 'string') throw new Error('missing_address');
  return `http://127.0.0.1:${address.port}`;
}
export async function close(service: ReturnType<typeof server>): Promise<void> {
  service.closeIdleConnections();
  await new Promise<void>((resolve, reject) => service.close(error => error ? reject(error) : resolve()));
}
export async function requestJson<T>(base: string, token: string, path: string, body?: unknown, signal?: AbortSignal, extraHeaders: Record<string, string> = {}): Promise<T> {
  const response = await fetch(new URL(path, base), {
    method: body === undefined ? 'GET' : 'POST', redirect: 'error',
    headers: { ...extraHeaders, authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000),
  });
  const value = await response.json() as { error?: string };
  if (!response.ok) throw new ApiError(response.status, value.error ?? 'remote_error');
  return value as T;
}
