/**
 * DDS brand themes: derive every Digikala Design System theme slot from a brand's base
 * colors, with a recipe reverse-engineered from the DDS's own brand themes.
 *
 * Two facts carry the whole thing:
 *   1. The number in a DDS color name is its darkness, step = round(100 * (1 - luma)),
 *      with Rec. 601 luma on the gamma-encoded channels.
 *   2. Tints are the base mixed with white and shades the base mixed with black, in that
 *      same gamma-encoded space. Luma is linear there, so a mix moves the step linearly
 *      and "lighten to step n" has a closed form.
 *
 * DDS_RECIPE holds the fitted constants. scripts/fit-recipe.ts derives them from
 * test/fixtures/dds-themes.json, and test/brand.ts fails if the two drift apart.
 */

import { Rgb, clamp01, rgbToHex, rgbToOklch } from './oklch';

export type BrandGroup = 'primary' | 'secondary' | 'tertiary';

/** The slots a recipe derives from the base. Everything else is the base itself or a rule. */
export type DerivedPart = 'tint-1' | 'tint-2' | 'tint-3' | 'shade-2' | 'shade-1';

export type SlotPart = DerivedPart | 'gradient' | 'base' | 'alpha' | 'on';

/**
 * How one slot is reached from the base. Tints move toward white and shades toward black:
 * `step` mixes until the color lands on that DDS step, `mix` uses a fixed share of white or
 * black (0..1). A base already past a step target is used as is.
 */
export type SlotRule = { kind: 'step'; step: number } | { kind: 'mix'; amount: number };

export interface BrandRecipe {
  primary: Record<'tint-1' | 'tint-2' | 'tint-3' | 'shade-2' | 'shade-1', SlotRule>;
  secondary: Record<'tint-1' | 'tint-2' | 'shade-1', SlotRule>;
  /** Only used for a custom tertiary; the default tertiary is the DDS neutral set. */
  tertiary: Record<'tint-1' | 'tint-2' | 'shade-1', SlotRule>;
  /** White text and icons when white on the base reaches this contrast ratio. */
  onContrast: number;
  /** Opacity of the `*-base-alpha-12` slots. */
  alpha: number;
}

/**
 * Fitted against the 20 DDS brand themes by scripts/fit-recipe.ts. Do not hand-tune:
 * refit, then copy the printed recipe here.
 */
export const DDS_RECIPE: BrandRecipe = {
  primary: {
    'tint-1': { kind: 'step', step: 3 },
    'tint-2': { kind: 'mix', amount: 0.88 },
    'tint-3': { kind: 'step', step: 21 },
    'shade-2': { kind: 'mix', amount: 0.2 },
    'shade-1': { kind: 'mix', amount: 0.55 },
  },
  secondary: {
    'tint-1': { kind: 'step', step: 4 },
    'tint-2': { kind: 'mix', amount: 0.68 },
    'shade-1': { kind: 'mix', amount: 0.41 },
  },
  tertiary: {
    'tint-1': { kind: 'step', step: 7 },
    'tint-2': { kind: 'step', step: 48 },
    'shade-1': { kind: 'step', step: 96 },
  },
  onContrast: 2,
  alpha: 0.12,
};

/** The DDS tertiary every brand shares (neutral 06-cold, 48, 80, 96, white). */
export const DDS_NEUTRAL_TERTIARY: Record<'tint-1' | 'tint-2' | 'base' | 'shade-1' | 'on', string> = {
  'tint-1': '#ECEDEF',
  'tint-2': '#848484',
  base: '#333333',
  'shade-1': '#0A0A0A',
  on: '#FFFFFF',
};

/** Dark text for light bases: DDS neutral-96. */
export const DDS_ON_DARK = '#0A0A0A';

/* -------------------------------------------------------------------------- */
/* Slots                                                                       */
/* -------------------------------------------------------------------------- */

export interface SlotSpec {
  group: BrandGroup;
  part: SlotPart;
  /** DDS token key, e.g. `primary-tint-1`. */
  key: string;
  /** Figma variable name, e.g. `primary/primary-tint-1`. */
  name: string;
  /** What the slot is for, from the DDS descriptions and its light/dark mode mapping. */
  usage: string;
}

function slot(group: BrandGroup, part: SlotPart, key: string, usage: string): SlotSpec {
  return { group, part, key, name: `${group}/${key}`, usage };
}

/** Every DDS theme slot, in the DDS's own order. */
export const BRAND_SLOTS: readonly SlotSpec[] = [
  slot('primary', 'tint-1', 'primary-tint-1', 'Container and hint backgrounds, in effect a surface. Dark mode uses shade-1 here.'),
  slot('primary', 'tint-2', 'primary-tint-2', 'Tonal actions and labels.'),
  slot('primary', 'tint-3', 'primary-tint-3', 'The light brand tone in light mode; brand text in dark mode.'),
  slot('primary', 'gradient', 'primary-gradient', 'Second stop of the primary gradient, which starts from the base.'),
  slot('primary', 'base', 'primary-base', 'The brand color.'),
  slot('primary', 'shade-2', 'primary-shade-2', 'Deep brand tone. Dark mode uses it where light mode uses tint-3.'),
  slot('primary', 'shade-1', 'primary-shade-1', 'Darkest brand tone; the brand surface in dark mode.'),
  slot('primary', 'alpha', 'primary-base-alpha-12', 'Progress bars and maps.'),
  slot('primary', 'on', 'on-primary', 'Text and icons on the brand color.'),
  slot('secondary', 'tint-1', 'secondary-tint-1', 'Secondary surface. Dark mode uses shade-1 here.'),
  slot('secondary', 'tint-2', 'secondary-tint-2', 'Lighter secondary tone; the secondary shade in dark mode.'),
  slot('secondary', 'base', 'secondary-base', 'The secondary color.'),
  slot('secondary', 'alpha', 'secondary-base-alpha-12', 'Borders.'),
  slot('secondary', 'shade-1', 'secondary-shade-1', 'Darkest secondary tone; the secondary surface in dark mode.'),
  slot('secondary', 'on', 'on-secondary', 'Text and icons on the secondary color.'),
  slot('tertiary', 'tint-1', 'tertiary-tint-1', 'Tertiary surface.'),
  slot('tertiary', 'tint-2', 'tertiary-tint-2', 'Mid tertiary tone.'),
  slot('tertiary', 'base', 'tertiary-base', 'The tertiary color.'),
  slot('tertiary', 'shade-1', 'tertiary-shade-1', 'Darkest tertiary tone.'),
  slot('tertiary', 'on', 'on-tertiary', 'Text and icons on the tertiary color.'),
];

/** The root string variable that names the brand. */
export const THEME_NAME_VARIABLE = 'theme';

export const BRAND_GROUPS: readonly BrandGroup[] = ['primary', 'secondary', 'tertiary'];

/* -------------------------------------------------------------------------- */
/* Color helpers                                                               */
/* -------------------------------------------------------------------------- */

const WHITE: Rgb = { r: 1, g: 1, b: 1 };
const BLACK: Rgb = { r: 0, g: 0, b: 0 };

/** `#abc`, `abc`, `#aabbcc` or `aabbcc`, any case. */
export function parseHex(text: string): Rgb | null {
  const hex = text.trim().replace(/^#/, '');
  const full = /^[0-9a-f]{3}$/i.test(hex)
    ? hex.split('').map((ch) => ch + ch).join('')
    : hex;
  if (!/^[0-9a-f]{6}$/i.test(full)) return null;
  return {
    r: parseInt(full.slice(0, 2), 16) / 255,
    g: parseInt(full.slice(2, 4), 16) / 255,
    b: parseInt(full.slice(4, 6), 16) / 255,
  };
}

function requireHex(text: string, label: string): Rgb {
  const color = parseHex(text);
  if (!color) throw new Error(`${label} is not a hex color: "${text}"`);
  return color;
}

/** Round each channel to 8 bits: what ships is what gets measured. */
export function round8(color: Rgb): Rgb {
  const q = (v: number) => Math.round(clamp01(v) * 255) / 255;
  return { r: q(color.r), g: q(color.g), b: q(color.b) };
}

/** Rec. 601 luma on gamma-encoded channels, 0..1. */
export function luma(color: Rgb): number {
  return 0.299 * color.r + 0.587 * color.g + 0.114 * color.b;
}

/** The DDS step number: `pomegranate-62` is 62 because its luma is 38%. */
export function stepOf(color: Rgb): number {
  return Math.round(100 * (1 - luma(color)));
}

/** Two digits, as the DDS writes them: 3 -> "03". */
export function stepLabel(step: number): string {
  return String(step).padStart(2, '0');
}

export function mixWhite(color: Rgb, amount: number): Rgb {
  const t = clamp01(amount);
  return { r: color.r + (1 - color.r) * t, g: color.g + (1 - color.g) * t, b: color.b + (1 - color.b) * t };
}

export function mixBlack(color: Rgb, amount: number): Rgb {
  const k = 1 - clamp01(amount);
  return { r: color.r * k, g: color.g * k, b: color.b * k };
}

/** Share of white that lands `color` on `step`; 0 when it is already that light. */
export function whiteForStep(color: Rgb, step: number): number {
  const current = luma(color);
  const target = 1 - step / 100;
  if (current >= 1 || target <= current) return 0;
  return clamp01((target - current) / (1 - current));
}

/** Share of black that lands `color` on `step`; 0 when it is already that dark. */
export function blackForStep(color: Rgb, step: number): number {
  const current = luma(color);
  const target = 1 - step / 100;
  if (current <= 0 || target >= current) return 0;
  return clamp01(1 - target / current);
}

/** Apply one recipe rule toward white (tints) or black (shades). */
export function applyRule(base: Rgb, rule: SlotRule, toward: 'white' | 'black'): Rgb {
  if (toward === 'white') {
    return mixWhite(base, rule.kind === 'mix' ? rule.amount : whiteForStep(base, rule.step));
  }
  return mixBlack(base, rule.kind === 'mix' ? rule.amount : blackForStep(base, rule.step));
}

function relativeLuminance(color: Rgb): number {
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * lin(color.r) + 0.7152 * lin(color.g) + 0.0722 * lin(color.b);
}

/** WCAG 2 contrast ratio, 1..21. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** White when white on the base reaches the threshold, otherwise DDS neutral-96. */
export function onColorFor(base: Rgb, threshold = DDS_RECIPE.onContrast): Rgb {
  return contrastRatio(WHITE, base) >= threshold ? WHITE : (parseHex(DDS_ON_DARK) as Rgb);
}

/** OKLab distance x100: 1 is roughly the smallest difference anyone notices. */
export function deltaE(a: Rgb, b: Rgb): number {
  const lab = (color: Rgb) => {
    const { l, c, h } = rgbToOklch(color);
    const rad = ((h ?? 0) * Math.PI) / 180;
    return [l, c * Math.cos(rad), c * Math.sin(rad)];
  };
  const [x, y] = [lab(a), lab(b)];
  return 100 * Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}

/* -------------------------------------------------------------------------- */
/* Generation                                                                  */
/* -------------------------------------------------------------------------- */

export interface BrandInput {
  /** Mode name in Figma and the value of the root `theme` variable, e.g. "Shop". */
  name: string;
  primary: string;
  secondary: string;
  /** Leave empty for the DDS neutral tertiary every brand shares. */
  tertiary?: string | null;
  /** Leave empty to use the primary base, as most DDS brands do. */
  gradient?: string | null;
}

export interface BrandSlot extends SlotSpec {
  /** Opaque color, `#RRGGBB`. Alpha slots carry their opacity in `rgb.a`. */
  hex: string;
  /** 0..1 channels, ready for a Figma paint or variable. */
  rgb: { r: number; g: number; b: number; a: number };
  /** DDS step of the opaque color. */
  step: number;
}

export interface BrandTheme {
  name: string;
  slots: BrandSlot[];
}

function derivedRule(recipe: BrandRecipe, group: BrandGroup, part: DerivedPart): SlotRule {
  const rules = recipe[group] as Partial<Record<DerivedPart, SlotRule>>;
  const rule = rules[part];
  if (!rule) throw new Error(`The recipe has no ${group} ${part}`);
  return rule;
}

/** Each group's slots from lightest to darkest, the order the DDS keeps them in. */
export const BRAND_LIGHT_TO_DARK: Record<BrandGroup, SlotPart[]> = {
  primary: ['tint-1', 'tint-2', 'tint-3', 'base', 'shade-2', 'shade-1'],
  secondary: ['tint-1', 'tint-2', 'base', 'shade-1'],
  tertiary: ['tint-1', 'tint-2', 'base', 'shade-1'],
};

export function generateBrandTheme(input: BrandInput, recipe: BrandRecipe = DDS_RECIPE): BrandTheme {
  const bases: Record<BrandGroup, Rgb | null> = {
    primary: requireHex(input.primary, 'Primary'),
    secondary: requireHex(input.secondary, 'Secondary'),
    tertiary: input.tertiary?.trim() ? requireHex(input.tertiary, 'Tertiary') : null,
  };
  const gradient = input.gradient?.trim() ? requireHex(input.gradient, 'Gradient') : null;

  const colors = new Map<string, Rgb>();
  for (const spec of BRAND_SLOTS) {
    const base = bases[spec.group];
    let color: Rgb;
    if (!base) {
      // Only the tertiary can be missing, and then it is the shared DDS neutral set.
      color = parseHex(DDS_NEUTRAL_TERTIARY[spec.part as keyof typeof DDS_NEUTRAL_TERTIARY]) as Rgb;
    } else if (spec.part === 'base' || spec.part === 'alpha') {
      color = base;
    } else if (spec.part === 'gradient') {
      color = gradient ?? base;
    } else if (spec.part === 'on') {
      color = onColorFor(base, recipe.onContrast);
    } else {
      const toward = spec.part.startsWith('tint') ? 'white' : 'black';
      color = applyRule(base, derivedRule(recipe, spec.group, spec.part), toward);
    }
    colors.set(spec.key, color);
  }

  // A light base can push a fixed-mix tint past a fixed-step one (12% of a step-15 base is
  // lighter than step 3). The DDS never orders slots out of light-to-dark; it collapses
  // them instead, so a slot that would overtake its lighter neighbour takes its color.
  for (const group of BRAND_GROUPS) {
    let previous: Rgb | null = null;
    for (const part of BRAND_LIGHT_TO_DARK[group]) {
      const spec = BRAND_SLOTS.find((s) => s.group === group && s.part === part);
      if (!spec) continue;
      let color = colors.get(spec.key) as Rgb;
      if (previous && luma(color) > luma(previous)) color = previous;
      colors.set(spec.key, color);
      previous = color;
    }
  }

  const slots = BRAND_SLOTS.map((spec): BrandSlot => {
    const rounded = round8(colors.get(spec.key) as Rgb);
    const alpha = spec.part === 'alpha' ? recipe.alpha : 1;
    return { ...spec, hex: rgbToHex(rounded), rgb: { ...rounded, a: alpha }, step: stepOf(rounded) };
  });

  return { name: input.name.trim() || 'Brand', slots };
}

/**
 * The whole white -> base -> black path a base color's tints and shades live on, sampled
 * every `every` steps with the base itself included. Every derived slot sits on it.
 */
export function spectrum(base: string, every = 2): Array<{ step: number; hex: string }> {
  const color = requireHex(base, 'Color');
  const baseStep = 100 * (1 - luma(color));
  const out: Array<{ step: number; hex: string }> = [];
  for (let step = 0; step <= 100; step += every) {
    const sample =
      step < baseStep
        ? mixWhite(color, whiteForStep(color, step))
        : mixBlack(color, blackForStep(color, step));
    out.push({ step, hex: rgbToHex(round8(sample)) });
  }
  out.push({ step: baseStep, hex: rgbToHex(round8(color)) });
  return out.sort((a, b) => a.step - b.step);
}

/* -------------------------------------------------------------------------- */
/* Export                                                                      */
/* -------------------------------------------------------------------------- */

export function brandSlug(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'brand'
  );
}

function cssValue(s: BrandSlot): string {
  if (s.rgb.a >= 1) return s.hex;
  const ch = (v: number) => Math.round(v * 255);
  return `rgba(${ch(s.rgb.r)},${ch(s.rgb.g)},${ch(s.rgb.b)},${Number(s.rgb.a.toFixed(2))})`;
}

/** The theme in the DDS tokens JSON shape: `{ <brand>: { primary: { ... }, theme } }`. */
export function brandThemeToJson(theme: BrandTheme): string {
  const body: Record<string, unknown> = {};
  for (const group of BRAND_GROUPS) {
    const entries: Record<string, unknown> = {};
    for (const s of theme.slots.filter((x) => x.group === group)) {
      entries[s.key] = { $type: 'color', $value: cssValue(s), $description: `step ${stepLabel(s.step)}` };
    }
    body[group] = entries;
  }
  body[THEME_NAME_VARIABLE] = { $type: 'string', $value: theme.name };
  return JSON.stringify({ [brandSlug(theme.name)]: body }, null, 2);
}
