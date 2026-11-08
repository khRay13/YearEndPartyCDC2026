import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDeck, judgeShot } from '../src/engine/cards.ts';
import type { Card } from '../src/engine/cards.ts';
import { CHIP_LOCK_AT_PERCENT, CHIP_LOCK_AT_PERCENT_BY_DECKS, CHIP_VALUES, roundTo50, DECK_COPIES, DECK_SIZE, Game, GameError, INITIAL_CHIPS, halfPot50 } from '../src/engine/game.ts';

const c = (rank: number): Card => ({ suit: 'S', rank });
const ranks = (...rs: number[]): Card[] => rs.map(c);

/** Build a shuffler that returns the given stacked decks, one per round. */
function stacked(...decks: Card[][]) {
  let i = 0;
  // a fresh copy each round: the engine consumes the deck it is given
  return () => decks[Math.min(i++, decks.length - 1)]!.slice();
}

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const P = [
  { uid: 'a', nickname: 'A' },
  { uid: 'b', nickname: 'B' },
  { uid: 'c', nickname: 'C' },
];

function code(fn: () => void): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof GameError) return e.code;
    throw e;
  }
  return 'NO_ERROR';
}

test('deck: 52 cards, 13 per suit, ranks 1..13', () => {
  const d = createDeck();
  assert.equal(d.length, 52);
  assert.equal(new Set(d.map((x) => x.suit + x.rank)).size, 52);
});

test('one deck: 52 cards, every suit+rank exactly once (TC-040)', () => {
  assert.equal(DECK_COPIES, 1);
  assert.equal(DECK_SIZE, 52);
  const d = createDeck(DECK_COPIES);
  assert.equal(d.length, 52);
  const counts = new Map<string, number>();
  for (const c of d) counts.set(c.suit + c.rank, (counts.get(c.suit + c.rank) ?? 0) + 1);
  assert.equal(counts.size, 52);
  assert.ok([...counts.values()].every((n) => n === 1));
  // multi-deck stays supported by the helper (the DECK_COPIES constant is the only switch)
  assert.equal(createDeck(2).length, 104);
});

test('a fresh round deals from DECK_SIZE cards: the gate (plus any redrawn pairs) leaves at most DECK_SIZE-2; integrity flags extra copies', () => {
  const g = new Game(P, { rng: mulberry32(5) });
  assert.ok(g.remainingCards <= DECK_SIZE - 2 && g.remainingCards >= DECK_SIZE - 12, 'remaining ' + g.remainingCards);
  assert.deepEqual(g.checkIntegrity(), []);
  const c = g.deck[0]!;
  g.deck.push({ ...c }, { ...c }, { ...c }); // force more copies than the deck configuration allows
  assert.ok(g.checkIntegrity().some((p) => p.includes('appears')));
});

test('judgeShot: strict interval (TC-007/008/009)', () => {
  assert.equal(judgeShot(3, 9, 5), 'HIT');
  assert.equal(judgeShot(9, 3, 5), 'HIT');
  assert.equal(judgeShot(3, 9, 3), 'COLLISION');
  assert.equal(judgeShot(3, 9, 9), 'COLLISION');
  assert.equal(judgeShot(3, 9, 2), 'MISS');
  assert.equal(judgeShot(3, 9, 13), 'MISS');
  // consecutive gate: cannot hit, collision still possible
  assert.equal(judgeShot(5, 6, 5), 'COLLISION');
  assert.equal(judgeShot(5, 6, 7), 'MISS');
});

test('player count limits (TC-003/004)', () => {
  assert.equal(code(() => new Game([P[0]!])), 'NOT_ENOUGH_PLAYERS');
  const many = Array.from({ length: 13 }, (_, i) => ({ uid: 'u' + i, nickname: 'n' }));
  assert.equal(code(() => new Game(many)), 'TOO_MANY_PLAYERS');
  assert.doesNotThrow(() => new Game(P.slice(0, 2)));
});

test('gate redraw on equal rank (TC-006), discarded cards stay out', () => {
  const g = new Game(P, { chipLockAtPercent: [], shuffler: stacked(ranks(5, 5, 7, 7, 3, 9, 1, 2, 4)) });
  assert.deepEqual([g.gate[0].rank, g.gate[1].rank], [3, 9]);
  assert.equal(g.remainingCards, 3); // 9 stacked - 2 discarded pairs - gate pair
});

test('consecutive ranks are ALLOWED as a gate: 8 and 9, two posts and no goal (TC-042)', () => {
  // equal ranks are still thrown away (4,4); consecutive ones are kept
  const g = new Game(P, { shuffler: stacked(ranks(4, 4, 8, 9, 1, 2)) });
  assert.deepEqual([g.gate[0].rank, g.gate[1].rank], [8, 9]);
  assert.equal(g.remainingCards, 2); // 6 stacked - the discarded 4,4 pair - the gate pair
  const g2 = new Game(P, { shuffler: stacked(ranks(9, 8, 1, 2)) }); // either order
  assert.deepEqual([g2.gate[0].rank, g2.gate[1].rank], [9, 8]);
});

test('on a consecutive gate nobody can hit: every card is a miss or a collision, so the pot can be pumped up (TC-043b)', () => {
  // gate 8,9: cards 3 and 12 miss; 8 and 9 collide; there is no rank strictly between
  const g = new Game(P, { chipLockAtPercent: [], shuffler: stacked(ranks(8, 9, 3, 12, 3, 12, 9, 1)) });
  g.placeBet('a', 1000);
  assert.equal(g.decide('a', 'SHOOT').result, 'MISS'); // 3
  g.placeBet('b', 1000);
  assert.equal(g.decide('b', 'SHOOT').result, 'MISS'); // 12
  g.placeBet('c', 1000);
  assert.equal(g.decide('c', 'SHOOT').result, 'MISS'); // 3
  assert.equal(g.pot, 3000);
  g.placeBet('a', 500); // pot after bet 3500, the next card is a post (12 first, then 9)
  assert.equal(g.decide('a', 'SHOOT').result, 'MISS'); // 12
  g.placeBet('b', 500); // pot 4000
  const col = g.decide('b', 'SHOOT'); // 9 -> collision: b owes the whole pot
  assert.equal(col.result, 'COLLISION');
  assert.equal(col.extraPayment, 4000);
  assert.equal(g.pot, 8000); // the pot doubled and is kept for the next round
});

test('a player who collides on a pumped-up pot can be wiped out and eliminated (the strategy)', () => {
  const g = new Game(P, { chipLockAtPercent: [], shuffler: stacked(ranks(8, 9, 3, 3, 9, 1), ranks(2, 8, 12, 12)) });
  g.player('b').chips = 3000;
  g.placeBet('a', 5000);
  assert.equal(g.decide('a', 'SHOOT').result, 'MISS'); // a pumps the pot to 5000
  g.placeBet('b', 500); // pot 5500; b has 2500 left
  assert.equal(g.decide('b', 'SHOOT').result, 'MISS'); // 3
  g.placeBet('c', 500); // pot 6000
  g.decide('c', 'PASS');
  g.placeBet('a', 5000); // pot 11000
  g.decide('a', 'PASS');
  g.player('b').chips = 2000;
  g.placeBet('b', 500); // pot 11500, b has 1500 left
  const r = g.decide('b', 'SHOOT'); // 9 -> collision
  assert.equal(r.result, 'COLLISION');
  assert.equal(r.extraPayment, 1500); // owes 11500 but pays everything left
  assert.equal(r.eliminated, true);
  assert.equal(g.player('b').eliminated, true);
  assert.equal(g.pot, 11500 + 1500);
});

test('gate fuzz: equal ranks never, consecutive ranks do occur (about 1 gate in 6), A and K are 12 apart', () => {
  let consecutive = 0;
  const N = 600;
  for (let seed = 1; seed <= N; seed++) {
    const g = new Game(P, { rng: mulberry32(seed) });
    const d = Math.abs(g.gate[0].rank - g.gate[1].rank);
    assert.ok(d >= 1, 'equal ranks must be redrawn');
    if (d === 1) consecutive++;
  }
  assert.ok(consecutive > N * 0.08 && consecutive < N * 0.28, 'consecutive gates are back: ' + consecutive + ' of ' + N);
  const g = new Game(P, { shuffler: stacked(ranks(1, 13, 7, 7)) });
  assert.deepEqual([g.gate[0].rank, g.gate[1].rank], [1, 13]);
});

test('gate: A and K are 12 apart and are accepted', () => {
  const g = new Game(P, { shuffler: stacked(ranks(1, 13, 7, 7)) });
  assert.deepEqual([g.gate[0].rank, g.gate[1].rank], [1, 13]);
});

test('every new round deals a valid gate (equal ranks are never kept), across a long game', () => {
  const g = new Game(P, { rng: mulberry32(99) });
  let rounds = 0;
  let guard = 0;
  while (g.status === 'PLAYING' && guard++ < 20000 && rounds < 200) {
    const before = g.roundNumber;
    g.autoPlay();
    if (g.roundNumber !== before && g.status === 'PLAYING') {
      rounds++;
      assert.notEqual(g.gate[0].rank, g.gate[1].rank);
    }
  }
  assert.ok(rounds > 10, 'exercised many new rounds: ' + rounds);
});

test('start state: 100,000 chips, empty pot', () => {
  const g = new Game(P);
  assert.ok(g.players.every((p) => p.chips === INITIAL_CHIPS));
  assert.equal(g.pot, 0);
  assert.equal(g.remainingCards, g.deck.length);
});

test('bet validation', () => {
  const g = new Game(P, { chipLockAtPercent: [], shuffler: stacked(ranks(3, 9, 5, 1, 2)) });
  assert.equal(code(() => g.placeBet('b', 100)), 'NOT_YOUR_TURN');
  assert.equal(code(() => g.placeBet('a', 0)), 'BET_TOO_LOW');
  assert.equal(code(() => g.placeBet('a', 25)), 'BET_TOO_LOW');
  assert.equal(code(() => g.placeBet('a', 120)), 'BET_NOT_MULTIPLE');
  assert.equal(code(() => g.placeBet('a', INITIAL_CHIPS + 50)), 'BET_EXCEEDS_CHIPS');
  assert.equal(code(() => g.decide('a', 'PASS')), 'BET_REQUIRED');
  g.placeBet('a', 3750);
  assert.equal(g.player('a').chips, INITIAL_CHIPS - 3750);
  assert.equal(g.pot, 3750);
  assert.equal(code(() => g.placeBet('a', 50)), 'BET_ALREADY_PLACED'); // TC-023
});

test('PASS: no card drawn, bet stays in pot (TC-010/011)', () => {
  const g = new Game(P, { chipLockAtPercent: [], shuffler: stacked(ranks(3, 9, 5, 1, 2)) });
  const before = g.remainingCards;
  g.placeBet('a', 500);
  const r = g.decide('a', 'PASS');
  assert.equal(r.result, 'PASS');
  assert.equal(r.thirdCard, null);
  assert.equal(g.remainingCards, before);
  assert.equal(g.pot, 500);
  assert.equal(g.currentUid, 'b');
});

test('no consecutive PASS (TC-026), per player', () => {
  const g = new Game(P, { chipLockAtPercent: [], shuffler: stacked(ranks(3, 9, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12)) });
  g.placeBet('a', 50);
  g.decide('a', 'PASS');
  g.placeBet('b', 50);
  g.decide('b', 'PASS'); // b's own previous action was null, so allowed
  g.placeBet('c', 50);
  g.decide('c', 'PASS');
  g.placeBet('a', 50);
  assert.equal(code(() => g.decide('a', 'PASS')), 'CONSECUTIVE_PASS');
  g.decide('a', 'SHOOT'); // a must shoot
});

test('HIT: wins whole pot, pot resets (TC-012)', () => {
  const g = new Game(P, { chipLockAtPercent: [], shuffler: stacked(ranks(3, 9, 5, 1, 2)) });
  g.placeBet('a', 1000);
  g.decide('a', 'PASS');
  g.placeBet('b', 500);
  const r = g.decide('b', 'SHOOT'); // third = 5 -> hit
  assert.equal(r.result, 'HIT');
  assert.equal(g.pot, 0);
  assert.equal(g.player('b').chips, INITIAL_CHIPS - 500 + 1500);
});

test('MISS: bet stays in pot (TC-013)', () => {
  const g = new Game(P, { chipLockAtPercent: [], shuffler: stacked(ranks(3, 9, 12, 1, 2)) });
  g.placeBet('a', 500);
  const r = g.decide('a', 'SHOOT');
  assert.equal(r.result, 'MISS');
  assert.equal(g.pot, 500);
  assert.equal(g.player('a').chips, INITIAL_CHIPS - 500);
});

test('MISS accumulates across turns', () => {
  const g = new Game(P, { chipLockAtPercent: [], shuffler: stacked(ranks(3, 9, 12, 12, 1, 2)) });
  g.placeBet('a', 3000);
  assert.equal(g.decide('a', 'SHOOT').result, 'MISS');
  g.placeBet('b', 500);
  assert.equal(g.decide('b', 'SHOOT').result, 'MISS');
  assert.equal(g.pot, 3500);
});

test('COLLISION exact numbers: pot 3000 + bet 500 -> 7000', () => {
  const g = new Game(P, { chipLockAtPercent: [], shuffler: stacked(ranks(3, 9, 9, 1, 2, 4)) });
  g.placeBet('a', 3000);
  g.decide('a', 'PASS');
  g.placeBet('b', 500);
  const r = g.decide('b', 'SHOOT'); // third = 9 -> collision
  assert.equal(r.result, 'COLLISION');
  assert.equal(r.extraPayment, 3500);
  assert.equal(r.potSettled, 7000); // doubled by the collision, as before
  assert.equal(g.pot, 7000); // not paid out: kept for the next round
  assert.equal(g.dealerUid, 'b'); // the deal passed a -> b
  assert.equal(g.currentUid, 'b'); // and the new dealer opens
  assert.equal(g.player('b').chips, INITIAL_CHIPS - 500 - 3500);
  assert.equal(g.player('b').eliminated, false);
});

test('COLLISION with insufficient chips: all chips to pot, eliminated (TC-015, spec 7.5)', () => {
  const g = new Game(P, { chipLockAtPercent: [], shuffler: stacked(ranks(3, 9, 9, 1, 2, 4)) });
  g.player('b').chips = 2500; // 3000 pot + 500 bet = 3500 owed, only 2000 left after bet
  g.placeBet('a', 3000);
  g.decide('a', 'PASS');
  g.placeBet('b', 500);
  const r = g.decide('b', 'SHOOT');
  assert.equal(r.result, 'COLLISION');
  assert.equal(r.extraPayment, 2000);
  assert.equal(r.potSettled, 5500);
  assert.equal(g.pot, 5500); // carried over; dealer 'a' stays
  assert.equal(g.player('b').chips, 0);
  assert.equal(g.player('b').eliminated, true);
  assert.equal(g.player('b').rank, 3);
});

test('All-in then HIT does not eliminate (TC-028)', () => {
  const g = new Game(P, { chipLockAtPercent: [], shuffler: stacked(ranks(3, 9, 5, 1, 2)) });
  g.placeBet('a', INITIAL_CHIPS);
  assert.equal(g.player('a').eliminated, false); // not judged mid-turn
  const r = g.decide('a', 'SHOOT');
  assert.equal(r.result, 'HIT');
  assert.equal(r.isAllIn, true);
  assert.equal(g.player('a').eliminated, false);
  assert.equal(g.player('a').chips, INITIAL_CHIPS); // bet returned from pot, no one else contributed
});

test('All-in then PASS or MISS eliminates after settlement (TC-021)', () => {
  const g = new Game(P, { chipLockAtPercent: [], shuffler: stacked(ranks(3, 9, 12, 1, 2)) });
  g.placeBet('a', INITIAL_CHIPS);
  g.decide('a', 'SHOOT'); // miss
  assert.equal(g.player('a').eliminated, true);
  assert.equal(g.player('a').rank, 3);
  assert.equal(g.status, 'PLAYING');
  assert.equal(g.currentUid, 'b'); // eliminated player skipped afterwards
});

test('deck exhaustion: settle first, then new round, state carries (TC-019/020)', () => {
  // 2 gate + 1 card left; first shot draws last card
  const g = new Game(P, {
    chipLockAtPercent: [], shuffler: stacked(ranks(3, 9, 12), ranks(2, 8, 1, 1, 1)),
  });
  g.placeBet('a', 500);
  const r = g.decide('a', 'SHOOT'); // 12 -> miss, deck now empty
  assert.equal(r.result, 'MISS');
  assert.equal(g.roundNumber, 2);
  assert.deepEqual([g.gate[0].rank, g.gate[1].rank], [2, 8]);
  assert.equal(g.pot, 500); // nobody won it: carried into the new round
  assert.equal(g.player('a').chips, INITIAL_CHIPS - 500);
  assert.equal(g.dealerUid, 'b'); // the deal passed a -> b
  assert.equal(g.currentUid, 'b'); // and the new dealer opens
});

test('HIT ends the round: reshuffle, new gate, pot reset, record keeps the old gate (TC-029)', () => {
  const g = new Game(P, { chipLockAtPercent: [], shuffler: stacked(ranks(3, 9, 5, 1, 2), ranks(2, 8, 12, 12, 12)) });
  g.placeBet('a', 1000);
  const r = g.decide('a', 'SHOOT'); // 5 is between 3 and 9
  assert.equal(r.result, 'HIT');
  assert.equal(r.roundEnded, true);
  assert.deepEqual(r.gate.map((c) => c.rank), [3, 9]); // gate in force for that shot
  assert.equal(g.roundNumber, 2);
  assert.deepEqual([g.gate[0].rank, g.gate[1].rank], [2, 8]); // fresh gate
  assert.equal(g.remainingCards, 3); // fresh 52-card shuffle replaced by stacked deck minus gate
  assert.equal(g.pot, 0);
});

test('COLLISION ends the round: pot kept, the deal passes on and the new dealer opens (TC-030)', () => {
  // seats a,b,c; dealer 'b' goes first
  const g = new Game(P, { dealerUid: 'b', chipLockAtPercent: [], shuffler: stacked(ranks(3, 9, 9, 1, 2), ranks(2, 8, 12, 12, 12)) });
  assert.equal(g.currentUid, 'b');
  g.placeBet('b', 100);
  g.decide('b', 'PASS');
  g.placeBet('c', 500);
  const r = g.decide('c', 'SHOOT'); // 9 = high gate -> collision by 'c' (not the dealer): pays the full pot
  assert.equal(r.result, 'COLLISION');
  assert.equal(r.extraMultiplier, 1);
  assert.equal(r.roundEnded, true);
  assert.equal(r.potAfterBet, 600); // 100 + 500
  assert.equal(r.extraPayment, 600);
  assert.equal(r.potSettled, 1200);
  assert.equal(g.pot, 1200); // carried into the next round
  assert.equal(g.roundNumber, 2);
  assert.equal(g.dealerUid, 'c'); // every round end passes the deal on: b -> c
  assert.equal(g.currentUid, 'c'); // and the new dealer opens
  assert.equal(r.nextDealerUid, 'c');
  assert.deepEqual([g.gate[0].rank, g.gate[1].rank], [2, 8]);
});

test('dealer who collides pays only HALF the pot (to the nearest 50); a normal player pays it all (TC-036)', () => {
  const deck = ranks(3, 9, 9, 1, 2);
  const g = new Game(P, { dealerUid: 'b', chipLockAtPercent: [], shuffler: stacked(deck, ranks(2, 8, 12, 12, 12)) });
  g.placeBet('b', 500);
  const r = g.decide('b', 'SHOOT'); // 9 -> collision by the dealer himself
  assert.equal(r.result, 'COLLISION');
  assert.equal(r.extraMultiplier, 0.5);
  assert.equal(r.potAfterBet, 500);
  assert.equal(r.extraPayment, 250); // half of 500
  assert.equal(r.potSettled, 750);
  assert.equal(g.pot, 750); // kept for the next round
  assert.equal(g.player('b').chips, INITIAL_CHIPS - 500 - 250);
  assert.equal(g.dealerUid, 'c'); // b -> c
  assert.equal(g.currentUid, 'c'); // new dealer opens
  assert.equal(g.totalChips, 3 * INITIAL_CHIPS);

  // a non-dealer pays the whole pot
  const g2 = new Game(P, { dealerUid: 'b', chipLockAtPercent: [], shuffler: stacked(deck, ranks(2, 8, 12, 12, 12)) });
  g2.placeBet('b', 100);
  g2.decide('b', 'PASS');
  g2.placeBet('c', 400);
  const r2 = g2.decide('c', 'SHOOT');
  assert.equal(r2.extraMultiplier, 1);
  assert.equal(r2.extraPayment, 500); // 1 x (100 + 400)
});

test('halfPot50: half of the pot, rounded to the nearest 50 (exact ties round up)', () => {
  assert.equal(halfPot50(1000), 500);
  assert.equal(halfPot50(3500), 1750);
  assert.equal(halfPot50(100), 50);
  assert.equal(halfPot50(50), 50); // 25 is a tie between 0 and 50 -> up
  assert.equal(halfPot50(150), 100); // 75 -> tie between 50 and 100 -> up
  assert.equal(halfPot50(350), 200); // 175 -> tie between 150 and 200 -> up
  assert.equal(halfPot50(250), 150); // 125 -> tie between 100 and 150 -> up
  for (const n of [50, 100, 150, 200, 350, 750, 1250, 9950]) assert.equal(halfPot50(n) % 50, 0);
});

test('dealer collision with an odd half: pot 350 -> pays 200 (nearest multiple of 50)', () => {
  const g = new Game(P, { dealerUid: 'a', chipLockAtPercent: [], shuffler: stacked(ranks(3, 9, 9, 1, 2), ranks(2, 8, 12, 12)) });
  g.placeBet('a', 350);
  const r = g.decide('a', 'SHOOT');
  assert.equal(r.potAfterBet, 350);
  assert.equal(r.extraPayment, 200);
  assert.equal(g.pot, 550);
});

test('dealer collision with too few chips pays everything left and is eliminated; the deal passes on', () => {
  const g = new Game(P, { dealerUid: 'a', chipLockAtPercent: [], shuffler: stacked(ranks(3, 9, 9, 1, 2), ranks(2, 8, 12, 12)) });
  g.player('a').chips = 1200; // bet 1000 -> 200 left; owes half of 1000 = 500, can pay only 200
  g.placeBet('a', 1000);
  const r = g.decide('a', 'SHOOT');
  assert.equal(r.extraMultiplier, 0.5);
  assert.equal(r.extraPayment, 200); // everything left
  assert.equal(r.eliminated, true);
  assert.equal(g.player('a').chips, 0);
  assert.equal(g.pot, 1000 + 200);
  assert.equal(g.dealerUid, 'b');
  assert.equal(g.currentUid, 'b');
  assert.equal(g.totalChips, 2 * INITIAL_CHIPS + 1200);
});

test('every round end passes the deal on, in seat order: after a HIT, after a collision and after a dealer collision (TC-038)', () => {
  const hit = ranks(3, 9, 5, 1, 2); // 5 -> HIT
  const col = ranks(3, 9, 9, 1, 2); // 9 -> COLLISION
  const g = new Game(P, { dealerUid: 'a', chipLockAtPercent: [], shuffler: stacked(hit, col, col, col) });
  g.placeBet('a', 100);
  g.decide('a', 'SHOOT'); // HIT -> a deals no more
  assert.equal(g.dealerUid, 'b');
  assert.equal(g.currentUid, 'b'); // after a HIT play simply continues in turn order
  g.placeBet('b', 100);
  g.decide('b', 'PASS');
  g.placeBet('c', 100);
  const r1 = g.decide('c', 'SHOOT'); // collision by c (not the dealer)
  assert.equal(r1.extraMultiplier, 1);
  assert.equal(g.dealerUid, 'c'); // b -> c, no 連莊 for anyone
  assert.equal(g.currentUid, 'c');
  g.placeBet('c', 100);
  const r2 = g.decide('c', 'SHOOT'); // collision by the dealer c
  assert.equal(r2.extraMultiplier, 0.5);
  assert.equal(g.dealerUid, 'a'); // c -> a (wraps around)
  assert.equal(g.currentUid, 'a');
  assert.ok(g.pot > 0); // the pot is still carried
});

test('dealer rotation is strictly seat order after EVERY round end (never random, never stays), wrapping and skipping eliminated players', () => {
  const seats = ['a', 'b', 'c', 'd', 'e'].map((u) => ({ uid: u, nickname: u }));
  const orderOfDealers = (seed: number) => {
    const g = new Game(seats, { dealerUid: 'a', rng: mulberry32(seed) });
    const seen: string[] = [g.dealerUid];
    let guard = 0;
    while (g.status === 'PLAYING' && seen.length < 40 && guard++ < 5000) {
      const before = g.roundNumber;
      const dealerBefore = g.dealerUid;
      const rec = g.autoPlay();
      if (g.status !== 'PLAYING') break;
      if (g.roundNumber !== before) {
        // legal transitions: stays (collision by a normal player) or the NEXT alive seat after the old dealer
        const alive = seats.map((s) => s.uid).filter((u) => !g.player(u).eliminated);
        const all = seats.map((s) => s.uid);
        let i = all.indexOf(dealerBefore);
        let expected = dealerBefore;
        for (let k = 0; k < all.length; k++) {
          i = (i + 1) % all.length;
          if (alive.includes(all[i]!)) { expected = all[i]!; break; }
        }
        assert.equal(g.dealerUid, expected, 'dealer must follow seat order: ' + rec.result);
        seen.push(g.dealerUid);
      }
    }
    return seen;
  };
  // deterministic: same seed -> same dealer sequence; and it is not seed-dependent in structure
  assert.deepEqual(orderOfDealers(7), orderOfDealers(7));
  for (let seed = 1; seed <= 40; seed++) orderOfDealers(seed);
});

test('dealer: starts with the given player, rotates in seat order every round, skips eliminated', () => {
  const deck = ranks(3, 9, 5, 1, 2); // third card 5 -> HIT every round
  const g = new Game(P, { dealerUid: 'b', chipLockAtPercent: [], shuffler: stacked(deck, deck, deck, deck) });
  assert.equal(g.dealerUid, 'b');
  assert.equal(g.currentUid, 'b'); // the dealer plays first
  g.placeBet('b', 100);
  g.decide('b', 'SHOOT'); // HIT -> round ends, dealer rotates b -> c
  assert.equal(g.dealerUid, 'c');
  g.placeBet('c', 100);
  g.decide('c', 'SHOOT'); // HIT -> dealer rotates c -> a
  assert.equal(g.dealerUid, 'a');
  g.player('b').eliminated = true; // b is out: after a comes b (skipped) then c
  g.placeBet('a', 100);
  g.decide('a', 'SHOOT'); // HIT
  assert.equal(g.dealerUid, 'c');
  assert.throws(() => new Game(P, { dealerUid: 'nobody' }));
});

test('narrow gate: a non-dealer who hits pays out an extra half pot from the dealer (TC-043)', () => {
  // gate 7 and 9: only an 8 hits. Dealer 'a' opens with a PASS (pot 100), 'b' bets 500 and hits.
  const g = new Game(P, { dealerUid: 'a', chipLockAtPercent: [], shuffler: stacked(ranks(7, 9, 8, 1, 2), ranks(2, 8, 12, 12)) });
  g.placeBet('a', 100);
  g.decide('a', 'PASS');
  g.placeBet('b', 500);
  const r = g.decide('b', 'SHOOT');
  assert.equal(r.result, 'HIT');
  assert.equal(r.narrowGate, true);
  assert.equal(r.potAfterBet, 600);
  assert.equal(r.dealerBonus, 300); // half of 600
  assert.equal(g.player('b').chips, INITIAL_CHIPS - 500 + 600 + 300);
  assert.equal(g.player('a').chips, INITIAL_CHIPS - 100 - 300);
  assert.equal(g.totalChips, 3 * INITIAL_CHIPS); // pure transfer
  assert.equal(r.chipsSettled, g.player('b').chips);
  assert.equal(r.dealerChipsSettled, g.player('a').chips);
  assert.equal(g.dealerUid, 'b'); // and the deal passes on as for any round end
});

test('narrow gate bonus rounds to the nearest 50: pot 350 -> 200', () => {
  const g = new Game(P, { dealerUid: 'a', chipLockAtPercent: [], shuffler: stacked(ranks(7, 9, 8, 1, 2), ranks(2, 8, 12, 12)) });
  g.placeBet('a', 100);
  g.decide('a', 'PASS');
  g.placeBet('b', 250);
  assert.equal(g.decide('b', 'SHOOT').dealerBonus, 200); // pot after bet 350
});

test('narrow gate does NOT pay a bonus when the dealer hits, on a wide gate, or on a miss/collision', () => {
  // the dealer himself hits the narrow gate
  const g1 = new Game(P, { dealerUid: 'a', chipLockAtPercent: [], shuffler: stacked(ranks(7, 9, 8, 1, 2), ranks(2, 8, 12, 12)) });
  g1.placeBet('a', 500);
  const r1 = g1.decide('a', 'SHOOT');
  assert.equal(r1.result, 'HIT');
  assert.equal(r1.dealerBonus, 0);
  // a wide gate (3,9)
  const g2 = new Game(P, { dealerUid: 'a', chipLockAtPercent: [], shuffler: stacked(ranks(3, 9, 5, 1, 2), ranks(2, 8, 12, 12)) });
  g2.placeBet('a', 100);
  g2.decide('a', 'PASS');
  g2.placeBet('b', 500);
  const r2 = g2.decide('b', 'SHOOT');
  assert.equal(r2.narrowGate, false);
  assert.equal(r2.dealerBonus, 0);
  // narrow gate but a miss, and a collision
  const g3 = new Game(P, { dealerUid: 'a', chipLockAtPercent: [], shuffler: stacked(ranks(7, 9, 12, 7, 1, 2), ranks(2, 8, 12, 12)) });
  g3.placeBet('a', 100);
  g3.decide('a', 'PASS');
  g3.placeBet('b', 100);
  assert.equal(g3.decide('b', 'SHOOT').dealerBonus, 0); // 12 -> miss
  g3.placeBet('c', 100);
  assert.equal(g3.decide('c', 'SHOOT').dealerBonus, 0); // 7 -> collision
  assert.equal(g3.totalChips, 3 * INITIAL_CHIPS);
});

test('narrow gate: a dealer who cannot afford the bonus pays what is left and is eliminated', () => {
  const g = new Game(P, { dealerUid: 'a', chipLockAtPercent: [], shuffler: stacked(ranks(7, 9, 8, 1, 2), ranks(2, 8, 12, 12)) });
  g.player('a').chips = 200;
  g.placeBet('a', 100); // 100 left
  g.decide('a', 'PASS');
  g.placeBet('b', 500); // pot after bet 600 -> bonus would be 300, dealer only has 100
  const r = g.decide('b', 'SHOOT');
  assert.equal(r.dealerBonus, 100);
  assert.equal(r.dealerEliminated, true);
  assert.equal(g.player('a').eliminated, true);
  assert.equal(g.player('a').rank, 3);
  assert.equal(g.player('b').eliminated, false);
  assert.equal(g.totalChips, 2 * INITIAL_CHIPS + 200);
  assert.equal(g.dealerUid, 'b'); // an eliminated dealer cannot keep the seat; the deal moves on once
});

test('a dealer knocked out mid-round (own All-in miss) hands the seat on at once', () => {
  const g = new Game(P, { dealerUid: 'a', chipLockAtPercent: [], shuffler: stacked(ranks(3, 9, 12, 1, 2), ranks(2, 8, 12, 12)) });
  g.placeBet('a', INITIAL_CHIPS);
  g.decide('a', 'SHOOT'); // miss, all chips in the pot -> eliminated; the round goes on
  assert.equal(g.player('a').eliminated, true);
  assert.equal(g.roundNumber, 1);
  assert.equal(g.dealerUid, 'b');
});

test('the dealer (host) plays first in the very first round (not just whoever sits first)', () => {
  for (const d of ['a', 'b', 'c']) {
    const g = new Game(P, { dealerUid: d });
    assert.equal(g.dealerUid, d);
    assert.equal(g.currentUid, d);
  }
  assert.equal(new Game(P).currentUid, 'a'); // default dealer: first seat
});

test('exhausted deck with no HIT: the pot is kept, the deal passes on and the new dealer opens', () => {
  // 2 gate + 2 cards: two misses exhaust the deck; dealer 'c' goes first
  const g = new Game(P, { dealerUid: 'c', chipLockAtPercent: [], shuffler: stacked(ranks(3, 9, 12, 13), ranks(2, 8, 12, 12)) });
  g.placeBet('c', 500);
  assert.equal(g.decide('c', 'SHOOT').result, 'MISS');
  assert.equal(g.pot, 500); // same round, pot stays while the round is on
  g.placeBet('a', 700);
  const r = g.decide('a', 'SHOOT'); // 13 -> miss, deck empty -> round ends
  assert.equal(r.roundEnded, true);
  assert.equal(g.pot, 1200); // nobody wins it: carried
  assert.equal(g.player('c').chips, INITIAL_CHIPS - 500); // the dealer does NOT collect it any more
  assert.equal(g.dealerUid, 'a'); // c -> a
  assert.equal(g.currentUid, 'a');
});

test('HIT: shooter takes the pot, dealer gets nothing extra', () => {
  const g = new Game(P, { dealerUid: 'c', chipLockAtPercent: [], shuffler: stacked(ranks(3, 9, 5, 1, 2), ranks(2, 8, 12)) });
  assert.equal(g.currentUid, 'c'); // dealer first
  g.placeBet('c', 100);
  g.decide('c', 'PASS');
  g.placeBet('a', 500); // next seat after c wraps around to a
  const r = g.decide('a', 'SHOOT');
  assert.equal(r.result, 'HIT');
  assert.equal(r.dealerBonus, 0); // wide gate: no narrow-gate bonus
  assert.equal(g.player('a').chips, INITIAL_CHIPS - 500 + 600); // wins bet + the dealer's 100
  assert.equal(g.player('c').chips, INITIAL_CHIPS - 100); // dealer only lost his own bet
});

test('dealer who goes broke on a collision: role passes on, the new dealer opens, pot is kept', () => {
  const g = new Game(P, { dealerUid: 'a', chipLockAtPercent: [], shuffler: stacked(ranks(3, 9, 9, 1, 2), ranks(2, 8, 12, 12)) });
  g.player('a').chips = 500; // the dealer is also the shooter and will go broke on a collision
  g.placeBet('a', 500);
  g.decide('a', 'SHOOT'); // collision, 'a' has 0 chips -> eliminated
  assert.equal(g.player('a').eliminated, true);
  assert.equal(g.dealerUid, 'b'); // next in seat order takes over
  assert.equal(g.currentUid, 'b'); // and goes first
  assert.equal(g.pot, 500); // kept for the next round
  assert.equal(g.player('b').chips, INITIAL_CHIPS); // nothing paid out
  assert.equal(g.totalChips, 2 * INITIAL_CHIPS + 500); // conserved
});

test('MISS and PASS keep the same round and gate (TC-031)', () => {
  const g = new Game(P, { chipLockAtPercent: [], shuffler: stacked(ranks(3, 9, 12, 1, 2)) });
  g.placeBet('a', 500);
  const r = g.decide('a', 'SHOOT');
  assert.equal(r.result, 'MISS');
  assert.equal(r.roundEnded, false);
  assert.equal(g.roundNumber, 1);
  g.placeBet('b', 500);
  assert.equal(g.decide('b', 'PASS').roundEnded, false);
  assert.equal(g.roundNumber, 1);
});

test('record keeps the stake: potAfterBet is the pot after the bet, before settlement', () => {
  const g = new Game(P, { chipLockAtPercent: [], shuffler: stacked(ranks(3, 9, 5, 1, 2), ranks(2, 8, 12, 12)) });
  g.placeBet('a', 700);
  g.decide('a', 'PASS');
  g.placeBet('b', 300);
  const r = g.decide('b', 'SHOOT'); // HIT: pot is emptied, but the stake shown must be 1000
  assert.equal(r.result, 'HIT');
  assert.equal(r.potAfterBet, 1000);
  assert.equal(r.potAfter, 0);
});

test('a shot can never happen without a bet (autoPlay and manual)', () => {
  for (let seed = 1; seed <= 20; seed++) {
    const g = new Game(P, { rng: mulberry32(seed) });
    assert.equal(code(() => g.decide(g.currentUid, 'SHOOT')), 'BET_REQUIRED');
    let n = 0;
    while (g.status === 'PLAYING' && n++ < 5000) {
      const before = g.pot;
      const r = g.autoPlay();
      assert.ok(r.bet >= 50 && r.potAfterBet === before + r.bet && r.potAfterBet >= 50);
    }
  }
});

test('actions after finish / wrong player rejected', () => {
  const g = new Game(P.slice(0, 2), { chipLockAtPercent: [], shuffler: stacked(ranks(3, 9, 12, 1)) });
  g.placeBet('a', INITIAL_CHIPS);
  g.decide('a', 'SHOOT'); // a busts -> only b left
  assert.equal(g.status, 'FINISHED');
  assert.equal(code(() => g.placeBet('b', 50)), 'GAME_FINISHED');
});

test('final ranking by reverse elimination order (TC-025)', () => {
  const g = new Game(P, { chipLockAtPercent: [], shuffler: stacked(ranks(3, 9, 12, 12, 12)) });
  g.placeBet('a', INITIAL_CHIPS);
  g.decide('a', 'SHOOT'); // a out first -> rank 3
  g.placeBet('b', INITIAL_CHIPS);
  g.decide('b', 'SHOOT'); // b out second -> rank 2, c wins
  assert.equal(g.status, 'FINISHED');
  assert.deepEqual(
    g.ranking().map((r) => [r.uid, r.rank]),
    [
      ['c', 1],
      ['b', 2],
      ['a', 3],
    ],
  );
});

test('autoPlay: bet within 50..5000, multiple of 50, All-in cap (TC-016/017)', () => {
  for (let seed = 1; seed <= 50; seed++) {
    const g = new Game(P, { rng: mulberry32(seed) });
    g.player('a').chips = 120 + (seed % 2) * 30; // tiny stack, multiple of 50? keep realistic below
    g.player('a').chips = 100;
    const before = g.player('a').chips;
    const rec = g.autoPlay();
    assert.ok(rec.isAuto);
    assert.ok(rec.bet >= 50 && rec.bet <= Math.min(5000, before));
    assert.equal(rec.bet % 50, 0);
    if (rec.bet === before) assert.equal(rec.isAllIn, true);
  }
});

test('autoPlay obeys no-consecutive-PASS and keeps an existing bet (timeout)', () => {
  const g = new Game(P, { rng: () => 0.9, chipLockAtPercent: [], shuffler: stacked(ranks(3, 9, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12)) });
  g.player('a').lastAction = 'PASS';
  g.placeBet('a', 700); // human bet, then timed out
  const rec = g.autoPlay();
  assert.equal(rec.bet, 700);
  assert.equal(rec.action, 'SHOOT');
  assert.equal(rec.isAuto, true);
});

test('invariant fuzz: chips conserved, never negative, matches finish with valid ranking', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const n = 2 + (seed % 11);
    const players = Array.from({ length: n }, (_, i) => ({ uid: 'u' + i, nickname: 'p' + i }));
    const g = new Game(players, { rng: mulberry32(seed) });
    const total = n * INITIAL_CHIPS;
    let steps = 0;
    while (g.status === 'PLAYING') {
      assert.ok(++steps < 500_000, 'game should terminate');
      g.autoPlay();
      assert.equal(g.totalChips, total);
      assert.ok(g.pot >= 0 && g.players.every((p) => p.chips >= 0));
    }
    const ranks = g.ranking().map((r) => r.rank);
    assert.deepEqual(ranks, Array.from({ length: n }, (_, i) => i + 1));
    assert.equal(g.ranking()[0]!.uid, g.players.find((p) => !p.eliminated)!.uid);
  }
});

// ---------------- chip locking (spec 4.3.1) ----------------

/** A fresh two-player game whose deck has exactly `left` cards, so the used-% is known. */
function gameWithDeck(left: number) {
  const g = new Game(P, { rng: mulberry32(11) });
  g.deck = g.deck.slice(0, left);
  return g;
}

test('chip lock thresholds are 15% / 20% / 25% of the deck used, and at most 3 chips ever lock (TC-046)', () => {
  assert.deepEqual([...CHIP_LOCK_AT_PERCENT], [15, 20, 25]);
  assert.deepEqual([...CHIP_VALUES], [50, 100, 500, 1000]);
  // cards left -> used % -> smallest open chip   (52-card deck: 1 card = 1.92%)
  const table: [number, number][] = [
    [50, 50], //  3.8% used (just the gate)
    [46, 50], // 11.5%
    [45, 50], // 13.5% < 15%
    [44, 100], // 15.4% >= 15% -> 50 locked
    [42, 100], // 19.2% < 20%
    [41, 500], // 21.2% >= 20% -> 100 locked
    [40, 500], // 23.1% < 25%
    [39, 1000], // 25.0% >= 25% -> 500 locked
    [30, 1000],
    [5, 1000],
    [1, 1000], // the 1000 chip is never locked
  ];
  for (const [left, minChip] of table) assert.equal(gameWithDeck(left).minChip, minChip, left + ' cards left');
  assert.deepEqual(gameWithDeck(39).lockedChips, [50, 100, 500]);
  assert.deepEqual(gameWithDeck(44).lockedChips, [50]);
  assert.deepEqual(gameWithDeck(50).lockedChips, []);
});

test('a locked chip cannot be used: bets must be a multiple of the smallest open chip (TC-047)', () => {
  const g = gameWithDeck(44); // 50 locked -> multiples of 100
  const uid = g.currentUid;
  assert.equal(code(() => g.placeBet(uid, 50)), 'BET_CHIP_LOCKED');
  assert.equal(code(() => g.placeBet(uid, 150)), 'BET_CHIP_LOCKED');
  assert.doesNotThrow(() => g.placeBet(uid, 200));

  const g2 = gameWithDeck(41); // 50 and 100 locked -> multiples of 500
  assert.equal(code(() => g2.placeBet(g2.currentUid, 100)), 'BET_CHIP_LOCKED');
  assert.equal(code(() => g2.placeBet(g2.currentUid, 700)), 'BET_CHIP_LOCKED'); // 700 is not made of 500s/1000s
  assert.doesNotThrow(() => g2.placeBet(g2.currentUid, 1500));

  const g3 = gameWithDeck(39); // only the 1000 chip: multiples of 1000
  assert.equal(code(() => g3.placeBet(g3.currentUid, 500)), 'BET_CHIP_LOCKED');
  assert.doesNotThrow(() => g3.placeBet(g3.currentUid, 3000));
});

test('All-in is always allowed, even when the chips do not add up to the open chips (never stuck)', () => {
  const g = gameWithDeck(39); // only multiples of 1000
  const p = g.player(g.currentUid);
  p.chips = 250; // less than the smallest open chip
  g.pot = 0;
  assert.doesNotThrow(() => g.placeBet(g.currentUid, 250));
  assert.equal(p.chips, 0);

  const g2 = gameWithDeck(39);
  g2.player(g2.currentUid).chips = 2750; // not a multiple of 1000
  assert.equal(code(() => g2.placeBet(g2.currentUid, 2000 + 50)), 'BET_CHIP_LOCKED'); // 2050 is neither
  assert.doesNotThrow(() => g2.placeBet(g2.currentUid, 2750)); // but all of it is
});

test('the lock eases again on a new round (fresh deck)', () => {
  const g2 = gameWithDeck(39);
  assert.equal(g2.minChip, 1000);
  g2.deck = g2.deck.concat(new Game(P, { rng: mulberry32(3) }).deck); // simulate a reshuffled, fuller deck
  assert.equal(g2.minChip, 50);
});

test('autoPlay (computer) only bets with chips that are still open (fuzz across whole games)', () => {
  let locked = 0;
  for (let seed = 1; seed <= 60; seed++) {
    const g = new Game(P, { rng: mulberry32(seed) });
    let n = 0;
    while (g.status === 'PLAYING' && n++ < 3000) {
      const min = g.minChip;
      const chipsBefore = g.player(g.currentUid).chips;
      const rec = g.autoPlay();
      if (min > 50) locked++;
      const allIn = rec.bet === chipsBefore;
      assert.ok(allIn || (rec.bet >= min && rec.bet % min === 0), `bet ${rec.bet} with min chip ${min}`);
      assert.ok(rec.bet <= 5000 || allIn);
      assert.deepEqual(g.checkIntegrity(), []);
    }
  }
  assert.ok(locked > 100, 'locking was actually exercised: ' + locked);
});

test('lock level is derived from the deck, so a restored game has it too (no hidden state)', () => {
  const g = gameWithDeck(41);
  const back = Game.restore(g.snapshot(), { rng: mulberry32(1) });
  assert.equal(back.minChip, 500);
  assert.deepEqual(back.lockedChips, [50, 100]);
});

// ---------------- dealer loot: the dealer hits a narrow gate (spec 7.2.2) ----------------

const FOUR = ['a', 'b', 'c', 'd'].map((u) => ({ uid: u, nickname: u }));

test('dealer hits a narrow gate: half the pot is collected from the other players, split evenly (the 15,000 example)', () => {
  const g = new Game(FOUR, { dealerUid: 'a', chipLockAtPercent: [], shuffler: stacked(ranks(7, 9, 8, 1, 2), ranks(2, 8, 12, 12)) });
  g.placeBet('a', 15000); // pot 15000, dealer plays first
  const r = g.decide('a', 'SHOOT'); // 8 between 7 and 9: a narrow gate hit by the dealer
  assert.equal(r.result, 'HIT');
  assert.equal(r.narrowGate, true);
  assert.equal(r.potAfterBet, 15000);
  assert.equal(r.lootShare, 2500); // half the pot 7500 / 3 other players
  assert.equal(r.dealerLoot, 7500);
  assert.deepEqual(r.lootFrom.map((l) => [l.uid, l.paid]), [['b', 2500], ['c', 2500], ['d', 2500]]);
  assert.equal(r.dealerBonus, 0); // the other rule (dealer pays a non-dealer's hit) is not involved
  assert.equal(g.player('a').chips, INITIAL_CHIPS - 15000 + 15000 + 7500);
  for (const u of ['b', 'c', 'd']) assert.equal(g.player(u).chips, INITIAL_CHIPS - 2500);
  assert.equal(r.chipsSettled, g.player('a').chips);
  assert.equal(g.totalChips, 4 * INITIAL_CHIPS); // a pure transfer
  assert.equal(g.dealerUid, 'b'); // and the deal passes on as for every round end
});

test('dealer loot: each share is rounded to a multiple of 50', () => {
  const g = new Game(FOUR, { dealerUid: 'a', chipLockAtPercent: [], shuffler: stacked(ranks(7, 9, 8, 1, 2), ranks(2, 8, 12, 12)) });
  g.placeBet('a', 1000); // half = 500; 500 / 3 = 166.67 -> nearest 50 = 150
  const r = g.decide('a', 'SHOOT');
  assert.equal(r.lootShare, 150);
  assert.equal(r.dealerLoot, 450);
  assert.ok(r.lootFrom.every((l) => l.paid % 50 === 0));
  assert.equal(roundTo50(166.67), 150);
  assert.equal(roundTo50(175), 200); // exact tie rounds up
  assert.equal(roundTo50(2500), 2500);
});

test('dealer loot: a player who cannot pay their share pays everything and is knocked out; eliminated players are not charged', () => {
  const g = new Game(FOUR, { dealerUid: 'a', chipLockAtPercent: [], shuffler: stacked(ranks(7, 9, 8, 1, 2), ranks(2, 8, 12, 12)) });
  g.player('b').chips = 1000; // owes 2500, has 1000
  g.player('d').eliminated = true; // already out: not one of the "other players"
  g.player('d').chips = 0;
  g.player('d').rank = 4;
  g.order = ['a', 'b', 'c', 'd'];
  g.placeBet('a', 15000);
  const r = g.decide('a', 'SHOOT');
  assert.equal(r.lootShare, 3750); // 7500 / 2 remaining others (b, c)
  assert.deepEqual(r.lootFrom.map((l) => l.uid), ['b', 'c']);
  assert.equal(r.lootFrom.find((l) => l.uid === 'b')!.paid, 1000); // all b had
  assert.equal(r.lootFrom.find((l) => l.uid === 'c')!.paid, 3750);
  assert.deepEqual(r.lootEliminated, ['b']);
  assert.equal(g.player('b').eliminated, true);
  assert.equal(g.player('b').chips, 0);
  assert.equal(r.dealerLoot, 4750);
  assert.equal(g.player('d').chips, 0); // untouched
  // chips are only transferred: a(100000) + b(1000) + c(100000) + d(0) were in play at the start
  assert.equal(g.totalChips, 2 * INITIAL_CHIPS + 1000);
});

test('dealer loot happens only when the DEALER hits a NARROW gate (not a wide gate, not a miss, not another player)', () => {
  // wide gate 3..9, dealer hits
  const g1 = new Game(FOUR, { dealerUid: 'a', chipLockAtPercent: [], shuffler: stacked(ranks(3, 9, 5, 1, 2), ranks(2, 8, 12, 12)) });
  g1.placeBet('a', 1000);
  assert.equal(g1.decide('a', 'SHOOT').dealerLoot, 0);
  // narrow gate, the dealer misses
  const g2 = new Game(FOUR, { dealerUid: 'a', chipLockAtPercent: [], shuffler: stacked(ranks(7, 9, 12, 1, 2), ranks(2, 8, 12, 12)) });
  g2.placeBet('a', 1000);
  assert.equal(g2.decide('a', 'SHOOT').dealerLoot, 0);
  // narrow gate hit by a NON-dealer: the dealer pays (the other rule), nobody is looted
  const g3 = new Game(FOUR, { dealerUid: 'a', chipLockAtPercent: [], shuffler: stacked(ranks(7, 9, 8, 1, 2), ranks(2, 8, 12, 12)) });
  g3.placeBet('a', 100);
  g3.decide('a', 'PASS');
  g3.placeBet('b', 500);
  const r3 = g3.decide('b', 'SHOOT');
  assert.equal(r3.dealerLoot, 0);
  assert.ok(r3.dealerBonus > 0);
});

// ---------------- two-deck option ----------------

test('deckCopies option: 1 (default) or 2; anything else is rejected', () => {
  assert.equal(new Game(P).deckCopies, 1);
  assert.equal(new Game(P).deckSize, 52);
  const g2 = new Game(P, { deckCopies: 2, rng: mulberry32(2) });
  assert.equal(g2.deckCopies, 2);
  assert.equal(g2.deckSize, 104);
  assert.ok(g2.remainingCards <= 102 && g2.remainingCards >= 90);
  assert.deepEqual(g2.checkIntegrity(), []); // two copies of a card are fine with two decks
  assert.equal(code(() => new Game(P, { deckCopies: 3 })), 'BAD_DECK');
  assert.equal(code(() => new Game(P, { deckCopies: 0 })), 'BAD_DECK');
});

test('two decks: the integrity check allows 2 copies but flags 3; one deck flags 2', () => {
  const g2 = new Game(P, { deckCopies: 2, rng: mulberry32(2) });
  const c = g2.deck[0]!;
  g2.deck.push({ ...c }, { ...c }, { ...c });
  assert.ok(g2.checkIntegrity().some((p) => p.includes('appears')));
  const g1 = new Game(P, { rng: mulberry32(2) });
  const d = g1.deck[0]!;
  g1.deck.push({ ...d });
  assert.ok(g1.checkIntegrity().some((p) => p.includes('appears')));
});

test('two decks: chip-lock thresholds are scaled to 7.5% / 10% / 12.5% (same number of cards as one deck) (TC-054)', () => {
  assert.deepEqual([...CHIP_LOCK_AT_PERCENT_BY_DECKS[1]!], [15, 20, 25]);
  assert.deepEqual([...CHIP_LOCK_AT_PERCENT_BY_DECKS[2]!], [7.5, 10, 12.5]);
  const twoDeck = (left: number) => {
    const g = new Game(P, { deckCopies: 2, rng: mulberry32(11) });
    g.deck = g.deck.slice(0, left);
    return g.minChip;
  };
  const oneDeck = (left: number) => gameWithDeck(left).minChip;
  // cards USED when each chip locks is the same for both: 8, 11 and 13 cards out of the box
  const table2: [number, number][] = [[97, 50], [96, 100], [94, 100], [93, 500], [92, 500], [91, 1000], [50, 1000], [1, 1000]];
  for (const [left, min] of table2) assert.equal(twoDeck(left), min, left + ' of 104 left');
  assert.equal(oneDeck(45), 50); //  7 cards used
  assert.equal(oneDeck(44), 100); //  8 used
  assert.equal(twoDeck(97), 50); //  7 used
  assert.equal(twoDeck(96), 100); //  8 used
  assert.equal(oneDeck(41), 500); // 11 used
  assert.equal(twoDeck(93), 500); // 11 used
  assert.equal(oneDeck(39), 1000); // 13 used
  assert.equal(twoDeck(91), 1000); // 13 used
});

test('two decks: a snapshot restores with its deck count and thresholds; an old snapshot without the field is single-deck', () => {
  const g = new Game(P, { deckCopies: 2, rng: mulberry32(4) });
  g.deck = g.deck.slice(0, 93);
  const back = Game.restore(g.snapshot(), { rng: mulberry32(1) });
  assert.equal(back.deckCopies, 2);
  assert.equal(back.deckSize, 104);
  assert.equal(back.minChip, 500);
  const old: any = new Game(P, { rng: mulberry32(5) }).snapshot();
  delete old.deckCopies;
  assert.equal(Game.restore(old).deckCopies, 1);
});
