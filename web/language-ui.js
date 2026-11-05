import { presentation } from './presentation.js';

// Resolvers belong to DOM nodes via weak keys. Removed messages/dialogs do not stay
// alive through the language registry, and changing language cannot recover them.
const resolvers = new WeakMap(), references = new Set();
let registrations = 0;
function track(node, resolve) {
  if (!resolvers.has(node)) references.add(new WeakRef(node));
  resolvers.set(node, resolve);
  if (++registrations % 256 === 0) prune();
}
function prune() {
  for (const reference of references) if (!reference.deref()) references.delete(reference);
}
export function bindText(node, value) {
  if (typeof value !== 'function') { node.textContent = value; return; }
  node.removeAttribute('lang');
  // Only this text node is replaced on selection; appended inputs, icons and
  // user content are never replaced or searched for matching translated strings.
  const slot = node.ownerDocument.createTextNode(value()); node.replaceChildren(slot);
  track(slot, () => { slot.nodeValue = value(); });
}
export function localizedText(document, resolve) {
  const slot = document.createTextNode(resolve());
  track(slot, () => { slot.nodeValue = resolve(); }); return slot;
}
export function bindAttribute(node, name, resolve) {
  if (!['title', 'placeholder', 'aria-label'].includes(name)) throw new Error('Unsupported presentation attribute');
  const key = `${name}Value`, bindings = node.__presentationAttributes ??= Object.create(null);
  bindings[key] = resolve;
  node.setAttribute(name, resolve());
  track(node, () => { for (const [key, value] of Object.entries(bindings)) node.setAttribute(key.slice(0, -5), value()); });
}
export function refreshBindings() {
  for (const reference of references) {
    const node = reference.deref();
    if (!node?.isConnected) { references.delete(reference); continue; }
    resolvers.get(node)?.();
  }
}
presentation.subscribe(refreshBindings);

export function bindStaticText(root) {
  for (const node of root.querySelectorAll('[data-i18n]')) {
    const key = node.getAttribute('data-i18n');
    bindText(node, () => { node.lang = presentation.messageLocale(key); return presentation.text(key); });
  }
  for (const name of ['title', 'placeholder', 'aria-label']) {
    for (const node of root.querySelectorAll(`[data-i18n-${name}]`)) bindAttribute(node, name, () => presentation.text(node.getAttribute(`data-i18n-${name}`)));
  }
}

export function installLanguageSelection(root, view = presentation) {
  const controls = [];
  for (const parent of root.querySelectorAll('[data-language-selection]')) {
    const label = root.createElement('label'), copy = root.createElement('span'), select = root.createElement('select');
    label.className = 'language-selection'; select.dataset.language = '';
    for (const choice of view.choices) { const option = root.createElement('option'); option.value = choice.id; option.textContent = choice.label; option.lang = choice.locale; select.append(option); }
    label.append(copy, select); parent.append(label); controls.push({ label, copy, select });
    select.addEventListener('change', () => { try { view.select(select.value); } finally { update(); } });
  }
  function update() {
    for (const { label, copy, select } of controls) {
      label.hidden = view.choices.length < 2 || view.locked !== null;
      copy.textContent = view.text('language.label'); select.setAttribute('aria-label', view.text('language.label')); select.value = view.id;
    }
  }
  update(); return view.subscribe(update);
}
