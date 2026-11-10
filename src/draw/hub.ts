// WebSocket side of the drawing game (path /ws/draw): the same device cookie as the card game, its own rooms.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { DrawError, DrawRooms, type DrawRoom } from './rooms.ts';

interface Conn {
  ws: WebSocket;
  sid: string;
  /** A small token bucket: strokes arrive in bursts, but nobody needs 100 messages a second. */
  budget: number;
  budgetAt: number;
}

/** A client-chosen number that tells the spectators which stroke a segment belongs to. */
const cleanId = (x: unknown): number | null => (typeof x === 'number' && Number.isInteger(x) && x >= 0 && x < 1e9 ? x : null);

const BUDGET_MAX = 60;
const BUDGET_PER_SEC = 30;

export class DrawHub {
  rooms: DrawRooms;
  private conns = new Map<string, Set<Conn>>();
  private timers = new Map<string, NodeJS.Timeout>();
  private sweepTimer: NodeJS.Timeout;
  private roomIdleMs: number | undefined;
  private logDir: string | undefined;
  private logged = new Map<string, number | null>();

  constructor(opts: { sweepMs?: number; roomIdleMs?: number; now?: () => number; logDir?: string } = {}) {
    this.rooms = new DrawRooms({ now: opts.now });
    this.logDir = opts.logDir;
    this.rooms.online = (sid) => this.isConnected(sid);
    this.roomIdleMs = opts.roomIdleMs;
    this.sweepTimer = setInterval(() => this.sweep(), opts.sweepMs ?? 60_000);
    this.sweepTimer.unref();
  }

  isConnected(sid: string | null): boolean {
    return !!sid && (this.conns.get(sid)?.size ?? 0) > 0;
  }

  sweep(): string[] {
    const removed = this.rooms.sweep((sid) => this.isConnected(sid), this.roomIdleMs);
    for (const id of removed) {
      const t = this.timers.get(id);
      if (t) clearTimeout(t);
      this.timers.delete(id);
    }
    return removed;
  }

  close(): void {
    clearInterval(this.sweepTimer);
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  // ---- connections ------------------------------------------------------------------------------

  attach(ws: WebSocket, sid: string): void {
    const conn: Conn = { ws, sid, budget: BUDGET_MAX, budgetAt: Date.now() };
    let set = this.conns.get(sid);
    if (!set) this.conns.set(sid, (set = new Set()));
    set.add(conn);
    this.sendTo(conn, { t: 'hello', serverNow: Date.now() });
    this.sendState(conn);

    ws.on('message', (data) => {
      let msg: any;
      try {
        if ((data as Buffer).length > 65_536) throw new Error('too large');
        msg = JSON.parse(String(data));
      } catch {
        return this.sendTo(conn, { t: 'error', code: 'BAD_MESSAGE', message: '訊息格式錯誤' });
      }
      const now = Date.now();
      conn.budget = Math.min(BUDGET_MAX, conn.budget + ((now - conn.budgetAt) / 1000) * BUDGET_PER_SEC);
      conn.budgetAt = now;
      if (msg?.t !== 'ping' && --conn.budget < 0) return this.sendTo(conn, { t: 'error', code: 'TOO_FAST', message: '操作太快了' });
      try {
        this.handle(conn, msg);
      } catch (e) {
        if (e instanceof DrawError) this.sendTo(conn, { t: 'error', code: e.code, message: e.message, ref: msg?.t });
        else {
          console.error('[draw] unexpected error', e);
          this.sendTo(conn, { t: 'error', code: 'INTERNAL', message: '伺服器錯誤' });
        }
      }
    });
    ws.on('close', () => {
      set!.delete(conn);
      if (!set!.size) {
        this.conns.delete(sid);
        const b = this.rooms.binding(sid);
        if (!b) return;
        // a painter who drops out of a match is out of it at once: the other one wins (before the painting starts it is just back to the waiting room);
        // the one who dropped stays in the room and finds the result, then the waiting room, when they come back
        try {
          this.after(this.rooms.quit(sid));
        } catch (e) {
          if (!(e instanceof DrawError)) throw e;
          this.after(this.rooms.dropped(sid) ?? b.room); // not a painter, or no match going on: a spectator from now on
        }
      }
    });
  }

  private handle(conn: Conn, msg: any): void {
    const sid = conn.sid;
    const r = this.rooms;
    switch (msg?.t) {
      case 'ping':
        return;
      case 'create': {
        const { room } = r.createRoom(sid, msg.nickname);
        return this.after(room);
      }
      case 'join': {
        const { room } = r.joinRoom(sid, String(msg.roomId ?? ''), msg.nickname);
        return this.after(room);
      }
      case 'leave': {
        const room = r.leave(sid);
        for (const c of this.conns.get(sid) ?? []) this.sendTo(c, { t: 'state', state: null });
        if (room) this.after(room);
        return;
      }
      case 'kick': {
        const b = r.binding(sid);
        const targetSid = b?.room.players.find((p) => p.uid === String(msg.uid))?.sid ?? null;
        const room = r.kick(sid, String(msg.uid));
        for (const c of this.conns.get(targetSid ?? '') ?? []) this.sendTo(c, { t: 'state', state: null, notice: '你已被房主剔除' });
        return this.after(room);
      }
      case 'setSlot':
        return this.after(r.setSlot(sid, Number(msg.slot), String(msg.uid)));
      case 'transferHost':
        return this.after(r.transferHost(sid, String(msg.uid)));
      case 'chat':
        return this.after(r.chat(sid, msg.text));
      case 'start':
        return this.after(r.start(sid));
      case 'quit':
        return this.after(r.quit(sid));
      case 'cancel':
        return this.after(r.cancel(sid));
      case 'again':
        return this.after(r.again(sid));
      case 'orient':
        return this.after(r.setOrient(sid, msg.ok === true));
      case 'sync': {
        const b = r.binding(sid);
        if (b) this.sendTo(conn, { t: 'snap', ...r.snapshot(b.room, b.uid) });
        return;
      }
      case 'stroke': {
        const { room, slot, stroke } = r.addStroke(sid, msg.stroke);
        return this.relay(room, { t: 'stroke', slot, id: cleanId(msg.id), stroke });
      }
      case 'seg': {
        // the line is still being drawn: spectators see it grow (nothing is kept until the stroke is finished)
        const { room, slot, stroke } = r.segment(sid, msg.stroke);
        return this.relay(room, { t: 'seg', slot, id: cleanId(msg.id), stroke });
      }
      case 'undo': {
        const { room, slot } = r.undo(sid);
        return this.relay(room, { t: 'undo', slot });
      }
      case 'clear': {
        const { room, slot } = r.clear(sid);
        return this.relay(room, { t: 'clear', slot });
      }
      default:
        throw new DrawError('UNKNOWN_MESSAGE', '未知的訊息');
    }
  }

  // ---- sending ----------------------------------------------------------------------------------

  private sendTo(conn: Conn, payload: unknown): void {
    if (conn.ws.readyState === WebSocket.OPEN) conn.ws.send(JSON.stringify(payload));
  }

  private sendState(conn: Conn): void {
    const b = this.rooms.binding(conn.sid);
    this.sendTo(conn, { t: 'state', state: b ? this.rooms.view(b.room, b.uid, (s) => this.isConnected(s)) : null });
  }

  broadcast(room: DrawRoom): void {
    for (const p of room.players) {
      if (!p.sid) continue;
      const view = this.rooms.view(room, p.uid, (s) => this.isConnected(s));
      for (const c of this.conns.get(p.sid) ?? []) this.sendTo(c, { t: 'state', state: view });
    }
  }

  /** A stroke, undo or clear goes to the spectators only: the other painter must not see it. */
  private relay(room: DrawRoom, payload: unknown): void {
    for (const p of room.players) {
      if (!p.sid || this.rooms.slotOf(room, p.uid) >= 0) continue;
      for (const c of this.conns.get(p.sid) ?? []) this.sendTo(c, payload);
    }
  }

  private after(room: DrawRoom): void {
    this.schedule(room);
    this.broadcast(room);
    this.logResult(room);
  }

  /**
   * Keep every finished game (the picture, both sets of strokes, the scores) in a file, so that real games can be replayed
   * through the judge later (scripts/draw-rescore.mjs). Only when a folder was given; failures are ignored.
   */
  private logResult(room: DrawRoom): void {
    if (!this.logDir || room.status !== 'RESULT' || !room.result || this.logged.get(room.roomId) === room.resultEndsAt) return;
    this.logged.set(room.roomId, room.resultEndsAt);
    const dir = this.logDir;
    const body = JSON.stringify({
      at: new Date().toISOString(), roomId: room.roomId, picture: room.referenceId, slotNames: room.slotNames,
      scores: room.result.scores, winner: room.result.winner, forfeit: room.result.forfeit, strokes: room.strokes,
    });
    mkdir(dir, { recursive: true }).then(() => writeFile(join(dir, `${Date.now()}-${room.referenceId}-${room.roomId}.json`), body)).catch(() => {});
  }

  /** One timer per room, for whichever clock is running. */
  private schedule(room: DrawRoom): void {
    const old = this.timers.get(room.roomId);
    if (old) clearTimeout(old);
    this.timers.delete(room.roomId);
    const at = this.rooms.nextTickAt(room);
    if (at === null) return;
    this.timers.set(
      room.roomId,
      setTimeout(() => {
        this.timers.delete(room.roomId);
        this.rooms.tick(room);
        this.after(room);
      }, Math.max(0, at - Date.now())),
    );
  }
}
