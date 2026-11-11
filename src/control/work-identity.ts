import { RESEARCH_SLOTS, WORK_IDENTITY_VERSION, objectValue, requireCondition, scopeValue, stringValue, type ResearchSlot, type Scope, type WorkIdentity } from '../contracts.js';

export function researchSlot(value: unknown = 'research'): ResearchSlot {
  requireCondition(RESEARCH_SLOTS.includes(value as ResearchSlot), 400, 'unsupported_work_slot');
  return value as ResearchSlot;
}
/** JSON tuple encoding is unambiguous even when IDs contain separators or Unicode. */
export function researchIdentity(source: Scope & { messageId: string; revision: number }, slot: ResearchSlot = 'research'): WorkIdentity {
  researchSlot(slot);
  scopeValue({ ...source }); stringValue(source.messageId, 'sourceMessageId', 128);
  requireCondition(Number.isSafeInteger(source.revision) && source.revision > 0, 400, 'invalid_source_revision');
  return { version: WORK_IDENTITY_VERSION, intent: 'research', slot,
    key: JSON.stringify([WORK_IDENTITY_VERSION, source.conversationId, source.threadId, source.messageId, source.revision, 'research', slot]) };
}
export function claimInput(raw: unknown) {
  const body = objectValue(raw);
  requireCondition(Object.keys(body).every(key => ['sourceMessageId', 'sourceRevision', 'intent', 'slot'].includes(key)), 400, 'invalid_claim_request');
  requireCondition(body.intent === 'research', 400, 'unsupported_intent');
  requireCondition(Number.isSafeInteger(body.sourceRevision) && Number(body.sourceRevision) > 0, 400, 'invalid_source_revision');
  return { messageId: stringValue(body.sourceMessageId, 'sourceMessageId', 128), sourceRevision: Number(body.sourceRevision), slot: researchSlot(body.slot) };
}
export const SLOT_INSTRUCTIONS: Record<ResearchSlot, string> = {
  research: 'Synthesize an answer to the authorized source question using the supplied synthetic evidence.',
  source_verification: 'Independently check the supplied synthetic source excerpts and report support, contradictions and evidence gaps; do not duplicate the primary synthesis.',
};
