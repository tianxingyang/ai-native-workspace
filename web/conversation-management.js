import { ApiError, errorText } from './client.js';
import { text as t } from './presentation.js';

const $ = id => document.getElementById(id);
const same = (a, b) => a?.conversationId === b?.conversationId && a?.threadId === b?.threadId;
const node = (tag, text) => { const element = document.createElement(tag); if (text !== undefined) element.textContent = text; return element; };
const option = (value, text) => { const element = node('option', text); element.value = value; return element; };
const localDate = time => new Date(time - new Date(time).getTimezoneOffset() * 60000).toISOString().slice(0, 19);

/** All drafts and frozen retry requests live only in this dialog instance. */
export function conversationManagement({ client, session, now, refresh, invalidate, beforeOpen, announce }) {
  const dialog = $('conversation-management'), fields = $('management-fields'), save = $('management-save'), status = $('management-status');
  let active = null, expiryTimer;
  const current = operation => active === operation && client() === operation.client && dialog.open;
  function close() {
    const rename = active?.mode === 'rename';
    clearTimeout(expiryTimer); active = null; dialog.close(); fields.replaceChildren(); status.textContent = '';
    if (rename) {
      const target = ['manage-conversation', 'create-conversation', 'room-title', 'connect-button', 'token'].map($).find(element => element && !element.disabled && element.getClientRects().length);
      target?.focus();
    }
  }
  function field(label, control) { const wrapper = node('label', t(label)); wrapper.append(control); fields.append(wrapper); return control; }
  function actions(allowed, parent) {
    const list = node('div'); list.className = 'management-options'; parent.append(list);
    return allowed.map(action => {
      const label = node('label'), input = node('input'); input.type = 'checkbox'; input.value = action;
      label.append(input, t(`management.${action}`)); list.append(label); return input;
    });
  }
  function deadline(options) {
    if (!options?.allowedActions.length) return null;
    const input = node('input'); input.type = 'datetime-local'; input.step = '1'; input.max = localDate(options.expiresAt);
    input.value = input.max; input.required = true;
    return field('management.until', input);
  }
  function authorized(operation) {
    const management = session()?.management;
    if (!management) return false;
    if (operation.creationVersion !== management.creationVersion) return false;
    if (operation.directoryUntil && (operation.directoryUntil <= now() || management.createUntil <= now())) return false;
    if (operation.issueUntil && (operation.issueUntil <= now() || management.issueUntil <= now())) return false;
    return operation.mode === 'create' ? management.createUntil > now()
      : management.scopes.some(scope => same(scope, operation.scope) && scope.until > now() && scope.membershipGeneration === operation.scope.membershipGeneration);
  }
  function update() {
    if (active && !authorized(active)) close();
  }
  async function open(mode, selected) {
    beforeOpen(); close();
    const operation = { mode, client: client(), scope: selected ?? session()?.management?.scopes[0], creationVersion: session()?.management?.creationVersion, pending: null, busy: true };
    if (!operation.client || !authorized(operation)) return;
    active = operation; fields.disabled = true; save.disabled = true; save.hidden = false;
    $('management-title').textContent = t(`management.${mode}`);
    status.textContent = t('management.loading'); dialog.showModal(); $('management-title').focus();
    try {
      const options = mode === 'rename' ? null : await operation.client.conversationOptions().catch(error => {
        if (mode === 'manage' && error instanceof ApiError && error.status === 403) return null;
        throw error;
      });
      const roster = mode !== 'create' ? await operation.client.memberships(operation.scope) : null;
      if (!current(operation)) return;
      operation.directoryUntil = options?.until ?? 0; operation.issueUntil = options?.allowedActions.length ? options.expiresAt : 0;
      const nextExpiry = Math.min(...[operation.directoryUntil, operation.issueUntil, operation.scope?.until].filter(until => until > 0));
      if (Number.isFinite(nextExpiry)) expiryTimer = setTimeout(update, Math.min(2147483647, Math.max(1, nextExpiry - now())));
      update(); if (!current(operation)) return;
      fields.replaceChildren(); status.textContent = ''; operation.busy = false;
      if (mode === 'create') {
        const title = node('input'); title.id = 'conversation-title'; title.maxLength = 128; title.required = true;
        field('management.title', title);
        const kind = node('select'); kind.id = 'conversation-kind'; kind.append(option('group', t('management.group')), option('direct', t('management.direct')));
        field('management.kind', kind); fields.append(node('p', t('management.members')));
        const choices = options.members.map(member => {
          const row = node('div'); row.className = 'management-member'; row.dataset.member = member.id;
          const label = node('label'), selected = node('input'); selected.type = 'checkbox'; selected.value = member.id;
          label.append(selected, member.name); row.append(label); fields.append(row);
          const granted = actions(options.allowedActions, row);
          for (const checkbox of granted) checkbox.disabled = true;
          selected.addEventListener('change', () => { for (const checkbox of granted) { checkbox.disabled = !selected.checked; if (!selected.checked) checkbox.checked = false; } });
          return { member, selected, granted };
        });
        const until = deadline(options);
        operation.payload = () => {
          const chosen = choices.filter(choice => choice.selected.checked);
          if (chosen.length < 2 || (kind.value === 'direct' && chosen.length !== 2)) throw new Error(t('management.invalidMembers'));
          return { route: '/conversations', body: { title: title.value, kind: kind.value, memberIds: chosen.map(c => c.member.id),
            initialGrants: chosen.flatMap(c => { const selected = c.granted.filter(input => input.checked).map(input => input.value);
              return selected.length ? [{ targetMemberId: c.member.id, actions: selected, expiresAt: new Date(until.value).getTime() }] : []; }), clientEventId: crypto.randomUUID() } };
        };
      } else if (mode === 'rename') {
        if (!roster.canRename) { close(); return; }
        const title = node('input'); title.id = 'rename-title'; title.maxLength = 128; title.required = true; title.value = roster.title;
        field('management.title', title); fields.append(node('p', t('management.renameHelp')));
        operation.payload = () => {
          if (!title.value.trim() || /[\u0000-\u001f\u007f\p{Surrogate}]/u.test(title.value)) throw new Error(t('management.invalidTitle'));
          return { route: '/conversations/rename', body: { conversationId: operation.scope.conversationId, threadId: operation.scope.threadId,
            title: title.value, expectedTitleRevision: roster.titleRevision, expectedMembershipGeneration: operation.scope.membershipGeneration, clientEventId: crypto.randomUUID() } };
        };
      } else {
        const scopes = node('select'); scopes.id = 'management-scope';
        for (const scope of session().management.scopes) { const item = option(JSON.stringify([scope.conversationId, scope.threadId]), scope.title ?? scope.conversationId); item.selected = same(scope, operation.scope); scopes.append(item); }
        field('management.scope', scopes);
        scopes.addEventListener('change', () => { const scope = session().management.scopes.find(s => JSON.stringify([s.conversationId, s.threadId]) === scopes.value); void open('manage', scope); });
        if (roster.canRename) {
          const rename = node('button', t('management.rename')); rename.type = 'button'; rename.id = 'rename-conversation';
          rename.addEventListener('click', () => void open('rename', operation.scope)); fields.append(rename);
        }
        for (const member of roster.members) {
          const remove = node('button', t('management.remove', { name: member.name })); remove.type = 'button'; remove.className = 'quiet';
          remove.addEventListener('click', () => submit({ route: '/memberships/remove', body: { conversationId: operation.scope.conversationId, threadId: operation.scope.threadId,
            targetMemberId: member.id, expectedRevision: roster.revision, clientEventId: crypto.randomUUID() } })); fields.append(remove);
        }
        save.hidden = !roster.canAdd;
        if (roster.canAdd) {
          let target;
          if (options) {
            target = node('select'); target.append(option('', t('management.choose')));
            for (const member of options.members.filter(m => !roster.members.some(p => p.id === m.id) && (!roster.pair || roster.pair.includes(m.id)))) target.append(option(member.id, member.name));
          } else { target = node('input'); target.maxLength = 128; }
          target.id = 'management-target'; target.required = true; field(options ? 'management.target' : 'management.memberId', target);
          const granted = actions(options?.allowedActions ?? [], fields), until = deadline(options);
          operation.payload = () => {
            const selected = granted.filter(input => input.checked).map(input => input.value);
            return { route: '/memberships/add', body: { conversationId: operation.scope.conversationId, threadId: operation.scope.threadId,
              targetMemberId: target.value, expectedRevision: roster.revision, clientEventId: crypto.randomUUID(),
              ...(selected.length ? { grant: { actions: selected, expiresAt: new Date(until.value).getTime() } } : {}) } };
          };
        }
      }
      fields.disabled = false; save.disabled = false; save.textContent = t('management.save');
      (fields.querySelector('input:not(:disabled),select,button') ?? $('management-title')).focus();
    } catch (error) {
      if (!current(operation)) return;
      operation.busy = false;
      if (error instanceof ApiError && error.status === 401) { invalidate(error); return; }
      status.textContent = errorText(error); fields.replaceChildren();
    }
  }
  async function submit(request) {
    const operation = active;
    if (!operation || operation.busy || !authorized(operation)) { update(); return; }
    try { operation.pending ??= request ?? operation.payload(); }
    catch (error) { status.textContent = error.message; return; }
    operation.busy = true; fields.disabled = true; save.hidden = false; save.disabled = true; status.textContent = t('management.sending');
    try {
      await operation.client.request(operation.pending.route, operation.pending.body);
      if (!current(operation)) return;
      close(); announce(t('management.done')); await refresh();
    } catch (error) {
      if (!current(operation)) return;
      if (error instanceof ApiError && error.status === 401) { invalidate(error); return; }
      // Unknown outcomes retain the exact request and freeze its editable inputs.
      const uncertain = !(error instanceof ApiError) || error.status >= 500;
      status.textContent = uncertain ? t('management.uncertain') : error?.code === 'conversation_title_conflict' ? t('management.titleConflict') : errorText(error);
      if (!uncertain) { operation.pending = null; fields.disabled = false; }
      if (error instanceof ApiError && [403, 409].includes(error.status)) { fields.disabled = true; save.disabled = true; void refresh(); }
      else { save.disabled = false; save.textContent = t(uncertain ? 'management.retry' : 'management.save'); }
      status.tabIndex = -1; status.focus();
    } finally { if (current(operation)) operation.busy = false; }
  }
  $('management-form').addEventListener('submit', event => { event.preventDefault(); void submit(); });
  $('management-close').addEventListener('click', () => { if (!active?.busy) close(); });
  dialog.addEventListener('cancel', event => { event.preventDefault(); if (!active?.busy) close(); });
  dialog.addEventListener('keydown', event => {
    if (event.key !== 'Tab') return;
    const targets = [...dialog.querySelectorAll('button,input,select,[tabindex]')].filter(element => !element.matches(':disabled') && element.tabIndex >= 0 && element.getClientRects().length);
    if (!targets.length) { event.preventDefault(); return; }
    const first = targets[0], last = targets.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
  $('create-conversation').addEventListener('click', () => void open('create'));
  $('manage-conversation').addEventListener('click', () => void open('manage'));
  return { close, update };
}
