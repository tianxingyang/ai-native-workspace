import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { objectValue, requireCondition, scopeValue, stringValue, type Grant, type Member } from '../contracts.js';
import type { ControlConfig } from '../control/state.js';
import { fixtureSources } from '../dev-fixture.js';

export type MockProvider = 'fake' | 'pi-mock';
export interface PrivateControlConfig { port: number; databasePath: string; control: ControlConfig }
export interface PrivateWorkerConfig { memberId: string; token: string; controlUrl: string; provider: MockProvider; workspace: string }
function id(value: unknown): string {
  const name = stringValue(value, 'id', 128);
  requireCondition(/^[a-zA-Z0-9_-]+$/.test(name) && !['alex', 'sam', 'guest'].includes(name), 400, 'private_identity_required');
  return name;
}
function token(envName: unknown, env: NodeJS.ProcessEnv): string {
  const key = stringValue(envName, 'token_env', 128);
  requireCondition(/^COSEAT_[A-Z0-9_]+$/.test(key), 400, 'invalid_token_env');
  const value = env[key];
  requireCondition(typeof value === 'string' && /^[\x21-\x7e]{32,512}$/.test(value) && !/dev-fixture|synthetic-demo|unit-only|REPLACE|[<>]/i.test(value), 400, 'private_token_required');
  return value;
}
export function protectedOrigin(value: unknown): string {
  const input = stringValue(value, 'control_url', 2048);
  let url: URL;
  try { url = new URL(input); } catch { throw new Error('invalid_control_url'); }
  requireCondition(!url.username && !url.password && !url.search && !url.hash && url.pathname === '/', 400, 'origin_required');
  requireCondition(url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)), 400, 'protected_transport_required');
  return url.origin;
}
export function parseControlConfig(raw: unknown, env: NodeJS.ProcessEnv): PrivateControlConfig {
  const c = objectValue(raw);
  requireCondition(c.mode === 'private-mock' && c.version === 1, 400, 'private_configuration_required');
  const port = c.port ?? 4317;
  requireCondition(Number.isInteger(port) && Number(port) >= 0 && Number(port) <= 65535, 400, 'invalid_port');
  const databasePath = stringValue(c.databasePath, 'database_path', 2048);
  requireCondition(isAbsolute(databasePath), 400, 'absolute_database_path_required');
  requireCondition(Array.isArray(c.members) && c.members.length >= 2 && c.members.length <= 20, 400, 'members_required');
  const members: Member[] = [], tokens: Record<string, string> = Object.create(null);
  const memberships: ControlConfig['memberships'] = Object.create(null);
  for (const rawMember of c.members) {
    const m = objectValue(rawMember), memberId = id(m.id);
    requireCondition(!members.some(x => x.id === memberId) && ['human', 'agent'].includes(String(m.kind)), 400, 'invalid_member');
    const secret = token(m.tokenEnv, env);
    requireCondition(!tokens[secret], 400, 'duplicate_identity_token');
    tokens[secret] = memberId;
    members.push({ id: memberId, name: stringValue(m.name, 'name', 128), kind: m.kind as 'human' | 'agent' });
    requireCondition(Array.isArray(m.scopes), 400, 'scopes_required');
    memberships[memberId] = m.scopes.map(s => scopeValue(objectValue(s)));
  }
  const researchMemberId = id(c.researchMemberId);
  requireCondition(members.find(m => m.id === researchMemberId)?.kind === 'agent', 400, 'research_member_required');
  requireCondition(Array.isArray(c.grants) && c.grants.length > 0, 400, 'explicit_grants_required');
  const grants: Grant[] = c.grants.map(rawGrant => {
    const g = objectValue(rawGrant), memberId = id(g.memberId);
    requireCondition(members.some(m => m.id === memberId), 400, 'unknown_grant_member');
    requireCondition(Array.isArray(g.actions) && g.actions.length > 0 && g.actions.every(a => ['read', 'send', 'claim', 'request_approval', 'cancel'].includes(String(a))), 400, 'invalid_actions');
    requireCondition(Number.isInteger(g.revision) && Number(g.revision) > 0 && Number.isFinite(g.expiresAt) && Number(g.expiresAt) > Date.now(), 400, 'valid_grant_required');
    return { ...scopeValue(g), id: id(g.id), memberId, revision: Number(g.revision), actions: g.actions as Grant['actions'], expiresAt: Number(g.expiresAt), revoked: g.revoked === true };
  });
  requireCondition(new Set(grants.map(g => g.id)).size === grants.length, 400, 'duplicate_grant_id');
  return { port: Number(port), databasePath, control: { members, tokens, memberships, grants, researchMemberId, sources: fixtureSources } };
}
export function parseWorkerConfig(raw: unknown, env: NodeJS.ProcessEnv): PrivateWorkerConfig {
  const c = objectValue(raw);
  requireCondition(c.mode === 'private-mock' && c.version === 1 && ['fake', 'pi-mock'].includes(String(c.provider)), 400, 'explicit_mock_provider_required');
  const workspace = stringValue(c.workspace, 'workspace', 2048);
  requireCondition(isAbsolute(workspace), 400, 'absolute_workspace_required');
  return { memberId: id(c.memberId), token: token(c.tokenEnv, env), controlUrl: protectedOrigin(c.controlUrl), provider: c.provider as MockProvider, workspace };
}
export function readConfiguration(): unknown {
  const path = process.env.COSEAT_CONFIG;
  requireCondition(path && isAbsolute(path), 400, 'configuration_path_required');
  return JSON.parse(readFileSync(path, 'utf8'));
}
// Only fixed event names are logged by private entrypoints. Never stringify errors or config.
export function safeLog(event: 'control_ready' | 'worker_ready' | 'startup_failed' | 'worker_disconnected' | 'worker_stopped'): void {
  console.log(JSON.stringify({ event, mode: 'private-mock' }));
}
