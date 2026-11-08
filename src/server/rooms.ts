import { randomBytes } from 'node:crypto';
import { DECK_OPTIONS, Game, GameError, MAX_PLAYERS, MIN_PLAYERS } from '../engine/game.ts';
import type { Action, GameSnapshot, TurnRecord } from '../engine/game.ts';
import type { Rng } from '../engine/cards.ts';

export type RoomStatus = 'WAITING' | 'READY' | 'PLAYING' | 'FINISHED' | 'CLOSED';

export interface RoomPlayer {
  uid: string;
  nickname: string;
  isBot: boolean;
  /** Kicked mid-game: stays in the match, always computer-played. */
  kicked: boolean;
  /** Session token (cookie) bound to this player; null for bots. */
  sid: string | null;
  /** Player-controlled 代打 switch: the computer plays this player's turns while on. */
  autoMode?: boolean;
  /** Pressed 離開 during a running match: back on the home screen, computer plays until they rejoin. */
  left?: boolean;
  /** Host-assigned observer: watches the match but does not play (set in the waiting room). */
  observer?: boolean;
  /** Matches this player has won in this room (shown in the waiting room, survives rematches). */
  wins?: number;
  /**
   * After a match: false while the player is still looking at the result table, true once they pressed 再玩一局
   * and are back in the waiting room. Undefined (never been in a result phase / joined later) counts as back.
   */
  back?: boolean;
}

export interface ChatMessage {
  seq: number;
  uid: string;
  nickname: string;
  text: string;
  ts: number;
}

/** The host has this long to come back to the waiting room after the first other player did (spec 3.4.3). */
export const HOST_RETURN_MS = 5 * 60 * 1000;

/** The host has this long to start the game; then the host role passes to a random player who is here. */
export const START_LIMIT_MS = 5 * 60 * 1000;
/** Seconds left at which the System account announces the countdown in the chat: every minute, then the last 10 seconds. */
export const START_REMIND_AT = [240, 180, 120, 60, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1] as const;
/** The chat author for automatic announcements. Players cannot use this name (see cleanNickname). */
export const SYSTEM_UID = 'system';
export const SYSTEM_NAME = 'System';
export const CHAT_MAX_LENGTH = 200;
export const CHAT_MIN_INTERVAL_MS = 700;
const CHAT_KEEP = 100;
const CHAT_SHOWN = 50;

export interface GameEvent {
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  ts: number;
}

export interface Room {
  roomId: string;
  /** 52-card decks the host chose in the waiting room: 1 (default) or 2. */
  deckCopies: number;
  /** Host option: may two posts of consecutive rank be dealt? */
  allowConsecutive: boolean;
  /** Waiting-room chat (text only). */
  chat: ChatMessage[];
  chatSeq: number;
  /** The finished match, kept for players who are still on the result table after the room became a waiting room. */
  resultGame: Game | null;
  /** Uids in the order they pressed 再玩一局 (the host succession queue). */
  backOrder: string[];
  /** When the host loses the room to the first player who came back; null when nobody is waiting on the host. */
  lobbyDeadline: number | null;
  /** When the waiting-room countdown ends and the host role is handed to a random player; null outside the waiting room. */
  startDeadline: number | null;
  /** Smallest START_REMIND_AT value already announced in this countdown (9999 = none yet). */
  startRemind: number;
  hostUid: string;
  status: RoomStatus;
  players: RoomPlayer[];
  game: Game | null;
  bannedSids: string[];
  createdAt: number;
  updatedAt: number;
  /** While the clock is before this, fast-forward is held off so the shot that knocked out the last human plays in full (transient). */
  fastHoldUntil?: number;
  /** When the current turn's clock starts (after reveal animation pause). */
  turnStartAt: number;
  events: GameEvent[];
  eventSeq: number;
  /** Recently seen client action ids (idempotency). */
  seenActions: string[];
}

export interface RoomSnapshot extends Omit<Room, 'game' | 'resultGame'> {
  game: GameSnapshot | null;
  resultGame: GameSnapshot | null;
}

const isBack = (p: RoomPlayer): boolean => p.back !== false;

export const BOT_NAMES = [
  '漆黑烈焰使', '暗影終結者', '紅蓮之瞳', '虛空行者', '次元斬', '墮天使·路西', '絕對零度', '雷霆審判者',
  '夜刃', '闇之支配者', '黃昏騎士', '終焉之龍', '蒼穹逆神', '不死鳳凰', '血色月光', '禁忌魔導士',
  '暗黑龍王', '星辰破壞者', '幻影刺客', '滅世魔瞳', '無盡深淵', '嗜血狂狼', '銀翼魔女', '爆裂魔法師',
  '邪王真眼', '千年孤獨者', '時空旅者', '黑曜石之牙', '斷罪之劍', '深淵凝視者', '焚天煉獄', '霸王色霸氣',
  '覺醒的右手', '漆黑之翼', '黯夜君王', '極光審判', '魔眼殺手', '暴風騎士', '冥府使者', '龍騎士·零',
];

export const TURN_TIME_MS = 30_000;
/** A room nobody is connected to is thrown away after this long without activity. */
export const ROOM_IDLE_MS = 30 * 60_000;
const MAX_EVENTS = 400;

export class RoomManager {
  rooms = new Map<string, Room>();
  /** sid -> binding. A device (cookie) is bound to one room at a time. */
  sessions = new Map<string, { roomId: string; uid: string }>();
  private rng: Rng;
  private now: () => number;
  /** uid -> time of the last chat message (rate limit; not persisted). */
  private lastChatAt = new Map<string, number>();

  private hostReturnMs: number;
  private startLimitMs: number;

  constructor(opts: { rng?: Rng; now?: () => number; hostReturnMs?: number; startLimitMs?: number } = {}) {
    this.startLimitMs = opts.startLimitMs ?? START_LIMIT_MS;
    this.rng = opts.rng ?? Math.random;
    this.now = opts.now ?? Date.now;
    this.hostReturnMs = opts.hostReturnMs ?? HOST_RETURN_MS;
  }

  // ---- lookup ------------------------------------------------------------

  getRoom(roomId: string): Room {
    const r = this.rooms.get(roomId.toUpperCase());
    if (!r || r.status === 'CLOSED') throw new GameError('ROOM_NOT_FOUND', '找不到房間');
    return r;
  }

  binding(sid: string): { room: Room; uid: string } | null {
    const b = this.sessions.get(sid);
    if (!b) return null;
    const room = this.rooms.get(b.roomId);
    if (!room || room.status === 'CLOSED' || !room.players.some((p) => p.uid === b.uid)) {
      this.sessions.delete(sid);
      return null;
    }
    return { room, uid: b.uid };
  }

  // ---- create / join / leave ---------------------------------------------

  createRoom(sid: string, nickname: string): { room: Room; uid: string } {
    const nick = this.cleanNickname(nickname);
    this.detach(sid);
    let roomId: string;
    do {
      roomId = String(Math.floor(this.rng() * 1_000_000)).padStart(6, '0');
    } while (this.rooms.has(roomId));
    const uid = this.newUid();
    const t = this.now();
    const room: Room = {
      roomId,
      deckCopies: 1,
      allowConsecutive: true,
      chat: [],
      chatSeq: 0,
      resultGame: null,
      backOrder: [],
      lobbyDeadline: null,
      startDeadline: null,
      startRemind: 9999,
      hostUid: uid,
      status: 'WAITING',
      players: [{ uid, nickname: nick, isBot: false, kicked: false, sid }],
      game: null,
      bannedSids: [],
      createdAt: t,
      updatedAt: t,
      turnStartAt: 0,
      events: [],
      eventSeq: 0,
      seenActions: [],
    };
    this.rooms.set(roomId, room);
    this.armStart(room);
    this.sessions.set(sid, { roomId, uid });
    this.emit(room, 'PLAYER_JOINED', { uid, nickname: nick });
    return { room, uid };
  }

  joinRoom(sid: string, roomId: string, nickname: string): { room: Room; uid: string } {
    const room = this.getRoom(String(roomId));
    // Re-entry by cookie keeps the same UID.
    const existing = this.binding(sid);
    if (existing && existing.room === room) return existing;
    if (room.bannedSids.includes(sid)) throw new GameError('BANNED', '你已被房主剔除');
    if (room.status === 'PLAYING' || room.status === 'FINISHED') {
      throw new GameError('GAME_STARTED', '遊戲已開始，無法加入');
    }
    if (room.players.length >= MAX_PLAYERS) throw new GameError('ROOM_FULL', '房間已滿（12 人）');
    const nick = this.cleanNickname(nickname);
    this.detach(sid);
    const uid = this.newUid();
    room.players.push({ uid, nickname: nick, isBot: false, kicked: false, sid });
    this.sessions.set(sid, { roomId: room.roomId, uid });
    this.refreshStatus(room);
    this.announce(room, `${nick} 已加入`);
    this.emit(room, 'PLAYER_JOINED', { uid, nickname: nick });
    return { room, uid };
  }

  /** Explicit leave. Lobby: removed. In a running match: stays seated, computer plays. */
  leave(sid: string): Room | null {
    const b = this.binding(sid);
    if (!b) return null;
    const { room, uid } = b;
    const seated = room.players.find((x) => x.uid === uid)!;
    if (room.status === 'PLAYING' && !seated.observer) {
      // Stay seated in the match (cookie binding kept so they can come back); the computer plays.
      const p = room.players.find((x) => x.uid === uid)!;
      p.left = true;
      p.autoMode = true;
      this.emit(room, 'PLAYER_LEFT', { uid });
      return room;
    }
    this.announce(room, `${seated.nickname} 已退出`);
    this.removePlayer(room, uid);
    this.sessions.delete(sid);
    this.emit(room, 'PLAYER_LEFT', { uid });
    this.afterRemoval(room, uid);
    return room;
  }

  /** Come back to a match after pressing 離開 (same cookie, same UID). */
  rejoin(sid: string): Room {
    const b = this.binding(sid);
    if (!b) throw new GameError('NOT_IN_ROOM', '沒有可返回的房間');
    const p = b.room.players.find((x) => x.uid === b.uid)!;
    if (p.left) {
      p.left = false;
      p.autoMode = false;
      this.emit(b.room, 'PLAYER_ONLINE', { uid: b.uid });
    }
    return b.room;
  }

  /** The room a device left mid-match and may still return to, if any. */
  rejoinable(sid: string): string | null {
    const b = this.binding(sid);
    if (!b || b.room.status !== 'PLAYING') return null;
    return b.room.players.find((x) => x.uid === b.uid)?.left ? b.room.roomId : null;
  }

  kick(sid: string, targetUid: string): Room {
    const { room } = this.requireHost(sid);
    const target = room.players.find((p) => p.uid === targetUid);
    if (!target) throw new GameError('UNKNOWN_PLAYER', '玩家不存在');
    if (target.uid === room.hostUid) throw new GameError('CANNOT_KICK_HOST', '不能剔除房主');
    if (room.status === 'PLAYING' && !target.observer) {
      target.kicked = true;
      this.emit(room, 'ROOM_UPDATED', { kicked: targetUid });
      return room;
    }
    this.announce(room, `${target.nickname} 已被踢除`);
    this.removePlayer(room, targetUid);
    if (target.sid) {
      room.bannedSids.push(target.sid);
      this.sessions.delete(target.sid);
    }
    this.emit(room, 'PLAYER_LEFT', { uid: targetUid, kicked: true });
    this.afterRemoval(room, targetUid);
    return room;
  }

  /** Toggle the player's own 代打 switch (spec 8.6). */
  setAuto(sid: string, on: boolean): Room {
    const b = this.binding(sid);
    if (!b) throw new GameError('NOT_IN_ROOM', '你不在任何房間內');
    const { room, uid } = b;
    if (room.status !== 'PLAYING' || !room.game) throw new GameError('BAD_STATE', '遊戲尚未進行');
    if (!room.game.players.some((x) => x.uid === uid)) throw new GameError('NOT_A_PLAYER', '觀察者不能操作');
    if (room.game.player(uid).eliminated) throw new GameError('ELIMINATED', '玩家已淘汰');
    const p = room.players.find((x) => x.uid === uid)!;
    p.autoMode = !!on;
    this.emit(room, 'ROOM_UPDATED', { uid, autoMode: !!on });
    return room;
  }

  /** Host marks a joined player as an observer (watches, does not play) or puts them back in the game. */
  setObserver(sid: string, targetUid: string, observer: boolean): Room {
    const { room } = this.requireHost(sid);
    if (room.status !== 'WAITING' && room.status !== 'READY') throw new GameError('BAD_STATE', '遊戲已開始，無法更改');
    const target = room.players.find((p) => p.uid === targetUid);
    if (!target) throw new GameError('UNKNOWN_PLAYER', '玩家不存在');
    if (target.isBot) throw new GameError('BOT_CANNOT_OBSERVE', '電腦玩家不能設為觀察者');
    if (target.uid === room.hostUid) throw new GameError('HOST_CANNOT_OBSERVE', '房主必須參賽');
    if (!!target.observer !== !!observer) this.announce(room, observer ? `${target.nickname} 現在是觀眾` : `${target.nickname} 已重新參戰`);
    target.observer = !!observer;
    this.refreshStatus(room);
    this.emit(room, 'ROOM_UPDATED', { uid: targetUid, observer: !!observer });
    return room;
  }

  /**
   * 再玩一局 (result table): this player goes back to the waiting room, on their own, without waiting for anybody.
   * The first player back turns the room into a waiting room for everyone who follows; players who have not
   * pressed it yet keep seeing the result table. If the host is not among the first to come back the room starts
   * a clock: after HOST_RETURN_MS the host role passes to the first player who came back (see checkHostSuccession).
   */
  playAgain(sid: string): Room {
    const b = this.binding(sid);
    if (!b) throw new GameError('NOT_IN_ROOM', '你不在任何房間內');
    const { room, uid } = b;
    const me = room.players.find((p) => p.uid === uid)!;
    const resultPhase = room.status === 'FINISHED' || ((room.status === 'WAITING' || room.status === 'READY') && !!room.resultGame);
    if (!resultPhase) throw new GameError('BAD_STATE', '現在不能再玩一局');
    if (isBack(me)) return room; // already back: pressing twice changes nothing

    if (room.status === 'FINISHED') {
      // first one back: the room is a waiting room from now on. Players who walked away or were kicked mid-match go.
      const gone = room.players.filter((p) => !p.isBot && (p.left || p.kicked));
      for (const p of gone) {
        if (p.sid) {
          this.sessions.delete(p.sid);
          if (p.kicked) room.bannedSids.push(p.sid);
        }
      }
      room.players = room.players.filter((p) => !gone.includes(p));
      room.backOrder = room.backOrder.filter((u) => room.players.some((p) => p.uid === u));
      for (const p of room.players) {
        p.autoMode = false;
        p.left = false;
        p.kicked = false;
      }
      if (!room.players.some((p) => p.uid === room.hostUid)) this.transferHostIfNeeded(room, room.hostUid);
      room.resultGame = room.game; // the others still look at it
      room.game = null;
      room.turnStartAt = 0;
      room.status = 'WAITING';
      room.lobbyDeadline = uid === room.hostUid ? null : this.now() + this.hostReturnMs;
      this.armStart(room);
    }
    me.back = true;
    if (!room.backOrder.includes(uid)) room.backOrder.push(uid);
    if (uid === room.hostUid) room.lobbyDeadline = null; // the host is home: nobody takes over
    this.refreshStatus(room);
    this.pruneResult(room);
    this.emit(room, 'ROOM_UPDATED', { uid, back: true });
    return room;
  }

  /** The first player (in the order they came back) who is still here and can take over as host. */
  private nextBackPlayer(room: Room, excludeUid: string): RoomPlayer | null {
    for (const u of room.backOrder) {
      const p = room.players.find((x) => x.uid === u);
      if (p && !p.isBot && p.uid !== excludeUid && isBack(p)) return p;
    }
    return null;
  }

  /** Nobody is looking at the result table any more: the finished match can be forgotten. */
  private pruneResult(room: Room): void {
    if (room.resultGame && room.players.filter((p) => !p.isBot).every(isBack)) room.resultGame = null;
  }

  /**
   * Called when room.lobbyDeadline passes. If the host still has not come back, the host role goes to the first
   * player who did (and, should that player leave later, to the next one in line: see transferHostIfNeeded).
   * Returns true when the host changed.
   */
  checkHostSuccession(room: Room, now = this.now()): boolean {
    if (!room.lobbyDeadline || now < room.lobbyDeadline) return false;
    room.lobbyDeadline = null;
    const host = room.players.find((p) => p.uid === room.hostUid);
    if (!host || isBack(host)) return false;
    const next = this.nextBackPlayer(room, room.hostUid);
    if (!next) return false;
    room.hostUid = next.uid;
    if (next.observer) next.observer = false; // the host always plays
    this.armStart(room);
    this.emit(room, 'ROOM_UPDATED', { newHost: next.uid, reason: 'host-timeout' });
    return true;
  }

  // ---- waiting-room start countdown --------------------------------------

  private inLobby(room: Room): boolean {
    return room.status === 'WAITING' || room.status === 'READY';
  }

  /** (Re)start the countdown: the host has START_LIMIT_MS to begin the game. */
  private armStart(room: Room): void {
    room.startDeadline = this.inLobby(room) ? this.now() + this.startLimitMs : null;
    room.startRemind = 9999;
  }

  /** A join / leave / kick / observer notice in the waiting-room chat (the chat only exists in the waiting room). */
  private announce(room: Room, text: string): void {
    if (this.inLobby(room)) this.systemSay(room, text);
  }

  /** An automatic announcement in the waiting-room chat, authored by System. */
  private systemSay(room: Room, text: string): void {
    room.chat.push({ seq: ++room.chatSeq, uid: SYSTEM_UID, nickname: SYSTEM_NAME, text, ts: this.now() });
    if (room.chat.length > CHAT_KEEP) room.chat.splice(0, room.chat.length - CHAT_KEEP);
    room.updatedAt = this.now();
  }

  /** Humans who could take over as host: here in the waiting room, not kicked, not the host. Computers never inherit. */
  private heirs(room: Room): RoomPlayer[] {
    return room.players.filter((p) => !p.isBot && !p.kicked && p.uid !== room.hostUid && isBack(p));
  }

  /** When the countdown next has something to do (an announcement, or the end); null when it is not running. */
  nextStartTickAt(room: Room): number | null {
    if (!this.inLobby(room) || !room.startDeadline) return null;
    const next = START_REMIND_AT.find((t) => t < room.startRemind);
    return next === undefined ? room.startDeadline : room.startDeadline - next * 1000;
  }

  /**
   * Run whatever the countdown owes by now: announce the minute / last-10-seconds reminders, and when the time is
   * up pass the host role to a random other player who is in the waiting room. Returns true when something changed.
   */
  tickStart(room: Room, isConnected: (uid: string) => boolean = () => true): boolean {
    if (!this.inLobby(room) || !room.startDeadline) return false;
    const now = this.now();
    if (now >= room.startDeadline) {
      const pool = this.heirs(room);
      const online = pool.filter((p) => isConnected(p.uid));
      const cands = online.length ? online : pool;
      if (!cands.length) {
        // Only the host is left (computers do not count): time is up, the host is sent out and the room is recycled.
        const host = room.players.find((p) => p.uid === room.hostUid);
        if (host?.sid) this.sessions.delete(host.sid);
        room.startDeadline = null;
        room.status = 'CLOSED';
        this.emit(room, 'ROOM_UPDATED', { closed: true, reason: 'start-timeout' });
        return true;
      }
      const next = cands[Math.floor(this.rng() * cands.length)]!;
      room.hostUid = next.uid;
      next.observer = false; // the host always plays
      room.lobbyDeadline = null;
      this.armStart(room);
      this.systemSay(room, `時間到！房主改由 ${next.nickname} 擔任，倒數重新開始`);
      this.emit(room, 'ROOM_UPDATED', { newHost: next.uid, reason: 'start-timeout' });
      return true;
    }
    const left = Math.ceil((room.startDeadline - now) / 1000);
    const due = START_REMIND_AT.filter((t) => left <= t && t < room.startRemind);
    if (!due.length) return false;
    const t = Math.min(...due); // several can be overdue after a hiccup: announce only the current one
    room.startRemind = t;
    // the words say what will really happen: another human to hand the room to, or nobody (only the host is a
    // person, computers do not count) and the room is recycled
    const recycle = this.heirs(room).length === 0;
    this.systemSay(room, recycle
      ? (t >= 60 ? `⚠ 還有 ${t / 60} 分鐘沒有開始遊戲，房間即將回收` : `⚠ 房間即將回收 ${t}`)
      : (t >= 60 ? `⏱ 開局倒數：還有 ${t / 60} 分鐘，時間到會自動換房主` : `⏱ 開局倒數 ${t}`));
    return true;
  }

  /** Waiting-room chat: plain text only, short, rate-limited. */
  chat(sid: string, text: unknown): Room {
    const b = this.binding(sid);
    if (!b) throw new GameError('NOT_IN_ROOM', '你不在任何房間內');
    const { room, uid } = b;
    if (room.status !== 'WAITING' && room.status !== 'READY') throw new GameError('CHAT_CLOSED', '聊天室只在等候房開放');
    if (!isBack(room.players.find((p) => p.uid === uid)!)) throw new GameError('CHAT_CLOSED', '先按「再玩一局」回到等候房才能聊天');
    // text only: control characters and line breaks become spaces; the client renders it as text, never as HTML
    const clean =
      typeof text === 'string'
        ? Array.from(text.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').trim()).slice(0, CHAT_MAX_LENGTH).join('').trim()
        : '';
    if (!clean) throw new GameError('CHAT_EMPTY', '訊息不能是空的');
    const now = this.now();
    if (now - (this.lastChatAt.get(uid) ?? 0) < CHAT_MIN_INTERVAL_MS) throw new GameError('CHAT_TOO_FAST', '說話太快了，請稍等一下');
    this.lastChatAt.set(uid, now);
    const nickname = room.players.find((p) => p.uid === uid)!.nickname;
    room.chat.push({ seq: ++room.chatSeq, uid, nickname, text: clean, ts: now });
    if (room.chat.length > CHAT_KEEP) room.chat.splice(0, room.chat.length - CHAT_KEEP);
    room.updatedAt = now;
    return room;
  }

  /** Host decides whether consecutive-rank posts may be dealt; only before the game starts. */
  setAllowConsecutive(sid: string, allow: boolean): Room {
    const { room } = this.requireHost(sid);
    if (room.status !== 'WAITING' && room.status !== 'READY') throw new GameError('BAD_STATE', '遊戲已開始，無法更改設定');
    room.allowConsecutive = !!allow;
    this.emit(room, 'ROOM_UPDATED', { allowConsecutive: room.allowConsecutive });
    return room;
  }

  /** Host picks how many decks (1 or 2) the match is played with; only before the game starts. */
  setDeckCopies(sid: string, copies: number): Room {
    const { room } = this.requireHost(sid);
    if (room.status !== 'WAITING' && room.status !== 'READY') throw new GameError('BAD_STATE', '遊戲已開始，無法更改牌組');
    if (!(DECK_OPTIONS as readonly number[]).includes(copies)) throw new GameError('BAD_DECK', '牌組只能是 1 副或 2 副');
    room.deckCopies = copies;
    this.emit(room, 'ROOM_UPDATED', { deckCopies: copies });
    return room;
  }

  addBot(sid: string): Room {
    const { room } = this.requireHost(sid);
    if (room.status !== 'WAITING' && room.status !== 'READY') throw new GameError('BAD_STATE', '遊戲已開始');
    if (room.players.length >= MAX_PLAYERS) throw new GameError('ROOM_FULL', '房間已滿（12 人）');
    const nickname = this.pickBotName(room);
    const uid = this.newUid();
    room.players.push({ uid, nickname, isBot: true, kicked: false, sid: null });
    this.refreshStatus(room);
    this.announce(room, `${nickname} 已加入`);
    this.emit(room, 'PLAYER_JOINED', { uid, nickname, isBot: true });
    return room;
  }

  /** Random edgy name that is not already used in this room. */
  private pickBotName(room: Room): string {
    const used = new Set(room.players.map((p) => p.nickname));
    const free = BOT_NAMES.filter((n) => !used.has(n));
    if (free.length) return free[Math.floor(this.rng() * free.length)]!;
    return BOT_NAMES[Math.floor(this.rng() * BOT_NAMES.length)]! + (room.players.length + 1);
  }

  // ---- host --------------------------------------------------------------

  /** Random new host among eligible players (spec 3.4). Returns false if none (room closes). */
  transferHostIfNeeded(room: Room, leavingUid: string, isConnected: (uid: string) => boolean = () => true): boolean {
    if (room.hostUid !== leavingUid) return true;
    // after a match: the next player in line (in the order they came back) takes over, not a random one
    const queued = this.nextBackPlayer(room, leavingUid);
    if (queued) {
      room.hostUid = queued.uid;
      if (queued.observer && room.status !== 'PLAYING') queued.observer = false;
      room.lobbyDeadline = null;
      this.armStart(room);
      this.emit(room, 'ROOM_UPDATED', { newHost: queued.uid, reason: 'queue' });
      return true;
    }
    const alive = (p: RoomPlayer) => room.game?.players.find((x) => x.uid === p.uid)?.eliminated !== true;
    const everyone = room.players.filter((p) => !p.isBot && p.uid !== leavingUid && !p.kicked);
    const humans = everyone.some((p) => !p.observer) ? everyone.filter((p) => !p.observer) : everyone; // players first
    const inGame = room.game ? humans.filter(alive) : humans;
    const pool = inGame.length ? inGame : humans;
    const online = pool.filter((p) => isConnected(p.uid));
    const candidates = online.length ? online : pool;
    if (!candidates.length) return false;
    const next = candidates[Math.floor(this.rng() * candidates.length)]!;
    room.hostUid = next.uid;
    if (next.observer && room.status !== 'PLAYING') next.observer = false; // the host always plays
    this.armStart(room);
    this.emit(room, 'ROOM_UPDATED', { newHost: next.uid });
    return true;
  }

  start(sid: string): Room {
    const { room } = this.requireHost(sid);
    if (room.status !== 'WAITING' && room.status !== 'READY') throw new GameError('BAD_STATE', '無法開始遊戲');
    // Whoever is still looking at the last result table did not come back in time: they watch the new match.
    for (const p of room.players) {
      if (!p.isBot && !isBack(p)) {
        p.observer = true;
        p.back = true;
      }
    }
    room.resultGame = null;
    room.backOrder = [];
    room.lobbyDeadline = null;
    room.startDeadline = null;
    const active = room.players.filter((p) => !p.observer); // observers watch, they are not in the game
    if (active.length < MIN_PLAYERS) throw new GameError('NOT_ENOUGH_PLAYERS', '至少需要 2 位參賽玩家（觀察者不算）');
    const order = active.slice();
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      [order[i], order[j]] = [order[j]!, order[i]!];
    }
    room.game = new Game(order.map((p) => ({ uid: p.uid, nickname: p.nickname })), { rng: this.rng, dealerUid: active.some((p) => p.uid === room.hostUid) ? room.hostUid : active[0]!.uid, deckCopies: room.deckCopies ?? 1, allowConsecutive: room.allowConsecutive ?? true });
    room.status = 'PLAYING';
    room.turnStartAt = this.now() + 1500;
    this.emit(room, 'GAME_STARTED', { order: order.map((p) => p.uid) });
    this.emit(room, 'ROUND_STARTED', { round: 1 });
    this.emit(room, 'GATE_REVEALED', { gate: room.game.gate });
    this.emit(room, 'TURN_STARTED', { uid: room.game.currentUid, turnId: room.game.currentTurnId });
    return room;
  }

  // ---- gameplay (authoritative validation, spec 13.3 / 13.4) ---------------

  private actor(sid: string, turnId: number, actionId: unknown): { room: Room; game: Game; uid: string } {
    const b = this.binding(sid);
    if (!b) throw new GameError('NOT_IN_ROOM', '你不在任何房間內');
    const { room, uid } = b;
    const game = room.game;
    if (room.status !== 'PLAYING' || !game) throw new GameError('BAD_STATE', '遊戲尚未進行');
    if (!game.players.some((p) => p.uid === uid)) throw new GameError('NOT_A_PLAYER', '觀察者不能操作');
    const me = room.players.find((p) => p.uid === uid);
    if (me?.kicked) throw new GameError('KICKED', '你已被剔除');
    if (me?.autoMode) throw new GameError('AUTO_ON', '代打中，請先關閉代打');
    if (typeof actionId === 'string') {
      if (room.seenActions.includes(actionId)) throw new GameError('DUPLICATE_ACTION', '重複的操作');
      room.seenActions.push(actionId);
      if (room.seenActions.length > 200) room.seenActions.shift();
    }
    if (turnId !== game.currentTurnId) throw new GameError('STALE_TURN', '回合已變更');
    return { room, game, uid };
  }

  bet(sid: string, turnId: number, amount: number, actionId?: string): Room {
    const { room, game, uid } = this.actor(sid, turnId, actionId);
    game.placeBet(uid, amount);
    this.emit(room, 'BET_PLACED', { uid, amount });
    this.emit(room, 'POT_UPDATED', { pot: game.pot });
    this.emit(room, 'CHIPS_UPDATED', { uid, chips: game.player(uid).chips });
    if (game.player(uid).chips === 0) this.emit(room, 'ALL_IN', { uid, amount });
    return room;
  }

  decide(sid: string, turnId: number, action: Action, actionId?: string): TurnRecord {
    if (action !== 'SHOOT' && action !== 'PASS') throw new GameError('BAD_ACTION', '無效操作');
    const { room, game, uid } = this.actor(sid, turnId, actionId);
    const rec = game.decide(uid, action);
    this.afterRecord(room, rec);
    return rec;
  }

  /** Computer play for the current turn (offline / timeout / bot / kicked). */
  autoTurn(room: Room): TurnRecord {
    const game = room.game;
    if (!game || room.status !== 'PLAYING') throw new GameError('BAD_STATE', '遊戲尚未進行');
    const hadBet = game.turn.bet !== null; // a human who timed out may already have bet (and announced it)
    const rec = game.autoPlay();
    if (!hadBet && rec.isAllIn) this.emit(room, 'ALL_IN', { uid: rec.uid, amount: rec.bet });
    this.emit(room, 'AUTO_PLAYED', { uid: rec.uid, bet: rec.bet, allIn: rec.isAllIn, action: rec.action });
    this.afterRecord(room, rec);
    return rec;
  }

  private afterRecord(room: Room, rec: TurnRecord): void {
    const game = room.game!;
    const round = game.roundNumber;
    if (rec.action === 'PASS') {
      this.emit(room, 'PLAYER_PASSED', { uid: rec.uid });
    } else {
      this.emit(room, 'CARD_REVEALED', { uid: rec.uid, card: rec.thirdCard });
      this.emit(room, 'RESULT_UPDATED', {
        uid: rec.uid,
        result: rec.result,
        extraPayment: rec.extraPayment,
        card: rec.thirdCard,
      });
    }
    this.emit(room, 'POT_UPDATED', { pot: rec.potAfter });
    this.emit(room, 'CHIPS_UPDATED', { uid: rec.uid, chips: game.player(rec.uid).chips });
    if (rec.dealerBonus > 0) {
      this.emit(room, 'DEALER_PAID', { uid: rec.dealerUid, to: rec.uid, amount: rec.dealerBonus });
      this.emit(room, 'CHIPS_UPDATED', { uid: rec.dealerUid, chips: rec.dealerChipsSettled });
    }
    if (rec.dealerLoot > 0) {
      this.emit(room, 'DEALER_LOOT', { uid: rec.uid, total: rec.dealerLoot, share: rec.lootShare, from: rec.lootFrom });
      this.emit(room, 'CHIPS_UPDATED', { uid: rec.uid, chips: game.player(rec.uid).chips });
    }
    for (const uid of rec.lootEliminated) this.emit(room, 'PLAYER_ELIMINATED', { uid, rank: game.player(uid).rank });
    if (rec.eliminated) this.emit(room, 'PLAYER_ELIMINATED', { uid: rec.uid, rank: game.player(rec.uid).rank });
    if (rec.dealerEliminated) this.emit(room, 'PLAYER_ELIMINATED', { uid: rec.dealerUid, rank: game.player(rec.dealerUid).rank });
    if (rec.roundEnded) {
      this.emit(room, 'ROUND_ENDED', { round: rec.roundNumber, reason: rec.result, nextDealerUid: rec.nextDealerUid });
      this.emit(room, 'ROUND_STARTED', { round });
      this.emit(room, 'GATE_REVEALED', { gate: game.gate });
    }
    if (game.status === 'FINISHED') {
      room.status = 'FINISHED';
      for (const p of room.players) p.back = false; // everyone starts on the result table
      room.backOrder = [];
      room.lobbyDeadline = null;
      room.resultGame = null;
      const winner = room.players.find((p) => p.uid === game.ranking()[0]?.uid);
      if (winner) winner.wins = (winner.wins ?? 0) + 1; // the 勝場 count shown back in the waiting room
      this.emit(room, 'MATCH_FINISHED', { ranking: game.ranking(), winner: winner?.uid ?? null });
    } else {
      this.emit(room, 'TURN_STARTED', { uid: game.currentUid, turnId: game.currentTurnId });
    }
    const problems = game.checkIntegrity();
    if (problems.length) {
      this.emit(room, 'INTEGRITY_ERROR', { problems });
      console.error(`[integrity] room ${room.roomId}:`, problems);
    }
  }

  // ---- views --------------------------------------------------------------

  /** Per-viewer public state. Never includes the deck. */
  view(room: Room, viewerUid: string | null, isConnected: (uid: string) => boolean, now = this.now()) {
    // After the first player pressed 再玩一局 the room is a waiting room, but whoever has not pressed it yet is
    // still looking at the result table of the match that just ended.
    const viewerP = viewerUid ? room.players.find((p) => p.uid === viewerUid) : undefined;
    const onResult = !!room.resultGame && !!viewerP && !isBack(viewerP) && room.status !== 'PLAYING';
    const status = onResult ? 'FINISHED' : room.status;
    const g = onResult ? room.resultGame : room.game;
    const hostP = room.players.find((p) => p.uid === room.hostUid);
    const gp = (uid: string) => g?.players.find((p) => p.uid === uid);
    const shots = (s: { hit: number; miss: number; collision: number }) => s.hit + s.miss + s.collision;
    const lastRecord = g && g.history.length ? g.history[g.history.length - 1]! : null;
    const cur = g && g.status === 'PLAYING' ? room.players.find((p) => p.uid === g.currentUid) : null;
    return {
      roomId: room.roomId,
      status,
      deckCopies: room.deckCopies ?? 1,
      allowConsecutive: room.allowConsecutive ?? true,
      // the chat lives in the waiting room only
      chat: (status === 'WAITING' || status === 'READY') ? room.chat.slice(-CHAT_SHOWN) : [],
      // the host has not come back yet: the clock until the room passes to the first player who did
      hostReturn:
        room.lobbyDeadline && hostP && !isBack(hostP)
          ? { deadline: room.lobbyDeadline, successor: this.nextBackPlayer(room, room.hostUid)?.nickname ?? null }
          : null,
      hostUid: room.hostUid,
      dealerUid: g && g.status === 'PLAYING' ? g.dealerUid : null,
      me: viewerUid,
      minPlayers: MIN_PLAYERS,
      maxPlayers: MAX_PLAYERS,
      serverNow: now,
      players: room.players.map((p) => {
        const s = gp(p.uid);
        return {
          uid: p.uid,
          nickname: p.nickname,
          isBot: p.isBot,
          isObserver: !!p.observer,
          onResult: !p.isBot && !isBack(p) && !!room.resultGame, // still looking at the result table
          wins: p.wins ?? 0,
          isHost: p.uid === room.hostUid,
          connected: p.isBot ? true : isConnected(p.uid),
          kicked: p.kicked,
          autoMode: !!p.autoMode,
          left: !!p.left,
          isDealer: !!g && g.status === 'PLAYING' && g.dealerUid === p.uid,
          chips: s?.chips ?? null,
          eliminated: s?.eliminated ?? false,
          rank: s?.rank ?? null,
          lastAction: s?.lastAction ?? null,
          stats: s
            ? {
                ...s.stats,
                shots: shots(s.stats),
                hitPct: shots(s.stats) ? (s.stats.hit / shots(s.stats)) * 100 : 0,
                missPct: shots(s.stats) ? (s.stats.miss / shots(s.stats)) * 100 : 0,
                collisionPct: shots(s.stats) ? (s.stats.collision / shots(s.stats)) * 100 : 0,
              }
            : null,
        };
      }),
      game: g
        ? {
            roundNumber: g.roundNumber,
            remainingCards: g.remainingCards,
            pot: g.pot,
            gate: g.gate,
            currentUid: g.status === 'PLAYING' ? g.currentUid : null,
            turnId: g.currentTurnId,
            currentBet: g.status === 'PLAYING' ? g.turn.bet : null,
            // the player to act has bet everything they own (drives the full-screen ALL IN effect)
            allIn: g.status === 'PLAYING' && g.turn.bet !== null && g.player(g.currentUid).chips === 0,
            minChip: g.minChip,
            lockedChips: g.lockedChips,
            deckUsedPercent: Math.round(g.deckUsedPercent),
            turnStartAt: room.turnStartAt,
            deadline: cur && !cur.isBot && !cur.kicked && !cur.autoMode ? room.turnStartAt + TURN_TIME_MS : null,
            lastRecord,
            history: g.history.slice(-80),
            deckSize: g.deckSize,
            seenCards: this.seenCards(g),
            lastCard: this.lastShotCard(g),
            fast: this.isFastForward(room),
            eliminationOrder: g.eliminationOrder,
            ranking: g.status === 'FINISHED' ? g.ranking() : null,
            canAct: !!viewerUid && g.status === 'PLAYING' && g.currentUid === viewerUid && !cur?.kicked,
          }
        : null,
      events: room.events.slice(-60),
    };
  }

  /** Cards face-up this round (gate + every third card); the unrevealed deck is never exposed. */
  /** No live human left in the match (all eliminated / left / kicked): computers play it out fast. */
  isFastForward(room: Room): boolean {
    const g = room.game;
    if (!g || g.status !== 'PLAYING') return false;
    if (room.fastHoldUntil && this.now() < room.fastHoldUntil) return false;
    // observers are not players: when only they are left watching, the computers still play it out quickly
    return !room.players.some((p) => !p.isBot && !p.observer && !p.kicked && !p.left && !g.player(p.uid).eliminated);
  }

  private seenCards(g: Game): { suit: string; rank: number }[] {
    const out: { suit: string; rank: number }[] = [...g.gate];
    for (let i = g.history.length - 1; i >= 0; i--) {
      const rec = g.history[i]!;
      if (rec.roundNumber !== g.roundNumber) break;
      if (rec.thirdCard) out.push(rec.thirdCard);
    }
    return out;
  }

  private lastShotCard(g: Game): { suit: string; rank: number } | null {
    const rec = g.history[g.history.length - 1];
    return rec && rec.roundNumber === g.roundNumber && rec.thirdCard ? rec.thirdCard : null;
  }

  // ---- room recycling ----------------------------------------------------

  /**
   * Remove rooms that are CLOSED, or that have had no connected human and no activity for `idleMs`.
   * Returns the removed room ids (so the caller can drop their timers).
   */
  sweep(isConnected: (sid: string | null) => boolean, idleMs: number = ROOM_IDLE_MS): string[] {
    const removed: string[] = [];
    for (const [id, room] of this.rooms) {
      const anyoneOnline = room.players.some((p) => !p.isBot && isConnected(p.sid));
      const idle = !anyoneOnline && this.now() - room.updatedAt >= idleMs;
      if (room.status !== 'CLOSED' && !idle) continue;
      this.rooms.delete(id);
      for (const [sid, b] of this.sessions) if (b.roomId === id) this.sessions.delete(sid);
      removed.push(id);
    }
    return removed;
  }

  // ---- persistence -------------------------------------------------------

  toJSON(): { rooms: RoomSnapshot[]; sessions: [string, { roomId: string; uid: string }][] } {
    return {
      rooms: [...this.rooms.values()].map((r) => ({ ...r, game: r.game ? r.game.snapshot() : null, resultGame: r.resultGame ? r.resultGame.snapshot() : null })),
      sessions: [...this.sessions.entries()],
    };
  }

  load(data: ReturnType<RoomManager['toJSON']>): void {
    this.rooms.clear();
    this.sessions.clear();
    for (const r of data.rooms) {
      const room: Room = { ...r, deckCopies: r.deckCopies ?? 1, allowConsecutive: r.allowConsecutive ?? true, chat: r.chat ?? [], chatSeq: r.chatSeq ?? 0, backOrder: r.backOrder ?? [], lobbyDeadline: r.lobbyDeadline ?? null, startDeadline: r.startDeadline ?? null, startRemind: r.startRemind ?? 9999, game: r.game ? Game.restore(r.game, { rng: this.rng }) : null, resultGame: r.resultGame ? Game.restore(r.resultGame, { rng: this.rng }) : null };
      delete (room as unknown as { passwordHash?: string }).passwordHash; // passwords were removed
      this.rooms.set(room.roomId, room);
      if (this.inLobby(room) && !room.startDeadline) this.armStart(room); // saves from before the countdown existed
    }
    for (const [sid, b] of data.sessions) this.sessions.set(sid, b);
  }

  // ---- internals ---------------------------------------------------------

  emit(room: Room, type: string, payload: Record<string, unknown>): void {
    room.events.push({ seq: ++room.eventSeq, type, payload, ts: this.now() });
    if (room.events.length > MAX_EVENTS) room.events.splice(0, room.events.length - MAX_EVENTS);
    room.updatedAt = this.now();
  }

  private requireHost(sid: string): { room: Room; uid: string } {
    const b = this.binding(sid);
    if (!b) throw new GameError('NOT_IN_ROOM', '你不在任何房間內');
    if (b.room.hostUid !== b.uid) throw new GameError('NOT_HOST', '只有房主可以執行');
    return b;
  }

  private removePlayer(room: Room, uid: string): void {
    room.players = room.players.filter((p) => p.uid !== uid);
    room.backOrder = room.backOrder.filter((u) => u !== uid);
  }

  private afterRemoval(room: Room, removedUid: string): void {
    const humans = room.players.filter((p) => !p.isBot);
    if (!humans.length) {
      room.status = 'CLOSED';
      this.emit(room, 'ROOM_UPDATED', { closed: true });
      return;
    }
    if (room.hostUid === removedUid && !this.transferHostIfNeeded(room, removedUid)) {
      room.status = 'CLOSED';
      return;
    }
    if (room.status === 'WAITING' || room.status === 'READY') this.refreshStatus(room);
    this.pruneResult(room);
  }

  private refreshStatus(room: Room): void {
    if (room.status === 'WAITING' || room.status === 'READY') {
      room.status = room.players.filter((p) => !p.observer).length >= MIN_PLAYERS ? 'READY' : 'WAITING';
    }
  }

  private detach(sid: string): void {
    const b = this.binding(sid);
    if (!b) return;
    if (b.room.status === 'PLAYING' && !b.room.players.find((x) => x.uid === b.uid)?.observer) {
      const p = b.room.players.find((x) => x.uid === b.uid)!;
      const eliminated = b.room.game?.player(b.uid).eliminated;
      if (!p.left && !eliminated) throw new GameError('IN_ACTIVE_GAME', '你仍在進行中的遊戲內，請先離開該遊戲');
      // Abandon the old match for good: the computer keeps the seat.
      p.left = true;
      p.autoMode = true;
      p.sid = null;
      this.sessions.delete(sid);
      return;
    }
    const gone = b.room.players.find((x) => x.uid === b.uid);
    if (gone) this.announce(b.room, `${gone.nickname} 已退出`);
    this.removePlayer(b.room, b.uid);
    this.sessions.delete(sid);
    this.afterRemoval(b.room, b.uid);
  }

  private cleanNickname(n: unknown): string {
    const s = typeof n === 'string' ? n.trim() : '';
    if (!s || s.length > 12) throw new GameError('BAD_NICKNAME', '暱稱需為 1–12 字');
    if (s.normalize('NFKC').replace(/\s+/g, '').toLowerCase() === SYSTEM_NAME.toLowerCase()) throw new GameError('BAD_NICKNAME', '「System」是系統保留名稱，請換一個');
    return s;
  }

  private newUid(): string {
    return 'u_' + randomBytes(6).toString('hex');
  }
}
