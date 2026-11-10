import type { ClaimConfirmation, Message, ResearchResult, WorkPackage } from '../contracts.js';
import { objectValue, requireCondition, resultValue } from '../contracts.js';
import { isDeepStrictEqual } from 'node:util';
import { requestJson } from '../http.js';
import { frozenSnapshot, validateWorkerWork } from './context-compiler.js';

/** Execution-side API client. No control state, database or administrator credentials. */
export class CoSeatTools {
  receiptId: string | undefined;
  readonly calls: string[] = [];
  readonly work: WorkPackage;
  private readonly deadlineAt: number;
  constructor(
    private readonly baseUrl: string,
    private readonly memberToken: string,
    work: WorkPackage,
    private readonly signal: AbortSignal,
    private readonly onApproval: (value: Record<string, unknown>) => void,
    private readonly headers: Record<string, string> = {},
    private readonly sessionId?: string,
  ) {
    this.work = frozenSnapshot(work);
    this.deadlineAt = Date.now() + work.budget.maxDurationMs;
  }
  assertActive(): void {
    this.signal.throwIfAborted();
    validateWorkerWork(this.work);
    requireCondition(Date.now() < this.deadlineAt, 408, 'runtime_budget_exceeded');
  }
  private before(name: string) {
    this.assertActive();
    requireCondition(this.work.tools.includes(name as WorkPackage['tools'][number]), 403, 'tool_not_allowed');
    requireCondition(this.calls.length < this.work.budget.maxToolCalls, 429, 'tool_budget_exceeded');
    this.calls.push(name);
  }
  async readMessages(): Promise<Message[]> {
    this.before('read_messages');
    const query = new URLSearchParams({ ...this.work.route, runId: this.work.runId });
    const value = await requestJson<{ messages: Message[] }>(this.baseUrl, this.memberToken, `/messages?${query}`, undefined, this.signal, this.headers);
    return value.messages;
  }
  private async confirmClaim(): Promise<ClaimConfirmation> {
    this.before('claim_task');
    const value = await requestJson<ClaimConfirmation>(this.baseUrl, this.memberToken, '/tools/confirm-claim', { runId: this.work.runId, sourceMessageId: this.work.source.messageId, sourceRevision: this.work.source.revision }, this.signal, this.headers);
    objectValue(value); objectValue(value.run);
    requireCondition(value.run.id === this.work.runId && value.run.taskId === this.work.taskId
      && value.run.memberId === this.work.memberId && value.run.sourceMessageId === this.work.source.messageId
      && isDeepStrictEqual(value.run.work, this.work), 409, 'claim_binding_mismatch');
    const execution = value.execution;
    requireCondition(execution && Number.isSafeInteger(execution.toolCalls) && execution.toolCalls > 0
      && execution.toolCalls <= this.work.budget.maxToolCalls
      && (execution.publishedReceiptId === null || (typeof execution.publishedReceiptId === 'string' && execution.publishedReceiptId.length > 0))
      && (execution.sessionId === null || (typeof execution.sessionId === 'string' && execution.sessionId.length > 0))
      && execution.publishedReceiptId === (value.run.receiptId ?? null)
      && execution.sessionId === (value.run.sessionId ?? null), 409, 'missing_execution_state');
    requireCondition(value.duplicate === true && (['queued', 'running'].includes(value.run.status)
      || (value.run.status === 'completed' && execution.publishedReceiptId !== null))
      && !value.run.invalidatedBy && !value.run.contextInvalidated, 409, 'run_not_active');
    this.assertActive();
    return value;
  }
  /** Reuse this tool client's deadline and counters across provider initialization.
   * A different session or unmatched control ledger cannot be safely replayed. */
  async prepareExecution(): Promise<void> {
    const value = await this.confirmClaim();
    if (value.execution.publishedReceiptId !== null) {
      this.receiptId = value.execution.publishedReceiptId;
      requireCondition(false, 409, 'publication_already_recorded');
    }
    requireCondition(this.sessionId && (value.execution.sessionId === null || value.execution.sessionId === this.sessionId), 409, 'provider_session_mismatch');
    requireCondition(value.execution.toolCalls === this.calls.length, 409, 'execution_history_not_empty');
  }
  async claimTask(): Promise<{ runId: string; duplicate: boolean }> {
    const value = await this.confirmClaim();
    return { runId: value.run.id, duplicate: value.duplicate };
  }
  async sendMessage(result: ResearchResult) {
    this.before('send_message');
    const value = await requestJson<{ receiptId: string; duplicate: boolean; message: Message }>(this.baseUrl, this.memberToken, '/tools/send', { runId: this.work.runId, result: resultValue(result) }, this.signal, this.headers);
    this.receiptId = value.receiptId;
    return value;
  }
  async requestApproval(action: string, reason: string) {
    this.before('request_approval');
    const value = await requestJson<{ id: string; status: 'pending' }>(this.baseUrl, this.memberToken, '/tools/request-approval', { runId: this.work.runId, action, reason }, this.signal, this.headers);
    this.onApproval(value);
    return value;
  }
}
