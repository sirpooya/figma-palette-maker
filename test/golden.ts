/**
 * Golden test: the 16 oklch strings below were scraped from the server-rendered
 * markup of https://sds.sallee.design/palette-maker at its default settings.
 * If this passes, the port reproduces the original tool exactly.
 *
 * Run: bun test/golden.ts
 */

import { defaultConfig, generatePalette, tokenNames } from '../src/palette';

const EXPECTED_OKLCH = [
  'oklch(100.00% 0.000 286.4)',
  'oklch(97.84% 0.01 286.2)',
  'oklch(95.95% 0.02 286.0)',
  'oklch(93.32% 0.03 287.6)',
  'oklch(89.89% 0.05 287.7)',
  'oklch(85.64% 0.07 287.3)',
  'oklch(79.95% 0.11 287.3)',
  'oklch(72.01% 0.15 287.4)',
  'oklch(62.62% 0.20 286.4)',
  'oklch(50.21% 0.20 286.2)',
  'oklch(37.07% 0.20 286.2)',
  'oklch(26.83% 0.16 284.6)',
  'oklch(17.58% 0.10 283.6)',
  'oklch(10.69% 0.06 284.4)',
  'oklch(4.82% 0.03 264.1)',
  'oklch(0% 0.000 286.4)',
];

const EXPECTED_TOKENS = [
  50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1100, 1200, 1300, 1400, 1500,
];

let failures = 0;

function check(label: string, actual: unknown, expected: unknown) {
  const ok = String(actual) === String(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'pass' : 'FAIL'}  ${label.padEnd(22)} ${actual}${ok ? '' : `   expected ${expected}`}`);
}

const stops = generatePalette(defaultConfig());

check('stop count', stops.length, EXPECTED_OKLCH.length);

stops.forEach((stop, i) => {
  check(`token[${i}]`, stop.token, EXPECTED_TOKENS[i]);
  check(`oklch[${i}]`, stop.oklch, EXPECTED_OKLCH[i]);
});

// Token numbering shapes
check('tokenNames(1, 4)', tokenNames(1, 4).join(','), '1,2,3,4');
check('tokenNames(50, 4)', tokenNames(50, 4).join(','), '50,100,200,300');
check('tokenNames(200, 3)', tokenNames(200, 3).join(','), '200,300,400');
check('tokenNames(7, 3)', tokenNames(7, 3).join(','), '7,8,9');

console.log('\nhex ramp:', stops.map((s) => s.hex).join(' '));
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
