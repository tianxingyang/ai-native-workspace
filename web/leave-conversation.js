import { bindText } from './language-ui.js';
import { ApiError, errorText } from './client.js';
import { text as t } from './presentation.js';

export function leaveConversation({ current, client, authorized, beforeOpen, left, refresh, invalidate, announce }) {
  const $ = id => document.getElementById(id), dialog = $('leave-dialog');
  let active;
  const valid = operation => operation.client === client() && operation.room.cacheIdentity === current()?.cacheIdentity
    && current()?.scope.canLeave && authorized('read', current());
  function close(restoreFocus = false) {
    const connection = active?.client; active = undefined;
    if (dialog.open) dialog.close();
    $('leave-name').textContent = ''; $('leave-status').textContent = '';
    if (restoreFocus) queueMicrotask(() => {
      if (active || connection !== client() || document.querySelector('dialog[open]')) return;
      const target = ['members-toggle', 'timeline', 'connect-button'].map($).find(node => node.getClientRects().length && !node.disabled);
      target?.focus({ preventScroll: true });
    });
  }
  function update() {
    $('leave-conversation').hidden = !current()?.scope.canLeave || !authorized('read', current());
    if (active && !valid(active)) {
      const pending = Boolean(active.pending); close(true);
      if (pending) announce(() => t('leave.unconfirmedEnded'));
    }
  }
  function open() {
    const room = current(), connection = client();
    if (!room?.scope.canLeave || !connection || !authorized('read', room)) return;
    beforeOpen(); close(); active = { room, client: connection, busy: false, pending: null };
    $('leave-name').textContent = room.scope.title ?? room.scope.conversationId;
    $('leave-submit').disabled = false; $('leave-close').disabled = false; bindText($('leave-submit'), () => t('leave.confirm'));
    dialog.showModal(); $('leave-close').focus();
  }
  async function submit() {
    const operation = active;
    if (!operation || operation.busy || !valid(operation)) { update(); return; }
    operation.pending ??= { conversationId: operation.room.scope.conversationId, threadId: operation.room.scope.threadId,
      expectedMembershipGeneration: operation.room.scope.membershipGeneration, clientEventId: crypto.randomUUID() };
    operation.busy = true; $('leave-submit').disabled = true; $('leave-close').disabled = true; bindText($('leave-status'), () => t('leave.sending'));
    try {
      await operation.client.request('/memberships/leave', operation.pending);
      // A confirmed outcome applies even after closing the dialog, but only to
      // the captured connection/cache identity, never a rejoined generation.
      if (active === operation) close();
      if (left(operation.client, operation.room)) announce(() => t('leave.done'));
    } catch (error) {
      if (operation.client !== client()) return;
      if (error instanceof ApiError && error.status === 401) { invalidate(error); return; }
      if (active !== operation) return;
      const uncertain = !(error instanceof ApiError) || error.status >= 500;
      bindText($('leave-status'), () => uncertain ? t('leave.uncertain') : errorText(error));
      if (!uncertain) operation.pending = null;
      $('leave-submit').disabled = !uncertain;
      bindText($('leave-submit'), () => t(uncertain ? 'leave.retry' : 'leave.confirm'));
      $('leave-status').tabIndex = -1; $('leave-status').focus();
      if (!uncertain) void refresh();
    } finally {
      if (active === operation) { operation.busy = false; $('leave-close').disabled = false; }
    }
  }
  $('leave-conversation').addEventListener('click', open);
  $('leave-submit').addEventListener('click', () => void submit());
  $('leave-close').addEventListener('click', () => { if (!active?.busy) close(true); });
  dialog.addEventListener('cancel', event => { event.preventDefault(); if (!active?.busy) close(true); });
  dialog.addEventListener('keydown', event => {
    if (event.key !== 'Tab') return;
    const targets = [...dialog.querySelectorAll('button,[tabindex]')].filter(node => !node.disabled && node.tabIndex >= 0);
    if (!targets.length) { event.preventDefault(); return; }
    const first = targets[0], last = targets.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
  return { close, update, get opened() { return dialog.open; }, get unconfirmed() { return Boolean(active?.pending); } };
}
