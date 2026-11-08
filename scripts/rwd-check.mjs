// Real-browser RWD check: drives the system Chrome at phone/tablet widths and reports anything that
// makes the page scroll sideways, in static screens AND while animations play.
// Usage: node scripts/rwd-check.mjs [screenshot-dir]
import puppeteer from 'puppeteer-core';
import { existsSync, mkdirSync } from 'node:fs';
import { startServer } from '../src/server/server.ts';

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((p) => existsSync(p));
if (!CHROME) throw new Error('no Chrome/Edge found');

const shotDir = process.argv[2];
if (shotDir) mkdirSync(shotDir, { recursive: true });

const WIDTHS = [
  { name: 'iPhone SE', width: 320, height: 568 },
  { name: 'iPhone 15 Pro', width: 393, height: 852 },
  { name: 'iPhone Pro Max', width: 430, height: 932 },
  { name: 'iPad mini', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
];
const LONG_NAME = '一二三四五六七八九十甲乙'; // 12 wide characters

const srv = await startServer({ port: 0, pauseMs: { pass: 0, shot: 3400, extra: 1800 }, botDelayMs: 600000, turnTimeMs: 600000, offlineGraceMs: 600000 });
const url = `http://127.0.0.1:${srv.port}/`;
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Runs in the page: how far does the page scroll sideways, and which elements stick out? */
function measure() {
  const vw = document.documentElement.clientWidth;
  const sw = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
  const out = [];
  for (const e of document.querySelectorAll('body *')) {
    if (e.closest('.drawer, .backdrop, .conn, .toast')) continue;
    const r = e.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (r.right > vw + 0.5 || r.left < -0.5) {
      out.push({
        el: e.tagName.toLowerCase() + (typeof e.className === 'string' && e.className.trim() ? '.' + e.className.trim().split(/\s+/).join('.') : ''),
        left: Math.round(r.left),
        right: Math.round(r.right),
        text: (e.textContent || '').trim().slice(0, 20),
      });
    }
  }
  return { vw, sw, overflow: sw - vw, offenders: out.slice(0, 8) };
}

const clickText = (page, text, exact = true) =>
  page.evaluate((t, ex) => {
    const b = [...document.querySelectorAll('button')].find((x) => (ex ? x.textContent === t : x.textContent.includes(t)));
    if (!b) throw new Error('no button: ' + t);
    b.click();
  }, text, exact);

async function enterGame(page, { bots, nickname }) {
  await page.goto(url, { waitUntil: 'networkidle0' });
  await page.type('input[type=text]', nickname);
  await clickText(page, '建立');
  await page.waitForSelector('.plate');
  for (let i = 0; i < bots; i++) await clickText(page, '電腦玩家', false);
  await page.waitForFunction((n) => document.querySelectorAll('.plist li').length === n + 1, {}, bots);
}

const results = [];
const record = (device, label, m) => results.push({ device, label, ...m });

for (const d of WIDTHS.filter((w) => !process.env.RWD_WIDTH || String(w.width) === process.env.RWD_WIDTH)) { // RWD_WIDTH=320 runs one width
  const phone = d.width < 700;
  const newPage = async () => {
    const ctx = await browser.createBrowserContext(); // fresh cookies: always starts at the home screen
    const page = await ctx.newPage();
    await page.setViewport({ width: d.width, height: d.height, deviceScaleFactor: 2, isMobile: phone, hasTouch: phone });
    return { ctx, page };
  };
  const shot = async (page, label) => { if (shotDir) await page.screenshot({ path: `${shotDir}/${d.width}-${label}.png` }); };

  // ---- static screens (long nickname, many players) ----
  {
    const { ctx, page } = await newPage();
    await page.goto(url, { waitUntil: 'networkidle0' });
    record(d.name, 'home', await page.evaluate(measure));
    await enterGame(page, { bots: 11, nickname: LONG_NAME });
    record(d.name, 'lobby-12', await page.evaluate(measure));
    await shot(page, 'lobby-12');
    await clickText(page, '開始遊戲');
    await page.waitForSelector('.stage .pillar .card');
    await sleep(500);
    record(d.name, 'game-12', await page.evaluate(measure));
    // both gate cards must sit fully inside the table (a clipped card is a layout bug even without a scrollbar)
    const clip = await page.evaluate(() => {
      const stage = document.querySelector('.stage').getBoundingClientRect();
      const bad = [...document.querySelectorAll('.stage .pillar')].map((p) => p.getBoundingClientRect()).filter((b) => b.left < stage.left - 0.5 || b.right > stage.right + 0.5);
      return { ok: bad.length === 0, why: bad.map((b) => Math.round(b.left) + '..' + Math.round(b.right)).join(' ') + ' stage ' + Math.round(stage.left) + '..' + Math.round(stage.right) };
    });
    record(d.name, 'gate-visible', { vw: d.width, sw: d.width, overflow: clip.ok ? 0 : 1, offenders: clip.ok ? [] : [{ el: 'gate card clipped', left: 0, right: 0, text: clip.why }] });
    // the chip area must be exactly a 2 x 2 grid whatever the width
    const grid = await page.evaluate(() => {
      const r = [...document.querySelectorAll('.stepper')].map((e) => e.getBoundingClientRect());
      if (r.length !== 4) return { ok: false, why: 'expected 4 steppers, got ' + r.length };
      const same = (a, b) => Math.abs(a - b) < 1;
      const ok = same(r[0].top, r[1].top) && same(r[2].top, r[3].top) && r[2].top > r[0].top + 10 && same(r[0].left, r[2].left) && same(r[1].left, r[3].left) && r[1].left > r[0].left + 10;
      return { ok, why: r.map((x) => Math.round(x.left) + ',' + Math.round(x.top)).join(' ') };
    });
    record(d.name, 'chips-2x2', { vw: d.width, sw: d.width, overflow: grid.ok ? 0 : 1, offenders: grid.ok ? [] : [{ el: 'not 2x2', left: 0, right: 0, text: grid.why }] });
    await shot(page, 'game-12');
    if (phone) {
      await page.click('.menu-btn');
      await sleep(400);
      record(d.name, 'menu-open', await page.evaluate(measure));
      await shot(page, 'menu-open');
      await page.click('.backdrop');
    }
    await ctx.close();
  }

  // ---- animations: force each outcome, sample during the whole sequence ----
  for (const kind of ['miss-left', 'miss-right', 'collision-low', 'collision-high', 'hit']) {
    const { ctx, page } = await newPage();
    await enterGame(page, { bots: 2, nickname: LONG_NAME });
    await clickText(page, '開始遊戲');
    await page.waitForSelector('.stage .pillar .card');
    await sleep(300);
    // stack the deck so the next card produces the outcome under test
    const room = [...srv.hub.manager.rooms.values()].at(-1);
    const g = room.game;
    const lo = Math.min(g.gate[0].rank, g.gate[1].rank);
    const hi = Math.max(g.gate[0].rank, g.gate[1].rank);
    const want = {
      'miss-left': (r) => r < lo,
      'miss-right': (r) => r > hi,
      'collision-low': (r) => r === lo,
      'collision-high': (r) => r === hi,
      hit: (r) => r > lo && r < hi,
    }[kind];
    const idx = g.deck.findIndex((c) => want(c.rank));
    if (idx < 0) { await ctx.close(); continue; } // not possible with this gate
    [g.deck[0], g.deck[idx]] = [g.deck[idx], g.deck[0]];
    // bet through the real UI (1,000 chip +), then shoot
    await page.waitForSelector('.stepper .step:not([disabled])');
    await page.evaluate(() => document.querySelectorAll('.stepper')[3].querySelectorAll('button')[1].click());
    await clickText(page, '確認下注');
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => b.textContent.includes('射龍門')));
    await clickText(page, '射龍門', false);
    let worst = { overflow: 0, offenders: [], sw: 0, vw: 0 };
    for (let i = 0; i < 70; i++) {
      await sleep(120);
      const m = await page.evaluate(measure);
      if (m.overflow > worst.overflow) worst = m;
      if (shotDir && i === 14) await shot(page, kind);
    }
    record(d.name, `anim:${kind}`, worst.overflow > 0 ? worst : { ...(await page.evaluate(measure)) });
    await ctx.close();
  }

  // ---- result screen ----
  {
    const { ctx, page } = await newPage();
    await enterGame(page, { bots: 5, nickname: LONG_NAME });
    await clickText(page, '開始遊戲');
    await page.waitForSelector('.stage .pillar .card');
    const room = [...srv.hub.manager.rooms.values()].at(-1);
    let n = 0;
    while (room.status === 'PLAYING' && n++ < 200000) srv.hub.manager.autoTurn(room);
    await page.reload({ waitUntil: 'networkidle0' });
    await page.waitForSelector('table');
    record(d.name, 'result', await page.evaluate(measure));
    await shot(page, 'result');
    await ctx.close();
  }
}

await browser.close();
await srv.close();

let failures = 0;
for (const r of results) {
  const bad = r.overflow > 0;
  if (bad) failures++;
  console.log(`${bad ? 'FAIL' : ' ok '} ${r.device.padEnd(14)} ${r.label.padEnd(18)} scrollWidth=${r.sw} viewport=${r.vw}${bad ? `  OVERFLOW +${r.overflow}px` : ''}`);
  if (bad) for (const o of r.offenders) console.log(`       -> ${o.el} left=${o.left} right=${o.right} "${o.text}"`);
}
console.log(failures ? `\n${failures} check(s) scroll sideways` : '\nno horizontal overflow in any screen or animation');
process.exit(failures ? 1 : 0);
