/**
 * Differential test: our readable port vs the original minified functions,
 * over a wide grid of presets, ranges and positions.
 *
 * Run: bun test/differential.ts
 */

import {
  Channel,
  PresetId,
  PRESET_LIST,
  defaultParams,
  evaluateChannel,
  solveArctan,
  solveExpo,
  solveExpoInverted,
  solveGaussian,
  solveQuad,
  Params,
} from '../src/curves';
// @ts-expect-error - untyped test oracle
import * as ref from './fixtures/original-curves.mjs';

const CHANNELS: Channel[] = ['l', 'c', 'h'];
const RANGES: Record<Channel, Array<[number, number]>> = {
  l: [[0, 100], [15.61, 99.8], [8, 92], [42, 42]],
  c: [[0, 0.2], [0, 0.001], [0.02, 0.34], [0.1, 0.1]],
  h: [[286.4, 286.4], [0, 360], [200, 320], [350, 10]],
};

const EPS = 1e-9;
let compared = 0;
let mismatches = 0;

function report(label: string, mine: unknown, theirs: unknown) {
  compared++;
  const same =
    typeof mine === 'number' && typeof theirs === 'number'
      ? Math.abs(mine - theirs) <= EPS ||
        (Number.isNaN(mine) && Number.isNaN(theirs))
      : JSON.stringify(mine) === JSON.stringify(theirs);
  if (!same) {
    mismatches++;
    if (mismatches <= 10) console.log(`MISMATCH ${label}\n  mine:   ${JSON.stringify(mine)}\n  theirs: ${JSON.stringify(theirs)}`);
  }
}

function sortKeys(o: Record<string, number>) {
  return Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
}

for (const channel of CHANNELS) {
  for (const preset of PRESET_LIST[channel].map((p) => p.id as PresetId)) {
    for (const [min, max] of RANGES[channel]) {
      const mineParams = defaultParams(preset, channel, min, max);
      const theirParams = ref.defaultParams_(preset, channel, min, max);
      report(
        `defaultParams(${preset}, ${channel}, ${min}, ${max})`,
        sortKeys(mineParams),
        sortKeys(theirParams),
      );

      // Same params on both sides, so this isolates evaluate() itself.
      for (let i = 0; i <= 24; i++) {
        const x = i / 24;
        report(
          `evaluate(${channel}/${preset}, min=${min}, max=${max}, x=${x.toFixed(4)})`,
          evaluateChannel(channel, preset, theirParams, min, max, x),
          ref.evaluateChannel_(channel, preset, theirParams, min, max, x),
        );
      }

      // And with hand-tweaked params, to exercise the `?? solved` fallbacks.
      for (const tweak of [{}, { k: 6 }, { k: 6, d: 1.2 }, { a: 3 }, { b: -12 }, { c: 7 }]) {
        const params = { ...theirParams, ...tweak };
        for (const x of [0, 0.13, 0.5, 0.77, 1]) {
          report(
            `evaluate(${channel}/${preset}, tweak=${JSON.stringify(tweak)}, x=${x})`,
            evaluateChannel(channel, preset, params, min, max, x),
            ref.evaluateChannel_(channel, preset, params, min, max, x),
          );
        }
      }
    }
  }
}

// Solver parity
for (const [min, max] of [[0, 100], [15.61, 99.8], [0, 0.2], [200, 320]] as Array<[number, number]>) {
  for (const params of [{ k: 4.5, d: 2.8 }, { k: 8 }, { k: 0.5, d: 0 }, {}] as Params[]) {
    report(`solveArctan(${min},${max})`, sortKeys(solveArctan(min, max, params)), sortKeys(ref.solveArctan_(min, max, params)));
    report(`solveQuad(${min},${max})`, sortKeys(solveQuad(min, max, params)), sortKeys(ref.solveQuad_(min, max, params)));
    report(`solveGaussian(${min},${max})`, sortKeys(solveGaussian(min, max, params)), sortKeys(ref.solveGaussian_(min, max, params)));
    report(`solveExpo(${min},${max})`, sortKeys(solveExpo(min, max, params)), sortKeys(ref.solveExpo_(min, max, params)));
    report(`solveExpoInverted(${min},${max})`, sortKeys(solveExpoInverted(min, max, params)), sortKeys(ref.solveExpoInv_(min, max, params)));
  }
}

console.log(`\n${compared} comparisons, ${mismatches} mismatches`);
process.exit(mismatches === 0 ? 0 : 1);
