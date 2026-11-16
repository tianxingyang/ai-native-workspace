import { objectValue, requireCondition, scopeValue, stringValue, type Member, type Message, type ResearchSlot, type Scope } from '../contracts.js';

export const PREFILTER_VERSION = 'coseat.participation-prefilter.v1';
export interface ParticipationSubscription extends Scope {
  memberId: string; revision: number; enabled: boolean; membershipGeneration: string;
  joinedAt: number; responsibilities: ResearchSlot[]; maxMessages?: number; maxChars?: number;
}
export interface PrefilterDecision {
  memberId: string; messageId: string; sourceRevision: number; ruleVersion: string;
  subscriptionRevision?: number; candidate: boolean; reason: string;
  history: { messageId: string; revision: number }[];
}
export interface ParticipationContext { decision: PrefilterDecision; messages: Message[]; subscription?: ParticipationSubscription }
const sameScope = (a: Scope, b: Scope) => a.conversationId === b.conversationId && a.threadId === b.threadId;
export function participationSubscriptionsValue(raw: unknown): ParticipationSubscription[] {
  requireCondition(Array.isArray(raw) && raw.length <= 1000, 400, 'invalid_participation_subscriptions');
  const seen = new Set<string>();
  return raw.map(value => {
    const s = objectValue(value), scope = scopeValue(s), memberId = stringValue(s.memberId, 'memberId', 128);
    const key = JSON.stringify([memberId, scope.conversationId, scope.threadId]);
    requireCondition(!seen.has(key), 400, 'duplicate_participation_subscription'); seen.add(key);
    requireCondition(Number.isSafeInteger(s.revision) && Number(s.revision) > 0 && typeof s.enabled === 'boolean'
      && Number.isSafeInteger(s.joinedAt) && Number(s.joinedAt) >= 0, 400, 'invalid_participation_subscription');
    requireCondition(Array.isArray(s.responsibilities) && s.responsibilities.every(r => r === 'research' || r === 'source_verification')
      && new Set(s.responsibilities).size === s.responsibilities.length, 400, 'invalid_participation_responsibilities');
    for (const [key, max] of [['maxMessages', 8], ['maxChars', 8000]] as const) requireCondition(s[key] === undefined
      || (Number.isSafeInteger(s[key]) && Number(s[key]) > 0 && Number(s[key]) <= max), 400, 'invalid_participation_budget');
    return { ...scope, memberId, revision: Number(s.revision), enabled: s.enabled, joinedAt: Number(s.joinedAt),
      membershipGeneration: stringValue(s.membershipGeneration, 'membership_generation', 128), responsibilities: [...s.responsibilities] as ResearchSlot[],
      ...(s.maxMessages === undefined ? {} : { maxMessages: Number(s.maxMessages) }), ...(s.maxChars === undefined ? {} : { maxChars: Number(s.maxChars) }) };
  });
}
/** Pure bounded preflight. Callers supply actual insertion order, never random ID order. */
export function prefilterParticipation(input: {
  member: Member; source: Message; authorKind?: Member['kind'] | undefined; subscription?: ParticipationSubscription | undefined;
  canRead: boolean; membershipGeneration: string; messages: readonly Message[];
}): ParticipationContext {
  const { member, source, subscription: s } = input;
  const decision: PrefilterDecision = { memberId: member.id, messageId: source.id, sourceRevision: source.revision,
    ruleVersion: PREFILTER_VERSION, ...(s ? { subscriptionRevision: s.revision } : {}), candidate: false, reason: 'not_subscribed', history: [] };
  const quiet = (reason: string): ParticipationContext => ({ decision: { ...decision, reason }, messages: [] });
  if (member.kind !== 'agent' || !s || s.memberId !== member.id || !sameScope(s, source)) return quiet('not_subscribed');
  if (!s.enabled) return quiet('disabled');
  if (!input.canRead) return quiet('scope_denied');
  if (s.membershipGeneration !== input.membershipGeneration) return quiet('membership_changed');
  if (!s.responsibilities.length) return quiet('no_responsibility');
  // Equality is ambiguous without a join sequence: fail closed for the entire millisecond.
  if (source.createdAt <= s.joinedAt) return quiet('before_subscription');
  if (source.retracted || source.invalidated) return quiet('source_unavailable');
  if (source.origin !== 'chat' || input.authorKind !== 'human') return quiet('not_human_chat');
  const maxChars = s.maxChars ?? 8000, maxMessages = s.maxMessages ?? 1;
  if (source.text.length > maxChars) return quiet('source_over_budget');
  const sourceIndex = input.messages.findIndex(m => m.id === source.id);
  const prior = sourceIndex < 0 ? input.messages.filter(m => m.createdAt < source.createdAt) : input.messages.slice(0, sourceIndex);
  const selected = [source]; let chars = source.text.length;
  for (let index = prior.length - 1; index >= 0 && selected.length < maxMessages; index--) {
    const m = prior[index]!;
    if (!sameScope(m, source) || m.createdAt <= s.joinedAt || m.createdAt > source.createdAt || m.retracted || m.invalidated || m.origin !== 'chat') continue;
    if (chars + m.text.length > maxChars) break;
    selected.unshift(m); chars += m.text.length;
  }
  const messages = selected.map(m => ({ id: m.id, conversationId: m.conversationId, threadId: m.threadId,
    authorId: m.authorId, text: m.text, origin: m.origin, revision: m.revision, createdAt: m.createdAt } as Message));
  return { subscription: s, messages, decision: { ...decision, candidate: true, reason: 'eligible', history: messages.map(m => ({ messageId: m.id, revision: m.revision })) } };
}
