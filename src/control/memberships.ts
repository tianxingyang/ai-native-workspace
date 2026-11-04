import { createHash, randomUUID } from 'node:crypto';
import { requireCondition, type Scope } from '../contracts.js';

export interface MembershipRemoval extends Scope {
  id: string; actorId: string; targetMemberId: string; revision: number; at: number;
}
interface SavedMemberships {
  removals: MembershipRemoval[];
  requests: [string, { fingerprint: string; removalId: string }][];
}
const scopeKey = (scope: Scope) => JSON.stringify([scope.conversationId, scope.threadId]);
const memberKey = (memberId: string, scope: Scope) => JSON.stringify([memberId, scope.conversationId, scope.threadId]);

/** Persistent removals override configured memberships without changing identities or Grants.
 * Authorization belongs to ControlState; this index never grants a product action. */
export class MembershipRegistry {
  private readonly removals = new Map<string, MembershipRemoval>();
  private readonly requests = new Map<string, { fingerprint: string; removalId: string }>();
  private readonly removed = new Set<string>();
  private readonly revisions = new Map<string, number>();

  snapshot(): SavedMemberships { return structuredClone({ removals: [...this.removals.values()], requests: [...this.requests] }); }
  restore(saved?: SavedMemberships): void {
    this.removals.clear(); this.requests.clear(); this.removed.clear(); this.revisions.clear();
    for (const removal of structuredClone(saved?.removals ?? [])) {
      this.removals.set(removal.id, removal); this.removed.add(memberKey(removal.targetMemberId, removal));
      this.revisions.set(scopeKey(removal), Math.max(this.revision(removal), removal.revision));
    }
    for (const [key, value] of structuredClone(saved?.requests ?? [])) this.requests.set(key, value);
  }
  revision(scope: Scope): number { return this.revisions.get(scopeKey(scope)) ?? 1; }
  scopes(memberId: string, configured: readonly Scope[]): Scope[] {
    return configured.filter(scope => !this.removed.has(memberKey(memberId, scope)));
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
}
