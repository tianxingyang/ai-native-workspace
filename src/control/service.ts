import { setTimeout as delay } from 'node:timers/promises';
import { ApiError, PROTOCOL_VERSION, requireCondition, scopeValue, stringValue, terminal, type Run } from '../contracts.js';
import { bearer, jsonBody, respond, server } from '../http.js';
import { ControlState } from './state.js';
import { RuntimeClient } from './runtime-client.js';

export function controlService(state: ControlState, runtime: RuntimeClient, options: { autoDispatch?: boolean } = {}) {
  const jobs = new Set<Promise<void>>();
  let shuttingDown = false;
  const dispatch = (run: Run) => {
    const job = (async () => {
      try {
        // Recheck visibility, grant and revisions immediately before dispatch.
        state.currentRun(run.memberId, run.id, 'read');
        const capabilities = await runtime.capabilities();
        requireCondition(capabilities.protocol === PROTOCOL_VERSION, 409, 'protocol_mismatch');
        state.currentRun(run.memberId, run.id, 'read');
        const session = await runtime.createSession(run.work);
        run.sessionId = session.sessionId;
        if (run.status === 'cancel_requested') await runtime.cancel(session.sessionId);
        else {
          state.currentRun(run.memberId, run.id, 'read');
          await runtime.submitInput(session.sessionId, { id: `${run.id}:1`, text: 'Research the authorized source message using the supplied synthetic evidence.', contextRevision: run.work.contextRevision });
        }
        const deadline = Date.now() + run.work.budget.maxDurationMs + 5000;
        while (!terminal(run.status) && !shuttingDown && Date.now() < deadline) {
          const { events } = await runtime.events(session.sessionId, run.events.length);
          for (const event of events) state.recordEvent(run, event);
          if (!terminal(run.status)) await delay(25);
        }
        if (!terminal(run.status)) { run.status = 'unknown'; run.error = 'runtime_stop_unconfirmed'; }
      } catch (error) {
        // Network errors cannot prove failure or cancellation of remote execution.
        if (error instanceof ApiError && !run.sessionId && run.status !== 'cancel_requested') {
          run.status = 'failed'; run.error = error.code;
        } else {
          run.status = 'unknown'; run.error = 'runtime_outcome_unknown';
        }
      }
    })();
    jobs.add(job); void job.finally(() => jobs.delete(job));
  };
  const service = server(async (request, response, url) => {
    if (url.pathname === '/health' && request.method === 'GET') { respond(response, 200, { service: 'control', pid: process.pid, mode: 'development-fixture' }); return; }
    const actor = state.authenticate(bearer(request));
    if (url.pathname === '/messages' && request.method === 'POST') {
      const body = await jsonBody(request);
      requireCondition(body.authorId === undefined && body.memberId === undefined, 400, 'identity_is_authenticated');
      const result = state.createMessage(actor, scopeValue(body), stringValue(body.text, 'text'), stringValue(body.clientEventId, 'clientEventId', 128));
      respond(response, result.duplicate ? 200 : 201, result);
      if (!result.duplicate && options.autoDispatch !== false) setImmediate(() => {
        try {
          if (state.evaluate(result.message)) {
            const claimed = state.claim(state.config.researchMemberId, result.message.id);
            if (!claimed.duplicate) dispatch(claimed.run);
          }
        } catch { /* Fail closed: visible chat remains accepted even if work is denied. */ }
      });
      return;
    }
    if (url.pathname === '/messages' && request.method === 'GET') {
      const scope = scopeValue(Object.fromEntries(url.searchParams));
      const runId = url.searchParams.get('runId') ?? undefined;
      respond(response, 200, { messages: state.readMessages(actor, scope, runId) }); return;
    }
    if (url.pathname === '/tools/claim' && request.method === 'POST') {
      const body = await jsonBody(request);
      requireCondition(body.intent === 'research', 400, 'unsupported_intent');
      const result = state.claim(actor, stringValue(body.sourceMessageId, 'sourceMessageId', 128));
      if (!result.duplicate && options.autoDispatch !== false) dispatch(result.run);
      respond(response, 200, result); return;
    }
    if (url.pathname === '/tools/send' && request.method === 'POST') {
      const body = await jsonBody(request);
      requireCondition(body.authorId === undefined && body.memberId === undefined && body.conversationId === undefined && body.threadId === undefined, 400, 'identity_and_route_are_bound');
      respond(response, 200, state.publish(actor, stringValue(body.runId, 'runId', 128), body.result)); return;
    }
    if (url.pathname === '/tools/request-approval' && request.method === 'POST') {
      const body = await jsonBody(request);
      respond(response, 202, state.requestApproval(actor, stringValue(body.runId, 'runId', 128), stringValue(body.action, 'action', 128), stringValue(body.reason, 'reason', 1000))); return;
    }
    if (url.pathname === '/runs' && request.method === 'GET') {
      const scope = scopeValue(Object.fromEntries(url.searchParams));
      state.authorize(actor, 'read', scope);
      respond(response, 200, { runs: [...state.runs.values()].filter(r => r.work.route.conversationId === scope.conversationId && r.work.route.threadId === scope.threadId) }); return;
    }
    const match = /^\/runs\/([^/]+)(\/cancel)?$/.exec(url.pathname);
    if (match && request.method === 'GET' && !match[2]) { respond(response, 200, state.visibleRun(actor, match[1]!)); return; }
    if (match?.[2] && request.method === 'POST') {
      const run = state.cancel(actor, match[1]!);
      // Freeze publication before the remote RPC; do not treat its acceptance as stopped.
      const receipt = run.sessionId && !terminal(run.status) ? await runtime.cancel(run.sessionId).catch(() => ({ accepted: false, stopped: false })) : { accepted: !terminal(run.status), stopped: run.status === 'stopped' };
      respond(response, 202, { status: run.status, cancellation: receipt, publishedReceiptId: run.receiptId ?? null }); return;
    }
    respond(response, 404, { error: 'not_found' });
  });
  return { service, dispatch, async drain() { await Promise.all(jobs); }, stop() { shuttingDown = true; } };
}
