import assert from 'node:assert/strict';
import test from 'node:test';
import { ThreadRegistry, threadInput } from '../src/control/threads.js';

const input = (id = 'create-one') => threadInput({ conversationId: 'conversation', threadId: 'main', title: '讨论 <文字>', clientEventId: id, expectedMembershipGeneration: 'initial', sourceMessageId: 'message' });

test('thread identity, parent and immutable receipt survive snapshot recovery without copied message bodies', () => {
  const registry = new ThreadRegistry(), request = input(), created = registry.create('member', request, 123);
  assert.notEqual(created.thread.threadId, request.parent.threadId);
  assert.deepEqual(created.thread.parent, request.parent); assert.equal(created.thread.status, 'active'); assert.equal(created.thread.revision, 1);
  assert.equal(created.thread.sourceMessageId, 'message'); assert.equal(created.duplicate, false);
  created.thread.title = 'caller mutation'; created.thread.parent.threadId = 'other'; request.title = 'input mutation';
  const saved = registry.snapshot(), recovered = new ThreadRegistry(); recovered.restore(saved);
  saved.threads[0]!.title = 'snapshot mutation';
  const retry = recovered.create('member', input(), 999);
  assert.equal(retry.duplicate, true); assert.equal(retry.thread.createdAt, 123); assert.equal(retry.thread.title, '讨论 <文字>');
  assert.equal(recovered.children({ conversationId: 'conversation', threadId: 'main' }).length, 1);
  assert.equal(recovered.children({ conversationId: 'other', threadId: 'main' }).length, 0);
  assert.equal(recovered.metadata({ conversationId: 'other', threadId: retry.thread.threadId }), undefined);
  assert.deepEqual(Object.keys(retry.thread).sort(), ['authorization', 'conversationId', 'createdAt', 'createdBy', 'parent', 'revision', 'sourceMessageId', 'status', 'threadId', 'title']);
});

test('creation event identity binds parent, title, source and membership generation while actors remain distinct', () => {
  const registry = new ThreadRegistry(), first = registry.create('member', input(), 123);
  for (const patch of [{ title: 'changed' }, { parent: { conversationId: 'other', threadId: 'main' } }, { sourceMessageId: 'other-message' }, { expectedMembershipGeneration: 'new-generation' }]) {
    assert.throws(() => registry.create('member', { ...input(), ...patch }, 124), /thread_request_conflict/);
  }
  const other = registry.create('agent', input(), 124);
  assert.notEqual(first.thread.threadId, other.thread.threadId);
  assert.equal(registry.snapshot().threads.length, 2);
});

test('thread input rejects injected identity, membership and permission fields and malformed titles', () => {
  const raw = { conversationId: 'conversation', threadId: 'main', title: '讨论', clientEventId: 'create', expectedMembershipGeneration: 'initial' };
  for (const extra of [{ memberId: 'other' }, { authorId: 'other' }, { memberIds: ['other'] }, { grants: [] }, { private: true }, { parent: {} }]) {
    assert.throws(() => threadInput({ ...raw, ...extra }), /invalid_thread_request/);
  }
  for (const title of ['', '   ', 'a'.repeat(129), '\nname', '\ud800', 'x\0y']) assert.throws(() => threadInput({ ...raw, title }), /invalid_thread_title/);
  assert.equal(threadInput({ ...raw, title: '  有效 🧪  ' }).title, '有效 🧪');
  assert.throws(() => threadInput({ ...raw, expectedMembershipGeneration: undefined }), /invalid_membership_generation/);
});

test('bounded thread capacity preserves exact retry and restore without a threads snapshot starts empty', () => {
  const registry = new ThreadRegistry();
  for (let i = 0; i < 100; i++) registry.create('member', input(`create-${i}`), i);
  assert.throws(() => registry.create('member', input('overflow'), 101), /thread_capacity_reached/);
  assert.equal(registry.create('member', input('create-0'), 102).duplicate, true);
  registry.restore(); assert.deepEqual(registry.snapshot(), { threads: [], requests: [] });
});
