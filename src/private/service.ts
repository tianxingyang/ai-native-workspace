import { setTimeout as delay } from 'node:timers/promises';
import { requireCondition, scopeValue, stringValue } from '../contracts.js';
import { bearer, jsonBody, respond, server } from '../http.js';
import { PrivateEngine } from './engine.js';
import { clientSession, serveWeb } from './web.js';

export function privateService(engine: PrivateEngine, options: { web?: boolean } = {}) {
  const { state } = engine;
  return server(async (request, response, url) => {
    if (options.web && serveWeb(request, response, url)) return;
    if (request.method === 'GET' && url.pathname === '/health') { respond(response, 200, { service: 'control', mode: 'private-mock', storageVersion: 1 }); return; }
    const token = bearer(request);
    const actor = state.authenticate(token);
    if (url.pathname === '/session' && request.method === 'GET') { respond(response, 200, engine.commit(() => clientSession(state, actor))); return; }
    const body = request.method === 'POST' ? await jsonBody(request) : undefined;
    if (body) requireCondition(body.memberId === undefined && body.authorId === undefined, 400, 'identity_is_authenticated');
    // Body reads and idle long polls await I/O: recheck credentials immediately before each operation.
    const commit = <T>(fn: () => T) => engine.commit(() => { state.authenticate(token); return fn(); });
    const guard = (runId: string) => engine.guardTool(actor, stringValue(request.headers['x-coseat-instance'], 'instance', 128), stringValue(request.headers['x-coseat-lease'], 'lease', 128), runId);
    if (url.pathname === '/attachments' && request.method === 'GET') {
      const runId = url.searchParams.get('runId') ?? undefined;
      requireCondition(runId || (!request.headers['x-coseat-instance'] && !request.headers['x-coseat-lease']), 400, 'run_required');
      const value = commit(() => {
        if (runId) guard(runId);
        return state.readAttachment(actor, scopeValue(Object.fromEntries(url.searchParams)), stringValue(url.searchParams.get('messageId'), 'messageId', 128),
          stringValue(url.searchParams.get('expectedMembershipGeneration'), 'membership_generation', 128), runId);
      });
      respond(response, 200, value); return;
    }
    if (url.pathname === '/conversations/options' && request.method === 'GET') {
      respond(response, 200, commit(() => state.conversationOptions(actor))); return;
    }
    if (url.pathname === '/conversations' && body) {
      const value = commit(() => state.createConversation(actor, body));
      respond(response, value.duplicate ? 200 : 201, value); return;
    }
    if (url.pathname === '/memberships' && request.method === 'GET') {
      const scope = scopeValue(Object.fromEntries(url.searchParams));
      respond(response, 200, commit(() => state.membershipRoster(actor, scope))); return;
    }
    if (url.pathname === '/memberships/remove' && body) {
      const value = commit(() => engine.removeScopeMember(actor, stringValue(body.targetMemberId, 'target_member_id', 128), scopeValue(body),
        body.expectedRevision as number, stringValue(body.clientEventId, 'client_event_id', 128)));
      // Management responses contain membership metadata, never message/run contents.
      respond(response, 200, { change: value.change, duplicate: value.duplicate }); return;
    }
    if (url.pathname === '/memberships/add' && body) {
      const value = commit(() => engine.addScopeMember(actor, stringValue(body.targetMemberId, 'target_member_id', 128), scopeValue(body),
        body.expectedRevision as number, stringValue(body.clientEventId, 'client_event_id', 128), body.grant));
      respond(response, 200, { change: value.change, duplicate: value.duplicate }); return;
    }
    if (url.pathname === '/sync' && request.method === 'GET') {
      const scope = scopeValue(Object.fromEntries(url.searchParams));
      const value = commit(() => { state.authorize(actor, 'read', scope); engine.sweep(); return state.syncScope(actor, scope, url.searchParams.get('cursor') ?? undefined); });
      respond(response, 200, value); return;
    }
    if (url.pathname === '/messages/receipt' && request.method === 'GET') {
      const scope = scopeValue(Object.fromEntries(url.searchParams));
      respond(response, 200, commit(() => ({ message: state.messageReceipt(actor, scope, stringValue(url.searchParams.get('clientEventId'), 'clientEventId', 128)) }))); return;
    }
    if (url.pathname === '/messages/change-receipt' && request.method === 'GET') {
      const scope = scopeValue(Object.fromEntries(url.searchParams));
      respond(response, 200, commit(() => ({ receipt: state.messageChangeReceipt(actor, scope, stringValue(url.searchParams.get('clientEventId'), 'clientEventId', 128)) }))); return;
    }
    if (url.pathname === '/read-position' && body) {
      respond(response, 200, commit(() => state.advanceReadPosition(actor, scopeValue(body), stringValue(body.messageId, 'messageId', 128), body.expectedMembershipGeneration))); return;
    }
    const changeMatch = /^\/messages\/([^/]+)\/(edit|retract)$/.exec(url.pathname);
    if (changeMatch && body) {
      const value = commit(() => engine.changeMessage(actor, changeMatch[1]!, changeMatch[2] as 'edit' | 'retract',
        body.expectedRevision as number, stringValue(body.clientEventId, 'client_event_id', 128),
        changeMatch[2] === 'edit' ? stringValue(body.text, 'text') : undefined, body.expectedMembershipGeneration));
      respond(response, 200, value); return;
    }
    if (url.pathname === '/messages' && body) {
      const value = commit(() => {
        const result = state.createMessage(actor, scopeValue(body), stringValue(body.text, 'text'), stringValue(body.clientEventId, 'client_event_id', 128),
          body.replyToMessageId === undefined ? undefined : stringValue(body.replyToMessageId, 'replyToMessageId', 128), body.expectedMembershipGeneration, body.attachment);
        if (!result.duplicate && state.evaluate(result.message)) {
          // Missing execution permissions do not reject otherwise valid chat.
          try { state.claim(state.config.researchMemberId, result.message.id); } catch { /* audit retains the denial */ }
        }
        return result;
      });
      respond(response, value.duplicate ? 200 : 201, value); return;
    }
    if (url.pathname === '/messages' && request.method === 'GET') {
      const runId = url.searchParams.get('runId') ?? undefined;
      const value = commit(() => {
        if (runId) guard(runId);
        const scope = scopeValue(Object.fromEntries(url.searchParams));
        return { messages: state.readMessages(actor, scope, runId), readThroughMessageId: state.readPosition(actor, scope) };
      });
      respond(response, 200, value); return;
    }
    if (url.pathname === '/worker/poll' && body) {
      const instance = stringValue(body.instanceId, 'instance', 128);
      requireCondition(body.runId === undefined && body.leaseId === undefined, 400, 'server_selects_assignment');
      let delivery = commit(() => engine.poll(actor, instance));
      if (delivery.command === 'idle') {
        await delay(750); // Bounded long poll; no held database transaction.
        delivery = commit(() => engine.poll(actor, instance));
      }
      respond(response, 200, delivery); return;
    }
    if (url.pathname === '/worker/events' && body) {
      const value = commit(() => engine.ingest(actor, stringValue(body.instanceId, 'instance', 128), stringValue(body.leaseId, 'lease', 128), body.events));
      respond(response, 200, value); return;
    }
    if (url.pathname === '/worker/not-started' && body) {
      respond(response, 200, commit(() => engine.notStarted(actor, stringValue(body.instanceId, 'instance', 128), stringValue(body.leaseId, 'lease', 128)))); return;
    }
    if (url.pathname.startsWith('/tools/') && body) {
      const runId = stringValue(body.runId, 'run', 128);
      const value = commit(() => {
        guard(runId);
        if (url.pathname === '/tools/send') {
          requireCondition(body.conversationId === undefined && body.threadId === undefined, 400, 'route_is_bound');
          return state.publish(actor, runId, body.result);
        }
        if (url.pathname === '/tools/confirm-claim') {
          requireCondition(Number.isInteger(body.sourceRevision), 400, 'invalid_revision');
          return state.confirmClaim(actor, runId, stringValue(body.sourceMessageId, 'source', 128), Number(body.sourceRevision));
        }
        if (url.pathname === '/tools/request-approval') return state.requestApproval(actor, runId, stringValue(body.action, 'action', 128), stringValue(body.reason, 'reason', 1000));
        requireCondition(false, 404, 'tool_not_found');
      });
      respond(response, 200, value); return;
    }
    if (url.pathname === '/runs' && request.method === 'GET') {
      const scope = scopeValue(Object.fromEntries(url.searchParams));
      const runs = commit(() => { state.authorize(actor, 'read', scope); engine.sweep(); return [...state.runs.values()].filter(r => r.work.route.conversationId === scope.conversationId && r.work.route.threadId === scope.threadId); });
      respond(response, 200, { runs: runs.map(run => state.presentRun(run)) }); return;
    }
    const match = /^\/runs\/([^/]+)(\/cancel)?$/.exec(url.pathname);
    if (match?.[2] && body) { respond(response, 202, commit(() => engine.cancel(actor, match[1]!))); return; }
    if (match && request.method === 'GET') { respond(response, 200, commit(() => { state.visibleRun(actor, match[1]!); engine.sweep(); return state.presentRun(state.runs.get(match[1]!)!); })); return; }
    respond(response, 404, { error: 'not_found' });
  });
}
