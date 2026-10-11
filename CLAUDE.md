# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Figma/FigJam plugin "Palette Maker" with two tools: **Curves**, an OKLCH color ramp
generator ported from sds.sallee.design/palette-maker, and **Brand**, a Digikala Design
System (DDS) theme generator whose formula is reverse-engineered from the DDS's own brand
themes. README.md has the full math write-up for both.

## Tooling

pnpm installs packages (never npm, yarn or `bun install`; `pnpm-lock.yaml` is the only
lockfile). Bun is the runtime: `scripts/build.ts` uses `Bun.build`, and the tests are plain
Bun scripts. So both pnpm and bun must be on PATH.

```
pnpm install
pnpm build            # dist/code.js + dist/ui.html, minified
bun scripts/build.ts --no-minify   # one-shot, unminified
pnpm dev              # watch src/, plugin/, manifest.json; unminified; survives syntax errors
pnpm typecheck        # two passes: tsconfig.json (DOM) and tsconfig.sandbox.json (no DOM)
pnpm test             # golden + differential + sweep + brand
pnpm test:ui          # builds first, then smoke-tests dist/ui.html under happy-dom
pnpm test:all         # everything above
bun test/golden.ts    # run one test file
bun test/example.ts   # print sample ramps as ANSI blocks, eyeball check
bun scripts/fit-recipe.ts    # refit the brand recipe from the DDS fixture, print the CV table
bun scripts/dds-fixture.ts   # refresh test/fixtures/dds-themes.json from the DDS API (network)
```

Tests are standalone scripts that print pass/FAIL and exit non-zero on failure. They are
not `bun test` runner suites, so do not add `describe`/`it`.

Load in Figma: Plugins > Development > Import plugin from manifest > `manifest.json`.
`dist/` is gitignored and must be built first.

## Architecture

Three layers, with a hard boundary between the two Figma runtimes:

- **Engine (`src/oklch.ts`, `src/curves.ts`, `src/palette.ts`)**: pure, dependency-free,
  runs anywhere. `generatePalette(config)` evaluates three independent curves (L, C, H)
  over `x = i / (stops - 1)`, gamut maps each OKLCH color into sRGB by chroma reduction
  (CSS Color 4 algorithm), rounds to 8 bits, then reads the OKLCH label back off the
  rounded value. Curve presets each have a solver that derives params from a min/max pair
  (`reanchorChannel`), which is why switching presets keeps the ramp's endpoints fixed.
- **Brand engine (`src/brand.ts`)**: also pure. `generateBrandTheme(input, recipe)` turns
  a primary, secondary and optional tertiary/gradient color into the 20 DDS theme slots.
  Tints and shades are mixes with white/black in gamma-encoded sRGB, and the DDS step number
  is `round(100 × (1 − Rec.601 luma))`, so "lighten to step n" solves the mix in closed form.
  The constants live in `DDS_RECIPE`.
- **Sandbox (`plugin/code.ts` + `src/figma.ts`)**: the only code that touches the
  document and `figma.*`. Creates swatch frames, upserts variables by name into a
  collection (finds existing collection, mode and variables before creating), writes the
  brand theme layer and draws its documentation sheet, and persists config and window size
  in `clientStorage` (failures swallowed on purpose).
- **UI iframe (`plugin/ui/main.ts` + `plugin/ui/index.html`)**: a Curves / Brand tool
  switch, controls, live preview and export. Runs the same engines locally, so preview and
  canvas output are identical.

The two sides talk only through the typed union in `plugin/messages.ts` (`UiToPlugin`,
`PluginToUi`). Adding a feature that crosses the boundary means extending that contract
and handling it in both `code.ts`'s switch and `main.ts`'s `window.onmessage`.

Rules that follow from the boundary:

- `src/figma.ts` is deliberately not re-exported from `src/index.ts`. Never import it from
  the UI side.
- Sandbox code must not use DOM APIs. `tsconfig.sandbox.json` drops the DOM lib to enforce
  this, so run `pnpm typecheck` (both passes) after touching sandbox files.

### Brand themes

- Variable names, groups and order must match the DDS `🌈 Theme` collection exactly:
  `primary/primary-tint-1` ... `primary/on-primary` (9), `secondary/...` (6),
  `tertiary/...` (5), plus the root `theme` string. The DDS Core Figma file is
  `LIxcZCIshqMTCD42AQm69S` if the structure ever needs re-checking.
- The plugin writes one theme layer with raw color values and no Core primitives (the
  user's call, 2026-10-11). Do not add a Core collection or aliases without asking.
- Never hand-tune `DDS_RECIPE`. The constants are fitted by `scripts/fit-recipe.ts` from
  `test/fixtures/dds-themes.json`, and `test/brand.ts` fails when the two disagree. The fit
  found no hue dependence (yellow included), so do not add hue special cases either.
- Step numbers use Rec. 601 luma on gamma-encoded channels. OKLab L or CIE L* give the
  wrong numbers.
- The UI's tool switch (`#tool`, `.tool` buttons) sits above the per-tool tab strip
  (`#tabs`, `.tab`); tests select tabs as `#tabs .tab`. Brand settings and the last tool
  persist under the `palette-maker:brand` and `palette-maker:tool` clientStorage keys, and
  `restoreBrand` fills gaps in settings saved by older builds.

### Build

Figma needs exactly two self-contained files. `scripts/build.ts` bundles both entries as
browser IIFEs, then splices the UI bundle into `plugin/ui/index.html` at the
`/*__APP_JS__*/` marker (with split/join, not `replace`, because bundles contain `$&`).
Do not remove that marker or add a separate `ui.js`.

### Window resizing

Figma has no native resize, so invisible edge handles in the UI post `resize` messages
continuously; the sandbox calls `figma.ui.resize()` and saves the size only when
`commit` is true (drag end). Minimum size is 260x320, and the layout is fluid down to it.
The UI uses Figma UI3 token names and control metrics (taken from figma-variable-studio's
mirrored `figma.css`), each color reading Figma's injected `--figma-color-*` first
(`themeColors: true`) with Figma's light/dark ramp hex as fallback. Sliders paint their
fill from a `--fill` percentage set in `sliderRow`.

## Correctness guards

The engine must stay bit-identical to the original tool:

- `test/golden.ts` holds the 16 OKLCH strings scraped from the live site at default
  settings. A diff here means the math changed, not that the fixture is stale.
- `test/differential.ts` compares the port's curves and solvers against the original
  minified functions in `test/fixtures/original-curves.mjs` (a test oracle only, never
  shipped).
- The OKLab matrices are culori's exact coefficients. Do not "clean up" the constants.
- `test/brand.ts` checks the brand engine against the DDS itself (`test/fixtures/dds-themes.json`):
  step numbers against the DDS color names, the recipe against every brand's hand-picked
  slots, on-colors against all 40 bases, and `DDS_RECIPE` against a fresh fit.

`manifest.json` declares no network access; keep it that way.
