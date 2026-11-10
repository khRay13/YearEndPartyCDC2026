// Builds src/draw/refs/<id>.json for every reference picture: the picture as a small pixel grid (what the server
// compares drawings against), its palette (the SVG's own fill colours) and its canvas size. Needs Chrome/Edge.
// Add a picture: put <id>.svg in public/draw/, add it to PICTURES below, run this again (npm run drawref).
import puppeteer from 'puppeteer-core';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';

const PICTURES = [
  { id: 'mona', title: '蒙娜麗莎' },
  { id: 'pearl', title: '戴珍珠耳環的少女' },
  { id: 'sunflowers', title: '向日葵' },
  { id: 'station', title: '車站' },
  { id: 'guava', title: '芭樂' },
  { id: 'pineapple', title: '鳳梨' },
];
const CANVAS_W = 366; // every canvas is this wide in "canvas units"; the height follows the picture
const CELL = 6; // the judge's grid: one cell is about 6 x 6 units
const SS = 4; // 4x4 samples per cell: an honest area average

const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find((p) => existsSync(p));
if (!CHROME) throw new Error('no Chrome/Edge found');
const lum = (hex) => { const n = parseInt(hex.slice(1), 16); return 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255); };

mkdirSync(new URL('../src/draw/refs/', import.meta.url), { recursive: true });
rmSync(new URL('../src/draw/mona-ref.json', import.meta.url), { force: true }); // (the old single-picture file)
const b = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
const p = await b.newPage();
for (const { id, title } of PICTURES) {
  const svg = readFileSync(new URL(`../public/draw/${id}.svg`, import.meta.url), 'utf8');
  const vb = /viewBox="([\d.\s-]+)"/.exec(svg)?.[1].trim().split(/\s+/).map(Number);
  if (!vb || vb.length !== 4) throw new Error(id + ': the SVG needs a viewBox');
  const H = Math.round((CANVAS_W * vb[3]) / vb[2]);
  const GW = Math.round(CANVAS_W / CELL);
  const GH = Math.max(1, Math.round(H / CELL));
  const out = await p.evaluate(async (svg, GW, GH, SS) => {
    const img = new Image();
    img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)));
    await img.decode();
    const c = document.createElement('canvas');
    c.width = GW * SS; c.height = GH * SS;
    const g = c.getContext('2d');
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, c.width, c.height); // the paper
    g.drawImage(img, 0, 0, c.width, c.height);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    const px = new Uint8Array(GW * GH * 3);
    for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) {
      const sum = [0, 0, 0];
      for (let j = 0; j < SS; j++) for (let i = 0; i < SS; i++) { const k = ((y * SS + j) * c.width + (x * SS + i)) * 4; sum[0] += d[k]; sum[1] += d[k + 1]; sum[2] += d[k + 2]; }
      for (let ch = 0; ch < 3; ch++) px[(y * GW + x) * 3 + ch] = Math.round(sum[ch] / (SS * SS));
    }
    let bin = ''; for (const v of px) bin += String.fromCharCode(v);
    return btoa(bin);
  }, svg, GW, GH, SS);
  const palette = [...new Set([...svg.matchAll(/fill="(#[0-9A-Fa-f]{6})"/g)].map((m) => m[1].toUpperCase()))].sort((a, c) => lum(c) - lum(a)); // light to dark
  writeFileSync(new URL(`../src/draw/refs/${id}.json`, import.meta.url), JSON.stringify({ id, title, file: `/draw/${id}.svg`, w: CANVAS_W, h: H, gridW: GW, gridH: GH, palette, pixels: out }));
  console.log(`${id}: canvas ${CANVAS_W}x${H}, grid ${GW}x${GH}, ${palette.length} colours ${palette.join(' ')}`);
}
await b.close();
