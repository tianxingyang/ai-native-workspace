import { setTimeout as delay } from 'node:timers/promises';
import { ApiError, PROTOCOL_VERSION, requireCondition, scopeValue, stringValue, terminal, type CancelReceipt, type Run } from '../contracts.js';
import { bearer, jsonBody, respond, server } from '../http.js';
import { ControlState } from './state.js';
import { RuntimeClient } from './runtime-client.js';

export function controlService(state: ControlState, runtime: RuntimeClient, options: { autoDispatch?: boolean; cancellationReconcileMs?: number } = {}) {
  const jobs = new Set<Promise<void>>();
  const creatingSessions = new Set<string>();
  const pollers = new Map<string, Promise<void>>();
  const reads = new Map<string, Promise<void>>();
  const cancellations = new Map<string, Promise<CancelReceipt>>();
  const cancellationDeadlines = new Map<string, number>();
  const cancellationReconcileMs = options.cancellationReconcileMs ?? 5000;
  requireCondition(Number.isInteger(cancellationReconcileMs) && cancellationReconcileMs >= 25 && cancellationReconcileMs <= 60000, 500, 'invalid_cancellation_reconcile_budget');
  let shuttingDown = false;
  const readEvents = (run: Run): Promise<void> => {
    const prior = reads.get(run.id);
    if (prior) return prior;
    const read = (async () => {
      const { events } = await runtime.events(run.sessionId!, run.events.length);
      for (const event of events) state.recordEvent(run, event);
      if (terminal(run.status)) delete run.error;
      if (options.autoDispatch !== false) for (const replacement of state.rebuildInvalidated()) dispatch(replacement);
    })().finally(() => reads.delete(run.id));
    reads.set(run.id, read);
    return read;
  };
  const cancelOnce = (run: Run): Promise<CancelReceipt> => {
    const prior = cancellations.get(run.id);
    if (prior) return prior;
    // Retain even an uncertain response: reconciliation only reads; it never replays cancellation.
    const request = runtime.cancel(run.sessionId!).catch(() => ({ accepted: false, stopped: false }));
    cancellations.set(run.id, request);
    return request;
  };
  const ensurePolling = (run: Run): Promise<void> => {
    const prior = pollers.get(run.id);
    if (prior) return prior;
    const ordinaryDeadline = Date.now() + run.work.budget.maxDurationMs + 5000;
    const job = (async () => {
      while (!terminal(run.status) && !shuttingDown && Date.now() < (cancellationDeadlines.get(run.id) ?? ordinaryDeadline)) {
        try { await readEvents(run); }
        catch {
          if (!cancellationDeadlines.has(run.id)) {
            run.status = 'unknown'; run.error = 'runtime_outcome_unknown'; return;
          }
          // Cancellation remains fenced while bounded read-only retries seek actual stop evidence.
        }
        if (!terminal(run.status)) await delay(25);
      }
      if (!terminal(run.status)) { run.status = 'unknown'; run.error = 'runtime_stop_unconfirmed'; }
    })().finally(() => { pollers.delete(run.id); jobs.delete(job); });
    pollers.set(run.id, job); jobs.add(job);
    return job;
  };
  const dispatch = (run: Run) => {
    const job = (async () => {
      try {
        // Accepted new messages remain queued while an old context is unconfirmed.
        while (state.contextBlocked(run) && !terminal(run.status) && !shuttingDown) await delay(25);
        if (terminal(run.status) || shuttingDown) return;
        // Recheck visibility, grant and revisions immediately before dispatch.
        state.currentRun(run.memberId, run.id, 'read');
        const capabilities = await runtime.capabilities();
        if (terminal(run.status)) return;
        requireCondition(capabilities.protocol === PROTOCOL_VERSION, 409, 'protocol_mismatch');
        state.currentRun(run.memberId, run.id, 'read');
        creatingSessions.add(run.id);
        const session = await runtime.createSession(run.work);
        run.sessionId = session.sessionId;
        creatingSessions.delete(run.id);
        if (run.status === 'cancel_requested') await cancelOnce(run);
        else {
          state.currentRun(run.memberId, run.id, 'read');
          await runtime.submitInput(session.sessionId, { id: `${run.id}:1`, text: 'Research the authorized source message using the supplied synthetic evidence.', contextRevision: run.work.contextRevision });
        }
        await ensurePolling(run);
      } catch (error) {
        if (terminal(run.status)) return;
        // Network errors cannot prove failure or cancellation of remote execution.
        if (error instanceof ApiError && !run.sessionId && !creatingSessions.has(run.id) && run.status !== 'cancel_requested') {
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
    if (url.pathname === '/attachments' && request.method === 'GET') {
      respond(response, 200, state.readAttachment(actor, scopeValue(Object.fromEntries(url.searchParams)), stringValue(url.searchParams.get('messageId'), 'messageId', 128),
        stringValue(url.searchParams.get('expectedMembershipGeneration'), 'membership_generation', 128), url.searchParams.get('runId') ?? undefined)); return;
    }
    if (url.pathname === '/sync' && request.method === 'GET') {
      respond(response, 200, state.syncScope(actor, scopeValue(Object.fromEntries(url.searchParams)), url.searchParams.get('cursor') ?? undefined)); return;
    }
    if (url.pathname === '/messages/receipt' && request.method === 'GET') {
      const scope = scopeValue(Object.fromEntries(url.searchParams));
      respond(response, 200, { message: state.messageReceipt(actor, scope, stringValue(url.searchParams.get('clientEventId'), 'clientEventId', 128)) }); return;
    }
    if (url.pathname === '/messages/change-receipt' && request.method === 'GET') {
      const scope = scopeValue(Object.fromEntries(url.searchParams));
      respond(response, 200, { receipt: state.messageChangeReceipt(actor, scope, stringValue(url.searchParams.get('clientEventId'), 'clientEventId', 128)) }); return;
    }
    if (url.pathname === '/read-position' && request.method === 'POST') {
      const body = await jsonBody(request);
      state.authenticate(bearer(request));
      requireCondition(body.authorId === undefined && body.memberId === undefined, 400, 'identity_is_authenticated');
      respond(response, 200, state.advanceReadPosition(actor, scopeValue(body), stringValue(body.messageId, 'messageId', 128))); return;
    }
    const changeMatch = /^\/messages\/([^/]+)\/(edit|retract)$/.exec(url.pathname);
    if (changeMatch && request.method === 'POST') {
      const body = await jsonBody(request);
      state.authenticate(bearer(request));
      requireCondition(body.authorId === undefined && body.memberId === undefined, 400, 'identity_is_authenticated');
      const result = state.changeMessage(actor, changeMatch[1]!, changeMatch[2] as 'edit' | 'retract',
        body.expectedRevision as number, stringValue(body.clientEventId, 'clientEventId', 128),
        changeMatch[2] === 'edit' ? stringValue(body.text, 'text') : undefined);
      if (!result.duplicate) for (const id of result.change.affectedRunIds) {
        const run = state.runs.get(id)!;
        if (!run.sessionId && !creatingSessions.has(id) && run.status !== 'unknown') {
          run.status = 'stopped'; run.stopEvidence = { scope: 'runtime_session_not_created', executionStarted: false };
        } else {
          cancellationDeadlines.set(id, Date.now() + cancellationReconcileMs);
          if (run.sessionId) { void cancelOnce(run); void ensurePolling(run); }
        }
      }
      if (options.autoDispatch !== false) for (const replacement of state.rebuildInvalidated()) dispatch(replacement);
      respond(response, 200, result); return;
    }
    if (url.pathname === '/messages' && request.method === 'POST') {
      const body = await jsonBody(request);
      requireCondition(body.authorId === undefined && body.memberId === undefined, 400, 'identity_is_authenticated');
      const result = state.createMessage(actor, scopeValue(body), stringValue(body.text, 'text'), stringValue(body.clientEventId, 'clientEventId', 128),
        body.replyToMessageId === undefined ? undefined : stringValue(body.replyToMessageId, 'replyToMessageId', 128), body.expectedMembershipGeneration, body.attachment);
      respond(response, result.duplicate ? 200 : 201, result);
      if (!result.duplicate && options.autoDispatch !== false) setImmediate(() => {
        try {
          if (state.evaluate(state.messages.get(result.message.id)!)) {
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
      respond(response, 200, { messages: state.readMessages(actor, scope, runId), readThroughMessageId: state.readPosition(actor, scope) }); return;
    }
    if (url.pathname === '/tools/claim' && request.method === 'POST') {
      const body = await jsonBody(request);
      requireCondition(body.intent === 'research', 400, 'unsupported_intent');
      const result = state.claim(actor, stringValue(body.sourceMessageId, 'sourceMessageId', 128));
      if (!result.duplicate && options.autoDispatch !== false) dispatch(result.run);
      respond(response, 200, result); return;
    }
    if (url.pathname === '/tools/confirm-claim' && request.method === 'POST') {
      const body = await jsonBody(request);
      requireCondition(Number.isInteger(body.sourceRevision) && Number(body.sourceRevision) > 0, 400, 'invalid_source_revision');
      respond(response, 200, state.confirmClaim(actor, stringValue(body.runId, 'runId', 128), stringValue(body.sourceMessageId, 'sourceMessageId', 128), Number(body.sourceRevision))); return;
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
      respond(response, 200, { runs: [...state.runs.values()].filter(r => r.work.route.conversationId === scope.conversationId && r.work.route.threadId === scope.threadId).map(run => state.presentRun(run)) }); return;
    }
    const match = /^\/runs\/([^/]+)(\/cancel)?$/.exec(url.pathname);
    if (match && request.method === 'GET' && !match[2]) { respond(response, 200, state.visibleRun(actor, match[1]!)); return; }
    if (match?.[2] && request.method === 'POST') {
      const run = state.cancel(actor, match[1]!);
      const stoppedBeforeSession = !run.sessionId && !creatingSessions.has(run.id) && !terminal(run.status);
      if (stoppedBeforeSession) {
        run.status = 'stopped';
        run.stopEvidence = { scope: 'runtime_session_not_created', executionStarted: false };
      }
      if (!terminal(run.status) && !cancellationDeadlines.has(run.id)) cancellationDeadlines.set(run.id, Date.now() + cancellationReconcileMs);
      // Freeze publication before the remote RPC; do not treat its acceptance as stopped.
      const receipt = run.sessionId && !terminal(run.status) ? await cancelOnce(run) : { accepted: stoppedBeforeSession || !terminal(run.status), stopped: run.status === 'stopped' };
      if (run.sessionId && !terminal(run.status)) {
        try { await readEvents(run); } catch { /* Bounded reconciliation below owns further reads. */ }
        if (!terminal(run.status)) void ensurePolling(run);
      }
      const cancellationOutcome = run.stopEvidence ? 'stopped_before_session' : run.status === 'completed' ? 'too_late_completed' : run.status === 'stopped' ? 'stopped' : run.status === 'failed' ? 'already_failed' : 'unconfirmed';
      respond(response, 202, { status: run.status, cancellation: receipt, cancellationOutcome, stopEvidence: run.stopEvidence ?? null, publishedReceiptId: run.receiptId ?? null }); return;
    }
    respond(response, 404, { error: 'not_found' });
  });
  return { service, dispatch, async drain() { await Promise.all(jobs); }, stop() { shuttingDown = true; } };
}
