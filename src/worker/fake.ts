import { setTimeout as delay } from 'node:timers/promises';
import type { ResearchResult } from '../contracts.js';
import { fixtureSources } from '../dev-fixture.js';
import type { Execute } from './runtime.js';

export function fixtureResult(): ResearchResult {
  return {
    conclusion: '开发夹具结论：取消受理与实际停止分别记录；成员身份与运行会话分离。',
    sources: structuredClone(fixtureSources),
    limitations: ['合成资料，仅验证工程闭环；未访问互联网，不能作为真实调研结论。'],
    evidence: 'synthetic-fixture',
  };
}
export function fakeExecution(delayMs = 50): Execute {
  return async (_work, _input, tools, signal, output, onInputApplied) => {
    signal.throwIfAborted();
    // The fixture starts processing this input here, before invoking its tools.
    onInputApplied();
    await tools.readMessages();
    await tools.claimTask();
    await delay(delayMs, undefined, { signal });
    const result = fixtureResult();
    const receipt = await tools.sendMessage(result);
    output({ result, receiptId: receipt.receiptId, evidenceLevel: 'fake_adapter' });
  };
}
