// Real-browser layout stability check: the turn indicator area must never make the page jump.
// Samples the Y position of the block under the table (the betting panel) and the heights of the table parts
// in every state that used to change them, and fails if they differ.   Usage: node scripts/stability-check.mjs
import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';
import { startServer } from '../src/server/server.ts';

const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find((p) => existsSync(p));
if (!CHROME) throw new Error('no Chrome/Edge found');
const srv = await startServer({ port: 0, botDelayMs: 600_000, turnTimeMs: 600_000, offlineGraceMs: 600_000 });
const b = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;

for (const [w, h, mobile] of [[320, 640, true], [393, 852, true], [1280, 800, false]]) {
  const ctx = await b.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: w, height: h, deviceScaleFactor: 1, isMobile: mobile, hasTouch: mobile });
  await page.goto(`http://127.0.0.1:${srv.port}/`, { waitUntil: 'networkidle0' });
  await page.type('input[type=text]', '阿龍');
  const click = (t, ex = true) => page.evaluate((t, ex) => [...document.querySelectorAll('button')].find((x) => (ex ? x.textContent === t : x.textContent.includes(t))).click(), t, ex);
  await click('建立');
  await page.waitForSelector('.plate');
  await click('電腦玩家', false);
  await click('電腦玩家', false);
  await page.waitForFunction(() => document.querySelectorAll('.plist li').length === 3);
  await click('開始遊戲');
  await page.waitForSelector('.turnbar .name');
  const room = [...srv.hub.manager.rooms.values()].at(-1);
  const g = room.game;
  const sid = room.players.find((p) => p.uid === room.hostUid).sid; // the real cookie of the host's browser
  const push = async () => {
    srv.hub.broadcast(room);
    await sleep(250);
  };
  const measure = () =>
    page.evaluate(() => {
      const top = (s) => Math.round(document.querySelector(s).getBoundingClientRect().top);
      const hgt = (s) => Math.round(document.querySelector(s).getBoundingClientRect().height);
      const tb = document.querySelector('.turnbar');
      return {
        actionsTop: top('.actions-wrap'),
        turnbarH: hgt('.turnbar'),
        stageH: hgt('.stage'),
        nameTop: Math.round(tb.querySelector('.name').getBoundingClientRect().top),
        nameText: tb.querySelector('.name').textContent.trim(),
      };
    });

  const rows = [];
  const sample = async (label) => rows.push({ label, ...(await measure()) });

  while (g.currentUid !== room.hostUid) srv.hub.manager.autoTurn(room);
  room.turnStartAt = 0;
  await push();
  await sample('my turn, no bet yet');
  srv.hub.manager.bet(sid, g.currentTurnId, 100);
  await push();
  await sample('my turn, bet placed');
  g.gate = [{ suit: 'S', rank: 8 }, { suit: 'H', rank: 9 }];
  await push();
  await sample('consecutive gate (8,9)');
  g.gate = [{ suit: 'S', rank: 7 }, { suit: 'H', rank: 9 }];
  await push();
  await sample('narrow gate (7,9)');
  const corner = await page.evaluate(() => {
    const n = document.querySelector('.gatenote').getBoundingClientRect();
    const t = document.querySelector('.table').getBoundingClientRect();
    const pillars = [...document.querySelectorAll('.pillar')].map((p) => p.getBoundingClientRect());
    return { topRight: n.right > t.right - 24 && n.top < t.top + 24, clearOfCards: pillars.every((p) => n.bottom <= p.top + 1), insidePanel: n.left >= t.left && n.right <= t.right };
  });
  if (!corner.topRight || !corner.clearOfCards || !corner.insidePanel) {
    bad++;
    console.log('       narrow-gate notice misplaced', JSON.stringify(corner));
  }
  g.gate = [{ suit: 'S', rank: 3 }, { suit: 'H', rank: 9 }];
  await push();
  await sample('wide gate (3,9): no notice');
  await page.evaluate(() => showBanner('某某 射中！贏得獎池 12,345', 'HIT'));
  await sleep(150);
  await sample('result banner showing');
  await page.evaluate(() => hideBanner());
  await sleep(150);
  await sample('banner hidden again');
  srv.hub.manager.decide(sid, g.currentTurnId, 'PASS');
  await push();
  await sample("someone else's turn");

  const keys = ['actionsTop', 'turnbarH', 'stageH', 'nameTop'];
  const spread = Object.fromEntries(keys.map((k) => [k, Math.max(...rows.map((r) => r[k])) - Math.min(...rows.map((r) => r[k]))]));
  const jumpy = keys.filter((k) => spread[k] > 0);
  if (jumpy.length) bad++;
  console.log(`${String(w).padStart(5)}px  ${jumpy.length ? 'JUMPS' : 'stable'}  spread(px) ${JSON.stringify(spread)}`);
  if (jumpy.length) for (const r of rows) console.log('       ', r.label.padEnd(26), 'actionsTop', r.actionsTop, 'turnbarH', r.turnbarH, 'stageH', r.stageH, 'name:', JSON.stringify(r.nameText));
  await ctx.close();
}
await b.close();
await srv.close();
console.log(bad ? `\n${bad} width(s) jump` : '\nthe table area never moves');
process.exit(bad ? 1 : 0);
