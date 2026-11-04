import { createHash } from 'node:crypto';
import { ACTIONS, objectValue, requireCondition, stringValue, type Action, type AuthorizationPolicy, type Grant, type Member, type Scope } from '../contracts.js';

export const HIGH_RISK_ACTIONS: Action[] = ['grant_permissions', 'external_send', 'permanent_delete', 'continuous_run'];
/** Templates are editable data, never implicit assignments or identity-based privileges. */
export function defaultPolicy(): AuthorizationPolicy {
  return { version: 1, disabledActions: [...HIGH_RISK_ACTIONS], roles: [
    { id: 'read-only', revision: 1, actions: ['read'] },
    { id: 'collaborator', revision: 1, actions: ['read', 'send', 'claim', 'request_approval', 'cancel'] },
    { id: 'resource-admin', revision: 1, actions: ['manage_resource'] },
    { id: 'workspace-admin', revision: 1, actions: ['manage_workspace'] },
  ] };
}
export function actionList(raw: unknown): Action[] {
  requireCondition(Array.isArray(raw) && raw.every(a => ACTIONS.includes(a as Action)) && new Set(raw).size === raw.length, 400, 'invalid_actions');
  return [...raw] as Action[];
}
export function parsePolicy(raw: unknown): AuthorizationPolicy {
  const p = objectValue(raw);
  requireCondition(Number.isSafeInteger(p.version) && Number(p.version) > 0, 400, 'invalid_policy_version');
  requireCondition(Array.isArray(p.roles) && p.roles.length <= 100, 400, 'invalid_roles');
  const roles = p.roles.map(rawRole => {
    const role = objectValue(rawRole);
    requireCondition(Number.isSafeInteger(role.revision) && Number(role.revision) > 0, 400, 'invalid_role_revision');
    return { id: stringValue(role.id, 'role_id', 128), revision: Number(role.revision), actions: actionList(role.actions) };
  });
  requireCondition(new Set(roles.map(r => r.id)).size === roles.length, 400, 'duplicate_role_id');
  return { version: Number(p.version), roles, disabledActions: actionList(p.disabledActions) };
}
export function policyDigest(policy?: AuthorizationPolicy): string {
  return createHash('sha256').update(JSON.stringify(policy ?? null)).digest('hex');
}
export function grantActions(grant: Grant, policy?: AuthorizationPolicy): Action[] {
  const roles = (grant.roleIds ?? []).map(id => policy?.roles.find(r => r.id === id));
  // A broken template reference invalidates the entire grant, including direct actions.
  if (roles.some(role => !role)) return [];
  return [...new Set([...grant.actions, ...roles.flatMap(role => role!.actions)])];
}
export interface AuthorizationConfig {
  members: Member[]; memberships: Record<string, Scope[]>; grants: Grant[]; policy?: AuthorizationPolicy;
}
export interface AuthorizationDecision {
  allowed: boolean; reason: 'allowed' | 'unknown_member' | 'not_in_scope' | 'policy_disabled' | 'explicit_deny' | 'no_grant';
  policyVersion: number; policyDigest: string; grantIds: string[]; grant?: Grant;
}
const sameScope = (a: Scope, b: Scope) => a.conversationId === b.conversationId && a.threadId === b.threadId;
/** Pure application policy evaluation; OS and external-service checks remain separate boundaries. */
export function decideAuthorization(config: AuthorizationConfig, actor: string, action: Action, scope: Scope, now: number, bound?: { id: string; revision: number }): AuthorizationDecision {
  const base = { policyVersion: config.policy?.version ?? 0, policyDigest: policyDigest(config.policy), grantIds: [] as string[] };
  const deny = (reason: AuthorizationDecision['reason']): AuthorizationDecision => ({ ...base, allowed: false, reason });
  if (!config.members.some(m => m.id === actor)) return deny('unknown_member');
  if (!config.memberships[actor]?.some(s => sameScope(s, scope))) return deny('not_in_scope');
  if ((config.policy?.disabledActions ?? HIGH_RISK_ACTIONS).includes(action)) return deny('policy_disabled');
  const applicable = config.grants.filter(g => g.memberId === actor && sameScope(g, scope) && !g.revoked && Number.isFinite(g.expiresAt) && g.expiresAt > now && grantActions(g, config.policy).includes(action));
  // Denies are deliberately not constrained to the run's original allow binding.
  const denied = applicable.filter(g => g.effect === 'deny');
  if (denied.length) return { ...deny('explicit_deny'), grantIds: denied.map(g => g.id) };
  const allowed = applicable.filter(g => (g.effect === undefined || g.effect === 'allow') && (!bound || (g.id === bound.id && g.revision === bound.revision))).sort((a, b) => b.expiresAt - a.expiresAt);
  const grant = allowed[0];
  return grant ? { ...base, allowed: true, reason: 'allowed', grantIds: allowed.map(g => g.id), grant } : deny('no_grant');
}
