export type Suit = 'S' | 'H' | 'D' | 'C';
export type Rng = () => number;

export interface Card {
  suit: Suit;
  /** A=1, 2..10, J=11, Q=12, K=13 */
  rank: number;
}

const SUITS: Suit[] = ['S', 'H', 'D', 'C'];

/** `copies` standard 52-card decks combined (the game plays with 2 = 104 cards, see DECK_COPIES). */
export function createDeck(copies = 1): Card[] {
  const deck: Card[] = [];
  for (let n = 0; n < copies; n++) {
    for (const suit of SUITS) {
      for (let rank = 1; rank <= 13; rank++) deck.push({ suit, rank });
    }
  }
  return deck;
}

/** Fisher-Yates shuffle; returns a new array. */
export function shuffle(deck: Card[], rng: Rng): Card[] {
  const a = deck.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

export type ShotResult = 'HIT' | 'MISS' | 'COLLISION';

/** Strict-interval judgement (spec 5.5). */
export function judgeShot(gateA: number, gateB: number, third: number): ShotResult {
  const low = Math.min(gateA, gateB);
  const high = Math.max(gateA, gateB);
  if (third === low || third === high) return 'COLLISION';
  if (third > low && third < high) return 'HIT';
  return 'MISS';
}
