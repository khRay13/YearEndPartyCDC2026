'use strict';
// 射龍門 client. All game truth comes from the server; this file only renders and sends intents.
//
// Rendering notes (bug: third card's rank/suit used to blank out until selected):
//  * No 3D transforms / perspective. Flip is a plain 2D scaleX animation.
//  * The table ("stage") is a persistent DOM subtree: server broadcasts never rebuild it, so
//    animations are never restarted mid-flight.
//  * While a reveal animation runs, `shown` (what panels render) is frozen so the pot/chips/ranking
//    do not spoil the result before the card lands.

const app = document.getElementById('app');
const connEl = document.getElementById('conn');
const toastEl = document.getElementById('toast');
const CHIPS = [50, 100, 500, 1000];
const SUIT = { S: '♠', H: '♥', D: '♦', C: '♣' };
const RANK = { 1: 'A', 11: 'J', 12: 'Q', 13: 'K' };
const rankLabel = (r) => RANK[r] || String(r);
const EMPTY_COUNTS = () => ({ 50: 0, 100: 0, 500: 0, 1000: 0 });

let ws = null;
let latest = null; // newest server state
let shown = null; // state used for rendering (frozen during reveal animations)
let clockOffset = 0; // serverNow - Date.now()
let homeTab = 'create';
let counts = EMPTY_COUNTS();
let countsTurn = null;
let synced = false;
let lastSeen = 0; // last record turnId already handled
let holding = false;
let busy = false;
let rejoinRoom = null; // room this device left mid-match (computer is playing for it)
let commitTimer = null;
const animChips = new Map(); // uid -> chips to show while a shot animates (bet, settlement, dealer payout)
let menuOpen = false; // phone side menu
const allInShown = new Set(); // turn ids whose ALL IN effect already played (never twice, never replayed on reconnect)
let animPot = null; // pot to display while a shot animates: the stake after the bet, before settlement
const queue = [];
let toastTimer = null;
let form = { nickname: localStorage.getItem('nick') || '', roomId: '' };

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}
/** replaceChildren that drops false/null/undefined (the result of `condition && element`) instead of printing them. */
function fill(el, ...nodes) {
  el.replaceChildren(...nodes.flat().filter((n) => n != null && n !== false));
}
const fmt = (n) => (n == null ? '-' : Number(n).toLocaleString('en-US'));
const now = () => Date.now() + clockOffset;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now());

// ---- ALL IN: full-screen effect for every player in the room -------------------------------------
function announceAllIn(turnId, uid, amount) {
  if (allInShown.has(turnId)) return;
  allInShown.add(turnId);
  showAllIn(nameOf(uid), amount);
}

function showAllIn(name, amount) {
  document.querySelectorAll('.allin').forEach((e) => e.remove());
  const glyphs = ['✨', '🪙', '💥', '⭐', '🔥'];
  const reach = Math.min(window.innerWidth || 400, window.innerHeight || 700);
  const sparks = [];
  for (let i = 0; i < 26; i++) {
    const ang = Math.random() * Math.PI * 2;
    const dist = 120 + Math.random() * reach * 0.6;
    sparks.push(h('span', {
      class: 'spark',
      style: `--dx:${Math.round(Math.cos(ang) * dist)}px;--dy:${Math.round(Math.sin(ang) * dist)}px;--rot:${Math.round(Math.random() * 360 - 180)}deg;--delay:${(Math.random() * 0.5).toFixed(2)}s`,
    }, glyphs[i % glyphs.length]));
  }
  const el = h('div', { class: 'allin', role: 'alert', 'aria-live': 'assertive' },
    h('div', { class: 'rays' }),
    ...sparks,
    h('div', { class: 'box' },
      h('div', { class: 'big' }, 'ALL IN!'),
      h('div', { class: 'who' }, `${name} 全押`, amount != null && h('span', { class: 'amt' }, ' ' + fmt(amount))),
      h('div', { class: 'sub' }, '所有籌碼都押上了！')));
  document.body.append(el);
  setTimeout(() => el.remove(), 2700);
}

function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.add('hidden'), 3200);
}

// ---- networking ------------------------------------------------------------
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => connEl.classList.add('hidden');
  ws.onclose = () => {
    connEl.classList.remove('hidden');
    setTimeout(connect, 1500);
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.t === 'state') onState(msg.state, msg.notice, msg.rejoin);
    else if (msg.t === 'error') toast(msg.message || msg.code);
  };
}
function send(obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  else toast('尚未連線');
}
setInterval(() => ws && ws.readyState === 1 && send({ t: 'ping' }), 25000);

function onState(s, notice, rejoin) {
  if (notice) toast(notice);
  if (!s) {
    rejoinRoom = rejoin || null;
    latest = shown = null;
    allInShown.clear();
    synced = false;
    lastSeen = 0;
    queue.length = 0;
    holding = false;
    unmountGame();
    render();
    return;
  }
  rejoinRoom = null;
  clockOffset = s.serverNow - Date.now();
  latest = s;
  if (!s.game) { // waiting room: the next match numbers its turns from 1 again
    lastSeen = 0;
    allInShown.clear();
    queue.length = 0;
    holding = false;
  }
  // No live human left: the computers play the match out fast, so skip animations and coalesce renders.
  const fast = !!(s.game && s.game.fast);
  const rec = s.game ? s.game.lastRecord : null;
  const wasSynced = synced;
  if (!synced) {
    synced = true; // first sync (join / reconnect): never replay old animations
    lastSeen = rec ? rec.turnId : 0;
  } else if (rec && rec.turnId > lastSeen) {
    lastSeen = rec.turnId;
    if (fast) {
      // watching a fast-forwarded match: no per-shot animation
    } else if (rec.action === 'SHOOT') {
      holding = true;
      queue.push(rec);
      if (!busy) runQueue();
    } else {
      if (rec.isAllIn) announceAllIn(rec.turnId, rec.uid, rec.bet); // computer bet everything, then passed
      flashBanner(rec);
    }
  }
  // A player has just bet everything (and not shot yet): tell everyone. Never on a first sync / fast-forward.
  if (s.game && s.game.allIn && s.game.currentUid && !allInShown.has(s.game.turnId)) {
    if (wasSynced && !fast) announceAllIn(s.game.turnId, s.game.currentUid, s.game.currentBet);
    else allInShown.add(s.game.turnId);
  }
  if (!holding) {
    if (!fast) commit();
    else if (!commitTimer) commitTimer = setTimeout(() => { commitTimer = null; if (!holding) commit(); }, 120);
  }
}

function commit() {
  shown = latest;
  render();
}

// ---- helpers ---------------------------------------------------------------
const player = (uid) => (latest && latest.players.find((p) => p.uid === uid)) || null;
const nameOf = (uid) => (player(uid) || {}).nickname || '?';
const me = () => (shown ? shown.players.find((p) => p.uid === shown.me) : null);
const total = () => CHIPS.reduce((s, v) => s + v * counts[v], 0);

function cardEl(c, cls) {
  if (!c) return h('div', { class: 'card back ' + (cls || '') });
  const red = c.suit === 'H' || c.suit === 'D';
  return h('div', { class: `card ${red ? 'red' : ''} ${cls || ''}` },
    h('span', { class: 'r' }, rankLabel(c.rank)), h('span', { class: 's' }, SUIT[c.suit]));
}
function miniCard(c, cls) {
  const red = c.suit === 'H' || c.suit === 'D';
  return h('span', { class: `mini ${red ? 'red' : ''} ${cls || ''}` }, rankLabel(c.rank) + SUIT[c.suit]);
}
function plate(id, small) {
  return h('div', { class: 'plate' + (small ? ' sm' : '') }, String(id).split('').map((d) => h('span', { class: 'digit' }, d)));
}

function resultText(r) {
  const who = nameOf(r.uid) + (r.isAuto ? '（電腦代打）' : '');
  if (r.result === 'PASS') return `${who} 下注 ${fmt(r.bet)} 後 PASS`;
  if (r.result === 'HIT') return `${who} 射中！贏得獎池 ${fmt(r.potAfterBet)}${r.dealerBonus > 0 ? '，窄門！莊家另付 ' + fmt(r.dealerBonus) : ''}${r.dealerLoot > 0 ? '，窄門！莊家搜括 ' + fmt(r.dealerLoot) : ''}`;
  if (r.result === 'MISS') return `${who} 射出`;
  if (r.extraMultiplier === 0.5) return `${who} 莊家撞柱！賠付減半 ${fmt(r.extraPayment)}`;
  return `${who} 撞柱！額外賠付 ${fmt(r.extraPayment)}`;
}

// ---- views -----------------------------------------------------------------
let view = null;
function render() {
  const s = shown;
  let next;
  if (!s) next = 'home';
  else if (s.status === 'WAITING' || s.status === 'READY') next = 'lobby';
  else if (s.status === 'FINISHED') next = 'result';
  else next = 'game';
  if (next === 'game') {
    if (view !== 'game') {
      app.replaceChildren(buildGame());
      view = 'game';
    }
    updateGame();
    return;
  }
  if (next === 'lobby') {
    if (view !== 'lobby') {
      if (view === 'game') unmountGame();
      app.replaceChildren(buildLobby());
      view = 'lobby';
    }
    updateLobby();
    return;
  }
  if (view === 'game') unmountGame();
  if (view === 'lobby') for (const k of Object.keys(L)) delete L[k];
  view = next;
  app.replaceChildren(next === 'home' ? homeView() : resultView());
}

function homeView() {
  const field = (label, key, attrs, hint) =>
    h('label', { class: 'col' }, h('span', { class: 'muted' }, label),
      h('input', Object.assign({ value: form[key], oninput: (e) => {
        if (key === 'roomId') e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
        form[key] = e.target.value;
      } }, attrs)), hint && h('span', { class: 'muted' }, hint));
  const submit = () => {
    localStorage.setItem('nick', form.nickname);
    if (homeTab === 'create') send({ t: 'create', nickname: form.nickname });
    else send({ t: 'join', roomId: form.roomId.trim(), nickname: form.nickname });
  };
  return h('div', { class: 'panel', style: 'max-width:440px;margin:6vh auto' },
    h('h1', {}, '🐉 射龍門'),
    h('p', { class: 'muted' }, '私人房間・虛擬籌碼・2–12 人'),
    rejoinRoom && h('div', { class: 'rejoin' },
      h('div', {}, `你離開了房間 ${rejoinRoom} 的進行中遊戲，電腦正在代打。`),
      h('button', { class: 'primary', onclick: () => send({ t: 'rejoin' }) }, '回到遊戲')),
    h('div', { class: 'tabs' },
      h('button', { class: homeTab === 'create' ? 'on' : '', onclick: () => { homeTab = 'create'; render(); } }, '建立房間'),
      h('button', { class: homeTab === 'join' ? 'on' : '', onclick: () => { homeTab = 'join'; render(); } }, '加入房間')),
    h('div', { class: 'col' },
      field('暱稱（1–12 字）', 'nickname', { type: 'text', placeholder: '你的暱稱', maxlength: 12 }),
      homeTab === 'join' && field('房間號碼（6 碼數字）', 'roomId', { type: 'text', inputmode: 'numeric', pattern: '[0-9]*', placeholder: '000000', maxlength: 6 }),
      h('button', { class: 'primary', onclick: submit }, homeTab === 'create' ? '建立' : '加入')));
}

// ---- waiting room (persistent skeleton: the chat box must keep focus and its draft across server updates) ----
const L = {};
let chatDraft = '';

function buildLobby() {
  L.info = h('div', { class: 'panel' });
  L.controls = h('div', { class: 'row ctlrow', style: 'margin-bottom:12px' });
  L.players = h('div', { class: 'panel' });
  L.chatLog = h('div', { class: 'chatlog', role: 'log', 'aria-live': 'polite', 'aria-label': '聊天室訊息' });
  L.chatInput = h('input', {
    type: 'text', class: 'chatin', maxlength: 200, autocomplete: 'off', enterkeyhint: 'send',
    placeholder: '輸入訊息（只能文字）', 'aria-label': '聊天訊息', value: chatDraft,
    oninput: (e) => { chatDraft = e.target.value; },
    onkeydown: (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); sendChat(); } },
  });
  L.chat = h('div', { class: 'panel chatbox' }, h('h3', {}, '聊天室'), L.chatLog,
    h('div', { class: 'chatform' }, L.chatInput, h('button', { class: 'primary', onclick: sendChat }, '送出')));
  L.hint = h('p', { class: 'muted' });
  L.notice = h('div', { class: 'hostclock hidden', role: 'status' });
  L.chatKey = '';
  // players first, chat second in the DOM: stacked on phones, side by side when the screen is wide enough
  L.cols = h('div', { class: 'lobbycols' }, L.players, L.chat);
  return h('div', {}, L.info, L.controls, L.notice, L.cols, L.hint);
}

function sendChat() {
  const text = (L.chatInput ? L.chatInput.value : '').trim();
  if (!text) return;
  send({ t: 'chat', text });
  chatDraft = '';
  if (L.chatInput) { L.chatInput.value = ''; L.chatInput.focus(); } // keep typing: the keyboard stays up on phones
}

function updateLobby() {
  const s = shown;
  const iAmHost = s.me === s.hostUid;
  const n = s.players.length;
  const seated = s.players.filter((p) => !p.isObserver && !p.onResult); // those who will play: back in the room
  const reading = s.players.filter((p) => p.onResult).length; // still on the result table
  const watchers = s.players.filter((p) => p.isObserver).length;

  fill(L.info, 
    h('div', { class: 'roomline', title: '把號碼告訴朋友，輸入號碼即可加入' }, h('span', { class: 'roomlabel' }, '房號：'), plate(s.roomId)),
    h('div', { class: 'opts' },
    h('div', { class: 'deckpick', role: 'radiogroup', 'aria-label': '牌組' },
      h('span', { class: 'muted' }, '牌組'),
      [1, 2].map((d) => h('label', { class: 'radio' + (s.deckCopies === d ? ' on' : '') + (iAmHost ? '' : ' ro') },
        h('input', { type: 'radio', name: 'deck', value: String(d), checked: s.deckCopies === d, disabled: !iAmHost, onchange: () => send({ t: 'setDeck', copies: d }) }),
        `${d} 副牌（${52 * d} 張）`))),
    h('div', { class: 'deckpick', role: 'radiogroup', 'aria-label': '連號門柱' },
      h('span', { class: 'muted' }, '連號門柱'),
      [true, false].map((v) => h('label', { class: 'radio' + (s.allowConsecutive === v ? ' on' : '') + (iAmHost ? '' : ' ro') },
        h('input', { type: 'radio', name: 'consec', value: String(v), checked: s.allowConsecutive === v, disabled: !iAmHost, onchange: () => send({ t: 'setConsecutive', allow: v }) }),
        v ? '允許（會出現）' : '不允許（重抽）')))),
    !iAmHost && h('div', { class: 'muted' }, '牌組與連號門柱由房主決定'),
    reading > 0 && iAmHost && h('div', { class: 'muted' }, '還在看結算的人若來不及按「再玩一局」，開始後會成為觀察者'));

  fill(L.controls, 
    iAmHost && h('button', { class: 'primary grow', disabled: seated.length < s.minPlayers, onclick: () => send({ t: 'start' }) }, '開始遊戲'),
    iAmHost && h('button', { disabled: n >= s.maxPlayers, onclick: () => send({ t: 'addBot' }) }, '＋ 電腦玩家'),
    h('button', { onclick: () => send({ t: 'leave' }) }, '離開房間'));

  fill(L.players, 
    h('div', { class: 'phead' },
      h('h3', {}, '玩家'),
      h('span', { class: 'startnote ' + (seated.length >= s.minPlayers ? 'ok' : 'wait'), role: 'status' },
        seated.length >= s.minPlayers
          ? (iAmHost ? '✔ 可以開始' : '✔ 等房主開始')
          : `✖ 還差 ${s.minPlayers - seated.length} 人才能開始`),
      h('span', { class: 'muted count' },
        `參賽 ${seated.length} 人${watchers ? `・觀察 ${watchers}` : ''}${reading ? `・看結算 ${reading}` : ''}・${n}/${s.maxPlayers}`)),
    h('ul', { class: 'plist' }, s.players.map((p) =>
      h('li', { class: p.isObserver ? 'observer' : '' },
        h('span', { class: 'dot ' + (p.connected ? 'on' : '') }),
        h('span', { class: 'who' }, p.nickname + (p.uid === s.me ? '（你）' : '')),
        p.isHost && h('span', { class: 'tag host' }, '房主'),
        p.isBot && h('span', { class: 'tag' }, '電腦'),
        p.isObserver && h('span', { class: 'tag obs' }, '觀察'),
        p.onResult && h('span', { class: 'tag res' }, '看結算中'),
        h('span', { class: 'wins', title: '在這個房間贏了幾場' }, `勝 ${p.wins || 0} 場`),
        iAmHost && !p.isHost && !p.isBot && h('label', { class: 'obsbox' },
          h('input', { type: 'checkbox', checked: p.isObserver, 'aria-label': `把 ${p.nickname} 設為觀察者`, onchange: (e) => send({ t: 'setObserver', uid: p.uid, observer: e.target.checked }) }),
          '觀察'),
        iAmHost && p.uid !== s.me && h('button', { class: 'small danger', onclick: () => (p.isBot || confirm(`剔除 ${p.nickname}？`)) && send({ t: 'kick', uid: p.uid }) }, '剔除')))));

  // chat log: only touched when something new arrived, and it keeps following the bottom unless you scrolled up
  const chat = s.chat || [];
  const key = chat.length ? chat[chat.length - 1].seq + ':' + chat.length : '0';
  if (key !== L.chatKey) {
    const el = L.chatLog;
    const stick = L.chatKey === '' || el.scrollHeight - el.scrollTop - el.clientHeight < 28;
    L.chatKey = key;
    el.replaceChildren(...(chat.length
      ? chat.map((c) => h('div', { class: 'chatmsg' + (c.uid === s.me ? ' mine' : '') + (c.uid === 'system' ? ' sys' : '') }, nameTag(c, s), h('span', { class: 'ts' }, ` [${clockTime(c.ts)}]`), ': ', c.text)) // text nodes only: never HTML
      : [h('div', { class: 'muted' }, '還沒有人說話，打個招呼吧')]));
    if (stick) el.scrollTop = el.scrollHeight;
  }
  L.hint.textContent = iAmHost ? '' : '等待房主開始遊戲…';
  tickLobby();
}

/** Chat name colours: one per player (join order, the same for everybody); orange is kept for System. */
const CHAT_COLORS = ['#7ec8ff', '#ff8fb1', '#9be37a', '#c9a0ff', '#ffe27a', '#5fe0d0', '#ff7a7a', '#a8b8ff', '#d6f06a', '#ff9ff3', '#8fe3b0', '#bfc9d6'];
function chatColor(uid, players) {
  let i = players.findIndex((p) => p.uid === uid);
  if (i < 0) { i = 0; for (const ch of String(uid)) i = (i * 31 + ch.charCodeAt(0)) >>> 0; } // someone who already left: stable by hash
  return CHAT_COLORS[i % CHAT_COLORS.length];
}

/** The author of a chat line: System is a black badge with a white border and orange text; players get their own colour. */
function nameTag(c, s) {
  if (c.uid === 'system') return h('b', { class: 'sysname' }, c.nickname);
  return h('b', { class: 'pname', style: 'color:' + chatColor(c.uid, s.players) }, c.nickname);
}

/** HH:MM:SS (24-hour) in the viewer's own time zone: the server sends a UTC timestamp. */
function clockTime(ts) {
  const d = new Date(ts);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
}

/** The host is still on the result table: count down to the moment the room passes to the first player back. */
function tickLobby() {
  if (!L.notice || !shown) return;
  const hr = shown.hostReturn;
  if (!hr) { L.notice.classList.add('hidden'); return; }
  const left = Math.max(0, Math.ceil((hr.deadline - now()) / 1000));
  const mm = Math.floor(left / 60);
  const ss = String(left % 60).padStart(2, '0');
  L.notice.classList.remove('hidden');
  L.notice.textContent = left > 0
    ? `房主還沒回來。${mm}:${ss} 後，房主會自動轉給第一個回來的玩家${hr.successor ? `（${hr.successor}）` : ''}。`
    : '房主逾時未回，房主身分正在轉移…';
}

function resultView() {
  const s = shown;
  const g = s.game;
  const byUid = Object.fromEntries(s.players.map((p) => [p.uid, p]));
  const pct = (v) => v.toFixed(1) + '%';
  return h('div', { class: 'panel' },
    h('h1', {}, '🏆 最終排名'),
    h('div', { class: 'tablewrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['名次', '玩家', '最終籌碼', '淘汰順序', '射中', '射出', '撞柱', 'PASS'].map((t) => h('th', {}, t)))),
      h('tbody', {}, g.ranking.map((r) => {
        const st = byUid[r.uid].stats;
        const elim = g.eliminationOrder.indexOf(r.uid);
        return h('tr', { class: r.rank === 1 ? 'rank1' : '' },
          h('td', {}, r.rank === 1 ? '🥇 1' : r.rank),
          h('td', {}, r.nickname),
          h('td', {}, fmt(r.chips)),
          h('td', {}, elim < 0 ? '存活' : `第 ${elim + 1} 位`),
          h('td', {}, `${st.hit}（${pct(st.hitPct)}）`),
          h('td', {}, `${st.miss}（${pct(st.missPct)}）`),
          h('td', {}, `${st.collision}（${pct(st.collisionPct)}）`),
          h('td', {}, String(st.pass)));
      })))),
    h('p', { class: 'muted' }, '機率 = 該玩家的射門次數為分母（不含 PASS）'),
    h('div', { class: 'row' },
      h('button', { class: 'primary grow', onclick: () => send({ t: 'playAgain' }) }, '再玩一局'),
      h('button', { onclick: () => send({ t: 'leave' }) }, '離開遊戲')));
}

// ---- game view (persistent skeleton) ---------------------------------------
const G = {}; // element refs of the mounted game view

const confirmLeave = () => confirm('離開後由電腦代打，確定？') && send({ t: 'leave' });

function buildGame() {
  G.topbar = h('div', { class: 'topbar' });
  G.pillars = h('div', { class: 'pillars' });
  G.pillarL = h('div', { class: 'pillar' });
  G.pillarR = h('div', { class: 'pillar' });
  G.gap = h('div', { class: 'gap' });
  G.pillars.append(G.pillarL, G.gap, G.pillarR);
  G.shotrow = h('div', { class: 'shotrow' }, h('div', { class: 'shotslot' }, '翻牌'));
  G.banner = h('div', { class: 'banner off' }, '\u00a0'); // "off" keeps its space: it must never push the table around
  G.turnbar = h('div', { class: 'turnbar' });
  G.note = h('div', { class: 'gatenote-slot' }); // top-right corner of the table: narrow gate / consecutive posts
  G.gateKey = '';
  G.stage = h('div', { class: 'stage' }, G.pillars, G.shotrow, G.banner);
  G.actions = h('div', { class: 'actions-wrap' });
  G.ranking = h('div', { class: 'panel' });
  G.history = h('div', { class: 'panel' });
  G.leave = h('button', { class: 'leave-btn', onclick: confirmLeave }, '離開遊戲');
  G.backdrop = h('div', { class: 'backdrop', onclick: () => setMenu(false) });
  G.drawer = h('aside', { class: 'drawer', 'aria-label': '遊戲資訊選單' });
  setTimeout(() => setMenu(menuOpen), 0);
  return h('div', { class: 'gamewrap' },
    h('div', { class: 'layout' },
      h('div', { class: 'main' }, G.topbar, h('div', { class: 'panel table' }, G.note, G.stage, G.turnbar), G.actions),
      h('div', { class: 'side' }, G.history, G.ranking, G.leave)),
    G.backdrop, G.drawer);
}

// Phone side menu (the ☰ button): slides in from the left; closes on backdrop tap, ✕ or Escape.
function setMenu(open) {
  menuOpen = !!open;
  if (G.drawer) G.drawer.classList.toggle('open', menuOpen);
  if (G.backdrop) G.backdrop.classList.toggle('open', menuOpen);
  const btn = G.topbar && G.topbar.querySelector('.menu-btn');
  if (btn) btn.setAttribute('aria-expanded', String(menuOpen));
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && menuOpen) setMenu(false); });

function unmountGame() {
  menuOpen = false;
  for (const k of Object.keys(G)) delete G[k];
  view = null;
}

function refreshPot() {
  if (!G.topbar || !shown || !shown.game) return;
  const text = fmt(animPot != null ? animPot : shown.game.pot);
  G.topbar.querySelectorAll('.pot-val').forEach((el) => { el.textContent = text; }); // phone bar + desktop stat
}

function updateGame() {
  const s = shown;
  const g = s.game;
  // Table: gate cards are managed by setGate(); only sync them when no animation owns the stage.
  if (!busy) setGate(g.gate, false);
  // Top bar
  const seated = s.players.filter((p) => !p.isObserver); // observers are not in the game
  const alive = seated.filter((p) => !p.eliminated).length;
  const dealerName = (s.players.find((p) => p.uid === s.dealerUid) || {}).nickname || '-';
  const potText = fmt(animPot != null ? animPot : g.pot);
  G.topbar.replaceChildren(
    // phones: ☰ + "莊家 · 玩家人數" + 獎池 only; everything else lives in the side menu
    h('button', { class: 'menu-btn', 'aria-label': '開啟選單', 'aria-expanded': String(menuOpen), onclick: () => setMenu(true) }, '☰'),
    h('div', { class: 'tb-info' },
      h('span', { class: 'dealer sm', title: '莊家' }, '莊'),
      h('b', { class: 'tb-dealer' }, dealerName),
      h('span', { class: 'tb-count' }, `👥 ${alive}/${seated.length}`)),
    h('div', { class: 'tb-pot' }, '獎池 ', h('b', { class: 'pot-val' }, potText)),
    // tablets / desktop: the full set of stats
    h('div', { class: 'tb-full' },
      h('div', { class: 'stat' }, '房間', plate(s.roomId, true)),
      h('div', { class: 'stat' }, '莊家', h('b', {}, dealerName)),
      h('div', { class: 'stat' }, '玩家人數', h('b', {}, `${alive} / ${seated.length}`)),
      h('div', { class: 'stat' }, '剩餘牌數', h('b', {}, g.remainingCards)),
      h('div', { class: 'stat pot' }, '獎池', h('b', { class: 'pot-val' }, potText))));
  // Side menu content (phones): the info that no longer fits in the bar.
  const mine = s.players.find((p) => p.uid === s.me);
  fill(G.drawer, 
    h('div', { class: 'drawer-head' }, h('b', {}, '遊戲資訊'), h('button', { class: 'drawer-close', 'aria-label': '關閉選單', onclick: () => setMenu(false) }, '✕')),
    h('div', { class: 'drow' }, h('span', { class: 'muted' }, '房間號碼'), plate(s.roomId, true)),
    h('div', { class: 'drow' }, h('span', { class: 'muted' }, '莊家'), h('b', {}, dealerName)),
    h('div', { class: 'drow' }, h('span', { class: 'muted' }, '玩家人數'), h('b', {}, `存活 ${alive} / 共 ${seated.length}`)),
    h('div', { class: 'drow' }, h('span', { class: 'muted' }, '剩餘牌數'), h('b', {}, g.remainingCards)),
    mine && !mine.eliminated && !mine.isObserver && h('div', { class: 'drow' }, h('span', { class: 'muted' }, '我的籌碼'), h('b', {}, fmt(animChips.has(mine.uid) ? animChips.get(mine.uid) : mine.chips))),
    h('div', { class: 'drawer-foot' }, h('button', { class: 'leave-btn drawer-leave', onclick: confirmLeave }, '離開遊戲')));
  // Turn bar
  const cur = s.players.find((p) => p.uid === g.currentUid);
  // Three fixed rows, always present: who is up / their bet / the clock. Their text changes, their place never does,
  // so nothing in this area appears or disappears and the page below does not jump.
  const NB = '\u00a0';
  G.turnbar.replaceChildren(
    h('div', { class: 'name' }, cur ? (cur.uid === s.me ? '輪到你了' : `輪到 ${cur.nickname}${cur.autoMode || cur.isBot ? '（電腦）' : ''}`) : NB),
    h('div', { class: 'muted betnote' }, cur ? (g.currentBet != null ? `已下注 ${fmt(g.currentBet)}` : '尚未下注') : NB),
    h('div', { class: 'timer', id: 'timer' }, NB));
  if (countsTurn !== g.turnId) { counts = EMPTY_COUNTS(); countsTurn = g.turnId; }
  G.actions.replaceChildren(actionPanel(s, g));
  renderRanking(s, g);
  G.history.replaceChildren(h('h3', {}, '翻牌歷史'), historyList(s, g));
  tick();
}

const chipsOf = (p) => (animChips.has(p.uid) ? animChips.get(p.uid) : p.chips);

// Smooth re-ranking (FLIP): remember where each row was, rebuild, then slide rows from old to new spot.
function renderRanking(s, g) {
  if (!G.ranking) return;
  const oldTops = new Map();
  G.ranking.querySelectorAll('li[data-uid]').forEach((li) => oldTops.set(li.dataset.uid, li.getBoundingClientRect().top));
  const watching = s.players.filter((p) => p.isObserver).map((p) => p.nickname);
  fill(G.ranking, h('h3', {}, '玩家排名'), rankingList(s, g),
    watching.length > 0 && h('div', { class: 'muted obsline' }, '👀 觀察者：' + watching.join('、')));
  flip(G.ranking, oldTops);
}

// Move a player's displayed chips (used by the shot animation so the ranking follows bet -> result -> payout).
function showChips(uid, chips) {
  animChips.set(uid, chips);
  if (shown && shown.game) renderRanking(shown, shown.game);
}

function flip(root, oldTops) {
  root.querySelectorAll('li[data-uid]').forEach((li) => {
    const was = oldTops.get(li.dataset.uid);
    if (was == null) return;
    const dy = was - li.getBoundingClientRect().top;
    if (!dy) return;
    li.style.transition = 'none';
    li.style.transform = `translateY(${dy}px)`;
    void li.offsetWidth; // commit the starting position
    li.style.transition = 'transform .7s cubic-bezier(.2,.8,.2,1)';
    li.style.transform = '';
  });
}

function rankingList(s, g) {
  const sorted = s.players.filter((p) => !p.isObserver).sort((a, b) => {
    if (a.eliminated !== b.eliminated) return a.eliminated ? 1 : -1;
    if (a.eliminated) return (a.rank || 99) - (b.rank || 99);
    return (chipsOf(b) || 0) - (chipsOf(a) || 0);
  });
  return h('ol', { class: 'rk' }, sorted.map((p, i) =>
    h('li', { 'data-uid': p.uid, class: `${p.uid === g.currentUid ? 'turn' : ''} ${p.eliminated ? 'out' : ''} ${p.uid === s.me ? 'me' : ''}` },
      h('span', { class: 'pos' }, p.eliminated ? '✕' : i + 1),
      h('span', { class: 'dot ' + (p.connected ? 'on' : '') }),
      p.isDealer && h('span', { class: 'dealer', title: '本局莊家' }, '莊'),
      h('span', { class: 'nm' }, p.nickname),
      p.isHost && h('span', { class: 'tag host' }, '房主'),
      p.isBot && h('span', { class: 'tag' }, '電腦'),
      !p.isBot && (p.autoMode || p.kicked) && h('span', { class: 'tag' }, '代打'),
      !p.isBot && !p.connected && !p.eliminated && h('span', { class: 'tag' }, '離線'),
      h('span', { class: 'chips' }, p.eliminated ? `出局・第 ${p.rank} 名` : fmt(chipsOf(p))),
      p.uid === g.currentUid && h('span', {}, '👈'))));
}

// Solitaire-style tracker: one row per suit, A..K left to right. Face-up = already out this round.
function historyList(s, g) {
  // Two decks: the same suit+rank can come out twice this round -> count occurrences, badge the 2nd.
  const seen = new Map();
  for (const c of g.seenCards || []) seen.set(c.suit + c.rank, (seen.get(c.suit + c.rank) || 0) + 1);
  const totalSeen = (g.seenCards || []).length;
  const gateKeys = new Set(g.gate.map((c) => c.suit + c.rank));
  const last = g.lastCard ? g.lastCard.suit + g.lastCard.rank : null;
  const rows = ['S', 'H', 'D', 'C'].map((suit) => {
    const red = suit === 'H' || suit === 'D';
    const cells = [];
    for (let rank = 1; rank <= 13; rank++) {
      const key = suit + rank;
      const out = seen.has(key);
      const n = seen.get(key) || 0;
      cells.push(h('div', { class: `t ${out ? 'drawn' : 'empty'} ${red ? 'red' : ''} ${gateKeys.has(key) ? 'gate' : ''} ${key === last ? 'last' : ''}`, title: out ? (n > 1 ? '這張牌已出現 ' + n + ' 次' : '') : '還在牌堆' },
        out ? rankLabel(rank) : '',
        n > 1 && h('span', { class: 'dup' }, String(n))));
    }
    return h('div', { class: 'trow' }, h('div', { class: `tsuit ${red ? 'red' : ''}` }, SUIT[suit]), cells);
  });
  return h('div', { class: 'deck-grid' }, rows,
    h('div', { class: 'muted legend' }, `本局已出 ${totalSeen} / ${g.deckSize || 52}　`, h('span', { class: 'lg gate' }, '龍門'), h('span', { class: 'lg last' }, '最新翻牌'),
      // the "2" badge can only appear when more than one deck is shuffled together
      (g.deckSize || 52) > 52 && [h('span', { class: 'lg dup2' }, '2'), '＝同一張牌出現第 2 次　'],
      '空格＝還在牌堆'));
}

function actionPanel(s, g) {
  const m = me();
  const mine = h('label', { class: 'switch' },
    h('input', { type: 'checkbox', checked: !!(m && m.autoMode), onchange: (e) => send({ t: 'setAuto', on: e.target.checked }) }),
    h('span', { class: 'slider' }), h('span', {}, '🤖 代打'));
  if (m && m.isObserver) return h('div', { class: 'panel' }, '👀 你是觀察者：只看不玩，不能下注也不能射龍門');
  if (m && m.eliminated) return h('div', { class: 'panel' }, '👀 你已淘汰，觀戰中');
  const lockedNow = g.lockedChips || [];
  const minNow = g.minChip || 50;
  const head = h('div', { class: 'ahead' },
    h('div', { class: 'headinfo' },
      h('span', { class: 'muted' }, m ? `我的籌碼 ${fmt(m.chips)}` : ''),
      // chips get locked as the deck is used up: said right next to the player's own chips
      // (which chips are locked is shown on the chips themselves, the smallest bet in the line below)
      lockedNow.length > 0 && h('span', { class: 'lockinfo', title: `已封鎖 ${lockedNow.map(fmt).join('、')} 籌碼，最小下注 ${fmt(minNow)}` }, `🔒 牌堆已用 ${g.deckUsedPercent}%`)),
    mine);
  if (m && m.autoMode) return h('div', { class: 'panel' }, head, h('div', { class: 'muted' }, '代打中：電腦會自動代你下注與決策。關閉開關即可收回操作。'));
  if (!g.canAct) return h('div', { class: 'panel' }, head, h('div', { class: 'muted' }, `等待 ${nameOf(g.currentUid)} 操作…`));
  const ready = now() >= g.turnStartAt;
  if (g.currentBet == null) {
    const t = total();
    const min = g.minChip || 50; // smallest chip still open (smaller ones are locked as the deck is used up)
    const locked = new Set(g.lockedChips || []);
    const ok = t === m.chips ? t > 0 : t >= min && t <= m.chips && t % min === 0; // All-in is always allowed
    const allIn = () => {
      let r = m.chips; counts = EMPTY_COUNTS();
      for (const v of [1000, 500, 100, 50]) { counts[v] = Math.floor(r / v); r -= counts[v] * v; }
      render();
    };
    return h('div', { class: 'panel' }, head,
      h('div', { class: 'steppers' }, CHIPS.map((v) =>
        h('div', { class: 'stepper' + (locked.has(v) ? ' locked' : '') },
          h('button', { class: 'step', 'aria-label': `減少 ${v}`, disabled: !ready || counts[v] === 0, onclick: () => { counts[v]--; render(); } }, '−'),
          h('div', { class: `chip c${v}${locked.has(v) ? ' locked' : ''}`, title: locked.has(v) ? '此籌碼已封鎖' : '' }, fmt(v),
            locked.has(v) && h('span', { class: 'lock', 'aria-label': '已封鎖' }, '🔒'),
            counts[v] > 0 && h('span', { class: 'cnt' }, '×' + counts[v])),
          h('button', { class: 'step', 'aria-label': `增加 ${v}`, disabled: !ready || locked.has(v) || t + v > m.chips, onclick: () => { counts[v]++; render(); } }, '+')))),
      h('div', { class: 'betline' }, h('span', {}, '下注 ', h('b', {}, fmt(t))), h('span', {}, '剩餘 ', h('b', {}, fmt(m.chips - t))), h('span', { class: 'muted' }, '最低 ' + fmt(Math.min(min, m.chips)) + (m.chips < min ? '（只能 All-in）' : ''))),
      h('div', { class: 'btnrow three' },
        h('button', { disabled: !ready, onclick: () => { counts = EMPTY_COUNTS(); render(); } }, '清空'),
        h('button', { disabled: !ready, onclick: allIn }, 'All-in'),
        h('button', { class: 'primary', disabled: !ready || !ok, onclick: () => send({ t: 'bet', turnId: g.turnId, amount: total(), actionId: uuid() }) }, '確認下注')));
  }
  const mustShoot = m.lastAction === 'PASS';
  return h('div', { class: 'panel' }, head,
    h('div', { class: 'betline' }, h('span', {}, '已下注 ', h('b', {}, fmt(g.currentBet)))),
    h('div', { class: 'btnrow' },
      h('button', { class: 'danger', onclick: () => send({ t: 'decide', turnId: g.turnId, action: 'SHOOT', actionId: uuid() }) }, '🎯 射龍門'),
      h('button', { disabled: mustShoot, onclick: () => send({ t: 'decide', turnId: g.turnId, action: 'PASS', actionId: uuid() }) }, 'PASS')),
    mustShoot && h('div', { class: 'muted' }, '上一回合已 PASS，本回合必須射龍門'));
}

// ---- stage: gate pillars + shot animation ----------------------------------
function setGate(cards, deal) {
  if (!G.pillarL) return;
  const [lo, hi] = cards.slice().sort((a, b) => a.rank - b.rank);
  const key = [lo, hi].map((c) => c.suit + c.rank).join('|');
  if (key === G.gateKey) return;
  G.gateKey = key;
  G.pillarL.classList.remove('knocked');
  G.pillarR.classList.remove('knocked');
  G.pillarL.replaceChildren(cardEl(lo));
  G.pillarR.replaceChildren(cardEl(hi));
  fill(G.note, gateNote(lo.rank, hi.rank));
  if (deal) {
    G.pillars.classList.remove('deal');
    void G.pillars.offsetWidth; // restart the deal-in animation
    G.pillars.classList.add('deal');
  }
}

/** The corner notice for the two special gates: a narrow gate (one rank between the posts) and consecutive posts. */
function gateNote(lo, hi) {
  const span = hi - lo;
  if (span === 1) {
    return h('div', { class: 'gatenote consec', role: 'status', title: '連號門柱：兩根門柱之間沒有球門，只會射出或撞柱，不可能射中' }, '⚠ 連號門柱：不可能射中');
  }
  if (span === 2) {
    return h('div', { class: 'gatenote narrow', role: 'status', title: '窄門：他人射中時莊家要加賠獎池一半；莊家自己射中則向其他玩家收取獎池一半' }, `🎯 窄門：只有 ${rankLabel(lo + 1)} 能射中`);
  }
  return false;
}

function showBanner(text, cls) {
  if (!G.banner) return;
  G.banner.className = 'banner ' + cls;
  G.banner.textContent = text;
  // re-trigger pop animation
  void G.banner.offsetWidth;
}
function hideBanner() {
  if (!G.banner) return;
  G.banner.className = 'banner off'; // invisible, but the row stays
  G.banner.textContent = '\u00a0';
}

function flashBanner(rec) {
  if (!G.banner) return;
  showBanner(resultText(rec), rec.result);
  setTimeout(() => !busy && hideBanner(), 1000);
}

async function runQueue() {
  busy = true;
  const guard = setTimeout(() => { holding = false; animPot = null; animChips.clear(); commit(); }, 12000); // never freeze the UI
  try {
    while (queue.length) {
      const rec = queue.shift();
      try { await playShot(rec); } catch (e) { console.error(e); }
    }
  } finally {
    clearTimeout(guard);
    animPot = null;
    animChips.clear();
    busy = false;
    holding = false;
    commit();
  }
}

const center = (r) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });

async function playShot(rec) {
  if (!G.stage || !G.pillarL) return; // not on the game screen
  setGate(rec.gate, false);
  // a computer's bet-and-shoot is one step on the server: announce the All-in first, then play the shot
  if (rec.isAllIn && !allInShown.has(rec.turnId)) {
    announceAllIn(rec.turnId, rec.uid, rec.bet);
    await sleep(2100);
  }
  // Make the stake visible first: pot right after this bet, plus who bet how much.
  animPot = rec.potAfterBet != null ? rec.potAfterBet : null;
  refreshPot();
  if (rec.chipsAfterBet != null) showChips(rec.uid, rec.chipsAfterBet);
  showBanner(`${nameOf(rec.uid)}${rec.isAuto ? '（電腦代打）' : ''} 下注 ${fmt(rec.bet)}${rec.isAllIn ? '（All-in）' : ''}，射龍門！`, 'PASS');
  const fly = h('div', { class: 'card fly back' });
  G.shotrow.append(fly);
  G.shotrow.classList.add('active');
  await sleep(60);
  fly.classList.add('in');
  await sleep(350);
  // 2D flip: shrink to nothing, swap face, grow back (no 3D transforms).
  fly.style.transform = 'scaleX(0)';
  await sleep(230);
  const face = cardEl(rec.thirdCard);
  fly.className = 'card fly in ' + (face.classList.contains('red') ? 'red' : '');
  fly.replaceChildren(...face.childNodes);
  fly.style.transform = 'scaleX(1)';
  await sleep(950); // let everyone read the card

  const [lo, hi] = rec.gate.slice().sort((a, b) => a.rank - b.rank);
  const c = rec.thirdCard.rank;
  const fr = fly.getBoundingClientRect();
  const fc = center(fr);
  const pl = G.pillarL.getBoundingClientRect();
  const pr = G.pillarR.getBoundingClientRect();
  const gp = G.gap.getBoundingClientRect();
  fly.style.transition = 'transform .85s cubic-bezier(.4,0,.7,.3), opacity .85s ease-in';
  let tx = 0, ty = 0, rot = 0, scale = 1;
  let knock = null;
  if (rec.result === 'HIT') { // into the gap
    const t = center(gp); tx = t.x - fc.x; ty = t.y - fc.y; scale = 0.45;
  } else if (rec.result === 'MISS') { // out past the left/right pillar
    if (c < lo.rank) { tx = pl.left - fr.width * 1.4 - fc.x; rot = -28; } else { tx = pr.right + fr.width * 1.4 - fc.x; rot = 28; }
    ty = -fr.height * 0.15;
  } else { // collision: ram the pillar with the same rank
    const left = c === lo.rank;
    const t = center(left ? pl : pr);
    tx = t.x - fc.x; ty = t.y - fc.y + fr.height * 0.55; knock = left ? G.pillarL : G.pillarR;
  }
  showBanner(resultText(rec), rec.result);
  animPot = rec.potSettled != null ? rec.potSettled : null; // pot as settled by the shot (e.g. doubled by a collision)
  refreshPot();
  // the narrow-gate bonus is shown as its own step below, so hold it back here
  if (rec.chipsSettled != null) showChips(rec.uid, rec.chipsSettled - (rec.dealerBonus || 0) - (rec.dealerLoot || 0));
  fly.style.transform = `translate(${tx}px, ${ty}px) rotate(${rot}deg) scale(${scale})`;
  if (knock) {
    await sleep(620);
    knock.classList.add('knocked');
    fly.style.opacity = '0';
    await sleep(600);
  } else {
    fly.style.opacity = '0';
    await sleep(900);
  }
  fly.remove();
  G.shotrow.classList.remove('active');
  await sleep(450);

  if (rec.dealerBonus > 0) { // 窄門: the dealer pays the shooter half the pot on top
    showBanner(`窄門！莊家 ${nameOf(rec.dealerUid)} 另付 ${fmt(rec.dealerBonus)} 給 ${nameOf(rec.uid)}`, 'COLLISION');
    showChips(rec.uid, rec.chipsSettled);
    showChips(rec.dealerUid, rec.dealerChipsSettled);
    await sleep(1700);
  }
  if (rec.dealerLoot > 0) { // 窄門 hit by the dealer: every other player hands over an equal share of half the pot
    showBanner(`莊家搜括！窄門射中，向其他 ${rec.lootFrom.length} 位玩家各收 ${fmt(rec.lootShare)}，共 ${fmt(rec.dealerLoot)}`, 'HIT');
    for (const l of rec.lootFrom) {
      const pl = shown && shown.players.find((p) => p.uid === l.uid);
      if (pl) showChips(l.uid, chipsOf(pl) - l.paid);
    }
    showChips(rec.uid, rec.chipsSettled);
    await sleep(2000);
  }
  if (rec.roundEnded && rec.result !== 'HIT' && rec.nextDealerUid) { // collision / exhausted deck: pot is kept
    showBanner(`獎池 ${fmt(rec.potAfter)} 留到下一局，莊家輪到 ${nameOf(rec.nextDealerUid)}，由 ${nameOf(rec.nextDealerUid)} 先開局`, 'COLLISION');
    await sleep(2000);
  }

  if (rec.roundEnded && latest && latest.game && latest.status === 'PLAYING') {
    showBanner('收牌・洗牌・重設龍門…', 'PASS');
    G.pillars.classList.add('collect');
    await sleep(850);
    G.pillars.classList.remove('collect');
    setGate(latest.game.gate, true);
    await sleep(700);
  }
  animPot = rec.potAfter != null ? rec.potAfter : null; // hold the final value until the panels commit
  refreshPot();
  hideBanner();
}

// ---- timer -----------------------------------------------------------------
function tick() {
  const t = document.getElementById('timer');
  if (!t || !shown || !shown.game) return;
  const g = shown.game;
  const n = now();
  if (g.deadline == null) t.textContent = '🤖 電腦思考中…';
  else if (n < g.turnStartAt) t.textContent = '準備中…';
  else {
    const sec = Math.max(0, Math.ceil((g.deadline - n) / 1000));
    t.textContent = sec + ' 秒';
    t.classList.toggle('low', sec <= 5);
  }
}
let readyTurn = null;
setInterval(() => {
  if (view === 'lobby') tickLobby();
  if (!shown || shown.status !== 'PLAYING' || view !== 'game') return;
  const g = shown.game;
  // Controls unlock once the pause after the previous turn is over: re-render once.
  if (g.canAct && now() >= g.turnStartAt && readyTurn !== g.turnId) { readyTurn = g.turnId; render(); return; }
  tick();
}, 250);

render();
connect();
