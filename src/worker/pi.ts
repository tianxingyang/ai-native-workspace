import { resolve } from 'node:path';
import { Type } from 'typebox';
import type { Model } from '@earendil-works/pi-ai';
import { createAgentSession, createExtensionRuntime, ModelRuntime, SessionManager, SettingsManager, type ResourceLoader, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { objectValue, requireCondition, resultValue, stringValue } from '../contracts.js';
import type { Execute } from './runtime.js';
import { ContextCompiler } from './context-compiler.js';
import { withPiRequestAdmission } from './pi-request-admission.js';

export interface PiModelConfig { runtime: ModelRuntime; model: Model<string>; callCount?: () => number }
export type PiModelFactory = () => Promise<PiModelConfig>;

/** Actual pinned SDK integration. The model is injected explicitly; no ambient provider selection. */
export function piExecution(modelFactory: PiModelFactory, workspace: string): Execute {
  return async (work, input, tools, signal, output, onInputApplied) => {
    const compiler = new ContextCompiler();
    const context = compiler.compile(work, input, signal);
    work = context.work; input = context.input;
    const { runtime, model, callCount } = await modelFactory();
    compiler.compile(work, input, signal);
    await tools.prepareExecution();
    let requestAdmitted = false;
    let admissionFailure: { error: unknown } | undefined;
    const requestRuntime = withPiRequestAdmission(runtime, async () => {
      try {
        // ModelRuntime resolves request auth after transformContext. Its final
        // headers hook runs after that auth and the SDK's async headers hook.
        if (!requestAdmitted) { await tools.prepareExecution(); requestAdmitted = true; }
        tools.assertActive(); signal.throwIfAborted();
      } catch (error) {
        // lazyStream converts admission errors to SDK assistant error messages.
        // Preserve the rejection even when a concurrent publisher has a receipt.
        admissionFailure ??= { error }; throw error;
      }
    });
    const resourceLoader: ResourceLoader = {
      getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
      getSkills: () => ({ skills: [], diagnostics: [] }),
      getPrompts: () => ({ prompts: [], diagnostics: [] }),
      getThemes: () => ({ themes: [], diagnostics: [] }),
      getAgentsFiles: () => ({ agentsFiles: [] }),
      getSystemPrompt: () => context.systemPrompt,
      getSystemPromptSource: () => undefined, getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [],
      extendResources: () => {}, reload: async () => {},
    };
    const toolResult = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }], details: {} });
    const customTools: ToolDefinition[] = [
      { name: 'read_messages', label: 'Read source thread', description: 'Read only this run’s authorized source thread.', parameters: Type.Object({}), execute: async () => toolResult(await tools.readMessages()) },
      { name: 'claim_task', label: 'Confirm research claim', description: 'Idempotently confirm this source’s research claim.', parameters: Type.Object({}), execute: async () => toolResult(await tools.claimTask()) },
      { name: 'send_message', label: 'Return sourced result', description: 'Publish once to the bound source thread. Include synthetic sources and limitations.', parameters: Type.Object({ result: Type.Unknown() }), execute: async (_id, args) => toolResult(await tools.sendMessage(resultValue(objectValue(args).result))) },
      { name: 'request_approval', label: 'Request approval', description: 'Record a pending request. This never grants permission or resumes execution.', parameters: Type.Object({ action: Type.String(), reason: Type.String() }), execute: async (_id, args) => toolResult(await tools.requestApproval(stringValue(objectValue(args).action, 'action', 128), stringValue(objectValue(args).reason, 'reason', 1000))) },
    ];
    const { session } = await createAgentSession({
      cwd: resolve(workspace), agentDir: resolve(workspace, 'sdk-state-unused'),
      modelRuntime: requestRuntime, model, thinkingLevel: 'off', resourceLoader,
      tools: [...work.tools], customTools,
      sessionManager: SessionManager.inMemory(resolve(workspace)),
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false, provider: { maxRetries: 0 } }, cacheWarming: 'off', enableAnalytics: false, enableInstallTelemetry: false }),
    });
    const activeTools = session.getActiveToolNames().sort();
    const transformContext = session.agent.transformContext;
    let admitted = false;
    session.agent.transformContext = async (messages, requestSignal) => {
      const transformed = transformContext ? await transformContext(messages, requestSignal) : messages;
      // Keep the early context check; request auth and headers still await
      // afterwards, so the request-runtime facade also checks before dispatch.
      if (!admitted) { await tools.prepareExecution(); admitted = true; }
      tools.assertActive();
      requestSignal?.throwIfAborted();
      return transformed;
    };
    const sdkEvents: string[] = [];
    const unsubscribe = session.subscribe(event => {
      // An abort during asynchronous prompt preflight can precede the SDK's
      // active run. Reassert it at this boundary, before the first model call.
      // Do not await abort here: it waits for this same run to settle.
      if (event.type === 'agent_start' && signal.aborted) void session.abort();
      // pi 1.4.0 appends to agent state before delivering message_end. A prompt
      // invocation or preflight callback alone does not establish application.
      if (event.type === 'message_end' && event.message.role === 'user') {
        const content = event.message.content;
        const text = typeof content === 'string' ? content : content.filter(part => part.type === 'text').map(part => part.text).join('');
        if (text === input.text) {
          sdkEvents.push('user_message_end');
          onInputApplied();
        }
      }
      if (['tool_execution_start', 'tool_execution_end', 'agent_settled'].includes(event.type)) sdkEvents.push(event.type);
    });
    const abort = () => { void session.abort(); };
    signal.addEventListener('abort', abort, { once: true });
    try {
      requireCondition(JSON.stringify(activeTools) === JSON.stringify([...work.tools].sort()), 500, 'unexpected_sdk_tool_set');
      signal.throwIfAborted();
      await session.prompt(input.text);
      await session.waitForIdle();
      signal.throwIfAborted();
      if (admissionFailure) throw admissionFailure.error;
      requireCondition(Boolean(tools.receiptId), 409, 'sdk_did_not_publish');
      output({ text: session.getLastAssistantText() ?? '', receiptId: tools.receiptId, sdkEvents, activeTools, modelCalls: callCount?.() ?? null, evidenceLevel: 'real_sdk_with_injected_model' });
    } finally {
      // Stop confirmation is emitted only after the SDK and awaited tools settle.
      signal.removeEventListener('abort', abort);
      await session.abort();
      unsubscribe(); session.dispose();
    }
  };
}
