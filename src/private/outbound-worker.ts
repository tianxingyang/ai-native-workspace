import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { requireCondition, terminal } from '../contracts.js';
import { requestJson } from '../http.js';
import { LocalRuntime, type Execute } from '../worker/runtime.js';
import type { PrivateWorkerConfig } from './config.js';
import type { Delivery } from './engine.js';

interface Active { leaseId: string; runId: string; runtime: LocalRuntime; sessionId: string; after: number; cancelled: boolean; watchdog?: ReturnType<typeof setTimeout> }
/** Outbound-only transport. No HTTP server or listening socket on the execution device. */
export class OutboundWorker {
  readonly instanceId = randomUUID();
  private active: Active | undefined;
  private readonly seen = new Map<string, Active>();
  private readonly noStart = new Set<string>();
  private readonly stopSignal = new AbortController();
  private stepping = false;
  constructor(readonly config: PrivateWorkerConfig, private readonly execute: Execute) {}
  private cancel(active: Active) {
    if (!active.cancelled && !terminal(active.runtime.status(active.sessionId).status)) {
      active.cancelled = true; active.runtime.cancel(active.sessionId);
    }
  }
  private async flush(active: Active): Promise<void> {
    const events = active.runtime.events(active.sessionId, active.after).slice(0, 16);
    if (events.length === 0) return;
    const response = await requestJson<{ after: number; status: string }>(this.config.controlUrl, this.config.token, '/worker/events', { instanceId: this.instanceId, leaseId: active.leaseId, events });
    requireCondition(Number.isInteger(response.after) && response.after >= active.after && response.after <= active.runtime.events(active.sessionId, 0).length, 409, 'invalid_ack');
    active.after = response.after;
    if (terminal(active.runtime.status(active.sessionId).status) && active.after === active.runtime.events(active.sessionId, 0).length) {
      if (active.watchdog) clearTimeout(active.watchdog);
      if (this.active === active) this.active = undefined;
    }
  }
  async step(): Promise<Delivery> {
    requireCondition(!this.stepping, 409, 'poll_already_in_progress');
    this.stepping = true;
    try {
      if (this.active) await this.flush(this.active);
      const delivery = await requestJson<Delivery>(this.config.controlUrl, this.config.token, '/worker/poll', { instanceId: this.instanceId }, this.stopSignal.signal);
      if (delivery.command === 'execute' || delivery.command === 'cancel') {
        requireCondition(typeof delivery.leaseId === 'string' && typeof delivery.runId === 'string' && typeof delivery.leaseTtlMs === 'number' && delivery.leaseTtlMs >= 1000 && delivery.leaseTtlMs <= 60000, 400, 'invalid_delivery');
        let active = this.seen.get(delivery.leaseId);
        if (!active && delivery.command === 'execute') {
          requireCondition(!this.active && delivery.work?.memberId === this.config.memberId && delivery.work.runId === delivery.runId, 409, 'assignment_mismatch');
          const runtime = new LocalRuntime({ provider: this.config.provider, version: this.config.provider === 'fake' ? '0.1.0' : '1.4.0', memberId: this.config.memberId, controlUrl: this.config.controlUrl, memberToken: this.config.token, execute: this.execute,
            toolHeaders: { 'x-coseat-instance': this.instanceId, 'x-coseat-lease': delivery.leaseId } });
          const { sessionId } = await runtime.createSession(delivery.work);
          active = { leaseId: delivery.leaseId, runId: delivery.runId, runtime, sessionId, after: 0, cancelled: false };
          // Record before applying input; redelivery cannot submit a second execution.
          this.seen.set(delivery.leaseId, active); this.active = active;
          await runtime.submitInput(sessionId, { id: `${delivery.runId}:1`, text: 'Research the authorized source using explicitly synthetic evidence.', contextRevision: delivery.work.contextRevision });
        }
        if (active) {
          requireCondition(active.runId === delivery.runId, 409, 'lease_binding_changed');
          this.active = active;
          if (active.watchdog) clearTimeout(active.watchdog);
          active.watchdog = setTimeout(() => this.cancel(active!), delivery.leaseTtlMs - 500);
          if (delivery.command === 'cancel') this.cancel(active);
          await this.flush(active);
        } else if (delivery.command === 'cancel') {
          // Only this still-live instance can attest that it never received/applied input.
          if (!this.noStart.has(delivery.leaseId)) {
            await requestJson(this.config.controlUrl, this.config.token, '/worker/not-started', { instanceId: this.instanceId, leaseId: delivery.leaseId });
            this.noStart.add(delivery.leaseId);
          }
        }
      } else requireCondition(delivery.command === 'idle' || delivery.command === 'blocked', 400, 'invalid_command');
      return delivery;
    } finally { this.stepping = false; }
  }
  async run(onDisconnect: () => void = () => {}): Promise<void> {
    let disconnected = false;
    while (!this.stopSignal.signal.aborted) {
      try { await this.step(); disconnected = false; }
      catch { if (!disconnected && !this.stopSignal.signal.aborted) onDisconnect(); disconnected = true; }
      if (!this.stopSignal.signal.aborted) await delay(250);
    }
  }
  requestStop(): void { this.stopSignal.abort(); if (this.active) this.cancel(this.active); }
  async close(): Promise<void> {
    this.requestStop();
    for (const active of this.seen.values()) {
      if (active.watchdog) clearTimeout(active.watchdog);
      await active.runtime.close();
    }
    if (this.active) { try { await this.flush(this.active); } catch { /* No stop receipt claimed while disconnected. */ } }
  }
}
