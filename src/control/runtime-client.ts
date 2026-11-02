import type { CancelReceipt, RuntimeCapabilities, RuntimeEvent, RuntimeInput, WorkPackage } from '../contracts.js';
import { requestJson } from '../http.js';
export class RuntimeClient {
  constructor(private readonly url: string, private readonly token: string) {}
  capabilities() { return requestJson<RuntimeCapabilities>(this.url, this.token, '/capabilities'); }
  createSession(work: WorkPackage) { return requestJson<{ sessionId: string }>(this.url, this.token, '/sessions', { work }); }
  submitInput(id: string, input: RuntimeInput) { return requestJson<{ accepted: boolean }>(this.url, this.token, `/sessions/${id}/input`, { input }); }
  events(id: string, after: number) { return requestJson<{ events: RuntimeEvent[] }>(this.url, this.token, `/sessions/${id}/events?after=${after}`); }
  cancel(id: string) { return requestJson<CancelReceipt>(this.url, this.token, `/sessions/${id}/cancel`, {}); }
}
