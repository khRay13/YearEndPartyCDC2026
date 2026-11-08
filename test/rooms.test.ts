import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GameError } from '../src/engine/game.ts';
import { RoomManager, BOT_NAMES, HOST_RETURN_MS } from '../src/server/rooms.ts';
import { DECK_COPIES, DECK_SIZE } from '../src/engine/game.ts';

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof GameError) return e.code;
    throw e;
  }
  return 'NO_ERROR';
}

function setup() {
  const m = new RoomManager();
  const { room, uid } = m.createRoom('sidA', '房主');
  return { m, room, host: uid };
}

test('TC-001: create room -> host, status WAITING, 6-digit number, no password anywhere', () => {
  const { room, host } = setup();
  assert.equal(room.hostUid, host);
  assert.equal(room.status, 'WAITING');
  assert.ok(!('passwordHash' in room), 'rooms have no password');
  assert.match(room.roomId, /^[0-9]{6}$/);
});

test('no passwords: the room number alone is enough to join, and the view carries no password field', () => {
  const m = new RoomManager();
  const { room } = m.createRoom('s1', 'host');
  assert.doesNotThrow(() => m.joinRoom('s2', room.roomId, 'guest'));
  const v = m.view(room, null, () => true);
  assert.ok(!('hasPassword' in v));
  assert.ok(!JSON.stringify(m.toJSON()).includes('passwordHash'), 'nothing password-related is persisted');
});

test('代打 switch: on -> computer plays for them & human actions rejected; off -> back', () => {
  const m = new RoomManager();
  const { room } = m.createRoom('A', 'a');
  m.joinRoom('B', room.roomId, 'b');
  m.start('A');
  const g = room.game!;
  const cur = room.players.find((p) => p.uid === g.currentUid)!;
  m.setAuto(cur.sid!, true);
  assert.equal(code(() => m.bet(cur.sid!, g.currentTurnId, 100)), 'AUTO_ON');
  const rec = m.autoTurn(room);
  assert.equal(rec.isAuto, true);
  m.setAuto(cur.sid!, false);
  assert.equal(cur.autoMode, false);
  assert.equal(code(() => m.setAuto('nobody', true)), 'NOT_IN_ROOM');
});

test('TC-002: an unknown room number is rejected', () => {
  const { m } = setup();
  assert.equal(code(() => m.joinRoom('s2', 'ZZZZZ', 'x')), 'ROOM_NOT_FOUND');
  assert.equal(code(() => m.joinRoom('s2', '000000', 'x')), 'ROOM_NOT_FOUND');
});

test('join: unique uids, duplicate nicknames allowed, READY at 2 players', () => {
  const { m, room } = setup();
  const a = m.joinRoom('s2', room.roomId, '同名');
  const b = m.joinRoom('s3', room.roomId, '同名');
  assert.notEqual(a.uid, b.uid);
  assert.equal(room.status, 'READY');
});

test('TC-003: 13th player rejected', () => {
  const { m, room } = setup();
  for (let i = 0; i < 11; i++) m.joinRoom('s' + i, room.roomId, 'p' + i);
  assert.equal(room.players.length, 12);
  assert.equal(code(() => m.joinRoom('sx', room.roomId, 'x')), 'ROOM_FULL');
});

test('TC-004/005: start needs 2 players, host only', () => {
  const { m, room } = setup();
  assert.equal(code(() => m.start('sidA')), 'NOT_ENOUGH_PLAYERS');
  m.joinRoom('s2', room.roomId, 'B');
  assert.equal(code(() => m.start('s2')), 'NOT_HOST');
  m.start('sidA');
  assert.equal(room.status, 'PLAYING');
  assert.equal(room.game!.players.length, 2);
});

test('no new participants after start; cookie re-entry keeps UID', () => {
  const { m, room, host } = setup();
  m.joinRoom('s2', room.roomId, 'B');
  m.start('sidA');
  assert.equal(code(() => m.joinRoom('s9', room.roomId, 'C')), 'GAME_STARTED');
  const again = m.joinRoom('sidA', room.roomId, 'ignored');
  assert.equal(again.uid, host);
});

test('host can add bots to fill; bots count toward start', () => {
  const { m, room } = setup();
  m.addBot('sidA');
  assert.equal(room.status, 'READY');
  m.start('sidA');
  assert.equal(room.game!.players.length, 2);
});

test('kick in lobby removes + bans; kick in game keeps player (computer plays)', () => {
  const { m, room } = setup();
  const b = m.joinRoom('s2', room.roomId, 'B');
  const c = m.joinRoom('s3', room.roomId, 'C');
  m.kick('sidA', b.uid);
  assert.equal(room.players.length, 2);
  assert.equal(code(() => m.joinRoom('s2', room.roomId, 'B')), 'BANNED');
  m.start('sidA');
  m.kick('sidA', c.uid);
  assert.equal(room.players.length, 2);
  assert.equal(room.players.find((p) => p.uid === c.uid)!.kicked, true);
  assert.equal(room.game!.players.length, 2);
  assert.equal(code(() => m.kick('s3', 'x')), 'NOT_HOST');
});

test('TC-022: host leaves -> random new host, room continues', () => {
  const { m, room, host } = setup();
  const b = m.joinRoom('s2', room.roomId, 'B');
  m.leave('sidA');
  assert.equal(room.hostUid, b.uid);
  assert.notEqual(room.hostUid, host);
  assert.equal(room.status, 'WAITING');
});

test('room closes when no eligible player remains', () => {
  const { m, room } = setup();
  m.leave('sidA');
  assert.equal(room.status, 'CLOSED');
});

test('TC-023: stale turn id / duplicate action id rejected', () => {
  const m = new RoomManager();
  const { room } = m.createRoom('A', 'a');
  m.joinRoom('B', room.roomId, 'b');
  m.start('A');
  const g = room.game!;
  const cur = room.players.find((p) => p.uid === g.currentUid)!;
  const sid = cur.sid!;
  const t = g.currentTurnId;
  assert.equal(code(() => m.bet(sid, t + 1, 100)), 'STALE_TURN');
  m.bet(sid, t, 100, 'act-1');
  assert.equal(code(() => m.bet(sid, t, 100, 'act-1')), 'DUPLICATE_ACTION');
  assert.equal(code(() => m.bet(sid, t, 100, 'act-2')), 'BET_ALREADY_PLACED');
  const other = room.players.find((p) => p.uid !== g.currentUid)!;
  assert.equal(code(() => m.bet(other.sid!, t, 100)), 'NOT_YOUR_TURN');
  m.decide(sid, t, 'PASS', 'act-3');
  assert.equal(code(() => m.decide(sid, t, 'PASS', 'act-4')), 'STALE_TURN'); // already advanced
  assert.deepEqual(g.checkIntegrity(), []);
});

test('view never exposes the deck', () => {
  const m = new RoomManager();
  const { room, uid } = m.createRoom('A', 'a');
  m.addBot('A');
  m.start('A');
  const v = m.view(room, uid, () => true);
  assert.ok(!('deck' in (v.game as object)));
  assert.equal(JSON.stringify(v).includes('"deck"'), false);
});

test('persistence round trip keeps game state', () => {
  const m = new RoomManager();
  const { room } = m.createRoom('A', 'a');
  m.addBot('A');
  m.start('A');
  m.autoTurn(room);
  const json = JSON.parse(JSON.stringify(m.toJSON()));
  const m2 = new RoomManager();
  m2.load(json);
  const r2 = m2.getRoom(room.roomId);
  assert.equal(r2.game!.pot, room.game!.pot);
  assert.deepEqual(r2.game!.deck, room.game!.deck);
  assert.equal(r2.game!.currentTurnId, room.game!.currentTurnId);
  assert.ok(m2.binding('A'));
  m2.autoTurn(r2); // restored game is playable
  assert.deepEqual(r2.game!.checkIntegrity(), []);
});

test('full bot match runs to a valid finish with ranking', () => {
  const m = new RoomManager();
  const { room } = m.createRoom('A', 'a');
  for (let i = 0; i < 4; i++) m.addBot('A');
  m.start('A');
  let n = 0;
  while (room.status === 'PLAYING') {
    assert.ok(++n < 200000);
    m.autoTurn(room);
  }
  assert.equal(room.status, 'FINISHED');
  assert.equal(room.game!.ranking().length, 5);
  assert.ok(room.events.some((e) => e.type === 'MATCH_FINISHED'));
});

test('host is the first dealer AND takes the first turn, however the seats were shuffled', () => {
  for (let i = 0; i < 25; i++) {
    const m = new RoomManager();
    const { room, uid } = m.createRoom('A', 'host');
    for (let k = 0; k < 4; k++) m.addBot('A');
    m.start('A');
    assert.equal(room.game!.dealerUid, uid);
    assert.equal(room.game!.currentUid, uid);
  }
});

test('host starts as dealer', () => {
  const m = new RoomManager();
  const { room, uid } = m.createRoom('A', 'a');
  m.joinRoom('B', room.roomId, 'b');
  m.start('A');
  assert.equal(room.game!.dealerUid, uid);
  assert.equal(m.view(room, uid, () => true).dealerUid, uid);
});

test('bot names: edgy, random, unique, never the old 電腦N pattern', () => {
  const m = new RoomManager();
  const { room } = m.createRoom('A', 'a');
  for (let i = 0; i < 11; i++) m.addBot('A');
  const names = room.players.filter((p) => p.isBot).map((p) => p.nickname);
  assert.equal(new Set(names).size, names.length);
  assert.ok(names.every((n) => !/^電腦\d+$/.test(n)));
  assert.ok(names.every((n) => BOT_NAMES.includes(n)));
});

test('離開 mid-match: stays seated under computer control, can come back, host passes on', () => {
  const m = new RoomManager();
  const { room, uid } = m.createRoom('A', 'a');
  m.joinRoom('B', room.roomId, 'b');
  m.start('A');
  assert.equal(m.rejoinable('A'), null);
  m.leave('A');
  const p = room.players.find((x) => x.uid === uid)!;
  assert.equal(p.left, true);
  assert.equal(p.autoMode, true);
  assert.equal(m.rejoinable('A'), room.roomId);
  assert.ok(room.game!.players.some((x) => x.uid === uid)); // still in the match
  m.rejoin('A');
  assert.equal(p.left, false);
  assert.equal(p.autoMode, false);
  assert.equal(m.rejoinable('A'), null);
});

test('a left player may join another room; the old seat stays with the computer', () => {
  const m = new RoomManager();
  const { room } = m.createRoom('A', 'a');
  m.joinRoom('B', room.roomId, 'b');
  m.start('A');
  assert.equal(code(() => m.createRoom('A', 'a')), 'IN_ACTIVE_GAME'); // still playing: must leave first
  m.leave('A');
  const fresh = m.createRoom('A', 'a');
  assert.notEqual(fresh.room.roomId, room.roomId);
  assert.equal(room.players.find((x) => x.sid === null && !x.isBot)?.autoMode, true);
});

test('fast-forward only once no live human is left', () => {
  const m = new RoomManager();
  const { room, uid } = m.createRoom('A', 'a');
  m.addBot('A');
  m.addBot('A');
  m.start('A');
  assert.equal(m.isFastForward(room), false);
  room.game!.player(uid).eliminated = true; // the only human is out
  assert.equal(m.isFastForward(room), true);
  assert.equal(m.view(room, uid, () => true).game!.fast, true);
});

// Only meaningful when several decks are shuffled together; with the single-deck game it cannot happen.
test('seenCards keeps a repeated card twice (multi-deck): same suit+rank drawn twice in one round', { skip: DECK_COPIES < 2 ? 'single-deck configuration' : false }, () => {
  const m = new RoomManager();
  const { room } = m.createRoom('A', 'a');
  m.joinRoom('B', room.roomId, 'b');
  m.start('A');
  const g = room.game!;
  const first = room.players.find((p) => p.uid === g.currentUid)!;
  const second = room.players.find((p) => p.uid !== g.currentUid)!;
  const q = { suit: 'S', rank: 12 };
  g.gate = [{ suit: 'H', rank: 3 }, { suit: 'D', rank: 9 }];
  g.deck = [{ ...q }, { ...q }, ...g.deck];
  m.bet(first.sid!, g.currentTurnId, 100);
  assert.equal(m.decide(first.sid!, g.currentTurnId, 'SHOOT').result, 'MISS'); // Q is outside 3..9
  m.bet(second.sid!, g.currentTurnId, 100);
  assert.equal(m.decide(second.sid!, g.currentTurnId, 'SHOOT').result, 'MISS'); // the second copy of Q♠
  const v = m.view(room, first.uid, () => true).game!;
  assert.equal(v.deckSize, DECK_SIZE);
  assert.equal(v.seenCards.filter((c: any) => c.suit === 'S' && c.rank === 12).length, 2);
  assert.equal(v.seenCards.length, 4); // 2 gate cards + 2 thirds
});

test('view tells the client which chips are locked and the smallest open chip', () => {
  const m = new RoomManager();
  const { room, uid } = m.createRoom('A', 'a');
  m.addBot('A');
  m.start('A');
  const g = room.game!;
  const v0 = m.view(room, uid, () => true).game!;
  assert.equal(v0.minChip, g.minChip);
  g.deck = g.deck.slice(0, 39); // 25% used
  const v = m.view(room, uid, () => true).game!;
  assert.equal(v.minChip, 1000);
  assert.deepEqual(v.lockedChips, [50, 100, 500]);
  assert.ok(v.deckUsedPercent >= 25);
});

test('view flags the turn in which the player to act has bet everything; ALL_IN event emitted once', () => {
  const m = new RoomManager();
  const { room, uid } = m.createRoom('A', 'a');
  m.addBot('A');
  m.start('A');
  const g = room.game!;
  while (g.currentUid !== uid) m.autoTurn(room);
  assert.equal(m.view(room, uid, () => true).game!.allIn, false);
  m.bet('A', g.currentTurnId, 500);
  assert.equal(m.view(room, uid, () => true).game!.allIn, false, 'a normal bet is not an all-in');
  m.decide('A', g.currentTurnId, 'PASS');

  // next time round: bet every chip
  while (g.currentUid !== uid) m.autoTurn(room);
  const chips = g.player(uid).chips;
  const before = room.events.filter((e) => e.type === 'ALL_IN').length;
  m.bet('A', g.currentTurnId, chips);
  const v = m.view(room, uid, () => true).game!;
  assert.equal(v.allIn, true);
  assert.equal(v.currentBet, chips);
  assert.equal(room.events.filter((e) => e.type === 'ALL_IN').length, before + 1);
  m.decide('A', g.currentTurnId, 'SHOOT'); // then shooting does not announce a second time
  assert.equal(room.events.filter((e) => e.type === 'ALL_IN').length, before + 1);
});

test('host chooses the deck (1 or 2) in the waiting room; default is 1; it feeds the game and the view', () => {
  const m = new RoomManager();
  const { room, uid } = m.createRoom('A', 'host');
  assert.equal(room.deckCopies, 1);
  assert.equal(m.view(room, uid, () => true).deckCopies, 1);
  m.joinRoom('B', room.roomId, 'guest');
  assert.equal(code(() => m.setDeckCopies('B', 2)), 'NOT_HOST');
  assert.equal(code(() => m.setDeckCopies('A', 3)), 'BAD_DECK');
  assert.equal(code(() => m.setDeckCopies('A', 0)), 'BAD_DECK');
  m.setDeckCopies('A', 2);
  assert.equal(m.view(room, uid, () => true).deckCopies, 2);
  m.setDeckCopies('A', 1); // can change its mind
  m.setDeckCopies('A', 2);
  m.start('A');
  assert.equal(room.game!.deckCopies, 2);
  const v = m.view(room, uid, () => true).game!;
  assert.equal(v.deckSize, 104);
  assert.equal(code(() => m.setDeckCopies('A', 1)), 'BAD_STATE'); // not once the game runs
});

test('deck choice survives a restart, and a room saved before the option existed loads as 1 deck', () => {
  const m = new RoomManager();
  const { room } = m.createRoom('A', 'host');
  m.addBot('A');
  m.setDeckCopies('A', 2);
  m.start('A');
  const saved = JSON.parse(JSON.stringify(m.toJSON()));
  const m2 = new RoomManager();
  m2.load(saved);
  assert.equal(m2.getRoom(room.roomId).deckCopies, 2);
  assert.equal(m2.getRoom(room.roomId).game!.deckCopies, 2);
  // an old save: no deckCopies on the room or the game, plus a leftover passwordHash from the password days
  const old = JSON.parse(JSON.stringify(saved));
  delete old.rooms[0].deckCopies;
  delete old.rooms[0].game.deckCopies;
  old.rooms[0].passwordHash = 'salt:hash';
  const m3 = new RoomManager();
  m3.load(old);
  assert.equal(m3.getRoom(room.roomId).deckCopies, 1);
  assert.equal(m3.getRoom(room.roomId).game!.deckCopies, 1);
  assert.ok(!('passwordHash' in m3.getRoom(room.roomId)), 'the stale password hash is dropped');
});

test('view carries per-player PASS counts (shown in the result table)', () => {
  const m = new RoomManager();
  const { room, uid } = m.createRoom('A', 'host');
  m.addBot('A');
  m.start('A');
  const v = m.view(room, uid, () => true);
  assert.ok(v.players.every((p) => p.stats && typeof p.stats.pass === 'number'));
  assert.ok(!('initialChips' in v), 'the starting chips were only sent for the removed profit/loss column');
});

// ---------------- observers (TC-061) ----------------

function lobbyOf(n: number) {
  const m = new RoomManager();
  const { room, uid } = m.createRoom('A', 'host');
  const uids = [uid];
  for (let i = 1; i < n; i++) uids.push(m.joinRoom('S' + i, room.roomId, 'p' + i).uid);
  return { m, room, host: uid, uids };
}

test('observers: only the host sets them, not on the host or a bot, and they do not count towards 2 players (TC-061)', () => {
  const { m, room, host, uids } = lobbyOf(3); // A (host), S1, S2
  assert.equal(code(() => m.setObserver('S1', uids[2]!, true)), 'NOT_HOST');
  assert.equal(code(() => m.setObserver('A', host, true)), 'HOST_CANNOT_OBSERVE');
  assert.equal(code(() => m.setObserver('A', 'nobody', true)), 'UNKNOWN_PLAYER');
  m.addBot('A');
  const bot = room.players.find((p) => p.isBot)!.uid;
  assert.equal(code(() => m.setObserver('A', bot, true)), 'BOT_CANNOT_OBSERVE');
  m.setObserver('A', uids[1]!, true);
  m.setObserver('A', uids[2]!, true);
  const v = m.view(room, host, () => true);
  assert.deepEqual(v.players.filter((p) => p.isObserver).map((p) => p.uid), [uids[1], uids[2]]);
  // host + bot are the only two who play: still enough
  assert.equal(room.status, 'READY');
  room.players = room.players.filter((p) => !p.isBot); // remove the bot: only the host plays -> not enough
  m.setObserver('A', uids[1]!, true); // (re-evaluates the room status)
  assert.equal(room.status, 'WAITING');
  assert.equal(code(() => m.start('A')), 'NOT_ENOUGH_PLAYERS');
  m.setObserver('A', uids[1]!, false); // checkbox off again
  assert.equal(room.status, 'READY');
});

test('observers are not in the game: no seat, no chips, no actions; they may leave freely; the match ignores them', () => {
  const { m, room, host, uids } = lobbyOf(4); // A, S1, S2, S3
  m.setObserver('A', uids[3]!, true);
  m.start('A');
  const g = room.game!;
  assert.equal(g.players.length, 3);
  assert.ok(!g.players.some((p) => p.uid === uids[3]));
  assert.equal(code(() => m.setObserver('A', uids[3]!, false)), 'BAD_STATE'); // not once the game runs
  const v = m.view(room, uids[3]!, () => true);
  const row = v.players.find((p) => p.uid === uids[3])!;
  assert.equal(row.isObserver, true);
  assert.equal(row.chips, null);
  assert.equal(row.stats, null);
  assert.equal(v.game!.canAct, false);
  // an observer can never act, whatever the turn
  assert.equal(code(() => m.bet('S3', g.currentTurnId, 100)), 'NOT_A_PLAYER');
  assert.equal(code(() => m.setAuto('S3', true)), 'NOT_A_PLAYER');
  // leaving mid-match just removes them: no left flag, no computer seat
  m.leave('S3');
  assert.ok(!room.players.some((p) => p.uid === uids[3]));
  assert.equal(g.players.length, 3);
  assert.equal(room.status, 'PLAYING');
});

test('with only observers left watching, the computers still play the match out fast', () => {
  const { m, room, uids } = lobbyOf(3);
  m.setObserver('A', uids[2]!, true); // S2 observes
  m.addBot('A');
  m.start('A');
  const g = room.game!;
  assert.equal(m.isFastForward(room), false); // A and S1 are live humans
  g.player(uids[0]!).eliminated = true;
  g.player(uids[1]!).eliminated = true;
  assert.equal(m.isFastForward(room), true); // the observer does not keep the slow, animated mode alive
  assert.doesNotThrow(() => m.view(room, uids[2]!, () => true)); // and the view copes with an observer (no seat)
});

test('when the host leaves, a real player is preferred over an observer as the new host', () => {
  const { m, room, uids } = lobbyOf(3);
  m.setObserver('A', uids[1]!, true); // S1 observes
  for (let i = 0; i < 20; i++) {
    const lobby = lobbyOf(3);
    lobby.m.setObserver('A', lobby.uids[1]!, true);
    lobby.m.leave('A');
    assert.equal(lobby.room.hostUid, lobby.uids[2], 'the player (not the observer) becomes host');
  }
  void m;
  void room;
});

test('an observer who is promoted host in the waiting room becomes a player (the host always plays)', () => {
  const { m, room, uids } = lobbyOf(2);
  m.setObserver('A', uids[1]!, true);
  m.leave('A'); // only the observer is left
  assert.equal(room.hostUid, uids[1]);
  assert.equal(room.players.find((p) => p.uid === uids[1])!.observer, false);
});

// ---------------- wins and back to the waiting room (TC-062) ----------------

function playOut(m: RoomManager, room: ReturnType<RoomManager['getRoom']>) {
  let n = 0;
  while (room.status === 'PLAYING' && n++ < 200000) m.autoTurn(room);
  assert.equal(room.status, 'FINISHED');
}

test('winner gets +1 win; every player goes back on their own with 再玩一局, wins/bots/observers kept (TC-062)', () => {
  const m = new RoomManager();
  const { room, uid } = m.createRoom('A', 'host');
  const b = m.joinRoom('B', room.roomId, 'obs').uid;
  m.setObserver('A', b, true);
  m.addBot('A');
  m.addBot('A');
  m.start('A');
  playOut(m, room);
  const winner = room.game!.ranking()[0]!.uid;
  const wins = () => Object.fromEntries(room.players.map((p) => [p.uid, p.wins ?? 0]));
  assert.equal(wins()[winner], 1);
  assert.equal(Object.values(wins()).reduce((a, c) => a + c, 0), 1, 'exactly one winner');
  assert.equal(m.view(room, uid, () => true).players.find((p) => p.uid === winner)!.wins, 1);
  assert.ok(room.events.some((e) => e.type === 'MATCH_FINISHED' && e.payload.winner === winner));

  // not before the match is over, and a stranger cannot
  assert.equal(code(() => m.playAgain('nobody')), 'NOT_IN_ROOM');
  // the observer is the first one back: it does not need the host
  m.playAgain('B');
  assert.equal(room.status, 'READY'); // host + 2 bots are enough
  assert.equal(room.game, null);
  assert.equal(wins()[winner], 1, 'wins survive the rematch');
  assert.equal(room.players.find((p) => p.uid === b)!.observer, true, 'observer flag kept');
  assert.equal(room.players.filter((p) => p.isBot).length, 2);
  assert.doesNotThrow(() => m.playAgain('B')); // pressing twice changes nothing
  m.playAgain('A'); // the host comes back as well
  assert.equal(room.resultGame, null, 'everybody is back: the old result is forgotten');

  // a second match accumulates
  m.start('A');
  playOut(m, room);
  assert.equal(Object.values(wins()).reduce((a, c) => a + c, 0), 2);
});

test('the first player back drops players who left or were kicked mid-match, and bans the kicked ones', () => {
  const { m, room, uids } = lobbyOf(4); // A, S1, S2, S3
  m.start('A');
  m.leave('S1'); // walked away mid-match
  m.kick('A', uids[2]!); // kicked mid-match
  playOut(m, room);
  m.playAgain('A');
  assert.deepEqual(room.players.map((p) => p.uid).sort(), [uids[0], uids[3]].sort());
  assert.equal(code(() => m.joinRoom('S2', room.roomId, 'back')), 'BANNED');
  assert.doesNotThrow(() => m.joinRoom('S1', room.roomId, 'again')); // the one who left may simply come back
  assert.ok(room.players.every((p) => !p.left && !p.kicked && !p.autoMode));
});

test('再玩一局 only exists after a match; old saved rooms without chat/wins/queue still load', () => {
  const { m, room } = lobbyOf(2);
  assert.equal(code(() => m.playAgain('A')), 'BAD_STATE'); // waiting room, no match yet
  m.start('A');
  assert.equal(code(() => m.playAgain('A')), 'BAD_STATE'); // match running
  const saved = JSON.parse(JSON.stringify(m.toJSON()));
  delete saved.rooms[0].chat;
  delete saved.rooms[0].chatSeq;
  delete saved.rooms[0].backOrder;
  delete saved.rooms[0].lobbyDeadline;
  delete saved.rooms[0].resultGame;
  for (const p of saved.rooms[0].players) delete p.wins;
  const m2 = new RoomManager();
  m2.load(saved);
  const r2 = m2.getRoom(room.roomId);
  assert.deepEqual(r2.chat, []);
  assert.deepEqual(r2.backOrder, []);
  assert.equal(r2.lobbyDeadline, null);
  assert.equal(r2.resultGame, null);
  assert.equal(m2.view(r2, null, () => true).players[0]!.wins, 0);
});

test('chat: text only; line breaks and control characters become spaces; empty, blank and non-text are refused (TC-063)', () => {
  const { m, room } = lobbyOf(2);
  let t = 1000;
  const cm = new RoomManager({ now: () => (t += 5000) }); // each call is far apart: no rate limit in this test
  const c = cm.createRoom('A', 'host');
  assert.equal(code(() => cm.chat('A', '')), 'CHAT_EMPTY');
  assert.equal(code(() => cm.chat('A', '   \n\t  ')), 'CHAT_EMPTY');
  assert.equal(code(() => cm.chat('A', 42)), 'CHAT_EMPTY');
  assert.equal(code(() => cm.chat('A', { text: 'x' })), 'CHAT_EMPTY');
  assert.equal(code(() => cm.chat('A', null)), 'CHAT_EMPTY');
  cm.chat('A', '  哈囉\n大家\u0007好  ');
  assert.equal(c.room.chat.at(-1)!.text, '哈囉 大家 好');
  // markup is just characters: the server keeps it literally (the page renders text nodes only)
  cm.chat('A', '<img src=x onerror=alert(1)>');
  assert.equal(c.room.chat.at(-1)!.text, '<img src=x onerror=alert(1)>');
  // long messages are cut to 200 characters (counting characters, not bytes)
  cm.chat('A', '你'.repeat(300));
  assert.equal(Array.from(c.room.chat.at(-1)!.text).length, 200);
  assert.deepEqual(Object.keys(c.room.chat.at(-1)!).sort(), ['nickname', 'seq', 'text', 'ts', 'uid']);
  void m;
  void room;
});

test('chat: rate limited per player; observers may chat; only available in the waiting room', () => {
  let t = 10_000;
  const m = new RoomManager({ now: () => t });
  const { room, uid } = m.createRoom('A', 'host');
  const b = m.joinRoom('B', room.roomId, 'guest').uid;
  m.setObserver('A', b, true);
  m.chat('A', 'one');
  assert.equal(code(() => m.chat('A', 'two')), 'CHAT_TOO_FAST'); // same instant
  m.chat('B', 'hi from the observer'); // someone else is not affected
  t += 699;
  assert.equal(code(() => m.chat('A', 'two')), 'CHAT_TOO_FAST');
  t += 1;
  assert.doesNotThrow(() => m.chat('A', 'two'));
  assert.deepEqual(room.chat.map((c) => c.text), ['one', 'hi from the observer', 'two']);
  assert.deepEqual(room.chat.map((c) => c.seq), [1, 2, 3]);
  assert.equal(code(() => m.chat('nobody', 'x')), 'NOT_IN_ROOM');
  // no chat once the game is on
  m.addBot('A');
  m.start('A');
  t += 5000;
  assert.equal(code(() => m.chat('A', 'late')), 'CHAT_CLOSED');
  assert.deepEqual(m.view(room, uid, () => true).chat, [], 'the view carries no chat during the match');
});

test('chat: the view shows the last 50 in the waiting room, the room keeps 100, and history is back after the match', () => {
  let t = 1;
  const m = new RoomManager({ now: () => (t += 1000) });
  const { room, uid } = m.createRoom('A', 'host');
  for (let i = 1; i <= 130; i++) m.chat('A', 'm' + i);
  assert.equal(room.chat.length, 100);
  assert.equal(room.chat[0]!.text, 'm31');
  const shown = m.view(room, uid, () => true).chat;
  assert.equal(shown.length, 50);
  assert.equal(shown[0]!.text, 'm81');
  assert.equal(shown.at(-1)!.text, 'm130');
  m.addBot('A');
  m.start('A');
  let n = 0;
  while (room.status === 'PLAYING' && n++ < 200000) m.autoTurn(room);
  m.playAgain('A');
  assert.equal(m.view(room, uid, () => true).chat.at(-1)!.text, 'm130', 'the conversation is still there after the rematch');
});

// ---------------- 再玩一局: each player on their own, and the 5-minute host succession (TC-062, TC-067) ----------------

/** Host A, humans B and C, finished match. `t` is the injected clock. */
function afterMatch(opts: { rng?: () => number } = {}) {
  const clock = { t: 1_000_000 };
  const m = new RoomManager({ now: () => clock.t, rng: opts.rng });
  const { room, uid } = m.createRoom('A', 'host');
  const b = m.joinRoom('B', room.roomId, 'bee').uid;
  const c = m.joinRoom('C', room.roomId, 'cee').uid;
  m.addBot('A');
  m.start('A');
  playOut(m, room);
  return { m, room, clock, A: uid, B: b, C: c, view: (u: string) => m.view(room, u, () => true) };
}

test('people who have not pressed 再玩一局 keep seeing the result table; the ones who did see the waiting room (TC-062)', () => {
  const x = afterMatch();
  assert.equal(x.view(x.B).status, 'FINISHED');
  x.m.playAgain('B'); // B is the first one back
  const vb = x.view(x.B);
  assert.ok(['WAITING', 'READY'].includes(vb.status), 'B is in the waiting room');
  assert.equal(vb.game, null);
  // A and C have not pressed it: still the result table of the match that just ended
  for (const u of [x.A, x.C]) {
    const v = x.view(u);
    assert.equal(v.status, 'FINISHED', 'still on the result table');
    assert.ok(v.game && v.game.ranking && v.game.ranking.length === 4, 'with the full ranking');
    assert.ok(v.players.every((p) => (p.stats ? true : p.isObserver)), 'and the per-player stats');
  }
  // the waiting room shows who is still reading the results
  const row = (u: string) => vb.players.find((p) => p.uid === u)!;
  assert.equal(row(x.A).onResult, true);
  assert.equal(row(x.C).onResult, true);
  assert.equal(row(x.B).onResult, false);
  // chat belongs to the waiting room: people on the result table cannot use it yet
  assert.equal(code(() => x.m.chat('A', 'hi')), 'CHAT_CLOSED');
  assert.doesNotThrow(() => x.m.chat('B', 'anyone?'));
  // C comes back; the view for A is unchanged until A presses it too
  x.m.playAgain('C');
  assert.equal(x.view(x.A).status, 'FINISHED');
  assert.ok(x.room.resultGame, 'the result table is kept while somebody still reads it');
  x.m.playAgain('A');
  assert.equal(x.room.resultGame, null, 'everybody is back: forgotten');
  assert.deepEqual(x.room.backOrder, [x.B, x.C, x.A]);
  assert.ok(['WAITING', 'READY'].includes(x.view(x.A).status));
});

test('the host starting the next match turns people still on the result table into observers (they watch it)', () => {
  const x = afterMatch();
  x.m.playAgain('A'); // host first
  x.m.playAgain('B');
  // C is still reading the old results when the host starts
  x.m.start('A');
  assert.equal(x.room.status, 'PLAYING');
  const c = x.room.players.find((p) => p.uid === x.C)!;
  assert.equal(c.observer, true);
  assert.equal(x.room.game!.players.some((p) => p.uid === x.C), false, 'not in the new match');
  const v = x.view(x.C);
  assert.equal(v.status, 'PLAYING', 'C now watches the match instead of the old result');
  assert.equal(x.room.resultGame, null);
  assert.equal(code(() => x.m.bet('C', x.room.game!.currentTurnId, 100)), 'NOT_A_PLAYER');
});

test('5 minutes after the first player came back, a host who has not returned loses the room to the first returner (TC-067)', () => {
  assert.equal(HOST_RETURN_MS, 5 * 60 * 1000);
  const x = afterMatch();
  x.m.playAgain('B'); // first back at t0; the host A has not
  const t0 = x.clock.t;
  assert.equal(x.room.lobbyDeadline, t0 + HOST_RETURN_MS);
  assert.deepEqual(x.view(x.B).hostReturn, { deadline: t0 + HOST_RETURN_MS, successor: 'bee' });
  x.m.playAgain('C'); // a second one back does not move the clock
  assert.equal(x.room.lobbyDeadline, t0 + HOST_RETURN_MS);
  x.clock.t = t0 + HOST_RETURN_MS - 1;
  assert.equal(x.m.checkHostSuccession(x.room), false, 'one millisecond early: nothing happens');
  assert.equal(x.room.hostUid, x.A);
  x.clock.t = t0 + HOST_RETURN_MS;
  assert.equal(x.m.checkHostSuccession(x.room), true);
  assert.equal(x.room.hostUid, x.B, 'the FIRST player back, not the second');
  assert.equal(x.room.lobbyDeadline, null);
  assert.ok(x.room.events.some((e) => e.type === 'ROOM_UPDATED' && e.payload.newHost === x.B && e.payload.reason === 'host-timeout'));
  assert.equal(x.view(x.B).hostReturn, null);
  // the old host coming back later is just a player now
  x.m.playAgain('A');
  assert.equal(x.room.hostUid, x.B);
  assert.equal(x.m.checkHostSuccession(x.room), false);
});

test('a host who comes back in time keeps the room; the first player back being the host starts no clock', () => {
  const x = afterMatch();
  x.m.playAgain('B');
  x.clock.t += HOST_RETURN_MS - 1000;
  x.m.playAgain('A'); // the host is back with a second to spare
  assert.equal(x.room.lobbyDeadline, null, 'the clock stops');
  x.clock.t += 10 * 60 * 1000;
  assert.equal(x.m.checkHostSuccession(x.room), false);
  assert.equal(x.room.hostUid, x.A);

  const y = afterMatch();
  y.m.playAgain('A'); // the host is first
  assert.equal(y.room.lobbyDeadline, null);
  assert.equal(y.view(y.A).hostReturn, null);
});

test('if the new host leaves, the host role goes to the second in line, then the third, in the order they came back (not at random)', () => {
  for (let seed = 1; seed <= 25; seed++) {
    const x = afterMatch({ rng: (() => { let s = seed * 7919; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); })() });
    x.m.playAgain('C'); // order of return: C, B, A
    x.m.playAgain('B');
    x.clock.t += HOST_RETURN_MS;
    assert.equal(x.m.checkHostSuccession(x.room), true);
    assert.equal(x.room.hostUid, x.C, 'first back -> host');
    x.m.leave('C'); // the new host walks away
    assert.equal(x.room.hostUid, x.B, 'second in line, every time (seed ' + seed + ')');
    x.m.playAgain('A'); // the old host finally returns...
    x.m.leave('B'); // ...and B leaves: A is next in line
    assert.equal(x.room.hostUid, x.A);
    assert.deepEqual(x.room.backOrder, [x.A]);
  }
});

test('the host leaving the result table before anybody returned hands over normally; after someone returned, by the queue', () => {
  const x = afterMatch();
  x.m.playAgain('C'); // C is first back, B is still on the result table
  x.m.leave('A'); // the host presses 離開遊戲
  assert.equal(x.room.hostUid, x.C, 'the player who came back, not the one still reading');
  assert.equal(x.room.lobbyDeadline, null, 'no clock needed any more');
  assert.ok(x.room.players.every((p) => p.uid !== x.A));
});

test('the host clock and the queue survive a restart', () => {
  const x = afterMatch();
  x.m.playAgain('B');
  const saved = JSON.parse(JSON.stringify(x.m.toJSON()));
  const m2 = new RoomManager({ now: () => x.clock.t });
  m2.load(saved);
  const r2 = m2.getRoom(x.room.roomId);
  assert.equal(r2.lobbyDeadline, x.room.lobbyDeadline);
  assert.deepEqual(r2.backOrder, [x.B]);
  assert.ok(r2.resultGame, 'the others can still read the result table after a restart');
  assert.equal(m2.view(r2, x.A, () => true).status, 'FINISHED');
  assert.ok(['WAITING', 'READY'].includes(m2.view(r2, x.B, () => true).status));
  x.clock.t += HOST_RETURN_MS;
  assert.equal(m2.checkHostSuccession(r2), true);
  assert.equal(r2.hostUid, x.B);
});

test('room recycling: abandoned rooms vanish after the idle time, occupied ones never do', () => {
  let t = 1_000_000;
  const m = new RoomManager({ now: () => t });
  const a = m.createRoom('sA', '甲').room; // everyone left the page
  const b = m.createRoom('sB', '乙').room; // somebody still connected
  const online = new Set(['sB']);
  const is = (sid: string | null) => !!sid && online.has(sid);
  t += 29 * 60_000;
  assert.deepEqual(m.sweep(is, 30 * 60_000), [], 'not idle long enough yet');
  t += 2 * 60_000;
  assert.deepEqual(m.sweep(is, 30 * 60_000), [a.roomId]);
  assert.ok(!m.rooms.has(a.roomId) && !m.sessions.has('sA'), 'room and its cookie binding are gone');
  assert.ok(m.rooms.has(b.roomId) && m.sessions.has('sB'), 'a room with a connected human is kept however quiet');
  online.delete('sB');
  t += 31 * 60_000;
  assert.deepEqual(m.sweep(is, 30 * 60_000), [b.roomId]);
});

test('room recycling: a CLOSED room is removed at once, and its number can be reused', () => {
  const m = new RoomManager();
  const { room } = m.createRoom('s1', '房主');
  m.leave('s1'); // last human leaves -> CLOSED
  assert.equal(m.rooms.get(room.roomId)?.status, 'CLOSED');
  assert.deepEqual(m.sweep(() => true), [room.roomId]);
  assert.equal(m.rooms.size, 0);
});
