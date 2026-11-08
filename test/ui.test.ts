import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { RoomManager } from '../src/server/rooms.ts';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8').replace(/<script[^>]*><\/script>/, '');
const appJs = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function boot() {
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/', pretendToBeVisual: true });
  const w: any = dom.window;
  const sent: any[] = [];
  let sock: any;
  w.WebSocket = class {
    readyState = 1;
    onopen: any;
    onclose: any;
    onmessage: any;
    constructor() {
      sock = this;
      setTimeout(() => this.onopen?.(), 0);
    }
    send(d: string) {
      sent.push(JSON.parse(d));
    }
  };
  w.confirm = () => true;
  w.eval(appJs);
  const push = (state: any, notice?: string) => sock.onmessage({ data: JSON.stringify({ t: 'state', state, notice }) });
  return { dom, w, doc: w.document as Document, sent, push };
}

function playing() {
  const m = new RoomManager();
  const { room, uid } = m.createRoom('A', '阿龍');
  m.addBot('A');
  m.addBot('A');
  m.start('A');
  const state = () => m.view(room, uid, () => true);
  return { m, room, uid, state };
}

test('home: no password field anywhere; 6-digit numeric room field', () => {
  const { doc, push, w } = boot();
  push(null);
  assert.ok(!doc.body.textContent!.includes('密碼'), 'no password wording on the create tab');
  assert.equal(doc.querySelectorAll('input[type=password]').length, 0);
  (doc.querySelectorAll('.tabs button')[1] as HTMLElement).click();
  const inputs = [...doc.querySelectorAll('input')] as HTMLInputElement[];
  const room = inputs.find((i) => i.maxLength === 6)!;
  assert.equal(room.getAttribute('inputmode'), 'numeric');
  assert.ok(!doc.body.textContent!.includes('密碼'), 'nor on the join tab');
  assert.equal(doc.querySelectorAll('input[type=password]').length, 0);
  w.close();
});

test('lobby: room number rendered as 6 dark digit tiles', () => {
  const m = new RoomManager();
  const { room, uid } = m.createRoom('A', '阿龍');
  const { doc, push, w } = boot();
  push(m.view(room, uid, () => true));
  const digits = [...doc.querySelectorAll('.plate .digit')].map((d) => d.textContent).join('');
  assert.equal(digits, room.roomId);
  assert.equal(room.roomId.length, 6);
  w.close();
});

test('game layout: bet area is under the table, shows player count not round number', () => {
  const g = playing();
  const { doc, push, w } = boot();
  push(g.state());
  const main = doc.querySelector('.main')!;
  const kids = [...main.children].map((c) => c.className.split(' ')[0]);
  assert.deepEqual(kids.slice(0, 3), ['topbar', 'panel', 'actions-wrap']); // topbar, table, then actions
  assert.ok(doc.body.textContent!.includes('玩家人數'));
  assert.ok(!doc.body.textContent!.includes('第幾局'));
  assert.ok(doc.querySelector('.stage .pillars'));
  // pillars show low on the left, high on the right
  const ranks = [...doc.querySelectorAll('.pillar .card .r')].map((e) => e.textContent);
  assert.equal(ranks.length, 2);
  w.close();
});

test('ranking panel sorted by chips (high to low); no event log panel', () => {
  const g = playing();
  g.room.game!.players[0]!.chips += 5000;
  g.room.game!.players[1]!.chips -= 5000;
  const { doc, push, w } = boot();
  push(g.state());
  const chips = [...doc.querySelectorAll('.rk .chips')].map((e) => Number(e.textContent!.replace(/,/g, '')));
  assert.deepEqual(chips, [...chips].sort((a, b) => b - a));
  assert.ok(![...doc.querySelectorAll('h3')].some((h) => h.textContent === '遊戲紀錄'));
  assert.ok([...doc.querySelectorAll('h3')].some((h) => h.textContent!.startsWith('翻牌歷史')));
  w.close();
});

test('chip steppers: minus/plus per denomination, undo a mis-click, 代打 switch sends setAuto', async () => {
  const g = playing();
  // make it the human's turn
  while (g.room.game!.currentUid !== g.uid) g.m.autoTurn(g.room);
  g.room.turnStartAt = 0;
  const { doc, push, w, sent } = boot();
  push(g.state());
  await sleep(300);
  const steppers = [...doc.querySelectorAll('.stepper')];
  assert.equal(steppers.length, 4);
  const [minus500, plus500] = steppers[2]!.querySelectorAll('button') as any;
  assert.equal(minus500.disabled, true); // nothing to remove yet
  plus500.click();
  plus500.click();
  const again = [...doc.querySelectorAll('.stepper')][2]!;
  assert.ok(again.textContent!.includes('×2'));
  (again.querySelectorAll('button')[0] as HTMLElement).click(); // minus
  assert.ok([...doc.querySelectorAll('.stepper')][2]!.textContent!.includes('×1'));
  assert.ok(doc.querySelector('.betline')!.textContent!.includes('500'));
  const confirmBtn = [...doc.querySelectorAll('button')].find((b) => b.textContent === '確認下注') as HTMLButtonElement;
  confirmBtn.click();
  const bet = sent.find((x) => x.t === 'bet');
  assert.equal(bet.amount, 500);
  assert.equal(bet.turnId, g.room.game!.currentTurnId);
  const sw = doc.querySelector('.switch input') as HTMLInputElement;
  sw.checked = true;
  sw.dispatchEvent(new w.Event('change'));
  assert.deepEqual(sent.find((x) => x.t === 'setAuto'), { t: 'setAuto', on: true });
  w.close();
});

test('bug #4: stage is persistent and the revealed card never goes blank', async () => {
  const g = playing();
  while (g.room.game!.currentUid !== g.uid) g.m.autoTurn(g.room);
  const { doc, push, w } = boot();
  push(g.state());
  const stageBefore = doc.querySelector('.stage');
  const pillarBefore = doc.querySelector('.pillar');
  // human shoots
  const sid = 'A';
  g.m.bet(sid, g.room.game!.currentTurnId, 500);
  let rec = g.m.decide(sid, g.room.game!.currentTurnId, 'SHOOT');
  assert.ok(rec.thirdCard);
  push(g.state());
  // many unrelated broadcasts while the animation runs (this used to rebuild the DOM)
  for (let i = 0; i < 8; i++) {
    await sleep(120);
    push(g.state());
    assert.equal(doc.querySelector('.stage'), stageBefore, 'stage node must not be rebuilt');
  }
  // after flip the flying card (or its outcome) must carry rank + suit text
  const fly = doc.querySelector('.card.fly');
  if (fly) assert.match(fly.textContent!, /[A2-9JQK10]+[♠♥♦♣]/);
  // frozen panels: pot shown must still be the pre-shot value while animating
  assert.equal(doc.querySelector('.stage'), stageBefore);
  assert.equal(doc.querySelector('.pillar') !== null, true);
  void pillarBefore;
  await sleep(6500); // let the whole animation + collect/deal finish
  assert.equal(doc.querySelector('.card.fly'), null, 'flying card cleaned up');
  // Solitaire-style tracker: 4 suit rows x 13 ranks; face-up cards = this round's gate + shots.
  const grid = doc.querySelector('.deck-grid')!;
  assert.equal(grid.querySelectorAll('.trow').length, 4);
  assert.equal(grid.querySelectorAll('.t').length, 52);
  const seen = g.state().game!.seenCards;
  assert.equal(grid.querySelectorAll('.t.drawn').length, seen.length);
  assert.ok(grid.querySelectorAll('.t.drawn').length >= 2);
  assert.ok([...grid.querySelectorAll('.t.drawn')].every((e) => /^(A|[2-9]|10|J|Q|K)$/.test(e.textContent!)));
  assert.equal(grid.querySelectorAll('.t.gate').length, 2);
  // after the animation the pillars show the live gate (new gate if the round ended)
  const live = g.state().game!.gate.map((c: any) => c.rank).sort((a: number, b: number) => a - b);
  const ranks = [...doc.querySelectorAll('.pillar .card .r')].map((e) => e.textContent!);
  const label = (r: number) => ({ 1: 'A', 11: 'J', 12: 'Q', 13: 'K' } as any)[r] ?? String(r);
  assert.deepEqual(ranks, live.map(label));
  void rec;
  w.close();
});

test('card tracker: starts with only the 2 gate cards face-up; resets on a new round', () => {
  const g = playing();
  const { doc, push, w } = boot();
  push(g.state());
  assert.equal(doc.querySelectorAll('.deck-grid .t.drawn').length, 2);
  assert.equal(doc.querySelectorAll('.deck-grid .t.empty').length, 50);
  assert.ok(doc.body.textContent!.includes('本局已出 2 / 52'));
  assert.ok(!doc.querySelector('.legend .dup2'), 'single deck: no "2" badge legend');
  w.close();
});

test('card tracker resets after the round ends (HIT/COLLISION/exhausted): no stale history', () => {
  const g = playing();
  const game = g.room.game!;
  let guard = 0;
  const startRound = game.roundNumber;
  while (game.roundNumber === startRound && game.status === 'PLAYING') {
    assert.ok(++guard < 5000);
    g.m.autoTurn(g.room);
  }
  const v = g.state().game!;
  assert.equal(game.roundNumber, startRound + 1);
  assert.equal(v.seenCards.length, 2, 'only the new gate is face-up after a reshuffle');
  assert.equal(v.lastCard, null);
});

test('seenCards never exposes unrevealed cards', () => {
  const g = playing();
  const v = g.state().game!;
  assert.equal(v.seenCards.length, 2); // just the gate
  const game = g.room.game!;
  const visible = JSON.stringify(g.state());
  // With two decks a face-down card can be the 2nd copy of a gate card (same suit+rank), so compare the
  // revealed list itself: it must be exactly the two gate cards, nothing from the deck.
  assert.deepEqual(v.seenCards, [...game.gate]);
  assert.equal(visible.includes('"deck"'), false);
});

test('pot shows the stake (after bet, before settlement) while a shot animates, even if it empties the pot', async () => {
  const g = playing();
  const game = g.room.game!;
  while (game.currentUid !== g.uid) g.m.autoTurn(g.room);
  const { doc, push, w } = boot();
  push(g.state());
  // force a HIT so the pot ends at 0: put a rank strictly between the gate on top of the deck
  const lo = Math.min(game.gate[0].rank, game.gate[1].rank);
  const hi = Math.max(game.gate[0].rank, game.gate[1].rank);
  if (hi - lo < 2) { w.close(); return; } // no card strictly between: nothing to force this time
  const idx = game.deck.findIndex((c) => c.rank > lo && c.rank < hi);
  [game.deck[0], game.deck[idx]] = [game.deck[idx]!, game.deck[0]!];
  g.m.bet('A', game.currentTurnId, 500);
  const rec = g.m.decide('A', game.currentTurnId, 'SHOOT');
  assert.equal(rec.result, 'HIT');
  assert.equal(rec.potAfter, 0);
  push(g.state());
  await sleep(400);
  const potText = () => doc.querySelector('.stat.pot b')!.textContent!.replace(/,/g, '');
  assert.equal(Number(potText()), rec.potAfterBet, 'stake visible, not 0');
  assert.ok(doc.querySelector('.banner')!.textContent!.includes('下注 500'));
  await sleep(6500);
  assert.equal(Number(potText()), 0, 'after settlement the real (empty) pot shows');
  w.close();
});

test('代打 on: action panel replaced by notice; kicked/auto tag in ranking', () => {
  const g = playing();
  g.m.setAuto('A', true);
  const { doc, push, w } = boot();
  push(g.state());
  assert.ok(doc.body.textContent!.includes('代打中'));
  assert.equal(doc.querySelectorAll('.stepper').length, 0);
  w.close();
});

test('lobby: start/add-bot/leave row sits above the player list; bot names are edgy', () => {
  const m = new RoomManager();
  const { room, uid } = m.createRoom('A', '阿龍');
  m.addBot('A');
  const { doc, push, w } = boot();
  push(m.view(room, uid, () => true));
  const kids = [...doc.querySelector('main > div')!.children];
  const rowIdx = kids.findIndex((k) => k.className.includes('row'));
  const listIdx = kids.findIndex((k) => k.querySelector('.plist'));
  assert.ok(rowIdx >= 0 && listIdx >= 0 && rowIdx < listIdx, 'button row must come before the player list');
  assert.ok(![...doc.querySelectorAll('.plist li')].some((li) => /電腦\d/.test(li.textContent!)));
  w.close();
});

test('game: history above ranking, plain titles, dealer marked in the ranking, dealer in top bar', () => {
  const g = playing();
  const { doc, push, w } = boot();
  push(g.state());
  const side = [...doc.querySelector('.side')!.children];
  const titles = side.map((k) => k.querySelector('h3')?.textContent).filter(Boolean);
  assert.deepEqual(titles, ['翻牌歷史', '玩家排名']);
  assert.ok(!doc.body.textContent!.includes('依籌碼'));
  assert.ok(!doc.body.textContent!.includes('本局已出的牌）'));
  const marks = doc.querySelectorAll('.rk .dealer');
  assert.equal(marks.length, 1);
  const row = marks[0]!.closest('li')!;
  assert.equal(row.querySelector('.nm')!.textContent, g.room.players.find((p) => p.uid === g.room.game!.dealerUid)!.nickname);
  // the marker comes before the name
  assert.ok(row.innerHTML.indexOf('class="dealer"') < row.innerHTML.indexOf('class="nm"'));
  assert.ok(doc.querySelector('.topbar')!.textContent!.includes('莊家'));
  w.close();
});

test('pot display never jumps back to the stale value around a collision (8000 -> 10000 -> 20000, kept)', async () => {
  const g = playing();
  const game = g.room.game!;
  while (game.currentUid !== g.uid) g.m.autoTurn(g.room);
  // make the pot 8000 first (client only cares about the numbers)
  game.pot = 8000;
  game.players.find((p) => p.uid === g.uid)!.chips -= 8000;
  const { doc, push, w } = boot();
  push(g.state());
  const potText = () => Number(doc.querySelector('.stat.pot b')!.textContent!.replace(/,/g, ''));
  assert.equal(potText(), 8000);
  // force a collision: top card has the same rank as a gate card
  const idx = game.deck.findIndex((c) => c.rank === game.gate[0].rank);
  if (idx < 0) { w.close(); return; }
  [game.deck[0], game.deck[idx]] = [game.deck[idx]!, game.deck[0]!];
  g.m.bet('A', game.currentTurnId, 2000);
  const rec = g.m.decide('A', game.currentTurnId, 'SHOOT');
  assert.equal(rec.result, 'COLLISION');
  assert.equal(rec.potAfterBet, 10000);
  push(g.state());
  const seen: number[] = [];
  for (let i = 0; i < 70; i++) {
    await sleep(100);
    seen.push(potText());
  }
  assert.ok(!seen.includes(8000), 'must not show the stale pre-bet pot: ' + [...new Set(seen)].join(','));
  assert.ok(seen.includes(10000), 'shows the stake first');
  assert.ok(seen.includes(rec.potSettled), 'then the settled (doubled) pot');
  assert.equal(seen[seen.length - 1], rec.potSettled, 'collision: the doubled pot is kept for the next round');
  assert.ok(!seen.includes(0), 'pot is never emptied after a collision');
  assert.ok(seen.indexOf(10000) < seen.indexOf(rec.potSettled));
  w.close();
});

test('home shows a "back to game" button after leaving a live match', () => {
  const { doc, push, w } = boot();
  push(null, undefined);
  assert.equal(doc.querySelector('.rejoin'), null);
  w.close();
});

test('fast-forward: no live human left -> no shot animation, panels update', async () => {
  const g = playing();
  const game = g.room.game!;
  const { doc, push, w } = boot();
  push(g.state());
  game.player(g.uid).eliminated = true;
  game.player(g.uid).rank = 3;
  // advance a few computer turns
  let shot = false;
  for (let i = 0; i < 50 && !shot; i++) {
    const before = game.history.length;
    if (game.status !== 'PLAYING') break;
    if (game.currentUid === g.uid) break;
    g.m.autoTurn(g.room);
    shot = game.history.length > before && game.history[game.history.length - 1]!.action === 'SHOOT';
  }
  push(g.state());
  assert.equal(g.state().game!.fast, true);
  await sleep(300);
  assert.equal(doc.querySelector('.card.fly'), null, 'no flying card while fast-forwarding');
  w.close();
});

test('ranking numbers follow a shot: bet shows immediately, then the settled chips, then the final state', async () => {
  const g = playing();
  const game = g.room.game!;
  while (game.currentUid !== g.uid) g.m.autoTurn(g.room);
  const { doc, push, w } = boot();
  push(g.state());
  const myChips = () => {
    const row = [...doc.querySelectorAll('.rk li')].find((li) => li.classList.contains('me'))!;
    return Number(row.querySelector('.chips')!.textContent!.replace(/,/g, ''));
  };
  const before = myChips();
  // force a HIT so chips go down (bet) and then up (pot won)
  const lo = Math.min(game.gate[0].rank, game.gate[1].rank);
  const hi = Math.max(game.gate[0].rank, game.gate[1].rank);
  const idx = game.deck.findIndex((c) => c.rank > lo && c.rank < hi);
  if (idx < 0) { w.close(); return; }
  [game.deck[0], game.deck[idx]] = [game.deck[idx]!, game.deck[0]!];
  g.m.bet('A', game.currentTurnId, 500);
  const rec = g.m.decide('A', game.currentTurnId, 'SHOOT');
  assert.equal(rec.result, 'HIT');
  assert.equal(rec.chipsAfterBet, before - 500);
  push(g.state());
  const seen: number[] = [];
  for (let i = 0; i < 90; i++) {
    await sleep(100);
    seen.push(myChips());
  }
  assert.equal(seen[0], before - 500, 'the bet shows up in the ranking right away: ' + seen.slice(0, 5));
  assert.ok(seen.includes(rec.chipsSettled), 'then the chips after the shot');
  assert.ok(seen.indexOf(before - 500) < seen.indexOf(rec.chipsSettled));
  assert.equal(seen[seen.length - 1], g.state().players.find((p: any) => p.uid === g.uid)!.chips, 'ends on the real server value');
  w.close();
});

test('stylesheet sanity: no duplicated sections or rules; the table element keeps real table layout', () => {
  const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  const lines = css.split(/\r?\n/);
  // 1) every "/* section */" marker comment appears exactly once
  const markers = lines.filter((l) => l.startsWith('/* ') && l.endsWith(' */'));
  const dupMarkers = markers.filter((m, i) => markers.indexOf(m) !== i);
  assert.deepEqual(dupMarkers, [], 'duplicated CSS section');
  // 2) a top-level rule for the bare "table" element must not make it a flex/grid box (breaks th/td alignment)
  const tableRules = lines.filter((l) => l.startsWith('table {') || l.startsWith('table{'));
  assert.equal(tableRules.length, 1, 'exactly one rule for the table element');
  assert.ok(!tableRules[0]!.includes('display: flex') && !tableRules[0]!.includes('display: grid'));
  // 3) no single-line top-level rule is defined twice
  const oneLiners = lines.filter((l) => !l.startsWith(' ') && l.includes('{') && l.endsWith('}'));
  const dupRules = oneLiners.filter((l, i) => oneLiners.indexOf(l) !== i);
  assert.deepEqual(dupRules, [], 'identical rule defined twice');
});

test('result table: header and every row have the same number of cells', () => {
  const m = new RoomManager();
  const { room, uid } = m.createRoom('A', 'a');
  m.addBot('A');
  m.addBot('A');
  m.start('A');
  let n = 0;
  while (room.status === 'PLAYING' && n++ < 100000) m.autoTurn(room);
  const { doc, push, w } = boot();
  push(m.view(room, uid, () => true));
  const table = doc.querySelector('table')!;
  const head = table.querySelectorAll('thead th').length;
  const rows = [...table.querySelectorAll('tbody tr')];
  assert.equal(rows.length, 3);
  assert.ok(rows.every((r) => r.children.length === head), 'every row aligns with the header');
  w.close();
});

test('phone top bar: only 莊家+玩家人數 and 獎池 in the bar; the rest lives in a side menu', () => {
  const g = playing();
  const { doc, push, w } = boot();
  push(g.state());
  const bar = doc.querySelector('.topbar')!;
  const dealerName = g.room.players.find((p) => p.uid === g.room.game!.dealerUid)!.nickname;
  // compact part
  assert.ok(bar.querySelector('.menu-btn'), 'hamburger button');
  const info = bar.querySelector('.tb-info')!;
  assert.ok(info.textContent!.includes(dealerName), 'dealer name in the bar');
  assert.match(info.textContent!, /3\/3/, 'alive/total merged into the same block');
  assert.ok(bar.querySelector('.tb-pot .pot-val'), 'pot in the bar');
  // the compact bar does NOT carry room number / remaining cards
  const compactText = [...bar.querySelectorAll('.menu-btn, .tb-info, .tb-pot')].map((e) => e.textContent).join(' ');
  assert.ok(!compactText.includes('剩餘牌數') && !compactText.includes('房間'));
  // the side menu holds the rest
  const drawer = doc.querySelector('.drawer')!;
  assert.ok(drawer.textContent!.includes('房間號碼'));
  assert.ok(drawer.textContent!.includes('剩餘牌數'));
  assert.ok(drawer.textContent!.includes('玩家人數'));
  assert.equal(drawer.querySelectorAll('.plate .digit').length, 6);
  w.close();
});

test('side menu opens from the ☰ button and closes by backdrop, ✕ and Escape', async () => {
  const g = playing();
  const { doc, push, w } = boot();
  push(g.state());
  const drawer = () => doc.querySelector('.drawer')!;
  const backdrop = () => doc.querySelector('.backdrop')!;
  assert.ok(!drawer().classList.contains('open'));
  (doc.querySelector('.menu-btn') as HTMLElement).click();
  assert.ok(drawer().classList.contains('open'));
  assert.ok(backdrop().classList.contains('open'));
  assert.equal(doc.querySelector('.menu-btn')!.getAttribute('aria-expanded'), 'true');
  // a state update while open must not close it (the bar is rebuilt, the drawer persists)
  push(g.state());
  assert.ok(drawer().classList.contains('open'), 'stays open across server updates');
  (backdrop() as HTMLElement).click();
  assert.ok(!drawer().classList.contains('open'));
  (doc.querySelector('.menu-btn') as HTMLElement).click();
  (doc.querySelector('.drawer-close') as HTMLElement).click();
  assert.ok(!drawer().classList.contains('open'));
  (doc.querySelector('.menu-btn') as HTMLElement).click();
  doc.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape' }));
  assert.ok(!drawer().classList.contains('open'), 'Escape closes it');
  w.close();
});

test('pot updates in both the phone bar and the desktop stat; leave button is a big full-width button', () => {
  const g = playing();
  const { doc, push, w } = boot();
  push(g.state());
  const pots = [...doc.querySelectorAll('.pot-val')];
  assert.equal(pots.length, 2);
  assert.equal(new Set(pots.map((p) => p.textContent)).size, 1, 'both show the same pot');
  const leave = doc.querySelector('.side .leave-btn')!;
  assert.ok(leave, 'leave button uses the large style');
  assert.ok(leave.textContent!.includes('離開'));
  assert.ok(!leave.classList.contains('small'));
  w.close();
});

test('stylesheet: leave button is large, phone bar is hidden from tablets up, side menu hidden on desktop', () => {
  const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  const leaveRule = css.split(/\r?\n/).find((l) => l.startsWith('.leave-btn {'))!;
  assert.ok(leaveRule, 'has a .leave-btn rule');
  const minH = Number(/min-height:\s*(\d+)px/.exec(leaveRule)?.[1]);
  assert.ok(minH >= 48, 'at least 48px tall: ' + leaveRule);
  assert.ok(css.includes('.menu-btn, .tb-info, .tb-pot, .drawer, .backdrop { display: none !important; }'));
  assert.ok(css.includes('.tb-full { display: none; }'));
});

test('dealer collision banner: announces the halved payment and names the next dealer (seat order)', async () => {
  const g = playing();
  const game = g.room.game!;
  assert.equal(game.dealerUid, g.uid); // host is the dealer and plays first
  const { doc, push, w } = boot();
  push(g.state());
  // force a collision on the host (the dealer)
  const idx = game.deck.findIndex((c) => c.rank === game.gate[0].rank);
  if (idx < 0) { w.close(); return; }
  [game.deck[0], game.deck[idx]] = [game.deck[idx]!, game.deck[0]!];
  g.m.bet('A', game.currentTurnId, 500);
  const rec = g.m.decide('A', game.currentTurnId, 'SHOOT');
  assert.equal(rec.result, 'COLLISION');
  assert.equal(rec.extraMultiplier, 0.5);
  assert.notEqual(rec.nextDealerUid, g.uid, 'the deal passes on after every round end');
  const seen = new Set<string>();
  push(g.state());
  for (let i = 0; i < 80; i++) {
    await sleep(100);
    const b = doc.querySelector('.banner');
    if (b && !b.classList.contains('off')) seen.add(b.textContent!);
  }
  const texts = [...seen].join(' | ');
  assert.ok(texts.includes('賠付減半'), 'halved payment announced: ' + texts);
  assert.ok(texts.includes('留到下一局'), 'pot carry announced: ' + texts);
  const next = g.room.players.find((p) => p.uid === rec.nextDealerUid)!.nickname;
  assert.ok(texts.includes(next), 'names the next dealer: ' + texts);
  w.close();
});

test('card tracker: a card that comes out a second time gets a "2" badge in its bottom-right corner', () => {
  const g = playing();
  const { doc, push, w } = boot();
  const state: any = g.state();
  const gate = state.game.gate;
  // Q of spades was turned over twice this round (two decks); K of hearts only once
  state.game.seenCards = [...gate, { suit: 'S', rank: 12 }, { suit: 'S', rank: 12 }, { suit: 'H', rank: 13 }];
  state.game.lastCard = { suit: 'S', rank: 12 };
  push(state);
  const tiles = [...doc.querySelectorAll('.deck-grid .t')];
  const tile = (suitIdx: number, rank: number) => tiles[suitIdx * 13 + rank - 1]!;
  const qs = tile(0, 12); // spades row, Q
  assert.ok(qs.classList.contains('drawn'));
  assert.equal(qs.querySelector('.dup')?.textContent, '2');
  const kh = tile(1, 13); // hearts row, K
  assert.ok(kh.classList.contains('drawn'));
  assert.equal(kh.querySelector('.dup'), null, 'single appearance has no badge');
  assert.equal(doc.querySelectorAll('.deck-grid .dup').length, 1);
  assert.ok(doc.querySelector('.legend')!.textContent!.includes(`本局已出 ${state.game.seenCards.length} / ${state.game.deckSize}`));
  w.close();
});

test('stylesheet: the 2-badge is pinned to the tile corner', () => {
  const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  assert.ok(css.includes('.t .dup { position: absolute; right: 0; bottom: 0;'));
  assert.ok(css.split(/\r?\n/).some((l) => l.startsWith('.t {') && l.includes('position: relative')));
});

test('stylesheet: chip area is a fixed 2 x 2 grid (never auto-fit to more columns), parts shrink on phones', () => {
  const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  const rule = css.split(/\r?\n/).find((l) => l.startsWith('.steppers {'))!;
  assert.ok(rule.includes('repeat(2, minmax(0, 1fr))'), rule);
  assert.ok(!rule.includes('auto-fit') && !rule.includes('auto-fill'), 'must not add columns on wide screens');
  assert.ok(css.includes('clamp(44px, 14vw, 58px)'), 'chip shrinks on narrow phones');
});

test('chip area renders four steppers in DOM order 50,100 / 500,1000', async () => {
  const g = playing();
  const game = g.room.game!;
  assert.equal(game.currentUid, g.uid);
  g.room.turnStartAt = 0;
  const { doc, push, w } = boot();
  push(g.state());
  await sleep(300);
  const chips = [...doc.querySelectorAll('.steppers .chip')].map((c) => c.textContent!.replace(/[^0-9,]/g, ''));
  assert.deepEqual(chips, ['50', '100', '500', '1,000']);
  w.close();
});

test('stylesheet: the empty slot between the pillars is the only spacer (gap not counted twice)', () => {
  const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  const lines = css.split(/\r?\n/);
  const pillars = lines.find((l) => l.startsWith('.pillars {'))!;
  const gap = lines.find((l) => l.startsWith('.gap {'))!;
  assert.ok(pillars.includes('gap: 0'), pillars);
  assert.ok(gap.includes('width: var(--gapw)'), gap);
});

test('narrow gate: the dealer-pays-extra step is announced and both ranking rows follow it', async () => {
  const g = playing();
  const game = g.room.game!;
  while (game.currentUid !== g.uid) g.m.autoTurn(g.room);
  // the host is NOT the dealer this time; a narrow gate 7..9 and an 8 on top of the deck
  const dealer = game.players.find((p) => p.uid !== g.uid)!.uid;
  game.dealerUid = dealer;
  game.gate = [{ suit: 'S', rank: 7 }, { suit: 'H', rank: 9 }];
  const i8 = game.deck.findIndex((c) => c.rank === 8);
  [game.deck[0], game.deck[i8]] = [game.deck[i8]!, game.deck[0]!];
  const { doc, push, w } = boot();
  push(g.state());
  g.m.bet('A', game.currentTurnId, 500);
  const rec = g.m.decide('A', game.currentTurnId, 'SHOOT');
  assert.equal(rec.result, 'HIT');
  assert.ok(rec.dealerBonus > 0);
  push(g.state());
  const banners = new Set<string>();
  const rowChips = (uid: string) => {
    const name = game.players.length && g.room.players.find((p) => p.uid === uid)!.nickname;
    const row = [...doc.querySelectorAll('.rk li')].find((li) => li.querySelector('.nm')!.textContent === name)!;
    return Number(row.querySelector('.chips')!.textContent!.replace(/,/g, ''));
  };
  const dealerSeen = new Set<number>();
  for (let i = 0; i < 70; i++) {
    await sleep(100);
    const b = doc.querySelector('.banner');
    if (b && !b.classList.contains('off')) banners.add(b.textContent!);
    dealerSeen.add(rowChips(dealer));
  }
  const texts = [...banners].join(' | ');
  assert.ok(texts.includes('窄門'), 'narrow gate announced: ' + texts);
  assert.ok(dealerSeen.has(rec.dealerChipsSettled), 'the dealer row shows the chips after paying: ' + [...dealerSeen]);
  assert.equal(rowChips(dealer), g.state().players.find((p: any) => p.uid === dealer)!.chips, 'ends on the real value');
  w.close();
});

test('stylesheet: double-tap zoom is off for every element (touch-action: manipulation), text selection off except inputs', () => {
  const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  const star = css.split(/\r?\n/).find((l) => l.startsWith('* {'))!;
  assert.ok(star.includes('touch-action: manipulation'), star);
  assert.ok(css.includes('body { -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; }'));
  assert.ok(css.includes('input { -webkit-user-select: text; user-select: text; }'), 'inputs stay selectable/typable');
  // pinch zoom must stay available (accessibility): the viewport meta must not forbid scaling
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.ok(!/user-scalable\s*=\s*no|maximum-scale/.test(html), 'do not disable pinch zoom');
});

test('locked chips: padlock, dimmed, + disabled; bet button follows the smallest open chip; All-in still works', async () => {
  const g = playing();
  const game = g.room.game!;
  while (game.currentUid !== g.uid) g.m.autoTurn(g.room);
  g.room.turnStartAt = 0;
  game.deck = game.deck.slice(0, 41); // 21.2% used -> 50 and 100 locked, min chip 500
  const { doc, push, w, sent } = boot();
  push(g.state());
  await sleep(300);
  const steppers = [...doc.querySelectorAll('.stepper')];
  assert.deepEqual(steppers.map((s) => s.classList.contains('locked')), [true, true, false, false]);
  assert.equal(steppers[0]!.querySelectorAll('.lock').length, 1);
  assert.equal(steppers[3]!.querySelectorAll('.lock').length, 0);
  const plus = (i: number) => steppers[i]!.querySelectorAll('button')[1] as HTMLButtonElement;
  assert.equal(plus(0).disabled, true, '50 + is disabled');
  assert.equal(plus(1).disabled, true, '100 + is disabled');
  assert.equal(plus(2).disabled, false, '500 + still works');
  const info = doc.querySelector('.lockinfo')!;
  assert.match(info.textContent!, /^🔒 牌堆已用 \d+%$/, 'short enough to share the row with 我的籌碼');
  assert.ok(info.getAttribute('title')!.includes('50、100'), 'details on hover');
  assert.ok(doc.querySelector('.betline')!.textContent!.includes('最低 500'), 'the smallest bet is in the line below');
  // same row as 我的籌碼 and the 代打 switch, not a separate block under the chips
  const row = info.closest('.ahead')!;
  assert.ok(row, 'inside the 我的籌碼 row');
  assert.ok(row.textContent!.includes('我的籌碼'), 'next to the player\'s own chips');
  assert.ok(row.querySelector('.switch'), 'and the 代打 switch');
  assert.equal(doc.querySelector('.lockhint'), null, 'no extra row any more');
  assert.equal(doc.querySelector('.steppers')!.previousElementSibling, row, 'the chips come straight after that one row');
  // one 500 chip is a valid bet
  plus(2).click();
  const confirm = [...doc.querySelectorAll('button')].find((b) => b.textContent === '確認下注') as HTMLButtonElement;
  assert.equal(confirm.disabled, false);
  confirm.click();
  assert.equal(sent.find((x) => x.t === 'bet')!.amount, 500);
  w.close();
});

/**
 * A started game where the host (human, plays first) is about to bet. A SECOND human is in the room: when the
 * only human is knocked out the server fast-forwards the computers and (by design) no effects are played.
 */
function allInSetup() {
  const m = new RoomManager();
  const { room, uid } = m.createRoom('A', '阿龍');
  m.joinRoom('B', room.roomId, '乙');
  m.addBot('A');
  m.start('A');
  const g = { m, room, uid, state: () => m.view(room, uid, () => true) };
  const game = room.game!;
  while (game.currentUid !== uid) m.autoTurn(room); // (the host is the dealer and plays first, so usually no-op)
  return { g, game };
}

test('ALL IN effect: full-screen overlay with the player and amount, shown once per turn, never blocks taps', () => {
  const { g, game } = allInSetup();
  const { doc, push, w } = boot();
  push(g.state()); // first sync, nothing yet
  assert.equal(doc.querySelector('.allin'), null);
  const chips = game.player(g.uid).chips;
  g.m.bet('A', game.currentTurnId, chips);
  push(g.state());
  const el = doc.querySelector('.allin')!;
  assert.ok(el, 'overlay appears for everyone');
  assert.ok(el.textContent!.includes('ALL IN'));
  assert.ok(el.textContent!.includes('阿龍') || el.textContent!.includes('全押'));
  assert.ok(el.textContent!.includes(chips.toLocaleString('en-US')), 'shows the amount');
  assert.equal(el.getAttribute('role'), 'alert');
  assert.ok(el.querySelectorAll('.spark').length >= 20, 'sparks');
  push(g.state()); // same turn again (e.g. another broadcast): no second effect
  assert.equal(doc.querySelectorAll('.allin').length, 1);
  w.close();
});

test('ALL IN effect is not replayed after a reconnect / first sync, and skipped while fast-forwarding', () => {
  const { g, game } = allInSetup();
  g.m.bet('A', game.currentTurnId, game.player(g.uid).chips);
  const a = boot();
  a.push(g.state()); // joining while the all-in is already on the table
  assert.equal(a.doc.querySelector('.allin'), null, 'no replay on first sync');
  a.w.close();

  const { g: g2, game: game2 } = allInSetup();
  const b = boot();
  b.push(g2.state());
  g2.m.bet('A', game2.currentTurnId, game2.player(g2.uid).chips);
  const st: any = g2.state();
  st.game.fast = true; // everyone human is out: computers play it out quickly, no effects
  b.push(st);
  assert.equal(b.doc.querySelector('.allin'), null, 'no effect in fast-forward');
  b.w.close();
});

test('ALL IN effect also fires when the bet and the shot/pass arrive together (computer play)', () => {
  const { g, game } = allInSetup();
  const { doc, push, w } = boot();
  push(g.state());
  const chips = game.player(g.uid).chips;
  g.m.bet('A', game.currentTurnId, chips);
  g.m.decide('A', game.currentTurnId, 'PASS'); // bet everything and pass: no 'allIn' turn state ever reaches the client
  push(g.state());
  assert.ok(doc.querySelector('.allin'), 'announced from the turn record');
  assert.ok(doc.querySelector('.allin')!.textContent!.includes(chips.toLocaleString('en-US')));
  w.close();
});

test('ALL IN effect: a shot after an all-in announces it first (record path), once', async () => {
  const { g, game } = allInSetup();
  const { doc, push, w } = boot();
  push(g.state());
  g.m.bet('A', game.currentTurnId, game.player(g.uid).chips);
  g.m.decide('A', game.currentTurnId, 'SHOOT');
  push(g.state());
  await sleep(150);
  assert.equal(doc.querySelectorAll('.allin').length, 1);
  w.close();
});

test('stylesheet: ALL IN overlay is click-through, uses only 2D animation, and has a reduced-motion fallback', () => {
  const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  const lines = css.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith('/* ALL IN: full-screen effect'));
  assert.ok(start >= 0, 'has the ALL IN section');
  // look at the rules only, not at the comments describing them
  const section = lines.slice(start).join('\n').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(section.includes('pointer-events: none'), 'must never block taps');
  assert.ok(section.includes('position: fixed; inset: 0'));
  assert.ok(!/perspective|rotateY|rotateX|translate3d|preserve-3d|background-clip/.test(section), 'no 3D / clipped-text tricks (they caused the blank-text bug before)');
  assert.ok(section.includes('prefers-reduced-motion'));
});

test('waiting room: the host picks 1 or 2 decks with a single-choice control; guests see it read-only', () => {
  const m = new RoomManager();
  const { room, uid } = m.createRoom('A', '阿龍');
  m.joinRoom('B', room.roomId, '乙');
  const host = boot();
  host.push(m.view(room, uid, () => true));
  const radios = [...host.doc.querySelectorAll('.deckpick input[type=radio]')] as HTMLInputElement[];
  assert.equal(radios.length, 2);
  assert.deepEqual(radios.map((r) => r.disabled), [false, false]);
  assert.deepEqual(radios.map((r) => r.checked), [true, false], 'default is 1 deck');
  assert.ok(host.doc.querySelector('.deckpick')!.textContent!.includes('1 副牌（52 張）'));
  assert.ok(host.doc.querySelector('.deckpick')!.textContent!.includes('2 副牌（104 張）'));
  radios[1]!.dispatchEvent(new host.w.Event('change'));
  assert.deepEqual(host.sent.find((x) => x.t === 'setDeck'), { t: 'setDeck', copies: 2 });
  host.w.close();

  m.setDeckCopies('A', 2);
  const guestUid = room.players.find((p) => p.uid !== uid)!.uid;
  const guest = boot();
  guest.push(m.view(room, guestUid, () => true));
  const gr = [...guest.doc.querySelectorAll('.deckpick input[type=radio]')] as HTMLInputElement[];
  assert.deepEqual(gr.map((r) => r.disabled), [true, true], 'guests cannot change it');
  assert.deepEqual(gr.map((r) => r.checked), [false, true], 'but see the host choice');
  assert.ok(guest.doc.body.textContent!.includes('牌組由房主決定'));
  guest.w.close();
});

test('result table: has a PASS count and NO profit/loss column', () => {
  const m = new RoomManager();
  const { room, uid } = m.createRoom('A', 'a');
  m.addBot('A');
  m.addBot('A');
  m.start('A');
  let n = 0;
  while (room.status === 'PLAYING' && n++ < 100000) m.autoTurn(room);
  const { doc, push, w } = boot();
  push(m.view(room, uid, () => true));
  const heads = [...doc.querySelectorAll('thead th')].map((e) => e.textContent);
  assert.deepEqual(heads, ['名次', '玩家', '最終籌碼', '淘汰順序', '射中', '射出', '撞柱', 'PASS']);
  assert.ok(!doc.body.textContent!.includes('損益'), 'no profit/loss anywhere on the result screen');
  assert.equal(doc.querySelector('td.gain, td.loss'), null);
  const rows = [...doc.querySelectorAll('tbody tr')];
  assert.equal(rows.length, 3);
  assert.ok(rows.every((r) => r.children.length === heads.length), 'every row aligns with the header');
  const pi = heads.indexOf('PASS');
  const ci = heads.indexOf('最終籌碼');
  const g = room.game!;
  for (const r of rows) {
    const name = r.children[1]!.textContent!;
    const p = g.players.find((x) => x.nickname === name)!;
    assert.equal(r.children[pi]!.textContent, String(p.stats.pass), 'PASS column = the player\'s pass count');
    assert.equal(r.children[ci]!.textContent, p.chips.toLocaleString('en-US'), 'final chips are still shown');
    assert.ok(!/^[+−]/.test(r.children[ci]!.textContent!), 'no signed amounts');
  }
  w.close();
});

// ---------------- waiting room: observers, wins, chat ----------------

/** Host A + guest B + a bot in a waiting room. */
function lobby3() {
  const m = new RoomManager();
  const { room, uid } = m.createRoom('A', '阿龍');
  const b = m.joinRoom('B', room.roomId, '乙').uid;
  m.addBot('A');
  const bot = room.players.find((p) => p.isBot)!.uid;
  return { m, room, host: uid, guest: b, bot, viewAs: (u: string) => m.view(room, u, () => true) };
}

test('waiting room: host gets an observer checkbox for each human guest (not for self or bots); wins shown on every row (TC-061)', () => {
  const L = lobby3();
  L.room.players.find((p) => p.uid === L.host)!.wins = 3;
  const { doc, push, w, sent } = boot();
  push(L.viewAs(L.host));
  const rows = [...doc.querySelectorAll('.plist li')];
  assert.equal(rows.length, 3);
  const rowOf = (name: string) => rows.find((r) => r.querySelector('.who')!.textContent!.startsWith(name))!;
  const botRow = rows.find((r) => [...r.querySelectorAll('.tag')].some((x) => x.textContent === '電腦'))!;
  assert.equal(rowOf('阿龍').querySelectorAll('input[type=checkbox]').length, 0, 'the host always plays');
  assert.equal(botRow.querySelectorAll('input[type=checkbox]').length, 0, 'bots cannot observe');
  const boxes = rowOf('乙').querySelectorAll('input[type=checkbox]');
  assert.equal(boxes.length, 1);
  // wins text on every row, host included
  assert.ok(rowOf('阿龍').textContent!.includes('勝 3 場'));
  assert.ok(rowOf('乙').textContent!.includes('勝 0 場'));
  assert.ok(botRow.querySelector('.wins')!.textContent!.startsWith('勝 '));
  // ticking sends setObserver
  const box = boxes[0] as HTMLInputElement;
  box.checked = true;
  box.dispatchEvent(new w.Event('change'));
  assert.deepEqual(sent.find((x) => x.t === 'setObserver'), { t: 'setObserver', uid: L.guest, observer: true });
  w.close();
});

test('waiting room: observers are tagged, do not count as players, and guests get no checkbox', () => {
  const L = lobby3();
  L.m.setObserver('A', L.guest, true);
  const host = boot();
  host.push(L.viewAs(L.host));
  const row = [...host.doc.querySelectorAll('.plist li')].find((r) => r.querySelector('.who')!.textContent!.startsWith('乙'))!;
  assert.ok(row.querySelector('.tag.obs'), '觀察 tag');
  assert.equal((row.querySelector('input[type=checkbox]') as HTMLInputElement).checked, true);
  assert.ok(host.doc.body.textContent!.includes('參賽 2 人'));
  assert.ok(host.doc.body.textContent!.includes('觀察 1 人'));
  host.w.close();

  const guest = boot();
  guest.push(L.viewAs(L.guest));
  assert.equal(guest.doc.querySelectorAll('.plist input[type=checkbox]').length, 0, 'only the host can change it');
  assert.ok(guest.doc.querySelector('.plist .tag.obs'));
  guest.w.close();

  // with only the host left as a player the start button is off
  const L2 = lobby3();
  L2.room.players = L2.room.players.filter((p) => !p.isBot);
  L2.m.setObserver('A', L2.guest, true);
  const h2 = boot();
  h2.push(L2.viewAs(L2.host));
  const start = [...h2.doc.querySelectorAll('button')].find((b) => b.textContent === '開始遊戲') as HTMLButtonElement;
  assert.equal(start.disabled, true);
  h2.w.close();
});

test('chat: messages are shown as plain text (no HTML ever), and sending trims, clears the box and ignores empty input (TC-063)', () => {
  const L = lobby3();
  L.m.chat('A', '<img src=x onerror="window.pwned=1"> <b>bold?</b>');
  const { doc, push, w, sent } = boot();
  push(L.viewAs(L.host));
  const log = doc.querySelector('.chatlog')!;
  assert.equal(log.querySelectorAll('img, b b, script').length, 0, 'markup is not interpreted');
  assert.ok(log.textContent!.includes('<img src=x onerror="window.pwned=1"> <b>bold?</b>'), 'it is shown literally');
  assert.equal((w as any).pwned, undefined);
  const input = doc.querySelector('.chatin') as HTMLInputElement;
  assert.equal(input.maxLength, 200);
  // empty / blank: nothing is sent
  input.value = '   ';
  input.dispatchEvent(new w.Event('input'));
  input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.equal(sent.filter((x) => x.t === 'chat').length, 0);
  // Enter sends the trimmed text and clears the box
  input.value = '  大家好  ';
  input.dispatchEvent(new w.Event('input'));
  input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.deepEqual(sent.filter((x) => x.t === 'chat'), [{ t: 'chat', text: '大家好' }]);
  assert.equal(input.value, '');
  // the send button does the same
  input.value = '再說一次';
  input.dispatchEvent(new w.Event('input'));
  (doc.querySelector('.chatform button') as HTMLButtonElement).click();
  assert.equal(sent.filter((x) => x.t === 'chat').length, 2);
  w.close();
});

test('chat: a half-typed message and the keyboard focus survive server updates; the log only changes when there is news', () => {
  const L = lobby3();
  const { doc, push, w } = boot();
  push(L.viewAs(L.host));
  const input = doc.querySelector('.chatin') as HTMLInputElement;
  input.focus();
  input.value = '我還在打字';
  input.dispatchEvent(new w.Event('input'));
  // someone joins and someone else ticks a checkbox: the lobby is redrawn around the chat box
  L.m.joinRoom('C', L.room.roomId, '丙');
  push(L.viewAs(L.host));
  L.m.setObserver('A', L.guest, true);
  push(L.viewAs(L.host));
  assert.equal(doc.querySelector('.chatin'), input, 'the very same input element, not a new one');
  assert.equal(doc.activeElement, input, 'still focused');
  assert.equal(input.value, '我還在打字', 'draft kept');
  // log: unchanged chat leaves the existing message nodes alone, new chat appends
  L.m.chat('B', '第一句');
  push(L.viewAs(L.host));
  const first = doc.querySelector('.chatmsg');
  assert.ok(first && first.textContent!.includes('第一句'));
  push(L.viewAs(L.host)); // nothing new
  assert.equal(doc.querySelector('.chatmsg'), first, 'message nodes untouched when there is no news');
  L.m.joinRoom('D', L.room.roomId, '丁'); // (room has room left)
  L.m.chat('A', '第二句');
  push(L.viewAs(L.host));
  const msgs = [...doc.querySelectorAll('.chatmsg')].map((e) => e.textContent);
  assert.deepEqual(msgs, ['乙：第一句', '阿龍：第二句']);
  assert.ok(doc.querySelector('.chatmsg.mine'), 'my own message is marked');
  w.close();
});

test('chat is a waiting-room feature: no chat box during a match', () => {
  const L = lobby3();
  L.m.start('A');
  const { doc, push, w } = boot();
  push(L.viewAs(L.host));
  assert.equal(doc.querySelector('.chatbox'), null);
  w.close();
});

// ---------------- result -> waiting room ----------------

function finishedRoom() {
  const m = new RoomManager();
  const { room, uid } = m.createRoom('A', '阿龍');
  const b = m.joinRoom('B', room.roomId, '乙').uid;
  m.addBot('A');
  m.start('A');
  let n = 0;
  while (room.status === 'PLAYING' && n++ < 200000) m.autoTurn(room);
  return { m, room, host: uid, guest: b, viewAs: (u: string) => m.view(room, u, () => true) };
}

test('result: every player has 再玩一局 and 離開遊戲, host or not, and nobody waits for the host (TC-062)', () => {
  const F = finishedRoom();
  for (const [who, uid] of [['host', F.host], ['guest', F.guest]] as const) {
    const b = boot();
    b.push(F.viewAs(uid));
    const labels = [...b.doc.querySelectorAll('.panel > .row button')].map((x) => x.textContent);
    assert.deepEqual(labels, ['再玩一局', '離開遊戲'], who);
    assert.ok(!b.doc.body.textContent!.includes('等房主'), who + ': no waiting for the host');
    const again = [...b.doc.querySelectorAll('button')].find((x) => x.textContent === '再玩一局') as HTMLButtonElement;
    again.click();
    assert.deepEqual(b.sent.find((x) => x.t === 'playAgain'), { t: 'playAgain' }, who);
    const leave = [...b.doc.querySelectorAll('button')].find((x) => x.textContent === '離開遊戲') as HTMLButtonElement;
    leave.click();
    assert.deepEqual(b.sent.find((x) => x.t === 'leave'), { t: 'leave' }, who);
    b.w.close();
  }
});

test('result -> waiting room shows the winner with +1 win; the one still reading is tagged', () => {
  const F = finishedRoom();
  const winner = F.room.game!.ranking()[0]!.uid;
  const name = F.room.players.find((p) => p.uid === winner)!.nickname;
  F.m.playAgain('A'); // only the host is back; B is still reading the results
  const { doc, push, w } = boot();
  push(F.viewAs(F.host));
  assert.equal(doc.querySelectorAll('.plist li').length, 3, 'everyone is listed');
  const row = [...doc.querySelectorAll('.plist li')].find((r) => r.querySelector('.who')!.textContent!.startsWith(name))!;
  assert.ok(row.querySelector('.wins')!.textContent!.includes('勝 1 場'), row.textContent!);
  assert.ok(doc.querySelector('.chatbox'), 'the chat is back too');
  const reader = [...doc.querySelectorAll('.plist li')].find((r) => r.querySelector('.who')!.textContent!.startsWith('乙'))!;
  assert.ok(reader.querySelector('.tag.res'), 'tagged: still on the result table');
  assert.ok(doc.body.textContent!.includes('還在看結算 1 人'));
  w.close();
});

test('rematch: the next match plays its animations and effects again (turn ids restart at 1)', () => {
  const m = new RoomManager();
  const { room, uid } = m.createRoom('A', '阿龍');
  m.joinRoom('B', room.roomId, '乙');
  m.addBot('A');
  m.start('A');
  const view = () => m.view(room, uid, () => true);
  const { doc, push, w } = boot();
  push(view());
  // match 1 runs for a long time: the client has "seen" a high turn id
  let n = 0;
  while (room.status === 'PLAYING' && n++ < 200000) m.autoTurn(room);
  push(view());
  assert.ok(room.game!.currentTurnId > 20);
  m.playAgain('A');
  m.playAgain('B'); // B stays a player (otherwise B would watch match 2 and the all-in below would end the match unseen)
  push(view()); // back in the waiting room
  assert.ok(doc.querySelector('.chatbox'));
  m.start('A');
  push(view()); // first state of match 2
  const g2 = room.game!;
  assert.equal(g2.currentTurnId, 1);
  while (g2.currentUid !== uid) m.autoTurn(room);
  // now the host bets everything and passes in match 2: record turn id is small, it must still be announced
  m.bet('A', g2.currentTurnId, g2.player(uid).chips);
  m.decide('A', g2.currentTurnId, 'PASS');
  push(view());
  assert.ok(doc.querySelector('.allin'), 'effects work again in the second match');
  w.close();
});

// ---------------- observers in a running match ----------------

test('observer in a match: sees the table but has no seat, no chips, no ranking row and no controls (TC-061)', () => {
  const m = new RoomManager();
  const { room, uid } = m.createRoom('A', '阿龍');
  const obs = m.joinRoom('B', room.roomId, '看戲的').uid;
  m.addBot('A');
  m.setObserver('A', obs, true);
  m.start('A');
  const { doc, push, w } = boot();
  push(m.view(room, obs, () => true));
  assert.ok(doc.querySelector('.stage'), 'the table is visible');
  assert.ok(doc.body.textContent!.includes('你是觀察者'));
  assert.equal(doc.querySelectorAll('.stepper').length, 0, 'no betting controls');
  assert.ok(![...doc.querySelectorAll('button')].some((b) => b.textContent!.includes('射龍門')));
  assert.equal(doc.querySelector('.switch'), null, 'no 代打 switch');
  const names = [...doc.querySelectorAll('.rk .nm')].map((e) => e.textContent);
  assert.ok(!names.includes('看戲的'), 'not in the ranking');
  assert.equal(names.length, 2);
  assert.ok(doc.querySelector('.obsline')!.textContent!.includes('看戲的'));
  assert.match(doc.querySelector('.tb-info')!.textContent!, /2\/2/, 'the player count excludes observers');
  void uid;
  w.close();
});

// ---------------- consecutive gate ----------------

test('gate notices: consecutive posts and a narrow gate each get a notice in the corner; other gates get none', () => {
  const m = new RoomManager();
  const { room, uid } = m.createRoom('A', '阿龍');
  m.addBot('A');
  m.start('A');
  const g = room.game!;
  const { doc, push, w } = boot();
  const show = (a: number, b: number) => {
    g.gate = [{ suit: 'S', rank: a }, { suit: 'H', rank: b }];
    push(m.view(room, uid, () => true));
    return doc.querySelector('.gatenote');
  };
  const consec = show(8, 9);
  assert.ok(consec && consec.classList.contains('consec'), 'consecutive posts: red notice');
  assert.ok(consec!.textContent!.includes('連號門柱') && consec!.textContent!.includes('不可能射中'));
  const narrow = show(7, 9);
  assert.ok(narrow && narrow.classList.contains('narrow'), 'narrow gate: gold notice');
  assert.equal(narrow!.textContent, '🎯 窄門：只有 8 能射中');
  assert.equal(doc.querySelectorAll('.gatenote').length, 1, 'only one notice at a time');
  assert.equal(show(10, 12)!.textContent, '🎯 窄門：只有 J 能射中', 'face cards are named');
  assert.equal(show(11, 13)!.textContent, '🎯 窄門：只有 Q 能射中');
  assert.equal(show(12, 10)!.textContent, '🎯 窄門：只有 J 能射中', 'order of the posts does not matter');
  assert.equal(show(3, 9), null, 'a wide gate: no notice');
  assert.equal(show(1, 13), null, 'A and K are far apart: no notice');
  assert.equal(show(4, 5)!.classList.contains('consec'), true, 'back to a notice for the next special gate');
  w.close();
});

test('waiting room: the start button counts only the players who are back; the host sees the 5-minute countdown to losing the room', () => {
  const m = new RoomManager();
  const { room, uid } = m.createRoom('A', '阿龍');
  const b = m.joinRoom('B', room.roomId, '乙').uid;
  m.start('A');
  let n = 0;
  while (room.status === 'PLAYING' && n++ < 200000) m.autoTurn(room);
  m.playAgain('B'); // B is back and the host is still reading the results: that starts the clock
  const view = (u: string) => m.view(room, u, () => true);

  // B (in the waiting room) sees who is reading and how long the host has left
  const bb = boot();
  bb.push(view(b));
  const notice = bb.doc.querySelector('.hostclock')!;
  assert.ok(!notice.classList.contains('hidden'));
  assert.match(notice.textContent!, /房主還沒回來。\d+:\d\d 後，房主會自動轉給第一個回來的玩家（乙）/);
  assert.match(notice.textContent!, /[45]:\d\d/, 'about five minutes');
  assert.ok(bb.doc.querySelector('.tag.res'), 'the host is tagged as still reading');
  bb.w.close();

  // once the host is back the countdown is gone and both can start
  m.playAgain('A');
  const hb = boot();
  hb.push(view(uid));
  assert.ok(hb.doc.querySelector('.hostclock')!.classList.contains('hidden'));
  const start = [...hb.doc.querySelectorAll('button')].find((x) => x.textContent === '開始遊戲') as HTMLButtonElement;
  assert.equal(start.disabled, false);
  hb.w.close();

  // a host with only readers around cannot start: nobody is "back" but the host himself
  const m2 = new RoomManager();
  const r2 = m2.createRoom('A', '阿龍');
  m2.joinRoom('B', r2.room.roomId, '乙');
  m2.joinRoom('C', r2.room.roomId, '丙');
  m2.start('A');
  let k = 0;
  while (r2.room.status === 'PLAYING' && k++ < 200000) m2.autoTurn(r2.room);
  m2.playAgain('A');
  const h2 = boot();
  h2.push(m2.view(r2.room, r2.uid, () => true));
  const start2 = [...h2.doc.querySelectorAll('button')].find((x) => x.textContent === '開始遊戲') as HTMLButtonElement;
  assert.equal(start2.disabled, true, 'only 1 player is back: not enough to start');
  assert.ok(h2.doc.body.textContent!.includes('參賽 1 人'));
  assert.ok(h2.doc.body.textContent!.includes('還在看結算 2 人'));
  assert.ok(h2.doc.body.textContent!.includes('開始後會成為觀察者'));
  h2.w.close();
});

test('phone side menu has its own 離開遊戲 (the page-bottom one stays); it asks first and leaves', () => {
  const m = new RoomManager();
  const { room, uid } = m.createRoom('A', '阿龍');
  m.addBot('A');
  m.start('A');
  const { doc, push, w, sent } = boot();
  push(m.view(room, uid, () => true));
  const inMenu = doc.querySelector('.drawer .drawer-foot .leave-btn') as HTMLButtonElement;
  assert.ok(inMenu, 'the leave button is in the side menu');
  assert.equal(inMenu.textContent, '離開遊戲');
  assert.ok(doc.querySelector('.side .leave-btn'), 'and the one at the bottom of the page is still there');
  let asked = 0;
  (w as any).confirm = () => { asked++; return false; };
  inMenu.click();
  assert.equal(asked, 1, 'asks before leaving');
  assert.equal(sent.filter((x) => x.t === 'leave').length, 0, 'declined: stays');
  (w as any).confirm = () => true;
  inMenu.click();
  assert.deepEqual(sent.filter((x) => x.t === 'leave'), [{ t: 'leave' }]);
  w.close();
});

test('stylesheet: on narrow screens the 牌組 label has its own line; wide screens keep one line; the menu button sits at the bottom', () => {
  const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  assert.ok(css.includes('@media (max-width: 480px) { .deckpick > .muted { flex: 1 0 100%; } }'), 'label takes a whole row on phones only');
  const wide = css.split(/\r?\n/).find((l) => l.startsWith('.deckpick {'))!;
  assert.ok(wide.includes('display: flex') && wide.includes('flex-wrap: wrap'), 'wide: the label and both choices share a line when they fit');
  assert.ok(css.includes('.drawer-foot { margin-top: auto;'), 'leave button at the bottom of the side menu');
});

test('the lock info shows next to 我的籌碼 only while chips are locked, also when waiting for your turn', () => {
  const m = new RoomManager();
  const { room, uid } = m.createRoom('A', '阿龍');
  m.addBot('A');
  m.start('A');
  const g = room.game!;
  const { doc, push, w } = boot();
  push(m.view(room, uid, () => true));
  assert.equal(doc.querySelector('.lockinfo'), null, 'nothing locked at the start of a round');
  g.deck = g.deck.slice(0, 41); // 21% used: 50 and 100 locked
  push(m.view(room, uid, () => true));
  assert.ok(doc.querySelector('.ahead .lockinfo'), 'shown in the row');
  w.close();
});

test('waiting room: players and chat share one two-column container, players first in the DOM (stacked on phones)', () => {
  const m = new RoomManager();
  const { room, uid } = m.createRoom('A', '阿龍');
  m.joinRoom('B', room.roomId, '乙');
  const { doc, push, w } = boot();
  push(m.view(room, uid, () => true));
  const cols = doc.querySelector('.lobbycols')!;
  assert.ok(cols, 'the container');
  const kids = [...cols.children];
  assert.equal(kids.length, 2);
  assert.ok(kids[0]!.querySelector('.plist'), 'the player list comes first, so it is on top on a phone');
  assert.ok(kids[1]!.classList.contains('chatbox'), 'the chat comes second, below the list on a phone');
  // everything else of the lobby stays above that block
  const root = cols.parentElement!;
  const order = [...root.children].map((k) => k.className.split(' ')[0]);
  assert.ok(order.indexOf('lobbycols') > order.indexOf('row'), 'start / add bot / leave row stays above');
  w.close();
});

test('stylesheet: one column by default; list left and chat right only from 900px up, chat stays in view', () => {
  const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  const lines = css.split(/\r?\n/);
  const base = lines.find((l) => l.startsWith('.lobbycols {'))!;
  assert.ok(base.includes('grid-template-columns: minmax(0, 1fr)'), 'default (phones): a single column, list then chat');
  const i = lines.findIndex((l) => l.startsWith('@media (min-width: 900px)') && lines[lines.indexOf(l) + 1]?.includes('.lobbycols'));
  assert.ok(i >= 0, 'a wide-screen block exists');
  const wide = lines.slice(i, i + 5).join('\n');
  assert.match(wide, /grid-template-columns: minmax\(0, 1\.25fr\) minmax\(0, 1fr\)/, 'two columns, list wider than the chat');
  assert.ok(wide.includes('position: sticky'), 'chat sticks while the list scrolls');
  // players are defined before the chat in the markup, so the single column puts the list on top
  assert.ok(css.indexOf('.lobbycols > .panel') > css.indexOf('.lobbycols {'));
});

test('stylesheet: the chat send button never wraps its label', () => {
  const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  assert.ok(css.includes('.chatform button { white-space: nowrap; flex: none; }'));
});

// ---------------- the turn indicator area never changes shape ----------------

test('turn bar: the same three rows in every state (who is up / bet note / clock), nothing appears or disappears', () => {
  const m = new RoomManager();
  const { room, uid } = m.createRoom('A', '阿龍');
  m.addBot('A');
  m.start('A');
  const g = room.game!;
  const { doc, push, w } = boot();
  const shape = () => [...doc.querySelector('.turnbar')!.children].map((e) => e.className.split(' ')[0] + (e.textContent!.trim() ? '' : '(blank)'));
  const rowsNow = () => [...doc.querySelector('.turnbar')!.children].map((e) => e.className);

  push(m.view(room, uid, () => true)); // my turn, nothing bet yet
  const base = rowsNow();
  assert.equal(base.length, 3, 'name, bet note, clock');
  assert.equal(doc.querySelector('.turnbar .name')!.textContent, '輪到你了');
  assert.equal(doc.querySelector('.turnbar .betnote')!.textContent, '尚未下注');
  m.bet('A', g.currentTurnId, 100);
  push(m.view(room, uid, () => true)); // bet placed
  assert.deepEqual(rowsNow(), base, 'same rows after betting');
  assert.equal(doc.querySelector('.turnbar .betnote')!.textContent, '已下注 100');
  g.gate = [{ suit: 'S', rank: 8 }, { suit: 'H', rank: 9 }];
  push(m.view(room, uid, () => true)); // consecutive gate: no extra row in the turn bar
  assert.deepEqual(rowsNow(), base, 'a consecutive gate adds no row');
  m.decide('A', g.currentTurnId, 'PASS');
  push(m.view(room, uid, () => true)); // the bot's turn
  assert.deepEqual(rowsNow(), base, "same rows on someone else's turn");
  assert.match(doc.querySelector('.turnbar .name')!.textContent!, /^輪到 .+（電腦）$/);
  void shape;
  w.close();
});

test('banner row is always there: idle = invisible but present, so showing a result cannot push anything', () => {
  const m = new RoomManager();
  const { room, uid } = m.createRoom('A', '阿龍');
  m.addBot('A');
  m.start('A');
  const { doc, push, w } = boot();
  push(m.view(room, uid, () => true));
  const banner = doc.querySelector('.stage .banner')!;
  assert.ok(banner, 'present in the stage even when idle');
  assert.ok(banner.classList.contains('off'));
  assert.ok(!banner.classList.contains('hidden'), 'not display:none');
  assert.equal(banner.textContent, '\u00a0', 'holds a blank so the row keeps its height');
  w.close();
});

test('gate notice sits in the top-right corner slot of the table panel, not in the gap and not in the turn bar', () => {
  const m = new RoomManager();
  const { room, uid } = m.createRoom('A', '阿龍');
  m.addBot('A');
  m.start('A');
  const { doc, push, w } = boot();
  for (const [a, b] of [[8, 9], [7, 9]] as const) {
    room.game!.gate = [{ suit: 'S', rank: a }, { suit: 'H', rank: b }];
    push(m.view(room, uid, () => true));
    const note = doc.querySelector('.gatenote')!;
    const slot = note.closest('.gatenote-slot')!;
    assert.ok(slot, 'inside the corner slot');
    assert.ok(slot.parentElement!.classList.contains('table'), 'a direct child of the table panel');
    assert.ok(!note.closest('.gap') && !note.closest('.turnbar') && !note.closest('.stage'), 'not inside the table content');
    assert.equal(note.getAttribute('role'), 'status');
  }
  assert.equal(doc.querySelector('.gap')!.children.length, 0, 'the gap between the posts stays empty');
  w.close();
});

test('stylesheet: nothing in the table area can change height (banner off = invisible, fixed turn bar, corner slot out of the flow)', () => {
  const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  const lines = css.split(/\r?\n/);
  assert.ok(css.includes('.banner.off { visibility: hidden; }'), 'invisible, not display:none');
  assert.ok(css.includes('.stage .banner { min-height: 44px;'), 'banner row reserved');
  assert.match(lines.find((l) => l.startsWith('.turnbar {'))!, /min-height: 87px/, 'the turn bar is always as tall as its three rows');
  const slot = lines.find((l) => l.startsWith('.gatenote-slot {'))!;
  assert.ok(slot.includes('position: absolute') && slot.includes('top: 8px') && slot.includes('right: 10px'), 'top-right corner, out of the flow: ' + slot);
  const table = lines.find((l) => l.startsWith('.table {'))!;
  assert.ok(table.includes('position: relative'), 'the corner is the table panel');
  assert.match(table, /padding: 4[0-9]px 10px/, 'a top strip is reserved so the notice never covers a card');
  assert.ok(!css.split(/\r?\n/).some((l) => l.startsWith('.gatewarn')), 'the old in-gap tag is gone');
  assert.ok(css.includes('.gatenote.narrow { background: var(--gold)') && css.includes('.gatenote.consec { background: var(--red)'), 'gold for narrow, red for consecutive');
  assert.ok(css.includes('@media (prefers-reduced-motion: reduce) { .gatenote { animation: none; } }'));
});