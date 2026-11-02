import assert from 'node:assert/strict';
import test from 'node:test';
import { get } from 'node:http';
import { startWebDemo } from '../scripts/web-demo.js';
import { requestJson } from '../src/http.js';
import { expectStatus } from './helpers.js';
import { clientSession } from '../src/private/web.js';

test('local web demo serves locked-down assets, separate Worker, and authenticated scope metadata', async t => {
  const demo = await startWebDemo(); t.after(() => demo.stop());
  assert.notEqual(demo.controlPid, demo.workerPid);
  const response = await fetch(demo.url);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(await response.text(), /CoSeat/);
  assert.equal((await fetch(`${demo.url}/client.js`)).status, 200);
  assert.equal((await fetch(`${demo.url}/package.json`)).status, 401);
  assert.equal((await fetch(`${demo.url}/`, { headers: { origin: 'https://untrusted.invalid' } })).status, 403);
  const rebindingStatus = await new Promise<number | undefined>((resolve, reject) => {
    get(demo.url, { headers: { host: 'untrusted.invalid' } }, result => { result.resume(); resolve(result.statusCode); }).on('error', reject);
  });
  assert.equal(rebindingStatus, 403);
  await expectStatus(requestJson(demo.url, '', '/session'), 401);
  const session = await requestJson<{ scopes: { members: unknown[]; permissions: Record<string, number> }[] }>(demo.url, demo.ownerToken, '/session');
  assert.equal(session.scopes.length, 2);
  assert.equal(session.scopes[0]!.members.length, 2);
  assert.equal(session.scopes[0]!.permissions.send, demo.expiresAt);
  assert.equal(JSON.stringify(session).includes(demo.ownerToken), false);
  await expectStatus(requestJson(demo.url, demo.ownerToken, '/messages?conversationId=secret&threadId=private'), 403);
  demo.engine.state.config.credentialExpiresAt!['demo-owner'] = Date.now() - 1;
  await expectStatus(requestJson(demo.url, demo.ownerToken, '/session'), 401, 'credential_expired');
});

test('session discovery filters unshared members, expired scopes and per-action permissions without granting access', async t => {
  const demo = await startWebDemo(); t.after(() => demo.stop());
  const state = demo.engine.state;
  state.config.members.push({ id: 'hidden-member', name: 'Unshared', kind: 'human' });
  state.config.memberships['hidden-member'] = [{ conversationId: 'hidden', threadId: 'hidden' }];
  const owner = state.config.grants.filter(g => g.memberId === 'demo-owner');
  owner[0]!.actions = ['read']; owner[1]!.expiresAt = Date.now() - 1;
  const session = clientSession(state, 'demo-owner');
  assert.equal(session.scopes.length, 1);
  assert.equal(session.scopes[0]!.permissions.send, 0);
  assert.equal(session.scopes[0]!.members.some(m => m.id === 'hidden-member'), false);
  owner[0]!.expiresAt = Date.now() - 1;
  assert.throws(() => clientSession(state, 'demo-owner'), /no_readable_scope/);
});
