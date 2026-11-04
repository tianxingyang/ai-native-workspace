import demoCatalog from './locales/zh-CN.js';

/** Pure presentation boundary. Callers render returned strings as text, never HTML.
 * Catalog selection is internal until the remaining UI resources and product languages are decided. */
export function createPresentation(catalog) {
  const { locale, messages, formats } = catalog;
  return {
    locale,
    text(key, parameters = {}) {
      if (!Object.hasOwn(messages, key) || typeof messages[key] !== 'string') throw new Error(`Unknown presentation key: ${key}`);
      return messages[key].replace(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g, (_, name) => {
        if (!Object.hasOwn(parameters, name)) throw new Error(`Missing presentation parameter: ${name}`);
        return String(parameters[name]);
      });
    },
    format(name, timestamp) {
      if (!Object.hasOwn(formats, name)) throw new Error(`Unknown presentation format: ${name}`);
      // Re-resolve the machine time zone on each call, as the previous Date helpers did.
      return new Intl.DateTimeFormat(locale, formats[name]).format(new Date(timestamp));
    },
  };
}

export const presentation = createPresentation(demoCatalog);
export const text = presentation.text;
