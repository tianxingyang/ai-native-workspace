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

/** Initialize explicitly marked static slots; never replace rich content or form values. */
export function applyStaticText(root, view = presentation) {
  for (const node of root.querySelectorAll('[data-i18n]')) {
    if (node.childElementCount || ['INPUT', 'TEXTAREA', 'SELECT'].includes(node.tagName)) throw new Error('Presentation text requires a leaf text slot');
    node.textContent = view.text(node.getAttribute('data-i18n'));
  }
  for (const attribute of ['aria-label', 'placeholder', 'title']) {
    for (const node of root.querySelectorAll(`[data-i18n-${attribute}]`)) {
      node.setAttribute(attribute, view.text(node.getAttribute(`data-i18n-${attribute}`)));
    }
  }
}
