import { ApiError, errorText } from './client.js';
import { text as t } from './presentation.js';

/** Content stays in this connection's memory; no object/public URLs or HTML parsing. */
export function attachments({ current, client, authorized, changed, deny, invalidate }) {
  const $ = id => document.getElementById(id), dialog = $('attachment-view');
  let selection = 0, loading = false, preview = null, chooser, reading;
  const sameRoom = room => current()?.cacheIdentity === room?.cacheIdentity && authorized('read', current());
  function close(restoreFocus = true) {
    const previous = preview;
    preview = null; $('attachment-content').textContent = ''; $('attachment-title').textContent = ''; $('attachment-status').textContent = '';
    if (dialog.open) dialog.close();
    if (previous && restoreFocus) queueMicrotask(() => {
      if (preview || previous.client !== client() || document.querySelector('dialog[open]')) return;
      const target = sameRoom(previous.room) && [...document.querySelectorAll('[data-action]')].find(node => node.dataset.action === `attachment-${previous.id}`);
      const fallback = ['timeline', 'create-conversation', 'manage-conversation', 'connect-button'].map($).find(node => !node.disabled && node.getClientRects().length);
      (target || fallback)?.focus({ preventScroll: true });
    });
  }
  function reset() {
    selection++; loading = false; reading = undefined; $('attachment-file').value = ''; $('attachment-error').textContent = '';
    $('attachment-draft').hidden = true; $('attachment-name').textContent = ''; close(false);
  }
  function update() {
    const room = current(), file = room?.attachment;
    if (reading && (!sameRoom(reading.room) || reading.connection !== client() || !authorized('send', room))) {
      selection++; loading = false; reading = undefined;
    }
    $('attach').disabled = !room || !authorized('send', room) || Boolean(room.pending) || loading;
    $('attachment-remove').disabled = !room || Boolean(room.pending) || loading;
    $('attachment-draft').hidden = !file;
    $('attachment-name').textContent = file ? t('attachment.selected', { name: file.name, bytes: new TextEncoder().encode(file.text).length }) : '';
    if (preview) {
      const message = room?.messages.find(message => message.id === preview.id);
      if (!sameRoom(preview.room) || client() !== preview.client || !message?.attachment || message.retracted || message.invalidated || message.revision !== preview.revision) close();
    }
  }
  $('attach').addEventListener('click', () => {
    chooser = { room: current(), connection: client(), selection: ++selection };
    $('attachment-file').click();
  });
  $('attachment-remove').addEventListener('click', () => { if (current() && !current().pending) current().attachment = undefined; reset(); changed(); $('attach').focus(); });
  $('attachment-file').addEventListener('change', async () => {
    const started = chooser; chooser = undefined;
    const valid = !started || started.selection === selection;
    const room = started?.room ?? current(), connection = started?.connection ?? client(), file = $('attachment-file').files[0], choice = ++selection;
    loading = false; reading = undefined;
    $('attachment-file').value = ''; $('attachment-error').textContent = '';
    if (!valid || !file || !room || !sameRoom(room) || connection !== client() || current().pending || !authorized('send', current())) { changed(); return; }
    reading = { room, connection }; loading = true; changed();
    try {
      if (!file.size || file.size > 8192 || file.name.length > 120 || file.name.trim() !== file.name
          || !/\S\.(txt|md)$/i.test(file.name) || /[\\/\x00-\x1f\x7f<>:"|?*\u202a-\u202e\u2066-\u2069]/u.test(file.name)) throw new Error('invalid_file');
      // Keep an initial UTF-8 BOM as text; do not silently replace malformed bytes.
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await file.arrayBuffer());
      if (!text || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(text)) throw new Error('invalid_file');
      if (choice !== selection || !sameRoom(room) || connection !== client() || !authorized('send', current()) || current().pending) return;
      current().attachment = { name: file.name, text };
    } catch {
      if (choice === selection && sameRoom(room) && connection === client()) $('attachment-error').textContent = t('attachment.invalid');
    } finally { if (choice === selection) { loading = false; reading = undefined; changed(); } }
  });
  async function open(room, message) {
    if (!sameRoom(room) || !message.attachment) return;
    close(false);
    const operation = preview = { room, id: message.id, revision: message.revision, client: client() };
    $('attachment-title').textContent = message.attachment.name; $('attachment-status').textContent = t('attachment.loading');
    dialog.showModal(); $('attachment-close').focus();
    try {
      const result = await operation.client.attachment(room.scope, message.id);
      update(); if (preview !== operation) return;
      $('attachment-content').textContent = result.text; $('attachment-status').textContent = t('attachment.note');
    } catch (error) {
      if (operation.client !== client()) return;
      if (error instanceof ApiError && error.status === 401) { invalidate(error); return; }
      if (error instanceof ApiError && error.status === 403) { deny(operation.client, room); update(); return; }
      update(); if (preview !== operation) return;
      $('attachment-content').textContent = ''; $('attachment-status').textContent = errorText(error);
    }
  }
  $('attachment-close').addEventListener('click', () => close());
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  dialog.addEventListener('keydown', event => {
    if (event.key !== 'Tab') return;
    const first = $('attachment-content'), last = $('attachment-close');
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
  return { open, update, reset, get loading() { return loading; }, get opened() { return dialog.open; } };
}
