# figma-palette-maker

The color generation engine behind [sds.sallee.design/palette-maker](https://sds.sallee.design/palette-maker),
extracted from the shipped bundle and rewritten as a readable, dependency-free TypeScript
module you can drop into a Figma plugin.

Verified against the original: the default 16 stop ramp matches the live site's output
exactly, and every curve function is diff-tested against the original minified code.

## Run it in Figma

```
bun install
bun run build          # writes dist/code.js and dist/ui.html
```

Then in the Figma desktop app: **Plugins > Development > Import plugin from manifest**,
and pick `manifest.json` in this folder. It shows up under Plugins > Development >
Palette Maker.

The window is resizable by dragging its right edge, bottom edge, or bottom-right
corner. There is no grip icon; the edges just change the cursor. Figma exposes no native
window resizing and no resize event, so the iframe edges drive `figma.ui.resize()`
directly. The size you leave it at is remembered for next time, and the layout is fluid
from 260px up: the curve parameters go one per row when narrow and two-up when there is
room, and labels stack above their controls below 320px.

While iterating:

```
bun run dev            # rebuilds dist/ on every save, unminified
```

Figma reloads the plugin each time you open it, so a save plus reopen is the loop. In the
plugin window, cmd-alt-P reruns the last plugin.

## Tests

```
bun run typecheck      # UI and sandbox checked separately, sandbox without the DOM lib
bun run test           # golden + differential + sweep
bun run test:ui        # builds, then drives dist/ui.html in a real DOM
bun run test:all       # all of the above
```

| Test | What it proves |
| --- | --- |
| `test/golden.ts` | all 16 default stops match the live site's rendered output |
| `test/differential.ts` | 4784 comparisons against the original minified functions, 0 mismatches |
| `test/sweep.ts` | 1372 preset combinations produce no NaN and no malformed hex |
| `test/ui-smoke.ts` | the built UI renders, sliders drive the ramp, buttons post the right messages |

## How the math works

A palette is three independent curves over `x`, the stop's normalized position from 0 to 1:

```
x    = i / (stops - 1)
L%   = curve_l(x)   clamped to [l.min, l.max]
C    = curve_c(x)   clamped to [c.min, c.max]
H    = curve_h(x)   clamped to [h.min, h.max]
```

Then `oklch(L% C H)` is gamut mapped into sRGB, rounded to 8 bits per channel, and the
displayed OKLCH string is read back off that rounded value. So the label always describes
the color the hex actually produces, not the mathematical ideal.

### The curves

Seven presets, available on all three channels. Each is authored so `y(0) = max` and
`y(1) = min`, meaning ramps run light to dark, with `quad` and `gaussian` as the exceptions
(bells that peak mid-ramp).

| Preset | Equation | Shape |
| --- | --- | --- |
| `flat` | `y = k` | constant, the usual choice for hue |
| `linear` | `y = mx + c` | straight |
| `gaussian` | `y = a·e^(−(kx − d)²) + c` | bell peaking at `x = d/k` |
| `arctan` | `y = b·atan(kx − d) + c` | S-curve, the default for lightness |
| `quad` | `y = a(kx − d)² + c` | parabola peaking at `x = d/k` |
| `expo` | `y = a·e^(kx) + c` | fast at the dark end |
| `expo-inverted` | `y = a·e^(−kx) + c` | fast at the light end |

The interesting part is the **solvers**. Each preset can derive its own parameters from a
min/max pair, so when you change a curve or drag an endpoint the ramp stays anchored:

- `arctan` solves `b = (min − max) / (atan(k − d) − atan(−d))`, `c = max − b·atan(−d)`
- `expo` solves `a = (min − max) / (e^k − 1)`, `c = max − a`
- `quad` solves `a = (min − max) / (k − d)²`, `c = max`
- `gaussian` sets the floor to `min` and amplitude to `max − min`

That is why the UI can switch curves without the palette jumping around: only the shape
between the endpoints changes.

### Gamut mapping

`oklch(62% 0.20 286)` is inside sRGB, `oklch(62% 0.32 286)` is not. Naive clipping shifts
hue, so this uses the CSS Color 4 algorithm (the same one culori implements):

1. `L >= 1` returns white, `L <= 0` returns black
2. if the color is already in gamut, convert directly
3. otherwise binary search chroma downward, accepting a channel-clipped candidate as soon
   as it lands within 0.02 deltaEOK of the target

This matters for a Figma plugin because Figma paints are sRGB. The wide-gamut OKLCH values
have to be mapped somewhere, and doing it by chroma reduction keeps the hue of the ramp
consistent even where the requested chroma is unreachable.

### Token numbering

```
tokenStart = 1     ->  1, 2, 3, 4 ...
tokenStart = 50    ->  50, 100, 200, 300 ...
tokenStart = n*100 ->  n, n+100, n+200 ...
otherwise          ->  n, n+1, n+2 ...
```

## Using the engine directly

```ts
import { defaultConfig, generatePalette, reanchorChannel } from './src/palette';

const stops = generatePalette({
  ...defaultConfig(),
  stops: 12,
  h: reanchorChannel('h', 'flat', 24, 24),   // orange ramp
  c: reanchorChannel('c', 'gaussian', 0, 0.19), // chroma peaks in the middle
});

stops[0];
// {
//   token: 50, l: 100, c: 0.2, h: 24,
//   hex: '#FFFFFF',
//   oklch: 'oklch(100.00% 0.000 24)',
//   rgb: { r: 1, g: 1, b: 1, a: 1 },
// }
```

`stop.rgb` is already 0..1, which is what Figma wants:

```ts
import { solidPaint, writeVariables, paintSwatchRow } from './src/figma';

rect.fills = [solidPaint(stops[8])];

await writeVariables(stops, {
  collectionName: 'Core',
  groupName: 'brand/orange',
  modeName: 'Value',
});

const frame = await paintSwatchRow(stops);
figma.currentPage.appendChild(frame);
```

## Files

The engine, platform-agnostic and dependency-free:

| File | Contents |
| --- | --- |
| [src/oklch.ts](src/oklch.ts) | OKLab/OKLCH/sRGB conversions, gamut mapping, hex and OKLCH formatting |
| [src/curves.ts](src/curves.ts) | The seven presets, their parameter specs, and the solvers |
| [src/palette.ts](src/palette.ts) | Config types, token numbering, `generatePalette`, CSS/JSON export |
| [src/index.ts](src/index.ts) | Re-exports the engine (not `figma.ts`) |

The plugin around it:

| File | Contents |
| --- | --- |
| [manifest.json](manifest.json) | Figma manifest. `documentAccess: dynamic-page`, no network access |
| [plugin/code.ts](plugin/code.ts) | Sandbox entry: handles messages, persists config in clientStorage |
| [plugin/ui/main.ts](plugin/ui/main.ts) | UI iframe: controls, live preview, export panel |
| [plugin/ui/index.html](plugin/ui/index.html) | UI shell and CSS: themed off Figma's color variables, fluid, invisible resize edges |
| [plugin/messages.ts](plugin/messages.ts) | The typed message contract between the two sides |
| [src/figma.ts](src/figma.ts) | Figma paints, variables, canvas swatches |
| [scripts/build.ts](scripts/build.ts) | Bundles both sides into `dist/`, with `--watch` |

`src/figma.ts` is deliberately left out of `index.ts` because it touches the `figma`
global. Import it only from the plugin sandbox entry, never from the UI iframe. The two
sides are typechecked with separate configs so sandbox code cannot accidentally reach for
`document`.

## How the build works

Figma wants exactly two files: one self-contained JS for the sandbox and one
self-contained HTML for the UI. So the build bundles `plugin/ui/main.ts` and splices it
into `plugin/ui/index.html` at the `/*__APP_JS__*/` marker, which is why there is no
separate `ui.js` in `dist/`. The engine gets bundled into both sides, which costs a couple
of kb and buys you the same palette math in the preview and on the canvas.

`dist/` is gitignored. Anyone cloning this needs `bun install && bun run build` before
importing the manifest.

## Notes on provenance

The original tool is by [Jeremy Sallée](https://sallee.design). Its color pipeline is
culori under the hood, and the OKLab matrices here are culori's exact coefficients so
output is bit-identical. Nothing from the original UI was copied, only the math needed to
reproduce the ramps. If you ship this publicly, credit is the decent thing to do.

`test/fixtures/original-curves.mjs` holds the original minified curve functions, used only
as a test oracle. It is not part of the shipped code.
