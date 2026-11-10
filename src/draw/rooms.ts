// Drawing game rooms: the same room model as the card game (6-digit number, up to 12 people, host, chat, player list)
// but two of the people are the painters and everybody else watches.
import { randomBytes } from 'node:crypto';
import { BRUSH_SIZES, FILL_UNIT, MAX_STROKES, REFERENCES, cleanStroke, getReference, similarity, type Reference, type Stroke } from './scoring.ts';

export class DrawError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export const MAX_MEMBERS = 12;
export const COUNTDOWN_MS = 3000;
export const DRAW_MS = 3 * 60 * 1000;
/** How long the result stays on screen before everybody is taken back to the waiting room. */
export const RESULT_MS = 15 * 1000;
const LATE_STROKE_GRACE_MS = 600; // a stroke that was already on its way when the clock ran out still counts
export const CHAT_MAX_LENGTH = 200;
export const CHAT_MIN_INTERVAL_MS = 700;
const CHAT_KEEP = 100;
const CHAT_SHOWN = 50;
export const ROOM_IDLE_MS = 30 * 60 * 1000;
export const SYSTEM_UID = 'system';
export const SYSTEM_NAME = 'System';

export type DrawStatus = 'LOBBY' | 'ORIENT' | 'COUNTDOWN' | 'DRAWING' | 'RESULT' | 'CLOSED';

export interface DrawPlayer {
  uid: string;
  nickname: string;
  sid: string | null;
  wins: number;
  /** The player's screen can show the reference and the canvas side by side (landscape, or wide enough). */
  orientOk: boolean;
}

export interface DrawChat {
  seq: number;
  uid: string;
  nickname: string;
  text: string;
  ts: number;
}

export interface DrawRoom {
  roomId: string;
  hostUid: string;
  players: DrawPlayer[];
  /** Who paints: slot 0 (player 1) and slot 1 (player 2). Everyone else is a spectator. */
  slots: [string | null, string | null];
  slotNames: [string, string];
  /** The picture drawn this round: picked at random when the host starts (null in the lobby, so nobody can plan ahead). */
  referenceId: string | null;
  /** The picture of the round before: never picked twice in a row. */
  lastReferenceId: string | null;
  status: DrawStatus;
  strokes: [Stroke[], Stroke[]];
  startsAt: number | null;
  endsAt: number | null;
  /** When the result screen ends and the room goes back to the waiting room (null outside the result). */
  resultEndsAt: number | null;
  /** forfeit: the slot of the painter who left during the painting (the other one wins at once), else null. */
  result: { scores: [number, number]; winner: 0 | 1 | null; forfeit: 0 | 1 | null } | null;
  chat: DrawChat[];
  chatSeq: number;
  bannedSids: string[];
  createdAt: number;
  updatedAt: number;
}

export class DrawRooms {
  rooms = new Map<string, DrawRoom>();
  sessions = new Map<string, { roomId: string; uid: string }>();
  /** The clocks; public so a test can shorten them. */
  drawMs = DRAW_MS;
  countdownMs = COUNTDOWN_MS;
  resultMs = RESULT_MS;
  /** Whether a device is connected right now (the hub sets this). Somebody who is not is only a spectator: never a painter, never the host. */
  online: (sid: string | null) => boolean = () => true;
  private now: () => number;
  private rng: () => number;
  private lastChatAt = new Map<string, number>();

  constructor(opts: { now?: () => number; rng?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
    this.rng = opts.rng ?? Math.random;
  }

  // ---- lookup ---------------------------------------------------------------------------------

  getRoom(roomId: string): DrawRoom {
    const r = this.rooms.get(String(roomId).trim());
    if (!r || r.status === 'CLOSED') throw new DrawError('ROOM_NOT_FOUND', '找不到房間');
    return r;
  }

  binding(sid: string): { room: DrawRoom; uid: string; player: DrawPlayer } | null {
    const b = this.sessions.get(sid);
    if (!b) return null;
    const room = this.rooms.get(b.roomId);
    const player = room?.players.find((p) => p.uid === b.uid);
    if (!room || room.status === 'CLOSED' || !player) {
      this.sessions.delete(sid);
      return null;
    }
    return { room, uid: b.uid, player };
  }

  private need(sid: string) {
    const b = this.binding(sid);
    if (!b) throw new DrawError('NOT_IN_ROOM', '你不在任何房間內');
    return b;
  }

  private needHost(sid: string) {
    const b = this.need(sid);
    if (b.room.hostUid !== b.uid) throw new DrawError('NOT_HOST', '只有房主可以執行');
    return b;
  }

  slotOf(room: DrawRoom, uid: string): -1 | 0 | 1 {
    return room.slots[0] === uid ? 0 : room.slots[1] === uid ? 1 : -1;
  }

  // ---- joining and leaving --------------------------------------------------------------------

  createRoom(sid: string, nickname: string): { room: DrawRoom; uid: string } {
    const nick = this.cleanNickname(nickname);
    this.detach(sid);
    let roomId: string;
    do roomId = String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0');
    while (this.rooms.has(roomId));
    const uid = this.newUid();
    const t = this.now();
    const room: DrawRoom = {
      roomId, hostUid: uid, players: [{ uid, nickname: nick, sid, wins: 0, orientOk: false }],
      slots: [uid, null], slotNames: [nick, ''], referenceId: null, lastReferenceId: null, status: 'LOBBY', strokes: [[], []], startsAt: null, endsAt: null, resultEndsAt: null,
      result: null, chat: [], chatSeq: 0, bannedSids: [], createdAt: t, updatedAt: t,
    };
    this.rooms.set(roomId, room);
    this.sessions.set(sid, { roomId, uid });
    return { room, uid };
  }

  joinRoom(sid: string, roomId: string, nickname: string): { room: DrawRoom; uid: string } {
    const room = this.getRoom(roomId);
    const existing = this.binding(sid);
    if (existing && existing.room === room) return { room, uid: existing.uid };
    if (room.bannedSids.includes(sid)) throw new DrawError('BANNED', '你已被房主剔除');
    if (room.players.length >= MAX_MEMBERS) throw new DrawError('ROOM_FULL', '房間已滿（12 人）');
    const nick = this.cleanNickname(nickname);
    this.detach(sid);
    const uid = this.newUid();
    room.players.push({ uid, nickname: nick, sid, wins: 0, orientOk: false });
    this.sessions.set(sid, { roomId: room.roomId, uid });
    this.announce(room, `${nick} 已加入`);
    // the second person in is player 2, unless the host has already picked somebody
    if (room.status === 'LOBBY' && room.slots[1] === null) room.slots[1] = uid;
    else if (room.status === 'LOBBY' && room.slots[0] === null) room.slots[0] = uid;
    this.touch(room);
    return { room, uid };
  }

  leave(sid: string): DrawRoom | null {
    const b = this.binding(sid);
    if (!b) return null;
    this.announce(b.room, `${b.player.nickname} 已退出`);
    this.removeMember(b.room, b.uid);
    this.sessions.delete(sid);
    return b.room;
  }

  kick(sid: string, targetUid: string): DrawRoom {
    const { room, uid } = this.needHost(sid);
    const target = room.players.find((p) => p.uid === targetUid);
    if (!target) throw new DrawError('UNKNOWN_PLAYER', '玩家不存在');
    if (target.uid === uid) throw new DrawError('CANNOT_KICK_HOST', '不能剔除房主');
    this.announce(room, `${target.nickname} 已被踢除`);
    if (target.sid) {
      room.bannedSids.push(target.sid);
      this.sessions.delete(target.sid);
    }
    this.removeMember(room, targetUid);
    return room;
  }

  private removeMember(room: DrawRoom, uid: string): void {
    const slot = this.slotOf(room, uid);
    room.players = room.players.filter((p) => p.uid !== uid);
    if (!room.players.length) {
      room.status = 'CLOSED';
      return;
    }
    if (room.hostUid === uid) {
      const next = room.players.find((p) => this.slotOf(room, p.uid) >= 0 && this.online(p.sid)) ?? room.players.find((p) => this.online(p.sid)) ?? room.players[0]!;
      room.hostUid = next.uid;
      this.announce(room, `${next.nickname} 現在是房主`);
    }
    if (slot >= 0) {
      if (room.status === 'ORIENT' || room.status === 'COUNTDOWN') {
        room.slots[slot] = null;
        this.backToLobby(room);
      } else if (room.status === 'DRAWING') {
        // one painter walked out (or was sent out) in the middle of the game: the other one wins at once.
        // (the seat keeps its name and strokes for the result screen)
        this.finish(room, slot as 0 | 1);
      } else if (room.status === 'LOBBY' || room.status === 'RESULT') {
        room.slots[slot] = null;
      }
    }
    if (room.status === 'LOBBY') this.fillSlots(room);
    this.touch(room);
  }

  /**
   * A device lost its connection while nothing is being painted (the match case is quit()): it is a spectator from now on.
   * In the waiting room it loses its seat (the next in line takes it); the host's job goes to somebody who is there.
   */
  dropped(sid: string): DrawRoom | null {
    const b = this.binding(sid);
    if (!b || (b.room.status !== 'LOBBY' && b.room.status !== 'RESULT')) return null;
    const room = b.room;
    if (room.status === 'LOBBY') {
      const slot = this.slotOf(room, b.uid);
      if (slot >= 0) room.slots[slot] = null;
    }
    if (room.hostUid === b.uid) {
      const next = room.players.find((p) => p.uid !== b.uid && this.online(p.sid));
      if (next) {
        room.hostUid = next.uid;
        this.announce(room, `${next.nickname} 現在是房主`);
      }
    }
    if (room.status === 'LOBBY') this.fillSlots(room);
    this.touch(room);
    return room;
  }

  /** An empty seat goes to the person who has been in the room longest and is not painting yet. */
  private fillSlots(room: DrawRoom): void {
    for (const s of [0, 1] as const) {
      if (room.slots[s] !== null) continue;
      const next = room.players.find((p) => this.slotOf(room, p.uid) < 0 && this.online(p.sid));
      if (next) room.slots[s] = next.uid;
    }
  }

  // ---- host controls --------------------------------------------------------------------------

  setSlot(sid: string, slot: number, targetUid: string): DrawRoom {
    const { room } = this.needHost(sid);
    if (room.status !== 'LOBBY') throw new DrawError('BAD_STATE', '遊戲進行中，無法更換玩家');
    if (slot !== 0 && slot !== 1) throw new DrawError('BAD_SLOT', '只有玩家 1 與玩家 2');
    const target = room.players.find((p) => p.uid === targetUid);
    if (!target) throw new DrawError('UNKNOWN_PLAYER', '玩家不存在');
    if (!this.online(target.sid)) throw new DrawError('PLAYER_OFFLINE', '斷線的玩家只能當觀眾');
    const s = slot as 0 | 1;
    const other = (1 - s) as 0 | 1;
    const prev = room.slots[s];
    if (prev === targetUid) return room;
    if (room.slots[other] === targetUid) room.slots[other] = prev; // already the other painter: the two swap seats
    room.slots[s] = targetUid;
    this.announce(room, `${target.nickname} 成為玩家 ${s + 1}`);
    this.touch(room);
    return room;
  }

  transferHost(sid: string, targetUid: string): DrawRoom {
    const { room, uid } = this.needHost(sid);
    const target = room.players.find((p) => p.uid === targetUid);
    if (!target) throw new DrawError('UNKNOWN_PLAYER', '玩家不存在');
    if (target.uid === uid) return room;
    if (!this.online(target.sid)) throw new DrawError('PLAYER_OFFLINE', '斷線的玩家不能當房主');
    room.hostUid = target.uid;
    this.announce(room, `${target.nickname} 現在是房主`);
    this.touch(room);
    return room;
  }

  // ---- the game -------------------------------------------------------------------------------

  start(sid: string): DrawRoom {
    const { room } = this.needHost(sid);
    if (room.status !== 'LOBBY') throw new DrawError('BAD_STATE', '無法開始遊戲');
    const [a, b] = room.slots;
    const pa = room.players.find((p) => p.uid === a);
    const pb = room.players.find((p) => p.uid === b);
    if (!pa || !pb) throw new DrawError('NOT_ENOUGH_PLAYERS', '需要 2 位玩家才能開始');
    room.slotNames = [pa.nickname, pb.nickname];
    room.referenceId = this.pickReference(room);
    room.strokes = [[], []];
    room.result = null;
    room.status = 'ORIENT';
    this.advance(room);
    this.touch(room);
    return room;
  }

  /** The picture of this round: drawn at random from all of them, but never the one of the round before. */
  private pickReference(room: DrawRoom): string {
    const pool = REFERENCES.filter((p) => p.id !== room.lastReferenceId);
    const choices = pool.length ? pool : REFERENCES;
    const id = choices[Math.min(choices.length - 1, Math.floor(this.rng() * choices.length))]!.id;
    room.lastReferenceId = id;
    return id;
  }

  private refOf(room: DrawRoom): Reference {
    return getReference(room.referenceId ?? REFERENCES[0]!.id);
  }

  /** A player's screen tells us whether it can hold the reference and the canvas side by side. */
  setOrient(sid: string, ok: boolean): DrawRoom {
    const { room, player } = this.need(sid);
    player.orientOk = !!ok;
    this.advance(room);
    this.touch(room);
    return room;
  }

  /** Move the game on whenever something changed: both painters ready -> countdown; one steps back -> wait again. */
  advance(room: DrawRoom, now = this.now()): void {
    const ready = room.slots.every((uid) => !!uid && room.players.find((p) => p.uid === uid)?.orientOk);
    if (room.status === 'ORIENT' && ready) {
      room.status = 'COUNTDOWN';
      room.startsAt = now + this.countdownMs;
    } else if (room.status === 'COUNTDOWN' && !ready) {
      room.status = 'ORIENT';
      room.startsAt = null;
    }
  }

  /** The clock: the countdown ends, the painting ends. Returns true when the room changed. */
  tick(room: DrawRoom, now = this.now()): boolean {
    if (room.status === 'COUNTDOWN' && room.startsAt !== null && now >= room.startsAt) {
      room.status = 'DRAWING';
      room.endsAt = room.startsAt + this.drawMs;
      this.touch(room);
      return true;
    }
    if (room.status === 'DRAWING' && room.endsAt !== null && now >= room.endsAt) {
      this.finish(room);
      return true;
    }
    // RESULT does not end by itself: somebody presses 回等候房 (`again`) or everybody leaves
    return false;
  }

  /** When the room next needs tick() (a timestamp), or null. */
  nextTickAt(room: DrawRoom): number | null {
    if (room.status === 'COUNTDOWN') return room.startsAt;
    if (room.status === 'DRAWING') return room.endsAt;
    return null;
  }

  private painter(sid: string): { room: DrawRoom; slot: 0 | 1 } {
    const { room, uid } = this.need(sid);
    if (room.status !== 'DRAWING' || room.endsAt === null || this.now() > room.endsAt + LATE_STROKE_GRACE_MS) throw new DrawError('NOT_DRAWING', '現在不能作畫');
    const slot = this.slotOf(room, uid);
    if (slot < 0) throw new DrawError('NOT_A_PAINTER', '觀眾不能作畫');
    return { room, slot: slot as 0 | 1 };
  }

  addStroke(sid: string, raw: unknown): { room: DrawRoom; slot: 0 | 1; stroke: Stroke } {
    const { room, slot } = this.painter(sid);
    const stroke = cleanStroke(raw, this.refOf(room));
    if (!stroke) throw new DrawError('BAD_STROKE', '筆畫不正確');
    if (room.strokes[slot].length >= MAX_STROKES) throw new DrawError('TOO_MANY_STROKES', '筆畫太多了，請先清空或復原');
    room.strokes[slot].push(stroke);
    room.updatedAt = this.now();
    return { room, slot, stroke };
  }

  /**
   * A piece of the stroke a painter is still drawing. It is checked like a stroke, but not kept: the finished stroke
   * (addStroke) is what counts. It only exists so the spectators can watch the line grow.
   */
  segment(sid: string, raw: unknown): { room: DrawRoom; slot: 0 | 1; stroke: Stroke } {
    const { room, slot } = this.painter(sid);
    const stroke = cleanStroke(raw, this.refOf(room));
    if (!stroke || stroke.runs) throw new DrawError('BAD_STROKE', '筆畫不正確'); // (a bucket fill is one move: it has no half-drawn pieces)
    return { room, slot, stroke };
  }

  undo(sid: string): { room: DrawRoom; slot: 0 | 1 } {
    const { room, slot } = this.painter(sid);
    room.strokes[slot].pop();
    room.updatedAt = this.now();
    return { room, slot };
  }

  clear(sid: string): { room: DrawRoom; slot: 0 | 1 } {
    const { room, slot } = this.painter(sid);
    room.strokes[slot] = [];
    room.updatedAt = this.now();
    return { room, slot };
  }

  /** Judge the pictures. `forfeitSlot`: that painter left, so the other one is the winner whatever the scores say. */
  finish(room: DrawRoom, forfeitSlot: 0 | 1 | null = null): void {
    const ref = this.refOf(room);
    const scores: [number, number] = [similarity(ref, room.strokes[0]), similarity(ref, room.strokes[1])];
    const winner: 0 | 1 | null = forfeitSlot !== null ? ((1 - forfeitSlot) as 0 | 1) : scores[0] === scores[1] ? null : scores[0] > scores[1] ? 0 : 1;
    room.result = { scores, winner, forfeit: forfeitSlot };
    room.status = 'RESULT';
    room.startsAt = null;
    room.resultEndsAt = this.now() + this.resultMs;
    if (winner !== null) {
      const w = room.players.find((p) => p.uid === room.slots[winner]);
      if (w) w.wins++;
    }
    this.touch(room);
  }

  /** Host: stop waiting for the screens (or the countdown) and go back to the lobby. */
  cancel(sid: string): DrawRoom {
    const { room } = this.needHost(sid);
    if (room.status !== 'ORIENT' && room.status !== 'COUNTDOWN') throw new DrawError('BAD_STATE', '現在不能取消');
    this.backToLobby(room);
    return room;
  }

  /**
   * A painter gives up this round (the 認輸 button), but stays in the room.
   * Before the painting starts that just ends the wait; during it the other painter wins at once.
   */
  quit(sid: string): DrawRoom {
    const { room, uid } = this.need(sid);
    const slot = this.slotOf(room, uid);
    if (slot < 0) throw new DrawError('NOT_A_PAINTER', '觀眾沒有比賽可以退出');
    if (room.status === 'ORIENT' || room.status === 'COUNTDOWN') this.backToLobby(room);
    else if (room.status === 'DRAWING') this.finish(room, slot as 0 | 1);
    else throw new DrawError('BAD_STATE', '現在不能認輸');
    return room;
  }

  /** Anybody in the room: the result has been seen, everybody goes back to the waiting room now (it happens by itself after RESULT_MS anyway). */
  again(sid: string): DrawRoom {
    const { room } = this.need(sid);
    if (room.status !== 'RESULT') throw new DrawError('BAD_STATE', '現在不能再玩一局');
    this.backToLobby(room);
    return room;
  }

  private backToLobby(room: DrawRoom): void {
    room.status = 'LOBBY';
    room.referenceId = null;
    room.strokes = [[], []];
    room.startsAt = null;
    room.endsAt = null;
    room.resultEndsAt = null;
    room.result = null;
    for (const s of [0, 1] as const) {
      const holder = room.players.find((p) => p.uid === room.slots[s]);
      if (!holder || !this.online(holder.sid)) room.slots[s] = null; // gone, or disconnected: a spectator
    }
    this.fillSlots(room);
    this.touch(room);
  }

  // ---- chat -----------------------------------------------------------------------------------

  chat(sid: string, text: unknown): DrawRoom {
    const { room, uid, player } = this.need(sid);
    if (room.status !== 'LOBBY' && room.status !== 'RESULT') throw new DrawError('CHAT_CLOSED', '聊天室只在等候與結算時開放');
    // text only: control characters and line breaks become spaces; the client shows it as text, never as HTML
    const clean = typeof text === 'string' ? Array.from(text.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ').trim()).slice(0, CHAT_MAX_LENGTH).join('').trim() : '';
    if (!clean) throw new DrawError('CHAT_EMPTY', '訊息不能是空的');
    const t = this.now();
    if (t - (this.lastChatAt.get(uid) ?? 0) < CHAT_MIN_INTERVAL_MS) throw new DrawError('CHAT_TOO_FAST', '說話太快了，請稍等一下');
    this.lastChatAt.set(uid, t);
    this.push(room, uid, player.nickname, clean);
    return room;
  }

  private push(room: DrawRoom, uid: string, nickname: string, text: string): void {
    room.chat.push({ seq: ++room.chatSeq, uid, nickname, text, ts: this.now() });
    if (room.chat.length > CHAT_KEEP) room.chat.splice(0, room.chat.length - CHAT_KEEP);
    room.updatedAt = this.now();
  }

  /** Joins, exits, kicks, seat changes: System says them in the chat (the chat is only open in the lobby and result). */
  private announce(room: DrawRoom, text: string): void {
    if (room.status === 'LOBBY' || room.status === 'RESULT') this.push(room, SYSTEM_UID, SYSTEM_NAME, text);
  }

  // ---- view -----------------------------------------------------------------------------------

  view(room: DrawRoom, viewerUid: string | null, isConnected: (sid: string | null) => boolean) {
    const t = this.now();
    const ref = room.referenceId ? getReference(room.referenceId) : null;
    return {
      roomId: room.roomId,
      status: room.status,
      me: viewerUid,
      hostUid: room.hostUid,
      serverNow: t,
      maxPlayers: MAX_MEMBERS,
      referenceCount: REFERENCES.length,
      reference: ref ? { id: ref.id, title: ref.title, file: ref.file } : null,
      canvas: ref ? { w: ref.w, h: ref.h } : null,
      palette: ref ? ref.palette : null,
      brushSizes: BRUSH_SIZES,
      fillUnit: FILL_UNIT,
      drawMs: this.drawMs,
      countdownMs: this.countdownMs,
      startsAt: room.startsAt,
      endsAt: room.endsAt,
      resultEndsAt: room.resultEndsAt,
      slots: room.slots,
      slotNames: room.slotNames,
      players: room.players.map((p) => ({
        uid: p.uid, nickname: p.nickname, connected: isConnected(p.sid), isHost: p.uid === room.hostUid,
        slot: this.slotOf(room, p.uid), wins: p.wins, orientOk: p.orientOk,
      })),
      counts: [room.strokes[0].length, room.strokes[1].length],
      canStart: room.status === 'LOBBY' && !!room.slots[0] && !!room.slots[1],
      chat: room.status === 'LOBBY' || room.status === 'RESULT' ? room.chat.slice(-CHAT_SHOWN) : [],
      // the finished pictures are for everybody; during the painting each painter only knows their own (see snapshot)
      result: room.status === 'RESULT' && room.result ? { ...room.result, strokes: room.strokes } : null,
    };
  }

  /** What a viewer may see of the pictures right now: a painter their own, a spectator both, nobody else's while painting. */
  snapshot(room: DrawRoom, viewerUid: string): { strokes: [Stroke[] | null, Stroke[] | null] } {
    const slot = this.slotOf(room, viewerUid);
    if (room.status === 'RESULT' || slot < 0) return { strokes: [room.strokes[0], room.strokes[1]] };
    return { strokes: [slot === 0 ? room.strokes[0] : null, slot === 1 ? room.strokes[1] : null] };
  }

  // ---- housekeeping ---------------------------------------------------------------------------

  /** Closed rooms, and rooms nobody is connected to for a long time, are removed. Returns the removed ids. */
  sweep(isConnected: (sid: string | null) => boolean, idleMs = ROOM_IDLE_MS): string[] {
    const removed: string[] = [];
    for (const [id, room] of this.rooms) {
      const online = room.players.some((p) => isConnected(p.sid));
      const idle = !online && this.now() - room.updatedAt >= idleMs;
      if (room.status !== 'CLOSED' && !idle) continue;
      this.rooms.delete(id);
      for (const [sid, b] of this.sessions) if (b.roomId === id) this.sessions.delete(sid);
      removed.push(id);
    }
    return removed;
  }

  private touch(room: DrawRoom): void {
    room.updatedAt = this.now();
  }

  private detach(sid: string): void {
    const b = this.binding(sid);
    if (!b) return;
    this.announce(b.room, `${b.player.nickname} 已退出`);
    this.removeMember(b.room, b.uid);
    this.sessions.delete(sid);
  }

  private cleanNickname(n: unknown): string {
    const s = typeof n === 'string' ? n.trim() : '';
    if (!s || s.length > 12) throw new DrawError('BAD_NICKNAME', '暱稱需為 1–12 字');
    if (s.normalize('NFKC').replace(/\s+/g, '').toLowerCase() === SYSTEM_NAME.toLowerCase()) throw new DrawError('BAD_NICKNAME', '「System」是系統保留名稱，請換一個');
    return s;
  }

  private newUid(): string {
    return 'd_' + randomBytes(6).toString('hex');
  }
}
