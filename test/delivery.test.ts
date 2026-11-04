import assert from 'node:assert/strict';
import test from 'node:test';
import { DeliveryJournal } from '../src/control/delivery.js';
import type { Message } from '../src/contracts.js';

const scope = { conversationId: 'one', threadId: 'chat' };
const message = (id: string, text = id): Message => ({ ...scope, id, text, revision: 1, authorId: 'owner', origin: 'chat', createdAt: 1 });

test('delivery sends current values once per entity and keeps no historical bodies', () => {
  const journal = new DeliveryJournal(), first = message('first', 'withdrawn private body'), second = message('second');
  const initial = journal.read('owner', scope, [first, second], [], null);
  assert.ok(initial.reset);
  const updated = { ...first, revision: 2, text: '', retracted: true };
  const delta = journal.read('owner', scope, [updated, second], [], second.id, initial.cursor);
  assert.equal(delta.reset, false); assert.deepEqual(delta.messages, [updated]); assert.equal(delta.readThroughMessageId, second.id);
  assert.deepEqual(journal.read('owner', scope, [updated, second], [], second.id, initial.cursor), delta);
  assert.equal(JSON.stringify(journal.snapshot()).includes('withdrawn private body'), false);
  delta.messages[0]!.text = 'client mutation';
  assert.equal(updated.text, '');
  const removed = journal.read('owner', scope, [second], [], null, delta.cursor);
  assert.deepEqual(removed.removedMessageIds, [first.id]); assert.deepEqual(removed.messages, []);
});

test('delivery cursor is bound to actor and scope before epoch reset and is strictly parsed', () => {
  const journal = new DeliveryJournal(), start = journal.read('owner', scope, [], [], null);
  for (const [actor, resource] of [['other', scope], ['owner', { ...scope, threadId: 'other' }]] as const) {
    assert.throws(() => journal.read(actor, resource, [], [], null, start.cursor), /sync_cursor_scope_mismatch/);
  }
  for (const cursor of ['', 'x'.repeat(129), start.cursor.replace('v1.', 'v2.'), start.cursor.replace(/\.0$/, '.01'), start.cursor.replace(/\.0$/, '.9007199254740992')]) {
    assert.throws(() => journal.read('owner', scope, [], [], null, cursor), /invalid_sync_cursor/);
  }
  const future = journal.read('owner', scope, [], [], null, start.cursor.replace(/\.0$/, '.1'));
  assert.ok(future.reset); assert.ok(future.cursorAhead);
  journal.restore();
  const reset = journal.read('owner', scope, [], [], null, start.cursor);
  assert.ok(reset.reset); assert.notEqual(reset.streamId, start.streamId);
});

test('delivery compaction retains exactly 512 descriptors and resets older baselines', () => {
  const journal = new DeliveryJournal(), empty = journal.read('owner', scope, [], [], null);
  const first = journal.read('owner', scope, [message('0')], [], null, empty.cursor);
  const messages = Array.from({ length: 513 }, (_, i) => message(String(i)));
  const boundary = journal.read('owner', scope, messages, [], null, first.cursor);
  assert.equal(boundary.reset, false); assert.equal(boundary.messages.length, 512);
  const expired = journal.read('owner', scope, messages, [], null, empty.cursor);
  assert.ok(expired.reset); assert.equal(expired.messages.length, 513);
  const restored = new DeliveryJournal(); restored.restore(journal.snapshot());
  const unchanged = restored.read('owner', scope, messages, [], '0', expired.cursor);
  assert.equal(unchanged.reset, false); assert.deepEqual(unchanged.messages, []);
  assert.equal(unchanged.cursor, expired.cursor); assert.equal(unchanged.readThroughMessageId, '0');
});
