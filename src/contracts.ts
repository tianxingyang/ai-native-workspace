/** Versioned wire types; provider sessions never identify CoSeat members or tasks. */
export const PROTOCOL_VERSION = 'coseat.runtime.v0' as const;
export const ACTIONS = ['read', 'send', 'claim', 'request_approval', 'cancel', 'manage_resource', 'manage_workspace', 'grant_permissions', 'external_send', 'permanent_delete', 'continuous_run'] as const;
export type Action = typeof ACTIONS[number];
export interface RoleTemplate { id: string; revision: number; actions: Action[] }
export interface AuthorizationPolicy { version: number; roles: RoleTemplate[]; disabledActions: Action[] }
export type RunStatus = 'queued' | 'running' | 'cancel_requested' | 'completed' | 'failed' | 'stopped' | 'unknown';
export const terminal = (status: RunStatus) => ['completed', 'failed', 'stopped'].includes(status);
export interface Scope { conversationId: string; threadId: string }
export interface Member { id: string; kind: 'human' | 'agent'; name: string; workMode?: string }
export interface Grant extends Scope {
  id: string; revision: number; memberId: string; actions: Action[]; expiresAt: number; revoked: boolean;
  effect?: 'allow' | 'deny'; roleIds?: string[];
}
export interface TextAttachment { name: string; bytes: number; sha256: string }
export interface Message extends Scope {
  id: string; revision: number; authorId: string; text: string; createdAt: number;
  origin: 'chat' | 'research'; sourceMessageId?: string; result?: ResearchResult;
  retracted?: boolean; changedAt?: number; invalidated?: boolean;
  replyToMessageId?: string;
  attachment?: TextAttachment;
}
export interface MessageChange extends Scope {
  id: string; messageId: string; actorId: string; kind: 'edit' | 'retract';
  revision: number; contextRevision: number; at: number; affectedRunIds: string[];
}
export interface Source { id: string; title: string; url: string; excerpt: string }
export interface ResearchResult {
  conclusion: string; sources: Source[]; limitations: string[];
  evidence: 'synthetic-fixture'; // This slice has no live research provider.
}
export interface WorkPackage {
  protocol: typeof PROTOCOL_VERSION;
  memberId: string; taskId: string; runId: string;
  source: Scope & { messageId: string; revision: number };
  contextRevision: number;
  grant: { id: string; revision: number; expiresAt: number };
  authorization?: { policyVersion: number; policyDigest: string; grants: { action: Action; id: string; revision: number; expiresAt: number }[] };
  tools: readonly ['read_messages', 'send_message', 'claim_task', 'request_approval'];
  budget: { maxToolCalls: number; maxDurationMs: number };
  route: Scope;
  constraints: readonly string[];
}
export interface CheckpointRef { provider: string; providerVersion: string; sessionId: string; opaqueRef: string }
export interface RuntimeCapabilities {
  protocol: typeof PROTOCOL_VERSION; provider: string; providerVersion: string;
  appendInput: false; pause: false; resume: false; checkpoint: false;
  cancellation: 'cooperative';
}
export interface RuntimeInput { id: string; text: string; contextRevision: number }
export interface RuntimeEvent {
  id: string; sequence: number; sessionId: string; runId: string;
  kind: 'input_received' | 'input_applied' | 'status' | 'output' | 'approval_requested' | 'stopped' | 'failed';
  status: RunStatus; at: number; data: Record<string, unknown>;
}
export interface CancelReceipt { accepted: boolean; stopped: boolean }
export interface RuntimeProvider {
  capabilities(): RuntimeCapabilities;
  createSession(work: WorkPackage): Promise<{ sessionId: string }>;
  submitInput(sessionId: string, input: RuntimeInput): Promise<{ accepted: boolean }>;
  status(sessionId: string): { status: RunStatus };
  events(sessionId: string, after: number): RuntimeEvent[];
  cancel(sessionId: string): CancelReceipt;
  appendInput(sessionId: string, input: RuntimeInput): never;
  pause(sessionId: string): never;
  resume(checkpoint: CheckpointRef): never;
}
export interface Run {
  id: string; taskId: string; memberId: string; sourceMessageId: string; intent: 'research';
  work: WorkPackage; status: RunStatus; sessionId?: string; receiptId?: string;
  events: RuntimeEvent[]; error?: string;
  invalidatedBy?: string;
  replacementRunId?: string;
  rebuildAfterInvalidation?: boolean;
  contextInvalidated?: boolean;
  stopEvidence?: { scope: 'runtime_session_not_created' | 'worker_acknowledged_not_started'; executionStarted: false };
}
/** Explicit control facts for provider admission; never reconstructed from a transcript. */
export interface ClaimConfirmation {
  run: Run; duplicate: true;
  execution: { toolCalls: number; publishedReceiptId: string | null; sessionId: string | null };
}
export class ApiError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}
export function requireCondition(condition: unknown, status: number, code: string): asserts condition {
  if (!condition) throw new ApiError(status, code);
}
export function stringValue(value: unknown, field: string, max = 8000): string {
  requireCondition(typeof value === 'string' && value.length > 0 && value.length <= max, 400, `invalid_${field}`);
  return value;
}
export function objectValue(value: unknown): Record<string, unknown> {
  requireCondition(value !== null && typeof value === 'object' && !Array.isArray(value), 400, 'invalid_object');
  return value as Record<string, unknown>;
}
export function scopeValue(value: Record<string, unknown>): Scope {
  return { conversationId: stringValue(value.conversationId, 'conversationId', 128), threadId: stringValue(value.threadId, 'threadId', 128) };
}
export function resultValue(value: unknown): ResearchResult {
  const result = objectValue(value);
  const conclusion = stringValue(result.conclusion, 'conclusion');
  requireCondition(result.evidence === 'synthetic-fixture', 400, 'fixture_evidence_required');
  requireCondition(Array.isArray(result.sources) && result.sources.length > 0 && result.sources.length <= 8, 400, 'sources_required');
  const sources = result.sources.map((item) => {
    const s = objectValue(item);
    const url = stringValue(s.url, 'url', 2048);
    // Fixture URLs cannot be mistaken for fetched real-world evidence.
    requireCondition(/^https:\/\/fixtures\.invalid\/[a-z0-9/-]+$/.test(url), 400, 'invalid_fixture_source');
    return { id: stringValue(s.id, 'sourceId', 128), title: stringValue(s.title, 'title', 300), url, excerpt: stringValue(s.excerpt, 'excerpt', 2000) };
  });
  requireCondition(Array.isArray(result.limitations) && result.limitations.length > 0 && result.limitations.length <= 8, 400, 'limitations_required');
  return { conclusion, sources, limitations: result.limitations.map(x => stringValue(x, 'limitation', 1000)), evidence: 'synthetic-fixture' };
}
export function validateWork(work: WorkPackage): void {
  requireCondition(work.protocol === PROTOCOL_VERSION, 400, 'protocol_mismatch');
  for (const key of ['memberId', 'taskId', 'runId'] as const) stringValue(work[key], key, 128);
  const source = objectValue(work.source), route = objectValue(work.route), grant = objectValue(work.grant);
  scopeValue(source); scopeValue(route);
  stringValue(source.messageId, 'sourceMessageId', 128); stringValue(grant.id, 'grantId', 128);
  requireCondition(Number.isInteger(work.source.revision) && work.source.revision > 0 && Number.isInteger(work.contextRevision) && work.contextRevision > 0, 400, 'missing_revision');
  requireCondition(work.route.conversationId === work.source.conversationId && work.route.threadId === work.source.threadId, 400, 'route_mismatch');
  requireCondition(Number.isInteger(work.grant.revision) && work.grant.revision > 0 && Number.isFinite(work.grant.expiresAt) && work.grant.expiresAt > Date.now(), 403, 'invalid_grant');
  if (work.authorization !== undefined) {
    const authorization = objectValue(work.authorization);
    requireCondition(Number.isSafeInteger(authorization.policyVersion) && Number(authorization.policyVersion) >= 0 && typeof authorization.policyDigest === 'string' && /^[a-f0-9]{64}$/.test(authorization.policyDigest), 400, 'invalid_authorization_policy');
    requireCondition(Array.isArray(authorization.grants) && authorization.grants.length === 4, 400, 'invalid_authorization_bindings');
    const actions = new Set<string>();
    for (const raw of authorization.grants) {
      const binding = objectValue(raw);
      requireCondition(['read', 'send', 'claim', 'request_approval'].includes(String(binding.action)) && !actions.has(String(binding.action)), 400, 'invalid_authorization_bindings');
      actions.add(String(binding.action)); stringValue(binding.id, 'grantId', 128);
      requireCondition(Number.isSafeInteger(binding.revision) && Number(binding.revision) > 0 && Number.isFinite(binding.expiresAt) && Number(binding.expiresAt) >= work.grant.expiresAt, 400, 'invalid_authorization_bindings');
    }
    const claim = work.authorization.grants.find(g => g.action === 'claim');
    requireCondition(claim?.id === work.grant.id && claim.revision === work.grant.revision, 400, 'invalid_authorization_bindings');
  }
  requireCondition(Number.isInteger(work.budget?.maxToolCalls) && work.budget.maxToolCalls > 0 && work.budget.maxToolCalls <= 20 && Number.isInteger(work.budget.maxDurationMs) && work.budget.maxDurationMs > 0 && work.budget.maxDurationMs <= 60000, 400, 'invalid_budget');
  requireCondition(JSON.stringify(work.tools) === JSON.stringify(['read_messages', 'send_message', 'claim_task', 'request_approval']), 400, 'invalid_tools');
  requireCondition(Array.isArray(work.constraints) && work.constraints.length > 0, 400, 'missing_constraints');
  for (const constraint of work.constraints) stringValue(constraint, 'constraint', 1000);
}
