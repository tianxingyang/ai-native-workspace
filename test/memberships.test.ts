import assert from 'node:assert/strict';
import test from 'node:test';
import { MembershipRegistry } from '../src/control/memberships.js';

const scope = { conversationId: 'group', threadId: 'main' }, other = { conversationId: 'private', threadId: 'main' };

test('membership removals survive restore and preserve independent resources and identities', () => {
  const registry = new MembershipRegistry(), configured = [scope, other];
  const result = registry.remove('manager', 'member', scope, 1, 'remove', configured, 123);
  assert.equal(result.change.revision, 2); assert.equal(result.duplicate, false);
  assert.deepEqual(registry.scopes('member', configured), [other]);
  assert.deepEqual(registry.scopes('another-member', configured), configured);
  assert.deepEqual(configured, [scope, other]); assert.equal(registry.revision(other), 1);
  result.change.targetMemberId = 'client-mutation';
  const restored = new MembershipRegistry(); restored.restore(registry.snapshot());
  assert.deepEqual(restored.scopes('member', configured), [other]);
  assert.equal(restored.revision(scope), 2);
  const replay = restored.remove('manager', 'member', scope, 1, 'remove', configured, 999);
  assert.ok(replay.duplicate); assert.equal(replay.change.targetMemberId, 'member'); assert.equal(replay.change.at, 123);
});

test('membership requests detect stale revisions and mismatched replay without changing other members', () => {
  const registry = new MembershipRegistry();
  registry.remove('manager', 'member', scope, 1, 'remove', [scope], 1);
  assert.throws(() => registry.remove('manager', 'other-member', scope, 2, 'remove', [scope], 2), /membership_request_conflict/);
  assert.throws(() => registry.remove('manager', 'other-member', scope, 1, 'new-request', [scope], 2), /membership_revision_conflict/);
  assert.throws(() => registry.remove('manager', 'member', scope, 2, 'new-request', [scope], 2), /scope_member_not_found/);
  assert.throws(() => registry.remove('manager', 'outsider', scope, 2, 'new-request', [], 2), /scope_member_not_found/);
  assert.deepEqual(registry.scopes('other-member', [scope]), [scope]);
  assert.equal(registry.remove('another-manager', 'other-member', scope, 2, 'remove', [scope], 3).change.revision, 3);
});

test('membership snapshots can roll back a removal and old snapshots initialize an empty overlay', () => {
  const registry = new MembershipRegistry(), before = registry.snapshot();
  registry.remove('manager', 'member', scope, 1, 'remove', [scope], 1);
  registry.restore(before); assert.deepEqual(registry.scopes('member', [scope]), [scope]);
  assert.equal(registry.revision(scope), 1);
  assert.equal(registry.remove('manager', 'member', scope, 1, 'remove', [scope], 2).duplicate, false);
  registry.restore(); assert.deepEqual(registry.scopes('member', [scope]), [scope]);
});
