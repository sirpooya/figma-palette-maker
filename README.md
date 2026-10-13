# Manshur Theme Builder (figma-palette-maker)

The color generation engine behind [sds.sallee.design/palette-maker](https://sds.sallee.design/palette-maker),
extracted from the shipped bundle and rewritten as a readable, dependency-free TypeScript
module you can drop into a Figma plugin.

Verified against the original: the default 16 stop ramp matches the live site's output
exactly, and every curve function is diff-tested against the original minified code.

The plugin has two tools:

- **Curves**: the palette maker port. Three OKLCH curves produce a ramp of any length.
- **Brand**: a [Digikala Design System](https://assets.alamut.digikala.com/llms.txt) theme
  generator. It starts with a built-in Starter recipe (the same numbers as
  [recipes/dds.json](recipes/dds.json), reverse-engineered from the 20 brand themes already
  in the DDS, but named neutrally), or import your own; pick a primary and a secondary
  color, and it derives every DDS theme slot. See
  [Brand themes (DDS)](#brand-themes-dds).

## Run it in Figma

Needs [pnpm](https://pnpm.io) and [Bun](https://bun.sh). pnpm installs the packages; the
build script and the tests run on Bun (`Bun.build` bundles both sides).

```
pnpm install
pnpm build          # writes dist/code.js and dist/ui.html
```

Then in the Figma desktop app: **Plugins > Development > Import plugin from manifest**,
and pick `manifest.json` in this folder. It shows up under Plugins > Development >
Manshur Theme Builder.

The window is resizable by dragging its right edge, bottom edge, or bottom-right
corner. There is no grip icon; the edges just change the cursor. Figma exposes no native
window resizing and no resize event, so the iframe edges drive `figma.ui.resize()`
directly. The size you leave it at is remembered for next time, and the layout is fluid
from 260px up: the curve parameters go one per row when narrow and two-up when there is
room, and labels stack above their controls below 320px.

While iterating:

```
pnpm dev            # rebuilds dist/ on every save, unminified
```

Figma reloads the plugin each time you open it, so a save plus reopen is the loop. In the
plugin window, cmd-alt-P reruns the last plugin.

## Tests

```
pnpm typecheck      # UI and sandbox checked separately, sandbox without the DOM lib
pnpm test           # golden + differential + sweep + brand
pnpm test:ui        # builds, then drives dist/ui.html in a real DOM
pnpm test:all       # all of the above
```

| Test | What it proves |
| --- | --- |
| `test/golden.ts` | all 16 default stops match the live site's rendered output |
| `test/differential.ts` | 4784 comparisons against the original minified functions, 0 mismatches |
| `test/sweep.ts` | 1372 preset combinations produce no NaN and no malformed hex |
| `test/ui-smoke.ts` | the built UI renders, sliders drive the ramp, the Brand tool starts on the Starter recipe, recipe import/export and loading from a URL work, the strip dots edit the recipe, buttons post the right messages |
| `test/brand.ts` | step numbers match the DDS names, the recipe reproduces the DDS themes, on-colors match all 40 bases, `recipes/dds.json` still equals a fresh fit of the fixture, and recipe files round-trip and refuse bad input |

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

## Brand themes (DDS)

### What a DDS theme is

The DDS `theme` token group (the `🌈 Theme` collection in the DDS Core Figma file, one mode
per brand) holds 21 variables:

| Group | Variables |
| --- | --- |
| `primary` | `primary-tint-1`, `primary-tint-2`, `primary-tint-3`, `primary-gradient`, `primary-base`, `primary-shade-2`, `primary-shade-1`, `primary-base-alpha-12`, `on-primary` |
| `secondary` | `secondary-tint-1`, `secondary-tint-2`, `secondary-base`, `secondary-base-alpha-12`, `secondary-shade-1`, `on-secondary` |
| `tertiary` | `tertiary-tint-1`, `tertiary-tint-2`, `tertiary-base`, `tertiary-shade-1`, `on-tertiary` |
| root | `theme`, the brand's display name |

In the DDS every slot aliases a Core primitive such as `core/color/brand/shop/pomegranate-62`,
and the `🌓 Mode` layer swaps slots for dark mode: `tint-1` and `shade-1` trade places as the
brand surface, `tint-3` and `shade-2` as the secondary tone. Tertiary is the same set of
neutrals in every brand.

### Step numbers

The number in a DDS color name is its darkness:

```
step = round(100 × (1 − luma))      luma = (0.299 R + 0.587 G + 0.114 B) / 255
```

That is Rec. 601 luma on the gamma-encoded channels, not OKLab or CIE lightness. It is exact
for every neutral (`neutral-48` is `#848484`) and within 1 for 125 of the 147 named colors;
the misses are colors that were edited after they were named.

### The recipe

Tints mix the base with white and shades mix it with black, in gamma-encoded sRGB, which is
the same as stacking the color at some opacity over white or black. Luma is linear in those
channels, so a mix moves the step number predictably. "Lighten to step n" means mix with
white until the step reaches n; a base that is already lighter is used as is, which is what
the DDS does when it collapses a slot onto the base.

| Slot | Rule |
| --- | --- |
| `primary-tint-1` | lighten to step 3 |
| `primary-tint-2` | base + 88% white, which is the alpha-12 color flattened onto white |
| `primary-tint-3` | lighten to step 21 |
| `primary-gradient` | the base, as in 12 of the 20 brands |
| `primary-base` | the input color |
| `primary-shade-2` | base + 20% black |
| `primary-shade-1` | base + 55% black |
| `secondary-tint-1` | lighten to step 4 |
| `secondary-tint-2` | base + 68% white |
| `secondary-shade-1` | base + 41% black |
| `*-base-alpha-12` | the base at 12% opacity |
| `on-*` | white when white on the base reaches 2:1 contrast, otherwise `#0A0A0A` (neutral-96) |
| `tertiary-*` | with the tertiary left empty (or set to `#333333`, the DDS tertiary base), the exact DDS neutrals `#ECEDEF`, `#848484`, `#333333`, `#0A0A0A` and white; any other tertiary color lightens to steps 7 and 48 and darkens to step 96, the steps of the neutral set |

Slots never pass each other: if a light base would put a fixed-mix tint lighter than a
fixed-step one (12% of a step-15 base is lighter than step 3), the slot takes its lighter
neighbour's color instead, the way the DDS collapses slots.

### How the recipe was derived

`scripts/fit-recipe.ts` reads the DDS themes from `test/fixtures/dds-themes.json` and drops
every slot that reuses another slot's color, since a collapsed slot says nothing about the
recipe. For each remaining slot it compares two models, a fixed step target and a fixed mix
amount, by leave-one-brand-out cross-validation, and keeps the one that best predicts the
brand it was not fitted on.

```
slot               n   step model (fit / cv dE)   mix model (fit / cv dE)   chosen
primary/tint-1      8   step 3    0.9 /  0.9       mix 94%   1.0 /  1.3      step 3
primary/tint-2      6   step 6    2.1 /  2.5       mix 88%   2.1 /  2.4      mix 88%
primary/tint-3     12   step 21   6.0 /  6.0       mix 64%   6.2 /  7.7      step 21
primary/shade-2     6   step 70   9.0 / 13.2       mix 20%   4.5 /  4.7      mix 20%
primary/shade-1     7   step 84   8.3 /  8.6       mix 55%   6.4 /  7.3      mix 55%
secondary/tint-1   15   step 4    2.0 /  2.0       mix 93%   2.0 /  2.0      step 4
secondary/tint-2   14   step 20   8.4 /  8.4       mix 68%   7.8 /  7.9      mix 68%
secondary/shade-1  12   step 77  11.8 / 12.5       mix 41%  10.7 / 12.1      mix 41%
```

- The surface tints (primary tint-1, secondary tint-1) and the light text tone (tint-3) are
  best explained by fixed steps: they look equally light whatever the hue.
- Primary tint-2 is a fixed 12% of the base on white, the same color as `base-alpha-12`
  flattened onto a white surface. Secondary tint-2 is a fixed mix too.
- The shades are fixed mixes: the base, darker by a set share of black.
- The script also tries amounts that depend on the base, on its lightness or on its warmth
  (a term that peaks at yellow), cross-validated the same way. Neither beats the fixed rule
  on any slot; the closest is a tie on shade-2. So there is no special case for yellow. A
  yellow base simply sits at a low step (super-coin's base is step 28, shop's is 63), and
  the same recipe lands on very different step numbers.
- The on-color threshold sits between super-coin (1.93:1, dark text) and jet's secondary
  (2.18:1, white text), so it matches all 40 bases. That is the DDS's own choice; WCAG text
  contrast asks for 4.5:1.

How close it gets, as mean ΔE (OKLab × 100, where about 2 is the visible threshold) against
the hand-picked tokens: tint-1 0.9, primary tint-2 2.1, secondary tint-1 2.0, shade-2 4.5,
tint-3 6.0, shade-1 6.4, secondary tint-2 7.8 and secondary shade-1 10.7. The larger numbers
are where the brands disagree with each other: shop's tint-3 is step 35 and plus's is 20.
Every rule stays editable (drag its dot on the strips) for a brand that wants to deviate,
the way super-coin keeps its shades lighter than the recipe.

### What the plugin writes

**Create variables** writes a single theme layer, without Core primitives: a collection named
after the brand, holding the 21 variables above named exactly as in the DDS
(`primary/primary-tint-1`, `theme` and so on), with raw color values in a mode of the same
name. Running it again for the same brand updates that collection; a different brand name
gets its own collection. One mode per collection also means it works on Figma's free plan,
which allows a single mode.

**Create documentation** draws a token sheet on the current page: each group's slots from
light to dark with step and hex, then a table of every variable with its usage. When the
theme variables exist, the swatches are bound to them, so the sheet follows later edits.

In the plugin window, the **Brand** tool starts on the built-in Starter recipe, with no
colors. At the top, Primary, Secondary and Tertiary sit side by side as Figma-style color
fields (swatch inside, hex without the `#`; typing or pasting with it works too), with Name
below them. Empty fields show `Brand`, `ED1944`, `1672DD` and `333333` as placeholders and use them as values, so a theme shows on first open. Creating needs a typed name, since the collection is named after it; until one is typed the Create buttons look disabled, and clicking one shows a Figma toast and puts the cursor in Name.
An imported recipe replaces the Starter and is kept in the plugin's storage on that computer
(`figma.clientStorage`), so it is still there next time. Then fill in a primary, a secondary
and a name.

Below the fields, one scrolling panel holds everything else, with no tabs. First the recipe:
**Reset**, **Clear**, **Import**, **URL** and **Export** on its heading row (Reset is always shown and
live after an edit, returning to the loaded recipe; Clear removes the recipe entirely, and the
empty panel then offers **Import recipe**, **Load URL** and **Use starter**), then one column of equal rows, each with its label on
top and a full-width bar below: a strip per group
showing its white → base → black spectrum with a dot on every slot, then **On-color** (the
contrast ratio from which on-colors turn white, on a plain bar) and **Alpha** (the opacity of
the `base-alpha-12` slots, starting from the recipe's `alpha`, shown as neutral black fading
in over a checkerboard), drawn the same way with their value printed in the bar. The dots are
the recipe's controls: drag one along its strip (or focus it and use the arrow keys, Shift
for 10 steps) to move that tint or shade, and the strip's label reads out the rule while you
do. The base dot is your color and does not move; a tertiary left on the recipe's fixed set
has no handles. Under the recipe, the theme it produces: the 20 color variables with value
and step, updating live, with **Copy JSON** on its heading row (the theme in the DDS tokens
shape).

### Recipe files

The recipe is data. The plugin bundles only the Starter (`src/starter.ts`); every number and
every fixed color comes from the recipe in use. The DDS one is [recipes/dds.json](recipes/dds.json);
**Import** / **Export** on the Recipe tab read and write this format:

```json
{
  "format": "manshur-theme-recipe",
  "version": 1,
  "name": "DDS fit",
  "primary": {
    "tint-1": { "step": 3 },
    "tint-2": { "white": 88 },
    "tint-3": { "step": 21 },
    "shade-2": { "black": 20 },
    "shade-1": { "black": 55 }
  },
  "secondary": { "tint-1": { "step": 4 }, "tint-2": { "white": 68 }, "shade-1": { "black": 41 } },
  "tertiary": { "tint-1": { "step": 7 }, "tint-2": { "step": 48 }, "shade-1": { "step": 96 } },
  "onContrast": 2,
  "onDark": "#0A0A0A",
  "alpha": 12,
  "tertiaryDefault": {
    "base": "#333333",
    "tint-1": "#ECEDEF",
    "tint-2": "#848484",
    "shade-1": "#0A0A0A",
    "on": "#FFFFFF"
  }
}
```

Each slot takes exactly one rule: `step` (lighten or darken to that DDS step, 0 to 100),
`white` for a tint or `black` for a shade (the share mixed in, in percent). `onContrast` is
the contrast ratio from which on-colors turn white, `onDark` the on-color below it, `alpha`
the opacity of the `base-alpha-12` slots in percent. `tertiaryDefault` is the fixed tertiary
used when no tertiary color is picked; without it, a tertiary color is required. `name` (shown in the
**Reset** button's tooltip) and `description` are optional, and so are `format` and `version` in
a hand-written file. Import is all or nothing: a file with a missing,
misspelled or out-of-range slot is refused with the reason, and the current recipe stays.

**URL** loads the same format from a JSON endpoint instead of a file: type the address, press
Enter or **Load**. It goes through the same strict parse, and the last address is remembered.
The manifest allows any host (`allowedDomains: ["*"]`). The endpoint must send
`Access-Control-Allow-Origin: *`, because the plugin iframe's origin is `null`. Only the GET for
the recipe goes out; nothing from the document is sent.

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

The brand engine works the same way:

```ts
import { generateBrandTheme, parseRecipe } from './src/brand';

const recipe = parseRecipe(await Bun.file('recipes/dds.json').text());
const theme = generateBrandTheme({ name: 'Shop', primary: '#ED1944', secondary: '#1672DD' }, recipe);

theme.slots[0];
// {
//   group: 'primary', part: 'tint-1', key: 'primary-tint-1', name: 'primary/primary-tint-1',
//   usage: 'Container and hint backgrounds, in effect a surface. ...',
//   hex: '#FEF4F6', step: 3,            // the DDS's own shop tint-1 is #FEF5F7
//   rgb: { r: 0.996, g: 0.957, b: 0.965, a: 1 },
// }

// In the sandbox: one theme layer, and a token sheet bound to it.
import { writeBrandTheme, paintBrandDoc } from './src/figma';
await writeBrandTheme(theme);                 // collection "Shop", mode "Shop"
const { frame: sheet } = await paintBrandDoc(theme);
```

## Files

The engine, platform-agnostic and dependency-free:

| File | Contents |
| --- | --- |
| [src/oklch.ts](src/oklch.ts) | OKLab/OKLCH/sRGB conversions, gamut mapping, hex and OKLCH formatting |
| [src/curves.ts](src/curves.ts) | The seven presets, their parameter specs, and the solvers |
| [src/palette.ts](src/palette.ts) | Config types, token numbering, `generatePalette`, CSS/JSON export |
| [src/brand.ts](src/brand.ts) | DDS brand themes: step numbers, recipe files, `generateBrandTheme` |
| [recipes/dds.json](recipes/dds.json) | The DDS recipe, fitted to the DDS brand themes; import it in the plugin (not bundled) |
| [src/starter.ts](src/starter.ts) | The built-in Starter recipe (same numbers as `recipes/dds.json`, neutral name) |
| [src/index.ts](src/index.ts) | Re-exports the engine (not `figma.ts`) |

The plugin around it:

| File | Contents |
| --- | --- |
| [manifest.json](manifest.json) | Figma manifest. `documentAccess: dynamic-page`, network access to any host for recipe URLs |
| [plugin/code.ts](plugin/code.ts) | Sandbox entry: handles messages, persists config in clientStorage |
| [plugin/ui/main.ts](plugin/ui/main.ts) | UI iframe: controls, live preview, export panel |
| [plugin/ui/index.html](plugin/ui/index.html) | UI shell and CSS: Figma UI3 tokens and control metrics over Figma's color variables, fluid, invisible resize edges |
| [plugin/messages.ts](plugin/messages.ts) | The typed message contract between the two sides |
| [src/figma.ts](src/figma.ts) | Figma paints, variables, canvas swatches, the brand theme layer and its documentation sheet |
| [scripts/build.ts](scripts/build.ts) | Bundles both sides into `dist/`, with `--watch` |
| [scripts/fit-recipe.ts](scripts/fit-recipe.ts) | Refits the brand recipe from the DDS fixture and prints the cross-validation table; `--write` rewrites `recipes/dds.json` |
| [scripts/dds-fixture.ts](scripts/dds-fixture.ts) | Rebuilds `test/fixtures/dds-themes.json` from the DDS tokens API (needs network) |

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

`dist/` is gitignored. Anyone cloning this needs `pnpm install && pnpm build` before
importing the manifest.

## Notes on provenance

The original tool is by [Jeremy Sallée](https://sallee.design). Its color pipeline is
culori under the hood, and the OKLab matrices here are culori's exact coefficients so
output is bit-identical. Nothing from the original UI was copied, only the math needed to
reproduce the ramps. If you ship this publicly, credit is the decent thing to do.

`test/fixtures/original-curves.mjs` holds the original minified curve functions, used only
as a test oracle. It is not part of the shipped code.

`test/fixtures/dds-themes.json` holds the DDS core colors and brand themes, taken from
`https://assets.alamut.digikala.com/api/tokens` (the file records the commit it came from).
It is the oracle the brand recipe is fitted and tested against, not shipped either. Refresh
it with `bun scripts/dds-fixture.ts`, then run `bun scripts/fit-recipe.ts --write` to
refit `recipes/dds.json` against it.
