import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { Hub, startServer } from '../src/server/server.ts';

type Msg = any;

async function getSid(port: number): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/`);
  const m = /sid=([0-9a-f]{48})/.exec(res.headers.get('set-cookie') ?? '');
  assert.ok(m, 'server must set sid cookie');
  assert.match(res.headers.get('set-cookie')!, /HttpOnly/);
  return m![1]!;
}

class Client {
  ws!: WebSocket;
  state: Msg = undefined;
  rejoin: Msg = undefined;
  errors: string[] = [];
  waiters: ((s: Msg) => boolean)[] = [];
  onState?: (s: Msg) => void;
  port: number;
  sid: string;
  constructor(port: number, sid: string) {
    this.port = port;
    this.sid = sid;
  }
  async open() {
    this.ws = new WebSocket(`ws://127.0.0.1:${this.port}/ws`, { headers: { cookie: `sid=${this.sid}` } });
    this.ws.on('message', (d) => {
      const m = JSON.parse(String(d));
      if (m.t === 'error') this.errors.push(m.code);
      if (m.t === 'state') {
        this.state = m.state;
        this.rejoin = m.rejoin;
        this.onState?.(m.state);
      }
    });
    await new Promise<void>((res, rej) => {
      this.ws.once('open', () => res());
      this.ws.once('error', rej);
    });
    await this.until((s) => s !== undefined);
  }
  send(o: object) {
    this.ws.send(JSON.stringify(o));
  }
  until(pred: (s: Msg) => boolean, ms = 20000): Promise<Msg> {
    return new Promise((res, rej) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        if (pred(this.state)) {
          clearInterval(iv);
          res(this.state);
        } else if (Date.now() - t0 > ms) {
          clearInterval(iv);
          rej(new Error('timeout waiting for state: ' + JSON.stringify(this.state)?.slice(0, 300)));
        }
      }, 10);
    });
  }
  close() {
    this.ws.close();
  }
}

const fast = { pauseMs: { pass: 0, shot: 0, extra: 0 }, botDelayMs: 0, offlineGraceMs: 30, turnTimeMs: 60 };

test('websocket server: no cookie -> 401', async () => {
  const srv = await startServer({ port: 0, ...fast });
  try {
    await assert.rejects(
      new Promise((_, rej) => {
        const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`);
        ws.on('error', rej);
        ws.on('open', () => rej(new Error('should not open')));
      }),
    );
  } finally {
    await srv.close();
  }
});

test('static: path traversal blocked, healthz ok', async () => {
  const srv = await startServer({ port: 0, ...fast });
  try {
    assert.equal((await fetch(`http://127.0.0.1:${srv.port}/healthz`)).status, 200);
    const r = await fetch(`http://127.0.0.1:${srv.port}/..%2f..%2fpackage.json`);
    assert.notEqual(r.status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${srv.port}/style.css`)).status, 200);
  } finally {
    await srv.close();
  }
});

test('end to end: create, join, unknown room, start, offline auto-play, cookie reconnect, finish', async () => {
  const srv = await startServer({ port: 0, ...fast });
  const clients: Client[] = [];
  try {
    const sidA = await getSid(srv.port);
    const sidB = await getSid(srv.port);
    const sidC = await getSid(srv.port);
    const A = new Client(srv.port, sidA);
    const B = new Client(srv.port, sidB);
    const C = new Client(srv.port, sidC);
    clients.push(A, B, C);
    await Promise.all([A.open(), B.open(), C.open()]);

    A.send({ t: 'create', nickname: '房主' });
    const s1 = await A.until((s) => s?.status === 'WAITING');
    const roomId = s1.roomId;
    const hostUid = s1.me;

    C.send({ t: 'join', roomId: '999999', nickname: 'C' });
    await C.until(() => C.errors.includes('ROOM_NOT_FOUND'));
    assert.equal(C.state, null);

    B.send({ t: 'join', roomId, nickname: 'B' });
    await A.until((s) => s?.status === 'READY' && s.players.length === 2);
    const bUid = B.state.me;
    assert.notEqual(bUid, hostUid);

    B.send({ t: 'start' });
    await B.until(() => B.errors.includes('NOT_HOST'));
    A.send({ t: 'start' });
    await A.until((s) => s?.status === 'PLAYING');
    // deck must never be exposed
    assert.equal(JSON.stringify(A.state).includes('"deck"'), false);

    // Humans act promptly (bet big, shoot); B drops mid-game and is computer-played.
    const play = (c: Client) => {
      c.onState = (s) => {
        const g = s?.game;
        if (!g || !g.canAct || s.status !== 'PLAYING') return;
        if (g.currentBet == null) c.send({ t: 'bet', turnId: g.turnId, amount: 5000, actionId: 'a' + Math.random() });
        else c.send({ t: 'decide', turnId: g.turnId, action: 'SHOOT', actionId: 'a' + Math.random() });
      };
    };
    play(A);
    play(B);
    A.send({ t: 'ping' });

    // B disconnects; A keeps going. B's turns must be auto-played.
    B.onState = undefined;
    B.close();
    await A.until((s) => s.players.find((p: any) => p.uid === bUid)?.connected === false);
    await A.until((s) => s.events.some((e: any) => e.type === 'AUTO_PLAYED' && e.payload.uid === bUid));

    // B returns with the same cookie: same UID, state synced.
    const B2 = new Client(srv.port, sidB);
    clients.push(B2);
    await B2.open();
    assert.equal(B2.state.me, bUid);
    assert.equal(B2.state.status === 'PLAYING' || B2.state.status === 'FINISHED', true);

    await A.until((s) => s.status === 'FINISHED', 60000);
    const final = A.state;
    assert.equal(final.game.ranking.length, 2);
    assert.deepEqual(final.game.ranking.map((r: any) => r.rank), [1, 2]);
    assert.ok(final.events.length > 0);
    const rooms = [...srv.hub.manager.rooms.values()];
    assert.deepEqual(rooms[0]!.game!.checkIntegrity(), []);
  } finally {
    for (const c of clients) c.ws?.terminate();
    await srv.close();
  }
});

test('late joiner rejected after start; room full', async () => {
  const srv = await startServer({ port: 0, ...fast, turnTimeMs: 60_000 });
  const clients: Client[] = [];
  try {
    const A = new Client(srv.port, await getSid(srv.port));
    clients.push(A);
    await A.open();
    A.send({ t: 'create', nickname: 'A' });
    const { roomId } = await A.until((s) => s?.status === 'WAITING');
    A.send({ t: 'addBot' });
    await A.until((s) => s?.players?.length === 2);
    A.send({ t: 'start' });
    await A.until((s) => s?.status === 'PLAYING');
    const L = new Client(srv.port, await getSid(srv.port));
    clients.push(L);
    await L.open();
    L.send({ t: 'join', roomId, nickname: 'late' });
    await L.until(() => L.errors.includes('GAME_STARTED'));
  } finally {
    for (const c of clients) c.ws?.terminate();
    await srv.close();
  }
});

test('離開 button works: lobby leave -> home; mid-match leave -> home + rejoin, computer plays meanwhile', async () => {
  const srv = await startServer({ port: 0, ...fast, turnTimeMs: 60_000 });
  const clients: Client[] = [];
  try {
    const A = new Client(srv.port, await getSid(srv.port));
    clients.push(A);
    await A.open();
    A.send({ t: 'create', nickname: 'A' });
    await A.until((s) => s?.status === 'WAITING');
    A.send({ t: 'leave' }); // lobby: just leaves
    await A.until((s) => s === null);
    assert.equal(A.rejoin ?? null, null);

    A.send({ t: 'create', nickname: 'A' });
    await A.until((s) => s?.status === 'WAITING');
    A.send({ t: 'addBot' });
    A.send({ t: 'addBot' });
    await A.until((s) => s?.players?.length === 3);
    A.send({ t: 'start' });
    await A.until((s) => s?.status === 'PLAYING');
    const roomId = A.state.roomId;
    const uid = A.state.me;

    A.send({ t: 'leave' }); // the button that used to do nothing
    await A.until((s) => s === null);
    assert.equal(A.rejoin, roomId, 'home screen offers the way back');
    // computer takes over this seat; the match keeps going without them
    const room = srv.hub.manager.getRoom(roomId);
    assert.equal(room.players.find((p) => p.uid === uid)!.autoMode, true);

    A.send({ t: 'rejoin' });
    const back = await A.until((s) => s?.status === 'PLAYING' && s.me === uid);
    assert.equal(back.players.find((p: any) => p.uid === uid).autoMode, false);

    // a fresh connection of a device that left lands on home with the rejoin offer, not in the game
    A.send({ t: 'leave' });
    await A.until((s) => s === null);
    const A2 = new Client(srv.port, A.sid);
    clients.push(A2);
    await A2.open();
    assert.equal(A2.state, null);
    assert.equal(A2.rejoin, roomId);
  } finally {
    for (const c of clients) c.ws?.terminate();
    await srv.close();
  }
});

test('computer-only match plays out in batches: finishes fast with far fewer broadcasts than turns', async () => {
  const srv = await startServer({ port: 0, ...fast, turnTimeMs: 600_000, offlineGraceMs: 600_000 });
  const clients: Client[] = [];
  try {
    const A = new Client(srv.port, await getSid(srv.port));
    clients.push(A);
    await A.open();
    A.send({ t: 'create', nickname: 'A' });
    await A.until((s) => s?.status === 'WAITING');
    for (let i = 0; i < 5; i++) A.send({ t: 'addBot' });
    await A.until((s) => s?.players?.length === 6);
    A.send({ t: 'start' });
    await A.until((s) => s?.status === 'PLAYING');
    let messages = 0;
    A.ws.on('message', () => messages++);
    // the only human is knocked out: nobody is left to watch, so the computers burn through the match
    const room = [...srv.hub.manager.rooms.values()].at(-1)!;
    const g = room.game!;
    while (g.currentUid === A.state.me) srv.hub.manager.autoTurn(room); // it is the host's turn first: let the computer play it
    g.pot += g.player(A.state.me).chips; // the stake stays on the table: chips are conserved
    g.player(A.state.me).chips = 0;
    g.player(A.state.me).eliminated = true;
    g.player(A.state.me).rank = 6;
    srv.hub.schedule(room);
    const t0 = Date.now();
    await A.until((s) => s?.status === 'FINISHED', 20000);
    const took = Date.now() - t0;
    const turns = g.history.length;
    assert.ok(turns > 50, 'a real match was played: ' + turns + ' turns');
    assert.ok(messages < turns / 3, `${messages} broadcasts for ${turns} turns`);
    assert.ok(took < 8000, 'finished quickly: ' + took + 'ms');
    assert.deepEqual(g.checkIntegrity(), []);
  } finally {
    for (const c of clients) c.ws?.terminate();
    await srv.close();
  }
});

test('waiting room over real sockets: chat, observer, finish -> back to the waiting room with the win counted', async () => {
  const srv = await startServer({ port: 0, ...fast, turnTimeMs: 600_000, offlineGraceMs: 600_000 });
  const clients: Client[] = [];
  try {
    const A = new Client(srv.port, await getSid(srv.port));
    const B = new Client(srv.port, await getSid(srv.port));
    clients.push(A, B);
    await Promise.all([A.open(), B.open()]);
    A.send({ t: 'create', nickname: '房主' });
    const { roomId } = await A.until((s) => s?.status === 'WAITING');
    B.send({ t: 'join', roomId, nickname: '旁觀' });
    await A.until((s) => s?.players?.length === 2);

    // chat reaches everybody, as text, and is rate limited
    A.send({ t: 'chat', text: '  哈囉 <b>大家</b>  ' });
    await B.until((s) => s?.chat?.length === 1);
    assert.equal(B.state.chat[0].text, '哈囉 <b>大家</b>');
    assert.equal(B.state.chat[0].nickname, '房主');
    A.send({ t: 'chat', text: 'too fast' });
    await A.until(() => A.errors.includes('CHAT_TOO_FAST'));
    B.send({ t: 'chat', text: '' });
    await B.until(() => B.errors.includes('CHAT_EMPTY'));

    // only the host may mark an observer
    B.send({ t: 'setObserver', uid: B.state.me, observer: true });
    await B.until(() => B.errors.includes('NOT_HOST'));
    A.send({ t: 'setObserver', uid: B.state.me, observer: true });
    await B.until((s) => s?.players?.find((p: any) => p.uid === s.me)?.isObserver === true);
    A.send({ t: 'start' });
    await A.until(() => A.errors.includes('NOT_ENOUGH_PLAYERS')); // host alone does not make a match
    A.send({ t: 'addBot' });
    await A.until((s) => s?.players?.length === 3);
    A.send({ t: 'start' });
    await B.until((s) => s?.status === 'PLAYING');
    assert.equal(B.state.chat.length, 0, 'no chat during the match');
    assert.ok(B.state.players.find((p: any) => p.uid === B.state.me).isObserver);
    B.send({ t: 'bet', turnId: 1, amount: 100 });
    await B.until(() => B.errors.includes('NOT_A_PLAYER'));

    // the host is knocked out: only the bot plays on, fast; the observer watches it end
    const room = [...srv.hub.manager.rooms.values()].at(-1)!;
    const g = room.game!;
    while (g.currentUid === A.state.me) srv.hub.manager.autoTurn(room);
    g.pot += g.player(A.state.me).chips;
    g.player(A.state.me).chips = 0;
    g.player(A.state.me).eliminated = true;
    g.player(A.state.me).rank = 2;
    srv.hub.schedule(room);
    await B.until((s) => s?.status === 'FINISHED', 20000);
    const botUid = room.players.find((p) => p.isBot)!.uid;
    assert.equal(g.ranking()[0]!.uid, botUid);

    // everybody decides for themselves: B (the observer) goes first, the host is still reading the results
    B.send({ t: 'playAgain' });
    await B.until((s) => s?.status === 'READY' || s?.status === 'WAITING');
    assert.equal(A.state.status, 'FINISHED', 'the host still sees the result table');
    assert.equal(B.state.players.find((p: any) => p.uid === botUid).wins, 1, 'the winner has one win');
    assert.equal(B.state.players.find((p: any) => p.uid === B.state.me).isObserver, true, 'observer flag kept');
    assert.equal(B.state.chat.length, 1, 'and the chat is back');
    assert.ok(B.state.hostReturn && B.state.hostReturn.successor === '旁觀', 'the host clock is running for B');
    A.send({ t: 'playAgain' });
    await A.until((s) => s?.status === 'READY' || s?.status === 'WAITING');
    await B.until((s) => s?.hostReturn === null);
  } finally {
    for (const c of clients) c.ws?.terminate();
    await srv.close();
  }
});

test('host clock over real sockets: the host stays on the result table, the first one back becomes host', async () => {
  const srv = await startServer({ port: 0, ...fast, hostReturnMs: 400, turnTimeMs: 600_000, offlineGraceMs: 600_000 });
  const clients: Client[] = [];
  try {
    const A = new Client(srv.port, await getSid(srv.port));
    const B = new Client(srv.port, await getSid(srv.port));
    const C = new Client(srv.port, await getSid(srv.port));
    clients.push(A, B, C);
    await Promise.all([A.open(), B.open(), C.open()]);
    A.send({ t: 'create', nickname: '房主' });
    const { roomId } = await A.until((s) => s?.status === 'WAITING');
    B.send({ t: 'join', roomId, nickname: '甲' });
    C.send({ t: 'join', roomId, nickname: '乙' });
    await A.until((s) => s?.players?.length === 3);
    A.send({ t: 'addBot' });
    await A.until((s) => s?.players?.length === 4);
    A.send({ t: 'start' });
    await A.until((s) => s?.status === 'PLAYING');
    // end the match quickly: the three humans are knocked out and the bot wins
    const room = [...srv.hub.manager.rooms.values()].at(-1)!;
    const g = room.game!;
    for (const p of room.players.filter((x) => !x.isBot)) {
      while (g.currentUid === p.uid) srv.hub.manager.autoTurn(room);
      g.pot += g.player(p.uid).chips;
      g.player(p.uid).chips = 0;
      g.player(p.uid).eliminated = true;
      g.player(p.uid).rank = 4;
    }
    srv.hub.schedule(room);
    await C.until((s) => s?.status === 'FINISHED', 20000);

    C.send({ t: 'playAgain' }); // C is first back...
    await C.until((s) => s?.status === 'READY' || s?.status === 'WAITING');
    B.send({ t: 'playAgain' }); // ...B second; the host A never presses anything
    await B.until((s) => s?.status === 'READY' || s?.status === 'WAITING');
    assert.equal(C.state.hostUid, A.state.me, 'still the host for the moment');
    await C.until((s) => s?.hostUid === s?.me, 5000); // 400 ms later the room is C's
    assert.equal(B.state.hostUid, C.state.me, 'the first one back, not the second');
    assert.equal(C.state.hostReturn, null);
    assert.equal(A.state.status, 'FINISHED', 'the old host is still reading the results');
    // the new host can run the room; a player who is not host cannot
    C.send({ t: 'setDeck', copies: 2 });
    await B.until((s) => s?.deckCopies === 2);
    B.send({ t: 'setDeck', copies: 1 });
    await B.until(() => B.errors.includes('NOT_HOST'));
  } finally {
    for (const c of clients) c.ws?.terminate();
    await srv.close();
  }
});

test('Hub.sweepRooms drops an abandoned room and its timers', async () => {
  const hub = new Hub({ roomIdleMs: 0 });
  const { room } = hub.manager.createRoom('s1', '房主');
  assert.deepEqual(hub.sweepRooms(), [room.roomId]);
  assert.equal(hub.manager.rooms.size, 0);
  hub.close();
});
