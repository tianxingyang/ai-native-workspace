import { randomUUID } from 'node:crypto';
import { ControlState, type ControlConfig } from '../control/state.js';
import { objectValue, requireCondition, stringValue, terminal, type Run, type RuntimeEvent, type WorkPackage } from '../contracts.js';
import { SnapshotStore } from './store.js';

interface Lease { id: string; runId: string; memberId: string; instanceId: string; expiresAt: number; cancel: boolean; finished: boolean }
interface Saved { state: ReturnType<ControlState['snapshot']>; leases: [string, Lease][] }
export interface Delivery {
  command: 'idle' | 'blocked' | 'execute' | 'cancel';
  leaseId?: string; runId?: string; work?: WorkPackage; after?: number; leaseTtlMs?: number;
}
export class PrivateEngine {
  readonly state: ControlState;
  private readonly leases = new Map<string, Lease>();
  constructor(readonly store: SnapshotStore, config: ControlConfig, readonly leaseMs = 10000, private readonly now = Date.now, restoredBackup = false) {
    requireCondition(config.credentialExpiresAt && config.members.every(m => Number.isSafeInteger(config.credentialExpiresAt![m.id]) && config.credentialExpiresAt![m.id]! > 0), 400, 'private_credential_expiry_required');
    this.state = new ControlState(config, now);
    const saved = store.load<Saved>();
    if (saved) {
      this.state.restore(saved.state);
      for (const [id, lease] of saved.leases) this.leases.set(id, lease);
      if (restoredBackup) for (const run of this.state.runs.values()) {
        if (!terminal(run.status)) { run.status = 'unknown'; run.error = 'backup_restore_reconciliation_required'; }
      }
      // Unclaimed work is safe to deliver. Leased work may already have side effects.
      for (const lease of this.leases.values()) {
        const run = this.state.runs.get(lease.runId)!;
        if (!terminal(run.status)) {
          lease.cancel = true;
          if (run.status !== 'cancel_requested') run.status = 'unknown';
          run.error = 'control_restarted_reconciliation_required';
        }
      }
      this.store.save(this.snapshot());
    }
  }
  private snapshot(): Saved { return { state: this.state.snapshot(), leases: structuredClone([...this.leases]) }; }
  commit<T>(operation: () => T): T {
    const before = this.snapshot();
    try {
      const value = operation();
      if (this.state.audit.length > 1000) this.state.audit.splice(0, this.state.audit.length - 1000);
      requireCondition(this.state.messages.size <= 5000 && this.state.runs.size <= 1000, 507, 'trial_capacity_reached');
      this.store.save(this.snapshot());
      return value;
    } catch (error) {
      this.state.restore(before.state); this.leases.clear();
      for (const [id, lease] of before.leases) this.leases.set(id, lease);
      throw error;
    }
  }
  sweep(): void {
    for (const lease of this.leases.values()) {
      const run = this.state.runs.get(lease.runId)!;
      if (!lease.finished && !terminal(run.status) && lease.expiresAt <= this.now()) {
        lease.cancel = true; run.status = 'unknown'; run.error = 'lease_expired_reconciliation_required';
      }
    }
  }
  private agent(actor: string): void {
    requireCondition(this.state.config.members.find(m => m.id === actor)?.kind === 'agent', 403, 'worker_identity_required');
  }
  poll(actor: string, instanceId: string): Delivery {
    this.agent(actor);
    const actions = ['read', 'send', 'claim', 'request_approval'] as const;
    const grant = this.state.config.grants.find(g => g.memberId === actor && !g.revoked && g.expiresAt > this.now()
      && actions.every(action => g.actions.includes(action))
      && this.state.config.memberships[actor]?.some(s => s.conversationId === g.conversationId && s.threadId === g.threadId));
    requireCondition(grant, 403, 'worker_poll_denied');
    this.state.authorize(actor, 'claim', grant, grant);
    this.sweep();
    const held = [...this.leases.values()].find(l => l.memberId === actor && !l.finished);
    if (held) {
      const run = this.state.runs.get(held.runId)!;
      this.state.authorizeRunGrant(actor, run, [...actions]);
      if (held.instanceId !== instanceId) return { command: 'blocked' };
      if (!held.cancel) {
        try { this.state.currentRun(actor, run.id, 'claim'); }
        catch { held.cancel = true; if (!terminal(run.status)) { run.status = 'unknown'; run.error = 'work_no_longer_authorized'; } }
      }
      held.expiresAt = this.now() + this.leaseMs;
      if (held.cancel || run.status === 'cancel_requested' || run.status === 'unknown') {
        return { command: 'cancel', leaseId: held.id, runId: run.id, after: run.events.length, leaseTtlMs: this.leaseMs };
      }
      return { command: 'execute', leaseId: held.id, runId: run.id, work: run.work, after: run.events.length, leaseTtlMs: this.leaseMs };
    }
    for (const run of this.state.runs.values()) {
      if (run.memberId !== actor || run.status !== 'queued' || [...this.leases.values()].some(l => l.runId === run.id)) continue;
      try { this.state.currentRun(actor, run.id, 'claim'); }
      catch { run.status = 'failed'; run.error = 'dispatch_authorization_denied'; continue; }
      const lease: Lease = { id: randomUUID(), runId: run.id, memberId: actor, instanceId, expiresAt: this.now() + this.leaseMs, cancel: false, finished: false };
      this.leases.set(lease.id, lease);
      return { command: 'execute', leaseId: lease.id, runId: run.id, work: run.work, after: 0, leaseTtlMs: this.leaseMs };
    }
    return { command: 'idle' };
  }
  private owned(actor: string, instanceId: string, leaseId: string): Lease {
    this.agent(actor);
    const lease = this.leases.get(leaseId);
    requireCondition(lease && lease.memberId === actor && lease.instanceId === instanceId, 403, 'lease_denied');
    return lease;
  }
  guardTool(actor: string, instanceId: string, leaseId: string, runId: string): void {
    this.sweep();
    const lease = this.owned(actor, instanceId, leaseId);
    requireCondition(lease.runId === runId && !lease.finished && !lease.cancel && lease.expiresAt > this.now(), 409, 'lease_not_executable');
  }
  cancel(actor: string, runId: string) {
    const priorStatus = this.state.runs.get(runId)?.status;
    const run = this.state.cancel(actor, runId);
    const lease = [...this.leases.values()].find(l => l.runId === run.id);
    if (!terminal(run.status)) {
      if (lease) lease.cancel = true;
      else if (priorStatus === 'unknown') { run.status = 'unknown'; run.error = 'missing_execution_history'; }
      else { run.status = 'stopped'; run.stopEvidence = { scope: 'runtime_session_not_created', executionStarted: false }; }
    }
    return { status: run.status, publishedReceiptId: run.receiptId ?? null };
  }
  notStarted(actor: string, instanceId: string, leaseId: string) {
    const lease = this.owned(actor, instanceId, leaseId), run = this.state.runs.get(lease.runId)!;
    this.state.authorizeRunGrant(actor, run, ['claim', 'send', 'request_approval']);
    requireCondition(lease.cancel && !run.sessionId && run.events.length === 0 && !run.receiptId, 409, 'cannot_confirm_not_started');
    run.status = 'stopped'; run.stopEvidence = { scope: 'worker_acknowledged_not_started', executionStarted: false };
    delete run.error; lease.finished = true;
    return { status: run.status };
  }
  ingest(actor: string, instanceId: string, leaseId: string, rawEvents: unknown) {
    const lease = this.owned(actor, instanceId, leaseId), run = this.state.runs.get(lease.runId)!;
    this.state.authorizeRunGrant(actor, run, ['claim', 'send', 'request_approval']);
    this.sweep();
    requireCondition(Array.isArray(rawEvents) && rawEvents.length <= 32, 400, 'invalid_events');
    for (const raw of rawEvents) {
      const e = objectValue(raw);
      stringValue(e.id, 'event_id', 200); stringValue(e.sessionId, 'session_id', 128);
      requireCondition(e.runId === run.id && Number.isInteger(e.sequence) && Number(e.sequence) > 0 && Number(e.sequence) <= 256 && Number.isFinite(e.at), 409, 'event_binding_mismatch');
      requireCondition(['input_received', 'input_applied', 'status', 'output', 'approval_requested', 'stopped', 'failed'].includes(String(e.kind)), 400, 'invalid_event_kind');
      requireCondition(['queued', 'running', 'cancel_requested', 'completed', 'failed', 'stopped', 'unknown'].includes(String(e.status)), 400, 'invalid_event_status');
      objectValue(e.data);
      const event = e as unknown as RuntimeEvent;
      const duplicate = run.events.find(previous => previous.id === event.id);
      if (duplicate) { requireCondition(JSON.stringify(duplicate) === JSON.stringify(event), 409, 'event_conflict'); continue; }
      if (!run.sessionId) run.sessionId = event.sessionId;
      const previousStatus = run.status;
      this.state.recordEvent(run, event);
      if (lease.cancel && !terminal(run.status)) run.status = previousStatus === 'unknown' ? 'unknown' : 'cancel_requested';
      if (terminal(run.status)) { lease.finished = true; if (run.status !== 'failed') delete run.error; }
    }
    return { after: run.events.length, status: run.status };
  }
}
