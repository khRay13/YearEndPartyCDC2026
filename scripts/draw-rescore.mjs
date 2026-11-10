// Replays the finished games kept in data/draw-results/ through the current judge and prints the scores next to the
// ones that were shown at the time. Use it to calibrate the judge with real games:   node scripts/draw-rescore.mjs [folder]
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getReference, similarity } from '../src/draw/scoring.ts';

const dir = process.argv[2] ?? new URL('../data/draw-results/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
if (!existsSync(dir)) { console.log('no games kept yet in ' + dir + ' (play on a server started with `npm start`)'); process.exit(0); }
const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
console.log('file'.padEnd(34), 'picture'.padEnd(11), 'player'.padEnd(10), 'shown'.padStart(6), 'judge now'.padStart(10), ' strokes');
for (const f of files) {
  const g = JSON.parse(readFileSync(join(dir, f), 'utf8'));
  const ref = getReference(g.picture);
  for (const i of [0, 1]) console.log(f.slice(0, 33).padEnd(34), g.picture.padEnd(11), String(g.slotNames[i]).slice(0, 9).padEnd(10), String(g.scores[i]).padStart(6), String(similarity(ref, g.strokes[i])).padStart(10), ' ', g.strokes[i].length);
}
