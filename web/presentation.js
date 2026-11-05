import { catalogs, fallbackId } from './locales/registry.js';

const own = (object, key) => object && Object.hasOwn(object, key);
const parameters = value => [...new Set([...value.matchAll(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g)].map(match => match[1]))].sort().join(',');

function validate(catalog, fallback) {
  if (!catalog || typeof catalog.locale !== 'string' || !catalog.messages || !catalog.formats) throw new Error('Invalid presentation catalog');
  new Intl.DateTimeFormat(catalog.locale);
  for (const [key, value] of Object.entries(catalog.messages)) {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`Invalid presentation message: ${key}`);
    if (fallback && own(fallback.messages, key) && parameters(value) !== parameters(fallback.messages[key])) throw new Error(`Mismatched presentation parameters: ${key}`);
  }
  for (const [key, value] of Object.entries(catalog.formats)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid presentation format: ${key}`);
    new Intl.DateTimeFormat(catalog.locale, value);
  }
}

/** Pure presentation boundary. Callers render returned strings as text, never HTML.
 * Catalog selection is internal until the remaining UI resources and product languages are decided. */
export function createPresentation(catalog, fallback = catalog) {
  validate(fallback); validate(catalog, fallback);
  // A caller cannot mutate a registered catalog underneath an active view.
  catalog = structuredClone(catalog); fallback = structuredClone(fallback);
  const { locale } = catalog;
  const source = (section, key) => own(catalog[section], key) ? catalog : own(fallback[section], key) ? fallback : null;
  return {
    locale,
    messageLocale(key) { return source('messages', key)?.locale ?? locale; },
    text(key, parameters = {}) {
      const selected = source('messages', key);
      if (!selected) throw new Error(`Unknown presentation key: ${key}`);
      return selected.messages[key].replace(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g, (_, name) => {
        if (!Object.hasOwn(parameters, name)) throw new Error(`Missing presentation parameter: ${name}`);
        return String(parameters[name]);
      });
    },
    format(name, timestamp) {
      const selected = source('formats', name);
      if (!selected) throw new Error(`Unknown presentation format: ${name}`);
      // Re-resolve the machine time zone on each call, as the previous Date helpers did.
      return new Intl.DateTimeFormat(locale, selected.formats[name]).format(new Date(timestamp));
    },
  };
}

/** Explicit in-memory selection among bundled catalogs; no preference, identity or content storage. */
export function createLanguageRegistry(entries, fallback, selected = fallback) {
  const source = entries.find(entry => entry.id === fallback)?.catalog;
  if (!source) throw new Error('Missing fallback catalog');
  const views = new Map(), choices = [];
  for (const entry of entries) {
    if (typeof entry.id !== 'string' || !/^[a-zA-Z0-9-]+$/.test(entry.id) || views.has(entry.id) || typeof entry.label !== 'string' || !entry.label.trim()) throw new Error('Invalid language registration');
    views.set(entry.id, createPresentation(entry.catalog, source));
    choices.push(Object.freeze({ id: entry.id, label: entry.label, locale: entry.catalog.locale }));
  }
  let id = views.has(selected) ? selected : fallback, locked = null;
  const listeners = new Set();
  const api = {
    get id() { return id; }, get locale() { return views.get(id).locale; }, get locked() { return locked; },
    choices: Object.freeze(choices),
    text: (...args) => views.get(id).text(...args),
    format: (...args) => views.get(id).format(...args),
    messageLocale: key => views.get(id).messageLocale(key),
    select(next) {
      if (!views.has(next)) throw new Error('Unregistered language');
      if (locked !== null && next !== locked) throw new Error('Desktop language requires a rebuild');
      if (next === id) return false;
      id = next;
      for (const listener of listeners) listener();
      return true;
    },
    lock(next) {
      if (locked !== null && locked !== next) throw new Error('Desktop language already locked');
      if (!views.has(next)) throw new Error('Unregistered desktop language');
      // Lock before notifying views, so no intermediate mismatched selection is possible.
      locked = next; api.select(next);
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
  return Object.freeze(api);
}

export const presentation = createLanguageRegistry(catalogs, fallbackId);
export const text = presentation.text;

/** Initialize explicitly marked static slots; never replace rich content or form values. */
export function applyStaticText(root, view = presentation) {
  for (const node of root.querySelectorAll('[data-i18n]')) {
    if (node.childElementCount || ['INPUT', 'TEXTAREA', 'SELECT'].includes(node.tagName)) throw new Error('Presentation text requires a leaf text slot');
    node.textContent = view.text(node.getAttribute('data-i18n'));
    node.lang = view.messageLocale?.(node.getAttribute('data-i18n')) ?? view.locale;
  }
  for (const attribute of ['aria-label', 'placeholder', 'title']) {
    for (const node of root.querySelectorAll(`[data-i18n-${attribute}]`)) {
      node.setAttribute(attribute, view.text(node.getAttribute(`data-i18n-${attribute}`)));
    }
  }
}
