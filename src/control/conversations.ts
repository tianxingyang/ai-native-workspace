import { createHash, randomUUID } from 'node:crypto';
import { objectValue, requireCondition, scopeValue, stringValue, type Action, type Grant, type Scope } from '../contracts.js';
import { actionList } from './authorization.js';

// Explicit provisioning authority, not inheritance from an arbitrary managed room.
export const CONVERSATION_ACTIONS: Action[] = ['read', 'send', 'claim', 'request_approval', 'cancel', 'manage_resource'];
export interface ConversationCreationRule { authorityScope: Scope; allowedActions: Action[]; maxGrantDurationMs: number }
export interface Conversation extends Scope { kind: 'group' | 'direct'; title: string; titleRevision: number; memberIds: string[]; createdBy: string; createdAt: number }
interface TitleChange extends Scope { title: string; titleRevision: number }
interface RenameReceipt { fingerprint: string; change: TitleChange }
export interface InitialGrant { targetMemberId: string; actions: Action[]; expiresAt: number }
export interface ConversationInput { kind: 'group' | 'direct'; title: string; memberIds: string[]; initialGrants: InitialGrant[]; clientEventId: string }
export interface GrantSource {
  actorId: string; scope: Scope; ruleDigest: string; policyDigest: string;
  bindings: { action: 'manage_workspace' | 'grant_permissions'; id: string; revision: number; digest: string }[];
}
interface IssuedGrant { grant: Grant; source: GrantSource; generation?: string }
interface SavedConversations { conversations: Conversation[]; grants: IssuedGrant[]; requests: [string, { fingerprint: string; conversationId: string; receipt?: Conversation }][]; authorities?: [string, Scope][]; renameRequests?: [string, RenameReceipt][] }
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
  private readonly requests = new Map<string, { fingerprint: string; conversationId: string; receipt?: Conversation }>();
  private readonly authorities = new Map<string, Scope>();
  private readonly renameRequests = new Map<string, RenameReceipt>();
  snapshot(): SavedConversations { return structuredClone({ conversations: [...this.conversations.values()], grants: this.grants, requests: [...this.requests], authorities: [...this.authorities], renameRequests: [...this.renameRequests] }); }
  restore(saved?: SavedConversations): void {
    this.conversations.clear(); this.requests.clear(); this.authorities.clear(); this.renameRequests.clear(); this.grants.length = 0;
    for (const conversation of structuredClone(saved?.conversations ?? [])) this.conversations.set(conversation.conversationId, { ...conversation, titleRevision: conversation.titleRevision ?? 1 });
    for (const [key, receipt] of structuredClone(saved?.renameRequests ?? [])) this.renameRequests.set(key, receipt);
    this.grants.push(...structuredClone(saved?.grants ?? []));
    for (const [key, value] of structuredClone(saved?.requests ?? [])) this.requests.set(key, { ...value, receipt: value.receipt ?? structuredClone(this.conversations.get(value.conversationId)!) });
    for (const [id, scope] of structuredClone(saved?.authorities ?? [])) this.authorities.set(id, scope);
    // PR26 snapshots can prove their original authority through issued Grants.
    // A legacy resource without this evidence is not silently assigned a source.
    if (!saved?.authorities) for (const conversation of this.conversations.values()) {
      const sources = this.grants.filter(g => g.grant.conversationId === conversation.conversationId).map(g => g.source.scope);
      if (sources.length && sources.every(scope => digest(scope) === digest(sources[0]))) this.authorities.set(conversation.conversationId, structuredClone(sources[0]!));
    }
  }
  metadata(scope: Scope): Conversation | undefined {
    const conversation = this.conversations.get(scope.conversationId);
    return conversation?.threadId === scope.threadId ? structuredClone(conversation) : undefined;
  }
  scopes(memberId: string): Scope[] {
    return [...this.conversations.values()].filter(c => c.memberIds.includes(memberId)).map(({ conversationId, threadId }) => ({ conversationId, threadId }));
  }
  authority(scope: Scope): Scope | undefined { return this.metadata(scope) ? structuredClone(this.authorities.get(scope.conversationId)) : undefined; }
  allGrants(): Grant[] { return this.grants.map(entry => structuredClone(entry.grant)); }
  effectiveGrants(validSource: (source: GrantSource) => boolean, generation: (memberId: string, scope: Scope) => string): Grant[] {
    return this.grants.filter(entry => (entry.generation ?? 'initial') === generation(entry.grant.memberId, entry.grant) && validSource(entry.source)).map(entry => structuredClone(entry.grant));
  }
  addMember(scope: Scope, targetMemberId: string, generation: string, grant: InitialGrant | undefined, source: GrantSource | undefined) {
    const conversation = this.conversations.get(scope.conversationId)!;
    if (!conversation.memberIds.includes(targetMemberId)) conversation.memberIds.push(targetMemberId);
    if (grant && source) this.grants.push({ generation, source: structuredClone(source), grant: { ...scope, id: randomUUID(), revision: 1,
      memberId: targetMemberId, actions: [...grant.actions], expiresAt: grant.expiresAt, revoked: false } });
  }
  prior(actorId: string, input: ConversationInput) {
    requireCondition(!this.renameRequests.has(JSON.stringify([actorId, input.clientEventId])), 409, 'conversation_request_conflict');
    const previous = this.requests.get(JSON.stringify([actorId, input.clientEventId]));
    if (!previous) return undefined;
    requireCondition(previous.fingerprint === digest(input), 409, 'conversation_request_conflict');
    return { conversation: structuredClone(previous.receipt ?? this.conversations.get(previous.conversationId)!), duplicate: true };
  }
  rename(actorId: string, scope: Scope, title: string, expectedTitleRevision: number, generation: string, clientEventId: string) {
    const conversation = this.conversations.get(scope.conversationId);
    requireCondition(conversation?.threadId === scope.threadId && conversation.kind === 'group', 403, 'conversation_rename_unavailable');
    const key = JSON.stringify([actorId, clientEventId]), fingerprint = digest([scope.conversationId, scope.threadId, title, expectedTitleRevision, generation]);
    requireCondition(!this.requests.has(key), 409, 'conversation_request_conflict');
    const prior = this.renameRequests.get(key);
    if (prior) {
      requireCondition(prior.fingerprint === fingerprint, 409, 'conversation_request_conflict');
      return { change: structuredClone(prior.change), duplicate: true };
    }
    requireCondition(conversation.titleRevision === expectedTitleRevision, 409, 'conversation_title_conflict');
    requireCondition(Number.isSafeInteger(conversation.titleRevision + 1), 409, 'conversation_title_conflict');
    conversation.title = title; conversation.titleRevision++;
    const change = { conversationId: scope.conversationId, threadId: scope.threadId, title, titleRevision: conversation.titleRevision };
    this.renameRequests.set(key, { fingerprint, change });
    return { change: structuredClone(change), duplicate: false };
  }
  create(actorId: string, input: ConversationInput, source: GrantSource, now: number) {
    requireCondition(this.conversations.size < 500, 507, 'conversation_capacity_reached');
    const conversation: Conversation = { conversationId: randomUUID(), threadId: 'main', kind: input.kind, title: input.title, titleRevision: 1,
      memberIds: [...input.memberIds], createdBy: actorId, createdAt: now };
    this.conversations.set(conversation.conversationId, conversation);
    this.authorities.set(conversation.conversationId, structuredClone(source.scope));
    for (const initial of input.initialGrants) this.grants.push({ source: structuredClone(source), grant: {
      conversationId: conversation.conversationId, threadId: conversation.threadId, id: randomUUID(), revision: 1,
      memberId: initial.targetMemberId, actions: [...initial.actions], expiresAt: initial.expiresAt, revoked: false,
    } });
    this.requests.set(JSON.stringify([actorId, input.clientEventId]), { fingerprint: digest(input), conversationId: conversation.conversationId, receipt: structuredClone(conversation) });
    return { conversation: structuredClone(conversation), duplicate: false };
  }
}
