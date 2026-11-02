import { setTimeout as delay } from 'node:timers/promises';
import { InMemoryCredentialStore, InMemoryModelsStore, fauxAssistantMessage, fauxProvider, fauxToolCall, type TranscriptContext } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { requireCondition } from '../contracts.js';
import { fixtureResult } from './fake.js';
import type { PiModelFactory } from './pi.js';

function requireToolResult(context: TranscriptContext, name: string): void {
  const result = context.messages.findLast(message => message.role === 'toolResult' && message.toolName === name);
  requireCondition(result?.role === 'toolResult' && !result.isError, 500, `fixture_tool_failed_${name}`);
}
/** Scripted model, real SDK loop and real HTTP tools. No network model or credentials. */
export function fixturePiModel(delayMs = 0): PiModelFactory {
  return async () => {
    const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
    const faux = fauxProvider({ provider: 'coseat-fixture', models: [{ id: 'scripted-research', contextWindow: 32000, maxTokens: 4000 }], tokensPerSecond: 0 });
    runtime.registerNativeProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall('read_messages', {})),
      (context) => { requireToolResult(context, 'read_messages'); return fauxAssistantMessage(fauxToolCall('claim_task', {})); },
      async (context, options) => {
        requireToolResult(context, 'claim_task');
        await delay(delayMs, undefined, { ...(options?.signal ? { signal: options.signal } : {}) });
        return fauxAssistantMessage(fauxToolCall('send_message', { result: JSON.parse(JSON.stringify(fixtureResult())) }));
      },
      (context) => { requireToolResult(context, 'send_message'); return fauxAssistantMessage('Synthetic research returned to the authorized source thread.'); },
    ]);
    return { runtime, model: faux.getModel(), callCount: () => faux.state.callCount };
  };
}
