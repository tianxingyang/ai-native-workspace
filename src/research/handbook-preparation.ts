import { validateWork, type Scope, type WorkPackage } from '../contracts.js';
import { EvidenceLedger, EVIDENCE_TEXT_LIMIT, type EvidenceBinding, type EvidenceClaim, type EvidenceReceipt } from './evidence-ledger.js';
import { collectHandbook, HANDBOOK_DOCUMENT, type HandbookRuntime } from './handbook-collector.js';

/** This opt-in seam accepts only host-owned offline doubles. No production factory exists. */
export interface OfflinePreparationDependencies {
  mode: 'offline-fixture';
  transport: HandbookRuntime;
  /** Pure local extraction; HTML is data, never rendered or executed. */
  extractText(document: string): string;
  /** Check current controller read/send grants, source/context revisions and run status. */
  assertCurrent(work: WorkPackage): void;
  /** Local mock only. Receives public fixture text, never tenant conversation/work identifiers. */
  model(input: Readonly<{ text: string; receiptId: string }>, signal: AbortSignal): Promise<unknown>;
}
export interface PendingHandbookEvidence {
  state: 'prepared-not-published';
  evidence: 'offline-handbook-fixture';
  binding: EvidenceBinding;
  route: Scope;
  conclusion: string;
  citations: Array<EvidenceReceipt & { excerpt: string }>;
}
function bindingFor(work: WorkPackage): EvidenceBinding {
  return { taskId: work.taskId, runId: work.runId, sourceMessageId: work.source.messageId,
    sourceRevision: work.source.revision, contextRevision: work.contextRevision };
}
/**
 * No publisher, model tools or default network transport. Prepared output is not ResearchResult
 * and cannot pass ControlState.publish. Revalidate atomically at any future publication boundary.
 */
export class OfflineHandbookPreparation {
  private readonly ledger = new EvidenceLedger([HANDBOOK_DOCUMENT]);
  private readonly attempted = new Set<string>();
  private sealed = false;
  constructor(private readonly dependencies: OfflinePreparationDependencies) {
    if (dependencies.mode !== 'offline-fixture') throw new Error('offline_mode_required');
  }
  async prepare(rawWork: WorkPackage, signal?: AbortSignal): Promise<PendingHandbookEvidence> {
    const work = structuredClone(rawWork);
    validateWork(work);
    const binding = bindingFor(work);
    if (this.sealed || this.attempted.has(work.runId)) throw new Error('preparation_attempt_denied');
    if (this.attempted.size >= 128) { this.sealed = true; throw new Error('preparation_capacity'); }
    this.attempted.add(work.runId);
    const controller = new AbortController();
    const abort = () => { this.ledger.revokeRun(work.runId); controller.abort(); };
    const check = () => {
      if (controller.signal.aborted) throw new Error('preparation_aborted');
      // Never expose the binding snapshot to mutation by an injected admission function.
      this.dependencies.assertCurrent(structuredClone(work));
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(abort, Math.min(work.budget.maxDurationMs, 8000));
    let rejectAbort!: (error: Error) => void;
    const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
    const onAbort = () => rejectAbort(new Error('preparation_aborted'));
    controller.signal.addEventListener('abort', onAbort, { once: true });
    const execute = async (): Promise<PendingHandbookEvidence> => {
      check();
      const document = await collectHandbook(this.dependencies.transport, { signal: controller.signal });
      check();
      const text = this.dependencies.extractText(document.utf8);
      if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > EVIDENCE_TEXT_LIMIT) throw new Error('invalid_extracted_text');
      check();
      const receipt = this.ledger.record(binding, HANDBOOK_DOCUMENT, text);
      const proposal = await this.dependencies.model(Object.freeze({ text, receiptId: receipt.receiptId }), controller.signal);
      check();
      if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) throw new Error('invalid_proposal');
      const value = proposal as Record<string, unknown>;
      if (Object.keys(value).sort().join(',') !== 'claims,conclusion' ||
          typeof value.conclusion !== 'string' || !value.conclusion.trim() || value.conclusion.length > 8000 ||
          !Array.isArray(value.claims)) throw new Error('invalid_proposal');
      const citations = this.ledger.verify(binding, value.claims as EvidenceClaim[]);
      check();
      return { state: 'prepared-not-published', evidence: 'offline-handbook-fixture', binding,
        route: { ...work.route }, conclusion: value.conclusion, citations };
    };
    try { return await Promise.race([execute(), aborted]); }
    finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      controller.signal.removeEventListener('abort', onAbort);
      // One preparation attempt per run, including failed/late attempts. Never reopen receipts.
      this.ledger.revokeRun(work.runId);
      controller.abort();
    }
  }
}
