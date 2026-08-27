/**
 * OKLCH <-> sRGB color math, plus CSS Color 4 gamut mapping.
 *
 * Ported from the culori conversion chain used by sds.sallee.design/palette-maker,
 * with the exact same matrix coefficients so output matches byte for byte.
 * Zero dependencies, so it runs inside the Figma plugin sandbox as-is.
 */

/** Lightness 0..1, chroma 0..~0.4, hue 0..360 (undefined when achromatic). */
export interface Oklch {
  l: number;
  c: number;
  h?: number;
}

/** Channels 0..1. */
export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

export function normalizeHue(h: number): number {
  const v = h % 360;
  return v < 0 ? v + 360 : v;
}

/* -------------------------------------------------------------------------- */
/* sRGB transfer functions                                                     */
/* -------------------------------------------------------------------------- */

function gammaDecode(c: number): number {
  const abs = Math.abs(c);
  if (abs <= 0.04045) return c / 12.92;
  return (Math.sign(c) || 1) * Math.pow((abs + 0.055) / 1.055, 2.4);
}

function gammaEncode(c: number): number {
  const abs = Math.abs(c);
  if (abs > 0.0031308) {
    return (Math.sign(c) || 1) * (1.055 * Math.pow(abs, 1 / 2.4) - 0.055);
  }
  return c * 12.92;
}

/* -------------------------------------------------------------------------- */
/* OKLab                                                                       */
/* -------------------------------------------------------------------------- */

interface Oklab {
  l: number;
  a: number;
  b: number;
}

function linearRgbToOklab(r: number, g: number, b: number): Oklab {
  const L = Math.cbrt(0.412221469470763 * r + 0.5363325372617348 * g + 0.0514459932675022 * b);
  const M = Math.cbrt(0.2119034958178252 * r + 0.6806995506452344 * g + 0.1073969535369406 * b);
  const S = Math.cbrt(0.0883024591900564 * r + 0.2817188391361215 * g + 0.6299787016738222 * b);
  return {
    l: 0.210454268309314 * L + 0.7936177747023054 * M - 0.0040720430116193 * S,
    a: 1.9779985324311684 * L - 2.42859224204858 * M + 0.450593709617411 * S,
    b: 0.0259040424655478 * L + 0.7827717124575296 * M - 0.8086757549230774 * S,
  };
}

function oklabToLinearRgb({ l, a, b }: Oklab): Rgb {
  const L = Math.pow(l + 0.3963377773761749 * a + 0.2158037573099136 * b, 3);
  const M = Math.pow(l - 0.1055613458156586 * a - 0.0638541728258133 * b, 3);
  const S = Math.pow(l - 0.0894841775298119 * a - 1.2914855480194092 * b, 3);
  return {
    r: 4.076741636075957 * L - 3.3077115392580616 * M + 0.2309699031821044 * S,
    g: -1.2684379732850317 * L + 2.6097573492876887 * M - 0.3413193760026573 * S,
    b: -0.0041960761386756 * L - 0.7034186179359362 * M + 1.7076146940746117 * S,
  };
}

/* -------------------------------------------------------------------------- */
/* Conversions                                                                 */
/* -------------------------------------------------------------------------- */

/** OKLCH -> sRGB. Channels are NOT clamped, so out-of-gamut colors stay detectable. */
export function oklchToRgb(color: Oklch): Rgb {
  const h = color.h ?? 0;
  const rad = (h * Math.PI) / 180;
  const lin = oklabToLinearRgb({
    l: color.l,
    a: color.c * Math.cos(rad),
    b: color.c * Math.sin(rad),
  });
  return { r: gammaEncode(lin.r), g: gammaEncode(lin.g), b: gammaEncode(lin.b) };
}

/** sRGB -> OKLCH. `h` is undefined for achromatic colors, matching culori. */
export function rgbToOklch(color: Rgb): Oklch {
  const lab = linearRgbToOklab(gammaDecode(color.r), gammaDecode(color.g), gammaDecode(color.b));
  // culori snaps exact grays to zero chroma before the polar conversion.
  if (color.r === color.g && color.g === color.b) {
    lab.a = 0;
    lab.b = 0;
  }
  const c = Math.sqrt(lab.a * lab.a + lab.b * lab.b);
  const out: Oklch = { l: lab.l, c };
  if (c) out.h = normalizeHue((Math.atan2(lab.b, lab.a) * 180) / Math.PI);
  return out;
}

export function inSrgbGamut(color: Oklch): boolean {
  const { r, g, b } = oklchToRgb(color);
  return r >= 0 && r <= 1 && g >= 0 && g <= 1 && b >= 0 && b <= 1;
}

/* -------------------------------------------------------------------------- */
/* Gamut mapping (CSS Color 4 / culori toGamut)                                */
/* -------------------------------------------------------------------------- */

/** Euclidean distance in OKLCH, with the chroma-weighted hue term culori uses. */
function deltaEOklch(a: Oklch, b: Oklch): number {
  const dl = a.l - b.l;
  const dc = a.c - b.c;
  let dh = 0;
  if (a.h !== undefined && b.h !== undefined && a.c && b.c) {
    const ha = normalizeHue(a.h);
    const hb = normalizeHue(b.h);
    dh = 2 * Math.sqrt(a.c * b.c) * Math.sin((((hb - ha + 360) / 2) * Math.PI) / 180);
  }
  return Math.sqrt(dl * dl + dc * dc + dh * dh);
}

/** Naive channel clip, returned back in OKLCH so it can be compared to the target. */
function clipToOklch(color: Oklch): Oklch {
  const rgb = oklchToRgb(color);
  return rgbToOklch({ r: clamp01(rgb.r), g: clamp01(rgb.g), b: clamp01(rgb.b) });
}

const CHROMA_EPSILON = 0.4 / 4000;
const JND = 0.02;

/**
 * Reduce chroma by binary search until the color fits in sRGB, accepting a clipped
 * candidate as soon as it is within a just-noticeable difference of the target.
 */
export function gamutMapOklchToRgb(color: Oklch): Rgb {
  const target: Oklch = { l: color.l, c: color.c, h: color.h };

  if (target.l >= 1) return { r: 1, g: 1, b: 1 };
  if (target.l <= 0) return { r: 0, g: 0, b: 0 };
  if (inSrgbGamut(target)) return oklchToRgb(target);

  let low = 0;
  let high = target.c;
  let clipped = clipToOklch(target);

  while (high - low > CHROMA_EPSILON) {
    target.c = (low + high) / 2;
    clipped = clipToOklch(target);
    if (inSrgbGamut(target) || deltaEOklch(target, clipped) <= JND) {
      low = target.c;
    } else {
      high = target.c;
    }
  }

  return oklchToRgb(inSrgbGamut(target) ? target : clipped);
}

/* -------------------------------------------------------------------------- */
/* Formatting                                                                  */
/* -------------------------------------------------------------------------- */

export function rgbToHex(color: Rgb): string {
  const ch = (v: number) => Math.round(255 * clamp01(v || 0));
  const packed = (1 << 24) | (ch(color.r) << 16) | (ch(color.g) << 8) | ch(color.b);
  return ('#' + packed.toString(16).slice(1)).toUpperCase();
}

/** `oklch(62.62% 0.20 286.4)`, using the palette maker's exact rounding rules. */
export function formatOklch(lPercent: number, c: number, h: number): string {
  const l = Number.isInteger(lPercent) ? String(lPercent) : lPercent.toFixed(2);
  const chroma = c.toFixed(c < 0.01 ? 3 : 2);
  const hue = Number.isInteger(h) ? String(h) : h.toFixed(1);
  return `oklch(${l}% ${chroma} ${hue})`;
}
