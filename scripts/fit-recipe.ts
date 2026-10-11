/**
 * Refit the DDS brand recipe from test/fixtures/dds-themes.json.
 *
 *   bun scripts/fit-recipe.ts           print the comparison and the fitted recipe
 *   bun scripts/fit-recipe.ts --write   also rewrite recipes/dds.json, the DDS recipe to import
 *
 * For every derived slot this compares two models by leave-one-brand-out cross-validation
 * and keeps the one that better predicts a brand it was not fitted on:
 *   step  lighten (tints) or darken (shades) until the color lands on a fixed DDS step
 *   mix   a fixed share of white (tints) or black (shades)
 * Slots that reuse another slot's color are dropped first: a collapsed slot says nothing
 * about the recipe.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  BrandRecipe,
  DerivedPart,
  SlotRule,
  applyRule,
  contrastRatio,
  deltaE,
  parseHex,
  recipeToJson,
  round8,
  stepOf,
} from '../src/brand';
import { Rgb, rgbToHex, rgbToOklch } from '../src/oklch';

export interface DdsFixture {
  source: string;
  commit: string | null;
  colors: Record<string, string>;
  themes: Record<string, Record<string, Record<string, string>>>;
}

export async function loadFixture(): Promise<DdsFixture> {
  const path = resolve(import.meta.dir, '../test/fixtures/dds-themes.json');
  return JSON.parse(await readFile(path, 'utf8')) as DdsFixture;
}

/** A DDS color value (hex or rgba) as opaque sRGB, rgba composited over white. */
export function opaque(value: string): Rgb {
  const hex = parseHex(value);
  if (hex) return hex;
  const m = value.replace(/\s/g, '').match(/^rgba\((\d+),(\d+),(\d+),([\d.]+)\)$/);
  if (!m) throw new Error(`Unreadable DDS color: ${value}`);
  const a = Number(m[4]);
  const over = (c: string) => (Number(c) / 255) * a + (1 - a);
  return { r: over(m[1]), g: over(m[2]), b: over(m[3]) };
}

export function colorOf(fixture: DdsFixture, ref: string): Rgb {
  const value = fixture.colors[ref];
  if (!value) throw new Error(`Missing DDS color ${ref}`);
  return opaque(value);
}

export interface Sample {
  brand: string;
  base: Rgb;
  target: Rgb;
}

export type FitGroup = 'primary' | 'secondary';

export const FIT_SLOTS: Record<FitGroup, DerivedPart[]> = {
  primary: ['tint-1', 'tint-2', 'tint-3', 'shade-2', 'shade-1'],
  secondary: ['tint-1', 'tint-2', 'shade-1'],
};

function isAchromatic(color: Rgb): boolean {
  return Math.max(color.r, color.g, color.b) - Math.min(color.r, color.g, color.b) < 0.02;
}

function hueGap(a: Rgb, b: Rgb): number {
  const ha = rgbToOklch(a).h ?? 0;
  const hb = rgbToOklch(b).h ?? 0;
  return Math.abs((((ha - hb + 180) % 360) + 360) % 360 - 180);
}

/** Every slot that carries recipe information, keyed `primary/tint-1` and so on. */
export function collectSamples(fixture: DdsFixture): Map<string, Sample[]> {
  const out = new Map<string, Sample[]>();
  for (const [brand, theme] of Object.entries(fixture.themes)) {
    for (const group of Object.keys(FIT_SLOTS) as FitGroup[]) {
      const slots = theme[group];
      const baseRef = slots?.[`${group}-base`];
      if (!baseRef) continue;
      const base = colorOf(fixture, baseRef);
      // Gray-based brands (car, void, fashion's neutral primary) are not color ramps.
      if (isAchromatic(base)) continue;

      const refs = FIT_SLOTS[group].map((part) => slots[`${group}-${part}`]);
      const uses = new Map<string, number>();
      for (const ref of refs) if (ref) uses.set(ref, (uses.get(ref) ?? 0) + 1);

      FIT_SLOTS[group].forEach((part, i) => {
        const ref = refs[i];
        if (!ref || ref === baseRef || (uses.get(ref) ?? 0) > 1) return;
        const target = colorOf(fixture, ref);
        // A different color family in the slot (not a tint or shade of the base).
        if (hueGap(base, target) > 30 && stepOf(target) > 10) return;
        const key = `${group}/${part}`;
        out.set(key, [...(out.get(key) ?? []), { brand, base, target }]);
      });
    }
  }
  return out;
}

function toward(part: DerivedPart): 'white' | 'black' {
  return part.startsWith('tint') ? 'white' : 'black';
}

function meanError(samples: Sample[], rule: SlotRule, part: DerivedPart): number {
  let sum = 0;
  for (const s of samples) sum += deltaE(round8(applyRule(s.base, rule, toward(part))), s.target);
  return sum / samples.length;
}

function candidates(kind: SlotRule['kind']): SlotRule[] {
  return kind === 'step'
    ? Array.from({ length: 99 }, (_v, i): SlotRule => ({ kind: 'step', step: i + 1 }))
    : Array.from({ length: 99 }, (_v, i): SlotRule => ({ kind: 'mix', amount: (i + 1) / 100 }));
}

function bestRule(samples: Sample[], kind: SlotRule['kind'], part: DerivedPart) {
  let best = { rule: candidates(kind)[0], error: Infinity };
  for (const rule of candidates(kind)) {
    const error = meanError(samples, rule, part);
    if (error < best.error) best = { rule, error };
  }
  return best;
}

/** Mean error on each held-out brand, fitting on all the others. */
function crossValidate(samples: Sample[], kind: SlotRule['kind'], part: DerivedPart): number {
  const brands = [...new Set(samples.map((s) => s.brand))];
  let sum = 0;
  let n = 0;
  for (const brand of brands) {
    const train = samples.filter((s) => s.brand !== brand);
    const test = samples.filter((s) => s.brand === brand);
    if (train.length < 2) continue;
    const { rule } = bestRule(train, kind, part);
    for (const s of test) {
      sum += deltaE(round8(applyRule(s.base, rule, toward(part))), s.target);
      n++;
    }
  }
  return n ? sum / n : Infinity;
}

export interface FitRow {
  slot: string;
  samples: number;
  step: { rule: SlotRule; error: number; cv: number };
  mix: { rule: SlotRule; error: number; cv: number };
  chosen: SlotRule;
}

/** Cross-validation errors closer than this count as a tie. */
const TIE = 0.05;

/** Most common value of one tertiary slot across the DDS brands. */
function commonTertiary(fixture: DdsFixture, key: string): Rgb {
  const counts = new Map<string, number>();
  for (const theme of Object.values(fixture.themes)) {
    const ref = theme.tertiary?.[key];
    if (ref) counts.set(ref, (counts.get(ref) ?? 0) + 1);
  }
  const [ref] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return colorOf(fixture, ref);
}

export function fitRecipe(fixture: DdsFixture) {
  const samples = collectSamples(fixture);
  const rows: FitRow[] = [];
  const chosen = new Map<string, SlotRule>();

  for (const group of Object.keys(FIT_SLOTS) as FitGroup[]) {
    for (const part of FIT_SLOTS[group]) {
      const key = `${group}/${part}`;
      const set = samples.get(key) ?? [];
      const step = { ...bestRule(set, 'step', part), cv: crossValidate(set, 'step', part) };
      const mix = { ...bestRule(set, 'mix', part), cv: crossValidate(set, 'mix', part) };
      // On a tie, tints keep the step model (a surface should look equally light for
      // every brand) and shades keep the mix model.
      const preferStep = toward(part) === 'white';
      const pick =
        Math.abs(step.cv - mix.cv) < TIE ? (preferStep ? step : mix) : step.cv < mix.cv ? step : mix;
      rows.push({ slot: key, samples: set.length, step, mix, chosen: pick.rule });
      chosen.set(key, pick.rule);
    }
  }

  // On-colors: the darkest base given dark text and the lightest given white text bound
  // the threshold. Take the round number between them.
  let darkMax = 0;
  let whiteMin = Infinity;
  const white: Rgb = { r: 1, g: 1, b: 1 };
  const darkRefs = new Map<string, number>();
  for (const theme of Object.values(fixture.themes)) {
    for (const group of ['primary', 'secondary'] as const) {
      const baseRef = theme[group]?.[`${group}-base`];
      const onRef = theme[group]?.[`on-${group}`];
      if (!baseRef || !onRef) continue;
      const ratio = contrastRatio(white, colorOf(fixture, baseRef));
      if (onRef === 'neutral.white') whiteMin = Math.min(whiteMin, ratio);
      else {
        darkMax = Math.max(darkMax, ratio);
        darkRefs.set(onRef, (darkRefs.get(onRef) ?? 0) + 1);
      }
    }
  }
  const middle = (darkMax + whiteMin) / 2;
  const rounded = Math.round(middle * 2) / 2;
  const onContrast = rounded > darkMax && rounded <= whiteMin ? rounded : Number(middle.toFixed(2));

  // The dark on-color the DDS uses where white does not reach the threshold.
  const [onDarkRef] = [...darkRefs.entries()].sort((a, b) => b[1] - a[1])[0];

  const tertiaryStep = (key: string): SlotRule => ({
    kind: 'step',
    step: stepOf(commonTertiary(fixture, key)),
  });

  const rule = (key: string) => chosen.get(key) as SlotRule;
  const recipe: BrandRecipe = {
    primary: {
      'tint-1': rule('primary/tint-1'),
      'tint-2': rule('primary/tint-2'),
      'tint-3': rule('primary/tint-3'),
      'shade-2': rule('primary/shade-2'),
      'shade-1': rule('primary/shade-1'),
    },
    secondary: {
      'tint-1': rule('secondary/tint-1'),
      'tint-2': rule('secondary/tint-2'),
      'shade-1': rule('secondary/shade-1'),
    },
    tertiary: {
      'tint-1': tertiaryStep('tertiary-tint-1'),
      'tint-2': tertiaryStep('tertiary-tint-2'),
      'shade-1': tertiaryStep('tertiary-shade-1'),
    },
    onContrast,
    onDark: rgbToHex(colorOf(fixture, onDarkRef)),
    alpha: 0.12,
    // The tertiary most DDS brands share, used as is when no tertiary color is picked.
    tertiaryDefault: {
      base: rgbToHex(commonTertiary(fixture, 'tertiary-base')),
      'tint-1': rgbToHex(commonTertiary(fixture, 'tertiary-tint-1')),
      'tint-2': rgbToHex(commonTertiary(fixture, 'tertiary-tint-2')),
      'shade-1': rgbToHex(commonTertiary(fixture, 'tertiary-shade-1')),
      on: rgbToHex(commonTertiary(fixture, 'on-tertiary')),
    },
  };

  return { recipe, rows, onRange: { darkMax, whiteMin } };
}

export function describeRule(rule: SlotRule): string {
  return rule.kind === 'step' ? `step ${rule.step}` : `mix ${Math.round(rule.amount * 100)}%`;
}

/** 1 for a yellow base (OKLCH hue 90), 0 for the opposite hue. */
function warmth(color: Rgb): number {
  const h = rgbToOklch(color).h ?? 90;
  return (1 + Math.cos(((h - 90) * Math.PI) / 180)) / 2;
}

/**
 * Report only: would the amount do better if it depended on the base? Fits
 * `mix = a + k * feature` for the base's luma and its warmth, cross-validated the same way.
 * Not part of fitRecipe, because it is slow and has never won.
 */
export function compareDependentModels(fixture: DdsFixture) {
  const features: Record<string, (c: Rgb) => number> = {
    'mix ~ base lightness': (c) => 0.299 * c.r + 0.587 * c.g + 0.114 * c.b,
    'mix ~ base warmth': warmth,
  };
  const grid: Array<[number, number]> = [];
  for (let a = 0; a <= 1.0001; a += 0.05) for (let k = -1; k <= 1.0001; k += 0.1) grid.push([a, k]);

  const rows: Array<{ slot: string; model: string; cv: number }> = [];
  for (const [key, set] of collectSamples(fixture)) {
    const part = key.split('/')[1] as DerivedPart;
    for (const [model, feature] of Object.entries(features)) {
      const predict = (s: Sample, a: number, k: number) =>
        round8(applyRule(s.base, { kind: 'mix', amount: Math.min(1, Math.max(0, a + k * feature(s.base))) }, toward(part)));
      const fit = (train: Sample[]) => {
        let best: [number, number] = grid[0];
        let bestError = Infinity;
        for (const [a, k] of grid) {
          let sum = 0;
          for (const s of train) sum += deltaE(predict(s, a, k), s.target);
          if (sum < bestError) [bestError, best] = [sum, [a, k]];
        }
        return best;
      };
      let sum = 0;
      let n = 0;
      for (const brand of new Set(set.map((s) => s.brand))) {
        const train = set.filter((s) => s.brand !== brand);
        if (train.length < 2) continue;
        const [a, k] = fit(train);
        for (const s of set.filter((x) => x.brand === brand)) {
          sum += deltaE(predict(s, a, k), s.target);
          n++;
        }
      }
      rows.push({ slot: key, model, cv: n ? sum / n : Infinity });
    }
  }
  return rows;
}

if (import.meta.main) {
  const fixture = await loadFixture();
  const { recipe, rows, onRange } = fitRecipe(fixture);
  console.log(`DDS fixture ${fixture.commit?.slice(0, 7) ?? '(no commit)'}\n`);
  console.log('slot               n   step model (fit / cv dE)      mix model (fit / cv dE)     chosen');
  for (const r of rows) {
    const cell = (m: FitRow['step']) =>
      `${describeRule(m.rule).padEnd(9)} ${m.error.toFixed(1).padStart(4)} / ${m.cv.toFixed(1).padStart(4)}`;
    console.log(
      `${r.slot.padEnd(18)} ${String(r.samples).padStart(2)}   ${cell(r.step).padEnd(28)}  ${cell(r.mix).padEnd(26)}  ${describeRule(r.chosen)}`,
    );
  }
  console.log('\nAmounts that depend on the base, cv dE (lower than the chosen model would win):');
  const dependent = compareDependentModels(fixture);
  for (const r of rows) {
    const chosenCv = r.chosen.kind === 'step' ? r.step.cv : r.mix.cv;
    const cells = dependent
      .filter((d) => d.slot === r.slot)
      .map((d) => `${d.model} ${d.cv.toFixed(1)}${d.cv < chosenCv ? ' WINS' : ''}`);
    console.log(`${r.slot.padEnd(18)} chosen ${chosenCv.toFixed(1)}   ${cells.join('   ')}`);
  }

  console.log(
    `\non-color: dark text up to ${onRange.darkMax.toFixed(2)}:1, white from ${onRange.whiteMin.toFixed(2)}:1, threshold ${recipe.onContrast}`,
  );
  const file = recipeToJson(recipe, {
    name: 'DDS fit',
    description:
      `Fitted to the ${Object.keys(fixture.themes).length} DDS brand themes` +
      (fixture.commit ? ` (tokens commit ${fixture.commit.slice(0, 7)})` : '') +
      ' by scripts/fit-recipe.ts. step: mix until the color lands on that DDS step. ' +
      'white / black: share of white in a tint or black in a shade, in percent. ' +
      'onContrast: white text from this contrast ratio up, onDark below it. ' +
      'alpha: opacity of the base-alpha-12 slots, in percent. ' +
      'tertiaryDefault: the fixed tertiary used when no tertiary color is picked.',
  });
  if (process.argv.includes('--write')) {
    const out = resolve(import.meta.dir, '../recipes/dds.json');
    await writeFile(out, file);
    console.log(`\nwrote ${out}`);
  } else {
    console.log('\nrecipes/dds.json would be:\n' + file);
  }
}
