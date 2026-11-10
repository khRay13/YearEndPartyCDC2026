import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir, rename, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { GameError } from '../engine/game.ts';
import type { TurnRecord } from '../engine/game.ts';
import { RoomManager, ROOM_IDLE_MS, TURN_TIME_MS } from './rooms.ts';
import type { Room } from './rooms.ts';
import { DrawHub } from '../draw/hub.ts';

const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(here, '../../public');

export interface HubOptions {
  /** Persist state here (JSON). Omit to keep everything in memory. */
  stateFile?: string;
  /** Pause after a turn so clients can play the reveal animation. */
  pauseMs?: { pass: number; shot: number; extra: number };
  /** Delay before a computer-controlled player acts. */
  botDelayMs?: number;
  /** How long the host has to start the game before the role passes to a random player (default 5 minutes). */
  startLimitMs?: number;
  /** How long the host has to come back after another player did (default 5 minutes). */
  hostReturnMs?: number;
  /** Delay between computer turns once no live human remains. */
  fastDelayMs?: number;
  /** Grace period before an offline human's turn is auto-played. */
  offlineGraceMs?: number;
  turnTimeMs?: number;
  /** Rooms with nobody connected are removed after this much inactivity (default 30 minutes). */
  roomIdleMs?: number;
  /** How often the room sweep runs (default 1 minute). */
  sweepMs?: number;
}

interface Conn {
  ws: WebSocket;
  sid: string;
}

export class Hub {
  manager: RoomManager;
  private conns = new Map<string, Set<Conn>>();
  private timers = new Map<string, NodeJS.Timeout>();
  private saveTimer: NodeJS.Timeout | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;
  private opts: Required<Omit<HubOptions, 'stateFile'>> & { stateFile?: string };

  constructor(opts: HubOptions = {}) {
    this.opts = {
      stateFile: opts.stateFile,
      pauseMs: opts.pauseMs ?? { pass: 900, shot: 3400, extra: 1800 },
      botDelayMs: opts.botDelayMs ?? 1200,
      fastDelayMs: opts.fastDelayMs ?? 12,
      offlineGraceMs: opts.offlineGraceMs ?? 3000,
      turnTimeMs: opts.turnTimeMs ?? TURN_TIME_MS,
      roomIdleMs: opts.roomIdleMs ?? ROOM_IDLE_MS,
      sweepMs: opts.sweepMs ?? 60_000,
    };
    this.manager = new RoomManager({ hostReturnMs: opts.hostReturnMs, startLimitMs: opts.startLimitMs });
    this.sweepTimer = setInterval(() => this.sweepRooms(), this.opts.sweepMs);
    this.sweepTimer.unref();
    if (this.opts.stateFile && existsSync(this.opts.stateFile)) {
      try {
        this.manager.load(JSON.parse(readFileSync(this.opts.stateFile, 'utf8')));
        for (const room of this.manager.rooms.values()) {
          if (room.status === 'PLAYING') {
            room.turnStartAt = Date.now() + 3000;
            this.schedule(room);
          }
          this.scheduleHostTimer(room);
          this.scheduleStartTimer(room);
        }
        console.log(`[hub] restored ${this.manager.rooms.size} room(s)`);
      } catch (e) {
        console.error('[hub] failed to restore state:', e);
      }
    }
  }

  // ---- room recycling ----------------------------------------------------

  /** Drop closed / abandoned rooms together with their timers; persists when something was removed. */
  sweepRooms(): string[] {
    const removed = this.manager.sweep((sid) => this.isConnected(sid), this.opts.roomIdleMs);
    for (const id of removed) {
      for (const m of [this.timers, this.hostTimers, this.broadcastTimers, this.startTimers]) {
        const t = m.get(id);
        if (t) clearTimeout(t);
        m.delete(id);
      }
    }
    if (removed.length) this.persist();
    return removed;
  }

  // ---- connections -------------------------------------------------------

  isConnected(sid: string | null): boolean {
    return !!sid && (this.conns.get(sid)?.size ?? 0) > 0;
  }

  private connectedUid(room: Room) {
    return (uid: string) => this.isConnected(room.players.find((p) => p.uid === uid)?.sid ?? null);
  }

  attach(ws: WebSocket, sid: string): void {
    const conn: Conn = { ws, sid };
    if (!this.conns.has(sid)) this.conns.set(sid, new Set());
    this.conns.get(sid)!.add(conn);
    const b = this.manager.binding(sid);
    const left = !!this.manager.rejoinable(sid);
    if (b && !left) {
      this.manager.emit(b.room, 'PLAYER_ONLINE', { uid: b.uid });
      this.broadcast(b.room);
      if (b.room.status === 'PLAYING') this.schedule(b.room);
    } else {
      this.sendHome(conn);
    }

    ws.on('message', (data) => {
      let msg: any;
      try {
        if ((data as Buffer).length > 4096) throw new Error('too large');
        msg = JSON.parse(String(data));
      } catch {
        return this.sendTo(conn, { t: 'error', code: 'BAD_MESSAGE', message: '訊息格式錯誤' });
      }
      try {
        this.handle(conn, msg);
      } catch (e) {
        if (e instanceof GameError) {
          this.sendTo(conn, { t: 'error', code: e.code, message: e.message, ref: msg?.t });
        } else {
          console.error('[hub] unexpected error', e);
          this.sendTo(conn, { t: 'error', code: 'INTERNAL', message: '伺服器錯誤' });
        }
      }
    });
    ws.on('close', () => {
      this.conns.get(sid)?.delete(conn);
      if (!this.isConnected(sid)) {
        this.conns.delete(sid);
        const bb = this.manager.binding(sid);
        if (bb) {
          this.manager.emit(bb.room, 'PLAYER_OFFLINE', { uid: bb.uid });
          if (bb.room.status === 'PLAYING') this.schedule(bb.room);
          this.broadcast(bb.room);
        }
      }
    });
  }

  // ---- message handling --------------------------------------------------

  private handle(conn: Conn, msg: any): void {
    const { sid } = conn;
    const m = this.manager;
    switch (msg?.t) {
      case 'create': {
        const { room } = m.createRoom(sid, msg.nickname);
        this.after(room);
        break;
      }
      case 'join': {
        const { room } = m.joinRoom(sid, msg.roomId, msg.nickname);
        m.rejoin(sid); // typing your own room's number again also brings you back
        this.after(room);
        if (room.status === 'PLAYING') this.schedule(room);
        break;
      }
      case 'leave': {
        const b = m.binding(sid);
        const room = m.leave(sid);
        if (room && b) {
          if (room.status === 'PLAYING') {
            // Host leaving hands the role to a random other player; the computer takes over their turns.
            m.transferHostIfNeeded(room, b.uid, this.connectedUid(room));
            this.schedule(room);
          }
          this.after(room);
        }
        if (room) this.scheduleHostTimer(room);
        // Every tab of this device goes back to the home screen.
        for (const c of this.conns.get(sid) ?? []) this.sendHome(c);
        break;
      }
      case 'rejoin': {
        const room = m.rejoin(sid);
        this.schedule(room);
        this.after(room);
        break;
      }
      case 'start': {
        const room = m.start(sid);
        this.scheduleHostTimer(room); // clears the host clock
        this.schedule(room);
        this.after(room);
        break;
      }
      case 'kick': {
        const b = m.binding(sid);
        const targetSid = b?.room.players.find((p) => p.uid === String(msg.uid))?.sid;
        const room = m.kick(sid, String(msg.uid));
        this.notifyRemoved(targetSid);
        this.schedule(room);
        this.after(room);
        break;
      }
      case 'setAuto': {
        const room = m.setAuto(sid, !!msg.on);
        this.schedule(room);
        this.after(room);
        break;
      }
      case 'setObserver': {
        this.after(m.setObserver(sid, String(msg.uid), !!msg.observer));
        break;
      }
      case 'playAgain': {
        const room = m.playAgain(sid);
        this.scheduleHostTimer(room);
        this.after(room);
        break;
      }
      case 'chat': {
        this.after(m.chat(sid, msg.text));
        break;
      }
      case 'setDeck': {
        this.after(m.setDeckCopies(sid, Number(msg.copies)));
        break;
      }
      case 'setConsecutive': {
        this.after(m.setAllowConsecutive(sid, msg.allow === true));
        break;
      }
      case 'addBot': {
        this.after(m.addBot(sid));
        break;
      }
      case 'bet': {
        const room = m.bet(sid, Number(msg.turnId), Number(msg.amount), msg.actionId);
        this.after(room);
        break;
      }
      case 'decide': {
        const b = m.binding(sid);
        const rec = m.decide(sid, Number(msg.turnId), msg.action, msg.actionId);
        this.afterRecord(b!.room, rec);
        break;
      }
      case 'ping':
        this.sendTo(conn, { t: 'pong', now: Date.now() });
        break;
      default:
        throw new GameError('BAD_MESSAGE', '未知的訊息類型');
    }
  }

  /** Tell a device it was removed from a lobby (it no longer has a binding). */
  private notifyRemoved(sid: string | null | undefined): void {
    if (!sid || this.manager.binding(sid)) return;
    for (const c of this.conns.get(sid) ?? []) this.sendTo(c, { t: 'state', state: null, notice: '你已被房主剔除' });
  }

  // ---- turn flow ---------------------------------------------------------

  private afterRecord(room: Room, rec: TurnRecord): void {
    const p = this.opts.pauseMs;
    // Extra time for the "eliminated" notice and for collecting + reshuffling + re-dealing the gate.
    // The turn that knocks out the last live human is still played in full (animation, notices); only after it
    // do the computers start to fast-forward.
    let fast = this.manager.isFastForward(room);
    if (fast && !this.fastRooms.has(room.roomId)) {
      this.fastRooms.add(room.roomId);
      room.fastHoldUntil = Date.now() + (rec.action === 'SHOOT' ? p.shot : p.pass) + (rec.eliminated ? p.extra : 0) + (rec.roundEnded ? p.extra * 2 : 0) + (rec.isAllIn ? p.extra : 0);
      fast = false;
    } else if (!fast && !(room.fastHoldUntil && Date.now() < room.fastHoldUntil)) this.fastRooms.delete(room.roomId);
    const pause = fast ? 0 : (rec.action === 'SHOOT' ? p.shot : p.pass) + (rec.eliminated ? p.extra : 0) + (rec.roundEnded ? p.extra * 2 : 0) + (rec.isAllIn ? p.extra : 0);
    room.turnStartAt = Date.now() + pause;
    this.schedule(room);
    this.after(room);
  }

  /** Rooms that are (or were just switched to) fast-forward, to spot the moment the last human drops out. */
  private fastRooms = new Set<string>();

  private isComputer(room: Room, uid: string): boolean {
    const p = room.players.find((x) => x.uid === uid);
    return !p || p.isBot || p.kicked || !!p.autoMode;
  }

  /** (Re)arm the single per-room timer for whoever must act next. */
  schedule(room: Room): void {
    const old = this.timers.get(room.roomId);
    if (old) clearTimeout(old);
    this.timers.delete(room.roomId);
    const g = room.game;
    if (room.status !== 'PLAYING' || !g) return;
    const uid = g.currentUid;
    const player = room.players.find((p) => p.uid === uid);
    const now = Date.now();
    let at: number;
    if (this.isComputer(room, uid)) {
      // Only computers (and nobody to watch live) left: play the rest of the match out quickly.
      at = Math.max(room.turnStartAt, now) + (this.manager.isFastForward(room) ? this.opts.fastDelayMs : this.opts.botDelayMs);
    } else if (!this.isConnected(player?.sid ?? null)) {
      at = Math.max(room.turnStartAt, now + this.opts.offlineGraceMs);
    } else {
      at = room.turnStartAt + this.opts.turnTimeMs;
    }
    const turnId = g.currentTurnId;
    this.timers.set(
      room.roomId,
      setTimeout(() => this.fire(room, turnId), Math.max(0, at - now)),
    );
  }

  private fire(room: Room, turnId: number): void {
    this.timers.delete(room.roomId);
    const g = room.game;
    if (room.status !== 'PLAYING' || !g || g.currentTurnId !== turnId) return;
    const uid = g.currentUid;
    const player = room.players.find((p) => p.uid === uid);
    const computer = this.isComputer(room, uid);
    const offline = !this.isConnected(player?.sid ?? null);
    const timedOut = Date.now() >= room.turnStartAt + this.opts.turnTimeMs;
    // No live human left: nobody is watching, so skip all the pacing and burn through the turns.
    if (this.manager.isFastForward(room)) return this.runFastForward(room);
    if (!computer && !offline && !timedOut) return this.schedule(room); // came back in time
    try {
      const rec = this.manager.autoTurn(room);
      this.afterRecord(room, rec);
    } catch (e) {
      console.error('[hub] autoTurn failed', e);
    }
  }

  /**
   * Computer-only match: play many turns per timer tick (no per-turn timers, no per-turn broadcast, no per-turn
   * view building) and tell the clients at most a few times per second, plus once when it is over.
   */
  private runFastForward(room: Room): void {
    const t0 = Date.now();
    let turns = 0;
    try {
      while (room.status === 'PLAYING' && this.manager.isFastForward(room) && turns < 5000 && Date.now() - t0 < 30) {
        this.manager.autoTurn(room);
        turns++;
      }
    } catch (e) {
      console.error('[hub] fast-forward failed', e);
    }
    room.turnStartAt = Date.now();
    this.schedule(room);
    this.broadcastSoon(room);
    this.persist();
  }

  private hostTimers = new Map<string, NodeJS.Timeout>();

  /** (Re)arm the clock that hands the room to the first returner when the host stays away (spec 3.4.3). */
  scheduleHostTimer(room: Room): void {
    const old = this.hostTimers.get(room.roomId);
    if (old) clearTimeout(old);
    this.hostTimers.delete(room.roomId);
    if (!room.lobbyDeadline) return;
    this.hostTimers.set(
      room.roomId,
      setTimeout(() => {
        this.hostTimers.delete(room.roomId);
        if (this.manager.checkHostSuccession(room)) this.after(room);
        else this.persist();
      }, Math.max(0, room.lobbyDeadline - Date.now())),
    );
  }

  private startTimers = new Map<string, NodeJS.Timeout>();

  /** (Re)arm the waiting-room countdown clock: minute reminders, the last 10 seconds, then the host hand-over. */
  scheduleStartTimer(room: Room): void {
    const old = this.startTimers.get(room.roomId);
    if (old) clearTimeout(old);
    this.startTimers.delete(room.roomId);
    const at = this.manager.nextStartTickAt(room);
    if (at === null) return;
    this.startTimers.set(
      room.roomId,
      setTimeout(() => {
        this.startTimers.delete(room.roomId);
        const hostSid = room.players.find((p) => p.uid === room.hostUid)?.sid ?? null;
        if (!this.manager.tickStart(room, (uid) => this.isConnected(room.players.find((p) => p.uid === uid)?.sid ?? null))) return this.scheduleStartTimer(room);
        if (room.status === 'CLOSED') {
          // nobody else was left: the host is sent home and the room goes through the normal recycling
          for (const c of this.conns.get(hostSid ?? '') ?? []) this.sendTo(c, { t: 'state', state: null, notice: '開局時間到，房間已關閉' });
          this.sweepRooms();
        } else this.after(room);
      }, Math.max(0, at - Date.now())),
    );
  }

  private broadcastTimers = new Map<string, NodeJS.Timeout>();

  /** Coalesce broadcasts (fast-forward); a finished match is announced immediately. */
  private broadcastSoon(room: Room): void {
    if (room.status !== 'PLAYING') {
      const t = this.broadcastTimers.get(room.roomId);
      if (t) clearTimeout(t);
      this.broadcastTimers.delete(room.roomId);
      return this.broadcast(room);
    }
    if (this.broadcastTimers.has(room.roomId)) return;
    this.broadcastTimers.set(
      room.roomId,
      setTimeout(() => {
        this.broadcastTimers.delete(room.roomId);
        this.broadcast(room);
      }, 150),
    );
  }

  // ---- output ------------------------------------------------------------

  private viewFor(sid: string) {
    const b = this.manager.binding(sid);
    if (!b) return null;
    return this.manager.view(b.room, b.uid, this.connectedUid(b.room));
  }

  /** Tell a connection it is not in a room (home screen), offering the way back if it left a live match. */
  private sendHome(conn: Conn): void {
    this.sendTo(conn, { t: 'state', state: null, rejoin: this.manager.rejoinable(conn.sid) });
  }

  private after(room: Room): void {
    this.scheduleStartTimer(room);
    this.broadcast(room);
    this.persist();
  }

  broadcast(room: Room): void {
    const sids = new Set(room.players.map((p) => p.sid).filter((s): s is string => !!s));
    for (const sid of sids) {
      const set = this.conns.get(sid);
      if (!set) continue;
      if (this.manager.rejoinable(sid)) continue; // they left: stay on the home screen
      const state = this.viewFor(sid);
      for (const c of set) this.sendTo(c, { t: 'state', state });
    }
  }

  private sendTo(conn: Conn, payload: unknown): void {
    if (conn.ws.readyState === WebSocket.OPEN) conn.ws.send(JSON.stringify(payload));
  }

  // ---- persistence (spec Phase 5) ---------------------------------------

  persist(): void {
    if (!this.opts.stateFile || this.saveTimer) return;
    this.saveTimer = setTimeout(async () => {
      this.saveTimer = null;
      try {
        const file = this.opts.stateFile!;
        await mkdir(dirname(file), { recursive: true });
        const tmp = file + '.tmp';
        await writeFile(tmp, JSON.stringify(this.manager.toJSON()));
        await rename(tmp, file); // atomic replace
      } catch (e) {
        console.error('[hub] persist failed', e);
      }
    }, 400);
  }

  close(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    for (const t of this.broadcastTimers.values()) clearTimeout(t);
    this.broadcastTimers.clear();
    for (const t of this.hostTimers.values()) clearTimeout(t);
    this.hostTimers.clear();
    for (const t of this.startTimers.values()) clearTimeout(t);
    this.startTimers.clear();
    if (this.saveTimer) clearTimeout(this.saveTimer);
  }
}

// ---- HTTP + WebSocket bootstrap ---------------------------------------------

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function startServer(opts: HubOptions & { port?: number; drawLogDir?: string } = {}) {
  const hub = new Hub(opts);
  const secure = process.env.COOKIE_SECURE === '1';

  const http = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? '/', 'http://x');
      if (url.pathname === '/healthz') {
        res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
        return;
      }
      let rel = decodeURIComponent(url.pathname);
      if (!rel.endsWith('/') && !extname(rel)) {
        // a folder without its trailing slash (/gate): relative links inside the page need the slash
        // (leading slashes collapsed: "//host" must never turn into a redirect to another site)
        res.writeHead(301, { location: '/' + url.pathname.replace(/^\/+/, '') + '/' + url.search }).end();
        return;
      }
      if (rel.endsWith('/')) rel += 'index.html'; // / is the festival home page, /gate/ is the game
      const file = normalize(join(PUBLIC_DIR, rel));
      if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + sep)) {
        res.writeHead(403).end('forbidden');
        return;
      }
      const [body, info] = await Promise.all([readFile(file).catch(() => null), stat(file).catch(() => null)]);
      if (!body || !info) {
        res.writeHead(404).end('not found');
        return;
      }
      const etag = `W/"${info.size.toString(16)}-${Math.round(info.mtimeMs).toString(16)}"`;
      const headers: Record<string, string> = {
        'content-type': MIME[extname(file)] ?? 'application/octet-stream',
        'cache-control': 'no-cache', // always ask, but the answer is a 304 when nothing changed
        etag,
      };
      if (req.headers['if-none-match'] === etag && parseCookies(req.headers.cookie).sid) {
        res.writeHead(304, headers).end(); // (a first visit still gets the full page: it carries the device cookie)
        return;
      }
      if (!parseCookies(req.headers.cookie).sid) {
        headers['set-cookie'] =
          `sid=${randomBytes(24).toString('hex')}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000` +
          (secure ? '; Secure' : '');
      }
      res.writeHead(200, headers).end(body);
    } catch {
      res.writeHead(500).end('error');
    }
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  // the drawing game: its own rooms on its own socket path, same device cookie
  const drawHub = new DrawHub({ logDir: opts.drawLogDir });
  const drawWss = new WebSocketServer({ noServer: true, maxPayload: 65_536 }); // (a bucket fill of a complicated area is a long list of rows)
  http.on('upgrade', (req, socket, head) => {
    const sid = parseCookies(req.headers.cookie).sid;
    if (!sid || !/^[0-9a-f]{48}$/.test(sid)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    if (new URL(req.url ?? '/', 'http://x').pathname === '/ws/draw') drawWss.handleUpgrade(req, socket, head, (ws) => drawHub.attach(ws, sid));
    else wss.handleUpgrade(req, socket, head, (ws) => hub.attach(ws, sid));
  });

  const port = opts.port ?? Number(process.env.PORT ?? 3000);
  return new Promise<{ hub: Hub; drawHub: DrawHub; port: number; close: () => Promise<void> }>((resolveP) => {
    http.listen(port, () => {
      const addr = http.address();
      const actual = typeof addr === 'object' && addr ? addr.port : port;
      resolveP({
        hub,
        drawHub,
        port: actual,
        close: () =>
          new Promise<void>((r) => {
            hub.close();
            drawHub.close();
            wss.clients.forEach((c) => c.terminate());
            drawWss.clients.forEach((c) => c.terminate());
            http.close(() => r());
          }),
      });
    });
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { port } = await startServer({
    stateFile: process.env.STATE_FILE ?? resolve(here, '../../data/state.json'),
    drawLogDir: process.env.DRAW_LOG_DIR ?? resolve(here, '../../data/draw-results'), // finished 臨摹大賽 games, for calibrating the judge
  });
  console.log(`射龍門 server listening on http://localhost:${port}`);
}
