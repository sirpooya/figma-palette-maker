/**
 * Brand themes: derive every theme slot from a brand's base colors, following a recipe the
 * user imports.
 *
 * Two facts carry the whole thing:
 *   1. A color's step is its darkness, step = round(100 * (1 - luma)),
 *      with Rec. 601 luma on the gamma-encoded channels.
 *   2. Tints are the base mixed with white and shades the base mixed with black, in that
 *      same gamma-encoded space. Luma is linear there, so a mix moves the step linearly
 *      and "lighten to step n" has a closed form.
 *
 * The engine is headless: it holds no recipe and no colors of its own. Every number and
 * every fixed color comes from a recipe file the user imports.
 */

import { Rgb, clamp01, rgbToHex, rgbToOklch } from './oklch';

export type BrandGroup = 'primary' | 'secondary' | 'tertiary';

/** The slots a recipe derives from the base. Everything else is the base itself or a rule. */
export type DerivedPart = 'tint-1' | 'tint-2' | 'tint-3' | 'shade-2' | 'shade-1';

export type SlotPart = DerivedPart | 'gradient' | 'base' | 'alpha' | 'on';

/**
 * How one slot is reached from the base. Tints move toward white and shades toward black:
 * `step` mixes until the color lands on that step, `mix` uses a fixed share of white or
 * black (0..1). A base already past a step target is used as is.
 */
export type SlotRule = { kind: 'step'; step: number } | { kind: 'mix'; amount: number };

/** A fixed tertiary set, used as is when the tertiary color is left empty or set to its base. */
export type TertiaryDefault = Record<'base' | 'tint-1' | 'tint-2' | 'shade-1' | 'on', string>;

export interface BrandRecipe {
  primary: Record<'tint-1' | 'tint-2' | 'tint-3' | 'shade-2' | 'shade-1', SlotRule>;
  secondary: Record<'tint-1' | 'tint-2' | 'shade-1', SlotRule>;
  /** For a tertiary color other than `tertiaryDefault.base`. */
  tertiary: Record<'tint-1' | 'tint-2' | 'shade-1', SlotRule>;
  /** White text and icons when white on the base reaches this contrast ratio. */
  onContrast: number;
  /** Text and icons on bases below the threshold. */
  onDark: string;
  /** Opacity of the `*-base-alpha-12` slots. */
  alpha: number;
  /** The tertiary set to use when no tertiary color is given, or null. */
  tertiaryDefault: TertiaryDefault | null;
}

const TERTIARY_DEFAULT_KEYS: Array<keyof TertiaryDefault> = ['base', 'tint-1', 'tint-2', 'shade-1', 'on'];

/* -------------------------------------------------------------------------- */
/* Recipe files                                                                */
/* -------------------------------------------------------------------------- */

/** Marks a JSON file as a Manshur Theme Builder recipe. */
export const RECIPE_FORMAT = 'manshur-theme-recipe';
export const RECIPE_VERSION = 1;

/** The slots a recipe sets, per group, in file order. */
export const RECIPE_SLOTS: Record<BrandGroup, DerivedPart[]> = {
  primary: ['tint-1', 'tint-2', 'tint-3', 'shade-2', 'shade-1'],
  secondary: ['tint-1', 'tint-2', 'shade-1'],
  tertiary: ['tint-1', 'tint-2', 'shade-1'],
};

/**
 * A recipe as a file: `{ "step": 3 }`, `{ "white": 88 }` (tints) or `{ "black": 55 }`
 * (shades) per slot, percentages for mixes and alpha, and optional name/description.
 */
export function recipeToJson(
  recipe: BrandRecipe,
  meta: { name?: string; description?: string } = {},
): string {
  const percent = (v: number) => Number((v * 100).toFixed(2));
  const group = (g: BrandGroup) =>
    Object.fromEntries(
      RECIPE_SLOTS[g].map((part) => {
        const rule = (recipe[g] as Record<string, SlotRule>)[part];
        const toward = part.startsWith('tint') ? 'white' : 'black';
        return [part, rule.kind === 'step' ? { step: rule.step } : { [toward]: percent(rule.amount) }];
      }),
    );
  const text = JSON.stringify(
    {
      format: RECIPE_FORMAT,
      version: RECIPE_VERSION,
      ...(meta.name ? { name: meta.name } : {}),
      ...(meta.description ? { description: meta.description } : {}),
      primary: group('primary'),
      secondary: group('secondary'),
      tertiary: group('tertiary'),
      onContrast: recipe.onContrast,
      onDark: recipe.onDark,
      alpha: percent(recipe.alpha),
      ...(recipe.tertiaryDefault ? { tertiaryDefault: recipe.tertiaryDefault } : {}),
    },
    null,
    2,
  );
  // One rule per line: `"tint-1": { "step": 3 }` reads and hand-edits better than three.
  return text.replace(/\{\n\s+("(?:step|white|black)": -?[\d.]+)\n\s+\}/g, '{ $1 }') + '\n';
}

/** Read a recipe from parsed JSON. Strict: every slot must be there, in range. */
export function recipeFromData(data: unknown): BrandRecipe {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('A recipe must be a JSON object');
  }
  const file = data as Record<string, unknown>;
  if (file.format !== undefined && file.format !== RECIPE_FORMAT) {
    throw new Error(`Not a Manshur Theme Builder recipe (format "${String(file.format)}")`);
  }
  if (typeof file.version === 'number' && file.version > RECIPE_VERSION) {
    throw new Error(`This recipe needs a newer Manshur Theme Builder (version ${file.version})`);
  }

  const number = (value: unknown, label: string, min: number, max: number): number => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
      throw new Error(`${label} must be a number from ${min} to ${max}`);
    }
    return value;
  };

  const rule = (value: unknown, label: string, toward: 'white' | 'black'): SlotRule => {
    if (!value || typeof value !== 'object') throw new Error(`${label} is missing`);
    const entry = value as Record<string, unknown>;
    const keys = Object.keys(entry);
    if (keys.length !== 1) throw new Error(`${label} needs exactly one of "step" or "${toward}"`);
    if (keys[0] === 'step') return { kind: 'step', step: Math.round(number(entry.step, `${label} step`, 0, 100)) };
    if (keys[0] === toward) {
      return { kind: 'mix', amount: number(entry[toward], `${label} ${toward}`, 0, 100) / 100 };
    }
    throw new Error(`${label} takes "step" or "${toward}", not "${keys[0]}"`);
  };

  const group = (g: BrandGroup) => {
    const source = file[g];
    if (!source || typeof source !== 'object') throw new Error(`"${g}" is missing`);
    return Object.fromEntries(
      RECIPE_SLOTS[g].map((part) => [
        part,
        rule((source as Record<string, unknown>)[part], `${g} ${part}`, part.startsWith('tint') ? 'white' : 'black'),
      ]),
    );
  };

  const hex = (value: unknown, label: string): string => {
    const color = typeof value === 'string' ? parseHex(value) : null;
    if (!color) throw new Error(`${label} must be a hex color like "#0A0A0A"`);
    return rgbToHex(color);
  };

  let tertiaryDefault: TertiaryDefault | null = null;
  if (file.tertiaryDefault !== undefined && file.tertiaryDefault !== null) {
    if (typeof file.tertiaryDefault !== 'object') throw new Error('tertiaryDefault must be an object');
    const source = file.tertiaryDefault as Record<string, unknown>;
    tertiaryDefault = Object.fromEntries(
      TERTIARY_DEFAULT_KEYS.map((key) => [key, hex(source[key], `tertiaryDefault ${key}`)]),
    ) as TertiaryDefault;
  }

  return {
    primary: group('primary') as BrandRecipe['primary'],
    secondary: group('secondary') as BrandRecipe['secondary'],
    tertiary: group('tertiary') as BrandRecipe['tertiary'],
    onContrast: number(file.onContrast, 'onContrast', 1, 21),
    onDark: hex(file.onDark, 'onDark'),
    alpha: number(file.alpha, 'alpha', 0, 100) / 100,
    tertiaryDefault,
  };
}

/** Read a recipe file's text. */
export function parseRecipe(text: string): BrandRecipe {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('The recipe file is not valid JSON');
  }
  return recipeFromData(data);
}

/* -------------------------------------------------------------------------- */
/* Slots                                                                       */
/* -------------------------------------------------------------------------- */

export interface SlotSpec {
  group: BrandGroup;
  part: SlotPart;
  /** Token key, e.g. `primary-tint-1`. */
  key: string;
  /** Figma variable name, e.g. `primary/primary-tint-1`. */
  name: string;
  /** What the slot is for, and how it maps between light and dark mode. */
  usage: string;
}

function slot(group: BrandGroup, part: SlotPart, key: string, usage: string): SlotSpec {
  return { group, part, key, name: `${group}/${key}`, usage };
}

/** Every theme slot, in variable order. */
export const BRAND_SLOTS: readonly SlotSpec[] = [
  slot('primary', 'tint-1', 'primary-tint-1', 'Container and hint backgrounds, in effect a surface. Dark mode uses shade-1 here.'),
  slot('primary', 'tint-2', 'primary-tint-2', 'Tonal actions and labels.'),
  slot('primary', 'tint-3', 'primary-tint-3', 'The light brand tone in light mode; brand text in dark mode.'),
  slot('primary', 'gradient', 'primary-gradient', 'Second stop of the primary gradient, which starts from the base.'),
  slot('primary', 'base', 'primary-base', 'The brand color.'),
  slot('primary', 'shade-2', 'primary-shade-2', 'Deep brand tone. Dark mode uses it where light mode uses tint-3.'),
  slot('primary', 'shade-1', 'primary-shade-1', 'Darkest brand tone; the brand surface in dark mode.'),
  slot('primary', 'alpha', 'primary-base-alpha-12', 'Translucent brand fills, such as progress tracks and highlights.'),
  slot('primary', 'on', 'on-primary', 'Text and icons on the brand color.'),
  slot('secondary', 'tint-1', 'secondary-tint-1', 'Secondary surface. Dark mode uses shade-1 here.'),
  slot('secondary', 'tint-2', 'secondary-tint-2', 'Lighter secondary tone; the secondary shade in dark mode.'),
  slot('secondary', 'base', 'secondary-base', 'The secondary color.'),
  slot('secondary', 'alpha', 'secondary-base-alpha-12', 'Translucent secondary fills and borders.'),
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

/** The step number: a color with 38% luma is step 62. */
export function stepOf(color: Rgb): number {
  return Math.round(100 * (1 - luma(color)));
}

/** Always two digits: 3 -> "03". */
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

/** White when white on the base reaches the recipe's threshold, otherwise its dark color. */
export function onColorFor(base: Rgb, recipe: Pick<BrandRecipe, 'onContrast' | 'onDark'>): Rgb {
  return contrastRatio(WHITE, base) >= recipe.onContrast ? WHITE : (parseHex(recipe.onDark) as Rgb);
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
  /**
   * Empty, or the recipe's `tertiaryDefault.base`, gives that fixed set; any other color runs
   * through the tertiary rules.
   */
  tertiary?: string | null;
  /** Leave empty to use the primary base. */
  gradient?: string | null;
}

export interface BrandSlot extends SlotSpec {
  /** Opaque color, `#RRGGBB`. Alpha slots carry their opacity in `rgb.a`. */
  hex: string;
  /** 0..1 channels, ready for a Figma paint or variable. */
  rgb: { r: number; g: number; b: number; a: number };
  /** Step of the opaque color. */
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

/** Each group's slots from lightest to darkest. */
export const BRAND_LIGHT_TO_DARK: Record<BrandGroup, SlotPart[]> = {
  primary: ['tint-1', 'tint-2', 'tint-3', 'base', 'shade-2', 'shade-1'],
  secondary: ['tint-1', 'tint-2', 'base', 'shade-1'],
  tertiary: ['tint-1', 'tint-2', 'base', 'shade-1'],
};

/** The tertiary color, or null when the recipe's fixed tertiary set applies. */
function customTertiary(text: string | null | undefined, recipe: BrandRecipe): Rgb | null {
  const fixed = recipe.tertiaryDefault;
  if (!text?.trim()) {
    if (!fixed) throw new Error('Pick a tertiary color: this recipe has no default tertiary');
    return null;
  }
  const color = requireHex(text, 'Tertiary');
  return fixed && rgbToHex(round8(color)) === fixed.base ? null : color;
}

export function generateBrandTheme(input: BrandInput, recipe: BrandRecipe): BrandTheme {
  const bases: Record<BrandGroup, Rgb | null> = {
    primary: requireHex(input.primary, 'Primary'),
    secondary: requireHex(input.secondary, 'Secondary'),
    tertiary: customTertiary(input.tertiary, recipe),
  };
  const gradient = input.gradient?.trim() ? requireHex(input.gradient, 'Gradient') : null;

  const colors = new Map<string, Rgb>();
  for (const spec of BRAND_SLOTS) {
    const base = bases[spec.group];
    let color: Rgb;
    if (!base) {
      // Only the tertiary can be missing, and then it is the recipe's fixed set.
      const fixed = recipe.tertiaryDefault as TertiaryDefault;
      color = parseHex(fixed[spec.part as keyof TertiaryDefault]) as Rgb;
    } else if (spec.part === 'base' || spec.part === 'alpha') {
      color = base;
    } else if (spec.part === 'gradient') {
      color = gradient ?? base;
    } else if (spec.part === 'on') {
      color = onColorFor(base, recipe);
    } else {
      const toward = spec.part.startsWith('tint') ? 'white' : 'black';
      color = applyRule(base, derivedRule(recipe, spec.group, spec.part), toward);
    }
    colors.set(spec.key, color);
  }

  // A light base can push a fixed-mix tint past a fixed-step one (12% of a step-15 base is
  // lighter than step 3). Slots never go out of light-to-dark order; they collapse
  // instead, so a slot that would overtake its lighter neighbour takes its color.
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

/** The theme as design tokens JSON: `{ <brand>: { primary: { ... }, theme } }`. */
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
