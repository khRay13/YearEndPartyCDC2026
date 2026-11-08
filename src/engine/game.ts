import { createDeck, judgeShot, shuffle } from './cards.ts';
import type { Card, Rng, ShotResult } from './cards.ts';

export const INITIAL_CHIPS = 100_000;
export const CHIP_UNIT = 50;
export const MIN_BET = 50;
export const AUTO_MAX_BET = 5_000;
/** The four chip denominations, smallest first. */
export const CHIP_VALUES = [50, 100, 500, 1000] as const;
/**
 * Chip locking (spec 4.3.1). As the deck gets used up the smallest chip still allowed is locked, so the pot grows
 * faster and nobody drags a long round out with tiny bets. Thresholds are the % of the deck already out (gate and
 * flipped cards) at the moment of betting; the 1,000 chip is never locked (at most 3 of the 4 chips).
 *
 * Why so low: a round ends on every HIT or COLLISION, so rounds are short (about 2.6 cards flipped on average;
 * simulated over 3.9M rounds, only 2.3% of bets happen with 25% of the deck gone, 0.8% at 30%, 0.1% at 40%).
 * Steps like 25/50/75 would barely trigger. 15/20/25 (eased by 5 points from the first 10/15/20) affects
 * ~13% / ~5% / ~2% of all bets.
 */
export const CHIP_LOCK_AT_PERCENT = [15, 20, 25] as const;

/**
 * Lock thresholds per deck count. With two decks the same round still flips ~2.6 cards, but a card is only half
 * as many percent of the deck, so the percentages are scaled to keep the same share of bets affected
 * (see the simulation notes in SPEC 4.3.1).
 */
export const CHIP_LOCK_AT_PERCENT_BY_DECKS: Record<number, readonly number[]> = {
  1: CHIP_LOCK_AT_PERCENT,
  2: [7.5, 10, 12.5],
};
/** The host picks one of these in the waiting room (default 1 deck = 52 cards, 2 decks = 104). */
export const DECK_OPTIONS = [1, 2] as const;
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 12;
/**
 * How many standard 52-card decks are shuffled together. The game is played with ONE (52 cards): two decks
 * (104) were tried and made the pace too slow. Everything else derives from this constant.
 */
export const DECK_COPIES = 1;
export const DECK_SIZE = 52 * DECK_COPIES;
/** Rounds to the nearest multiple of 50 (exact ties round up). */
export function roundTo50(amount: number): number {
  return Math.floor(amount / 50 + 0.5) * 50;
}
/** A 窄門 (narrow gate) has exactly one rank strictly between the posts, e.g. 7 and 9. */
export const NARROW_GATE_SPAN = 2;

/**
 * Half of an amount, rounded to the nearest multiple of 50 (exact ties round up).
 * Used for the dealer's reduced collision payment and the dealer's narrow-gate bonus.
 */
export function halfPot50(amount: number): number {
  return Math.floor(amount / 100 + 0.5) * 50;
}

export type Action = 'SHOOT' | 'PASS';
export type TurnResult = ShotResult | 'PASS';

export class GameError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'GameError';
    this.code = code;
  }
}

export interface PlayerStats {
  hit: number;
  miss: number;
  collision: number;
  pass: number;
  autoPlay: number;
  allIn: number;
  totalBet: number;
}

export interface PlayerState {
  uid: string;
  nickname: string;
  chips: number;
  eliminated: boolean;
  /** Final rank, set at elimination (or to 1 for the winner). */
  rank: number | null;
  lastAction: Action | null;
  stats: PlayerStats;
}

export interface TurnRecord {
  turnId: number;
  roundNumber: number;
  uid: string;
  bet: number;
  action: Action;
  thirdCard: Card | null;
  result: TurnResult;
  extraPayment: number;
  potAfter: number;
  isAuto: boolean;
  isAllIn: boolean;
  eliminated: boolean;
  /** Gate cards in force when this turn was played (the live gate may change after it). */
  gate: [Card, Card];
  /** Pot after the shot was settled (what players watched; e.g. grown by a collision payment). */
  potSettled: number;
  /** Dealer for the round that follows this turn (differs from dealerUid when the seat changed). */
  nextDealerUid: string;
  /** 0.5 when the dealer collided (pays half the pot, to the nearest 50), otherwise 1 (the full pot). */
  extraMultiplier: 1 | 0.5;
  /** The hit landed on a narrow gate (posts differ by exactly 2). */
  narrowGate: boolean;
  /** Extra chips the dealer paid the shooter for hitting the dealer's narrow gate (0 if none). */
  dealerBonus: number;
  /** The dealer hit a narrow gate: half the pot is collected from the other players, split evenly (spec 7.2.2). */
  lootShare: number;
  dealerLoot: number;
  lootFrom: { uid: string; paid: number }[];
  /** Players knocked out because they could not pay their share. */
  lootEliminated: string[];
  /** Dealer's chips after that bonus, and whether paying it knocked the dealer out. */
  dealerChipsSettled: number;
  dealerEliminated: boolean;
  /** The player's chips right after placing the bet / after the shot was settled (before any dealer payout). */
  chipsAfterBet: number;
  chipsSettled: number;
  /** Dealer in force during this turn. */
  dealerUid: string;
  /** Pot right after this turn's bet, before the shot was settled (what players saw at stake). */
  potAfterBet: number;
  /** True when this turn ended the round (HIT / COLLISION / deck exhausted) and a new one began. */
  roundEnded: boolean;
}

export interface GameOptions {
  rng?: Rng;
  /** Who deals first (the room host). Dealers then rotate in seat order each round. */
  dealerUid?: string;
  /** Override shuffling (tests). Receives a fresh ordered deck; first element is drawn first. */
  shuffler?: (deck: Card[]) => Card[];
  /** Override the chip-lock thresholds in % of the deck used (tests pass [] to turn locking off). */
  chipLockAtPercent?: readonly number[];
  /** How many 52-card decks are shuffled together: 1 (default) or 2. */
  deckCopies?: number;
}

export interface GameSnapshot {
  deckCopies?: number;
  players: PlayerState[];
  order: string[];
  status: 'PLAYING' | 'FINISHED';
  pot: number;
  roundNumber: number;
  deck: Card[];
  gate: [Card, Card];
  history: TurnRecord[];
  eliminationOrder: string[];
  dealerUid: string;
  turn: CurrentTurn;
  turnIdx: number;
  turnCounter: number;
}

interface CurrentTurn {
  uid: string;
  bet: number | null;
  betIsAuto: boolean;
}

export class Game {
  players: PlayerState[];
  order: string[];
  status: 'PLAYING' | 'FINISHED' = 'PLAYING';
  pot = 0;
  roundNumber = 0;
  deck: Card[] = [];
  gate: [Card, Card];
  history: TurnRecord[] = [];
  /** Uids in order of elimination (first eliminated first). */
  eliminationOrder: string[] = [];
  turn: CurrentTurn;
  /** 莊家: collects the pot whenever a round ends without a HIT. */
  dealerUid: string;

  private rng: Rng;
  private chipLockAt: readonly number[] = CHIP_LOCK_AT_PERCENT;
  /** 52-card decks shuffled together this game (1 or 2). */
  deckCopies = 1;
  private shuffler: (deck: Card[]) => Card[];
  private turnIdx = 0;
  private turnCounter = 0;

  constructor(players: { uid: string; nickname: string }[], opts: GameOptions = {}) {
    if (players.length < MIN_PLAYERS) throw new GameError('NOT_ENOUGH_PLAYERS', '至少需要 2 位玩家');
    if (players.length > MAX_PLAYERS) throw new GameError('TOO_MANY_PLAYERS', '最多 12 位玩家');
    if (new Set(players.map((p) => p.uid)).size !== players.length) {
      throw new GameError('DUPLICATE_UID', 'UID 不可重複');
    }
    this.rng = opts.rng ?? Math.random;
    const copies = opts.deckCopies ?? 1;
    if (!(DECK_OPTIONS as readonly number[]).includes(copies)) throw new GameError('BAD_DECK', '牌組只能是 1 副或 2 副');
    this.deckCopies = copies;
    this.chipLockAt = opts.chipLockAtPercent ?? CHIP_LOCK_AT_PERCENT_BY_DECKS[copies]!;
    this.shuffler = opts.shuffler ?? ((d) => shuffle(d, this.rng));
    this.players = players.map((p) => ({
      uid: p.uid,
      nickname: p.nickname,
      chips: INITIAL_CHIPS,
      eliminated: false,
      rank: null,
      lastAction: null,
      stats: { hit: 0, miss: 0, collision: 0, pass: 0, autoPlay: 0, allIn: 0, totalBet: 0 },
    }));
    this.order = players.map((p) => p.uid);
    if (opts.dealerUid && !this.order.includes(opts.dealerUid)) throw new GameError('UNKNOWN_PLAYER', '莊家不在玩家名單');
    this.dealerUid = opts.dealerUid ?? this.order[0]!;
    this.gate = this.startRound();
    // The dealer (the room host) plays first.
    this.turnIdx = this.order.indexOf(this.dealerUid);
    this.turn = { uid: this.dealerUid, bet: null, betIsAuto: false };
  }

  get currentUid(): string {
    return this.turn.uid;
  }

  get remainingCards(): number {
    return this.deck.length;
  }

  /** Total cards in this game's deck: 52 per deck. */
  get deckSize(): number {
    return 52 * this.deckCopies;
  }

  /** % of the deck already out of the box (gate, discarded gate tries and flipped cards). */
  get deckUsedPercent(): number {
    return ((this.deckSize - this.deck.length) / this.deckSize) * 100;
  }

  /** How many of the smallest chips are locked right now (0..3). */
  get lockedChipCount(): number {
    const used = this.deckUsedPercent;
    return Math.min(CHIP_VALUES.length - 1, this.chipLockAt.filter((t) => used >= t).length);
  }

  /** The chips that are locked right now, smallest first. */
  get lockedChips(): number[] {
    return CHIP_VALUES.slice(0, this.lockedChipCount);
  }

  /** The smallest chip still allowed: every bet must be a multiple of it (unless it is an All-in). */
  get minChip(): number {
    return CHIP_VALUES[this.lockedChipCount]!;
  }

  /** Id of the turn currently awaiting action (monotonic; used for de-duplication). */
  get currentTurnId(): number {
    return this.turnCounter + 1;
  }

  /** Serializable snapshot (includes the secret deck: server-side persistence only). */
  snapshot(): GameSnapshot {
    return structuredClone({
      deckCopies: this.deckCopies,
      players: this.players,
      order: this.order,
      status: this.status,
      pot: this.pot,
      roundNumber: this.roundNumber,
      deck: this.deck,
      gate: this.gate,
      history: this.history,
      eliminationOrder: this.eliminationOrder,
      dealerUid: this.dealerUid,
      turn: this.turn,
      turnIdx: this.turnIdx,
      turnCounter: this.turnCounter,
    });
  }

  static restore(s: GameSnapshot, opts: GameOptions = {}): Game {
    const g = Object.create(Game.prototype) as Game;
    const d = structuredClone(s);
    g.rng = opts.rng ?? Math.random;
    g.shuffler = opts.shuffler ?? ((deck) => shuffle(deck, g.rng));
    Object.assign(g, d);
    g.deckCopies = d.deckCopies ?? 1; // snapshots from before the deck option existed were single-deck
    g.chipLockAt = opts.chipLockAtPercent ?? CHIP_LOCK_AT_PERCENT_BY_DECKS[g.deckCopies]!;
    g.dealerUid ??= g.order[0]!;
    return g;
  }

  /** Consistency checks (spec 15.2/15.3). Returns a list of problems; empty = healthy. */
  checkIntegrity(): string[] {
    const problems: string[] = [];
    const expected = this.players.length * INITIAL_CHIPS;
    if (this.totalChips !== expected) problems.push(`chips not conserved: ${this.totalChips} != ${expected}`);
    if (this.pot < 0) problems.push('negative pot');
    for (const p of this.players) {
      if (p.chips < 0) problems.push(`negative chips: ${p.uid}`);
      if (p.chips % CHIP_UNIT !== 0) problems.push(`chips not multiple of 50: ${p.uid}`);
    }
    // Two decks: every suit+rank may appear at most twice among the cards still in the deck + the gate.
    const counts = new Map<string, number>();
    for (const c of [...this.deck, ...this.gate]) counts.set(c.suit + c.rank, (counts.get(c.suit + c.rank) ?? 0) + 1);
    for (const [k, n] of counts) if (n > this.deckCopies) problems.push(`card ${k} appears ${n} times (max ${this.deckCopies})`);
    if (this.deck.length > this.deckSize - 2) problems.push('deck too large');
    if (this.gate[0].rank === this.gate[1].rank) problems.push('gate cards equal rank');
    return problems;
  }

  player(uid: string): PlayerState {
    const p = this.players.find((x) => x.uid === uid);
    if (!p) throw new GameError('UNKNOWN_PLAYER', '玩家不存在');
    return p;
  }

  /** Total chips in play (players + pot); constant over the whole match. */
  get totalChips(): number {
    return this.players.reduce((s, p) => s + p.chips, 0) + this.pot;
  }

  /** Final ranking, best first. Only meaningful once FINISHED. */
  ranking(): { uid: string; nickname: string; rank: number; chips: number }[] {
    return this.players
      .filter((p) => p.rank !== null)
      .map((p) => ({ uid: p.uid, nickname: p.nickname, rank: p.rank!, chips: p.chips }))
      .sort((a, b) => a.rank - b.rank);
  }

  // ---- player actions ----------------------------------------------------

  placeBet(uid: string, amount: number, isAuto = false): void {
    this.assertTurn(uid);
    if (this.turn.bet !== null) throw new GameError('BET_ALREADY_PLACED', '本回合已下注');
    const p = this.player(uid);
    if (!Number.isInteger(amount) || amount < MIN_BET) throw new GameError('BET_TOO_LOW', '最低下注 50');
    if (amount % CHIP_UNIT !== 0) throw new GameError('BET_NOT_MULTIPLE', '下注金額須為 50 的倍數');
    if (amount > p.chips) throw new GameError('BET_EXCEEDS_CHIPS', '下注超過持有籌碼');
    // Locked chips cannot be used, so a bet must be made of the chips still open, i.e. be a multiple of the
    // smallest open chip. All-in is always allowed, whatever the chips add up to.
    const min = this.minChip;
    if (amount !== p.chips && (amount < min || amount % min !== 0)) {
      throw new GameError('BET_CHIP_LOCKED', `目前最小籌碼為 ${min}，下注須為 ${min} 的倍數（或 All-in）`);
    }
    p.chips -= amount;
    this.pot += amount;
    p.stats.totalBet += amount;
    this.turn.bet = amount;
    this.turn.betIsAuto = isAuto;
  }

  decide(uid: string, action: Action, isAuto = false): TurnRecord {
    this.assertTurn(uid);
    if (this.turn.bet === null) throw new GameError('BET_REQUIRED', '必須先下注');
    const p = this.player(uid);
    if (action === 'PASS' && p.lastAction === 'PASS') {
      throw new GameError('CONSECUTIVE_PASS', '上一回合已 PASS，本回合必須射龍門');
    }
    const bet = this.turn.bet;
    const potAfterBet = this.pot;
    const chipsAfterBet = p.chips;
    const dealerAtTurn = this.dealerUid;
    const isDealer = uid === dealerAtTurn;
    const auto = isAuto || this.turn.betIsAuto;
    const isAllIn = p.chips === 0;
    let thirdCard: Card | null = null;
    let result: TurnResult = 'PASS';
    let extra = 0;
    let extraMultiplier: 1 | 0.5 = 1;
    let narrowGate = false;
    let dealerBonus = 0;
    let lootShare = 0;
    let dealerLoot = 0;
    const lootFrom: { uid: string; paid: number }[] = [];

    if (action === 'PASS') {
      p.stats.pass++;
    } else {
      thirdCard = this.deck.shift()!;
      result = judgeShot(this.gate[0].rank, this.gate[1].rank, thirdCard.rank);
      if (result === 'HIT') {
        p.chips += this.pot;
        this.pot = 0;
        p.stats.hit++;
        // 窄門: when a non-dealer hits a narrow gate the dealer pays them half the pot on top (spec 7.2.1).
        narrowGate = Math.abs(this.gate[0].rank - this.gate[1].rank) === NARROW_GATE_SPAN;
        if (narrowGate && !isDealer) {
          const dealer = this.player(dealerAtTurn);
          dealerBonus = Math.min(halfPot50(potAfterBet), dealer.chips);
          dealer.chips -= dealerBonus;
          p.chips += dealerBonus;
        } else if (narrowGate && isDealer) {
          // The dealer hit a narrow gate: half the pot he wins is collected from the other players, split evenly
          // and rounded to 50 (spec 7.2.2). Someone who cannot pay their share pays everything they have.
          const di = this.order.indexOf(dealerAtTurn);
          const seatsAfterDealer = [...this.order.slice(di + 1), ...this.order.slice(0, di)];
          const others = seatsAfterDealer.map((u) => this.player(u)).filter((x) => !x.eliminated);
          if (others.length > 0) {
            lootShare = roundTo50(halfPot50(potAfterBet) / others.length);
            for (const o of others) {
              const paid = Math.min(lootShare, o.chips);
              o.chips -= paid;
              p.chips += paid;
              dealerLoot += paid;
              lootFrom.push({ uid: o.uid, paid });
            }
          }
        }
      } else if (result === 'MISS') {
        p.stats.miss++;
      } else {
        // A collision costs the full pot; a collision by the dealer costs only half of it, rounded to the
        // nearest 50 (spec 7.4.1). Never more than the player holds.
        extraMultiplier = isDealer ? 0.5 : 1;
        const owed = isDealer ? halfPot50(this.pot) : this.pot;
        extra = Math.min(owed, p.chips);
        p.chips -= extra;
        this.pot += extra;
        p.stats.collision++;
      }
    }
    p.lastAction = action;
    if (auto) p.stats.autoPlay++;
    if (isAllIn) p.stats.allIn++;

    const chipsSettled = p.chips;
    const dealerChipsSettled = this.player(dealerAtTurn).chips;

    // Elimination is judged only after settlement (spec 6.4 / 10.1). The dealer can also be knocked out
    // by paying the narrow-gate bonus.
    let eliminated = false;
    let dealerEliminated = false;
    if (p.chips === 0) {
      this.eliminate(p);
      eliminated = true;
    }
    const dealerPlayer = this.player(dealerAtTurn);
    if (dealerPlayer.chips === 0 && !dealerPlayer.eliminated) {
      this.eliminate(dealerPlayer);
      dealerEliminated = true;
    }
    const lootEliminated: string[] = [];
    for (const l of lootFrom) {
      const o = this.player(l.uid);
      if (o.chips === 0 && !o.eliminated) {
        this.eliminate(o);
        lootEliminated.push(o.uid);
      }
    }

    // Round end: HIT (shooter took the pot), COLLISION (pot kept for the next round) or deck exhausted
    // (pot kept too). Whatever ended it, the deal passes to the next player in seat order (spec 7.6).
    const roundEnded = result === 'HIT' || result === 'COLLISION' || this.deck.length === 0;
    const potSettled = this.pot;
    // A dealer who is out cannot keep the seat: it passes on at once, unless the round ends now (that rotates).
    if (this.player(this.dealerUid).eliminated && !roundEnded) this.advanceDealer();

    const record: TurnRecord = {
      turnId: ++this.turnCounter,
      roundNumber: this.roundNumber,
      uid,
      bet,
      action,
      thirdCard,
      result,
      extraPayment: extra,
      extraMultiplier,
      narrowGate,
      lootShare,
      dealerLoot,
      lootFrom,
      lootEliminated,
      dealerBonus,
      dealerChipsSettled,
      dealerEliminated,
      nextDealerUid: this.dealerUid,
      potAfter: this.pot,
      potSettled,
      chipsAfterBet,
      chipsSettled,
      dealerUid: dealerAtTurn,
      potAfterBet,
      isAuto: auto,
      isAllIn,
      eliminated,
      gate: [this.gate[0], this.gate[1]],
      roundEnded: false,
    };
    record.roundEnded = roundEnded && !(this.players.filter((x) => !x.eliminated).length <= 1);
    this.history.push(record);
    // After a collision (or an exhausted deck) the new dealer opens the next round; after a HIT play simply
    // continues in turn order.
    this.afterTurn(roundEnded, result !== 'HIT');
    record.nextDealerUid = this.dealerUid; // dealer for the round that follows this turn
    return record;
  }

  /**
   * Computer play for the current player (offline / timeout / kicked / bot).
   * Keeps an already-placed bet; otherwise bets random 50..5000 capped at chips.
   */
  autoPlay(): TurnRecord {
    const uid = this.turn.uid;
    const p = this.player(uid);
    if (this.turn.bet === null) {
      // random multiple of the smallest open chip, up to 5,000; capped at the player's chips (an All-in)
      const min = this.minChip;
      const random = (Math.floor(this.rng() * Math.floor(AUTO_MAX_BET / min)) + 1) * min;
      this.placeBet(uid, Math.min(random, p.chips), true);
    }
    const action: Action = p.lastAction === 'PASS' ? 'SHOOT' : this.rng() < 0.5 ? 'SHOOT' : 'PASS';
    return this.decide(uid, action, true);
  }

  // ---- internals ---------------------------------------------------------

  private assertTurn(uid: string): void {
    if (this.status !== 'PLAYING') throw new GameError('GAME_FINISHED', '遊戲已結束');
    const p = this.player(uid);
    if (p.eliminated) throw new GameError('ELIMINATED', '玩家已淘汰');
    if (uid !== this.turn.uid) throw new GameError('NOT_YOUR_TURN', '尚未輪到該玩家');
  }

  private afterTurn(roundEnded: boolean, dealerOpens = false): void {
    const alive = this.players.filter((p) => !p.eliminated);
    if (alive.length <= 1) {
      this.status = 'FINISHED';
      if (alive[0]) alive[0].rank = 1;
      return;
    }
    // Settlement is done: the deal passes on, cards are collected and reshuffled, a new gate is revealed.
    if (roundEnded) {
      this.advanceDealer();
      this.gate = this.startRound();
      if (dealerOpens) {
        this.turnIdx = this.order.indexOf(this.dealerUid);
        this.turn = { uid: this.dealerUid, bet: null, betIsAuto: false };
        return;
      }
    }
    do {
      this.turnIdx = (this.turnIdx + 1) % this.order.length;
    } while (this.player(this.order[this.turnIdx]!).eliminated);
    this.turn = { uid: this.order[this.turnIdx]!, bet: null, betIsAuto: false };
  }

  private eliminate(pl: PlayerState): void {
    pl.eliminated = true;
    pl.rank = this.players.filter((x) => !x.eliminated).length + 1;
    this.eliminationOrder.push(pl.uid);
  }

  /** Dealer rotates to the next remaining player in seat order. */
  private advanceDealer(): void {
    const n = this.order.length;
    let i = this.order.indexOf(this.dealerUid);
    for (let k = 0; k < n; k++) {
      i = (i + 1) % n;
      if (!this.player(this.order[i]!).eliminated) {
        this.dealerUid = this.order[i]!;
        return;
      }
    }
  }

  /**
   * Shuffle a fresh deck and draw two gate cards (spec 5.4). Only equal ranks are thrown away and redrawn.
   * Consecutive ranks (8 and 9: two posts and no goal between them) ARE allowed on purpose: nobody can hit,
   * so such a round only ends in a miss or a collision, and the pot can be pumped up to wipe out whoever
   * collides.
   */
  private startRound(): [Card, Card] {
    this.roundNumber++;
    this.deck = this.shuffler(createDeck(this.deckCopies));
    for (;;) {
      const a = this.deck.shift();
      const b = this.deck.shift();
      if (!a || !b) throw new GameError('DECK_EXHAUSTED', '牌堆不足以建立龍門');
      if (a.rank !== b.rank) return [a, b];
    }
  }
}
