import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { requireCondition, type Action, type Scope } from '../contracts.js';
import type { ControlState } from '../control/state.js';

const assets = new Map([
  ['/', ['index.html', 'text/html']], ['/app.js', ['app.js', 'text/javascript']],
  ['/client.js', ['client.js', 'text/javascript']], ['/style.css', ['style.css', 'text/css']],
  ['/presentation.js', ['presentation.js', 'text/javascript']], ['/locales/zh-CN.js', ['locales/zh-CN.js', 'text/javascript']],
  ['/conversation-management.js', ['conversation-management.js', 'text/javascript']],
]);
const contents = new Map<string, Buffer>();

/** Opt-in, loopback-only local UI. Never installs a browser session or grants access. */
export function serveWeb(request: IncomingMessage, response: ServerResponse, url: URL): boolean {
  const hosts = [`127.0.0.1:${request.socket.localPort}`, `localhost:${request.socket.localPort}`];
  requireCondition(hosts.includes(request.headers.host ?? ''), 403, 'local_host_required');
  const origin = request.headers.origin;
  requireCondition(!origin || origin === `http://${request.headers.host}`, 403, 'origin_denied');
  requireCondition(request.headers['sec-fetch-site'] !== 'cross-site', 403, 'origin_denied');
  response.setHeader('content-security-policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('referrer-policy', 'no-referrer');
  response.setHeader('cache-control', 'no-store');
  const asset = assets.get(url.pathname);
  if (!asset || request.method !== 'GET') return false;
  const [file, type] = asset as [string, string];
  let content = contents.get(file);
  if (!content) { content = readFileSync(new URL(`../../../web/${file}`, import.meta.url)); contents.set(file, content); }
  response.writeHead(200, { 'content-type': `${type}; charset=utf-8` }); response.end(content);
  return true;
}

const same = (a: Scope, b: Scope) => a.conversationId === b.conversationId && a.threadId === b.threadId;
export function clientSession(state: ControlState, actor: string) {
  const now = Date.now();
  const scopes = state.memberScopes(actor).filter((s, i, all) => all.findIndex(a => same(a, s)) === i)
    .flatMap(scope => {
      // Discovery uses the same read authorization as message access. The action
      // deadlines below are presentation hints, never an alternative authorizer.
      if (!state.visible(actor, scope)) return [];
      const permissions = Object.fromEntries((['read', 'send', 'cancel'] as Action[]).map(action =>
        [action, state.authorization(actor, action, scope).grant?.expiresAt ?? 0]));
      const members = state.config.members.filter(m => state.memberScopes(m.id).some(s => same(s, scope)));
      return [{ ...scope, ...state.conversationMetadata(scope), membershipGeneration: state.membershipGeneration(actor, scope), permissions, members }];
    });
  const management = state.managementCapabilities(actor);
  requireCondition(scopes.length > 0 || management.createUntil > now || management.scopes.length > 0, 403, 'no_readable_scope');
  return { member: state.config.members.find(m => m.id === actor)!, scopes, management, mode: 'private-mock', serverTime: now };
}
