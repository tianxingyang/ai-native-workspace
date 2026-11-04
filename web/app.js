import { Client, ApiError, errorText } from './client.js';

const $ = id => document.getElementById(id);
const desktop = window.__TAURI__;
const SVG = 'http://www.w3.org/2000/svg';
const key = scope => JSON.stringify([scope.conversationId, scope.threadId]);
const state = {
  client: null, session: null, selected: '', rooms: new Map(), epoch: 0, timer: null, expiryTimer: null, syncing: false, offset: 0,
  cancels: new Map(), pane: null, paneReturn: null, lastSync: 0,
  // Render signatures keep focus, selection and open disclosures stable across polling.
  ui: { nav: '', seats: '', seat: '', expiry: '', pane: '', outbox: '' },
};
const labels = { queued: '等待执行', running: '正在研究', cancel_requested: '等待停止确认', completed: '已完成', failed: '执行失败', stopped: '已停止', unknown: '执行结果待核对' };
const LIVE = new Set(['queued', 'running', 'cancel_requested']);
const SETTLED = new Set(['cancel_requested', 'completed', 'failed', 'stopped']);
const GROUP_WINDOW = 5 * 60 * 1000;
const EXPIRY_NOTICE = 5 * 60 * 1000;
const paneOverlay = matchMedia('(max-width: 1179px)');
const SUGGESTIONS = ['请调研一下插件协议', '大家好，同步一下今天的进展。'];

let cancellationRevision = 0;
let messageChange = null;
function el(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }
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
function setText(node, text) { if (node.textContent !== text) node.textContent = text; }
function current() { return state.rooms.get(state.selected); }
function serverNow() { return Date.now() + state.offset; }
function deadline(action, room = current()) { return room?.scope.permissions[action] ?? 0; }
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
function announce(text) { $('announcement').textContent = text; }
function clock(ts) { return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }); }
function clockSeconds(ts) { return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
function remaining(ms) { const minutes = Math.max(1, Math.ceil(ms / 60000)); return minutes >= 60 ? `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟` : `${minutes} 分钟`; }
function initial(name) { return [...name.trim()][0] ?? '?'; }
function kindLabel(member) { return member.kind === 'agent' ? 'Agent' : '人类'; }
function isMe(id) { return id === state.session?.member.id; }
function memberIn(room, id) { return room.scope.members.find(member => member.id === id) ?? { id, name: '成员', kind: 'human' }; }
function firstLine(text) { return text.split('\n').find(line => line.trim()) ?? text; }
function tile(member, className = '') { const node = el('span', `tile ${member.kind} ${className}`.trim(), initial(member.name)); node.setAttribute('aria-hidden', 'true'); return node; }
function timeNode(ts, text = clock(ts)) { const node = el('time', '', text); node.dateTime = new Date(ts).toISOString(); node.title = new Date(ts).toLocaleString('zh-CN'); return node; }
function startOfDay(ts) { const day = new Date(ts); return new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime(); }
function dayLabel(ts) {
  const diff = Math.round((startOfDay(Date.now()) - startOfDay(ts)) / 86400000);
  if (diff === 0) return '今天';
  if (diff === 1) return '昨天';
  return new Date(ts).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' });
}
function roomTime(ts) { return startOfDay(ts) === startOfDay(Date.now()) ? clock(ts) : new Date(ts).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }); }
function unseen(room) { return room.messages.filter(message => !room.seen.has(message.id) && !isMe(message.authorId)).length; }
function markSeen(room) { for (const message of room.messages) room.seen.add(message.id); }
function accessEnded() { return state.rooms.size > 0 && [...state.rooms.values()].every(room => deadline('read', room) <= serverNow()); }

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
    for (const run of room.runs) state.cancels.delete(run.id);
    state.rooms.delete(id);
  }
  if (!state.rooms.size) { invalidate(new ApiError(403, 'grant_expired')); return; }
  state.session.scopes = state.session.scopes.filter(scope => state.rooms.has(key(scope)));
  setText($('room-count'), `${state.rooms.size} 个讨论`);
  if (!state.rooms.has(state.selected)) {
    void selectRoom(state.rooms.keys().next().value);
    announce('当前会话的阅读授权已到期，缓存已清除，已切换到仍获授权的会话。');
  } else renderRooms();
  const next = Math.min(...[...state.rooms.values()].map(room => deadline('read', room)));
  state.expiryTimer = setTimeout(expireReadScopes, Math.min(2147483647, Math.max(1, next - serverNow())));
}

function invalidate(error) {
  closeMessageChange();
  if (desktop) void desktop.core.invoke('desktop_connected', { connected: false });
  state.client?.close(); state.client = null; state.epoch++; clearTimeout(state.timer); clearTimeout(state.expiryTimer); state.syncing = false;
  state.session = null; state.rooms.clear(); state.cancels.clear(); state.selected = ''; state.lastSync = 0;
  state.pane = null; state.paneReturn = null;
  for (const name of Object.keys(state.ui)) state.ui[name] = '';
  $('app').hidden = true; $('connect').hidden = false; $('token').value = ''; $('message').value = '';
  for (const id of ['messages', 'rooms', 'outbox', 'seats', 'seat', 'members', 'my-seat', 'details-thread', 'identity']) $(id).replaceChildren();
  $('details').hidden = true; $('app').classList.remove('show-rooms', 'has-pane'); $('members-toggle').setAttribute('aria-expanded', 'false');
  updatePaneAccessibility();
  $('announcement').textContent = '';
  $('sync-error').hidden = true; $('new-messages').hidden = true; $('expiry').hidden = true;
  $('connection-status').dataset.state = 'pending'; $('connection-status').textContent = '正在连接';
  // Only a rejected credential is a field error; expiry and denial are about access, not input.
  $('token').setAttribute('aria-invalid', String(!desktop && error instanceof ApiError && error.status === 401));
  $('connect-error').textContent = error ? errorText(error) : '';
  $('connect-button').disabled = false; $('connect-button').textContent = desktop ? '进入本地演示' : '连接会话';
  (desktop ? $('connect-button') : $('token')).focus();
}

function sessionReceived(session) {
  // A slower response must not move our known server clock backwards and revive
  // a scope whose deadline was already reached while that request was in flight.
  const offset = session.serverTime - Date.now();
  state.offset = state.session ? Math.max(state.offset, offset) : offset;
  session.scopes = session.scopes.filter(scope => scope.permissions.read > serverNow());
  if (!session.scopes.length) throw new ApiError(403, 'grant_expired');
  state.session = session;
  const next = new Map();
  for (const scope of session.scopes) {
    const id = key(scope), old = state.rooms.get(id), known = { ...old?.known };
    for (const [name, until] of Object.entries(scope.permissions)) if (until > 0) known[name] = until;
    next.set(id, old ? { ...old, scope, known } : { scope, known, messages: [], runs: [], loaded: false, draft: '', pending: null, signature: '', seen: new Set(), rendered: 0 });
  }
  state.rooms = next;
  if (!next.has(state.selected)) { state.selected = next.keys().next().value; state.pane = null; renderPane(); }
  renderIdentity();
  setText($('room-count'), `${session.scopes.length} 个讨论`);
  renderRooms(); renderHeader();
  expireReadScopes();
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
      top.append(el('strong', 'room-name', room.scope.conversationId), el('span', 'room-thread', room.scope.threadId), el('span', 'room-time'));
      bottom.append(el('span', 'room-preview'), el('span', 'room-badge'));
      copy.append(top, bottom);
      const roomTile = el('span', 'tile', initial(room.scope.conversationId)); roomTile.setAttribute('aria-hidden', 'true');
      item.append(roomTile, copy); children.push(item);
    }
    $('rooms').replaceChildren(...children);
  }
  for (const item of $('rooms').children) { const room = state.rooms.get(item.dataset.room); if (room) updateRoomItem(item, room); }
}

function updateRoomItem(item, room) {
  const selected = item.dataset.room === state.selected, last = room.messages.at(-1);
  const live = room.runs.find(run => LIVE.has(run.status)), fresh = selected ? 0 : unseen(room);
  const text = live ? `${memberIn(room, live.memberId).name} 正在调研` : last ? `${memberIn(room, last.authorId).name}：${firstLine(last.text)}` : room.loaded ? '还没有消息' : '';
  const preview = item.querySelector('.room-preview'), previewSignature = JSON.stringify([text, Boolean(live)]);
  if (preview.dataset.signature !== previewSignature) {
    preview.dataset.signature = previewSignature;
    preview.replaceChildren(...(live ? [el('span', 'live-dot'), text] : [text]));
  }
  setText(item.querySelector('.room-time'), last ? roomTime(last.createdAt) : '');
  const badge = item.querySelector('.room-badge'); setText(badge, fresh ? String(fresh) : ''); badge.hidden = !fresh;
  item.classList.toggle('is-live', Boolean(live)); item.classList.toggle('has-new', fresh > 0);
  const label = [`${room.scope.conversationId} ${room.scope.threadId}`, live && '调研进行中', fresh && `${fresh} 条新消息`].filter(Boolean).join('，');
  if (item.getAttribute('aria-label') !== label) item.setAttribute('aria-label', label);
}

function renderHeader() {
  const room = current(); if (!room) return;
  const { conversationId, threadId, members } = room.scope;
  setText($('room-title'), conversationId);
  setText($('thread-title'), `${threadId} · ${members.length} 位成员`);
  setText($('room-tile'), initial(conversationId));
  setText($('members-count'), `${members.length} 位成员`);
  setText($('members-short'), String(members.length));
  setText($('scope-note'), `消息发送到「${conversationId} › ${threadId}」。可编辑或撤回自己的消息；暂不支持附件和私聊。`);
  renderSeats(room); updateComposer();
}

function renderSeats(room) {
  const live = new Set(room.runs.filter(run => LIVE.has(run.status)).map(run => run.memberId));
  const shown = room.scope.members.slice(0, 4);
  const signature = JSON.stringify([shown, [...live], state.session?.member.id, room.scope.members.length]);
  if (signature === state.ui.seats) return;
  state.ui.seats = signature;
  const seats = shown.map(member => {
    const working = live.has(member.id), seat = el('li', working ? 'seat is-live' : 'seat');
    seat.append(tile(member), el('span', 'seat-name', member.name));
    if (working) seat.append(el('span', 'live-dot'));
    seat.append(el('span', 'seat-kind', working ? '调研中' : isMe(member.id) ? '你' : kindLabel(member)));
    return seat;
  });
  if (room.scope.members.length > shown.length) seats.push(el('li', 'seats-more', `+${room.scope.members.length - shown.length}`));
  $('seats').replaceChildren(...seats);
}

function selectRoom(id) {
  if (!state.rooms.has(id)) return;
  if (!authorized('read', state.rooms.get(id))) { expireReadScopes(); return; }
  const old = current(); if (old && !old.pending) old.draft = $('message').value;
  state.selected = id; state.epoch++; state.syncing = false;
  clearTimeout(state.timer); $('app').classList.remove('show-rooms');
  if (state.pane) { state.pane = null; state.paneReturn = null; renderPane(); }
  const room = current(); $('message').value = room.draft; markSeen(room);
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
    if (selection !== state.selected) { $('message').value = current().draft; renderMessages(true); }
    // Every authorized room is refreshed so the list can show activity; only the
    // open room's failure decides the connection state.
    const ids = [...state.rooms.keys()], revision = cancellationRevision;
    const results = await Promise.allSettled(ids.map(id => client.snapshot(state.rooms.get(id).scope)));
    if (epoch !== state.epoch) return;
    // None of this batch may replace a newer cancellation acknowledgement.
    if (revision !== cancellationRevision) return;
    const opened = results[ids.indexOf(state.selected)];
    if (opened.status === 'rejected') throw opened.reason;
    ids.forEach((id, index) => {
      const room = state.rooms.get(id), result = results[index];
      if (room && result.status === 'fulfilled') applySnapshot(room, result.value, id === state.selected);
    });
    renderRooms(); renderSeats(current()); renderMessages(); renderPane(); renderOutbox();
    state.lastSync = Date.now(); setConnection('ok'); $('sync-error').hidden = true;
    return true;
  } catch (error) {
    if (epoch !== state.epoch) return;
    if (error instanceof ApiError && [401, 403].includes(error.status)) { invalidate(error); return; }
    // The server has already said when access ends; past that point an unreachable
    // service is expiry, not a transient outage worth retrying forever.
    if (!(error instanceof ApiError) && accessEnded()) { invalidate(new ApiError(403, 'grant_expired')); return; }
    setConnection('down');
    $('sync-error-text').textContent = `${errorText(error)} ${state.lastSync ? `当前显示 ${clock(state.lastSync)} 同步的记录。` : '当前显示上次同步的记录。'}`;
    $('sync-error').hidden = false;
  } finally {
    if (epoch === state.epoch) { state.syncing = false; if (state.client) { updateComposer(); state.timer = setTimeout(sync, 1200); } }
  }
}

function setConnection(value) {
  const node = $('connection-status'); node.dataset.state = value;
  setText(node, value === 'ok' ? '已连接' : '连接中断');
}

function applySnapshot(room, data, selected) {
  const before = new Map(room.runs.map(run => [run.id, run.status])), firstLoad = !room.loaded;
  room.messages = data.messages; room.runs = data.runs; room.loaded = true;
  if (messageChange?.roomId === key(room.scope) && room.messages.find(m => m.id === messageChange.messageId)?.retracted) closeMessageChange();
  for (const run of room.runs) if (SETTLED.has(run.status)) state.cancels.delete(run.id);
  // Activity counts are local to this page session; nothing is reported back as a read receipt.
  if (firstLoad || selected) markSeen(room);
  if (!selected || firstLoad) return;
  room.runs.forEach((run, index) => {
    const previous = before.get(run.id);
    if (previous === undefined) announce(`${memberIn(room, run.memberId).name} 已认领调研 #${index + 1}。`);
    else if (previous !== run.status && !LIVE.has(run.status)) announce(`调研 #${index + 1}：${labels[run.status] ?? '状态待核对'}。`);
  });
}

function context(room) {
  const runsBySource = new Map(), resultsBySource = new Map(), code = new Map();
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
  return { runsBySource, resultsBySource, code, byId: new Map(room.messages.map(message => [message.id, message])) };
}

// Consecutive messages from one author read as one turn, as in familiar IMs.
// Research results and messages that carry a research card always restart the
// header, so agent work never hides inside someone else's turn.
function continues(previous, message, ctx) {
  return Boolean(previous) && previous.authorId === message.authorId
    && message.createdAt - previous.createdAt < GROUP_WINDOW
    && !previous.result && !message.result
    && !ctx.runsBySource.has(previous.id);
}

function renderMessages(force = false) {
  const room = current(); if (!room) return;
  const signature = JSON.stringify([room.messages, room.runs, authorized('cancel'), authorized('send'), [...state.cancels], room.loaded]);
  if (!force && signature === room.signature) return;
  room.signature = signature;
  const timeline = $('timeline'), previousScroll = timeline.scrollTop;
  const atBottom = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 90;
  const expanded = new Set([...$('messages').querySelectorAll('details[open]')].map(x => x.dataset.message));
  const focused = $('messages').contains(document.activeElement) ? document.activeElement.dataset.action : undefined;
  const ctx = context(room), nodes = [];
  let previous = null, day = '';
  for (const message of room.messages) {
    const label = dayLabel(message.createdAt);
    if (label !== day) { day = label; previous = null; const divider = el('div', 'day-divider', label); divider.setAttribute('role', 'separator'); nodes.push(divider); }
    nodes.push(renderMessage(room, message, previous, ctx, expanded));
    previous = message;
  }
  if (!room.messages.length) nodes.push(emptyState(room));
  $('messages').replaceChildren(...nodes);
  if (focused) ([...$('messages').querySelectorAll('[data-action]')].find(x => x.dataset.action === focused) ?? timeline).focus({ preventScroll: true });
  const grew = room.messages.length > room.rendered; room.rendered = room.messages.length;
  if (force || atBottom) { timeline.scrollTop = timeline.scrollHeight; $('new-messages').hidden = true; }
  else { timeline.scrollTop = previousScroll; if (grew) $('new-messages').hidden = false; }
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
    if (isMe(member.id)) head.append(el('span', 'kind you', '你'));
    head.append(timeNode(message.createdAt)); body.append(head);
  }
  if (message.result) body.append(...resultHead(room, message, ctx));
  body.append(el('p', 'message-text', message.retracted ? '消息已撤回' : message.invalidated ? '原上下文已变更，此结果已失效。' : message.text));
  if (message.changedAt && !message.retracted) body.append(el('span', 'kind', '已编辑'));
  if (message.result) body.append(sourcesNode(message, expanded));
  const actions = el('div', 'message-actions');
  if (message.origin === 'chat' && isMe(message.authorId) && !message.retracted && authorized('send', room)) {
    actions.append(action('编辑消息', `edit-${message.id}`, () => openMessageChange(room, message, 'edit')),
      action('撤回消息', `retract-${message.id}`, () => openMessageChange(room, message, 'retract')));
  }
  if (message.sourceMessageId) actions.append(action('查看来源消息与讨论', `source-${message.id}`, event => openPane({ kind: 'discussion', messageId: message.sourceMessageId }, event.currentTarget)));
  else if (runs.length || ctx.resultsBySource.has(message.id)) actions.append(action('查看这条消息的讨论', `source-${message.id}`, event => openPane({ kind: 'discussion', messageId: message.id }, event.currentTarget)));
  if (actions.firstElementChild) body.append(actions);
  for (const run of runs) body.append(renderRun(room, run, ctx));
  article.append(body);
  return article;
}

function resultHead(room, message, ctx) {
  const head = el('div', 'result-head'), nodes = [head];
  head.append(el('span', 'result-label', '模拟研究结果 · 合成资料'));
  const run = (ctx.runsBySource.get(message.sourceMessageId) ?? []).find(item => item.memberId === message.authorId);
  if (run) head.append(el('span', 'run-code', `调研 #${ctx.code.get(run.id)}`));
  const source = ctx.byId.get(message.sourceMessageId);
  if (source) {
    const quote = el('div', 'quote');
    quote.append(el('span', 'quote-author', `回应 ${memberIn(room, source.authorId).name}`), el('span', 'quote-text', firstLine(source.text)));
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
  summary.append(icon('i-chevron'), el('span', '', `${sources.length} 条合成来源与限制`), keys);
  const list = el('ol', 'source-list');
  sources.forEach((source, index) => {
    const item = el('li'), copy = el('div');
    copy.append(el('strong', 'source-title', source.title), el('p', 'source-excerpt', source.excerpt), el('span', 'source-url', `${source.url}（测试占位地址，不可作为证据链接）`));
    item.append(el('span', 'source-key', String(index + 1)), copy); list.append(item);
  });
  details.append(summary, list);
  if (limitations.length) {
    const limits = el('div', 'limits'); limits.append(el('strong', '', '限制'));
    for (const limitation of limitations) limits.append(el('p', '', limitation));
    details.append(limits);
  }
  return details;
}

function runNote(run) {
  if (run.invalidatedBy || run.contextInvalidated) {
    if (run.status === 'unknown') return '消息变更已收到；旧运行停止未确认，暂不重建，也不发布旧结果。';
    if (run.replacementRunId) return '旧上下文已失效，已创建新的研究；应用状态见新研究进度。';
    if (!['completed', 'failed', 'stopped'].includes(run.status)) return '消息变更已收到，等待旧运行停止；旧结果已禁止发布。';
    return '旧运行已结束，旧上下文已失效。';
  }
  const stoppedEvent = run.events.find(event => event.kind === 'stopped' && event.data.executionSettled === true);
  return {
    queued: '已认领，正在等待执行设备。', running: '模拟 Agent 正在处理；消息送达不代表研究完成。',
    cancel_requested: '已受理取消请求，尚未收到实际停止确认。',
    completed: run.receiptId ? '成果已回到本讨论，发布回执已保存。' : '缺少发布回执，请核对执行记录。',
    failed: '本次执行失败。不会自动重新研究，请先核对已有结果。',
    unknown: '暂时无法确认执行结果。不会自动重跑；需核对执行设备。',
    stopped: stoppedEvent ? '执行设备已确认运行结束，停止回执已保存。' : run.stopEvidence ? '已确认任务未开始执行。' : '停止证据待核对。',
  }[run.status] ?? '请核对运行记录。';
}

// Progress is derived only from server-recorded runtime events, never from timers.
function runSteps(run) {
  const at = kind => run.events.find(event => event.kind === kind)?.at;
  const started = at('input_applied'), steps = [{ label: '已认领', state: 'done' }];
  if (started) steps.push({ label: run.work.contextRevision > 1 && !run.contextInvalidated ? '修改已应用' : '开始执行', time: started, state: 'done' });
  else if (run.stopEvidence?.executionStarted === false) steps.push({ label: '未开始执行', state: 'done' });
  else steps.push({ label: '开始执行', state: run.status === 'queued' ? 'current' : 'todo' });
  if (run.status === 'cancel_requested') steps.push({ label: '取消已受理', state: 'done' }, { label: '等待停止确认', state: 'current' });
  else if (run.status === 'stopped') steps.push({ label: '已停止', time: at('stopped'), state: 'done' });
  else if (run.status === 'failed') steps.push({ label: '执行失败', time: at('failed'), state: 'bad' });
  else if (run.status === 'unknown') steps.push({ label: '结果待核对', state: 'bad' });
  else steps.push({ label: '结果回到讨论', time: run.receiptId ? at('output') : undefined, state: run.receiptId ? 'done' : run.status === 'running' ? 'current' : 'todo' });
  return steps;
}

function stepsNode(run) {
  const list = el('ol', 'run-steps');
  list.setAttribute('aria-label', '调研进度');
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
  block.dataset.run = run.id; block.setAttribute('aria-label', `调研 #${code}`);
  const top = el('div', 'run-top'), status = el('span', 'run-state'), title = el('span', 'run-title');
  status.append(icon(`st-${run.status}`, `mark st-${run.status}`), el('span', 'status-label', labels[run.status] ?? '状态待核对'));
  title.append(el('strong', '', `调研 #${code}`), el('span', '', memberIn(room, run.memberId).name));
  top.append(status, title);
  const cancellation = state.cancels.get(run.id);
  if (['queued', 'running', 'unknown'].includes(run.status) && authorized('cancel')) {
    const cancel = action(cancellation === 'sending' ? '正在请求…' : cancellation === 'failed' ? '重试取消' : '取消研究', `cancel-${run.id}`, () => cancelRun(run.id), 'outline-button run-cancel');
    cancel.disabled = cancellation === 'sending'; top.append(cancel);
  }
  block.append(top, stepsNode(run), el('p', 'run-note', runNote(run)));
  if (cancellation === 'failed') block.append(el('p', 'error', '取消请求结果未确认，请重试或等待同步；未声称任务已停止。'));
  const result = (ctx.resultsBySource.get(run.sourceMessageId) ?? []).find(message => message.authorId === run.memberId);
  if (result) block.append(action('查看结果', `jump-${run.id}`, () => focusMessage(result.id), 'text-button run-jump', 'i-jump'));
  return block;
}

function emptyState(room) {
  if (!room.loaded) {
    const skeleton = el('div', 'skeleton'); skeleton.append(el('p', 'sr-only', '正在加载讨论…'));
    for (let row = 0; row < 3; row++) {
      const line = el('div', 'skeleton-row'), lines = el('div', 'skeleton-lines');
      lines.append(el('span'), el('span')); line.append(el('span'), lines); skeleton.append(line);
    }
    return skeleton;
  }
  const empty = el('div', 'empty');
  empty.append(el('h3', '', '从一条消息开始'), el('p', '', '在这里和团队交流。提出明确的调研请求时，模拟 Agent 会在授权范围内参与，并把带来源的结果发回这条讨论。'));
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
    for (const room of state.rooms.values()) room.runs = room.runs.map(run => run.id === id ? {
      ...run,
      // A newer poll may already have observed the terminal state while cancel was in flight.
      status: ['completed', 'failed', 'stopped'].includes(run.status) ? run.status : result.status,
      receiptId: result.publishedReceiptId ?? run.receiptId,
    } : run);
    state.cancels.delete(id); announce('取消请求已受理，正在核对停止状态。');
    renderMessages(); renderPane(); renderRooms(); renderSeats(current());
    await sync();
  } catch (error) {
    if (client !== state.client) return;
    if (error instanceof ApiError && [401, 403].includes(error.status)) { invalidate(error); return; }
    state.cancels.set(id, 'failed'); announce(errorText(error));
  }
  if (client === state.client) { renderMessages(); renderPane(); renderRooms(); }
}

function closeMessageChange() {
  messageChange = null;
  $('message-change').close(); $('change-text').value = ''; $('change-error').textContent = '';
}
function openMessageChange(room, message, kind) {
  messageChange = { roomId: key(room.scope), messageId: message.id, revision: message.revision, kind, id: crypto.randomUUID(), sending: false, submittedText: undefined };
  $('change-title').textContent = kind === 'edit' ? '编辑消息' : '撤回消息';
  $('change-text').value = message.text; $('change-text').hidden = kind === 'retract'; $('change-label').hidden = kind === 'retract';
  $('change-text').disabled = false; $('change-save').disabled = false; $('change-close').disabled = false;
  $('change-save').textContent = kind === 'edit' ? '保存修改' : '确认撤回';
  $('change-help').textContent = kind === 'edit' ? '保存后，相关研究会停止使用旧内容；确认旧运行结束后重新处理。' : '撤回后，相关旧结果将失效。已完成的外部动作不会被撤销。';
  $('change-error').textContent = ''; $('message-change').showModal();
  (kind === 'edit' ? $('change-text') : $('change-save')).focus();
}
$('change-close').addEventListener('click', closeMessageChange);
$('message-change').addEventListener('cancel', event => { if (messageChange?.sending) event.preventDefault(); else closeMessageChange(); });
$('change-form').addEventListener('submit', async event => {
  event.preventDefault(); const change = messageChange, client = state.client;
  if (!change || !client || change.sending) return;
  const room = state.rooms.get(change.roomId);
  if (!room || !authorized('read', room) || !authorized('send', room)) { closeMessageChange(); return; }
  const text = change.submittedText ?? $('change-text').value.trim();
  if (change.kind === 'edit' && !text) return;
  change.submittedText = text; change.sending = true;
  $('change-text').disabled = true; $('change-save').disabled = true; $('change-close').disabled = true;
  try {
    const result = await client.change(change.messageId, change.kind, change.revision, change.id, text);
    if (client !== state.client || messageChange !== change) return;
    cancellationRevision++;
    const latest = state.rooms.get(change.roomId);
    if (latest) {
      latest.messages = latest.messages.map(m => m.id === result.message.id && m.revision <= result.message.revision ? result.message : m);
      // Hide cached derived output immediately, before the next snapshot.
      latest.messages = latest.messages.map(m => m.origin === 'research' ? { ...m, text: '', result: undefined, invalidated: true } : m);
    }
    closeMessageChange(); renderMessages(); renderPane(); renderRooms();
    announce('消息变更已收到，正在核对相关研究的停止与应用状态。'); await sync();
  } catch (error) {
    if (client !== state.client || messageChange !== change) return;
    if (error instanceof ApiError && [401, 403].includes(error.status)) { invalidate(error); return; }
    const conflict = error instanceof ApiError && error.status === 409;
    $('change-error').textContent = conflict ? '消息版本已变化，请返回讨论并重新打开最新消息。' : errorText(error);
    $('change-save').disabled = conflict; $('change-save').textContent = '重试同一变更';
    $('change-close').disabled = false; change.sending = false;
    if (conflict) void sync();
  }
});

function lapse(grant) {
  return grant.reason === 'expired' ? `已于 ${clock(grant.until)} 到期` : grant.reason === 'withdrawn' ? '已被收回' : '未授权';
}
function readOnlyReason(room) {
  const send = permission('send', room);
  return send.reason === 'none' ? '列席（只读）：你在此讨论没有发言授权' : `列席（只读）：发言授权${lapse(send)}`;
}

function updateComposer() {
  const room = current(); if (!room || !state.session) return;
  const allowed = authorized('send');
  $('message').disabled = !allowed || Boolean(room.pending);
  $('send').disabled = !allowed || Boolean(room.pending) || !$('message').value.trim();
  setText($('send-label'), room.pending?.status === 'sending' ? '发送中…' : '发送');
  $('composer').classList.toggle('is-readonly', !allowed);
  // The input folds away when speaking ends; keep keyboard focus somewhere visible.
  if (!allowed && document.activeElement === $('message')) $('timeline').focus();
  setText($('send-help'), allowed ? 'Enter 发送 · Shift + Enter 换行' : readOnlyReason(room));
  const placeholder = allowed ? `在「${room.scope.threadId}」中发言…` : '只读讨论';
  if ($('message').placeholder !== placeholder) $('message').placeholder = placeholder;
  renderSeatCard(room, allowed); renderExpiry(room, allowed);
}

function renderSeatCard(room, allowed) {
  const member = state.session.member, send = permission('send', room), left = (send.until ?? 0) - serverNow();
  const soon = allowed && left <= EXPIRY_NOTICE;
  const detail = allowed ? `可发言至 ${clock(send.until)}（剩 ${remaining(left)}）` : send.reason === 'none' ? '只读，未获发言授权' : `发言授权${lapse(send)}`;
  const signature = JSON.stringify([member.id, allowed, detail, soon]);
  if (signature === state.ui.seat) return;
  state.ui.seat = signature;
  $('seat').classList.toggle('is-soon', soon);
  $('seat').replaceChildren(tile(member), el('span', 'seat-member', member.name), el('span', 'seat-standing', allowed ? '出席' : '列席（只读）'), el('span', 'seat-detail', detail));
  if (!allowed) $('seat').prepend(icon('i-lock'));
}

function renderExpiry(room, allowed) {
  const until = deadline('send', room), left = until - serverNow();
  const text = allowed && left <= EXPIRY_NOTICE
    ? `你在本讨论的发言授权将于 ${clock(until)} 到期（约 ${remaining(left)}后）。演示授权不会自动续期，${desktop ? '到期后请退出应用并重新开始本地演示。' : '到期后需要重新连接新的演示。'}`
    : '';
  if (text === state.ui.expiry) return;
  state.ui.expiry = text;
  $('expiry').replaceChildren(...(text ? [icon('i-clock'), el('span', '', text)] : []));
  $('expiry').hidden = !text;
}

function renderOutbox() {
  const room = current(), pending = room?.pending;
  const signature = pending ? JSON.stringify([state.selected, pending.id, pending.status, pending.error]) : '';
  if (signature === state.ui.outbox) return;
  state.ui.outbox = signature;
  if (!pending) { $('outbox').replaceChildren(); return; }
  const failed = pending.status === 'failed', node = el('div', `outbox-item is-${failed ? 'failed' : 'sending'}`), head = el('div', 'outbox-head');
  head.append(icon(failed ? 'i-alert' : 'i-clock'), el('p', '', failed ? pending.error : '正在发送，请稍候…'));
  node.append(head);
  if (failed) {
    const actions = el('div', 'outbox-actions');
    actions.append(button('重试同一条消息', () => sendPending(current(), state.selected), 'outline-button'), el('p', 'muted', '重试会使用同一个消息标识，避免重复发送。刷新会丢失此待确认请求，请先核对消息记录。'));
    node.append(actions);
  }
  $('outbox').replaceChildren(node);
}

async function sendPending(room, id) {
  const pending = room.pending, client = state.client;
  if (!pending || pending.status === 'sending' || !client) return;
  pending.status = 'sending'; if (id === state.selected) { updateComposer(); renderOutbox(); }
  try {
    const result = await client.send(room.scope, pending.text, pending.id);
    if (client !== state.client) return;
    // Session polling may replace room wrappers while this request is in flight.
    const latest = state.rooms.get(id); if (!latest || latest.pending !== pending) return;
    latest.pending = null; latest.draft = ''; latest.seen.add(result.message.id);
    if (!latest.messages.some(m => m.id === result.message.id)) latest.messages.push(result.message);
    if (id === state.selected) { $('message').value = ''; renderMessages(true); $('message').disabled = false; $('message').focus(); }
    renderRooms();
    announce(result.duplicate ? '已核对：这条消息已送达，没有重复发送。' : '消息已送达。');
    await sync();
  } catch (error) {
    if (client !== state.client) return;
    if (error instanceof ApiError && [401, 403].includes(error.status)) { invalidate(error); return; }
    pending.status = 'failed'; pending.error = errorText(error); announce(pending.error);
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
  $('details-members').hidden = pane?.kind !== 'members';
  $('details-thread').hidden = pane?.kind !== 'discussion';
  updatePaneAccessibility();
  if (!pane) {
    state.ui.pane = '';
    for (const id of ['my-seat', 'members', 'details-thread']) $(id).replaceChildren();
    return;
  }
  if (!room) return;
  if (pane.kind === 'members') renderMembersPane(room); else renderThreadPane(room, pane.messageId);
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
  setText($('details-title'), '座次与权限');
  const member = state.session.member, speaking = authorized('send', room), head = el('div', 'my-seat-head'), copy = el('div');
  copy.append(el('strong', '', member.name), el('span', '', `${kindLabel(member)} · 你`));
  head.append(tile(member), copy, el('span', speaking ? 'standing' : 'standing is-readonly', speaking ? '出席' : '列席（只读）'));
  const names = { read: '查看消息', send: '发言', cancel: '取消调研' }, list = el('dl', 'perm-list');
  for (const [name, grant] of permissions) {
    list.append(el('dt', '', names[name]), el('dd', grant.allowed ? 'perm-on' : 'perm-off', grant.allowed ? `可用 · 至 ${clock(grant.until)}` : lapse(grant)));
  }
  $('my-seat').replaceChildren(head, list);
  $('members').replaceChildren(...room.scope.members.map(person => {
    const row = el('li'), name = el('span', 'member-name');
    name.append(el('strong', '', person.name), el('span', '', isMe(person.id) ? `${kindLabel(person)} · 你` : kindLabel(person)));
    row.append(tile(person), name);
    if (live.has(person.id)) { const working = el('span', 'member-state is-live'); working.append(el('span', 'live-dot'), '调研中'); row.append(working); }
    return row;
  }));
}

function renderThreadPane(room, messageId) {
  const source = room.messages.find(message => message.id === messageId);
  const runs = room.runs.filter(run => run.sourceMessageId === messageId);
  const results = room.messages.filter(message => message.sourceMessageId === messageId);
  const signature = JSON.stringify(['discussion', messageId, source, runs, results]);
  if (signature === state.ui.pane) return;
  state.ui.pane = signature;
  setText($('details-title'), '讨论详情');
  const ctx = context(room), nodes = [el('p', 'thread-intro', '源消息、由它引发的调研，以及回到本讨论的结果。')];
  nodes.push(source ? threadMessage(room, source) : el('p', 'pane-note', '这条消息已不在当前记录中。'));
  for (const run of runs) nodes.push(threadRun(room, run, ctx));
  for (const result of results) nodes.push(threadMessage(room, result));
  nodes.push(el('p', 'pane-note', '回复仍发送到当前讨论线程；暂不支持对单条消息单独回复。'));
  $('details-thread').replaceChildren(...nodes);
}

function threadMessage(room, message) {
  const member = memberIn(room, message.authorId), item = el('article', 'thread-item'), head = el('div', 'thread-head');
  head.append(el('strong', '', member.name), el('span', 'kind', kindLabel(member)), timeNode(message.createdAt));
  item.append(head);
  if (message.result) item.append(el('span', 'thread-synthetic', '模拟研究结果 · 合成资料'));
  item.append(el('p', 'thread-text', message.text));
  if (message.result) {
    const list = el('ol', 'thread-sources');
    message.result.sources.forEach((source, index) => {
      const row = el('li'), copy = el('div');
      copy.append(el('strong', 'source-title', source.title), el('p', 'source-excerpt', source.excerpt), el('span', 'source-url', `${source.url}（测试占位地址，不可作为证据链接）`));
      row.append(el('span', 'source-key', String(index + 1)), copy); list.append(row);
    });
    const limits = el('div', 'thread-limits'); limits.append(el('strong', '', '限制'));
    for (const limitation of message.result.limitations) limits.append(el('p', '', limitation));
    item.append(list, limits);
  }
  return item;
}

function threadRun(room, run, ctx) {
  const box = el('div', 'thread-run'), top = el('div', 'thread-run-top'), status = el('span', 'thread-status');
  status.append(icon(`st-${run.status}`, `mark st-${run.status}`), el('span', '', labels[run.status] ?? '状态待核对'));
  top.append(status, el('span', 'run-title', `调研 #${ctx.code.get(run.id)} · ${memberIn(room, run.memberId).name}`));
  box.append(top, stepsNode(run), el('p', 'run-note', runNote(run)));
  return box;
}

$('connect-form').addEventListener('submit', async event => {
  event.preventDefault(); if ($('connect-button').disabled) return;
  const token = desktop ? 'local-demo' : $('token').value.trim(); if (!token) return;
  $('connect-button').disabled = true; $('connect-button').textContent = '正在连接…'; $('connect-error').textContent = '';
  const client = new Client(token); $('token').value = ''; $('token').setAttribute('aria-invalid', 'false');
  try {
    const session = await client.session(); state.client = client; state.epoch++;
    if (desktop) void desktop.core.invoke('desktop_connected', { connected: true });
    sessionReceived(session); $('connect').hidden = true; $('app').hidden = false;
    $('message').value = current().draft; renderMessages(true); renderOutbox(); await sync();
    if (state.client) $('message').focus();
  } catch (error) { client.close(); invalidate(error); }
});
$('composer').addEventListener('submit', event => {
  event.preventDefault(); const room = current(), text = $('message').value.trim();
  if (!room || room.pending || !text || !authorized('send')) return;
  room.draft = text; room.pending = { id: crypto.randomUUID(), text, status: 'new', error: '' };
  void sendPending(room, state.selected);
});
$('message').addEventListener('input', () => { if (current() && !current().pending) current().draft = $('message').value; updateComposer(); });
$('message').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); $('composer').requestSubmit(); } });
$('token').addEventListener('input', () => $('token').setAttribute('aria-invalid', 'false'));
$('logout').addEventListener('click', () => invalidate());
$('members-toggle').addEventListener('click', event => { if (state.pane?.kind === 'members') closePane(true); else openPane({ kind: 'members' }, event.currentTarget); });
$('details-close').addEventListener('click', () => closePane(true));
$('reconnect').addEventListener('click', () => void sync());
$('back').addEventListener('click', () => { closePane(false); $('app').classList.add('show-rooms'); $('rooms').querySelector('[aria-current=true]')?.focus(); });
$('new-messages').addEventListener('click', () => { $('timeline').scrollTop = $('timeline').scrollHeight; $('new-messages').hidden = true; });
$('timeline').addEventListener('scroll', () => {
  const timeline = $('timeline');
  if (!$('new-messages').hidden && timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 90) $('new-messages').hidden = true;
}, { passive: true });
document.addEventListener('keydown', event => {
  if (event.isComposing || !state.client || $('app').hidden) return;
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
window.addEventListener('pagehide', () => invalidate());
window.addEventListener('beforeunload', event => { if ([...state.rooms.values()].some(room => room.pending)) { event.preventDefault(); event.returnValue = ''; } });
if (desktop) {
  $('token').required = false; $('token').hidden = true;
  document.querySelector('label[for="token"]').hidden = true;
  $('connect-button').textContent = '进入本地演示';
  $('credential-help').textContent = '安装版已内置模拟服务。临时身份只保留在后台内存，启动 30 分钟后失效。关闭窗口会留在托盘；退出应用可结束并清理本次演示。通知点击会重新校验授权；已结束或重启前的演示不会恢复旧消息。';
  document.querySelector('.demo-note').textContent = 'CoSeat Demo 0.1.3 · 未签名测试版 · 无真实模型调用';
  $('logout').querySelector('span').textContent = '断开连接';
  const actions = el('div', 'desktop-actions'), quit = button('', () => desktop.core.invoke('desktop_quit'), 'rail-button');
  quit.append(icon('i-power'), el('span', '', '退出应用'));
  $('logout').before(actions); actions.append($('logout'), quit);
  document.querySelector('.connect-body').append(button('退出应用', () => desktop.core.invoke('desktop_quit'), 'quiet connect-quit'));
  const noticePanel = el('section', 'connection-page'); noticePanel.hidden = true;
  noticePanel.append(el('p', '', '正在核对通知来源与当前授权…')); document.body.append(noticePanel);
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
              $('connect-error').textContent = result.reason === 'disconnected'
                ? '当前已断开连接。请手动进入演示后查看获准访问的消息。'
                : '这条通知属于已结束或不可用的演示，旧消息不会恢复。可手动进入本次本地演示。';
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
