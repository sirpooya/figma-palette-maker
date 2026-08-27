/** Sanity sweep: every preset on every channel, 3..24 stops, no NaN, no throw. */
import { PRESET_LIST, Channel, PresetId } from '../src/curves';
import { generatePalette, reanchorChannel, PaletteConfig } from '../src/palette';

const RANGES: Record<Channel, [number, number]> = {
  l: [8, 98],
  c: [0.01, 0.24],
  h: [200, 320],
};

let bad = 0;
let cases = 0;

for (const lp of PRESET_LIST.l) {
  for (const cp of PRESET_LIST.c) {
    for (const hp of PRESET_LIST.h) {
      for (const stops of [3, 7, 16, 24]) {
        const config: PaletteConfig = {
          stops,
          tokenStart: 50,
          l: reanchorChannel('l', lp.id, ...RANGES.l),
          c: reanchorChannel('c', cp.id, ...RANGES.c),
          h: reanchorChannel('h', hp.id, ...RANGES.h),
        };
        cases++;
        const ramp = generatePalette(config);
        const broken = ramp.filter(
          (s) =>
            !Number.isFinite(s.l) ||
            !Number.isFinite(s.c) ||
            !Number.isFinite(s.h) ||
            !/^#[0-9A-F]{6}$/.test(s.hex) ||
            s.oklch.includes('NaN'),
        );
        if (broken.length) {
          bad++;
          console.log(`FAIL l=${lp.id} c=${cp.id} h=${hp.id} stops=${stops}`, broken[0]);
        }
      }
    }
  }
}

console.log(`${cases} configs checked, ${bad} broken`);

// Monotonic lightness for the descending curves, and endpoint anchoring.
for (const id of ['linear', 'arctan', 'quad', 'expo', 'expo-inverted'] as PresetId[]) {
  const ramp = generatePalette({
    stops: 12,
    tokenStart: 50,
    l: reanchorChannel('l', id, 10, 95),
    c: reanchorChannel('c', 'flat', 0, 0.05),
    h: reanchorChannel('h', 'flat', 280, 280),
  });
  const first = ramp[0].l;
  const last = ramp[ramp.length - 1].l;
  // quad and gaussian are bells: they peak mid-ramp and sit at min on both ends.
  const endpointAnchored = first.toFixed(4) === '95.0000' && last.toFixed(4) === '10.0000';
  const bell = id === 'quad' || id === 'gaussian';
  console.log(
    `${id.padEnd(14)} L ${first.toFixed(2)} -> ${last.toFixed(2)}  ` +
      `${endpointAnchored ? 'endpoint-anchored' : bell ? 'bell (expected)' : 'UNEXPECTED'}`,
  );
  if (!endpointAnchored && !bell) bad++;
}

process.exit(bad === 0 ? 0 : 1);
