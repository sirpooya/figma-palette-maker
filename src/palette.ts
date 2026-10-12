/**
 * Palette generation: turn a curve config into a ramp of stops.
 *
 * The whole pipeline for stop i of n:
 *   1. x = i / (n - 1)
 *   2. L% = curve_l(x), C = curve_c(x), H = curve_h(x)   (each clamped to its min/max)
 *   3. per-stop manual overrides win over the curve
 *   4. oklch(L% C H) -> gamut mapped into sRGB -> rounded to 8 bit -> hex
 *   5. the displayed oklch string is read back OFF the rounded sRGB value,
 *      so what you see is what the hex actually is
 */

import {
  Channel,
  Params,
  PresetId,
  defaultParams,
  evaluateChannel,
  solveArctan,
} from './curves';
import {
  Rgb,
  clamp01,
  formatOklch,
  gamutMapOklchToRgb,
  rgbToHex,
  rgbToOklch,
} from './oklch';

export interface ChannelConfig {
  preset: PresetId;
  params: Params;
  /** Curve output is clamped to this range. Lightness in %, chroma 0..0.4, hue in degrees. */
  min: number;
  max: number;
}

export type StopOverride = Partial<Record<Channel, number>>;

export interface PaletteConfig {
  /** Number of stops. The original UI allows 3..24. */
  stops: number;
  /** First token number. 50 yields 50, 100, 200, 300 ... */
  tokenStart: number;
  l: ChannelConfig;
  c: ChannelConfig;
  h: ChannelConfig;
  stopOverrides?: StopOverride[];
}

export interface PaletteStop {
  token: number;
  /** Lightness in percent, 0..100. */
  l: number;
  /** Chroma, 0..0.4. */
  c: number;
  /** Hue in degrees. */
  h: number;
  hex: string;
  /** Read back from the rounded sRGB value, e.g. `oklch(62.62% 0.20 286.4)`. */
  oklch: string;
  /** 0..1 channels, ready for a Figma paint. */
  rgb: { r: number; g: number; b: number; a: number };
}

export const MIN_STOPS = 3;
export const MAX_STOPS = 24;

/* -------------------------------------------------------------------------- */
/* Token numbering                                                             */
/* -------------------------------------------------------------------------- */

function normalizeTokenStart(v: number): number {
  return Math.max(1, Math.round(v));
}

/**
 * 1     -> 1, 2, 3 ...
 * 50    -> 50, 100, 200, 300 ...  (the Tailwind-ish shape)
 * n*100 -> n, n+100, n+200 ...
 * other -> n, n+1, n+2 ...
 */
export function tokenNames(tokenStart: number, stops: number): number[] {
  const start = normalizeTokenStart(tokenStart);
  if (stops < 1) return [];
  if (start === 1) return Array.from({ length: stops }, (_v, i) => i + 1);
  if (start === 50) {
    return [50, ...Array.from({ length: stops - 1 }, (_v, i) => (i + 1) * 100)];
  }
  if (start % 100 === 0) {
    return Array.from({ length: stops }, (_v, i) => start + 100 * i);
  }
  return Array.from({ length: stops }, (_v, i) => start + i);
}

/* -------------------------------------------------------------------------- */
/* Generation                                                                  */
/* -------------------------------------------------------------------------- */

function resolveColor(lPercent: number, c: number, h: number) {
  const mapped = gamutMapOklchToRgb({ l: lPercent / 100, c, h });

  // Round to 8 bit first: everything downstream describes the color you can ship.
  const rounded: Rgb = {
    r: Math.round(mapped.r * 255) / 255,
    g: Math.round(mapped.g * 255) / 255,
    b: Math.round(mapped.b * 255) / 255,
  };

  const readBack = rgbToOklch(rounded);

  return {
    hex: rgbToHex(rounded),
    oklch: formatOklch(readBack.l * 100, readBack.c, readBack.h ?? h),
    rgb: { r: clamp01(rounded.r), g: clamp01(rounded.g), b: clamp01(rounded.b), a: 1 },
  };
}

export function generatePalette(config: PaletteConfig): PaletteStop[] {
  const tokens = tokenNames(config.tokenStart, config.stops);
  const span = Math.max(config.stops - 1, 1);
  const overrides = config.stopOverrides ?? [];

  return tokens.map((token, i) => {
    const x = i / span;
    const override = overrides[i];

    const l =
      override?.l ??
      evaluateChannel('l', config.l.preset, config.l.params, config.l.min, config.l.max, x);
    const c =
      override?.c ??
      evaluateChannel('c', config.c.preset, config.c.params, config.c.min, config.c.max, x);
    const h =
      override?.h ??
      evaluateChannel('h', config.h.preset, config.h.params, config.h.min, config.h.max, x);

    return { token, l, c, h, ...resolveColor(l, c, h) };
  });
}

/* -------------------------------------------------------------------------- */
/* Built-in configs                                                            */
/* -------------------------------------------------------------------------- */

/** The default ramp: 16 stops, arctan lightness, flat chroma and hue. */
export function defaultConfig(): PaletteConfig {
  return {
    stops: 16,
    tokenStart: 50,
    l: {
      preset: 'arctan',
      params: solveArctan(0, 100, { k: 4.5, d: 2.8 }),
      min: 0,
      max: 100,
    },
    c: { preset: 'flat', params: { c: 0.2 }, min: 0, max: 0.2 },
    h: {
      preset: 'flat',
      params: defaultParams('flat', 'h', 286.4, 286.4),
      min: 286.4,
      max: 286.4,
    },
  };
}

/** The "binding palette" preset: 24 near-neutral stops for surfaces and borders. */
export function bindingPaletteConfig(): PaletteConfig {
  return {
    stops: 24,
    tokenStart: 50,
    l: {
      preset: 'arctan',
      params: solveArctan(15.61, 99.8, { k: 4.5, d: 2.8 }),
      min: 15.61,
      max: 99.8,
    },
    c: {
      preset: 'flat',
      params: defaultParams('flat', 'c', 0, 0.001),
      min: 0,
      max: 0.001,
    },
    h: {
      preset: 'flat',
      params: defaultParams('flat', 'h', 286.4, 286.4),
      min: 286.4,
      max: 286.4,
    },
  };
}

/**
 * Rebuild a channel config around a new min/max, re-solving the curve so the ramp
 * still starts at max and ends at min. Use this when the user drags an endpoint.
 */
export function reanchorChannel(
  channel: Channel,
  preset: PresetId,
  min: number,
  max: number,
): ChannelConfig {
  return { preset, params: defaultParams(preset, channel, min, max), min, max };
}

/* -------------------------------------------------------------------------- */
/* Export helpers                                                              */
/* -------------------------------------------------------------------------- */

export function toCssVariables(stops: PaletteStop[], name = 'gray'): string {
  const body = stops.map((s) => `  --${name}-${s.token}: ${s.oklch};`).join('\n');
  return `:root {\n${body}\n}`;
}

export function toJson(stops: PaletteStop[], name = 'gray'): string {
  return JSON.stringify(
    {
      name,
      stops: stops.map((s) => ({
        token: s.token,
        hex: s.hex,
        oklch: s.oklch,
        l: s.l,
        c: s.c,
        h: s.h,
      })),
    },
    null,
    2,
  );
}
