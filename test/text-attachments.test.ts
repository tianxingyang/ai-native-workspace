import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiError, type Action, type Scope } from '../src/contracts.js';
import type { ControlConfig } from '../src/control/state.js';
import { defaultPolicy } from '../src/control/authorization.js';
import { fixtureSources } from '../src/dev-fixture.js';
import { PrivateEngine } from '../src/private/engine.js';
import { SnapshotStore } from '../src/private/store.js';
import { privateService } from '../src/private/service.js';
import { close, listen, requestJson } from '../src/http.js';
import { expectStatus } from './helpers.js';

const scope = { conversationId: 'attachment-room', threadId: 'main' };
const other = { conversationId: 'attachment-room', threadId: 'other' };
const attachment = { name: 'notes.md', text: 'PRIVATE-ATTACHMENT-CONTENT\n你好 <script>not executable</script>' };
const route = (messageId: string, resource: Scope = scope, extras: Record<string, string> = {}) =>
  `/attachments?${new URLSearchParams({ ...resource, messageId, expectedMembershipGeneration: 'initial', ...extras })}`;

async function setup(t: { after(fn: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), 'coseat-attachments-')), path = join(directory, 'state.sqlite');
  const ids = ['writer', 'reader', 'worker', 'nonreader'], expiry = Date.now() + 600000;
  const tokens = Object.fromEntries(ids.map(id => [id, randomBytes(32).toString('hex')]));
  const grant = (memberId: string, resource: Scope, actions: Action[]) => ({ ...resource, id: `${memberId}-${resource.threadId}`, memberId, actions, revision: 1, expiresAt: expiry, revoked: false });
  const config: ControlConfig = {
    members: ids.map(id => ({ id, name: id, kind: id === 'worker' ? 'agent' : 'human' })),
    tokens: Object.fromEntries(ids.map(id => [tokens[id]!, id])), credentialExpiresAt: Object.fromEntries(ids.map(id => [id, expiry])),
    memberships: Object.fromEntries(ids.map(id => [id, [scope, other]])),
    grants: [grant('writer', scope, ['read', 'send', 'manage_resource']), grant('writer', other, ['read', 'send']),
      grant('reader', scope, ['read']), grant('reader', other, ['read']), grant('nonreader', scope, ['send']),
      grant('worker', scope, ['read', 'send', 'claim', 'request_approval']), grant('worker', other, ['read', 'send', 'claim', 'request_approval'])],
    researchMemberId: 'worker', sources: fixtureSources,
  };
  let store = new SnapshotStore(path), engine = new PrivateEngine(store, config), service = privateService(engine), url = await listen(service);
  const api = <T = any>(actor: string, path: string, body?: unknown, headers?: Record<string, string>) => requestJson<T>(url, tokens[actor]!, path, body, undefined, headers);
  const input = (clientEventId = 'attach-one') => ({ ...scope, text: 'Here are the notes', clientEventId, expectedMembershipGeneration: 'initial', attachment });
  t.after(async () => { await close(service); store.close(); assert.ok(directory.startsWith(join(tmpdir(), 'coseat-attachments-'))); await rm(directory, { recursive: true, force: true }); });
  return { config, api, input, get engine() { return engine; }, get store() { return store; },
    async restart() { await close(service); store.close(); store = new SnapshotStore(path); engine = new PrivateEngine(store, config); service = privateService(engine); url = await listen(service); },
  };
}

test('text attachment persists atomically, exposes only metadata in sync and retries without duplication', async t => {
  const env = await setup(t), input = env.input();
  const first = await env.api('writer', '/messages', input), id = first.message.id;
  assert.deepEqual(first.message.attachment, { name: attachment.name, bytes: Buffer.byteLength(attachment.text), sha256: createHash('sha256').update(attachment.text).digest('hex') });
  assert.equal((await env.api('writer', '/messages', input)).duplicate, true);
  const sync = await env.api('reader', `/sync?${new URLSearchParams(scope)}`);
  assert.equal(sync.messages.length, 1);
  assert.equal(JSON.stringify(sync).includes(attachment.text), false);
  assert.equal(JSON.stringify(env.engine.state.snapshot().messageKeys).includes(attachment.text), false);
  assert.equal((await env.api('reader', route(id))).text, attachment.text);
  await env.restart();
  assert.equal((await env.api('reader', route(id))).text, attachment.text);
  assert.equal((await env.api('writer', '/messages', input)).message.id, id);
  for (const changed of [{ ...attachment, text: 'different content' }, { ...attachment, name: 'renamed.txt' }]) {
    await expectStatus(env.api('writer', '/messages', { ...input, attachment: changed }), 409, 'idempotency_key_conflict');
  }
  await expectStatus(env.api('writer', '/messages', { ...input, attachment: undefined }), 409, 'idempotency_key_conflict');
  const plain = { ...scope, text: 'Legacy ordinary message', clientEventId: 'plain' };
  const legacy = await env.api('writer', '/messages', plain);
  assert.equal((await env.api('writer', '/messages', plain)).message.id, legacy.message.id);
  await expectStatus(env.api('reader', route(legacy.message.id)), 404);
});

test('attachment lookup requires exact scope, current read permission and membership generation', async t => {
  const env = await setup(t), { message } = await env.api('writer', '/messages', env.input());
  await expectStatus(env.api('reader', route(message.id, other)), 404);
  await expectStatus(env.api('reader', route(message.id, { ...scope, conversationId: 'wrong' })), 403);
  await expectStatus(env.api('nonreader', route(message.id)), 403);
  await expectStatus(env.api('reader', route(message.id, scope, { expectedMembershipGeneration: 'stale-generation' })), 409, 'membership_generation_conflict');
  const grant = env.config.grants.find(g => g.memberId === 'reader' && g.threadId === scope.threadId)!;
  const expiresAt = grant.expiresAt; grant.expiresAt = Date.now() - 1;
  await expectStatus(env.api('reader', route(message.id)), 403); grant.expiresAt = expiresAt;
  await env.api('writer', '/memberships/remove', { ...scope, targetMemberId: 'reader', expectedRevision: 1, clientEventId: 'remove-reader' });
  await expectStatus(env.api('reader', route(message.id)), 403);
  await env.restart();
  await expectStatus(env.api('reader', route(message.id)), 403);
  assert.equal((await env.api('writer', route(message.id))).text, attachment.text);
});

test('caption edit preserves attachment while retraction removes content and old retries cannot resurrect it', async t => {
  const env = await setup(t), input = env.input(), { message } = await env.api('writer', '/messages', input);
  await env.api('writer', `/messages/${message.id}/edit`, { text: 'Corrected caption', expectedRevision: 1, clientEventId: 'edit' });
  assert.equal((await env.api('reader', route(message.id))).text, attachment.text);
  const withdrawn = await env.api('writer', `/messages/${message.id}/retract`, { expectedRevision: 2, clientEventId: 'retract' });
  assert.equal(withdrawn.message.attachment, undefined);
  await expectStatus(env.api('reader', route(message.id)), 404);
  const retried = await env.api('writer', '/messages', input);
  assert.equal(retried.duplicate, true); assert.equal(retried.message.retracted, true); assert.equal(retried.message.attachment, undefined);
  assert.equal(JSON.stringify(env.engine.state.snapshot()).includes(attachment.text), false);
  await env.restart();
  await expectStatus(env.api('reader', route(message.id)), 404);
  assert.equal(JSON.stringify(env.engine.state.snapshot()).includes(attachment.text), false);
});

test('storage failure rolls back both attachment and idempotency receipt', async t => {
  const env = await setup(t), save = env.store.save.bind(env.store), input = env.input();
  env.store.save = () => { throw new ApiError(507, 'trial_storage_limit'); };
  await expectStatus(env.api('writer', '/messages', input), 507, 'trial_storage_limit');
  env.store.save = save;
  assert.equal(env.engine.state.messages.size, 0);
  assert.equal(JSON.stringify(env.engine.state.snapshot()).includes(attachment.text), false);
  await env.restart();
  const created = await env.api('writer', '/messages', input);
  assert.equal(created.duplicate, false);
  assert.equal((await env.api('reader', route(created.message.id))).text, attachment.text);
});

test('text attachment limits count UTF-8 bytes and reject invalid names, binary controls and malformed Unicode', async t => {
  const env = await setup(t);
  const invalid = [null, [], 'file', {}, { name: '../notes.txt', text: 'x' }, { name: 'a\\b.txt', text: 'x' },
    { name: 'notes.html', text: 'x' }, { name: 'notes.txt', text: '' }, { name: 'notes.txt', text: '\0binary' },
    { name: 'notes.txt', text: '\ud800' }];
  for (let index = 0; index < invalid.length; index++) {
    await expectStatus(env.api('writer', '/messages', { ...env.input(`invalid-${index}`), attachment: invalid[index] }), 400);
  }
  for (const text of ['a'.repeat(8193), '中'.repeat(2731)]) {
    await expectStatus(env.api('writer', '/messages', { ...env.input('oversize'), attachment: { name: 'notes.txt', text } }), 413, 'attachment_too_large');
  }
  assert.equal(env.engine.state.messages.size, 0);
  const full = await env.api('writer', '/messages', { ...env.input('full'), attachment: { name: 'full.txt', text: 'a'.repeat(8192) } });
  assert.equal(full.message.attachment.bytes, 8192);
  const unicode = await env.api('writer', '/messages', { ...env.input('unicode'), attachment: { name: '资料.txt', text: '中'.repeat(2730) } });
  assert.equal(unicode.message.attachment.bytes, 8190);
});

test('run-bound attachment reads require the assigned lease and reject old context after message edit', async t => {
  const env = await setup(t), { message } = await env.api('writer', '/messages', env.input());
  const run = env.engine.commit(() => env.engine.state.claim('worker', message.id)).run;
  const delivery = await env.api('worker', '/worker/poll', { instanceId: 'attachment-device' });
  assert.equal(delivery.runId, run.id);
  const headers = { 'x-coseat-instance': 'attachment-device', 'x-coseat-lease': delivery.leaseId };
  const path = route(message.id, scope, { runId: run.id });
  await expectStatus(env.api('worker', path), 400);
  await expectStatus(env.api('worker', route(message.id), undefined, headers), 400, 'run_required');
  assert.equal((await env.api('worker', path, undefined, headers)).text, attachment.text);
  await expectStatus(env.api('worker', route(message.id, other, { runId: run.id }), undefined, headers), 403);
  await env.api('writer', `/messages/${message.id}/edit`, { text: 'Context changed', expectedRevision: 1, clientEventId: 'invalidate-run' });
  await expectStatus(env.api('worker', path, undefined, headers), 409);
  assert.equal((await env.api('reader', route(message.id))).text, attachment.text);
});

test('rejoining with a new grant permits history but rejects attachment requests from the old membership', async t => {
  const env = await setup(t);
  env.config.policy = defaultPolicy();
  env.config.policy.disabledActions = env.config.policy.disabledActions.filter(action => action !== 'grant_permissions');
  env.config.grants[0]!.actions.push('manage_workspace', 'grant_permissions');
  env.config.conversationCreation = { authorityScope: scope, allowedActions: ['read', 'send', 'manage_resource'], maxGrantDurationMs: 300000 };
  const expiresAt = Date.now() + 180000;
  const { conversation } = await env.api('writer', '/conversations', { kind: 'group', title: 'Attachment audience', memberIds: ['writer', 'reader'], clientEventId: 'create',
    initialGrants: [{ targetMemberId: 'writer', actions: ['read', 'send', 'manage_resource'], expiresAt }, { targetMemberId: 'reader', actions: ['read'], expiresAt }] });
  const { message } = await env.api('writer', '/messages', { ...env.input(), ...conversation });
  const oldRead = route(message.id, conversation);
  assert.equal((await env.api('reader', oldRead)).text, attachment.text);
  await env.api('writer', '/memberships/remove', { ...conversation, targetMemberId: 'reader', expectedRevision: 1, clientEventId: 'remove' });
  await expectStatus(env.api('reader', oldRead), 403);
  const { change } = await env.api('writer', '/memberships/add', { ...conversation, targetMemberId: 'reader', expectedRevision: 2, clientEventId: 'rejoin', grant: { actions: ['read'], expiresAt } });
  await expectStatus(env.api('reader', oldRead), 409, 'membership_generation_conflict');
  const currentRead = route(message.id, conversation, { expectedMembershipGeneration: change.id });
  assert.equal((await env.api('reader', currentRead)).text, attachment.text);
  await env.restart();
  await expectStatus(env.api('reader', oldRead), 409, 'membership_generation_conflict');
  assert.equal((await env.api('reader', currentRead)).text, attachment.text);
});
