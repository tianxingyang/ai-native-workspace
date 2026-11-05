import { createHash, randomUUID } from 'node:crypto';
import { objectValue, requireCondition, scopeValue, stringValue, type Action, type Scope } from '../contracts.js';

// A versioned product rule, not a grant. Changing this one data object changes
// the gateway's decision digest and invalidates previously bound child work.
export const THREAD_POLICY = Object.freeze({ source: 'parent-v1' as const, version: 1,
  actions: Object.freeze(['read', 'send', 'claim', 'request_approval', 'cancel'] satisfies Action[]),
  creationActions: Object.freeze(['read', 'send'] satisfies Action[]) });

/** Discussion identity and provenance only. This registry never issues permissions. */
export interface DiscussionThread extends Scope {
  parent: Scope; title: string; revision: number; status: 'active';
  createdBy: string; createdAt: number; sourceMessageId?: string;
  authorization: 'parent-v1';
}
export interface ThreadInput {
  parent: Scope; title: string; clientEventId: string;
  expectedMembershipGeneration: string; sourceMessageId?: string;
}
interface Receipt { fingerprint: string; thread: DiscussionThread }
interface SavedThreads { threads: DiscussionThread[]; requests: [string, Receipt][] }
const scopeKey = (scope: Scope) => JSON.stringify([scope.conversationId, scope.threadId]);
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function threadInput(raw: unknown): ThreadInput {
  const value = objectValue(raw);
  requireCondition(Object.keys(value).every(key => ['conversationId', 'threadId', 'title', 'clientEventId', 'expectedMembershipGeneration', 'sourceMessageId'].includes(key)), 400, 'invalid_thread_request');
  const text = stringValue(value.title, 'thread_title', 128), title = text.trim();
  requireCondition(title.length > 0 && !/[\u0000-\u001f\u007f\p{Surrogate}]/u.test(text), 400, 'invalid_thread_title');
  return { parent: scopeValue(value), title, clientEventId: stringValue(value.clientEventId, 'client_event_id', 128),
    expectedMembershipGeneration: stringValue(value.expectedMembershipGeneration, 'membership_generation', 128),
    ...(value.sourceMessageId === undefined ? {} : { sourceMessageId: stringValue(value.sourceMessageId, 'source_message_id', 128) }) };
}

export class ThreadRegistry {
  private readonly threads = new Map<string, DiscussionThread>();
  private readonly requests = new Map<string, Receipt>();
  snapshot(): SavedThreads { return structuredClone({ threads: [...this.threads.values()], requests: [...this.requests] }); }
  restore(saved?: SavedThreads): void {
    this.threads.clear(); this.requests.clear();
    for (const thread of structuredClone(saved?.threads ?? [])) this.threads.set(scopeKey(thread), thread);
    for (const [id, receipt] of structuredClone(saved?.requests ?? [])) this.requests.set(id, receipt);
  }
  metadata(scope: Scope): DiscussionThread | undefined { return structuredClone(this.threads.get(scopeKey(scope))); }
  children(parent: Scope): DiscussionThread[] {
    return structuredClone([...this.threads.values()].filter(thread => scopeKey(thread.parent) === scopeKey(parent)));
  }
  prior(actor: string, input: ThreadInput) {
    const previous = this.requests.get(JSON.stringify([actor, input.clientEventId]));
    if (!previous) return undefined;
    requireCondition(previous.fingerprint === digest(input), 409, 'thread_request_conflict');
    return { thread: structuredClone(previous.thread), duplicate: true };
  }
  create(actor: string, input: ThreadInput, now: number) {
    const previous = this.prior(actor, input); if (previous) return previous;
    requireCondition(this.threads.size < 1000 && this.children(input.parent).length < 100, 507, 'thread_capacity_reached');
    const thread: DiscussionThread = { conversationId: input.parent.conversationId, threadId: randomUUID(), parent: { ...input.parent },
      title: input.title, revision: 1, status: 'active', createdBy: actor, createdAt: now, authorization: THREAD_POLICY.source,
      ...(input.sourceMessageId === undefined ? {} : { sourceMessageId: input.sourceMessageId }) };
    this.threads.set(scopeKey(thread), thread);
    this.requests.set(JSON.stringify([actor, input.clientEventId]), { fingerprint: digest(input), thread: structuredClone(thread) });
    return { thread: structuredClone(thread), duplicate: false };
  }
}
