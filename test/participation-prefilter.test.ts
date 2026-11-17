import assert from 'node:assert/strict';
import test from 'node:test';
import { participationSubscriptionsValue, prefilterParticipation, type ParticipationSubscription } from '../src/control/participation-prefilter.js';
import type { Message } from '../src/contracts.js';
const scope = { conversationId: 'room', threadId: 'thread' };
const sub: ParticipationSubscription = { ...scope, memberId: 'agent', revision: 1, enabled: true, membershipGeneration: 'initial', joinedAt: 10, responsibilities: ['research'] };
const source: Message = { ...scope, id: 'source', revision: 1, authorId: 'human', origin: 'chat', text: 'research a protocol', createdAt: 20 };
function check(overrides: Partial<Parameters<typeof prefilterParticipation>[0]> = {}) {
  return prefilterParticipation({ member: { id: 'agent', kind: 'agent', name: 'Agent' }, source, subscription: sub,
    authorKind: 'human', canRead: true, membershipGeneration: 'initial', messages: [source], ...overrides });
}
test('default source-only context is detached and strips extra metadata', () => {
  const result = check({ source: { ...source, replyToMessageId: 'secret', attachment: { name: 'secret', bytes: 1, sha256: 'secret' } } });
  assert.ok(result.decision.candidate); assert.deepEqual(result.messages, [source]);
  result.messages[0]!.text = 'changed'; assert.equal(source.text, 'research a protocol');
});
for (const [name, overrides, reason] of [
  ['no subscription', { subscription: undefined }, 'not_subscribed'],
  ['disabled', { subscription: { ...sub, enabled: false } }, 'disabled'],
  ['denied', { canRead: false }, 'scope_denied'],
  ['membership incarnation', { membershipGeneration: 'new' }, 'membership_changed'],
  ['join same millisecond', { source: { ...source, createdAt: 10 } }, 'before_subscription'],
  ['retracted', { source: { ...source, retracted: true } }, 'source_unavailable'],
  ['invalidated', { source: { ...source, invalidated: true } }, 'source_unavailable'],
  ['agent output', { authorKind: 'agent' }, 'not_human_chat'],
  ['empty responsibility', { subscription: { ...sub, responsibilities: [] } }, 'no_responsibility'],
  ['over budget', { subscription: { ...sub, maxChars: 2 } }, 'source_over_budget'],
] as const) test(`${name} stays quiet`, () => { const r = check(overrides as Parameters<typeof check>[0]); assert.equal(r.decision.reason, reason); assert.deepEqual(r.messages, []); });
test('same-ms history follows insertion order rather than lexical ID order', () => {
  const first = { ...source, id: 'z-first' }, latest = { ...source, id: 'a-latest' }, future = { ...source, id: 'future' };
  const result = check({ subscription: { ...sub, maxMessages: 2 }, messages: [first, latest, source, future] });
  assert.deepEqual(result.messages.map(m => m.id), ['a-latest', 'source']);
});
test('history excludes foreign, old, withdrawn and future messages', () => {
  const history = [{ ...source, id: 'before', createdAt: 9 }, { ...source, id: 'equal', createdAt: 10 },
    { ...source, id: 'valid', createdAt: 15 }, { ...source, id: 'foreign', threadId: 'hidden' },
    { ...source, id: 'withdrawn', retracted: true }, { ...source, id: 'future', createdAt: 21 }, source];
  assert.deepEqual(check({ subscription: { ...sub, maxMessages: 8 }, messages: history }).messages.map(m => m.id), ['valid', 'source']);
});
test('nearest overbudget history stops bounded catch-up', () => {
  assert.deepEqual(check({ subscription: { ...sub, maxMessages: 8, maxChars: 20 }, messages: [{ ...source, id: 'small', text: 'x' }, { ...source, id: 'big', text: 'x'.repeat(50) }, source] }).messages, [source]);
});
test('malformed and duplicate subscriptions fail closed', () => {
  for (const raw of [[{ ...sub, maxMessages: 9 }], [{ ...sub, responsibilities: ['admin'] }], [{ ...sub, membershipGeneration: '' }], [sub, sub], {}]) assert.throws(() => participationSubscriptionsValue(raw));
  assert.deepEqual(participationSubscriptionsValue([sub]), [sub]);
});
