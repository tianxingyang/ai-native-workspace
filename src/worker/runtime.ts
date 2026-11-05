import { randomUUID } from 'node:crypto';
import { ApiError, PROTOCOL_VERSION, requireCondition, terminal, type CheckpointRef, type RuntimeCapabilities, type RuntimeEvent, type RuntimeInput, type RuntimeProvider, type RunStatus, type WorkPackage } from '../contracts.js';
import { CoSeatTools } from './coseat-tools.js';
import { ContextCompiler, frozenSnapshot, validateWorkerWork } from './context-compiler.js';

/** Providers acknowledge only when the input has actually entered their execution context. */
export type Execute = (work: WorkPackage, input: RuntimeInput, tools: CoSeatTools, signal: AbortSignal, output: (data: Record<string, unknown>) => void, onInputApplied: () => void) => Promise<void>;
interface Session {
  id: string; work: WorkPackage; status: RunStatus; events: RuntimeEvent[];
  abort: AbortController; input?: RuntimeInput; completion?: Promise<void>; cancelRequested: boolean;
}
/** Shared protocol lifecycle; harness-specific execution remains a small function. */
export class LocalRuntime implements RuntimeProvider {
  private readonly sessions = new Map<string, Session>();
  private readonly compiler = new ContextCompiler();
  constructor(private readonly config: { provider: string; version: string; memberId: string; controlUrl: string; memberToken: string; execute: Execute; toolHeaders?: Record<string, string> }) {}
  capabilities(): RuntimeCapabilities {
    return { protocol: PROTOCOL_VERSION, provider: this.config.provider, providerVersion: this.config.version, appendInput: false, pause: false, resume: false, checkpoint: false, cancellation: 'cooperative' };
  }
  async createSession(work: WorkPackage) {
    work = this.compiler.bind(work);
    requireCondition(work.memberId === this.config.memberId, 403, 'worker_member_mismatch');
    const prior = [...this.sessions.values()].find(s => s.work.runId === work.runId);
    if (prior) {
      requireCondition(JSON.stringify(prior.work) === JSON.stringify(work), 409, 'session_conflict');
      return { sessionId: prior.id };
    }
    const id = randomUUID();
    this.sessions.set(id, { id, work, status: 'queued', events: [], abort: new AbortController(), cancelRequested: false });
    return { sessionId: id };
  }
  private session(id: string): Session {
    const s = this.sessions.get(id); requireCondition(s, 404, 'session_not_found'); return s;
  }
  private emit(s: Session, kind: RuntimeEvent['kind'], data: Record<string, unknown> = {}) {
    s.events.push({ id: `${s.id}:${s.events.length + 1}`, sequence: s.events.length + 1, sessionId: s.id, runId: s.work.runId, kind, status: s.status, at: Date.now(), data });
  }
  async submitInput(id: string, input: RuntimeInput) {
    const s = this.session(id);
    requireCondition(typeof input.id === 'string' && input.id.length > 0 && typeof input.text === 'string' && input.text.length > 0 && input.text.length <= 8000, 400, 'invalid_input');
    if (s.input?.id === input.id) {
      requireCondition(JSON.stringify(s.input) === JSON.stringify(input), 409, 'input_conflict');
      return { accepted: true };
    }
    requireCondition(s.status === 'queued' && !s.input, 409, 'append_input_not_supported');
    requireCondition(input.contextRevision === s.work.contextRevision, 409, 'context_revision_changed');
    input = frozenSnapshot(input);
    s.input = input;
    this.emit(s, 'input_received', { inputId: input.id, contextRevision: s.work.contextRevision });
    // The RPC acknowledges receipt; only the provider can acknowledge application.
    s.completion = new Promise<void>(resolve => setImmediate(resolve)).then(async () => {
      if (s.cancelRequested) return;
      s.status = 'running'; this.emit(s, 'status');
      let inputApplied = false;
      let executionSettled = false;
      const onInputApplied = () => {
        // Cancellation is cooperative: application that races the request is
        // still evidence and must not be hidden by the aborted signal.
        if (inputApplied || executionSettled) return;
        inputApplied = true;
        this.emit(s, 'input_applied', { inputId: input.id, contextRevision: s.work.contextRevision });
      };
      let budgetExpired = false;
      const timer = setTimeout(() => { budgetExpired = true; s.abort.abort(new Error('runtime_budget_exceeded')); }, s.work.budget.maxDurationMs);
      const tools = new CoSeatTools(this.config.controlUrl, this.config.memberToken, s.work, s.abort.signal, value => this.emit(s, 'approval_requested', value), this.config.toolHeaders);
      try {
        const context = this.compiler.compile(s.work, input, s.abort.signal);
        // Confirm live control authority and exact bindings before any provider
        // starts. This budgeted call does not acknowledge input application.
        await tools.claimTask();
        s.abort.signal.throwIfAborted();
        validateWorkerWork(context.work);
        await this.config.execute(context.work, context.input, tools, s.abort.signal, value => this.emit(s, 'output', value), onInputApplied);
        requireCondition(Boolean(tools.receiptId), 409, 'no_publication_receipt');
        if (!s.cancelRequested && !budgetExpired) {
          s.status = 'completed'; this.emit(s, 'status', { receiptId: tools.receiptId, tools: tools.calls });
        }
      } catch (error) {
        if (!s.cancelRequested) {
          s.status = 'failed'; this.emit(s, 'failed', { code: error instanceof ApiError ? error.code : 'execution_failed' });
        }
      } finally {
        executionSettled = true;
        clearTimeout(timer);
        if (s.cancelRequested) {
          s.status = 'stopped';
          this.emit(s, 'stopped', { executionSettled: true, scope: 'provider_task_and_awaited_tools', receiptId: tools.receiptId ?? null });
        } else if (budgetExpired && s.status !== 'failed') {
          s.status = 'failed'; this.emit(s, 'failed', { code: 'runtime_budget_exceeded' });
        }
      }
    });
    return { accepted: true };
  }
  status(id: string) { return { status: this.session(id).status }; }
  events(id: string, after: number) {
    requireCondition(Number.isInteger(after) && after >= 0, 400, 'invalid_event_cursor');
    return structuredClone(this.session(id).events.filter(e => e.sequence > after));
  }
  cancel(id: string) {
    const s = this.session(id);
    if (terminal(s.status)) return { accepted: false, stopped: s.status === 'stopped' };
    s.cancelRequested = true;
    const started = s.status === 'running' || s.status === 'cancel_requested';
    s.status = 'cancel_requested'; this.emit(s, 'status', { cancellationReceived: true });
    s.abort.abort(new Error('cancel_requested'));
    if (!started) { s.status = 'stopped'; this.emit(s, 'stopped', { executionSettled: true, scope: 'input_not_started' }); }
    return { accepted: true, stopped: !started };
  }
  appendInput(_id: string, _input: RuntimeInput): never { throw new ApiError(501, 'append_input_not_supported'); }
  pause(_id: string): never { throw new ApiError(501, 'pause_not_supported'); }
  resume(_ref: CheckpointRef): never { throw new ApiError(501, 'resume_not_supported'); }
  async close() {
    for (const s of this.sessions.values()) if (!terminal(s.status)) this.cancel(s.id);
    await Promise.all([...this.sessions.values()].map(s => s.completion));
  }
}
