import { createHash, randomUUID } from "node:crypto";
import { isIP } from "node:net";

export interface EvidenceBinding {
  taskId: string; runId: string; sourceMessageId: string;
  sourceRevision: number; contextRevision: number;
}
export interface EvidenceReceipt extends EvidenceBinding {
  receiptId: string; url: string; sha256: string; bytes: number;
  receivedAt: number; expiresAt: number;
}
export interface EvidenceClaim { receiptId: string; excerpt: string }
export const EVIDENCE_TEXT_LIMIT = 64 * 1024;
const keys = ["taskId", "runId", "sourceMessageId", "sourceRevision", "contextRevision"] as const;
function bindingValid(b: EvidenceBinding): boolean {
  return ["taskId", "runId", "sourceMessageId"].every(k => typeof b[k as keyof EvidenceBinding] === "string" && String(b[k as keyof EvidenceBinding]).length > 0 && String(b[k as keyof EvidenceBinding]).length <= 200)
    && [b.sourceRevision, b.contextRevision].every(n => Number.isSafeInteger(n) && n > 0);
}
function documentUrl(value: string): string {
  const u = new URL(value);
  if (u.protocol !== "https:" || u.username || u.password || u.port || u.search || u.hash || isIP(u.hostname) || u.hostname.startsWith("[") ||
      !u.hostname.includes(".") || /\.(localhost|local|internal|test|invalid|example)$/i.test(u.hostname)) throw new Error("invalid_document_url");
  return u.href;
}
/** Controller-private, in-memory receipt store. Never expose record() to model input. */
export class EvidenceLedger {
  private records = new Map<string, { receipt: EvidenceReceipt; text: string }>();
  private revoked = new Set<string>();
  private sealed = false;
  private allowed: Set<string>;
  constructor(urls: readonly string[], private readonly now: () => number = Date.now) {
    if (!urls.length || urls.length > 16) throw new Error("invalid_allowlist");
    this.allowed = new Set(urls.map(documentUrl));
  }
  record(binding: EvidenceBinding, url: string, text: string): EvidenceReceipt {
    const time = this.now();
    if (this.sealed || this.revoked.has(binding.runId) || !bindingValid(binding)) throw new Error("inadmissible_binding");
    const canonical = documentUrl(url);
    if (!this.allowed.has(canonical)) throw new Error("document_not_allowed");
    if (typeof text !== "string" || !text.length || Buffer.byteLength(text) > EVIDENCE_TEXT_LIMIT) throw new Error("invalid_evidence_text");
    if (!Number.isSafeInteger(time) || time < 0) throw new Error("invalid_clock");
    for (const [id, r] of this.records) if (r.receipt.expiresAt <= time) this.records.delete(id);
    if (this.records.size >= 128) throw new Error("receipt_capacity");
    const receipt: EvidenceReceipt = { taskId: binding.taskId, runId: binding.runId, sourceMessageId: binding.sourceMessageId,
      sourceRevision: binding.sourceRevision, contextRevision: binding.contextRevision, receiptId: randomUUID(),
      url: canonical, sha256: createHash("sha256").update(text).digest("hex"), bytes: Buffer.byteLength(text), receivedAt: time, expiresAt: time + 300_000 };
    this.records.set(receipt.receiptId, { receipt, text });
    return { ...receipt };
  }
  verify(binding: EvidenceBinding, claims: readonly EvidenceClaim[]): Array<EvidenceReceipt & { excerpt: string }> {
    const time = this.now();
    if (!bindingValid(binding) || this.sealed || this.revoked.has(binding.runId) || !Number.isSafeInteger(time) || time < 0 ||
        !Array.isArray(claims) || !claims.length || claims.length > 8) throw new Error("invalid_claims");
    const seen = new Set<string>();
    return claims.map(claim => {
      if (!claim || Object.keys(claim).sort().join(",") !== "excerpt,receiptId" || typeof claim.receiptId !== "string" ||
          typeof claim.excerpt !== "string" || !claim.excerpt.length || claim.excerpt.length > 2000 || seen.has(claim.receiptId)) throw new Error("invalid_claim");
      seen.add(claim.receiptId);
      const r = this.records.get(claim.receiptId);
      if (!r || keys.some(k => r.receipt[k] !== binding[k]) || time < r.receipt.receivedAt || time >= r.receipt.expiresAt ||
          !r.text.includes(claim.excerpt)) throw new Error("unverified_evidence");
      return { ...r.receipt, excerpt: claim.excerpt };
    });
  }
  revokeRun(runId: string): void {
    if (this.revoked.has(runId)) return;
    // Never evict a tombstone: bounded exhaustion permanently closes this ledger.
    if (this.revoked.size >= 128) { this.sealed = true; this.records.clear(); return; }
    this.revoked.add(runId);
    for (const [id, r] of this.records) if (r.receipt.runId === runId) this.records.delete(id);
  }
}
