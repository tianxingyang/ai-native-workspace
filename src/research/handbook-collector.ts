import { lookup } from "node:dns/promises";
import { Agent, request, type RequestOptions } from "node:https";
import { isIP } from "node:net";
import type { IncomingMessage, ClientRequest } from "node:http";
import type { TLSSocket } from "node:tls";

export const HANDBOOK_DOCUMENT = "https://www.typescriptlang.org/docs/handbook/2/everyday-types.html";
export const DOCUMENT_BYTE_LIMIT = 512 * 1024;
export interface DocumentResponse {
  status: number; headers: Record<string, string | string[] | undefined>;
  body: AsyncIterable<Uint8Array>; close(): void;
}
export interface HandbookRuntime {
  resolveIPv4(): Promise<string[]>;
  openPinned(address: string, signal: AbortSignal): Promise<DocumentResponse>;
}
export function publicIPv4(address: string): boolean {
  if (isIP(address) !== 4) return false;
  const [a,b,c] = address.split(".").map(Number) as [number,number,number,number];
  return !(a===0 || a===10 || a===127 || a>=224 || (a===100 && b>=64 && b<=127) ||
    (a===169 && b===254) || (a===172 && b>=16 && b<=31) || (a===192 && (b===168 || (b===0 && (c===0 || c===2)) || (b===88 && c===99))) ||
    (a===198 && (b===18 || b===19 || (b===51 && c===100))) || (a===203 && b===0 && c===113));
}
type Request = (options: RequestOptions, callback: (response: IncomingMessage) => void) => ClientRequest;
/** Injection is trusted host code only; never a model-facing transport capability. */
export function createNodeHandbookRuntime(send: Request = request): HandbookRuntime {
  return {
    resolveIPv4: async () => (await lookup("www.typescriptlang.org",{family:4,all:true})).map(r=>r.address),
    openPinned: (address,signal) => new Promise((resolve,reject) => {
      if (!publicIPv4(address) || signal.aborted) { reject(new Error("inadmissible_connection")); return; }
      const agent = new Agent({keepAlive:false,maxCachedSessions:0,proxyEnv:{}});
      let req: ClientRequest | undefined;
      let response: IncomingMessage | undefined;
      const close = () => { response?.destroy(); req?.destroy(); agent.destroy(); };
      try {
        req = send({
          protocol:"https:",hostname:"www.typescriptlang.org",servername:"www.typescriptlang.org",
          port:443,path:"/docs/handbook/2/everyday-types.html",method:"GET",family:4,
          agent,signal,rejectUnauthorized:true,maxHeaderSize:8192,
          lookup: (_hostname,_options,callback) => callback(null,address,4),
          headers:{Accept:"text/html, text/plain","Accept-Encoding":"identity","User-Agent":"CoSeat-private-research/0"},
        }, res => {
          response = res;
          const socket = res.socket as TLSSocket;
          if (signal.aborted || !socket.authorized || socket.remoteAddress !== address || socket.remotePort !== 443) {
            close(); reject(new Error("unverified_tls_peer")); return;
          }
          resolve({status:res.statusCode ?? 0,headers:res.headers,body:res,close});
        });
        req.on("error",error=>{close();reject(error);});
        req.end();
      } catch (error) { close(); reject(error); }
    }),
  };
}
const nodeRuntime = createNodeHandbookRuntime();
export async function collectHandbook(
  runtime: HandbookRuntime = nodeRuntime,
  options: {signal?: AbortSignal; timeoutMs?: number} = {},
): Promise<{url: typeof HANDBOOK_DOCUMENT; mediaType:"text/html"|"text/plain"; utf8:string; bytes:number}> {
  const timeout = options.timeoutMs ?? 8000;
  if (!Number.isSafeInteger(timeout) || timeout<1 || timeout>8000) throw new Error("invalid_timeout");
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort",abort,{once:true});
  if (options.signal?.aborted) abort();
  const timer = setTimeout(abort,timeout);
  let response: DocumentResponse | undefined;
  let rejectAbort!: (error: Error) => void;
  const aborted = new Promise<never>((_,reject)=>{rejectAbort=reject;});
  const onAbort = () => { response?.close(); rejectAbort(new Error("collection_aborted")); };
  controller.signal.addEventListener("abort",onAbort,{once:true});
  const work = async () => {
    if (controller.signal.aborted) throw new Error("collection_aborted");
    const addresses = await runtime.resolveIPv4();
    if (controller.signal.aborted) throw new Error("collection_aborted");
    if (!addresses.length || addresses.length>32 || addresses.some(a=>!publicIPv4(a))) throw new Error("non_public_dns");
    const opened = await runtime.openPinned(addresses[0]!,controller.signal);
    if (controller.signal.aborted) { opened.close(); throw new Error("collection_aborted"); }
    response=opened;
    if (opened.status!==200) throw new Error("invalid_status");
    const type=opened.headers["content-type"];
    const match=typeof type==="string" ? /^(text\/html|text\/plain)\s*;\s*charset\s*=\s*(?:"utf-8"|utf-8)\s*$/i.exec(type) : null;
    if (!match) throw new Error("invalid_content_type");
    const encoding=opened.headers["content-encoding"];
    if (encoding!==undefined && encoding!=="identity") throw new Error("unsupported_encoding");
    const length=opened.headers["content-length"];
    if (length!==undefined && (typeof length!=="string" || !/^\d+$/.test(length) || Number(length)>DOCUMENT_BYTE_LIMIT)) throw new Error("invalid_content_length");
    const chunks: Buffer[]=[]; let bytes=0;
    for await (const chunk of opened.body) {
      if (controller.signal.aborted) throw new Error("collection_aborted");
      bytes+=chunk.byteLength;
      if (bytes>DOCUMENT_BYTE_LIMIT) throw new Error("document_too_large");
      chunks.push(Buffer.from(chunk));
    }
    if (controller.signal.aborted) throw new Error("collection_aborted");
    if (!bytes || (length!==undefined && bytes!==Number(length))) throw new Error("incomplete_document");
    const utf8=new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(chunks));
    return {url:HANDBOOK_DOCUMENT as typeof HANDBOOK_DOCUMENT,mediaType:match[1]!.toLowerCase() as "text/html"|"text/plain",utf8,bytes};
  };
  try { return await Promise.race([work(),aborted]); }
  finally {clearTimeout(timer);options.signal?.removeEventListener("abort",abort);controller.signal.removeEventListener("abort",onAbort);response?.close();}
}
