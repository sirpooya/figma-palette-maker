/**
 * The distribution curves behind the palette maker.
 *
 * Every channel (lightness, chroma, hue) is a function of x, where x is the stop's
 * normalized position 0..1 across the ramp. Each preset carries:
 *   - the parameters it exposes (with slider ranges, kept for UI parity)
 *   - `evaluate(x, params, min, max)`
 *   - a solver that derives its parameters from a min/max pair, so switching preset
 *     keeps the ramp anchored at the same two endpoints.
 *
 * Curves are authored so that y(0) = max and y(1) = min: the ramp runs light to dark.
 */

export type Channel = 'l' | 'c' | 'h';

export type PresetId =
  | 'flat'
  | 'linear'
  | 'gaussian'
  | 'arctan'
  | 'quad'
  | 'expo'
  | 'expo-inverted';

export type Params = Record<string, number>;

export interface ParamSpec {
  name: string;
  label: string;
  default: number;
  min: number;
  max: number;
  step: number;
}

export interface Preset {
  id: PresetId;
  label: string;
  equation: string;
  params: ParamSpec[];
  evaluate: (x: number, params: Params, min: number, max: number) => number;
}

/* -------------------------------------------------------------------------- */
/* Parameter solvers                                                           */
/* -------------------------------------------------------------------------- */

/** arctan: solve b and c so y(0) = max and y(1) = min. */
function solveArctanBC(min: number, max: number, k: number, d: number) {
  const base = Math.atan(-d);
  const b = (min - max) / (Math.atan(k - d) - base);
  return { b, c: max - b * base };
}

export function solveArctan(min: number, max: number, params: Params): Params {
  const k = params.k ?? 4;
  const d = params.d ?? k / 2;
  const { b, c } = solveArctanBC(min, max, k, d);
  return { ...params, k, d, b, c };
}

export function solveQuad(min: number, max: number, params: Params): Params {
  const k = params.k ?? 4;
  const d = params.d ?? k / 2;
  return {
    ...params,
    k,
    d,
    c: max,
    a: (min - max) / ((k - d) ** 2 || 1e-6),
  };
}

/** gaussian: a bell of height max - min sitting on a floor of min. */
export function solveGaussian(
  min: number,
  max: number,
  params: Params,
  anchor?: 'max',
): Params {
  const k = params.k ?? 8;
  const d = params.d ?? k / 2;
  const raw = anchor === 'max' ? params.c ?? min : min;
  const floor = Math.max(min, Math.min(max, raw));
  return { ...params, k, d, c: floor, a: max - floor };
}

function solveExpoAC(min: number, max: number, k: number) {
  const denom = Math.exp(k) - 1;
  if (Math.abs(denom) < 1e-12) return { a: min - max, c: max };
  const a = (min - max) / denom;
  return { a, c: max - a };
}

function solveExpoInvertedAC(min: number, max: number, k: number) {
  const denom = Math.exp(-k) - 1;
  if (Math.abs(denom) < 1e-12) return { a: min - max, c: max };
  const a = (min - max) / denom;
  return { a, c: max - a };
}

export function solveExpo(min: number, max: number, params: Params): Params {
  const k = params.k ?? 4;
  const { a, c } = solveExpoAC(min, max, k);
  const out: Params = { ...params, k, a, c };
  delete out.d;
  return out;
}

export function solveExpoInverted(min: number, max: number, params: Params): Params {
  const k = params.k ?? 4;
  const { a, c } = solveExpoInvertedAC(min, max, k);
  const out: Params = { ...params, k, a, c };
  delete out.d;
  return out;
}

/* -------------------------------------------------------------------------- */
/* Presets                                                                     */
/* -------------------------------------------------------------------------- */

/** Shared by all three channels. Each channel prepends its own "flat" variant. */
const SHARED_PRESETS: Preset[] = [
  {
    id: 'linear',
    label: 'Linear',
    equation: 'y = mx + c',
    params: [
      { name: 'm', label: 'm', default: -88.25, min: -150, max: 150, step: 0.1 },
      { name: 'c', label: 'c', default: 99.8, min: 0, max: 120, step: 0.1 },
    ],
    evaluate: (x, p) => (p.m ?? 0) * x + (p.c ?? 0),
  },
  {
    id: 'gaussian',
    label: 'Gaussian',
    equation: 'y = a · e^(−(kx − d)²) + c',
    params: [
      { name: 'a', label: 'a', default: 84, min: 0, max: 100, step: 0.1 },
      { name: 'k', label: 'k', default: 8, min: 0.5, max: 24, step: 0.1 },
      { name: 'd', label: 'd', default: 4, min: 0, max: 24, step: 0.1 },
      { name: 'c', label: 'c', default: 15.61, min: 0, max: 100, step: 0.1 },
    ],
    evaluate: (x, p, min, max) => {
      const k = p.k ?? 8;
      const d = p.d ?? k / 2;
      const floor = Math.min(max, Math.max(min, p.c ?? min));
      const amp = p.a ?? max - floor;
      return amp * Math.exp(-Math.pow(k * x - d, 2)) + floor;
    },
  },
  {
    id: 'arctan',
    label: 'Arctan',
    equation: 'y = b · atan(kx − d) + c',
    params: [
      { name: 'b', label: 'b', default: 0, min: -80, max: 0, step: 0.1 },
      { name: 'k', label: 'k', default: 4, min: 0.5, max: 20, step: 0.1 },
      { name: 'd', label: 'd', default: 2, min: 0, max: 10, step: 0.1 },
      { name: 'c', label: 'c', default: 0, min: 0, max: 100, step: 0.1 },
    ],
    evaluate: (x, p, min, max) => {
      const k = p.k ?? 4;
      const d = p.d ?? k / 2;
      const solved = solveArctanBC(min, max, k, d);
      return (p.b ?? solved.b) * Math.atan(k * x - d) + (p.c ?? solved.c);
    },
  },
  {
    id: 'quad',
    label: 'Quad',
    equation: 'y = a(kx − d)² + c',
    params: [
      { name: 'a', label: 'a', default: -84, min: -200, max: 0, step: 0.1 },
      { name: 'k', label: 'k', default: 4, min: 0.5, max: 24, step: 0.1 },
      { name: 'd', label: 'd', default: 2, min: 0, max: 24, step: 0.1 },
      { name: 'c', label: 'c', default: 99.8, min: 0, max: 100, step: 0.1 },
    ],
    evaluate: (x, p, min, max) => {
      const k = p.k ?? 4;
      const d = p.d ?? k / 2;
      const c = p.c ?? max;
      const a = p.a ?? (min - max) / ((k - d) ** 2 || 1e-6);
      return a * Math.pow(k * x - d, 2) + c;
    },
  },
  {
    id: 'expo',
    label: 'Expo',
    equation: 'y = a · e^(kx) + c',
    params: [
      { name: 'a', label: 'a', default: -84, min: -500, max: 500, step: 0.1 },
      { name: 'k', label: 'k', default: 4, min: 0.5, max: 12, step: 0.1 },
      { name: 'c', label: 'c', default: 99.8, min: 0, max: 100, step: 0.1 },
    ],
    evaluate: (x, p, min, max) => {
      const k = p.k ?? 4;
      const solved = solveExpoAC(min, max, k);
      return (p.a ?? solved.a) * Math.exp(k * x) + (p.c ?? solved.c);
    },
  },
  {
    id: 'expo-inverted',
    label: 'Expo inverted',
    equation: 'y = a · e^(−kx) + c',
    params: [
      { name: 'a', label: 'a', default: -84, min: -500, max: 500, step: 0.1 },
      { name: 'k', label: 'k', default: 4, min: 0.5, max: 12, step: 0.1 },
      { name: 'c', label: 'c', default: 99.8, min: 0, max: 100, step: 0.1 },
    ],
    evaluate: (x, p, min, max) => {
      const k = p.k ?? 4;
      const solved = solveExpoInvertedAC(min, max, k);
      return (p.a ?? solved.a) * Math.exp(-(k * x)) + (p.c ?? solved.c);
    },
  },
];

const LIGHTNESS_PRESETS: Preset[] = [
  {
    id: 'flat',
    label: 'Flat',
    equation: 'y = l',
    params: [{ name: 'l', label: 'l', default: 50, min: 0, max: 100, step: 0.01 }],
    evaluate: (_x, p) => p.l ?? 50,
  },
  ...SHARED_PRESETS,
];

const CHROMA_PRESETS: Preset[] = [
  {
    id: 'flat',
    label: 'Flat',
    equation: 'y = c',
    params: [{ name: 'c', label: 'c', default: 0.001, min: 0, max: 0.4, step: 0.0001 }],
    evaluate: (_x, p) => p.c ?? 0.001,
  },
  ...SHARED_PRESETS,
];

const HUE_PRESETS: Preset[] = [
  {
    id: 'flat',
    label: 'Flat',
    equation: 'y = h',
    params: [{ name: 'h', label: 'h', default: 286.4, min: 0, max: 360, step: 0.1 }],
    evaluate: (_x, p) => p.h ?? 286.4,
  },
  ...SHARED_PRESETS,
];

const byId = (list: Preset[]) =>
  Object.fromEntries(list.map((p) => [p.id, p])) as Record<PresetId, Preset>;

export const PRESETS: Record<Channel, Record<PresetId, Preset>> = {
  l: byId(LIGHTNESS_PRESETS),
  c: byId(CHROMA_PRESETS),
  h: byId(HUE_PRESETS),
};

export const PRESET_LIST: Record<Channel, Preset[]> = {
  l: LIGHTNESS_PRESETS,
  c: CHROMA_PRESETS,
  h: HUE_PRESETS,
};

export function getPreset(channel: Channel, id: PresetId): Preset | undefined {
  return PRESETS[channel][id];
}

/* -------------------------------------------------------------------------- */
/* Public helpers                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Starting parameters for a preset, solved against the channel's min/max so the
 * ramp keeps its endpoints when the user switches curve.
 */
export function defaultParams(
  preset: PresetId,
  channel: Channel,
  min: number,
  max: number,
): Params {
  const def = getPreset(channel, preset);
  if (!def) return {};

  const params: Params = {};
  for (const spec of def.params) params[spec.name] = spec.default;

  switch (preset) {
    case 'linear':
      params.m = min - max;
      params.c = max;
      break;
    case 'arctan':
      Object.assign(params, solveArctan(min, max, params));
      break;
    case 'gaussian':
      Object.assign(params, solveGaussian(min, max, params));
      break;
    case 'quad':
      Object.assign(params, solveQuad(min, max, params));
      break;
    case 'expo':
      Object.assign(params, solveExpo(min, max, params));
      break;
    case 'expo-inverted':
      Object.assign(params, solveExpoInverted(min, max, params));
      break;
    case 'flat':
      if (channel === 'l') params.l = (min + max) / 2;
      if (channel === 'c') params.c = max;
      if (channel === 'h') params.h = min;
      break;
  }

  return params;
}

/** Evaluate one channel at position x, clamped to [min, max] for non-flat curves. */
export function evaluateChannel(
  channel: Channel,
  preset: PresetId,
  params: Params,
  min: number,
  max: number,
  x: number,
): number {
  const def = getPreset(channel, preset);
  if (!def) return min;
  const y = def.evaluate(x, params, min, max);
  return preset === 'flat' ? y : Math.min(max, Math.max(min, y));
}
