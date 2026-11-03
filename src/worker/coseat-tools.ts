import type { Message, ResearchResult, Run, WorkPackage } from '../contracts.js';
import { requireCondition } from '../contracts.js';
import { requestJson } from '../http.js';

/** Execution-side API client. No control state, database or administrator credentials. */
export class CoSeatTools {
  receiptId: string | undefined;
  readonly calls: string[] = [];
  constructor(
    private readonly baseUrl: string,
    private readonly memberToken: string,
    readonly work: WorkPackage,
    private readonly signal: AbortSignal,
    private readonly onApproval: (value: Record<string, unknown>) => void,
    private readonly headers: Record<string, string> = {},
  ) {}
  private before(name: string) {
    this.signal.throwIfAborted();
    requireCondition(this.calls.length < this.work.budget.maxToolCalls, 429, 'tool_budget_exceeded');
    this.calls.push(name);
  }
  async readMessages(): Promise<Message[]> {
    this.before('read_messages');
    const query = new URLSearchParams({ ...this.work.route, runId: this.work.runId });
    const value = await requestJson<{ messages: Message[] }>(this.baseUrl, this.memberToken, `/messages?${query}`, undefined, this.signal, this.headers);
    return value.messages;
  }
  async claimTask(): Promise<{ runId: string; duplicate: boolean }> {
    this.before('claim_task');
    const value = await requestJson<{ run: Run; duplicate: boolean }>(this.baseUrl, this.memberToken, '/tools/confirm-claim', { runId: this.work.runId, sourceMessageId: this.work.source.messageId, sourceRevision: this.work.source.revision }, this.signal, this.headers);
    requireCondition(value.run.id === this.work.runId, 409, 'claim_binding_mismatch');
    return { runId: value.run.id, duplicate: value.duplicate };
  }
  async sendMessage(result: ResearchResult) {
    this.before('send_message');
    const value = await requestJson<{ receiptId: string; duplicate: boolean; message: Message }>(this.baseUrl, this.memberToken, '/tools/send', { runId: this.work.runId, result }, this.signal, this.headers);
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
