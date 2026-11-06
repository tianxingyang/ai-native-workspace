import type { ModelRuntime } from '@earendil-works/pi-coding-agent';

/** Session-scoped facade: keep SDK request options and auth on the original
 * runtime, then admit after its complete asynchronous header transform.
 * Do not mutate a factory runtime that another session may also use. */
export function withPiRequestAdmission(runtime: ModelRuntime, admit: () => Promise<void>): ModelRuntime {
  const streamSimple: ModelRuntime['streamSimple'] = (model, context, options) => runtime.streamSimple(model, context, {
    ...options,
    transformHeaders: async headers => {
      const transformed = options?.transformHeaders ? await options.transformHeaders(headers) : headers;
      options?.signal?.throwIfAborted();
      await admit();
      options?.signal?.throwIfAborted();
      return transformed;
    },
  });
  return new Proxy(runtime, {
    get(target, property) {
      if (property === 'streamSimple') return streamSimple;
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
