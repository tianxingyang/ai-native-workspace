import assert from 'node:assert/strict';
import test from 'node:test';
import { ControlState } from '../src/control/state.js';
import { defaultPolicy, HIGH_RISK_ACTIONS, parsePolicy } from '../src/control/authorization.js';
import { developmentGrants, fixtureSources, members } from '../src/dev-fixture.js';
import { clientSession } from '../src/private/web.js';
import { fixtureResult } from '../src/worker/fake.js';
import { validateWork, type Action, type Grant } from '../src/contracts.js';
import { scope } from './helpers.js';

function setup() {
  let now = Date.now();
  const state = new ControlState({ members: structuredClone(members), grants: developmentGrants(), tokens: {}, memberships: { alex: [scope], sam: [scope], guest: [scope] }, researchMemberId: 'sam', sources: fixtureSources, policy: defaultPolicy() }, () => now);
  return { state, advance: (ms: number) => { now += ms; } };
}
function source(state: ControlState) { return state.createMessage('alex', scope, 'research', 'source').message; }

test('send receipts require read and expose only the sender current message in the requested scope', () => {
  const { state } = setup(), message = state.createMessage('alex', scope, 'private-original-receipt-body', 'source').message;
  const grant = state.config.grants.find(g => g.memberId === 'alex')!;
  const other = { ...scope, threadId: 'other' };
  state.config.grants.push({ ...grant, ...other, id: 'other-scope' });
  state.config.memberships.alex!.push(other);
  assert.equal(state.messageReceipt('sam', scope, 'source'), null);
  assert.equal(state.messageReceipt('alex', other, 'source'), null);
  assert.equal(state.messageReceipt('alex', scope, 'missing'), null);
  state.changeMessage('alex', message.id, 'edit', 1, 'receipt-edit', 'current text');
  assert.equal(state.messageReceipt('alex', scope, 'source')!.text, 'current text');
  state.changeMessage('alex', message.id, 'retract', 2, 'receipt-retract');
  grant.actions = ['read'];
  const receipt = state.messageReceipt('alex', scope, 'source')!;
  assert.equal(receipt.text, ''); assert.ok(receipt.retracted);
  assert.equal(JSON.stringify(receipt).includes('private-original-receipt-body'), false);
  assert.equal('fingerprint' in receipt, false);
  grant.actions = ['send'];
  assert.throws(() => state.messageReceipt('alex', scope, 'source'), /scope_denied/);
});

test('read positions are private to the authenticated member and require read, not send', () => {
  const { state } = setup(), first = source(state);
  const second = state.createMessage('alex', scope, 'second', 'second').message;
  state.messages.set('elsewhere', { ...first, id: 'elsewhere', threadId: 'other' });
  for (const actor of ['alex', 'sam']) {
    const grant = state.config.grants.find(g => g.memberId === actor)!;
    grant.actions = ['read'];
    assert.equal(state.readPosition(actor, scope), null);
    assert.throws(() => state.advanceReadPosition(actor, scope, 'elsewhere'), /read_target_unavailable/);
    assert.throws(() => state.advanceReadPosition(actor, scope, 'missing'), /read_target_unavailable/);
    assert.equal(state.advanceReadPosition(actor, scope, second.id).readThroughMessageId, second.id);
    assert.equal(state.advanceReadPosition(actor, scope, first.id).readThroughMessageId, second.id);
    grant.actions = ['send'];
    assert.throws(() => state.readPosition(actor, scope), /scope_denied/);
    assert.throws(() => state.advanceReadPosition(actor, scope, first.id), /scope_denied/);
  }
});
test('replies require read and send for human and agent equally and cannot cross scopes', () => {
  const { state } = setup(), parent = source(state);
  state.messages.set('hidden', { ...parent, id: 'hidden', conversationId: 'private', text: 'private body' });
  for (const actor of ['alex', 'sam']) {
    const grant = state.config.grants.find(g => g.memberId === actor)!;
    for (const actions of [['send'], ['read']] as Action[][]) {
      grant.actions = actions;
      assert.throws(() => state.createMessage(actor, scope, 'reply', `denied-${actor}`, parent.id), /scope_denied/);
    }
    grant.actions = ['read', 'send'];
    assert.throws(() => state.createMessage(actor, scope, 'reply', `hidden-${actor}`, 'hidden'), /reply_source_unavailable/);
    assert.throws(() => state.createMessage(actor, scope, 'reply', `missing-${actor}`, 'missing'), /reply_source_unavailable/);
    const reply = state.createMessage(actor, scope, 'reply', `valid-${actor}`, parent.id).message;
    assert.equal(reply.replyToMessageId, parent.id); assert.equal(reply.authorId, actor);
    assert.equal(JSON.stringify(reply).includes(parent.text), false);
  }
});
function split(state: ControlState, memberId: string) {
  const original = state.config.grants.find(g => g.memberId === memberId)!;
  state.config.grants = state.config.grants.filter(g => g.memberId !== memberId);
  const grants = (['read', 'send', 'claim', 'request_approval', 'cancel'] as Action[]).map(action => ({ ...original, id: `${memberId}-${action}`, actions: [action] }));
  state.config.grants.push(...grants);
  return grants;
}

test('authorization treats human and agent members equally; memberships and admin templates never imply read', () => {
  const { state } = setup();
  for (const actor of ['alex', 'sam']) {
    const grant = state.config.grants.find(g => g.memberId === actor)!;
    grant.actions = []; grant.roleIds = ['resource-admin', 'workspace-admin'];
    assert.equal(state.authorize(actor, 'manage_resource', scope).id, grant.id);
    assert.equal(state.authorize(actor, 'manage_workspace', scope).id, grant.id);
    assert.throws(() => state.readMessages(actor, scope), /scope_denied/);
    grant.roleIds.push('read-only');
    assert.deepEqual(state.readMessages(actor, scope), []);
    assert.throws(() => state.authorize(actor, 'send', scope), /scope_denied/);
  }
  assert.throws(() => state.authorize('guest', 'read', scope), /scope_denied/);
  state.config.grants.push({ ...state.config.grants[0]!, memberId: 'absent', id: 'absent' });
  state.config.memberships.absent = [scope];
  assert.equal(state.authorization('absent', 'read', scope).reason, 'unknown_member');
});

test('explicit deny overrides bound allows regardless of order and controls UI hints', () => {
  const { state, advance } = setup();
  const allow = state.config.grants[0]!;
  const deny: Grant = { ...allow, id: 'deny-send', actions: ['send'], effect: 'deny', expiresAt: Date.now() + 1000 };
  for (const grants of [[allow, deny], [deny, allow]]) {
    state.config.grants = grants;
    assert.throws(() => state.authorize('alex', 'send', scope, allow), /scope_denied/);
    assert.equal(state.audit.at(-1)?.reason, 'explicit_deny');
    assert.deepEqual(state.audit.at(-1)?.grantIds, ['deny-send']);
    assert.equal(clientSession(state, 'alex').scopes[0]?.permissions.send, 0);
  }
  advance(1000);
  assert.equal(state.authorization('alex', 'send', scope).allowed, true);
  deny.expiresAt += 10000; deny.revoked = true;
  assert.equal(state.authorization('alex', 'send', scope).allowed, true);
});

test('cancel requires read plus cancel, independently of send, for both identity types', () => {
  for (const actor of ['alex', 'sam']) for (const actions of [['read', 'cancel'], ['read', 'send'], ['cancel'], ['send']] as Action[][]) {
    const { state } = setup(); const { run } = state.claim('sam', source(state).id);
    state.config.grants.find(g => g.memberId === actor)!.actions = actions;
    if (actions.includes('read') && actions.includes('cancel')) assert.equal(state.cancel(actor, run.id).status, 'cancel_requested');
    else { assert.throws(() => state.cancel(actor, run.id), /scope_denied/); assert.equal(run.status, 'queued'); }
  }
});

test('split grants bind each required action and cannot fall back to replacement authority', () => {
  const { state } = setup(); const grants = split(state, 'sam');
  const { run } = state.claim('sam', source(state).id);
  validateWork(run.work);
  assert.equal(new Set(run.work.authorization!.grants.map(g => g.id)).size, 4);
  const bound = grants.find(g => g.actions.includes('send'))!;
  state.config.grants.push({ ...bound, id: 'replacement-send' }); bound.revoked = true;
  assert.equal(state.authorization('sam', 'send', scope).allowed, true);
  assert.throws(() => state.publish('sam', run.id, fixtureResult()), /scope_denied/);
  assert.equal(state.messages.size, 1);
});

test('new deny fences a running publication even when it was absent at claim time', () => {
  const { state } = setup(); const { run } = state.claim('sam', source(state).id);
  state.config.grants.push({ ...state.config.grants[1]!, id: 'deny-late', effect: 'deny', actions: ['send'] });
  assert.throws(() => state.publish('sam', run.id, fixtureResult()), /scope_denied/);
  assert.equal(run.receiptId, undefined);
});

test('revocation of any compiled action grant fences every subsequent run action', () => {
  for (const action of ['read', 'claim', 'send', 'request_approval'] as const) {
    const { state } = setup(); const grants = split(state, 'sam');
    const { run } = state.claim('sam', source(state).id);
    grants.find(g => g.actions.includes(action))!.revoked = true;
    assert.throws(() => state.publish('sam', run.id, fixtureResult()), /scope_denied/);
    assert.throws(() => state.readMessages('sam', scope, run.id), /scope_denied/);
    assert.equal(state.messages.size, 1);
  }
});

test('policy and role edits invalidate work even if the operator forgets to bump the version', () => {
  for (const change of ['version', 'role', 'disabled'] as const) {
    const { state } = setup();
    state.config.grants[1]!.actions = []; state.config.grants[1]!.roleIds = ['collaborator'];
    const { run } = state.claim('sam', source(state).id);
    if (change === 'version') state.config.policy!.version++;
    if (change === 'role') state.config.policy!.roles[1]!.actions = ['read'];
    if (change === 'disabled') state.config.policy!.disabledActions.push('send');
    assert.throws(() => state.readMessages('sam', scope, run.id), /policy_revision_changed/);
    assert.throws(() => state.publish('sam', run.id, fixtureResult()), /policy_revision_changed|scope_denied/);
  }
});

test('legacy runs fail closed when adopting a configured policy; new split work validates all bindings', () => {
  const { state } = setup(); const { run } = state.claim('sam', source(state).id);
  delete run.work.authorization;
  assert.throws(() => state.publish('sam', run.id, fixtureResult()), /policy_revision_changed/);
  const fresh = state.claim('sam', state.createMessage('alex', scope, 'next', 'next').message.id).run;
  for (const grants of [[], fresh.work.authorization!.grants.slice(1), Array(4).fill(fresh.work.authorization!.grants[0])]) {
    assert.throws(() => validateWork({ ...fresh.work, authorization: { ...fresh.work.authorization!, grants } }), /invalid_authorization_bindings/);
  }
});

test('high risk actions are disabled by default even with explicit grants; changing policy alone grants nothing', () => {
  const { state } = setup();
  for (const action of HIGH_RISK_ACTIONS) {
    state.config.grants[0]!.actions.push(action);
    assert.equal(state.authorization('alex', action, scope).reason, 'policy_disabled');
    state.config.policy!.disabledActions = [];
    assert.equal(state.authorization('alex', action, scope).allowed, true);
    assert.equal(state.authorization('sam', action, scope).allowed, false);
    state.config.policy!.disabledActions = [...HIGH_RISK_ACTIONS];
  }
});

test('role references and malformed policy fail closed; decision metadata survives snapshot restoration', () => {
  const { state } = setup(); state.config.grants[0]!.roleIds = ['missing'];
  assert.equal(state.authorization('alex', 'read', scope).allowed, false);
  for (const policy of [{ ...defaultPolicy(), version: 0 }, { ...defaultPolicy(), disabledActions: ['typo'] }, { ...defaultPolicy(), roles: [defaultPolicy().roles[0], defaultPolicy().roles[0]] }]) assert.throws(() => parsePolicy(policy));
  assert.throws(() => state.authorize('alex', 'read', scope));
  const audit = structuredClone(state.audit); state.restore(state.snapshot());
  assert.deepEqual(state.audit, audit); assert.equal(audit[0]?.policyVersion, 1);
  assert.equal(audit[0]?.policyDigest?.length, 64);
});
