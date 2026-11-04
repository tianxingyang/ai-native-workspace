import { createHash, randomUUID } from 'node:crypto';
import { requireCondition, type Message, type Run, type Scope } from '../contracts.js';

const RETAINED_CHANGES = 512;
type Kind = 'message' | 'run';
interface Change { sequence: number; kind: Kind; id: string }
interface Stream {
  id: string; sequence: number; changes: Change[];
  messages: [string, string][]; runs: [string, string][];
}
export interface SyncBatch {
  streamId: string; cursor: string; reset: boolean; cursorAhead: boolean;
  messages: Message[]; runs: Run[]; removedMessageIds: string[]; removedRunIds: string[];
  readThroughMessageId: string | null;
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** A bounded latest-state change index, not an event-delivery or read receipt.
 * Persist only IDs/hashes, never historical message bodies or runtime output. */
export class DeliveryJournal {
  private readonly streams = new Map<string, Stream>();
  snapshot(): [string, Stream][] { return structuredClone([...this.streams]); }
  restore(saved: [string, Stream][] = []): void {
    this.streams.clear(); for (const [key, stream] of structuredClone(saved)) this.streams.set(key, stream);
  }
  read(actorId: string, scope: Scope, messages: Message[], runs: Run[], readThroughMessageId: string | null, cursor?: string): SyncBatch {
    const key = JSON.stringify([scope.conversationId, scope.threadId]), binding = digest([actorId, key]);
    let parsed: RegExpExecArray | null = null;
    if (cursor !== undefined) {
      requireCondition(typeof cursor === 'string' && cursor.length <= 128, 400, 'invalid_sync_cursor');
      parsed = /^v1\.([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\.([a-f0-9]{64})\.(0|[1-9][0-9]{0,15})$/.exec(cursor);
      requireCondition(parsed && Number.isSafeInteger(Number(parsed[3])), 400, 'invalid_sync_cursor');
      // This prevents accidental cross-identity/scope reuse; it never grants authority.
      requireCondition(parsed[2] === binding, 400, 'sync_cursor_scope_mismatch');
    }
    const stream = this.streams.get(key) ?? { id: randomUUID(), sequence: 0, changes: [], messages: [], runs: [] };
    const update = (kind: Kind, previous: [string, string][], values: { id: string }[]): [string, string][] => {
      const old = new Map(previous), next = values.map(value => [value.id, digest(value)] as [string, string]);
      for (const [id, hash] of next) {
        if (old.get(id) !== hash) stream.changes.push({ sequence: ++stream.sequence, kind, id });
        old.delete(id);
      }
      for (const id of old.keys()) stream.changes.push({ sequence: ++stream.sequence, kind, id });
      return next;
    };
    stream.messages = update('message', stream.messages, messages); stream.runs = update('run', stream.runs, runs);
    stream.changes = stream.changes.slice(-RETAINED_CHANGES); this.streams.set(key, stream);
    const after = parsed ? Number(parsed[3]) : 0, cursorAhead = Boolean(parsed && parsed[1] === stream.id && after > stream.sequence);
    const floor = stream.changes[0]?.sequence ?? stream.sequence + 1;
    const reset = !parsed || parsed[1] !== stream.id || cursorAhead || after < floor - 1;
    const messageIds = new Set<string>(), runIds = new Set<string>();
    if (!reset) for (const change of stream.changes) if (change.sequence > after) (change.kind === 'message' ? messageIds : runIds).add(change.id);
    const currentMessages = new Set(messages.map(m => m.id)), currentRuns = new Set(runs.map(r => r.id));
    return structuredClone({ streamId: stream.id, cursor: `v1.${stream.id}.${binding}.${stream.sequence}`, reset, cursorAhead,
      messages: reset ? messages : messages.filter(m => messageIds.has(m.id)), runs: reset ? runs : runs.filter(r => runIds.has(r.id)),
      removedMessageIds: [...messageIds].filter(id => !currentMessages.has(id)), removedRunIds: [...runIds].filter(id => !currentRuns.has(id)), readThroughMessageId });
  }
}
