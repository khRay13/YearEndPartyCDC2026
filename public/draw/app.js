'use strict';
// 臨摹大賽 — two people copy the same picture, everybody else watches, the server judges.
// What this device knows of the pictures lives in `local.strokes`; the server is the authority for the rest.

const app = document.getElementById('app');
const connEl = document.getElementById('conn');
const toastEl = document.getElementById('toast');

// ---- small helpers ---------------------------------------------------------------------------------------------
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}
const fill = (el, ...nodes) => el.replaceChildren(...nodes.flat().filter((n) => n != null && n !== false));
let toastTimer = null;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.add('hidden'), 3200);
}
const r1 = (n) => Math.round(n * 10) / 10;
const nowMs = () => Date.now() + offset; // the server's clock, as far as we can tell

function plate(id) {
  return h('div', { class: 'plate sm' }, String(id).split('').map((d) => h('span', { class: 'digit' }, d)));
}
/** HH:MM:SS in this device's own time zone (the server sends a UTC time stamp). */
function clockTime(ts) {
  const d = new Date(ts);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
}
const CHAT_COLORS = ['#7ec8ff', '#ff8fb1', '#9be37a', '#c9a0ff', '#ffe27a', '#5fe0d0', '#ff7a7a', '#a8b8ff', '#d6f06a', '#ff9ff3', '#8fe3b0', '#bfc9d6'];
function chatColor(uid, players) {
  let i = players.findIndex((p) => p.uid === uid);
  if (i < 0) { i = 0; for (const ch of String(uid)) i = (i * 31 + ch.charCodeAt(0)) >>> 0; }
  return CHAT_COLORS[i % CHAT_COLORS.length];
}

// ---- connection ------------------------------------------------------------------------------------------------
let ws = null;
let S = null; // the latest room state (null: not in a room)
let offset = 0;
let pendingSync = false;
let preloaded = '';
const local = { strokes: [[], []] };

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) { ws.send(JSON.stringify(msg)); return true; }
  return false;
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws/draw`);
  ws.onopen = () => {
    connEl.classList.add('hidden');
    pendingSync = false;
    reportOrient();
  };
  ws.onmessage = (e) => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    if (m.t === 'hello') offset = m.serverNow - Date.now();
    else if (m.t === 'state') onState(m.state, m.notice);
    else if (m.t === 'seg') onRemoteSeg(m.slot, m.id, m.stroke);
    else if (m.t === 'stroke') onRemoteStroke(m.slot, m.id, m.stroke);
    else if (m.t === 'undo') { live[m.slot] = null; local.strokes[m.slot].pop(); repaint(m.slot); }
    else if (m.t === 'clear') { live[m.slot] = null; local.strokes[m.slot] = []; repaint(m.slot); }
    else if (m.t === 'snap') onSnap(m.strokes);
    else if (m.t === 'error') toast(m.message || '發生錯誤');
  };
  ws.onclose = () => {
    connEl.classList.remove('hidden');
    setTimeout(connect, 1000);
  };
}
setInterval(() => send({ t: 'ping' }), 25000);

// ---- the state ---------------------------------------------------------------------------------------------------
function onState(s, notice) {
  if (!window.__firstState) { window.__firstState = true; setTimeout(() => document.dispatchEvent(new Event('app-ready')), 0); } // nav.js waits for this
  if (notice) toast(notice);
  S = s;
  if (s && s.reference && s.reference.file !== preloaded) { preloaded = s.reference.file; new Image().src = preloaded; } // the picture is in hand before the countdown ends
  syncPictures();
  render();
  reportOrient();
}

const mySlot = () => (S ? S.slots.indexOf(S.me) : -1);

function syncPictures() {
  if (!S || !['COUNTDOWN', 'DRAWING', 'RESULT'].includes(S.status)) {
    local.strokes = [[], []];
    return;
  }
  if (S.status === 'RESULT' && S.result) {
    local.strokes = [S.result.strokes[0].slice(), S.result.strokes[1].slice()];
    return;
  }
  const slot = mySlot();
  // a painter's own list is the authority while painting; it is fetched only by a device that knows nothing (a reload).
  // A spectator's pictures are fed by the stroke messages: if they do not add up, ask again.
  const need = slot < 0 ? local.strokes.some((l, i) => l.length !== S.counts[i]) : local.strokes[slot].length === 0 && S.counts[slot] > 0;
  if (need && !pendingSync) { pendingSync = true; send({ t: 'sync' }); }
}

function onSnap(strokes) {
  pendingSync = false;
  for (let i = 0; i < 2; i++) if (strokes[i]) local.strokes[i] = strokes[i].slice();
  repaintAll();
}

/** The stroke each painter is drawing right now, as far as a spectator has been told: { id }. */
const live = [null, null];

/** A piece of a line that is still being drawn: paint it at once, so the spectator sees it grow. */
function onRemoteSeg(slot, id, piece) {
  live[slot] = { id };
  const cv = G.canvases && G.canvases[slot];
  if (cv) paintStroke(cv.getContext('2d'), piece);
}

function onRemoteStroke(slot, id, stroke) {
  local.strokes[slot].push(stroke);
  const cv = G.canvases && G.canvases[slot];
  const alreadyShown = live[slot] && live[slot].id === id; // its pieces were painted as they came
  live[slot] = null;
  if (cv && !alreadyShown) paintStroke(cv.getContext('2d'), stroke);
}

// ---- screen size: can this device hold the reference and the canvas side by side? -------------------------------------
/** Every screen will do: held upright, the painter gets a layout that is all canvas (see draw.css); wide screens get three columns. */
const screenOk = () => true;
/** The compact (upright / narrow) layout is on: same query as in draw.css. */
const compactLayout = () => matchMedia("(orientation: portrait), (max-width: 700px)").matches;
/** Tell the server whenever what it knows of our screen differs from the truth (after joining, after a turn or resize). */
function reportOrient() {
  const me = S && S.players.find((p) => p.uid === S.me);
  if (me && me.orientOk !== screenOk()) send({ t: 'orient', ok: screenOk() });
}
let resizeTimer = null;
function onResize() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    reportOrient();
    if (view === 'wait') render();
  }, 150);
}
addEventListener('resize', onResize);
addEventListener('orientationchange', onResize);

// ---- rendering: which screen -------------------------------------------------------------------------------------
let view = null;
const G = {}; // the painting screen's parts
const L = {}; // the lobby's parts
let homeTab = 'create';
const form = { nickname: localStorage.getItem('nick') || '', roomId: '' };

function render() {
  document.body.classList.toggle('painting', !!S && (S.status === 'COUNTDOWN' || S.status === 'DRAWING' || S.status === 'RESULT'));
  if (!S) return mount('home', homeView);
  switch (S.status) {
    case 'LOBBY': return showLobby();
    case 'ORIENT': return mount('wait', waitView, true);
    case 'COUNTDOWN':
    case 'DRAWING': return showGame();
    case 'RESULT': return mount('result', resultView);
    default: return mount('home', homeView);
  }
}
function mount(name, build, always) {
  if (view === name && !always) return;
  clearInterval(G.tick);
  view = name;
  app.replaceChildren(build());
}

// ---- home ----------------------------------------------------------------------------------------------------------
function homeView() {
  const field = (label, key, attrs) =>
    h('label', { class: 'col' }, h('span', { class: 'muted' }, label),
      h('input', Object.assign({ value: form[key], oninput: (e) => {
        if (key === 'roomId') e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
        form[key] = e.target.value;
      } }, attrs)));
  const submit = () => {
    localStorage.setItem('nick', form.nickname);
    if (homeTab === 'create') send({ t: 'create', nickname: form.nickname });
    else send({ t: 'join', roomId: form.roomId.trim(), nickname: form.nickname });
  };
  return h('div', { class: 'panel', style: 'max-width:440px;margin:6vh auto' },
    h('h1', {}, '🖼️ 臨摹大賽'),
    h('p', { class: 'muted' }, '兩人看著同一張名畫臨摹，3 分鐘後比相似度・其他人當觀眾・最多 12 人'),
    h('div', { class: 'tabs' },
      h('button', { class: homeTab === 'create' ? 'on' : '', onclick: () => { homeTab = 'create'; view = null; render(); } }, '建立房間'),
      h('button', { class: homeTab === 'join' ? 'on' : '', onclick: () => { homeTab = 'join'; view = null; render(); } }, '加入房間')),
    h('div', { class: 'col' },
      field('暱稱（1–12 字）', 'nickname', { type: 'text', placeholder: '你的暱稱', maxlength: 12 }),
      homeTab === 'join' && field('房間號碼（6 碼數字）', 'roomId', { type: 'text', inputmode: 'numeric', pattern: '[0-9]*', placeholder: '000000', maxlength: 6 }),
      h('button', { class: 'primary', onclick: submit }, homeTab === 'create' ? '建立' : '加入')),
    h('a', { class: 'back muted', href: '/lobby/', 'data-nav': 'out' }, '回遊戲大廳'));
}

// ---- lobby ---------------------------------------------------------------------------------------------------------
let chatDraft = '';
function showLobby() {
  if (view !== 'lobby') {
    clearInterval(G.tick);
    view = 'lobby';
    buildLobby();
  }
  updateLobby();
}

function buildLobby() {
  L.info = h('div', { class: 'panel' });
  L.controls = h('div', { class: 'row ctlrow', style: 'margin-bottom:12px' });
  L.players = h('div', { class: 'panel' });
  L.chatLog = h('div', { class: 'chatlog', role: 'log', 'aria-live': 'polite', 'aria-label': '聊天室訊息' });
  L.chatInput = h('input', {
    type: 'text', class: 'chatin', maxlength: 200, autocomplete: 'off', enterkeyhint: 'send',
    placeholder: '輸入訊息（只能文字）', 'aria-label': '聊天訊息', value: chatDraft,
    oninput: (e) => { chatDraft = e.target.value; },
    onkeydown: (e) => { if (e.key === 'Enter') sendChat(); },
  });
  L.chat = h('div', { class: 'panel chatbox' }, h('h3', {}, '聊天室'), L.chatLog,
    h('div', { class: 'chatform' }, L.chatInput, h('button', { class: 'primary', onclick: sendChat }, '送出')));
  L.chatKey = '';
  L.hint = h('div', { class: 'muted', style: 'margin:8px 0' });
  app.replaceChildren(h('div', {}, L.info, L.controls, h('div', { class: 'lobbycols' }, L.players, L.chat), L.hint));
}

function sendChat() {
  const text = L.chatInput.value.trim();
  if (!text) return;
  send({ t: 'chat', text });
  chatDraft = '';
  L.chatInput.value = '';
  L.chatInput.focus();
}

function updateLobby() {
  const s = S;
  const iAmHost = s.me === s.hostUid;
  const painters = s.slots.map((uid) => s.players.find((p) => p.uid === uid));
  fill(L.info,
    h('div', { class: 'roomline' }, h('span', { class: 'roomlabel' }, '房號：'), plate(s.roomId)),
    h('ul', { class: 'rules' },
      h('li', {}, `玩家 1 與玩家 2 看著同一張名畫臨摹，其他人是觀眾。題目在開始時從 ${s.referenceCount} 幅名畫裡隨機抽出。`),
      h('li', {}, '3 分鐘畫完不論完成與否，系統比對相似度，高者勝。顏色只有那幅畫裡的顏色（另有橡皮擦）。'),
      h('li', {}, '手機直拿、橫拿都可以。畫布一次只認一根手指，雙指不會留下筆畫。')));
  fill(L.controls,
    iAmHost && h('button', { class: 'primary grow', disabled: !s.canStart, onclick: () => send({ t: 'start' }) }, '開始臨摹'),
    h('button', { onclick: () => send({ t: 'leave' }) }, '離開房間'));

  fill(L.players,
    h('div', { class: 'phead' },
      h('h3', {}, '玩家'),
      h('span', { class: 'startnote ' + (s.canStart ? 'ok' : 'wait'), role: 'status' }, s.canStart ? (iAmHost ? '✔ 可以開始' : '✔ 等房主開始') : '✖ 還差一位玩家'),
      h('span', { class: 'muted count' }, `${painters.filter(Boolean).length}/2 位玩家・觀眾 ${s.players.length - painters.filter(Boolean).length}・${s.players.length}/${s.maxPlayers}`)),
    h('ul', { class: 'plist' }, s.players.map((p) =>
      h('li', { class: p.slot < 0 ? 'observer' : '' },
        h('span', { class: 'dot ' + (p.connected ? 'on' : '') }),
        h('span', { class: 'who' }, p.nickname + (p.uid === s.me ? '（你）' : '')),
        p.isHost && h('span', { class: 'tag host' }, '房主'),
        h('span', { class: 'slot ' + (p.slot < 0 ? 'watch' : 's' + p.slot) }, p.slot < 0 ? '觀眾' : `玩家 ${p.slot + 1}`),
        h('span', { class: 'wins', title: '在這個房間贏了幾場' }, `勝 ${p.wins || 0} 場`),
        iAmHost && h('div', { class: 'who-actions' },
          p.connected && p.slot !== 0 && h('button', { class: 'small', onclick: () => send({ t: 'setSlot', slot: 0, uid: p.uid }) }, '設為玩家 1'),
          p.connected && p.slot !== 1 && h('button', { class: 'small', onclick: () => send({ t: 'setSlot', slot: 1, uid: p.uid }) }, '設為玩家 2'),
          p.connected && p.uid !== s.me && h('button', { class: 'small', onclick: () => confirm(`把房主交給 ${p.nickname}？`) && send({ t: 'transferHost', uid: p.uid }) }, '轉移房主'),
          p.uid !== s.me && h('button', { class: 'small danger', onclick: () => confirm(`剔除 ${p.nickname}？`) && send({ t: 'kick', uid: p.uid }) }, '剔除'))))));

  const chat = s.chat || [];
  const key = chat.length ? chat[chat.length - 1].seq + ':' + chat.length : '0';
  if (key !== L.chatKey) {
    const el = L.chatLog;
    const stick = L.chatKey === '' || el.scrollHeight - el.scrollTop - el.clientHeight < 28;
    L.chatKey = key;
    el.replaceChildren(...(chat.length
      ? chat.map((c) => h('div', { class: 'chatmsg' + (c.uid === s.me ? ' mine' : '') + (c.uid === 'system' ? ' sys' : '') },
        c.uid === 'system' ? h('b', { class: 'sysname' }, c.nickname) : h('b', { class: 'pname', style: 'color:' + chatColor(c.uid, s.players) }, c.nickname),
        h('span', { class: 'ts' }, ` [${clockTime(c.ts)}]`), ': ', c.text))
      : [h('div', { class: 'muted' }, '還沒有人說話，打個招呼吧')]));
    if (stick) el.scrollTop = el.scrollHeight;
  }
  L.hint.textContent = iAmHost ? '' : '等待房主開始遊戲…';
}

// ---- waiting for the screens ---------------------------------------------------------------------------------------
function waitView() {
  const s = S;
  const slot = mySlot();
  const need = slot >= 0 && !screenOk();
  const painters = s.slots.map((uid) => s.players.find((p) => p.uid === uid));
  return h('div', { class: 'panel wait' },
    h('h2', {}, '準備作畫'),
    h('p', { class: 'muted' }, '本局題目：', h('b', { style: 'color:var(--gold)' }, s.reference ? s.reference.title : '？')),
    need
      ? h('div', {}, h('div', { class: 'phone' }, '📱'), h('p', { class: 'need' }, '請把手機轉成橫向（或換到更寬的螢幕）'), h('p', { class: 'muted' }, '參考圖與畫布要並排，兩位玩家都就緒才會開始倒數。'))
      : h('p', { class: 'muted' }, slot >= 0 ? '你的畫面已就緒，等待對方…' : '玩家正在準備畫面…'),
    h('ul', { class: 'plist' }, painters.map((p, i) =>
      h('li', {}, h('span', { class: 'slot s' + i }, `玩家 ${i + 1}`), h('span', { class: 'who' }, p ? p.nickname : '（空位）'),
        h('span', { class: p && p.orientOk ? 'ok' : 'no' }, p && p.orientOk ? '✔ 已就緒' : '✖ 還沒轉橫向')))),
    h('div', { class: 'row', style: 'justify-content:center;margin-top:12px' },
      s.me === s.hostUid && h('button', { onclick: () => send({ t: 'cancel' }) }, '取消，回等候房'),
      h('button', { onclick: () => send({ t: 'leave' }) }, '離開房間')));
}

// ---- the paper -------------------------------------------------------------------------------------------------------
const K = 2; // the canvas is drawn at twice the logical size

function makePaper() {
  const cv = h('canvas', { class: 'paper', width: S.canvas.w * K, height: S.canvas.h * K });
  const g = cv.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, cv.width, cv.height);
  return cv;
}

function paintStroke(g, st, from = 0) {
  const col = S.palette[st.c];
  if (st.runs) {
    // a bucket fill: rows of squares, [y, x0, x1] each, in S.fillUnit canvas units (whole pixels, so no seams)
    g.fillStyle = col;
    const u = S.fillUnit * K;
    for (let i = 0; i < st.runs.length; i += 3) g.fillRect(st.runs[i + 1] * u, st.runs[i] * u, (st.runs[i + 2] - st.runs[i + 1]) * u, u);
    return;
  }
  g.strokeStyle = col;
  g.fillStyle = col;
  g.lineWidth = st.w * K;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  const p = st.pts;
  if (p.length === 2) {
    g.beginPath();
    g.arc(p[0] * K, p[1] * K, (st.w * K) / 2, 0, Math.PI * 2);
    g.fill();
    return;
  }
  g.beginPath();
  g.moveTo(p[from] * K, p[from + 1] * K);
  for (let i = from + 2; i < p.length; i += 2) g.lineTo(p[i] * K, p[i + 1] * K);
  g.stroke();
}

function repaint(slot) {
  const cv = G.canvases && G.canvases[slot];
  if (!cv) return;
  const g = cv.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, cv.width, cv.height);
  for (const st of local.strokes[slot]) paintStroke(g, st);
}
function repaintAll() {
  repaint(0);
  repaint(1);
}

// ---- the painting screen ---------------------------------------------------------------------------------------------
const tool = { color: 5, size: 1, mode: 'pen' }; // mode: 'pen' or 'bucket'

function showGame() {
  const slot = mySlot();
  const role = slot >= 0 ? 'p' + slot : 'w';
  if (view !== 'game' || G.role !== role) {
    view = 'game';
    buildGame(slot, role);
  }
  updateGame();
}

function topBar(right) {
  G.timer = h('span', { class: 'timer' }, '3:00');
  G.bar = h('div', { class: 'dg-bar', style: 'width:100%' });
  return h('div', { class: 'dg-top' },
    h('div', { class: 'left' }, h('span', {}, '🖼️ 臨摹大賽'), plate(S.roomId)),
    G.timer,
    h('div', { class: 'right' }, right),
    G.bar);
}

function refCol(cls, tappable) {
  const col = h('div', Object.assign({ class: 'dg-col ref ' + cls }, tappable ? { role: 'button', tabindex: '0', 'aria-label': '參考圖：點一下放大，再點一下縮回去' } : {}),
    h('div', { class: 'fit' }, h('img', { class: 'refimg', src: S.reference.file, alt: '參考圖：' + S.reference.title })),
    h('div', { class: 'dg-cap' }, '參考圖・' + S.reference.title, h('span', { class: 'hint' }, '　點一下縮回去')));
  // on a compact screen the reference is a thumbnail in the top left corner: a tap opens it big, a tap puts it back
  if (tappable) col.addEventListener('click', () => { if (compactLayout()) col.classList.toggle('big'); });
  return col;
}

function buildGame(slot, role) {
  G.role = role;
  G.canvases = [null, null];
  G.countNum = h('div', { class: 'num' });
  G.count = h('div', { class: 'dg-count hidden' }, G.countNum,
    h('div', { class: 'cdhint' }, compactLayout() ? '參考圖在左上角，點一下可以放大來看' : '參考圖在左邊，對照著畫'));
  const leave = slot >= 0
    ? h('button', { onclick: () => confirm('認輸並結束這一局？對手會直接獲勝，你會和大家一起回到等候房。') && send({ t: 'quit' }) }, '認輸')
    : h('button', { onclick: () => confirm('離開房間？') && send({ t: 'leave' }) }, '離開');
  const names = S.slotNames;
  let main;
  if (slot >= 0) {
    G.canvases[slot] = makePaper();
    main = h('div', { class: 'dg-main' },
      refCol('', true),
      h('div', { class: 'dg-col' }, h('div', { class: 'fit' }, G.canvases[slot]), h('div', { class: 'dg-cap' }, `你是玩家 ${slot + 1}（${names[slot]}）`)),
      buildTools());
  } else {
    G.canvases = [makePaper(), makePaper()];
    const col = (i) => h('div', { class: 'dg-col p' + i }, h('div', { class: 'fit' }, G.canvases[i]), h('div', { class: 'dg-cap' }, `玩家 ${i + 1}・`, h('b', {}, names[i])));
    main = h('div', { class: 'dg-main' }, col(0), refCol(''), col(1));
  }
  app.replaceChildren(h('div', { class: slot >= 0 ? 'dg dg-player' : 'dg dg-watch', style: 'position:relative' }, topBar(leave), main, G.count));
  repaintAll();
  if (slot >= 0) attachDrawing(slot);
}

function buildTools() {
  const swatch = (i) => {
    const paper = i === S.palette.length - 1;
    return h('button', {
      class: 'swatch' + (tool.color === i ? ' on' : ''), style: `background:${S.palette[i]}`,
      'aria-label': paper ? '橡皮擦（紙色）' : '顏色 ' + (i + 1), title: paper ? '橡皮擦（紙色）' : '',
      onclick: (e) => { tool.color = i; for (const b of e.currentTarget.parentNode.children) b.classList.toggle('on', b === e.currentTarget); },
    }, paper ? '擦' : '');
  };
  const sizeBtn = (i) => h('button', {
    class: tool.size === i ? 'on' : '', 'aria-label': '筆刷 ' + (i + 1),
    onclick: (e) => { tool.size = i; for (const b of e.currentTarget.parentNode.children) b.classList.toggle('on', b === e.currentTarget); },
  }, h('i', { style: `width:${4 + i * 7}px;height:${4 + i * 7}px` }));
  const mode = (m, icon, label) => h('button', {
    class: tool.mode === m ? 'on' : '', 'aria-pressed': tool.mode === m,
    onclick: (e) => {
      tool.mode = m;
      for (const b of e.currentTarget.parentNode.children) b.classList.toggle('on', b === e.currentTarget);
      if (G.canvases && G.canvases[mySlot()]) G.canvases[mySlot()].classList.toggle('bucket', m === 'bucket');
      if (G.sizes) G.sizes.classList.toggle('off', m === 'bucket');
    },
  }, icon + ' ', h('span', { class: 'lab' }, label));
  G.sizes = h('div', { class: 'sizes' + (tool.mode === 'bucket' ? ' off' : '') }, S.brushSizes.map((_, i) => sizeBtn(i)));
  return h('div', { class: 'dg-col dg-tools' },
    h('div', { class: 'modes' }, mode('pen', '✏️', '畫筆'), mode('bucket', '🪣', '油漆桶')),
    h('h4', {}, '顏色'),
    h('div', { class: 'swatches' }, S.palette.map((_, i) => swatch(i))),
    h('h4', {}, '筆刷'),
    G.sizes,
    h('div', { class: 'acts' },
      h('button', { onclick: undo, 'aria-label': '復原' }, '↶ ', h('span', { class: 'lab' }, '復原')),
      h('button', { onclick: () => confirm('清空整張畫布？') && clearAll(), 'aria-label': '清空' }, '🗑 ', h('span', { class: 'lab' }, '清空'))));
}

function undo() {
  const slot = G.role === 'p0' ? 0 : 1;
  if (S.status !== 'DRAWING' || !local.strokes[slot].length) return;
  local.strokes[slot].pop();
  repaint(slot);
  send({ t: 'undo' });
}
function clearAll() {
  const slot = G.role === 'p0' ? 0 : 1;
  if (S.status !== 'DRAWING') return;
  local.strokes[slot] = [];
  repaint(slot);
  send({ t: 'clear' });
}

function attachDrawing(slot) {
  const cv = G.canvases[slot];
  const g = cv.getContext('2d');
  let cur = null;
  let last = 0; // index (in cur.pts) of the point the next segment starts from
  let strokeId = 0; // numbers the strokes, so the spectators can tell which one a piece belongs to
  let id = 0;
  let sent = 0; // how many numbers of cur.pts the spectators have already been sent
  let streamTimer = null;
  // while the line is being drawn, send what is new every 80 ms (the finished stroke is sent when the pen lifts)
  const flush = () => {
    if (!cur || cur.pts.length <= sent) return;
    const from = Math.max(0, sent - 2); // one point back, so the pieces join up
    send({ t: 'seg', id, stroke: { c: cur.c, w: cur.w, pts: cur.pts.slice(from) } });
    sent = cur.pts.length;
  };
  const at = (e) => {
    const r = cv.getBoundingClientRect();
    return [r1(((e.clientX - r.left) / r.width) * S.canvas.w), r1(((e.clientY - r.top) / r.height) * S.canvas.h)];
  };
  const begin = (x, y) => {
    cur = { c: tool.color, w: S.brushSizes[tool.size], pts: [x, y] };
    last = 0;
    sent = 0;
    id = ++strokeId;
    paintStroke(g, cur);
    clearInterval(streamTimer);
    streamTimer = setInterval(flush, 80);
    flush(); // the first point goes out at once
  };
  const commit = () => {
    if (!cur) return;
    clearInterval(streamTimer);
    local.strokes[slot].push(cur);
    send({ t: 'stroke', id, stroke: cur });
    cur = null;
  };

  // One finger paints, nothing else does. Two fingers (a resting palm, a pinch, a second hand) never leave a mark:
  // - a stroke does not start the moment a finger lands but a moment later, or when it moves, so that a second
  //   finger arriving at the same time cancels it before anything is drawn;
  // - a second finger ends the stroke in progress, and nothing is drawn again until every finger is up;
  // - a bucket fill happens when the one finger is lifted (a tap), not when it lands.
  const fingers = new Set();
  let multi = false; // a second finger came down: ignore everything until all are up
  let pending = null; // { x, y, timer }: the finger is down, the stroke has not started yet
  let tap = null; // { x, y }: bucket mode, waiting for the finger to lift
  const startPending = () => {
    if (!pending) return;
    clearTimeout(pending.timer);
    const p = pending;
    pending = null;
    if (!multi && fingers.size === 1 && S.status === 'DRAWING') begin(p.x, p.y);
  };
  cv.addEventListener('pointerdown', (e) => {
    if (S.status !== 'DRAWING' || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault();
    fingers.add(e.pointerId);
    if (fingers.size > 1) { // a second finger
      multi = true;
      if (pending) { clearTimeout(pending.timer); pending = null; }
      tap = null;
      commit();
      return;
    }
    multi = false;
    cv.setPointerCapture(e.pointerId);
    const [x, y] = at(e);
    if (tool.mode === 'bucket') { tap = { x, y }; return; }
    pending = { x, y, timer: setTimeout(startPending, 60) };
  });
  cv.addEventListener('pointermove', (e) => {
    if (multi) return;
    if (pending) startPending();
    if (!cur) return;
    e.preventDefault();
    for (const ev of e.getCoalescedEvents ? e.getCoalescedEvents() : [e]) {
      const [x, y] = at(ev);
      const n = cur.pts.length;
      const dx = x - cur.pts[n - 2];
      const dy = y - cur.pts[n - 1];
      if (dx * dx + dy * dy < 2.25) continue; // under 1.5 units: not worth a point
      cur.pts.push(x, y);
      paintStroke(g, cur, last);
      last = cur.pts.length - 2;
      if (cur.pts.length >= 560) { // very long line: cut it here, carry on from the same spot
        commit();
        begin(x, y);
      }
    }
  });
  const lift = (e) => {
    const wasMulti = multi;
    fingers.delete(e.pointerId);
    if (!fingers.size) multi = false;
    if (wasMulti) return;
    if (tap) { // bucket: a tap fills where the finger came down (unless it had wandered off: that was not a tap)
      const [x, y] = at(e);
      const t = tap;
      tap = null;
      if (Math.hypot(x - t.x, y - t.y) < 14) bucketFill(slot, cv, t.x, t.y);
      return;
    }
    startPending(); // a quick tap still leaves its dot
    commit();
  };
  cv.addEventListener('pointerup', lift);
  cv.addEventListener('pointercancel', (e) => { tap = null; lift(e); });
  cv.addEventListener('lostpointercapture', (e) => { if (fingers.has(e.pointerId)) { tap = null; lift(e); } });
  // two fingers on the sheet must not zoom or scroll the page either
  cv.addEventListener('touchstart', (e) => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });
}

/**
 * The bucket: look at what is on the canvas at the spot, find the connected area of nearly the same colour, and paint it.
 * The area is sent as rows of squares (see paintStroke); the server keeps it like any other stroke, so undo and the judge work.
 */
let bucketId = 1_000_000; // (numbers apart from the pen's, so a spectator never mixes a fill up with a line)
function bucketFill(slot, cv, x, y) {
  const U = S.fillUnit;
  const cols = Math.ceil(S.canvas.w / U);
  const rows = Math.ceil(S.canvas.h / U);
  const g = cv.getContext('2d');
  const img = g.getImageData(0, 0, cv.width, cv.height).data;
  const colourAt = (cx, cy) => {
    const X = Math.min(cv.width - 1, cx * U * K + ((U * K) >> 1));
    const Y = Math.min(cv.height - 1, cy * U * K + ((U * K) >> 1));
    const i = (Y * cv.width + X) * 4;
    return [img[i], img[i + 1], img[i + 2]];
  };
  const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
  const hex = S.palette[tool.color];
  const want = [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
  const sx = Math.max(0, Math.min(cols - 1, Math.floor(x / U)));
  const sy = Math.max(0, Math.min(rows - 1, Math.floor(y / U)));
  const start = sy * cols + sx;
  const target = colourAt(sx, sy);
  if (dist(target, want) < 8) return; // already that colour
  const TOLERANCE = 0; // the same colour code, or it is another colour: a different code always stops the fill
  const barrier = new Uint8Array(cols * rows); // 1: a different colour, the fill stops here
  for (let c = 0; c < cols * rows; c++) barrier[c] = dist(colourAt(c % cols, (c / cols) | 0), target) > TOLERANCE ? 1 : 0;
  const around = [[1, 0], [-1, 0], [0, 1], [0, -1]];

  // a plain flood fill, like Paint: spread up, down, left and right from the click, stop at a different colour
  const seen = new Uint8Array(cols * rows);
  const q = new Int32Array(cols * rows);
  let h = 0;
  let t = 0;
  q[t++] = start;
  seen[start] = 1;
  while (h < t) {
    const c = q[h++];
    const cx = c % cols;
    const cy = (c / cols) | 0;
    for (const [dx, dy] of around) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows || seen[ny * cols + nx] || barrier[ny * cols + nx]) continue;
      seen[ny * cols + nx] = 1;
      q[t++] = ny * cols + nx;
    }
  }
  // the soft edge of a stroke is a blend of the two colours: the cells of it that are closer to this area's colour than to the stroke's go with the area
  const edge = [];
  for (let c = 0; c < cols * rows; c++) {
    if (seen[c]) continue;
    const cx = c % cols;
    const cy = (c / cols) | 0;
    let touches = false;
    let other = null;
    for (const [dx, dy] of around) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
      const n = ny * cols + nx;
      if (seen[n]) touches = true;
      else if (barrier[n] && dist(colourAt(nx, ny), target) > 40) other = colourAt(nx, ny); // a solid colour of something else
    }
    if (!touches) continue;
    const mine = colourAt(cx, cy);
    if (other && dist(mine, target) < dist(mine, other)) edge.push(c);
    else if (!other && dist(mine, target) < 60) edge.push(c);
  }
  for (const c of edge) seen[c] = 1;
  const runs = [];
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      if (!seen[cy * cols + cx]) continue;
      const x0 = cx;
      while (cx + 1 < cols && seen[cy * cols + cx + 1]) cx++;
      runs.push(cy, x0, cx + 1);
    }
  }
  if (runs.length / 3 > 1500) { toast('這塊區域太零碎了，換個比較完整的地方試試'); return; }
  const stroke = { c: tool.color, w: 0, pts: [], runs };
  local.strokes[slot].push(stroke);
  paintStroke(g, stroke);
  send({ t: 'stroke', id: ++bucketId, stroke });
}

function updateGame() {
  const s = S;
  G.count.classList.toggle('hidden', s.status !== 'COUNTDOWN');
  clearInterval(G.tick);
  const tick = () => {
    const now = nowMs();
    if (S.status === 'COUNTDOWN') {
      const n = Math.max(1, Math.ceil((S.startsAt - now) / 1000));
      G.countNum.textContent = String(n);
      G.timer.textContent = fmt(S.drawMs);
      G.bar.style.width = '100%';
    } else if (S.status === 'DRAWING') {
      const left = Math.max(0, S.endsAt - now);
      G.timer.textContent = fmt(left);
      G.timer.classList.toggle('low', left < 30000);
      G.bar.style.width = (left / S.drawMs) * 100 + '%';
    }
  };
  tick();
  G.tick = setInterval(tick, 100);
}
const fmt = (ms) => `${Math.floor(Math.ceil(ms / 1000) / 60)}:${String(Math.ceil(ms / 1000) % 60).padStart(2, '0')}`;

// ---- the result ------------------------------------------------------------------------------------------------------
function resultView() {
  clearInterval(G.tick);
  const s = S;
  const res = s.result;
  G.role = 'result';
  G.canvases = [makePaper(), makePaper()];
  repaintAll();
  const names = s.slotNames;
  const win = res.winner;
  const col = (i) => h('div', { class: 'dg-col p' + i },
    h('div', { class: 'fit' }, G.canvases[i]),
    h('div', { class: 'dg-cap' + (win === i ? ' win' : '') }, `玩家 ${i + 1}・`, h('b', {}, names[i] + (win === i ? ' 🏆' : ''))),
    h('div', { class: 'score' + (win === i ? ' win' : '') }, res.scores[i].toFixed(1) + '%'));
  const iAmHost = s.me === s.hostUid;
  return h('div', { class: 'dg dg-watch', style: 'position:relative' },
    h('div', { class: 'dg-banner' },
      res.forfeit !== null ? `${names[res.forfeit]} 退出比賽，${names[win]} 直接獲勝！` : win === null ? '平手！' : `${names[win]} 獲勝！`,
      h('small', {}, res.forfeit !== null ? `對手中途退出（當時相似度 ${res.scores[0].toFixed(1)}% 對 ${res.scores[1].toFixed(1)}%）` : `相似度 ${res.scores[0].toFixed(1)}% 對 ${res.scores[1].toFixed(1)}%`)),
    h('div', { class: 'dg-main' }, col(0), refCol(''), col(1)),
    h('div', { class: 'dg-foot' },
      h('button', { class: 'primary', onclick: () => send({ t: 'again' }) }, '回等候房'),
      h('button', { onclick: () => confirm('離開房間？') && send({ t: 'leave' }) }, '離開房間')));
}

// no pinch zoom: the page is a tool, not a document (iOS Safari ignores the viewport tag for this)
for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(ev, (e) => e.preventDefault());
// (double-tap zoom is switched off by touch-action: manipulation in the stylesheet, which leaves quick taps on the buttons alone)

// ---- go ------------------------------------------------------------------------------------------------------------------
render();
connect();
