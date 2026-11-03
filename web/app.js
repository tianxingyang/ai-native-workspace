import { Client, ApiError, errorText } from './client.js';

const $ = id => document.getElementById(id);
const desktop = window.__TAURI__;
const key = scope => JSON.stringify([scope.conversationId, scope.threadId]);
const state = { client: null, session: null, selected: '', rooms: new Map(), epoch: 0, timer: null, syncing: false, source: null, offset: 0, cancels: new Map() };
const labels = { queued: '等待执行', running: '正在研究', cancel_requested: '等待停止确认', completed: '已完成', failed: '执行失败', stopped: '已停止', unknown: '执行结果待核对' };
let navigationSignature = '';
function el(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }
function button(text, fn, className = 'quiet') { const node = el('button', className, text); node.type = 'button'; node.addEventListener('click', fn); return node; }
function current() { return state.rooms.get(state.selected); }
function authorized(action) { return (current()?.scope.permissions[action] ?? 0) > Date.now() + state.offset; }
function announce(text) { $('announcement').textContent = text; }
function invalidate(error) {
  if (desktop) void desktop.core.invoke('desktop_connected', { connected: false });
  state.client?.close(); state.client = null; state.epoch++; clearTimeout(state.timer); state.syncing = false;
  state.session = null; state.rooms.clear(); state.cancels.clear(); state.source = null; state.selected = '';
  navigationSignature = '';
  $('app').hidden = true; $('connect').hidden = false; $('token').value = ''; $('message').value = '';
  $('messages').replaceChildren(); $('rooms').replaceChildren(); $('outbox').replaceChildren();
  $('source-filter').hidden = true; $('sync-error').hidden = true; $('new-messages').hidden = true;
  $('identity').textContent = ''; $('members').replaceChildren(); $('connect-error').textContent = error ? errorText(error) : '';
  $('connect-button').disabled = false; $('connect-button').textContent = desktop ? '进入本地演示' : '连接会话';
  (desktop ? $('connect-button') : $('token')).focus();
}
function sessionReceived(session) {
  state.session = session; state.offset = session.serverTime - Date.now();
  const next = new Map();
  for (const scope of session.scopes) {
    const id = key(scope), old = state.rooms.get(id);
    next.set(id, old ? { ...old, scope } : { scope, messages: [], runs: [], loaded: false, draft: '', pending: null, signature: '' });
  }
  state.rooms = next;
  if (!next.has(state.selected)) { state.selected = next.keys().next().value; state.source = null; $('source-filter').hidden = true; }
  $('identity').textContent = `${session.member.name} · ${session.member.kind === 'agent' ? 'Agent' : '人类'}`;
  $('room-count').textContent = `${session.scopes.length} 个讨论`;
  renderRooms(); renderHeader();
}
function renderRooms() {
  const signature = JSON.stringify([state.selected, [...state.rooms.keys()]]);
  if (signature === navigationSignature) return;
  navigationSignature = signature;
  const children = [];
  for (const [id, room] of state.rooms) {
    const item = button('', () => selectRoom(id), 'room'); item.setAttribute('aria-current', String(id === state.selected));
    const icon = el('span', 'room-icon');
    // Fixed authored icon; user content always uses textContent.
    icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-6 3V6a2 2 0 0 1 2-2Z"/><path d="M7 9h10M7 13h7"/></svg>';
    const copy = el('span', 'room-copy'); copy.append(el('strong', '', room.scope.conversationId), el('small', '', room.scope.threadId)); item.append(icon, copy); children.push(item);
  }
  $('rooms').replaceChildren(...children);
}
function renderHeader() {
  const room = current(); if (!room) return;
  $('room-title').textContent = room.scope.conversationId;
  $('thread-title').textContent = `${room.scope.threadId} · ${room.scope.members.length} 位成员`;
  $('members-toggle').textContent = `${room.scope.members.length} 位成员`;
  $('members').replaceChildren(...room.scope.members.map(member => {
    const node = el('span'); node.append(el('span', '', member.name), el('span', 'kind', member.kind === 'agent' ? 'Agent' : '人类')); return node;
  }));
  $('scope-note').textContent = state.source ? '发送仍进入当前预设讨论线程；暂不支持回复选中的单条消息。' : '当前为预设讨论线程；暂不支持附件、私聊创建和消息编辑。';
  updateComposer();
}
function selectRoom(id) {
  if (!state.rooms.has(id)) return;
  const old = current(); if (old && !old.pending) old.draft = $('message').value;
  state.selected = id; state.source = null; state.epoch++; state.syncing = false;
  clearTimeout(state.timer); $('app').classList.remove('show-rooms'); $('message').value = current().draft;
  $('source-filter').hidden = true; $('sync-error').hidden = true; $('new-messages').hidden = true;
  renderRooms(); renderHeader(); renderMessages(true); renderOutbox(); const syncing = sync();
  if (matchMedia('(max-width: 720px)').matches) { $('room-title').tabIndex = -1; $('room-title').focus(); }
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
    const room = current(), data = await client.snapshot(room.scope);
    if (epoch !== state.epoch) return;
    room.messages = data.messages; room.runs = data.runs; room.loaded = true;
    for (const run of room.runs) if (['cancel_requested', 'completed', 'failed', 'stopped'].includes(run.status)) state.cancels.delete(run.id);
    renderMessages(); updateComposer(); renderOutbox();
    $('connection-status').textContent = '已连接'; $('sync-error').hidden = true;
    return true;
  } catch (error) {
    if (epoch !== state.epoch) return;
    if (error instanceof ApiError && [401, 403].includes(error.status)) { invalidate(error); return; }
    $('connection-status').textContent = '连接中断'; $('sync-error-text').textContent = `${errorText(error)} 当前显示上次同步的记录。`;
    $('sync-error').hidden = false;
  } finally {
    if (epoch === state.epoch) { state.syncing = false; if (state.client) state.timer = setTimeout(sync, 1200); }
  }
}
function memberFor(id) { return current().scope.members.find(member => member.id === id) ?? { id, name: '成员', kind: 'human' }; }
function showSource(id) {
  state.source = id; $('source-filter').hidden = false; renderMessages(true); $('timeline').scrollTop = 0; $('timeline').focus();
  $('scope-note').textContent = '发送仍进入当前预设讨论线程；暂不支持回复选中的单条消息。';
}
function renderMessages(force = false) {
  const room = current(); if (!room) return;
  const signature = JSON.stringify([room.messages, room.runs, room.scope.permissions, state.source, [...state.cancels], room.loaded]);
  if (!force && signature === room.signature) return;
  room.signature = signature;
  const timeline = $('timeline'), previousScroll = timeline.scrollTop;
  const atBottom = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 90;
  const expanded = new Set([...$('messages').querySelectorAll('details[open]')].map(x => x.dataset.message));
  const focused = document.activeElement?.dataset.action;
  const visible = room.messages.filter(m => !state.source || m.id === state.source || m.sourceMessageId === state.source);
  const nodes = visible.map(message => {
    const member = memberFor(message.authorId), article = el('article', 'message'); article.dataset.message = message.id;
    if (state.source === message.id) article.classList.add('source-highlight');
    article.append(el('div', `avatar ${member.kind}`, member.name.slice(0, 1)));
    const body = el('div'), head = el('div', 'message-head');
    const time = el('time', '', new Date(message.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })); time.dateTime = new Date(message.createdAt).toISOString(); time.title = new Date(message.createdAt).toLocaleString('zh-CN');
    head.append(el('strong', '', member.name), el('span', 'kind', member.kind === 'agent' ? 'Agent' : '人类'), time); body.append(head);
    if (message.result) body.append(el('span', 'result-label', '模拟研究结果 · 合成资料'));
    body.append(el('p', 'message-text', message.text));
    const associated = room.runs.filter(run => run.sourceMessageId === message.id);
    const actions = el('div', 'message-actions');
    if (message.sourceMessageId) actions.append(button('查看来源消息与讨论', () => showSource(message.sourceMessageId)));
    else if (associated.length || room.messages.some(m => m.sourceMessageId === message.id)) actions.append(button('查看这条消息的讨论', () => showSource(message.id)));
    if (actions.firstElementChild) actions.firstElementChild.dataset.action = `source-${message.id}`;
    body.append(actions);
    for (const run of associated) body.append(renderRun(run));
    if (message.result) {
      const details = el('details', 'sources'); details.dataset.message = message.id; details.open = expanded.has(message.id);
      const summary = el('summary', '', `${message.result.sources.length} 条合成来源与限制`); summary.dataset.action = `sources-${message.id}`; details.append(summary);
      const list = el('ol');
      for (const source of message.result.sources) {
        const item = el('li'); item.append(el('strong', '', source.title), el('p', '', source.excerpt), el('span', 'source-url', `${source.url}（测试占位地址，不可作为证据链接）`)); list.append(item);
      }
      details.append(list); for (const limitation of message.result.limitations) details.append(el('p', '', limitation)); body.append(details);
    }
    article.append(body); return article;
  });
  if (!nodes.length) {
    const empty = el('div', 'empty'); empty.append(el('h3', '', room.loaded ? '从一条消息开始' : '正在加载讨论…'), el('p', '', room.loaded ? '在这里和团队交流。试试“请调研一下插件协议”，模拟 Agent 会在授权范围内参与。' : '正在获取已授权的消息和任务状态。')); nodes.push(empty);
  }
  $('messages').replaceChildren(...nodes);
  if (focused) ([...$('messages').querySelectorAll('[data-action]')].find(x => x.dataset.action === focused) ?? timeline).focus({ preventScroll: true });
  if (force || atBottom) { timeline.scrollTop = timeline.scrollHeight; $('new-messages').hidden = true; }
  else { timeline.scrollTop = previousScroll; $('new-messages').hidden = false; }
}
function renderRun(run) {
  const block = el('div', 'run'); block.dataset.run = run.id;
  const top = el('div', 'run-top'), title = el('div', 'run-title', `${memberFor(run.memberId).name} · 调研`);
  title.append(el('span', 'status-label', labels[run.status] ?? '状态待核对')); top.append(title);
  const cancellation = state.cancels.get(run.id);
  if (['queued', 'running', 'unknown'].includes(run.status) && authorized('cancel')) {
    const cancel = button(cancellation === 'sending' ? '正在请求…' : cancellation === 'failed' ? '重试取消' : '取消研究', () => cancelRun(run.id));
    cancel.disabled = cancellation === 'sending'; cancel.dataset.action = `cancel-${run.id}`; top.append(cancel);
  }
  block.append(top);
  const stoppedEvent = run.events.find(event => event.kind === 'stopped' && event.data.executionSettled === true);
  let note = {
    queued: '已认领，正在等待执行设备。', running: '模拟 Agent 正在处理；消息送达不代表研究完成。',
    cancel_requested: '已受理取消请求，尚未收到实际停止确认。',
    completed: run.receiptId ? '成果已回到本讨论，发布回执已保存。' : '缺少发布回执，请核对执行记录。',
    failed: '本次执行失败。不会自动重新研究，请先核对已有结果。',
    unknown: '暂时无法确认执行结果。不会自动重跑；需核对执行设备。',
    stopped: stoppedEvent ? '执行设备已确认运行结束，停止回执已保存。' : run.stopEvidence ? '已确认任务未开始执行。' : '停止证据待核对。',
  }[run.status];
  block.append(el('p', '', note ?? '请核对运行记录。'));
  if (cancellation === 'failed') block.append(el('p', 'error', '取消请求结果未确认，请重试或等待同步；未声称任务已停止。'));
  return block;
}
async function cancelRun(id) {
  if (!state.client || state.cancels.get(id) === 'sending') return;
  const client = state.client;
  state.cancels.set(id, 'sending'); renderMessages();
  try {
    const result = await client.cancel(id); if (client !== state.client) return;
    for (const room of state.rooms.values()) room.runs = room.runs.map(run => run.id === id ? result : run);
    state.cancels.delete(id); announce('取消请求已受理，正在核对停止状态。'); await sync();
  } catch (error) {
    if (client !== state.client) return;
    if (error instanceof ApiError && [401, 403].includes(error.status)) { invalidate(error); return; }
    state.cancels.set(id, 'failed'); announce(errorText(error));
  }
  if (client === state.client) renderMessages();
}
function updateComposer() {
  const room = current(); if (!room) return;
  const allowed = authorized('send');
  $('message').disabled = !allowed || Boolean(room.pending);
  $('send').disabled = !allowed || Boolean(room.pending) || !$('message').value.trim();
  $('send').textContent = room.pending?.status === 'sending' ? '发送中…' : '发送';
  $('send-help').textContent = allowed ? 'Enter 发送 · Shift + Enter 换行' : '当前讨论只读或发送授权已到期';
}
function renderOutbox() {
  const pending = current()?.pending;
  if (!pending) { $('outbox').replaceChildren(); return; }
  const node = el('div', 'outbox-item');
  node.append(el('p', '', pending.status === 'sending' ? '正在发送，请稍候…' : pending.error));
  if (pending.status === 'failed') {
    node.append(button('重试同一条消息', () => sendPending(current(), state.selected)));
    node.append(el('p', 'muted', '重试会使用同一个消息标识，避免重复发送。刷新会丢失此待确认请求，请先核对消息记录。'));
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
    latest.pending = null; latest.draft = '';
    if (!latest.messages.some(m => m.id === result.message.id)) latest.messages.push(result.message);
    if (id === state.selected) { $('message').value = ''; renderMessages(); $('message').disabled = false; $('message').focus(); }
    announce(result.duplicate ? '已核对：这条消息已送达，没有重复发送。' : '消息已送达。');
    await sync();
  } catch (error) {
    if (client !== state.client) return;
    if (error instanceof ApiError && [401, 403].includes(error.status)) { invalidate(error); return; }
    pending.status = 'failed'; pending.error = errorText(error); announce(pending.error);
  }
  if (client === state.client && id === state.selected) { updateComposer(); renderOutbox(); }
}
$('connect-form').addEventListener('submit', async event => {
  event.preventDefault(); if ($('connect-button').disabled) return;
  const token = desktop ? 'local-demo' : $('token').value.trim(); if (!token) return;
  $('connect-button').disabled = true; $('connect-button').textContent = '正在连接…'; $('connect-error').textContent = '';
  const client = new Client(token); $('token').value = '';
  try {
    const session = await client.session(); state.client = client; state.epoch++;
    if (desktop) void desktop.core.invoke('desktop_connected', { connected: true });
    sessionReceived(session); $('connect').hidden = true; $('app').hidden = false;
    $('message').value = current().draft; renderMessages(true); await sync();
    if (state.client) $('message').focus();
  } catch (error) { client.close(); invalidate(error); }
});
$('composer').addEventListener('submit', event => {
  event.preventDefault(); const room = current(), text = $('message').value.trim();
  if (!room || room.pending || !text || !authorized('send')) return;
  state.source = null; $('source-filter').hidden = true;
  room.draft = text; room.pending = { id: crypto.randomUUID(), text, status: 'new', error: '' };
  void sendPending(room, state.selected);
});
$('message').addEventListener('input', () => { if (current() && !current().pending) current().draft = $('message').value; updateComposer(); });
$('message').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); $('composer').requestSubmit(); } });
$('logout').addEventListener('click', () => invalidate());
$('members-toggle').addEventListener('click', () => { $('members').hidden = !$('members').hidden; $('members-toggle').setAttribute('aria-expanded', String(!$('members').hidden)); });
$('reconnect').addEventListener('click', () => void sync());
$('back').addEventListener('click', () => { $('app').classList.add('show-rooms'); $('rooms').querySelector('[aria-current=true]')?.focus(); });
$('all-messages').addEventListener('click', () => { state.source = null; $('source-filter').hidden = true; renderMessages(true); renderHeader(); $('timeline').focus(); });
$('new-messages').addEventListener('click', () => { $('timeline').scrollTop = $('timeline').scrollHeight; $('new-messages').hidden = true; });
window.addEventListener('online', () => void sync());
window.addEventListener('pagehide', () => invalidate());
window.addEventListener('beforeunload', event => { if ([...state.rooms.values()].some(room => room.pending)) { event.preventDefault(); event.returnValue = ''; } });
if (desktop) {
  $('token').required = false; $('token').hidden = true;
  document.querySelector('label[for="token"]').hidden = true;
  $('connect-button').textContent = '进入本地演示';
  $('credential-help').textContent = '安装版已内置模拟服务。临时身份只保留在后台内存，启动 30 分钟后失效。关闭窗口会留在托盘；退出应用可结束并清理本次演示。通知点击会重新校验授权；已结束或重启前的演示不会恢复旧消息。';
  document.querySelector('.demo-note').textContent = 'CoSeat Demo 0.1.1 · 未签名测试版 · 无真实模型调用';
  $('logout').textContent = '断开连接';
  const actions = el('div', 'desktop-actions');
  $('logout').before(actions); actions.append($('logout'), button('退出应用', () => desktop.core.invoke('desktop_quit')));
  document.querySelector('.connect-panel').append(button('退出应用', () => desktop.core.invoke('desktop_quit')));
  const noticePanel = el('section', 'connection-page'); noticePanel.hidden = true;
  noticePanel.append(el('p', '', '正在核对通知来源与当前授权…')); document.body.append(noticePanel);
  let noticeBusy = false;
  async function openNotification() {
    if (noticeBusy) return; noticeBusy = true;
    let handled = false;
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
    finally {
      noticeBusy = false;
      // A queued event may arrive after the initial pending-notice drain. Never
      // leave the loading screen stranded when that event has nothing to take.
      noticePanel.hidden = true;
      if (!handled) { $('app').hidden = !state.client; $('connect').hidden = Boolean(state.client); }
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
