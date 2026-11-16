import test from "node:test";
import assert from "node:assert/strict";
import { EvidenceLedger, EVIDENCE_TEXT_LIMIT } from "../src/research/evidence-ledger.js";
const url = "https://www.typescriptlang.org/docs/handbook/2/everyday-types.html";
const binding = { taskId: "t", runId: "r", sourceMessageId: "m", sourceRevision: 1, contextRevision: 2 };
function setup() { let now = 1000; const ledger = new EvidenceLedger([url], () => now); const receipt = ledger.record(binding,url,"Interfaces describe objects."); const claims = [{receiptId:receipt.receiptId,excerpt:"describe objects"}]; return {ledger,receipt,claims,time:(n:number)=>{now=n;}}; }
test("controller receipt binds exact excerpt and hash",()=>{ const s=setup(); const result=s.ledger.verify(binding,s.claims)[0]!; assert.equal(result.bytes,28); assert.match(result.sha256,/^[a-f0-9]{64}$/); });
test("receipt copy cannot alter stored metadata",()=>{const s=setup();s.receipt.url="https://bad.invalid";assert.equal(s.ledger.verify(binding,s.claims)[0]!.url,url);});
test("every binding field matters",()=>{const s=setup();for(const key of Object.keys(binding))assert.throws(()=>s.ledger.verify({...binding,[key]:typeof binding[key as keyof typeof binding]==="number"?3:"other"},s.claims));});
test("expiry and clock reversal reject",()=>{const s=setup();s.time(301000);assert.throws(()=>s.ledger.verify(binding,s.claims));s.time(999);assert.throws(()=>s.ledger.verify(binding,s.claims));});
test("unknown receipts and absent excerpts rejected",()=>{const s=setup();assert.throws(()=>s.ledger.verify(binding,[{receiptId:"fake",excerpt:"a"}]));assert.throws(()=>s.ledger.verify(binding,[{...s.claims[0]!,excerpt:"not found"}]));});
test("extra model metadata and duplicate claims rejected",()=>{const s=setup();assert.throws(()=>s.ledger.verify(binding,[{...s.claims[0]!,url} as typeof s.claims[0]]));assert.throws(()=>s.ledger.verify(binding,[...s.claims,...s.claims]));});
test("URL scope rejects queries credentials and local literals",()=>{for(const u of ["http://example.org","https://127.0.0.1","https://[::1]","https://example.org/?q=a","https://u:p@example.org","https://host.local"])assert.throws(()=>new EvidenceLedger([u]));assert.throws(()=>setup().ledger.record(binding,"https://example.org/","x"));});
test("text and claims bounded",()=>{const s=setup();assert.throws(()=>s.ledger.record(binding,url,"x".repeat(EVIDENCE_TEXT_LIMIT+1)));assert.throws(()=>s.ledger.verify(binding,[]));assert.throws(()=>s.ledger.verify(binding,Array(9).fill(s.claims[0])));});
test("revocation rejects current and late collection",()=>{const s=setup();s.ledger.revokeRun("r");assert.throws(()=>s.ledger.verify(binding,s.claims));assert.throws(()=>s.ledger.record(binding,url,"late"));});
test("tombstone saturation seals rather than reopens",()=>{const s=setup();for(let i=0;i<129;i++)s.ledger.revokeRun(String(i));assert.throws(()=>s.ledger.record({...binding,runId:"fresh"},url,"x"));});
test("capacity bounded and expired entries reclaimed",()=>{const s=setup();for(let i=0;i<127;i++)s.ledger.record(binding,url,"x");assert.throws(()=>s.ledger.record(binding,url,"x"));s.time(301000);assert.ok(s.ledger.record(binding,url,"x"));});
test("invalid binding rejected",()=>{assert.throws(()=>setup().ledger.record({...binding,sourceRevision:0},url,"x"));});
