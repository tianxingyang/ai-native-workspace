import { ApiError, errorText } from './client.js';
import { text as t } from './presentation.js';
import { bindText } from './language-ui.js';

/** Creation retries retain the original parent, membership generation, event and title. */
export function discussionThreads({ current, client, now, authorized, parent, beforeOpen, refresh, enter, invalidate, announce }) {
  const $ = id => document.getElementById(id), dialog = $('thread-create');
  let active, timer;
  const canCreate = room => room && !room.scope.parent && room.scope.createThreadUntil > now() && authorized('read', room) && authorized('send', room);
  const valid = operation => operation.client === client() && operation.room.cacheIdentity === current()?.cacheIdentity && canCreate(current());
  function close(restoreFocus = false) {
    const connection = active?.client; active = undefined;
    if (dialog.open) dialog.close();
    $('thread-create-name').value = ''; $('thread-create-status').textContent = ''; $('thread-create-parent').textContent = '';
    if (restoreFocus) queueMicrotask(() => {
      if (active || connection !== client() || document.querySelector('dialog[open]')) return;
      ['create-thread', 'room-title', 'connect-button'].map($).find(node => node.getClientRects().length && !node.disabled)?.focus({ preventScroll: true });
    });
  }
  function update() {
    clearTimeout(timer);
    const room = current(), available = canCreate(room), owner = parent(room);
    $('create-thread').hidden = !available;
    $('parent-thread').hidden = !owner || !authorized('read', owner);
    $('thread-toolbar').hidden = $('create-thread').hidden && $('parent-thread').hidden;
    bindText($('parent-thread'), () => owner ? t('threads.back', { title: owner.scope.title ?? owner.scope.conversationId }) : '');
    if (active && !valid(active)) {
      const pending = Boolean(active.pending); close(true);
      if (pending) announce(() => t('threads.unconfirmedEnded'));
    }
    if (available) timer = setTimeout(update, Math.min(2147483647, Math.max(1, room.scope.createThreadUntil - now())));
  }
  function open() {
    const room = current(), connection = client();
    if (!connection || !canCreate(room)) return;
    beforeOpen(); close(); active = { room, client: connection, busy: false, pending: null };
    bindText($('thread-create-parent'), () => t('threads.parent', { title: room.scope.title ?? room.scope.conversationId }));
    $('thread-create-name').disabled = false; $('thread-create-save').disabled = false;
    $('thread-create-close').disabled = false; bindText($('thread-create-save'), () => t('threads.submit'));
    dialog.showModal(); $('thread-create-name').focus();
  }
  async function submit() {
    const operation = active;
    if (!operation || operation.busy || !valid(operation)) { update(); return; }
    const title = $('thread-create-name').value.trim();
    if (!operation.pending && (!title || /[\u0000-\u001f\u007f\p{Surrogate}]/u.test(title))) {
      bindText($('thread-create-status'), () => t('threads.invalidTitle')); $('thread-create-name').focus(); return;
    }
    operation.pending ??= { conversationId: operation.room.scope.conversationId, threadId: operation.room.scope.threadId,
      title, expectedMembershipGeneration: operation.room.scope.membershipGeneration, clientEventId: crypto.randomUUID() };
    operation.busy = true; $('thread-create-name').disabled = true; $('thread-create-save').disabled = true;
    $('thread-create-close').disabled = true; bindText($('thread-create-status'), () => t('threads.sending'));
    try {
      const result = await operation.client.request('/threads', operation.pending);
      if (active !== operation || !valid(operation)) { update(); return; }
      // Fresh discovery supplies permissions; the receipt never inserts a room.
      if (!await refresh() || active !== operation || !valid(operation)) {
        if (active === operation && valid(operation)) throw new Error('thread_discovery_failed');
        update(); return;
      }
      if (!enter(result.thread)) throw new Error('thread_discovery_failed');
      close(); announce(() => t('threads.created')); $('room-title').focus({ preventScroll: true });
    } catch (error) {
      if (active !== operation || !valid(operation)) { update(); return; }
      if (error instanceof ApiError && error.status === 401) { invalidate(error); return; }
      const uncertain = !(error instanceof ApiError) || error.status >= 500;
      bindText($('thread-create-status'), () => uncertain ? t('threads.uncertain') : errorText(error));
      if (!uncertain) operation.pending = null;
      const ended = error instanceof ApiError && [403, 409].includes(error.status);
      $('thread-create-name').disabled = uncertain || ended; $('thread-create-save').disabled = ended;
      bindText($('thread-create-save'), () => t(uncertain ? 'threads.retry' : 'threads.submit'));
      $('thread-create-status').tabIndex = -1; $('thread-create-status').focus();
      if (ended) void refresh();
    } finally {
      if (active === operation) { operation.busy = false; $('thread-create-close').disabled = false; }
    }
  }
  $('create-thread').addEventListener('click', open);
  $('parent-thread').addEventListener('click', () => { const room = parent(current()); if (room && authorized('read', room)) enter(room.scope); });
  $('thread-create-form').addEventListener('submit', event => { event.preventDefault(); void submit(); });
  $('thread-create-close').addEventListener('click', () => { if (!active?.busy) close(true); });
  dialog.addEventListener('cancel', event => { event.preventDefault(); if (!active?.busy) close(true); });
  dialog.addEventListener('keydown', event => {
    if (event.key !== 'Tab') return;
    const targets = [...dialog.querySelectorAll('button,input,[tabindex]')].filter(node => !node.disabled && node.tabIndex >= 0 && node.getClientRects().length);
    if (!targets.length) { event.preventDefault(); return; }
    const first = targets[0], last = targets.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
  return { close, update, get opened() { return dialog.open; } };
}
