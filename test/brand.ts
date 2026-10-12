/**
 * Brand theme test: the DDS is the oracle. test/fixtures/dds-themes.json holds every DDS
 * core color and brand theme; this checks the step numbers against the DDS color names,
 * the recipe against every brand's hand-picked slots, the on-colors against all 40 bases,
 * and that recipes/dds.json is still what a fresh fit of the fixture produces.
 *
 * Run: bun test/brand.ts
 */

import {
  BRAND_SLOTS,
  THEME_NAME_VARIABLE,
  brandThemeToJson,
  deltaE,
  generateBrandTheme,
  parseHex,
  parseRecipe,
  recipeToJson,
  spectrum,
  stepOf,
} from '../src/brand';
import { rgbToHex } from '../src/oklch';
import { colorOf, collectSamples, fitRecipe, loadFixture, opaque } from '../scripts/fit-recipe';

let failures = 0;

function check(label: string, actual: unknown, expected: unknown) {
  const ok = String(actual) === String(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'pass' : 'FAIL'}  ${label.padEnd(44)} ${actual}${ok ? '' : `   expected ${expected}`}`);
}

function atMost(label: string, actual: number, limit: number) {
  const ok = actual <= limit;
  if (!ok) failures++;
  console.log(`${ok ? 'pass' : 'FAIL'}  ${label.padEnd(44)} ${actual.toFixed(2)}${ok ? '' : `   limit ${limit}`}`);
}

const fixture = await loadFixture();
// The engine has no built-in recipe; the DDS one is a file like any other.
const ddsFile = await Bun.file(new URL('../recipes/dds.json', import.meta.url)).text();
const DDS = parseRecipe(ddsFile);
const hexOf = (ref: string) => rgbToHex(colorOf(fixture, ref));

/* -------------------------------------------------------------------------- */
/* Step numbers                                                                */
/* -------------------------------------------------------------------------- */

// Plain neutrals are named by the formula exactly: neutral-48 is #848484.
const neutrals = Object.entries(fixture.colors).filter(([ref]) => /^neutral\.\d{2}$/.test(ref));
const neutralMisses = neutrals.filter(([ref, v]) => stepOf(opaque(v)) !== Number(ref.slice(-2)));
check('neutral names match the step formula', `${neutrals.length - neutralMisses.length}/${neutrals.length}`, `${neutrals.length}/${neutrals.length}`);

// Colored names: within 1 for the large majority. The misses were edited after naming.
const named = Object.entries(fixture.colors).filter(
  ([ref, v]) => !ref.startsWith('neutral.') && v.startsWith('#') && /-\d{2}(❌)?$/.test(ref.replace('❌', '')),
);
const close = named.filter(([ref, v]) => {
  const n = Number(ref.replace('❌', '').match(/-(\d{2})$/)?.[1]);
  return Math.abs(stepOf(opaque(v)) - n) <= 1;
});
atMost('colored names off by more than 1 step (share)', 1 - close.length / named.length, 0.2);

/* -------------------------------------------------------------------------- */
/* The recipe against the DDS brands                                           */
/* -------------------------------------------------------------------------- */

// Mean OKLab dE x100 per slot, over every slot that is not collapsed onto another.
// The limits sit just above today's fit, so they catch regressions, not noise.
const LIMITS: Record<string, number> = {
  'primary/tint-1': 1.5,
  'primary/tint-2': 2.5,
  'primary/tint-3': 6.5,
  'primary/shade-2': 5,
  'primary/shade-1': 7,
  'secondary/tint-1': 2.5,
  'secondary/tint-2': 8.5,
  'secondary/shade-1': 11.5,
};

const samples = collectSamples(fixture);
for (const [key, set] of samples) {
  const [group, part] = key.split('/');
  let sum = 0;
  for (const s of set) {
    const theme = generateBrandTheme({ name: s.brand, primary: rgbToHex(s.base), secondary: rgbToHex(s.base) }, DDS);
    const slot = theme.slots.find((x) => x.group === group && x.part === part);
    sum += deltaE(parseHex(slot!.hex)!, s.target);
  }
  atMost(`${key} mean dE over ${set.length} brands`, sum / set.length, LIMITS[key] ?? 0);
}

// Every DDS base gets the on-color the DDS gave it.
let onTotal = 0;
let onMatches = 0;
for (const theme of Object.values(fixture.themes)) {
  for (const group of ['primary', 'secondary'] as const) {
    const baseRef = theme[group]?.[`${group}-base`];
    const onRef = theme[group]?.[`on-${group}`];
    if (!baseRef || !onRef) continue;
    const generated = generateBrandTheme({ name: 'x', primary: hexOf(baseRef), secondary: hexOf(baseRef) }, DDS);
    const on = generated.slots.find((s) => s.key === `on-${group}`)!.hex;
    onTotal++;
    if (on === hexOf(onRef)) onMatches++;
  }
}
check('on-colors match the DDS', `${onMatches}/${onTotal}`, `${onTotal}/${onTotal}`);

// The DDS recipe is a fit, not a guess: refitting the fixture must give the same recipe.
const refit = fitRecipe(fixture);
check('recipes/dds.json equals a fresh fit', JSON.stringify(DDS), JSON.stringify(refit.recipe));
// The default recipe is a file, not code, and recipe files round-trip.
check('recipe files round-trip', JSON.stringify(parseRecipe(recipeToJson(DDS))), JSON.stringify(DDS));
check('fit script output is the file', recipeToJson(refit.recipe, {
  name: 'DDS fit',
  description: JSON.parse(ddsFile).description,
}), ddsFile);

// Imports are strict: a broken file says what is wrong instead of half-applying.
const good = JSON.parse(recipeToJson(DDS));
const refusal = (data: unknown) => {
  try {
    parseRecipe(typeof data === 'string' ? data : JSON.stringify(data));
    return '';
  } catch (error) {
    return (error as Error).message;
  }
};
check('broken JSON is refused', refusal('{'), 'The recipe file is not valid JSON');
check(
  'a missing slot is named',
  refusal({ ...good, primary: { ...good.primary, 'tint-3': undefined } }),
  'primary tint-3 is missing',
);
check(
  'a shade cannot mix white',
  refusal({ ...good, primary: { ...good.primary, 'shade-1': { white: 40 } } }),
  'primary shade-1 takes "step" or "black", not "white"',
);
check(
  'out of range is refused',
  refusal({ ...good, secondary: { ...good.secondary, 'tint-1': { step: 140 } } }),
  'secondary tint-1 step must be a number from 0 to 100',
);
check('other formats are refused', refusal({ ...good, format: 'tokens' }), 'Not a Manshur Theme Builder recipe (format "tokens")');
check('hand-written files may skip the header', refusal({ ...good, format: undefined, version: undefined }), '');
check('onDark must be a color', refusal({ ...good, onDark: 'dark' }), 'onDark must be a hex color like "#0A0A0A"');
check('tertiaryDefault is optional', refusal({ ...good, tertiaryDefault: undefined }), '');

// Without a tertiaryDefault, the tertiary color is required rather than invented.
const noFixedTertiary = { ...DDS, tertiaryDefault: null };
const missingTertiary = (() => {
  try {
    generateBrandTheme({ name: 'x', primary: '#ed1944', secondary: '#1672dd' }, noFixedTertiary);
    return '';
  } catch (error) {
    return (error as Error).message;
  }
})();
check('no fixed tertiary asks for one', missingTertiary, 'Pick a tertiary color: this recipe has no default tertiary');

check(
  'on threshold sits between the DDS cases',
  DDS.onContrast > refit.onRange.darkMax && DDS.onContrast <= refit.onRange.whiteMin,
  true,
);

/* -------------------------------------------------------------------------- */
/* Shape of a generated theme                                                  */
/* -------------------------------------------------------------------------- */

const shop = generateBrandTheme({ name: 'Shop', primary: '#ed1944', secondary: '#1672dd' }, DDS);

// The exact DDS 🌈 Theme variables, in the DDS order.
const DDS_NAMES = [
  'primary/primary-tint-1', 'primary/primary-tint-2', 'primary/primary-tint-3',
  'primary/primary-gradient', 'primary/primary-base', 'primary/primary-shade-2',
  'primary/primary-shade-1', 'primary/primary-base-alpha-12', 'primary/on-primary',
  'secondary/secondary-tint-1', 'secondary/secondary-tint-2', 'secondary/secondary-base',
  'secondary/secondary-base-alpha-12', 'secondary/secondary-shade-1', 'secondary/on-secondary',
  'tertiary/tertiary-tint-1', 'tertiary/tertiary-tint-2', 'tertiary/tertiary-base',
  'tertiary/tertiary-shade-1', 'tertiary/on-tertiary',
];
check('slot names match the DDS theme', shop.slots.map((s) => s.name).join(','), DDS_NAMES.join(','));
check('slot table matches the generator', BRAND_SLOTS.length, shop.slots.length);
check('root variable is "theme"', THEME_NAME_VARIABLE, 'theme');
check('every value is opaque hex', shop.slots.every((s) => /^#[0-9A-F]{6}$/.test(s.hex)), true);
check(
  'alpha slots carry 12% opacity',
  shop.slots.filter((s) => s.part === 'alpha').map((s) => s.rgb.a).join(','),
  '0.12,0.12',
);
check('base passes through untouched', shop.slots.find((s) => s.key === 'primary-base')?.hex, '#ED1944');
check('gradient defaults to the base', shop.slots.find((s) => s.key === 'primary-gradient')?.hex, '#ED1944');
check(
  'gradient override is used',
  generateBrandTheme({ name: 'x', primary: '#ed1944', secondary: '#1672dd', gradient: '#e40138' }, DDS).slots.find(
    (s) => s.key === 'primary-gradient',
  )?.hex,
  '#E40138',
);
check('names its step like the DDS', shop.slots.find((s) => s.key === 'primary-base')?.step, 63);

// Default tertiary is the DDS neutral set, and that set is what most DDS brands use.
const tertiary = shop.slots.filter((s) => s.group === 'tertiary').map((s) => s.hex);
const fixedTertiary = DDS.tertiaryDefault!;
check(
  'default tertiary is the recipe set',
  tertiary.join(','),
  [fixedTertiary['tint-1'], fixedTertiary['tint-2'], fixedTertiary.base, fixedTertiary['shade-1'], fixedTertiary.on].join(','),
);
check(
  'tertiary #333333 keeps the exact neutrals',
  generateBrandTheme({ name: 'x', primary: '#ed1944', secondary: '#1672dd', tertiary: '#333333' }, DDS)
    .slots.filter((s) => s.group === 'tertiary')
    .map((s) => s.hex)
    .join(','),
  tertiary.join(','),
);
const most = (key: string) => {
  const counts = new Map<string, number>();
  for (const t of Object.values(fixture.themes)) {
    const ref = t.tertiary?.[key];
    if (ref) counts.set(ref, (counts.get(ref) ?? 0) + 1);
  }
  return hexOf([...counts.entries()].sort((a, b) => b[1] - a[1])[0][0]);
};
check(
  'neutral set matches the DDS majority',
  ['tertiary-tint-1', 'tertiary-tint-2', 'tertiary-base', 'tertiary-shade-1', 'on-tertiary'].map(most).join(','),
  tertiary.join(','),
);

// A custom tertiary runs through the neutral steps instead: 7, 48, base, 96. A base
// lighter than step 48 (this teal is 45) keeps tint-2 on the base, as the DDS collapses.
const tertiarySteps = (hex: string) =>
  generateBrandTheme({ name: 'x', primary: '#ed1944', secondary: '#1672dd', tertiary: hex }, DDS)
    .slots.filter((s) => s.group === 'tertiary' && s.part !== 'on')
    .map((s) => s.step)
    .join(',');
check('custom tertiary follows the neutral steps', tertiarySteps('#1a4342'), '7,48,79,96');
check('light custom tertiary collapses tint-2', tertiarySteps('#2bb5b2'), '7,45,45,96');

// Light to dark, every time: tints never pass each other or the base, shades likewise.
let disorders = 0;
for (let h = 0; h < 360; h += 15) {
  for (const l of [0.35, 0.5, 0.65, 0.8, 0.92]) {
    const hex = rgbToHex({
      r: Math.min(1, Math.max(0, l + 0.35 * Math.cos((h * Math.PI) / 180))),
      g: Math.min(1, Math.max(0, l + 0.35 * Math.cos(((h - 120) * Math.PI) / 180))),
      b: Math.min(1, Math.max(0, l + 0.35 * Math.cos(((h + 120) * Math.PI) / 180))),
    });
    const t = generateBrandTheme({ name: 'x', primary: hex, secondary: hex }, DDS);
    const steps = (group: string, keys: string[]) =>
      keys.map((k) => t.slots.find((s) => s.key === `${group}-${k}`)!.step);
    const ordered = (xs: number[]) => xs.every((x, i) => i === 0 || xs[i - 1] <= x);
    if (!ordered(steps('primary', ['tint-1', 'tint-2', 'tint-3', 'base', 'shade-2', 'shade-1']))) disorders++;
    if (!ordered(steps('secondary', ['tint-1', 'tint-2', 'base', 'shade-1']))) disorders++;
  }
}
check('tints and shades stay in order (120 bases)', disorders, 0);

// The spectrum runs white to black through the base, and the slots sit on it.
const path = spectrum('#ed1944');
check('spectrum starts at white', path[0].hex, '#FFFFFF');
check('spectrum ends at black', path[path.length - 1].hex, '#000000');
check('spectrum runs light to dark', path.every((p, i) => i === 0 || path[i - 1].step <= p.step), true);
check('spectrum passes through the base', path.some((p) => p.hex === '#ED1944'), true);

// The JSON export has the DDS tokens shape.
const json = JSON.parse(brandThemeToJson(shop));
check('json keyed by brand slug', Object.keys(json).join(','), 'shop');
check('json carries the theme name', json.shop.theme.$value, 'Shop');
check('json alpha is rgba', json.shop.primary['primary-base-alpha-12'].$value, 'rgba(237,25,68,0.12)');

/* -------------------------------------------------------------------------- */
/* Report                                                                      */
/* -------------------------------------------------------------------------- */

// For eyeballing: the brands that fill every primary slot, DDS step / recipe step.
console.log('\nDDS step / recipe step, primary group:');
for (const name of ['shop', 'plus', 'ai', 'pharmacy', 'service-hub', 'super-coin', 'commercial']) {
  const theme = fixture.themes[name];
  const generated = generateBrandTheme({
    name,
    primary: hexOf(theme.primary['primary-base']),
    secondary: hexOf(theme.secondary['secondary-base']),
  }, DDS);
  const cells = ['tint-1', 'tint-2', 'tint-3', 'base', 'shade-2', 'shade-1'].map((part) => {
    const dds = stepOf(colorOf(fixture, theme.primary[`primary-${part}`]));
    const ours = generated.slots.find((s) => s.key === `primary-${part}`)!.step;
    return `${part} ${String(dds).padStart(2, '0')}/${String(ours).padStart(2, '0')}`;
  });
  console.log(`  ${name.padEnd(12)} ${cells.join('  ')}`);
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
