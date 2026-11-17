import { requireCondition, type ResearchResult, type Source, type WorkPackage } from '../contracts.js';
import { OfflineHandbookPreparation, type OfflinePreparationDependencies } from '../research/handbook-preparation.js';
import { ControlState } from './state.js';

/** Synthetic, explicit configuration only. This is never an assertion of a fetched webpage. */
export const OFFLINE_HANDBOOK_SOURCE: Readonly<Source> = Object.freeze({
  id: 'offline-handbook-comparison',
  title: 'Synthetic Handbook comparison fixture (not fetched)',
  url: 'https://fixtures.invalid/handbook/comparison',
  excerpt: 'Fixture: type aliases can describe unions; interfaces describe object shapes.',
});
type Dependencies = Omit<OfflinePreparationDependencies, 'assertCurrent'>;

/**
 * Host-only offline harness, not an HTTP route or model tool. Keeps synthetic wire contracts.
 * All publication authority and idempotency remain in ControlState.publish.
 */
export class OfflineHandbookPublisher {
  private readonly preparation: OfflineHandbookPreparation;
  private readonly attempts = new Map<string, { work: WorkPackage; result: Promise<ResearchResult> }>();
  private sealed = false;
  constructor(private readonly state: ControlState, dependencies: Dependencies) {
    requireCondition(state.config.sources.some(source => JSON.stringify(source) === JSON.stringify(OFFLINE_HANDBOOK_SOURCE)),
      400, 'offline_handbook_fixture_not_configured');
    this.preparation = new OfflineHandbookPreparation({
      ...dependencies,
      assertCurrent: work => this.assertCurrent(work),
    });
  }
  private assertCurrent(work: WorkPackage, allowCompleted = false): void {
    const current = this.state.currentRun(work.memberId, work.runId, 'send', allowCompleted);
    requireCondition(JSON.stringify(current.work) === JSON.stringify(work), 409, 'offline_work_changed');
  }
  async publish(actorId: string, runId: string, signal?: AbortSignal) {
    const current = this.state.currentRun(actorId, runId, 'send', true);
    requireCondition(!signal?.aborted, 409, 'offline_publication_aborted');
    let attempt = this.attempts.get(runId);
    if (!attempt) {
      // A restarted bridge has no trusted preparation cache. Never rerun a recorded run.
      requireCondition(!current.receiptId, 409, 'offline_publication_already_recorded');
      requireCondition(!this.sealed, 429, 'offline_publication_capacity');
      if (this.attempts.size >= 128) { this.sealed = true; throw new Error('offline_publication_capacity'); }
      const work = structuredClone(current.work);
      const result = this.preparation.prepare(work, signal).then(prepared => {
        requireCondition(prepared.evidence === 'offline-handbook-fixture' && prepared.citations.length === 1 &&
          prepared.citations[0]!.excerpt === OFFLINE_HANDBOOK_SOURCE.excerpt, 400, 'offline_fixture_excerpt_mismatch');
        return {
          conclusion: prepared.conclusion,
          sources: [{ ...OFFLINE_HANDBOOK_SOURCE }],
          limitations: ['Offline synthetic fixture only. No live webpage or external model was consulted.'],
          evidence: 'synthetic-fixture' as const,
        };
      });
      attempt = { work, result };
      this.attempts.set(runId, attempt);
    }
    const result = await attempt.result;
    requireCondition(!signal?.aborted, 409, 'offline_publication_aborted');
    this.assertCurrent(attempt.work, true);
    // No await between current authorization and the existing synchronous atomic commit.
    // No worker-supplied URL/route/receipt metadata is accepted here.
    return this.state.publish(actorId, runId, result);
  }
}
