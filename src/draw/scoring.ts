// Drawing game: the pictures, the paper, the palette, and the judge.
// The judge never sees a picture sent by a player. It receives their strokes (the same strokes that are shown to the
// spectators), repaints them on its own small grid, and compares that grid with the reference picture.
import { readFileSync } from 'node:fs';

interface RefFile {
  id: string;
  title: string;
  file: string;
  w: number;
  h: number;
  gridW: number;
  gridH: number;
  palette: string[];
  pixels: string; // base64, gridW * gridH * 3 bytes, RGB
}

export const PAPER = '#FFFFFF';
/** Brush diameters in canvas units (the canvas is 366 units wide whatever the picture). */
export const BRUSH_SIZES = [6, 12, 24] as const;
export const MAX_STROKES = 800;
export const MAX_POINTS = 300; // per stroke, x and y counted as two numbers: 600 numbers

/**
 * A line (c, w, pts) or a bucket fill (c, runs): runs is [y, x0, x1, y, x0, x1, ...] in FILL_UNIT squares, each triple one
 * row of the filled area from x0 up to (not including) x1. A fill has no brush (w = 0) and no points.
 */
export interface Stroke {
  c: number;
  w: number;
  pts: number[];
  runs?: number[];
}

/** The bucket works in squares this many canvas units wide: the players' screens and the judge agree on them. */
export const FILL_UNIT = 2;
export const MAX_FILL_RUNS = 1500; // rows-of-colour per fill

/** One picture to copy, with everything the judge needs about it. */
export interface Reference {
  id: string;
  title: string;
  /** The SVG shown to the players. */
  file: string;
  /** Canvas size in canvas units: strokes use these coordinates. Every canvas is 366 wide; the height follows the picture. */
  w: number;
  h: number;
  /** The picture's own colours (light to dark), then the paper (the last one), which doubles as the eraser. */
  palette: string[];
  gridW: number;
  gridH: number;
  /** One judge cell, in canvas units. */
  cellX: number;
  cellY: number;
  rgb: (readonly [number, number, number])[];
  /** The picture as the judge sees it: gridW * gridH * 3 numbers, and the same blurred. */
  grid: Float32Array;
  blurred: Float32Array;
  /** What an untouched bit of paper counts as: the picture's average colour (so it is neither right nor wrong). */
  neutral: readonly number[];
}

/** The picture list: add a picture with scripts/make-draw-ref.mjs, then list its id here. */
const IDS = ['mona', 'pearl', 'sunflowers', 'station', 'guava', 'pineapple'];

/**
 * Box blur (a 7x7 window): a stroke that lands a little beside the right place still counts for most of what it
 * would have, and a fat sloppy brush is judged by where its colour sits, not by its exact edge.
 */
const BLUR_RADIUS = 3;
function blur(src: Float32Array, gw: number, gh: number): Float32Array {
  const out = new Float32Array(src.length);
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      for (let k = 0; k < 3; k++) {
        let sum = 0;
        let n = 0;
        for (let j = -BLUR_RADIUS; j <= BLUR_RADIUS; j++) {
          for (let i = -BLUR_RADIUS; i <= BLUR_RADIUS; i++) {
            const xx = x + i;
            const yy = y + j;
            if (xx < 0 || yy < 0 || xx >= gw || yy >= gh) continue;
            sum += src[(yy * gw + xx) * 3 + k]!;
            n++;
          }
        }
        out[(y * gw + x) * 3 + k] = sum / n;
      }
    }
  }
  return out;
}

function load(id: string): Reference {
  const f: RefFile = JSON.parse(readFileSync(new URL(`./refs/${id}.json`, import.meta.url), 'utf8'));
  const palette = [...f.palette, PAPER];
  const grid = Float32Array.from(Buffer.from(f.pixels, 'base64'));
  const mean = [0, 0, 0];
  for (let i = 0; i < grid.length; i++) mean[i % 3]! += grid[i]!;
  for (let k = 0; k < 3; k++) mean[k]! /= f.gridW * f.gridH;
  return {
    id: f.id, title: f.title, file: f.file, w: f.w, h: f.h, palette, gridW: f.gridW, gridH: f.gridH,
    cellX: f.w / f.gridW, cellY: f.h / f.gridH,
    rgb: palette.map((hex) => {
      const n = parseInt(hex.slice(1), 16);
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255] as const;
    }),
    grid, blurred: blur(grid, f.gridW, f.gridH), neutral: mean,
  };
}

export const REFERENCES: Reference[] = IDS.map(load);
const byId = new Map(REFERENCES.map((r) => [r.id, r]));
export function getReference(id: string): Reference {
  const r = byId.get(id);
  if (!r) throw new Error('unknown reference ' + id);
  return r;
}

/** Check one stroke from a client; returns a clean copy, or null when it is not a legal stroke for this picture. */
export function cleanStroke(raw: unknown, ref: Reference): Stroke | null {
  if (!raw || typeof raw !== 'object') return null;
  const { c, w, pts, runs } = raw as Record<string, unknown>;
  if (typeof c !== 'number' || !Number.isInteger(c) || c < 0 || c >= ref.palette.length) return null;
  if (runs !== undefined) {
    // a bucket fill: every row must lie inside the canvas
    if (!Array.isArray(runs) || runs.length < 3 || runs.length > MAX_FILL_RUNS * 3 || runs.length % 3) return null;
    const rows = Math.ceil(ref.h / FILL_UNIT);
    const cols = Math.ceil(ref.w / FILL_UNIT);
    for (let i = 0; i < runs.length; i += 3) {
      const y = runs[i];
      const x0 = runs[i + 1];
      const x1 = runs[i + 2];
      if (!Number.isInteger(y) || !Number.isInteger(x0) || !Number.isInteger(x1) || y < 0 || y >= rows || x0 < 0 || x1 <= x0 || x1 > cols) return null;
    }
    return { c, w: 0, pts: [], runs: runs as number[] };
  }
  if (typeof w !== 'number' || !(BRUSH_SIZES as readonly number[]).includes(w)) return null;
  if (!Array.isArray(pts) || pts.length < 2 || pts.length > MAX_POINTS * 2 || pts.length % 2) return null;
  const out: number[] = [];
  for (let i = 0; i < pts.length; i += 2) {
    const x = pts[i];
    const y = pts[i + 1];
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return null;
    out.push(Math.round(Math.min(ref.w, Math.max(0, x)) * 10) / 10, Math.round(Math.min(ref.h, Math.max(0, y)) * 10) / 10);
  }
  return { c, w, pts: out };
}

/**
 * Paint strokes, in order, on a grid. Round brush: a cell is covered by how much the brush reaches into it.
 * Paper that was never touched counts as the picture's average colour: leaving a gap earns nothing but costs nothing,
 * while painting the wrong colour costs. (Painting with the white paper colour is a real colour, e.g. to erase.)
 */
export function rasterize(ref: Reference, strokes: Stroke[]): Float32Array {
  return paint(ref, strokes).grid;
}

function paint(ref: Reference, strokes: Stroke[]): { grid: Float32Array; painted: number } {
  const GW = ref.gridW;
  const GH = ref.gridH;
  const col3 = new Float32Array(GW * GH * 3); // colour x alpha (premultiplied)
  const alpha = new Float32Array(GW * GH);
  const paint = (x0: number, y0: number, x1: number, y1: number, r: number, col: readonly number[]) => {
    const minX = Math.max(0, Math.floor(Math.min(x0, x1) - r - 1));
    const maxX = Math.min(GW - 1, Math.ceil(Math.max(x0, x1) + r + 1));
    const minY = Math.max(0, Math.floor(Math.min(y0, y1) - r - 1));
    const maxY = Math.min(GH - 1, Math.ceil(Math.max(y0, y1) + r + 1));
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len2 = dx * dx + dy * dy;
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5;
        const py = y + 0.5;
        const t = len2 ? Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / len2)) : 0;
        const d = Math.hypot(px - (x0 + t * dx), py - (y0 + t * dy));
        const cover = Math.max(0, Math.min(1, r + 0.5 - d));
        if (!cover) continue;
        const c = y * GW + x;
        for (let k = 0; k < 3; k++) col3[c * 3 + k] = col[k]! * cover + col3[c * 3 + k]! * (1 - cover);
        alpha[c] = cover + alpha[c]! * (1 - cover);
      }
    }
  };
  for (const s of strokes) {
    const col = ref.rgb[s.c]!;
    if (s.runs) {
      // a fill: add up how much of each cell its rows cover, then paint once (two half-covered rows next to each other fill the cell)
      const cov = new Map<number, number>();
      for (let i = 0; i < s.runs.length; i += 3) {
        const ry0 = (s.runs[i]! * FILL_UNIT) / ref.cellY;
        const ry1 = ((s.runs[i]! + 1) * FILL_UNIT) / ref.cellY;
        const rx0 = (s.runs[i + 1]! * FILL_UNIT) / ref.cellX;
        const rx1 = (s.runs[i + 2]! * FILL_UNIT) / ref.cellX;
        for (let y = Math.max(0, Math.floor(ry0)); y <= Math.min(GH - 1, Math.floor(ry1 - 1e-9)); y++) {
          const oy = Math.min(y + 1, ry1) - Math.max(y, ry0);
          for (let x = Math.max(0, Math.floor(rx0)); x <= Math.min(GW - 1, Math.floor(rx1 - 1e-9)); x++) {
            const ox = Math.min(x + 1, rx1) - Math.max(x, rx0);
            if (ox > 0 && oy > 0) cov.set(y * GW + x, (cov.get(y * GW + x) ?? 0) + ox * oy);
          }
        }
      }
      for (const [c, v] of cov) {
        const cover = Math.min(1, v);
        for (let k = 0; k < 3; k++) col3[c * 3 + k] = col[k]! * cover + col3[c * 3 + k]! * (1 - cover);
        alpha[c] = cover + alpha[c]! * (1 - cover);
      }
      continue;
    }
    const r = s.w / 2 / ref.cellX;
    const p = s.pts;
    const gx = (i: number) => p[i]! / ref.cellX;
    const gy = (i: number) => p[i + 1]! / ref.cellY;
    if (p.length === 2) paint(gx(0), gy(0), gx(0), gy(0), r, col);
    for (let i = 2; i < p.length; i += 2) paint(gx(i - 2), gy(i - 2), gx(i), gy(i), r, col);
  }
  const g = new Float32Array(GW * GH * 3);
  let covered = 0;
  for (let c = 0; c < GW * GH; c++) {
    for (let k = 0; k < 3; k++) g[c * 3 + k] = col3[c * 3 + k]! + ref.neutral[k]! * (1 - alpha[c]!);
    if (alpha[c]! > 0.5) covered++;
  }
  return { grid: g, painted: covered / (GW * GH) };
}

/** A picture needs to be painted over at least this share of the sheet to count in full; less is marked down in proportion. */
const FULL_CREDIT_AT = 0.6;

/** Pearson correlation of two blurred pictures (all three colour channels together): do the light and dark, the hues, sit in the same places? */
function correlation(a: Float32Array, b: Float32Array, cells: number): number {
  const ma = [0, 0, 0];
  const mb = [0, 0, 0];
  for (let i = 0; i < a.length; i++) {
    ma[i % 3]! += a[i]!;
    mb[i % 3]! += b[i]!;
  }
  for (let k = 0; k < 3; k++) {
    ma[k]! /= cells;
    mb[k]! /= cells;
  }
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < a.length; i++) {
    const da = a[i]! - ma[i % 3]!;
    const db = b[i]! - mb[i % 3]!;
    sab += da * db;
    saa += da * da;
    sbb += db * db;
  }
  return saa > 1e-6 && sbb > 1e-6 ? sab / Math.sqrt(saa * sbb) : 0;
}

/**
 * How alike this drawing and the picture are, 0 to 100. It is the correlation of the two blurred pictures: a flat sheet,
 * a blank sheet, a scribble and a picture in the wrong colours all come out near 0; a faithful copy near 100; a sloppy but
 * recognisable one in between (a fat brush that is roughly in the right places earns well over half). A drawing that
 * leaves most of the sheet bare is marked down in proportion (see FULL_CREDIT_AT).
 */
export function similarity(ref: Reference, strokes: Stroke[]): number {
  const { grid, painted } = paint(ref, strokes);
  const r = correlation(blur(grid, ref.gridW, ref.gridH), ref.blurred, ref.gridW * ref.gridH);
  // r ^ 0.8: a gentle curve, so a picture that is clearly the right one but not exact is not marked down too hard.
  // And a frame of dark paint round the edge of a picture with a dark background must not count for much: a drawing
  // that covers less than FULL_CREDIT_AT of the sheet is marked down in proportion to how much it leaves bare.
  const completeness = Math.min(1, painted / FULL_CREDIT_AT);
  return Math.round(Math.pow(Math.max(0, Math.min(1, r)), 0.8) * completeness * 1000) / 10;
}
