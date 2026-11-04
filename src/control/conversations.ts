import { createHash, randomUUID } from 'node:crypto';
import { objectValue, requireCondition, scopeValue, stringValue, type Action, type Grant, type Scope } from '../contracts.js';
import { actionList } from './authorization.js';

// Explicit provisioning authority, not inheritance from an arbitrary managed room.
export const CONVERSATION_ACTIONS: Action[] = ['read', 'send', 'claim', 'request_approval', 'cancel', 'manage_resource'];
export interface ConversationCreationRule { authorityScope: Scope; allowedActions: Action[]; maxGrantDurationMs: number }
export interface Conversation extends Scope { kind: 'group' | 'direct'; title: string; memberIds: string[]; createdBy: string; createdAt: number }
export interface InitialGrant { targetMemberId: string; actions: Action[]; expiresAt: number }
export interface ConversationInput { kind: 'group' | 'direct'; title: string; memberIds: string[]; initialGrants: InitialGrant[]; clientEventId: string }
export interface GrantSource {
  actorId: string; scope: Scope; ruleDigest: string; policyDigest: string;
  bindings: { action: 'manage_workspace' | 'grant_permissions'; id: string; revision: number; digest: string }[];
}
interface IssuedGrant { grant: Grant; source: GrantSource }
interface SavedConversations { conversations: Conversation[]; grants: IssuedGrant[]; requests: [string, { fingerprint: string; conversationId: string }][] }
export const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value) ?? 'null').digest('hex');

export function creationRuleValue(raw: unknown): ConversationCreationRule {
  const value = objectValue(raw), allowedActions = actionList(value.allowedActions);
  requireCondition(allowedActions.every(action => CONVERSATION_ACTIONS.includes(action)), 400, 'invalid_conversation_actions');
  requireCondition(Number.isSafeInteger(value.maxGrantDurationMs) && Number(value.maxGrantDurationMs) > 0, 400, 'invalid_conversation_grant_duration');
  return { authorityScope: scopeValue(objectValue(value.authorityScope)), allowedActions, maxGrantDurationMs: Number(value.maxGrantDurationMs) };
}
export function conversationInput(raw: unknown): ConversationInput {
  const value = objectValue(raw);
  requireCondition(value.kind === 'group' || value.kind === 'direct', 400, 'invalid_conversation_kind');
  const title = stringValue(value.title, 'conversation_title', 128).trim();
  requireCondition(title.length > 0, 400, 'invalid_conversation_title');
  requireCondition(Array.isArray(value.memberIds) && value.memberIds.length >= 2 && value.memberIds.length <= 20, 400, 'invalid_conversation_members');
  const memberIds = value.memberIds.map(id => stringValue(id, 'member_id', 128));
  requireCondition(new Set(memberIds).size === memberIds.length && (value.kind !== 'direct' || memberIds.length === 2), 400, 'invalid_conversation_members');
  requireCondition(Array.isArray(value.initialGrants) && value.initialGrants.length <= 20, 400, 'invalid_initial_grants');
  const initialGrants = value.initialGrants.map(rawGrant => {
    const grant = objectValue(rawGrant), targetMemberId = stringValue(grant.targetMemberId, 'target_member_id', 128), actions = actionList(grant.actions);
    requireCondition(memberIds.includes(targetMemberId) && actions.length > 0, 400, 'invalid_initial_grant_member');
    requireCondition(Number.isSafeInteger(grant.expiresAt) && Number(grant.expiresAt) > 0, 400, 'invalid_initial_grant_expiry');
    return { targetMemberId, actions, expiresAt: Number(grant.expiresAt) };
  });
  requireCondition(new Set(initialGrants.map(g => g.targetMemberId)).size === initialGrants.length, 400, 'duplicate_initial_grant_member');
  return { kind: value.kind, title, memberIds, initialGrants, clientEventId: stringValue(value.clientEventId, 'client_event_id', 128) };
}

/** Durable resource facts and explicit grants; authorization is evaluated by ControlState. */
export class ConversationRegistry {
  private readonly conversations = new Map<string, Conversation>();
  private readonly grants: IssuedGrant[] = [];
  private readonly requests = new Map<string, { fingerprint: string; conversationId: string }>();
  snapshot(): SavedConversations { return structuredClone({ conversations: [...this.conversations.values()], grants: this.grants, requests: [...this.requests] }); }
  restore(saved?: SavedConversations): void {
    this.conversations.clear(); this.requests.clear(); this.grants.length = 0;
    for (const conversation of structuredClone(saved?.conversations ?? [])) this.conversations.set(conversation.conversationId, conversation);
    this.grants.push(...structuredClone(saved?.grants ?? []));
    for (const [key, value] of structuredClone(saved?.requests ?? [])) this.requests.set(key, value);
  }
  metadata(scope: Scope): Conversation | undefined {
    const conversation = this.conversations.get(scope.conversationId);
    return conversation?.threadId === scope.threadId ? structuredClone(conversation) : undefined;
  }
  scopes(memberId: string): Scope[] {
    return [...this.conversations.values()].filter(c => c.memberIds.includes(memberId)).map(({ conversationId, threadId }) => ({ conversationId, threadId }));
  }
  effectiveGrants(validSource: (source: GrantSource) => boolean): Grant[] {
    return this.grants.filter(entry => validSource(entry.source)).map(entry => structuredClone(entry.grant));
  }
  prior(actorId: string, input: ConversationInput) {
    const previous = this.requests.get(JSON.stringify([actorId, input.clientEventId]));
    if (!previous) return undefined;
    requireCondition(previous.fingerprint === digest(input), 409, 'conversation_request_conflict');
    return { conversation: structuredClone(this.conversations.get(previous.conversationId)!), duplicate: true };
  }
  create(actorId: string, input: ConversationInput, source: GrantSource, now: number) {
    requireCondition(this.conversations.size < 500, 507, 'conversation_capacity_reached');
    const conversation: Conversation = { conversationId: randomUUID(), threadId: 'main', kind: input.kind, title: input.title,
      memberIds: [...input.memberIds], createdBy: actorId, createdAt: now };
    this.conversations.set(conversation.conversationId, conversation);
    for (const initial of input.initialGrants) this.grants.push({ source: structuredClone(source), grant: {
      conversationId: conversation.conversationId, threadId: conversation.threadId, id: randomUUID(), revision: 1,
      memberId: initial.targetMemberId, actions: [...initial.actions], expiresAt: initial.expiresAt, revoked: false,
    } });
    this.requests.set(JSON.stringify([actorId, input.clientEventId]), { fingerprint: digest(input), conversationId: conversation.conversationId });
    return { conversation: structuredClone(conversation), duplicate: false };
  }
}
