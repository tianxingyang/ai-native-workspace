import { createHash, randomUUID } from 'node:crypto';
import { requireCondition, type Scope } from '../contracts.js';

export interface MembershipRemoval extends Scope {
  id: string; actorId: string; targetMemberId: string; revision: number; at: number;
}
interface SavedMemberships {
  removals: MembershipRemoval[];
  additions?: MembershipRemoval[];
  requests: [string, { fingerprint: string; removalId: string }][];
}
const scopeKey = (scope: Scope) => JSON.stringify([scope.conversationId, scope.threadId]);
const memberKey = (memberId: string, scope: Scope) => JSON.stringify([memberId, scope.conversationId, scope.threadId]);

/** Persistent removals override configured memberships without changing identities or Grants.
 * Authorization belongs to ControlState; this index never grants a product action. */
export class MembershipRegistry {
  private readonly removals = new Map<string, MembershipRemoval>();
  private readonly additions = new Map<string, MembershipRemoval>();
  private readonly generations = new Map<string, string>();
  private readonly requests = new Map<string, { fingerprint: string; removalId: string }>();
  private readonly removed = new Set<string>();
  private readonly revisions = new Map<string, number>();

  snapshot(): SavedMemberships { return structuredClone({ removals: [...this.removals.values()], additions: [...this.additions.values()], requests: [...this.requests] }); }
  restore(saved?: SavedMemberships): void {
    this.removals.clear(); this.additions.clear(); this.generations.clear(); this.requests.clear(); this.removed.clear(); this.revisions.clear();
    for (const change of structuredClone(saved?.removals ?? [])) this.removals.set(change.id, change);
    for (const change of structuredClone(saved?.additions ?? [])) this.additions.set(change.id, change);
    for (const change of [...this.removals.values(), ...this.additions.values()].sort((a, b) => a.revision - b.revision)) {
      const key = memberKey(change.targetMemberId, change);
      if (this.additions.has(change.id)) { this.removed.delete(key); this.generations.set(key, change.id); }
      else this.removed.add(key);
      this.revisions.set(scopeKey(change), Math.max(this.revision(change), change.revision));
    }
    for (const [key, value] of structuredClone(saved?.requests ?? [])) this.requests.set(key, value);
  }
  revision(scope: Scope): number { return this.revisions.get(scopeKey(scope)) ?? 1; }
  generation(memberId: string, scope: Scope): string { return this.generations.get(memberKey(memberId, scope)) ?? 'initial'; }
  scopes(memberId: string, configured: readonly Scope[]): Scope[] {
    return configured.filter(scope => !this.removed.has(memberKey(memberId, scope)));
  }
  priorAddition(actorId: string, targetMemberId: string, scope: Scope, expectedRevision: number, clientEventId: string, grant: unknown) {
    const previous = this.requests.get(JSON.stringify([actorId, clientEventId]));
    if (!previous) return undefined;
    requireCondition(previous.fingerprint === this.additionFingerprint(targetMemberId, scope, expectedRevision, grant), 409, 'membership_request_conflict');
    return { change: structuredClone(this.additions.get(previous.removalId)!), duplicate: true };
  }
  private additionFingerprint(targetMemberId: string, scope: Scope, expectedRevision: number, grant: unknown) {
    return createHash('sha256').update(JSON.stringify(['add', targetMemberId, scope.conversationId, scope.threadId, expectedRevision, grant])).digest('hex');
  }
  add(actorId: string, targetMemberId: string, scope: Scope, expectedRevision: number, clientEventId: string, configured: readonly Scope[], grant: unknown, now: number) {
    requireCondition(Number.isSafeInteger(expectedRevision) && expectedRevision > 0, 400, 'invalid_membership_revision');
    requireCondition(this.revision(scope) === expectedRevision, 409, 'membership_revision_conflict');
    requireCondition(!this.scopes(targetMemberId, configured).some(s => scopeKey(s) === scopeKey(scope)), 409, 'scope_member_already_present');
    const change: MembershipRemoval = { ...scope, id: randomUUID(), actorId, targetMemberId, revision: expectedRevision + 1, at: now };
    this.additions.set(change.id, change); this.generations.set(memberKey(targetMemberId, scope), change.id);
    this.removed.delete(memberKey(targetMemberId, scope)); this.revisions.set(scopeKey(scope), change.revision);
    this.requests.set(JSON.stringify([actorId, clientEventId]), { fingerprint: this.additionFingerprint(targetMemberId, scope, expectedRevision, grant), removalId: change.id });
    return { change: structuredClone(change), duplicate: false };
  }
  remove(actorId: string, targetMemberId: string, scope: Scope, expectedRevision: number, clientEventId: string, configured: readonly Scope[], now: number) {
    requireCondition(Number.isSafeInteger(expectedRevision) && expectedRevision > 0, 400, 'invalid_membership_revision');
    const key = JSON.stringify([actorId, clientEventId]);
    const fingerprint = createHash('sha256').update(JSON.stringify([targetMemberId, scope.conversationId, scope.threadId, expectedRevision])).digest('hex');
    const previous = this.requests.get(key);
    if (previous) {
      requireCondition(previous.fingerprint === fingerprint, 409, 'membership_request_conflict');
      return { change: structuredClone(this.removals.get(previous.removalId)!), duplicate: true };
    }
    requireCondition(this.revision(scope) === expectedRevision, 409, 'membership_revision_conflict');
    requireCondition(this.scopes(targetMemberId, configured).some(s => scopeKey(s) === scopeKey(scope)), 404, 'scope_member_not_found');
    const change: MembershipRemoval = { conversationId: scope.conversationId, threadId: scope.threadId,
      id: randomUUID(), actorId, targetMemberId, revision: expectedRevision + 1, at: now };
    this.removals.set(change.id, change); this.requests.set(key, { fingerprint, removalId: change.id });
    this.removed.add(memberKey(targetMemberId, scope)); this.revisions.set(scopeKey(scope), change.revision);
    return { change: structuredClone(change), duplicate: false };
  }
  leave(actorId: string, scope: Scope, expectedGeneration: string, clientEventId: string, configured: readonly Scope[], now: number) {
    // Generation is checked before receipts: an old request must never confirm
    // departure from a newly granted membership, even when its ID is identical.
    requireCondition(this.generation(actorId, scope) === expectedGeneration, 409, 'membership_generation_conflict');
    const key = JSON.stringify([actorId, clientEventId]);
    const fingerprint = createHash('sha256').update(JSON.stringify(['leave', scope.conversationId, scope.threadId, expectedGeneration])).digest('hex');
    const previous = this.requests.get(key);
    if (previous) {
      requireCondition(previous.fingerprint === fingerprint, 409, 'membership_request_conflict');
      return { change: structuredClone(this.removals.get(previous.removalId)!), duplicate: true };
    }
    requireCondition(this.scopes(actorId, configured).some(s => scopeKey(s) === scopeKey(scope)), 404, 'scope_member_not_found');
    const change: MembershipRemoval = { conversationId: scope.conversationId, threadId: scope.threadId,
      id: randomUUID(), actorId, targetMemberId: actorId, revision: this.revision(scope) + 1, at: now };
    this.removals.set(change.id, change); this.requests.set(key, { fingerprint, removalId: change.id });
    this.removed.add(memberKey(actorId, scope)); this.revisions.set(scopeKey(scope), change.revision);
    return { change: structuredClone(change), duplicate: false };
  }
}
