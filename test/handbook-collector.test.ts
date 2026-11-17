import test from "node:test";
import assert from "node:assert/strict";
import { collectHandbook, publicIPv4, DOCUMENT_BYTE_LIMIT, HANDBOOK_DOCUMENT, type HandbookRuntime, type DocumentResponse } from "../src/research/handbook-collector.js";
function fixture(text="hello", overrides:Partial<DocumentResponse>={}) {
 let closed=0; let opened=0;
 const response:DocumentResponse={status:200,headers:{"content-type":"text/html; charset=utf-8"},body:(async function*(){yield Buffer.from(text);})(),close:()=>{closed++;},...overrides};
 const runtime:HandbookRuntime={resolveIPv4:async()=>["93.184.215.14"],openPinned:async(address)=>{assert.equal(address,"93.184.215.14");opened++;return response;}};
 return {runtime,response,closed:()=>closed,opened:()=>opened};
}
test("fixed URL and normal UTF8 document",async()=>{const s=fixture("文");const r=await collectHandbook(s.runtime);assert.equal(r.url,HANDBOOK_DOCUMENT);assert.equal(r.bytes,3);assert.equal(r.utf8,"文");assert.equal(s.closed(),1);});
test("public IPv4 only and reserved range defense",()=>{for(const ip of ["127.0.0.1","10.0.0.1","169.254.1.1","100.64.0.1","192.0.2.1","198.18.0.1","203.0.113.1","::1","224.0.0.1"])assert.equal(publicIPv4(ip),false);assert.equal(publicIPv4("93.184.215.14"),true);});
test("mixed DNS rejected before open",async()=>{const s=fixture();s.runtime.resolveIPv4=async()=>["93.184.215.14","127.0.0.1"];await assert.rejects(collectHandbook(s.runtime),/non_public_dns/);assert.equal(s.opened(),0);});
test("status and redirect rejected",async()=>{for(const status of [301,302,404])await assert.rejects(collectHandbook(fixture("x",{status}).runtime),/invalid_status/);});
test("strict MIME charset and encoding",async()=>{for(const headers of [{"content-type":"text/html"},{"content-type":"application/json; charset=utf-8"},{"content-type":"text/html; charset=latin1"},{"content-type":"text/html; charset=utf-8","content-encoding":"gzip"}])await assert.rejects(collectHandbook(fixture("x",{headers}).runtime));});
test("declared and streamed caps",async()=>{await assert.rejects(collectHandbook(fixture("x", {headers:{"content-type":"text/html; charset=utf-8","content-length":String(DOCUMENT_BYTE_LIMIT+1)}}).runtime));await assert.rejects(collectHandbook(fixture("x".repeat(DOCUMENT_BYTE_LIMIT+1)).runtime));});
test("raw document cap separate from extracted text limit",async()=>{assert.equal((await collectHandbook(fixture("x".repeat(324762)).runtime)).bytes,324762);});
test("empty or truncated response rejected",async()=>{await assert.rejects(collectHandbook(fixture("").runtime));await assert.rejects(collectHandbook(fixture("x",{headers:{"content-type":"text/plain; charset=utf-8","content-length":"2"}}).runtime));});
test("invalid UTF8 rejected",async()=>{await assert.rejects(collectHandbook(fixture("x",{body:(async function*(){yield Buffer.from([255]);})()}).runtime));});
test("preabort prevents DNS",async()=>{const c=new AbortController();c.abort();const s=fixture();s.runtime.resolveIPv4=async()=>{throw Error("DNS must not run");};await assert.rejects(collectHandbook(s.runtime,{signal:c.signal}),/aborted/);});
test("late DNS cannot connect",async()=>{const s=fixture();s.runtime.resolveIPv4=()=>new Promise(r=>setTimeout(()=>r(["93.184.215.14"]),30));await assert.rejects(collectHandbook(s.runtime,{timeoutMs:5}),/aborted/);await new Promise(r=>setTimeout(r,40));assert.equal(s.opened(),0);});
test("late open closes response",async()=>{const s=fixture();s.runtime.openPinned=()=>new Promise(r=>setTimeout(()=>r(s.response),30));await assert.rejects(collectHandbook(s.runtime,{timeoutMs:5}),/aborted/);await new Promise(r=>setTimeout(r,40));assert.equal(s.closed(),1);});
test("stalled body closes under total deadline",async()=>{const s=fixture("x",{body:(async function*(){await new Promise(()=>{});yield Buffer.from("x");})()});await assert.rejects(collectHandbook(s.runtime,{timeoutMs:5}),/aborted/);assert.ok(s.closed()>0);});
test("split UTF8 decoded only after bounded body complete",async()=>{const s=fixture("x",{body:(async function*(){yield Buffer.from([0xe6]);yield Buffer.from([0x96,0x87]);})()});assert.equal((await collectHandbook(s.runtime)).utf8,"文");});
test("Node request uses fixed GET private agent and pinned DNS",async()=>{
 const {createNodeHandbookRuntime}=await import("../src/research/handbook-collector.js");
 const {EventEmitter}=await import("node:events");
 let checked=false;
 const runtime=createNodeHandbookRuntime((options,callback)=>{
   assert.equal(options.method,"GET");assert.equal(options.hostname,"www.typescriptlang.org");assert.equal(options.servername,"www.typescriptlang.org");
   assert.equal(options.path,"/docs/handbook/2/everyday-types.html");assert.equal(options.rejectUnauthorized,true);assert.equal(options.port,443);assert.equal(options.family,4);
   assert.deepEqual(options.headers,{Accept:"text/html, text/plain","Accept-Encoding":"identity","User-Agent":"CoSeat-private-research/0"});
   assert.notEqual(options.agent,undefined);
   const lookup=options.lookup as (h:string,o:unknown,cb:(e:unknown,a:string,f:number)=>void)=>void;
   lookup("ignored",{},(error,address,family)=>{assert.equal(error,null);assert.equal(address,"93.184.215.14");assert.equal(family,4);checked=true;});
   const req=new EventEmitter() as import("node:http").ClientRequest;
   req.destroy=()=>req;
   req.end=(()=>{queueMicrotask(()=>callback({socket:{authorized:true,remoteAddress:"93.184.215.14",remotePort:443},statusCode:200,headers:{"content-type":"text/plain; charset=utf-8"},destroy(){},async *[Symbol.asyncIterator](){yield Buffer.from("hello");}} as unknown as import("node:http").IncomingMessage));return req;}) as typeof req.end;
   return req;
 });
 runtime.resolveIPv4=async()=>["93.184.215.14"];
 assert.equal((await collectHandbook(runtime)).utf8,"hello");assert.equal(checked,true);
});
test("Node rejects unauthorized or mismatched TLS peer",async()=>{
 const {createNodeHandbookRuntime}=await import("../src/research/handbook-collector.js");
 const {EventEmitter}=await import("node:events");
 for(const socket of [{authorized:false,remoteAddress:"93.184.215.14",remotePort:443},{authorized:true,remoteAddress:"93.184.215.15",remotePort:443},{authorized:true,remoteAddress:"93.184.215.14",remotePort:80}]) {
  let closed=false;
  const runtime=createNodeHandbookRuntime((_options,callback)=>{
    const req=new EventEmitter() as import("node:http").ClientRequest;req.destroy=()=>req;
    req.end=(()=>{queueMicrotask(()=>callback({socket,destroy(){closed=true;}} as unknown as import("node:http").IncomingMessage));return req;}) as typeof req.end;return req;
  });runtime.resolveIPv4=async()=>["93.184.215.14"];
  await assert.rejects(collectHandbook(runtime),/unverified_tls_peer/);assert.equal(closed,true);
 }
});
