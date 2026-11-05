import { bindText, bindAttribute, bindStaticText, installLanguageSelection } from './language-ui.js';
import { Client, ApiError, errorText, messageBody } from './client.js';
import { presentation, text as t, applyStaticText } from './presentation.js';
import { conversationManagement } from './conversation-management.js';
import { attachments } from './attachments.js';
import { leaveConversation } from './leave-conversation.js';
import { PendingStore } from './pending-store.js';

document.documentElement.lang = presentation.locale;
applyStaticText(document);
bindStaticText(document);

const $ = id => document.getElementById(id);
const desktop = window.__TAURI__;
let desktopLanguageReady = !desktop;
if (desktop) {
  try {
    const selected = await desktop.core.invoke('desktop_presentation');
    if (selected?.selection !== 'rebuild') throw new Error('Unknown desktop language policy');
    presentation.lock(selected.locale); desktopLanguageReady = true;
    document.documentElement.lang = presentation.locale;
  } catch {
    presentation.lock(presentation.id);
    $('connect-button').disabled = true;
    bindText($('connect-error'), () => t('language.unavailable'));
  }
}
installLanguageSelection(document);
const SVG = 'http://www.w3.org/2000/svg';
const key = scope => JSON.stringify([scope.conversationId, scope.threadId]);
const roomName = scope => scope.title ?? scope.conversationId;
const state = {
  client: null, session: null, selected: '', rooms: new Map(), epoch: 0, timer: null, expiryTimer: null, syncing: false, offset: 0,
  cancels: new Map(), reads: new Map(), pane: null, paneReturn: null, lastSync: 0,
  // Render signatures keep focus, selection and open disclosures stable across polling.
  ui: { nav: '', seats: '', seat: '', expiry: '', pane: '', outbox: '' },
};
const runLabel = status => t(['queued', 'running', 'cancel_requested', 'completed', 'failed', 'stopped', 'unknown'].includes(status) ? `run.${status}` : 'run.unrecognized');
const LIVE = new Set(['queued', 'running', 'cancel_requested']);
const attachmentUI = attachments({ current, client: () => state.client, authorized, changed: updateComposer, deny: denyReadScope, invalidate });
const leaveDialog = leaveConversation({ current, client: () => state.client, authorized, beforeOpen: () => closePane(false), left: leaveConfirmed, refresh: sync, invalidate, announce });
const SETTLED = new Set(['cancel_requested', 'completed', 'failed', 'stopped']);
const GROUP_WINDOW = 5 * 60 * 1000;
const EXPIRY_NOTICE = 5 * 60 * 1000;
const paneOverlay = matchMedia('(max-width: 1179px)');
const SUGGESTIONS = ['请调研一下插件协议', '大家好，同步一下今天的进展。'];
let changingLanguage = false;

let cancellationRevision = 0;
let messageChange = null;
const managementDialog = conversationManagement({ client: () => state.client, session: () => state.session, now: serverNow,
  refresh: sync, invalidate, beforeOpen: () => closePane(false), announce });
function el(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) bindText(node, text); return node; }
function button(text, fn, className = 'quiet') { const node = el('button', className, text); node.type = 'button'; node.addEventListener('click', fn); return node; }
function icon(name, className = 'icon') {
  const svg = document.createElementNS(SVG, 'svg'), use = document.createElementNS(SVG, 'use');
  svg.setAttribute('class', className); svg.setAttribute('aria-hidden', 'true'); use.setAttribute('href', `#${name}`); svg.append(use);
  return svg;
}
function action(text, id, fn, className = 'text-button', glyph) {
  const node = button('', fn, className); node.dataset.action = id;
  if (glyph) node.append(icon(glyph));
  node.append(el('span', '', text)); return node;
}
function setText(node, text) { if (typeof text === 'function' || node.textContent !== text) bindText(node, text); }
function current() { return state.rooms.get(state.selected); }
function serverNow() { return Date.now() + state.offset; }
function deadline(action, room = current()) { return Math.min(room?.scope.permissions[action] ?? 0, room?.scope.outboxExpiresAt ?? Infinity); }
function authorized(action, room = current()) { return deadline(action, room) > serverNow(); }
// A lapsed grant is reported as 0. The last deadline seen in this connection lets
// the UI say "expired at 14:32" or "withdrawn" instead of "never granted".
function permission(action, room = current()) {
  const until = deadline(action, room), now = serverNow();
  if (until > now) return { allowed: true, until };
  const last = Math.max(until, room?.known[action] ?? 0);
  if (!last) return { allowed: false, reason: 'none' };
  return { allowed: false, reason: last <= now ? 'expired' : 'withdrawn', until: last };
}
function announce(text) { bindText($('announcement'), text); }
function clock(ts) { return presentation.format('time', ts); }
function clockSeconds(ts) { return presentation.format('timeSeconds', ts); }
function remaining(ms) {
  const minutes = Math.max(1, Math.ceil(ms / 60000));
  return minutes >= 60 ? t('duration.hoursMinutes', { hours: Math.floor(minutes / 60), minutes: minutes % 60 }) : t('duration.minutes', { minutes });
}
function initial(name) { return [...name.trim()][0] ?? '?'; }
function kindLabel(member) { return t(member.kind === 'agent' ? 'member.agent' : 'member.human'); }
function isMe(id) { return id === state.session?.member.id; }
function memberIn(room, id) { return room.scope.members.find(member => member.id === id) ?? { id, name: t('member.unknown'), kind: 'human' }; }
function firstLine(text) { return text.split('\n').find(line => line.trim()) ?? text; }
function tile(member, className = '') { const node = el('span', `tile ${member.kind} ${className}`.trim(), initial(member.name)); node.setAttribute('aria-hidden', 'true'); return node; }
function timeNode(ts, text = clock(ts)) { const node = el('time', '', text); node.dateTime = new Date(ts).toISOString(); node.title = presentation.format('dateTime', ts); return node; }
function startOfDay(ts) { const day = new Date(ts); return new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime(); }
function dayLabel(ts) {
  const diff = Math.round((startOfDay(Date.now()) - startOfDay(ts)) / 86400000);
  if (diff === 0) return t('date.today');
  if (diff === 1) return t('date.yesterday');
  return presentation.format('day', ts);
}
function roomTime(ts) { return startOfDay(ts) === startOfDay(Date.now()) ? clock(ts) : presentation.format('compactDate', ts); }
function unreadMessages(room) { return room.messages.filter(message => !room.seen.has(message.id) && !isMe(message.authorId) && !message.retracted && !message.invalidated); }
function unseen(room) { return unreadMessages(room).length; }
function applyReadPosition(room, messageId) {
  const index = room.messages.findIndex(message => message.id === messageId);
  if (index < 0) return;
  for (const message of room.messages.slice(0, index + 1)) room.seen.add(message.id);
  if (index > room.messages.findIndex(message => message.id === room.readThroughMessageId)) room.readThroughMessageId = messageId;
  if (index >= room.messages.findIndex(message => message.id === room.pendingReadMessageId)) room.pendingReadMessageId = undefined;
}
function markSeen(room) {
  if (changingLanguage) return;
  if (!room || room !== current() || !authorized('read', room) || document.hidden || $('app').hidden || $('message-change').open || $('conversation-management').open || attachmentUI.opened || leaveDialog.opened
      || $('app').classList.contains('show-rooms') || (state.pane && paneOverlay.matches)) return;
  const timeline = $('timeline');
  if (timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight >= 90) return;
  for (const message of room.messages) room.seen.add(message.id);
  const messageId = room.messages.at(-1)?.id;
  if (messageId && messageId !== room.readThroughMessageId) room.pendingReadMessageId = messageId;
  flushReadPosition(room);
}
function flushReadPosition(room) {
  const messageId = room.pendingReadMessageId, id = key(room.scope), client = state.client;
  if (!client || !authorized('read', room) || !messageId || state.reads.has(id)) return;
  const attempt = {}; state.reads.set(id, attempt);
  void client.markRead(room.scope, messageId).then(result => {
    const latest = state.rooms.get(id);
    if (client === state.client && state.reads.get(id) === attempt && latest?.cacheIdentity === room.cacheIdentity && authorized('read', latest)) applyReadPosition(latest, result.readThroughMessageId);
  }).catch(error => {
    if (client !== state.client) return;
    if (error instanceof ApiError && error.status === 401) { invalidate(error); return; }
    if (state.reads.get(id) === attempt && error instanceof ApiError && error.status === 403) denyReadScope(client, room);
    // Other failures retain the fixed target for a later idempotent retry.
  }).finally(() => { if (state.reads.get(id) === attempt) state.reads.delete(id); });
}
function hasManagement(session = state.session) { return session?.management?.createUntil > serverNow() || session?.management?.scopes.some(scope => scope.until > serverNow()); }
function accessEnded() { return !hasManagement() && [...state.rooms.values()].every(room => deadline('read', room) <= serverNow()); }
function renderManagement() {
  $('create-conversation').hidden = !(state.session?.management?.createUntil > serverNow());
  $('manage-conversation').hidden = !state.session?.management?.scopes.some(scope => scope.until > serverNow());
  $('management-toolbar').hidden = $('create-conversation').hidden && $('manage-conversation').hidden;
  $('management-empty').hidden = state.rooms.size > 0;
  $('app').classList.toggle('management-empty', state.rooms.size === 0);
  managementDialog.update();
}

function denyReadScope(client, room) {
  const latest = state.rooms.get(key(room.scope));
  if (client !== state.client || !latest || latest.cacheIdentity !== room.cacheIdentity) return;
  // A session request already in flight must not recreate this denied cache.
  state.epoch++; state.syncing = false; clearTimeout(state.timer);
  latest.scope.permissions.read = 0;
  expireReadScopes();
  // Removing the selected room already starts sync through selectRoom().
  if (state.client && !state.syncing) void sync();
}
function leaveConfirmed(client, room) {
  const latest = state.rooms.get(key(room.scope));
  if (client !== state.client || !latest || latest.cacheIdentity !== room.cacheIdentity) return false;
  // Management discovery is a separate cache and must disappear immediately too.
  if (state.session?.management) state.session.management.scopes = state.session.management.scopes.filter(scope => key(scope) !== key(room.scope));
  denyReadScope(client, room);
  if (!state.client) bindText($('connect-error'), () => t('leave.noRemaining'));
  // The original button lived in a now-hidden member pane. Restore focus only
  // for the generation actually removed, never for a delayed older receipt.
  const focus = current() ? $('room-title') : state.client ? $('create-conversation').hidden ? $('manage-conversation') : $('create-conversation') : desktop ? $('connect-button') : $('token');
  focus.focus({ preventScroll: true });
  return true;
}

// Known read deadlines apply to cached content too, independently of a pending
// request or a network outage. Keep other still-authorized conversations usable.
function expireReadScopes() {
  clearTimeout(state.expiryTimer);
  if (!state.client) return;
  if (messageChange) {
    const editingRoom = state.rooms.get(messageChange.roomId);
    if (!editingRoom || !authorized('read', editingRoom)) closeMessageChange();
  }
  for (const [id, room] of state.rooms) {
    if (authorized('read', room)) continue;
    forgetPending(room);
    for (const run of room.runs) state.cancels.delete(run.id);
    state.reads.delete(id);
    state.rooms.delete(id);
  }
  if (!state.rooms.size && !hasManagement()) { invalidate(new ApiError(403, 'grant_expired')); return; }
  state.session.scopes = state.session.scopes.filter(scope => state.rooms.has(key(scope)));
  setText($('room-count'), () => t('room.count', { count: state.rooms.size }));
  if (state.rooms.size && !state.rooms.has(state.selected)) {
    void selectRoom(state.rooms.keys().next().value);
    announce(() => t('room.readExpired'));
  } else renderRooms();
  if (!state.rooms.size) {
    state.selected = ''; state.pane = null; state.paneReturn = null; renderPane();
    for (const id of ['messages', 'outbox', 'reply-preview', 'seats', 'seat', 'members', 'my-seat', 'details-thread', 'search-results', 'search-count']) $(id).replaceChildren();
    $('message').value = ''; $('search-query').value = '';
  }
  renderManagement();
  attachmentUI.update();
  leaveDialog.update();
  const next = Math.min(...[...state.rooms.values()].map(room => deadline('read', room)),
    ...[state.session?.management?.createUntil ?? 0, state.session?.management?.issueUntil ?? 0, ...(state.session?.management?.scopes ?? []).map(scope => scope.until)].filter(until => until > serverNow()));
  state.expiryTimer = setTimeout(expireReadScopes, Math.min(2147483647, Math.max(1, next - serverNow())));
}

function forgetPending(room) { if (room?.store) { void room.store.forget(room.scope.outboxKey).catch(() => {}); room.store.close(); } }
function invalidate(error, preservePending = false) {
  const leaveUnconfirmed = leaveDialog.unconfirmed; leaveDialog.close();
  attachmentUI.reset();
  closeMessageChange();
  managementDialog.close();
  for (const room of state.rooms.values()) { if (preservePending) room.store?.close(); else forgetPending(room); }
  if (desktop) void desktop.core.invoke('desktop_connected', { connected: false });
  state.client?.close(); state.client = null; state.epoch++; clearTimeout(state.timer); clearTimeout(state.expiryTimer); state.syncing = false;
  state.session = null; state.rooms.clear(); state.cancels.clear(); state.reads.clear(); state.selected = ''; state.lastSync = 0;
  state.pane = null; state.paneReturn = null;
  for (const name of Object.keys(state.ui)) state.ui[name] = '';
  $('app').hidden = true; $('connect').hidden = false; $('token').value = ''; $('message').value = '';
  for (const id of ['messages', 'rooms', 'outbox', 'reply-preview', 'seats', 'seat', 'members', 'my-seat', 'details-thread', 'identity', 'search-results', 'search-count']) $(id).replaceChildren();
  $('search-query').value = ''; $('search-toggle').setAttribute('aria-expanded', 'false');
  $('reply-preview').hidden = true; delete $('reply-preview').dataset.signature;
  $('details').hidden = true; $('app').classList.remove('show-rooms', 'has-pane'); $('members-toggle').setAttribute('aria-expanded', 'false');
  updatePaneAccessibility();
  $('announcement').textContent = '';
  $('sync-error').hidden = true; $('new-messages').hidden = true; $('expiry').hidden = true;
  $('connection-status').dataset.state = 'pending'; bindText($('connection-status'), () => t('connection.pending'));
  // Only a rejected credential is a field error; expiry and denial are about access, not input.
  $('token').setAttribute('aria-invalid', String(!desktop && error instanceof ApiError && error.status === 401));
  bindText($('connect-error'), () => error ? leaveUnconfirmed ? t('leave.unconfirmedEnded') : errorText(error) : '');
  $('connect-button').disabled = false; bindText($('connect-button'), () => t(desktop ? 'desktop.enter' : 'connect.submit'));
  (desktop ? $('connect-button') : $('token')).focus();
}

function sessionReceived(session) {
  // A slower response must not move our known server clock backwards and revive
  // a scope whose deadline was already reached while that request was in flight.
  const offset = session.serverTime - Date.now();
  state.offset = state.session ? Math.max(state.offset, offset) : offset;
  session.scopes = session.scopes.filter(scope => scope.permissions.read > serverNow());
  if (!session.scopes.length && !hasManagement(session)) throw new ApiError(403, 'grant_expired');
  state.session = session;
  const next = new Map();
  for (const scope of session.scopes) {
    const id = key(scope), previous = state.rooms.get(id);
    const old = previous?.scope.membershipGeneration === scope.membershipGeneration && previous?.scope.outboxKey === scope.outboxKey ? previous : undefined, known = { ...old?.known };
    if (previous && !old) {
      forgetPending(previous);
      state.reads.delete(id); for (const run of previous.runs) state.cancels.delete(run.id);
      if (messageChange?.roomId === id) closeMessageChange();
      if (state.selected === id) {
        $('message').value = ''; $('messages').replaceChildren(); $('outbox').replaceChildren(); state.ui.outbox = '';
        $('reply-preview').replaceChildren(); $('reply-preview').hidden = true; delete $('reply-preview').dataset.signature;
        state.pane = null; renderPane();
      }
    }
    for (const [name, until] of Object.entries(scope.permissions)) if (until > 0) known[name] = until;
    next.set(id, old ? { ...old, scope, known } : { scope, known, store: new PendingStore(serverNow), restoring: true, cacheIdentity: {}, messages: [], runs: [], loaded: false, draft: '', pending: null, signature: '', seen: new Set(), rendered: 0, entering: true });
  }
  for (const [id, room] of state.rooms) if (!next.has(id)) forgetPending(room);
  state.rooms = next;
  for (const [id, room] of next) if (room.restoring && !room.restoreStarted) { room.restoreStarted = true; void restorePending(room, id); }
  updateComposer();
  if (!next.has(state.selected)) { state.selected = next.keys().next().value ?? ''; if (current()) current().entering = true; state.pane = null; renderPane(); }
  renderIdentity();
  setText($('room-count'), () => t('room.count', { count: session.scopes.length }));
  renderRooms(); renderHeader();
  expireReadScopes();
}

async function restorePending(room, id) {
  const client = state.client;
  try {
    const saved = await room.store.load(room.scope.outboxKey), latest = state.rooms.get(id);
    if (client !== state.client || latest?.cacheIdentity !== room.cacheIdentity || !authorized('read', latest)) return;
    if (saved && saved.conversationId === room.scope.conversationId && saved.threadId === room.scope.threadId && saved.membershipGeneration === room.scope.membershipGeneration) {
      latest.pending = { ...saved, status: 'failed', error: t('send.recovered'), errorRender: () => t('send.recovered'), recovered: true };
      latest.draft = saved.text; latest.replyToMessageId = saved.replyToMessageId; latest.attachment = saved.attachment;
      if (id === state.selected) $('message').value = saved.text;
      void reconcilePending(latest, id);
    } else if (saved) await room.store.remove(room.scope.outboxKey, saved.id);
  } catch { /* Sending will report a storage failure; never silently send without saving. */ }
  finally {
    const latest = state.rooms.get(id);
    if (client === state.client && latest?.cacheIdentity === room.cacheIdentity) {
      latest.restoring = false; if (id === state.selected) { updateComposer(); renderOutbox(); }
    }
  }
}

function renderIdentity() {
  const member = state.session.member, copy = el('span', 'identity-copy');
  copy.append(el('strong', '', member.name), el('span', '', kindLabel(member)));
  $('identity').replaceChildren(tile(member), copy);
}

function renderRooms() {
  const signature = JSON.stringify([state.selected, [...state.rooms.keys()]]);
  if (signature !== state.ui.nav) {
    // Rebuild only when the list itself changes so a focused room survives polling.
    state.ui.nav = signature;
    const children = [];
    for (const [id, room] of state.rooms) {
      const item = button('', () => selectRoom(id), 'room');
      item.dataset.room = id; item.setAttribute('aria-current', String(id === state.selected));
      const top = el('span', 'room-top'), bottom = el('span', 'room-bottom'), copy = el('span', 'room-copy');
      top.append(el('strong', 'room-name', roomName(room.scope)), el('span', 'room-thread', room.scope.threadId), el('span', 'room-time'));
      bottom.append(el('span', 'room-preview'), el('span', 'room-badge'));
      copy.append(top, bottom);
      const roomTile = el('span', 'tile', initial(roomName(room.scope))); roomTile.setAttribute('aria-hidden', 'true');
      item.append(roomTile, copy); children.push(item);
    }
    $('rooms').replaceChildren(...children);
  }
  for (const item of $('rooms').children) { const room = state.rooms.get(item.dataset.room); if (room) updateRoomItem(item, room); }
}

function updateRoomItem(item, room) {
  setText(item.querySelector('.room-name'), roomName(room.scope));
  setText(item.querySelector('.tile'), initial(roomName(room.scope)));
  const selected = item.dataset.room === state.selected, last = room.messages.at(-1);
  const live = room.runs.find(run => LIVE.has(run.status)), fresh = selected ? 0 : unseen(room);
  const text = live ? t('room.researching', { name: memberIn(room, live.memberId).name }) : last ? t('room.latestMessage', { name: memberIn(room, last.authorId).name, text: firstLine(last.text) }) : room.loaded ? t('room.noMessages') : '';
  const preview = item.querySelector('.room-preview'), previewSignature = JSON.stringify([text, Boolean(live)]);
  if (preview.dataset.signature !== previewSignature) {
    preview.dataset.signature = previewSignature;
    preview.replaceChildren(...(live ? [el('span', 'live-dot'), text] : [text]));
  }
  setText(item.querySelector('.room-time'), last ? roomTime(last.createdAt) : '');
  const badge = item.querySelector('.room-badge'); setText(badge, fresh ? String(fresh) : ''); badge.hidden = !fresh;
  item.classList.toggle('is-live', Boolean(live)); item.classList.toggle('has-new', fresh > 0);
  const label = [`${roomName(room.scope)} ${room.scope.threadId}`, live && t('room.researchActive'), fresh && t('room.unread', { count: fresh })].filter(Boolean).join(t('list.separator'));
  if (item.getAttribute('aria-label') !== label) item.setAttribute('aria-label', label);
}

function renderHeader() {
  const room = current(); if (!room) return;
  const { threadId, members } = room.scope;
  setText($('room-title'), roomName(room.scope));
  setText($('thread-title'), () => t('room.threadMembers', { thread: threadId, count: members.length }));
  setText($('room-tile'), initial(roomName(room.scope)));
  setText($('members-count'), () => t('room.members', { count: members.length }));
  setText($('members-short'), String(members.length));
  setText($('scope-note'), () => t('room.scopeNote', { conversation: roomName(room.scope), thread: threadId }));
  renderSeats(room); updateComposer();
}

function renderSeats(room) {
  if (!room) return;
  const live = new Set(room.runs.filter(run => LIVE.has(run.status)).map(run => run.memberId));
  const shown = room.scope.members.slice(0, 4);
  const signature = JSON.stringify([shown, [...live], state.session?.member.id, room.scope.members.length]);
  if (signature === state.ui.seats) return;
  state.ui.seats = signature;
  const seats = shown.map(member => {
    const working = live.has(member.id), seat = el('li', working ? 'seat is-live' : 'seat');
    seat.append(tile(member), el('span', 'seat-name', member.name));
    if (working) seat.append(el('span', 'live-dot'));
    seat.append(el('span', 'seat-kind', () => working ? t('member.researching') : isMe(member.id) ? t('member.you') : kindLabel(member)));
    return seat;
  });
  if (room.scope.members.length > shown.length) seats.push(el('li', 'seats-more', `+${room.scope.members.length - shown.length}`));
  $('seats').replaceChildren(...seats);
}

function selectRoom(id) {
  if (!state.rooms.has(id)) return;
  if (!authorized('read', state.rooms.get(id))) { expireReadScopes(); return; }
  attachmentUI.reset();
  const old = current(); if (old && !old.pending) old.draft = $('message').value;
  if (old?.loaded) { const position = rememberScroll(); if (position) old.scrollPosition = position; }
  state.selected = id; state.epoch++; state.syncing = false;
  clearTimeout(state.timer); $('app').classList.remove('show-rooms');
  if (state.pane) { state.pane = null; state.paneReturn = null; renderPane(); }
  const room = current(); room.entering = true; $('message').value = room.draft;
  $('sync-error').hidden = true; $('new-messages').hidden = true;
  renderRooms(); renderHeader(); renderMessages(true); renderOutbox(); const syncing = sync();
  if (matchMedia('(max-width: 720px)').matches) $('room-title').focus();
  return syncing;
}

async function sync() {
  if (!state.client || state.syncing) return;
  clearTimeout(state.timer); state.syncing = true;
  const epoch = state.epoch, client = state.client, selection = state.selected;
  try {
    const session = await client.session();
    if (epoch !== state.epoch) return;
    sessionReceived(session);
    if (selection !== state.selected) { $('message').value = current()?.draft ?? ''; renderMessages(true); }
    // Every authorized room is refreshed so the list can show activity; only the
    // open room's failure decides the connection state.
    const ids = [...state.rooms.keys()], revision = cancellationRevision;
    const requests = ids.map(id => { const room = state.rooms.get(id); return { room, generation: room.syncGeneration ?? 0, cursor: room.syncCursor }; });
    const results = await Promise.allSettled(requests.map(({ room, cursor }) => client.snapshot(room.scope, cursor)));
    if (epoch !== state.epoch) return;
    for (const [index, result] of results.entries()) {
      if (result.status !== 'rejected' || !(result.reason instanceof ApiError)) continue;
      if (result.reason.status === 401) throw result.reason;
      // A background scope's read denial must evict its cache too.
      if (result.reason.status === 403 && state.rooms.get(ids[index]) === requests[index].room) requests[index].room.scope.permissions.read = 0;
    }
    expireReadScopes(); if (epoch !== state.epoch) return;
    // Permission failures still apply; only stale content must be discarded.
    if (revision !== cancellationRevision) return;
    const opened = results[ids.indexOf(state.selected)];
    if (opened?.status === 'rejected') throw opened.reason;
    ids.forEach((id, index) => {
      const room = state.rooms.get(id), result = results[index];
      const request = requests[index];
      if (room === request.room && authorized('read', room) && (room.syncGeneration ?? 0) === request.generation
          && room.syncCursor === request.cursor && result.status === 'fulfilled') applySnapshot(room, result.value, id === state.selected);
    });
    renderRooms(); renderSeats(current()); renderMessages(); renderPane(); renderOutbox(); markSeen(current());
    for (const [id, room] of state.rooms) {
      if (room.pending?.status === 'failed' && !authorized('send', room)) void reconcilePending(room, id);
    }
    updateMessageChange();
    if (messageChange?.submittedText !== undefined && !messageChange.sending && !messageChange.autoChecked
        && (messageChange.targetRetracted || !authorized('send', state.rooms.get(messageChange.roomId)))) {
      messageChange.autoChecked = true; void submitMessageChange(true);
    }
    state.lastSync = Date.now(); setConnection('ok'); $('sync-error').hidden = true;
    return true;
  } catch (error) {
    if (epoch !== state.epoch) return;
    if (error instanceof ApiError && [401, 403].includes(error.status)) { invalidate(error); return; }
    // The server has already said when access ends; past that point an unreachable
    // service is expiry, not a transient outage worth retrying forever.
    if (!(error instanceof ApiError) && accessEnded()) { invalidate(new ApiError(403, 'grant_expired')); return; }
    setConnection('down');
    bindText($('sync-error-text'), () => state.lastSync ? t('sync.staleAt', { error: errorText(error), time: clock(state.lastSync) }) : t('sync.stale', { error: errorText(error) }));
    $('sync-error').hidden = false;
  } finally {
    if (epoch === state.epoch) { state.syncing = false; if (state.client) { updateComposer(); state.timer = setTimeout(sync, 1200); } }
  }
}

function setConnection(value) {
  const node = $('connection-status'); node.dataset.state = value;
  setText(node, () => t(value === 'ok' ? 'connection.connected' : 'connection.disconnected'));
}

function invalidateSnapshot(room) {
  room.syncGeneration = (room.syncGeneration ?? 0) + 1;
  room.syncCursor = undefined;
}
function applySnapshot(room, data, selected) {
  const before = new Map(room.runs.map(run => [run.id, run.status])), firstLoad = !room.loaded;
  const merge = (previous, updates, removed) => {
    const values = new Map(previous.map(value => [value.id, value]));
    for (const id of removed) values.delete(id);
    for (const value of updates) values.set(value.id, value);
    return [...values.values()];
  };
  const restartedStream = room.syncStreamId && room.syncStreamId !== data.streamId;
  room.messages = data.reset ? data.messages : merge(room.messages, data.messages, data.removedMessageIds);
  room.runs = data.reset ? data.runs : merge(room.runs, data.runs, data.removedRunIds);
  if (restartedStream || data.cursorAhead) {
    room.seen.clear(); room.readThroughMessageId = undefined; room.pendingReadMessageId = undefined;
    state.reads.delete(key(room.scope));
  }
  const retained = new Set(room.messages.map(message => message.id));
  room.seen = new Set([...room.seen].filter(id => retained.has(id)));
  if (!retained.has(room.readThroughMessageId)) room.readThroughMessageId = undefined;
  if (!retained.has(room.pendingReadMessageId)) room.pendingReadMessageId = undefined;
  room.syncCursor = data.cursor; room.syncStreamId = data.streamId; room.loaded = true;
  applyReadPosition(room, data.readThroughMessageId);
  if (messageChange?.roomId === key(room.scope) && room.messages.find(m => m.id === messageChange.messageId)?.retracted) {
    if (messageChange.submittedText === undefined) closeMessageChange();
    else {
      // A tombstone is not proof that this particular operation was received.
      // Keep its identity for a read-only check, but discard the withdrawn body.
      messageChange.targetRetracted = true; messageChange.submittedText = '';
      $('change-text').value = ''; $('change-text').hidden = true; $('change-label').hidden = true;
      bindText($('change-help'), () => t('editor.retractedPending'));
    }
  }
  for (const run of room.runs) if (SETTLED.has(run.status)) state.cancels.delete(run.id);
  // Retry only a previously visible target, even after switching rooms. Never
  // advance to newer background messages merely because a sync received them.
  flushReadPosition(room);
  if (!selected || firstLoad) return;
  room.runs.forEach((run, index) => {
    const previous = before.get(run.id);
    if (previous === undefined) announce(() => t('run.announce.claimed', { name: memberIn(room, run.memberId).name, number: index + 1 }));
    else if (previous !== run.status && !LIVE.has(run.status)) announce(() => t('run.announce.status', { number: index + 1, status: runLabel(run.status) }));
  });
}

function context(room) {
  const runsBySource = new Map(), resultsBySource = new Map(), code = new Map();
  const byId = new Map(room.messages.map(message => [message.id, message])), roots = new Map(), discussions = new Map();
  for (const message of room.messages) {
    const path = [], visited = new Set(); let node = message, root = message.id;
    while (node && !visited.has(node.id)) {
      if (roots.has(node.id)) { root = roots.get(node.id); break; }
      visited.add(node.id); path.push(node.id); root = node.id;
      node = byId.get(node.replyToMessageId ?? node.sourceMessageId);
    }
    for (const id of path) roots.set(id, root);
    if (!discussions.has(root)) discussions.set(root, []);
    discussions.get(root).push(message);
  }
  room.runs.forEach((run, index) => {
    code.set(run.id, index + 1);
    if (!runsBySource.has(run.sourceMessageId)) runsBySource.set(run.sourceMessageId, []);
    runsBySource.get(run.sourceMessageId).push(run);
  });
  for (const message of room.messages) {
    if (!message.sourceMessageId) continue;
    if (!resultsBySource.has(message.sourceMessageId)) resultsBySource.set(message.sourceMessageId, []);
    resultsBySource.get(message.sourceMessageId).push(message);
  }
  return { runsBySource, resultsBySource, code, byId, roots, discussions };
}
function messageText(message) {
  return !message ? t('message.unavailable') : message.retracted ? t('message.retracted') : message.invalidated ? t('message.invalidated') : message.text;
}
function replyQuote(room, message, ctx) {
  const parent = ctx.byId.get(message.replyToMessageId);
  const quote = action('', `quote-${message.id}`, () => { closePane(false); focusMessage(message.replyToMessageId); }, 'quote reply-quote');
  bindAttribute(quote, 'aria-label', () => t('reply.view'));
  quote.append(el('span', 'quote-author', () => parent ? t(parent.changedAt && !parent.retracted ? 'reply.editedAuthor' : 'reply.author', { name: memberIn(room, parent.authorId).name }) : t('message.reply')),
    el('span', 'quote-text', firstLine(messageText(parent))));
  return quote;
}
function chooseReply(room, message) {
  const latest = state.rooms.get(key(room.scope));
  if (!latest || latest !== current() || latest.pending || !authorized('send', latest)) return;
  latest.replyToMessageId = message.id; closePane(false); updateComposer(); $('message').focus();
}

// Consecutive messages from one author read as one turn, as in familiar IMs.
// Research results and messages that carry a research card always restart the
// header, so agent work never hides inside someone else's turn.
function continues(previous, message, ctx) {
  return Boolean(previous) && previous.authorId === message.authorId
    && message.createdAt - previous.createdAt < GROUP_WINDOW
    && !previous.result && !message.result && !message.replyToMessageId
    && !ctx.runsBySource.has(previous.id);
}

function rememberScroll() {
  const timeline = $('timeline'); if (!timeline.getClientRects().length) return undefined;
  const top = timeline.getBoundingClientRect().top;
  const anchor = [...$('messages').children].find(node => node.dataset.message && node.getBoundingClientRect().bottom > top);
  return { messageId: anchor?.dataset.message, offset: anchor ? anchor.getBoundingClientRect().top - top : 0,
    atBottom: timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 90 };
}
function scrollToMessage(id, offset = 0) {
  if (!id) return false;
  const node = [...$('messages').children].find(item => item.dataset.message === id);
  if (!node) return false;
  const timeline = $('timeline');
  timeline.scrollTop += node.getBoundingClientRect().top - timeline.getBoundingClientRect().top - offset;
  return true;
}
function renderMessages(force = false) {
  attachmentUI.update();
  const room = current(); if (!room) return;
  const entering = room.entering && room.loaded && $('timeline').getClientRects().length > 0;
  if (entering) room.unreadBoundaryId = unreadMessages(room)[0]?.id;
  const signature = JSON.stringify([room.messages, room.runs, authorized('cancel'), authorized('send'), [...state.cancels], room.loaded, room.unreadBoundaryId]);
  if (!force && !entering && signature === room.signature) return;
  room.signature = signature;
  const timeline = $('timeline'), previousScroll = timeline.scrollTop, previousPosition = rememberScroll();
  const atBottom = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 90;
  const expanded = new Set([...$('messages').querySelectorAll('details[open]')].map(x => x.dataset.message));
  const focused = $('messages').contains(document.activeElement) ? document.activeElement.dataset.action : undefined;
  const ctx = context(room), nodes = [];
  let previous = null, day = null;
  for (const message of room.messages) {
    const dayKey = startOfDay(message.createdAt), label = dayLabel(message.createdAt);
    if (dayKey !== day) { day = dayKey; previous = null; const divider = el('div', 'day-divider', label); divider.setAttribute('role', 'separator'); nodes.push(divider); }
    if (message.id === room.unreadBoundaryId) {
      const divider = el('div', 'day-divider unread-divider', () => t('message.new')); divider.setAttribute('role', 'separator');
      nodes.push(divider); previous = null;
    }
    nodes.push(renderMessage(room, message, previous, ctx, expanded));
    previous = message;
  }
  if (!room.messages.length) nodes.push(emptyState(room));
  $('messages').replaceChildren(...nodes);
  if (focused) ([...$('messages').querySelectorAll('[data-action]')].find(x => x.dataset.action === focused) ?? timeline).focus({ preventScroll: true });
  const grew = room.messages.length > room.rendered; room.rendered = room.messages.length;
  if (entering) {
    room.entering = false;
    const saved = room.scrollPosition;
    if (saved && !saved.atBottom && scrollToMessage(saved.messageId, saved.offset)) { /* Preserve history position. */ }
    else if (!scrollToMessage(room.unreadBoundaryId, 24)) timeline.scrollTop = timeline.scrollHeight;
    $('new-messages').hidden = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 90;
  }
  else if (force || atBottom) { timeline.scrollTop = timeline.scrollHeight; $('new-messages').hidden = true; }
  else { if (!scrollToMessage(previousPosition?.messageId, previousPosition?.offset)) timeline.scrollTop = previousScroll; if (grew) $('new-messages').hidden = false; }
}

function renderMessage(room, message, previous, ctx, expanded) {
  const member = memberIn(room, message.authorId), runs = ctx.runsBySource.get(message.id) ?? [];
  const continued = continues(previous, message, ctx);
  const article = el('article', 'message'); article.dataset.message = message.id; article.dataset.action = `message-${message.id}`; article.tabIndex = -1;
  if (continued) article.classList.add('is-continued');
  if (message.result) article.classList.add('is-result');
  if (continued) { const gutter = el('div', 'gutter'); gutter.append(timeNode(message.createdAt)); article.append(gutter); }
  else article.append(tile(member));
  const body = el('div', 'message-body');
  if (!continued) {
    const head = el('div', 'message-head');
    head.append(el('strong', 'author', member.name), el('span', 'kind', kindLabel(member)));
    if (isMe(member.id)) head.append(el('span', 'kind you', () => t('member.you')));
    head.append(timeNode(message.createdAt)); body.append(head);
  }
  if (message.result) body.append(...resultHead(room, message, ctx));
  if (message.replyToMessageId) body.append(replyQuote(room, message, ctx));
  body.append(el('p', 'message-text', messageText(message)));
  if (message.attachment && !message.retracted && !message.invalidated) body.append(action(() => t('attachment.open', message.attachment), `attachment-${message.id}`, () => attachmentUI.open(room, message), 'attachment-link'));
  if (message.changedAt && !message.retracted) body.append(el('span', 'kind', () => t('message.edited')));
  if (message.result) body.append(sourcesNode(message, expanded));
  const actions = el('div', 'message-actions');
  if (!message.retracted && !message.invalidated && authorized('send', room)) actions.append(action(() => t('message.reply'), `reply-${message.id}`, () => chooseReply(room, message)));
  if (message.origin === 'chat' && isMe(message.authorId) && !message.retracted && authorized('send', room)) {
    actions.append(action(() => t('editor.editTitle'), `edit-${message.id}`, () => openMessageChange(room, message, 'edit')),
      action(() => t('editor.retractTitle'), `retract-${message.id}`, () => openMessageChange(room, message, 'retract')));
  }
  if (message.sourceMessageId) actions.append(action(() => t('message.sourceDiscussion'), `source-${message.id}`, event => openPane({ kind: 'discussion', messageId: message.sourceMessageId }, event.currentTarget)));
  else if (runs.length || (ctx.discussions.get(ctx.roots.get(message.id))?.length ?? 0) > 1) actions.append(action(() => t('message.discussion'), `source-${message.id}`, event => openPane({ kind: 'discussion', messageId: message.id }, event.currentTarget)));
  if (actions.firstElementChild) body.append(actions);
  for (const run of runs) body.append(renderRun(room, run, ctx));
  article.append(body);
  return article;
}

function resultHead(room, message, ctx) {
  const head = el('div', 'result-head'), nodes = [head];
  head.append(el('span', 'result-label', () => t('result.synthetic')));
  const run = (ctx.runsBySource.get(message.sourceMessageId) ?? []).find(item => item.memberId === message.authorId);
  if (run) head.append(el('span', 'run-code', () => t('run.label', { number: ctx.code.get(run.id) })));
  const source = ctx.byId.get(message.sourceMessageId);
  if (source) {
    const quote = el('div', 'quote');
    quote.append(el('span', 'quote-author', () => t('result.respondingTo', { name: memberIn(room, source.authorId).name })), el('span', 'quote-text', firstLine(source.text)));
    nodes.push(quote);
  }
  return nodes;
}

function sourcesNode(message, expanded) {
  const { sources, limitations } = message.result;
  const details = el('details', 'sources'); details.dataset.message = message.id; details.open = expanded.has(message.id);
  const summary = el('summary'), keys = el('span', 'summary-keys');
  summary.dataset.action = `sources-${message.id}`;
  keys.setAttribute('aria-hidden', 'true');
  sources.forEach((_, index) => keys.append(el('span', 'source-key', String(index + 1))));
  summary.append(icon('i-chevron'), el('span', '', () => t('result.sourcesSummary', { count: sources.length })), keys);
  const list = el('ol', 'source-list');
  sources.forEach((source, index) => {
    const item = el('li'), copy = el('div');
    copy.append(el('strong', 'source-title', source.title), el('p', 'source-excerpt', source.excerpt), el('span', 'source-url', () => t('result.placeholderUrl', { url: source.url })));
    item.append(el('span', 'source-key', String(index + 1)), copy); list.append(item);
  });
  details.append(summary, list);
  if (limitations.length) {
    const limits = el('div', 'limits'); limits.append(el('strong', '', () => t('result.limitations')));
    for (const limitation of limitations) limits.append(el('p', '', limitation));
    details.append(limits);
  }
  return details;
}

function runNote(run) {
  if (run.invalidatedBy || run.contextInvalidated) {
    if (run.status === 'unknown') return t('run.note.invalidatedUnknown');
    if (run.replacementRunId) return t('run.note.replacementCreated');
    if (!['completed', 'failed', 'stopped'].includes(run.status)) return t('run.note.invalidatedWaiting');
    return t('run.note.invalidatedSettled');
  }
  const stoppedEvent = run.events.find(event => event.kind === 'stopped' && event.data.executionSettled === true);
  return {
    queued: t('run.note.queued'), running: t('run.note.running'),
    cancel_requested: t('run.note.cancelRequested'),
    completed: t(run.receiptId ? 'run.note.published' : 'run.note.missingReceipt'),
    failed: t('run.note.failed'),
    unknown: t('run.note.unknown'),
    stopped: t(stoppedEvent ? 'run.note.executionStopped' : run.stopEvidence ? 'run.note.notStarted' : 'run.note.stopUnconfirmed'),
  }[run.status] ?? t('run.note.unrecognized');
}

// Progress is derived only from server-recorded runtime events, never from timers.
function runSteps(run) {
  const at = kind => run.events.find(event => event.kind === kind)?.at;
  const started = at('input_applied'), steps = [{ label: t('run.step.claimed'), state: 'done' }];
  if (started) steps.push({ label: t(run.work.contextRevision > 1 && !run.contextInvalidated ? 'run.step.changeApplied' : 'run.step.started'), time: started, state: 'done' });
  else if (run.stopEvidence?.executionStarted === false) steps.push({ label: t('run.step.notStarted'), state: 'done' });
  else steps.push({ label: t('run.step.started'), state: run.status === 'queued' ? 'current' : 'todo' });
  if (run.status === 'cancel_requested') steps.push({ label: t('run.step.cancelAccepted'), state: 'done' }, { label: t('run.cancel_requested'), state: 'current' });
  else if (run.status === 'stopped') steps.push({ label: t('run.stopped'), time: at('stopped'), state: 'done' });
  else if (run.status === 'failed') steps.push({ label: t('run.failed'), time: at('failed'), state: 'bad' });
  else if (run.status === 'unknown') steps.push({ label: t('run.step.unknown'), state: 'bad' });
  else steps.push({ label: t('run.step.resultReturned'), time: run.receiptId ? at('output') : undefined, state: run.receiptId ? 'done' : run.status === 'running' ? 'current' : 'todo' });
  return steps;
}

function stepsNode(run) {
  const list = el('ol', 'run-steps');
  bindAttribute(list, 'aria-label', () => t('run.progressLabel'));
  for (const step of runSteps(run)) {
    const item = el('li', `is-${step.state}`);
    item.append(el('span', 'step-dot'), el('span', '', step.label));
    if (step.time) { const time = timeNode(step.time, clockSeconds(step.time)); time.classList.add('step-time'); item.append(time); }
    list.append(item);
  }
  return list;
}

function renderRun(room, run, ctx) {
  const code = ctx.code.get(run.id), block = el('section', `run is-${run.status}`);
  block.dataset.run = run.id; bindAttribute(block, 'aria-label', () => t('run.label', { number: code }));
  const top = el('div', 'run-top'), status = el('span', 'run-state'), title = el('span', 'run-title');
  status.append(icon(`st-${run.status}`, `mark st-${run.status}`), el('span', 'status-label', () => runLabel(run.status)));
  title.append(el('strong', '', () => t('run.label', { number: code })), el('span', '', memberIn(room, run.memberId).name));
  top.append(status, title);
  const cancellation = state.cancels.get(run.id);
  if (['queued', 'running', 'unknown'].includes(run.status) && authorized('cancel')) {
    const cancel = action(() => t(cancellation === 'sending' ? 'run.cancel.requesting' : cancellation === 'failed' ? 'run.cancel.retry' : 'run.cancel.action'), `cancel-${run.id}`, () => cancelRun(run.id), 'outline-button run-cancel');
    cancel.disabled = cancellation === 'sending'; top.append(cancel);
  }
  block.append(top, stepsNode(run), el('p', 'run-note', runNote(run)));
  if (cancellation === 'failed') block.append(el('p', 'error', () => t('run.cancel.unconfirmed')));
  const result = (ctx.resultsBySource.get(run.sourceMessageId) ?? []).find(message => message.authorId === run.memberId);
  if (result) block.append(action(() => t('run.viewResult'), `jump-${run.id}`, () => focusMessage(result.id), 'text-button run-jump', 'i-jump'));
  return block;
}

function emptyState(room) {
  if (!room.loaded) {
    const skeleton = el('div', 'skeleton'); skeleton.append(el('p', 'sr-only', () => t('room.loading')));
    for (let row = 0; row < 3; row++) {
      const line = el('div', 'skeleton-row'), lines = el('div', 'skeleton-lines');
      lines.append(el('span'), el('span')); line.append(el('span'), lines); skeleton.append(line);
    }
    return skeleton;
  }
  const empty = el('div', 'empty');
  empty.append(el('h3', '', () => t('room.emptyTitle')), el('p', '', () => t('room.emptyHelp')));
  if (authorized('send', room)) {
    const list = el('div', 'suggestions');
    for (const text of SUGGESTIONS) list.append(button(text, () => { if (current().pending) return; $('message').value = text; current().draft = text; updateComposer(); $('message').focus(); }, 'suggestion'));
    empty.append(list);
  }
  return empty;
}

function focusMessage(id) {
  const node = [...$('messages').children].find(child => child.dataset.message === id);
  if (!node) return;
  node.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  node.classList.remove('is-flash'); void node.offsetWidth; node.classList.add('is-flash');
  node.focus({ preventScroll: true });
  setTimeout(() => node.classList.remove('is-flash'), 1800);
}

async function cancelRun(id) {
  if (!state.client || state.cancels.get(id) === 'sending') return;
  const client = state.client;
  state.cancels.set(id, 'sending'); renderMessages();
  try {
    const result = await client.cancel(id); if (client !== state.client) return;
    cancellationRevision++;
    // Cancellation returns an acknowledgement, not a full Run. Keep identity and execution evidence.
    for (const room of state.rooms.values()) {
      if (!room.runs.some(run => run.id === id)) continue;
      invalidateSnapshot(room);
      room.runs = room.runs.map(run => run.id === id ? {
      ...run,
      // A newer poll may already have observed the terminal state while cancel was in flight.
      status: ['completed', 'failed', 'stopped'].includes(run.status) ? run.status : result.status,
      receiptId: result.publishedReceiptId ?? run.receiptId,
      } : run);
    }
    state.cancels.delete(id); announce(() => t('run.cancel.accepted'));
    renderMessages(); renderPane(); renderRooms(); renderSeats(current());
    await sync();
  } catch (error) {
    if (client !== state.client) return;
    if (error instanceof ApiError && [401, 403].includes(error.status)) { invalidate(error); return; }
    state.cancels.set(id, 'failed'); announce(() => errorText(error));
  }
  if (client === state.client) { renderMessages(); renderPane(); renderRooms(); }
}

function closeMessageChange() {
  const wasOpen = $('message-change').open;
  messageChange = null;
  $('message-change').close(); $('change-text').value = ''; $('change-error').textContent = '';
  // The invoking edit button may have disappeared after send loss or retraction.
  if (wasOpen && !$('app').hidden) $('timeline').focus({ preventScroll: true });
}
function openMessageChange(room, message, kind) {
  messageChange = { roomId: key(room.scope), membershipGeneration: room.scope.membershipGeneration ?? 'initial', messageId: message.id, revision: message.revision, kind, id: crypto.randomUUID(), sending: false, submittedText: undefined };
  bindText($('change-title'), () => t(kind === 'edit' ? 'editor.editTitle' : 'editor.retractTitle'));
  $('change-text').value = message.text; $('change-text').hidden = kind === 'retract'; $('change-label').hidden = kind === 'retract';
  $('change-text').disabled = false; $('change-save').disabled = false; $('change-close').disabled = false;
  bindText($('change-save'), () => t(kind === 'edit' ? 'editor.save' : 'editor.retract'));
  bindText($('change-help'), () => t(kind === 'edit' ? 'editor.editHelp' : 'editor.retractHelp'));
  $('change-error').textContent = ''; $('message-change').showModal();
  (kind === 'edit' ? $('change-text') : $('change-save')).focus();
}
$('change-close').addEventListener('click', closeMessageChange);
$('message-change').addEventListener('cancel', event => { if (messageChange?.sending) event.preventDefault(); else closeMessageChange(); });
function updateMessageChange() {
  const change = messageChange; if (!change || change.sending) return;
  const allowed = authorized('send', state.rooms.get(change.roomId)), submitted = change.submittedText !== undefined;
  $('change-save').disabled = change.conflict || (!submitted && !allowed);
  bindText($('change-save'), () => t(submitted ? (allowed && !change.targetRetracted ? 'editor.retry' : 'editor.check') : change.kind === 'edit' ? 'editor.save' : 'editor.retract'));
  if (allowed && !change.targetRetracted) change.autoChecked = false;
}
function acceptMessageChange(change, result) {
  const latest = state.rooms.get(change.roomId);
  if (!latest || !authorized('read', latest)) { expireReadScopes(); return; }
  cancellationRevision++;
  invalidateSnapshot(latest);
  latest.messages = latest.messages.map(m => m.id === result.message.id && m.revision <= result.message.revision ? result.message : m);
  // Hide cached derived output immediately, before the next snapshot.
  latest.messages = latest.messages.map(m => m.origin === 'research' ? { ...m, text: '', result: undefined, invalidated: true } : m);
  closeMessageChange(); renderMessages(); renderPane(); renderRooms();
  announce(() => t(result.message.revision > result.change.revision ? 'editor.receivedNewer' : 'editor.received'));
  void sync();
}
async function submitMessageChange(receiptOnly = false) {
  const change = messageChange, client = state.client;
  if (!change || !client || change.sending) return;
  const room = state.rooms.get(change.roomId);
  if (!room || !authorized('read', room)) { closeMessageChange(); return; }
  const retry = change.submittedText !== undefined;
  if (!retry && !authorized('send', room)) { updateMessageChange(); return; }
  const text = change.submittedText ?? $('change-text').value.trim();
  if (change.kind === 'edit' && !text && !change.targetRetracted) return;
  change.submittedText = text; change.sending = true;
  const restoreFocus = document.activeElement === $('change-save');
  $('change-text').disabled = true; $('change-save').disabled = true; $('change-close').disabled = true;
  bindText($('change-error'), () => t(retry ? 'editor.checking' : 'editor.submitting'));
  $('change-error').tabIndex = -1;
  if (restoreFocus) $('change-error').focus();
  let readingReceipt = false;
  try {
    if (retry) {
      readingReceipt = true;
      const { receipt } = await client.changeReceipt(room.scope, change.id);
      readingReceipt = false;
      if (client !== state.client || messageChange !== change) return;
      if (receipt) { acceptMessageChange(change, receipt); return; }
    }
    if (receiptOnly || change.targetRetracted || !authorized('send', state.rooms.get(change.roomId))) {
      bindText($('change-error'), () => t('editor.missingReceipt')); return;
    }
    const result = await client.change(change.messageId, change.kind, change.revision, change.id, text, change.membershipGeneration);
    if (client !== state.client || messageChange !== change) return;
    acceptMessageChange(change, result);
  } catch (error) {
    if (client !== state.client || messageChange !== change) return;
    if (error instanceof ApiError && error.status === 401) { invalidate(error); return; }
    if (readingReceipt && error instanceof ApiError && error.status === 403) { denyReadScope(client, room); return; }
    change.conflict = error instanceof ApiError && error.status === 409;
    bindText($('change-error'), () => change.conflict ? t('editor.conflict') : errorText(error));
    if (change.conflict || (error instanceof ApiError && error.status === 403)) void sync();
  } finally {
    if (client === state.client && messageChange === change) {
      change.sending = false; $('change-close').disabled = false; updateMessageChange();
      if (restoreFocus && document.activeElement === $('change-error')) ($('change-save').disabled ? $('change-close') : $('change-save')).focus();
    }
  }
}
$('change-form').addEventListener('submit', event => { event.preventDefault(); void submitMessageChange(); });

function lapse(grant) {
  return grant.reason === 'expired' ? t('permission.expired', { time: clock(grant.until) }) : t(grant.reason === 'withdrawn' ? 'permission.withdrawn' : 'permission.none');
}
function readOnlyReason(room) {
  const send = permission('send', room);
  return send.reason === 'none' ? t('permission.readOnlyNone') : t('permission.readOnlyLapsed', { reason: lapse(send) });
}

function updateComposer() {
  attachmentUI.update();
  leaveDialog.update();
  const room = current(); if (!room || !state.session) return;
  const allowed = authorized('send');
  $('message').disabled = !allowed || Boolean(room.pending) || room.restoring;
  const parent = room.messages.find(m => m.id === room.replyToMessageId);
  const replyUnavailable = Boolean(room.replyToMessageId && (!parent || parent.retracted || parent.invalidated));
  $('send').disabled = !allowed || Boolean(room.pending) || room.restoring || attachmentUI.loading || !$('message').value.trim() || replyUnavailable;
  const preview = $('reply-preview'), replySignature = JSON.stringify([state.selected, room.replyToMessageId, parent, Boolean(room.pending)]);
  if (preview.dataset.signature !== replySignature) {
    preview.dataset.signature = replySignature; preview.hidden = !room.replyToMessageId; preview.replaceChildren();
    if (room.replyToMessageId) {
      const copy = el('div'); copy.append(el('strong', '', () => parent ? t('reply.author', { name: memberIn(room, parent.authorId).name }) : t('message.reply')),
        el('p', '', () => replyUnavailable ? t('reply.unavailable') : firstLine(messageText(parent))));
      const cancel = button(() => t('reply.cancel'), () => { current().replyToMessageId = undefined; updateComposer(); $('message').focus(); }, 'quiet');
      cancel.disabled = Boolean(room.pending); preview.append(copy, cancel);
    }
  }
  setText($('send-label'), () => t(room.pending?.status === 'sending' ? 'composer.sending' : 'composer.send'));
  $('composer').classList.toggle('is-readonly', !allowed);
  // The input folds away when speaking ends; keep keyboard focus somewhere visible.
  if (!allowed && document.activeElement === $('message')) $('timeline').focus();
  setText($('send-help'), () => allowed ? t('composer.keyboardHint') : readOnlyReason(room));
  const placeholder = allowed ? t('composer.threadPlaceholder', { thread: room.scope.threadId }) : t('composer.readOnlyPlaceholder');
  if ($('message').placeholder !== placeholder) $('message').placeholder = placeholder;
  renderSeatCard(room, allowed); renderExpiry(room, allowed);
}

function renderSeatCard(room, allowed) {
  const member = state.session.member, send = permission('send', room), left = (send.until ?? 0) - serverNow();
  const soon = allowed && left <= EXPIRY_NOTICE;
  const detail = allowed ? t('seat.availableUntil', { time: clock(send.until), duration: remaining(left) }) : send.reason === 'none' ? t('seat.noSpeaking') : t('seat.speakingLapsed', { reason: lapse(send) });
  const signature = JSON.stringify([member.id, allowed, detail, soon]);
  if (signature === state.ui.seat) return;
  state.ui.seat = signature;
  $('seat').classList.toggle('is-soon', soon);
  $('seat').replaceChildren(tile(member), el('span', 'seat-member', member.name), el('span', 'seat-standing', () => t(allowed ? 'seat.present' : 'seat.readOnly')), el('span', 'seat-detail', detail));
  if (!allowed) $('seat').prepend(icon('i-lock'));
}

function renderExpiry(room, allowed) {
  const until = deadline('send', room), left = until - serverNow();
  const text = allowed && left <= EXPIRY_NOTICE
    ? t(desktop ? 'permission.expiryDesktop' : 'permission.expiryBrowser', { time: clock(until), duration: remaining(left) })
    : '';
  if (text === state.ui.expiry) return;
  state.ui.expiry = text;
  $('expiry').replaceChildren(...(text ? [icon('i-clock'), el('span', '', text)] : []));
  $('expiry').hidden = !text;
}

function setPendingError(pending, render) { pending.errorRender = render; pending.error = render(); }

function renderOutbox() {
  const room = current(), pending = room?.pending;
  const signature = pending ? JSON.stringify([state.selected, pending.id, pending.status, pending.error, pending.checking, authorized('send', room)]) : '';
  if (signature === state.ui.outbox) return;
  state.ui.outbox = signature;
  const hadFocus = $('outbox').contains(document.activeElement);
  if (!pending) {
    $('outbox').replaceChildren(); if (hadFocus) $('timeline').focus({ preventScroll: true }); return;
  }
  const focusedAction = hadFocus && document.activeElement.dataset.action;
  if (focusedAction && focusedAction !== 'pending-status') pending.focusAction = focusedAction;
  const failed = pending.status === 'failed', node = el('div', `outbox-item is-${failed ? 'failed' : 'sending'}`), head = el('div', 'outbox-head');
  const status = el('p', '', () => pending.checking ? t('send.checking') : failed ? (pending.errorRender?.() ?? pending.error) : t('send.sending'));
  status.tabIndex = -1; status.dataset.action = 'pending-status';
  head.append(icon(failed ? 'i-alert' : 'i-clock'), status);
  node.append(head);
  if (failed) {
    const actions = el('div', 'outbox-actions');
    const check = button(() => t(pending.checking ? 'send.checkingAction' : 'send.check'), () => reconcilePending(current(), state.selected), 'outline-button');
    check.dataset.action = 'check-receipt'; check.disabled = Boolean(pending.checking); actions.append(check);
    if (authorized('send', room)) {
      const retry = button(() => t('send.retry'), () => sendPending(current(), state.selected), 'outline-button');
      retry.dataset.action = 'retry-send'; retry.disabled = Boolean(pending.checking); actions.append(retry);
    }
    actions.append(el('p', 'muted', () => t('send.receiptHelp')));
    if (pending.replyRejected) {
      const cancel = button(() => t('send.cancelReply'), () => void cancelPendingReply(current(), state.selected), 'outline-button');
      cancel.dataset.action = 'cancel-reply'; cancel.disabled = Boolean(pending.checking); actions.append(cancel);
    }
    node.append(actions);
  }
  $('outbox').replaceChildren(node);
  if (hadFocus) {
    const buttons = [...node.querySelectorAll('button:not(:disabled)')];
    (pending.checking ? status : buttons.find(button => button.dataset.action === pending.focusAction) ?? buttons[0] ?? status).focus({ preventScroll: true });
  }
}

async function cancelPendingReply(room, id) {
  const pending = room?.pending, client = state.client;
  if (!pending?.replyRejected || pending.checking || !client) return;
  pending.checking = true; renderOutbox();
  try {
    await room.store.remove(room.scope.outboxKey, pending.id);
    const latest = state.rooms.get(id);
    if (client !== state.client || latest?.cacheIdentity !== room.cacheIdentity || latest.pending !== pending) return;
    latest.pending = null; latest.replyToMessageId = undefined;
    if (id === state.selected) { updateComposer(); renderOutbox(); $('message').focus(); }
  } catch {
    setPendingError(pending, () => t('send.storageDeleteFailed'));
  } finally {
    pending.checking = false;
    if (client === state.client && state.rooms.get(id)?.pending === pending && id === state.selected) renderOutbox();
  }
}

function acceptPending(id, pending, result) {
  const latest = state.rooms.get(id);
  if (!latest || latest.pending !== pending || !authorized('read', latest)) return false;
  void latest.store.remove(latest.scope.outboxKey, pending.id).catch(() => {});
  invalidateSnapshot(latest);
  latest.pending = null; latest.draft = ''; latest.replyToMessageId = undefined; latest.seen.add(result.message.id);
  latest.attachment = undefined;
  if (!result.duplicate && !latest.messages.some(m => m.id === result.message.id)) latest.messages.push(result.message);
  if (id === state.selected) {
    $('message').value = ''; renderMessages(!result.duplicate); updateComposer(); renderOutbox();
    if (!result.duplicate && (!state.pane || !paneOverlay.matches)) (authorized('send', latest) ? $('message') : $('timeline')).focus();
  }
  renderRooms(); announce(() => t(result.duplicate ? 'send.duplicateConfirmed' : 'send.delivered'));
  return true;
}
async function reconcilePending(room, id) {
  const pending = room?.pending, client = state.client;
  if (!pending || pending.status === 'sending' || pending.checking || !client) return false;
  pending.checking = true; if (id === state.selected) renderOutbox();
  try {
    const result = await client.receipt(room.scope, pending.id);
    if (client !== state.client || state.rooms.get(id)?.pending !== pending) return false;
    if (result.message) return acceptPending(id, pending, { ...result, duplicate: true });
    if (!pending.replyRejected) setPendingError(pending, () => t('send.missingReceipt'));
  } catch (error) {
    if (client !== state.client) return false;
    if (error instanceof ApiError && error.status === 401) { invalidate(error); return false; }
    if (state.rooms.get(id)?.cacheIdentity !== room.cacheIdentity || state.rooms.get(id)?.pending !== pending) return false;
    if (error instanceof ApiError && error.status === 403) { denyReadScope(client, room); return false; }
    setPendingError(pending, () => errorText(error));
  } finally {
    pending.checking = false;
    if (client === state.client && state.rooms.get(id)?.pending === pending && id === state.selected) { updateComposer(); renderOutbox(); }
  }
  return false;
}
async function sendPending(room, id) {
  const pending = room.pending, client = state.client;
  if (!pending || pending.status === 'sending' || pending.checking || !client) return;
  if (pending.status === 'failed') {
    if (await reconcilePending(room, id) || client !== state.client || state.rooms.get(id)?.pending !== pending) return;
  }
  const latest = state.rooms.get(id);
  if (!latest || !authorized('send', latest)) return;
  pending.status = 'sending'; if (id === state.selected) { updateComposer(); renderOutbox(); }
  try {
    await room.store.save(room.scope.outboxKey, { id: pending.id, text: pending.text, conversationId: room.scope.conversationId, threadId: room.scope.threadId,
      membershipGeneration: room.scope.membershipGeneration, ...(pending.replyToMessageId ? { replyToMessageId: pending.replyToMessageId } : {}), ...(pending.attachment ? { attachment: pending.attachment } : {}) },
    Math.min(room.scope.outboxExpiresAt, deadline('read', room)));
    const currentRoom = state.rooms.get(id);
    if (client !== state.client || currentRoom?.cacheIdentity !== room.cacheIdentity || currentRoom.pending !== pending || !authorized('read', currentRoom)) return;
    if (!authorized('send', currentRoom)) {
      pending.status = 'failed'; setPendingError(pending, () => t('send.recovered'));
      if (id === state.selected) { updateComposer(); renderOutbox(); }
      return;
    }
    const result = await client.send(room.scope, pending.text, pending.id, pending.replyToMessageId, pending.attachment);
    if (client !== state.client) return;
    acceptPending(id, pending, result);
    await sync();
  } catch (error) {
    if (client !== state.client) return;
    if (error instanceof ApiError && error.status === 401) { invalidate(error); return; }
    pending.replyRejected = error instanceof ApiError && error.code === 'reply_source_unavailable';
    pending.status = 'failed'; setPendingError(pending, () => error?.message?.startsWith('pending_storage_') ? t('send.storageFailed') : pending.replyRejected ? t('send.replyRejected') : errorText(error)); announce(() => pending.errorRender?.() ?? pending.error);
    if (error instanceof ApiError && error.status === 403) await sync();
  }
  if (client === state.client && id === state.selected) { updateComposer(); renderOutbox(); }
}

function openPane(pane, trigger) {
  state.pane = pane;
  state.paneReturn = trigger?.dataset.action ? { action: trigger.dataset.action } : trigger?.id ? { id: trigger.id } : null;
  state.ui.pane = ''; renderPane(); $('details-title').focus();
}

function closePane(restoreFocus) {
  if (!state.pane) return;
  const back = state.paneReturn;
  state.pane = null; state.paneReturn = null; renderPane();
  if (!restoreFocus) return;
  const target = back?.action ? [...$('messages').querySelectorAll('[data-action]')].find(x => x.dataset.action === back.action) : back?.id ? $(back.id) : null;
  (target ?? $('timeline')).focus();
}

function renderPane() {
  const pane = state.pane, room = current();
  $('details').hidden = !pane; $('app').classList.toggle('has-pane', Boolean(pane));
  $('members-toggle').setAttribute('aria-expanded', String(pane?.kind === 'members'));
  $('search-toggle').setAttribute('aria-expanded', String(pane?.kind === 'search'));
  $('details-members').hidden = pane?.kind !== 'members';
  $('details-thread').hidden = pane?.kind !== 'discussion';
  $('details-search').hidden = pane?.kind !== 'search';
  if (pane?.kind !== 'search') {
    $('search-query').value = ''; $('search-results').replaceChildren(); $('search-count').textContent = '';
  }
  updatePaneAccessibility();
  if (!pane) {
    state.ui.pane = '';
    for (const id of ['my-seat', 'members', 'details-thread']) $(id).replaceChildren();
    return;
  }
  if (!room) return;
  if (pane.kind === 'search') renderSearchPane(room);
  else if (pane.kind === 'members') renderMembersPane(room);
  else renderThreadPane(room, pane.messageId);
}

function renderSearchPane(room, focusId) {
  const pane = state.pane, query = pane.query.trim().toLowerCase();
  const matches = query && authorized('read', room) ? room.messages.filter(message =>
    !message.retracted && !message.invalidated && message.text.toLowerCase().includes(query)).reverse() : [];
  const shown = matches.slice(0, pane.limit), signature = JSON.stringify(['search', key(room.scope), query, pane.limit, matches]);
  if (signature === state.ui.pane) return;
  const restoreFocus = $('search-results').contains(document.activeElement);
  focusId ??= document.activeElement?.dataset.searchMessage;
  state.ui.pane = signature; setText($('details-title'), () => t('search.title'));
  setText($('search-count'), () => !query ? t('search.prompt') : matches.length ? t('search.count', { total: matches.length, shown: shown.length }) : t('search.empty'));
  const nodes = shown.map(message => {
    const row = button('', () => {
      const latest = current();
      if (!latest || key(latest.scope) !== key(room.scope) || !authorized('read', latest)) return;
      const target = latest.messages.find(item => item.id === message.id);
      if (!target || target.retracted || target.invalidated) return;
      closePane(false); focusMessage(message.id);
    }, 'search-result');
    row.dataset.searchMessage = message.id;
    const head = el('span', 'thread-head');
    head.append(el('strong', '', memberIn(room, message.authorId).name), timeNode(message.createdAt));
    const start = Math.max(0, message.text.toLowerCase().indexOf(query) - 60), end = start + 240;
    row.append(head, el('span', 'search-excerpt', `${start ? '…' : ''}${message.text.slice(start, end)}${message.text.length > end ? '…' : ''}`));
    return row;
  });
  if (matches.length > shown.length) nodes.push(button(() => t('search.more'), () => { pane.limit += 50; renderSearchPane(current(), matches[shown.length]?.id); }, 'text-button'));
  $('search-results').replaceChildren(...nodes);
  if (restoreFocus) (nodes.find(node => node.dataset.searchMessage === focusId) ?? $('search-query')).focus();
}

function updatePaneAccessibility() {
  const modal = Boolean(state.pane) && paneOverlay.matches;
  $('sidebar').inert = modal; $('chat').inert = modal;
  if (modal) {
    $('details').setAttribute('role', 'dialog'); $('details').setAttribute('aria-modal', 'true');
  } else {
    $('details').removeAttribute('role'); $('details').removeAttribute('aria-modal');
  }
}
paneOverlay.addEventListener('change', () => {
  updatePaneAccessibility();
  if (state.pane && paneOverlay.matches && !$('details').contains(document.activeElement)) $('details-title').focus();
});

function renderMembersPane(room) {
  const live = new Set(room.runs.filter(run => LIVE.has(run.status)).map(run => run.memberId));
  const permissions = ['read', 'send', 'cancel'].map(name => [name, permission(name, room)]);
  const signature = JSON.stringify(['members', key(room.scope), room.scope.members, [...live], permissions]);
  if (signature === state.ui.pane) return;
  state.ui.pane = signature;
  setText($('details-title'), () => t('seat.title'));
  const member = state.session.member, speaking = authorized('send', room), head = el('div', 'my-seat-head'), copy = el('div');
  copy.append(el('strong', '', member.name), el('span', '', () => t('member.selfKind', { kind: kindLabel(member) })));
  head.append(tile(member), copy, el('span', speaking ? 'standing' : 'standing is-readonly', () => t(speaking ? 'seat.present' : 'seat.readOnly')));
  const names = { read: t('permission.read'), send: t('permission.send'), cancel: t('permission.cancel') }, list = el('dl', 'perm-list');
  for (const [name, grant] of permissions) {
    list.append(el('dt', '', names[name]), el('dd', grant.allowed ? 'perm-on' : 'perm-off', () => grant.allowed ? t('permission.availableUntil', { time: clock(grant.until) }) : lapse(grant)));
  }
  $('my-seat').replaceChildren(head, list);
  $('members').replaceChildren(...room.scope.members.map(person => {
    const row = el('li'), name = el('span', 'member-name');
    name.append(el('strong', '', person.name), el('span', '', () => isMe(person.id) ? t('member.selfKind', { kind: kindLabel(person) }) : kindLabel(person)));
    row.append(tile(person), name);
    if (live.has(person.id)) { const working = el('span', 'member-state is-live'); working.append(el('span', 'live-dot'), t('member.researching')); row.append(working); }
    return row;
  }));
}

function renderThreadPane(room, messageId) {
  const ctx = context(room), root = ctx.roots.get(messageId);
  const messages = ctx.discussions.get(root) ?? [];
  const runs = room.runs.filter(run => ctx.roots.get(run.sourceMessageId) === root);
  const signature = JSON.stringify(['discussion', messageId, messages, runs, authorized('send', room)]);
  if (signature === state.ui.pane) return;
  state.ui.pane = signature;
  setText($('details-title'), () => t('discussion.title'));
  const nodes = [el('p', 'thread-intro', () => t('discussion.intro'))];
  if (!messages.length) nodes.push(el('p', 'pane-note', () => t('discussion.unavailable')));
  for (const message of messages) {
    nodes.push(threadMessage(room, message, ctx));
    for (const run of runs.filter(r => r.sourceMessageId === message.id)) nodes.push(threadRun(room, run, ctx));
  }
  nodes.push(el('p', 'pane-note', () => t('discussion.help')));
  $('details-thread').replaceChildren(...nodes);
}

function threadMessage(room, message, ctx) {
  const member = memberIn(room, message.authorId), item = el('article', 'thread-item'), head = el('div', 'thread-head');
  head.append(el('strong', '', member.name), el('span', 'kind', kindLabel(member)), timeNode(message.createdAt));
  item.append(head);
  if (message.result) item.append(el('span', 'thread-synthetic', () => t('result.synthetic')));
  if (message.replyToMessageId) item.append(replyQuote(room, message, ctx));
  item.append(el('p', 'thread-text', messageText(message)));
  if (!message.retracted && !message.invalidated && authorized('send', room)) item.append(button(() => t('message.reply'), () => chooseReply(room, message), 'text-button'));
  if (message.result) {
    const list = el('ol', 'thread-sources');
    message.result.sources.forEach((source, index) => {
      const row = el('li'), copy = el('div');
      copy.append(el('strong', 'source-title', source.title), el('p', 'source-excerpt', source.excerpt), el('span', 'source-url', () => t('result.placeholderUrl', { url: source.url })));
      row.append(el('span', 'source-key', String(index + 1)), copy); list.append(row);
    });
    const limits = el('div', 'thread-limits'); limits.append(el('strong', '', () => t('result.limitations')));
    for (const limitation of message.result.limitations) limits.append(el('p', '', limitation));
    item.append(list, limits);
  }
  return item;
}

function threadRun(room, run, ctx) {
  const box = el('div', 'thread-run'), top = el('div', 'thread-run-top'), status = el('span', 'thread-status');
  status.append(icon(`st-${run.status}`, `mark st-${run.status}`), el('span', '', () => runLabel(run.status)));
  top.append(status, el('span', 'run-title', () => t('run.ownerLabel', { number: ctx.code.get(run.id), name: memberIn(room, run.memberId).name })));
  box.append(top, stepsNode(run), el('p', 'run-note', runNote(run)));
  return box;
}

$('connect-form').addEventListener('submit', async event => {
  if (!desktopLanguageReady) { event.preventDefault(); return; }
  event.preventDefault(); if ($('connect-button').disabled) return;
  const token = desktop ? 'local-demo' : $('token').value.trim(); if (!token) return;
  $('connect-button').disabled = true; bindText($('connect-button'), () => t('connect.connecting')); $('connect-error').textContent = '';
  const client = new Client(token); $('token').value = ''; $('token').setAttribute('aria-invalid', 'false');
  try {
    const session = await client.session(); state.client = client; state.epoch++;
    if (desktop) void desktop.core.invoke('desktop_connected', { connected: true });
    sessionReceived(session); $('connect').hidden = true; $('app').hidden = false;
    $('message').value = current()?.draft ?? ''; renderMessages(true); renderOutbox(); await sync();
    if (state.client) (current() ? $('message') : $('create-conversation').hidden ? $('manage-conversation') : $('create-conversation')).focus();
  } catch (error) { client.close(); invalidate(error); }
});
$('composer').addEventListener('submit', event => {
  event.preventDefault(); const room = current(), text = $('message').value.trim();
  if (!room || room.pending || !text || !authorized('send') || $('send').disabled) return;
  const id = crypto.randomUUID();
  if (new TextEncoder().encode(JSON.stringify(messageBody(room.scope, text, id, room.replyToMessageId, room.attachment))).length > 60000) {
    bindText($('attachment-error'), () => t('attachment.requestTooLarge')); return;
  }
  room.draft = text; room.pending = { id, text, replyToMessageId: room.replyToMessageId, attachment: room.attachment, status: 'new', error: '' };
  void sendPending(room, state.selected);
});
$('message').addEventListener('input', () => { if (current() && !current().pending) current().draft = $('message').value; updateComposer(); });
$('message').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); $('composer').requestSubmit(); } });
$('token').addEventListener('input', () => $('token').setAttribute('aria-invalid', 'false'));
$('logout').addEventListener('click', () => invalidate());
$('members-toggle').addEventListener('click', event => { if (state.pane?.kind === 'members') closePane(true); else openPane({ kind: 'members' }, event.currentTarget); });
$('search-toggle').addEventListener('click', event => {
  if (state.pane?.kind === 'search') closePane(true);
  else { openPane({ kind: 'search', query: '', limit: 50 }, event.currentTarget); $('search-query').focus(); }
});
$('search-query').addEventListener('input', () => {
  if (state.pane?.kind !== 'search') return;
  state.pane.query = $('search-query').value; state.pane.limit = 50; renderSearchPane(current());
});
$('details-close').addEventListener('click', () => closePane(true));
$('reconnect').addEventListener('click', () => void sync());
$('back').addEventListener('click', () => {
  closePane(false); const room = current(), position = rememberScroll();
  if (room?.loaded && position) room.scrollPosition = position;
  $('app').classList.add('show-rooms'); $('rooms').querySelector('[aria-current=true]')?.focus();
});
$('new-messages').addEventListener('click', () => {
  const message = unreadMessages(current())[0];
  if (!message || !scrollToMessage(message.id, 24)) $('timeline').scrollTop = $('timeline').scrollHeight;
  markSeen(current()); $('new-messages').hidden = true;
  const target = message && [...$('messages').children].find(node => node.dataset.message === message.id);
  (target || $('timeline')).focus({ preventScroll: true });
});
$('timeline').addEventListener('scroll', () => {
  const timeline = $('timeline');
  if (!$('new-messages').hidden && timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 90) $('new-messages').hidden = true;
  markSeen(current());
}, { passive: true });
document.addEventListener('keydown', event => {
  if (event.isComposing || !state.client || $('app').hidden || $('message-change').open || $('conversation-management').open || attachmentUI.opened || leaveDialog.opened) return;
  if (event.key === 'Escape' && state.pane) { event.preventDefault(); closePane($('details').contains(document.activeElement)); return; }
  if (state.pane && paneOverlay.matches && event.key === 'Tab') {
    const targets = [...$('details').querySelectorAll('button, a[href], input, select, textarea, [tabindex]')]
      .filter(node => !node.disabled && node.tabIndex >= 0 && node.getClientRects().length);
    const first = targets[0] ?? $('details-title'), last = targets.at(-1) ?? first;
    if (event.shiftKey && (document.activeElement === first || !targets.includes(document.activeElement))) {
      event.preventDefault(); last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || !targets.includes(document.activeElement))) {
      event.preventDefault(); first.focus();
    }
    return;
  }
  if (event.altKey && !event.ctrlKey && !event.metaKey && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
    const ids = [...state.rooms.keys()], index = ids.indexOf(state.selected);
    const next = ids[(index + (event.key === 'ArrowDown' ? 1 : ids.length - 1)) % ids.length];
    if (next && next !== state.selected) { event.preventDefault(); void selectRoom(next); }
  }
});
window.addEventListener('online', () => void sync());
window.addEventListener('focus', expireReadScopes);
document.addEventListener('visibilitychange', () => { if (!document.hidden) expireReadScopes(); });
window.addEventListener('pagehide', () => invalidate(undefined, true));
window.addEventListener('beforeunload', event => { if ([...state.rooms.values()].some(room => room.pending)) { event.preventDefault(); event.returnValue = ''; } });
if (desktop && desktopLanguageReady) {
  $('token').required = false; $('token').hidden = true;
  document.querySelector('label[for="token"]').hidden = true;
  bindText($('connect-button'), () => t('desktop.enter'));
  bindText($('credential-help'), () => t('desktop.help'));
  bindText(document.querySelector('.demo-note'), () => t('desktop.demoNote', { version: '0.1.3' }));
  bindText($('logout').querySelector('span'), () => t('desktop.disconnect'));
  const actions = el('div', 'desktop-actions'), quit = button('', () => desktop.core.invoke('desktop_quit'), 'rail-button');
  quit.append(icon('i-power'), el('span', '', () => t('desktop.quit')));
  $('logout').before(actions); actions.append($('logout'), quit);
  document.querySelector('.connect-body').append(button(() => t('desktop.quit'), () => desktop.core.invoke('desktop_quit'), 'quiet connect-quit'));
  const noticePanel = el('section', 'connection-page'); noticePanel.hidden = true;
  noticePanel.append(el('p', '', () => t('desktop.checkingNotice'))); document.body.append(noticePanel);
  let noticeBusy = false, noticePending = false;
  async function openNotification() {
    noticePending = true;
    if (noticeBusy) return; noticeBusy = true;
    let handled = false;
    try {
      do {
        noticePending = false;
        try {
          for (;;) {
            const result = await desktop.core.invoke('desktop_take_notification');
            if (result.kind === 'none') break;
            handled = true;
            $('app').hidden = true; $('connect').hidden = true; noticePanel.hidden = false;
            state.epoch++; state.syncing = false; clearTimeout(state.timer);
            if (result.kind === 'open' && state.client) {
              const client = state.client;
              const session = await client.session();
              if (client !== state.client) throw new ApiError(401, 'connection_changed');
              sessionReceived(session);
              const id = key(result.scope);
              if (!state.rooms.has(id)) throw new ApiError(403, 'scope_denied');
              if (!await selectRoom(id) || client !== state.client) throw new Error('notification_sync_failed');
              $('app').hidden = false; $('connect').hidden = true;
            } else if (result.kind === 'unauthorized') {
              invalidate(new ApiError(Number(result.status) || 403, 'notification_access_denied'));
            } else {
              invalidate();
              bindText($('connect-error'), () => result.reason === 'disconnected'
                ? t('desktop.noticeDisconnected')
                : t('desktop.noticeUnavailable'));
            }
            noticePanel.hidden = true;
          }
        } catch (error) { handled = true; noticePanel.hidden = true; invalidate(error); }
        // An activation can arrive after native code took an empty queue but
        // before its IPC response reaches us. Keep one consumer and drain again
        // for recorded wake-ups, including those received during a failed read.
      } while (noticePending);
    } finally {
      noticeBusy = false;
      // Duplicate wake-ups can hide the views without yielding another notice.
      // Restore the current authorized state (or the cleared error view).
      noticePanel.hidden = true;
      $('app').hidden = !state.client; $('connect').hidden = Boolean(state.client);
      if (handled) await desktop.core.invoke('desktop_present');
    }
  }
  void desktop.event.listen('desktop-notification', () => {
    // Hide any cached content immediately; native window restoration happens only
    // after this handler has loaded freshly authorized state or a safe error view.
    $('app').hidden = true; $('connect').hidden = true; noticePanel.hidden = false;
    void openNotification();
  }).then(() => openNotification());
}

presentation.subscribe(() => {
  document.documentElement.lang = presentation.locale;
  const focused = document.activeElement, container = focused.closest('#details,#messages,#outbox,#rooms')?.id;
  const action = focused.dataset.action, room = focused.dataset.room, search = focused.dataset.searchMessage;
  const selection = typeof focused.selectionStart === 'number' ? [focused.selectionStart, focused.selectionEnd, focused.selectionDirection] : null;
  changingLanguage = true;
  try {
    // Repaint derived display only. Never reconnect, resubmit, re-read, or change
    // drafts/receipts/identity/deadlines as a side effect of language selection.
    for (const item of state.rooms.values()) {
      item.signature = '';
      if (item.pending?.errorRender) item.pending.error = item.pending.errorRender();
    }
    for (const name of ['seats', 'seat', 'expiry', 'pane', 'outbox']) state.ui[name] = '';
    delete $('reply-preview').dataset.signature;
    if (state.session) {
      renderIdentity(); renderRooms(); renderHeader(); renderMessages(); renderPane(); renderOutbox(); updateMessageChange();
    }
    const parent = container ? $(container) : document;
    const target = focused.isConnected ? focused : focused.id ? $(focused.id)
      : [...parent.querySelectorAll('[data-action],[data-room],[data-search-message]')].find(node =>
        action ? node.dataset.action === action : room ? node.dataset.room === room : search && node.dataset.searchMessage === search);
    if (target && !target.disabled) {
      target.focus({ preventScroll: true });
      if (selection && target.setSelectionRange) target.setSelectionRange(...selection);
    }
  } finally {
    // Layout-induced scroll events must not write a read receipt for a language change.
    requestAnimationFrame(() => requestAnimationFrame(() => { changingLanguage = false; }));
  }
});
