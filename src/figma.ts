/**
 * Figma-side helpers. Import these only from the plugin's sandbox code
 * (the file that has access to the `figma` global), never from the UI iframe.
 */

import {
  BRAND_GROUPS,
  BRAND_LIGHT_TO_DARK,
  BrandSlot,
  BrandTheme,
  THEME_NAME_VARIABLE,
  parseHex,
  spectrum,
  stepLabel,
} from './brand';
import { PaletteStop } from './palette';

/** A generated stop as a Figma solid paint. */
export function solidPaint(stop: PaletteStop): SolidPaint {
  return {
    type: 'SOLID',
    color: { r: stop.rgb.r, g: stop.rgb.g, b: stop.rgb.b },
    opacity: stop.rgb.a,
  };
}

export interface WriteVariablesOptions {
  /** Variable collection name, e.g. "Core". Reused if it already exists. */
  collectionName: string;
  /** Variable group / prefix, e.g. "gray" or "brand/primary". */
  groupName: string;
  /** Mode name to write into. Renames the default mode when the collection is new. */
  modeName?: string;
}

/**
 * Write a ramp into Figma variables as `groupName/token` color variables.
 * Existing variables with the same name are updated instead of duplicated.
 */
export async function writeVariables(
  stops: PaletteStop[],
  options: WriteVariablesOptions,
): Promise<VariableCollection> {
  const { collectionName, groupName, modeName } = options;

  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  let collection = collections.find((c) => c.name === collectionName);
  if (!collection) {
    collection = figma.variables.createVariableCollection(collectionName);
    if (modeName) collection.renameMode(collection.modes[0].modeId, modeName);
  }

  const mode = modeName
    ? collection.modes.find((m) => m.name === modeName) ?? collection.modes[0]
    : collection.modes[0];

  const existing = (await figma.variables.getLocalVariablesAsync('COLOR')).filter(
    (v) => v.variableCollectionId === collection!.id,
  );

  for (const stop of stops) {
    const name = `${groupName}/${stop.token}`;
    const variable =
      existing.find((v) => v.name === name) ??
      figma.variables.createVariable(name, collection, 'COLOR');

    variable.setValueForMode(mode.modeId, {
      r: stop.rgb.r,
      g: stop.rgb.g,
      b: stop.rgb.b,
      a: stop.rgb.a,
    });
  }

  return collection;
}

/** Lay the ramp out on the canvas as a row of labeled swatches. */
export async function paintSwatchRow(
  stops: PaletteStop[],
  opts: { size?: number; gap?: number; label?: boolean } = {},
): Promise<FrameNode> {
  const size = opts.size ?? 96;
  const gap = opts.gap ?? 8;

  const frame = figma.createFrame();
  frame.name = 'Palette';
  frame.layoutMode = 'HORIZONTAL';
  frame.itemSpacing = gap;
  frame.paddingTop = frame.paddingBottom = frame.paddingLeft = frame.paddingRight = gap * 2;
  frame.primaryAxisSizingMode = 'AUTO';
  frame.counterAxisSizingMode = 'AUTO';

  if (opts.label !== false) await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });

  for (const stop of stops) {
    const cell = figma.createFrame();
    cell.name = String(stop.token);
    cell.layoutMode = 'VERTICAL';
    cell.itemSpacing = 6;
    cell.fills = [];
    cell.primaryAxisSizingMode = 'AUTO';
    cell.counterAxisSizingMode = 'AUTO';

    const swatch = figma.createRectangle();
    swatch.resize(size, size);
    swatch.cornerRadius = 8;
    swatch.fills = [solidPaint(stop)];
    cell.appendChild(swatch);

    if (opts.label !== false) {
      const text = figma.createText();
      text.fontName = { family: 'Inter', style: 'Regular' };
      text.fontSize = 11;
      text.characters = `${stop.token}\n${stop.hex}`;
      cell.appendChild(text);
    }

    frame.appendChild(cell);
  }

  return frame;
}

/* -------------------------------------------------------------------------- */
/* Brand themes                                                                */
/* -------------------------------------------------------------------------- */

const COLOR_SCOPES: VariableScope[] = ['ALL_FILLS', 'STROKE_COLOR', 'EFFECT_COLOR'];

export interface BrandWriteResult {
  collection: VariableCollection;
  addedMode: boolean;
  created: number;
  updated: number;
}

/**
 * Write a brand theme as one DDS-shaped theme layer: `primary/primary-tint-1` ... plus the
 * root `theme` string, raw values, in a mode named after the brand. The collection is named
 * after the brand too unless `collectionName` says otherwise; writing the same brand again
 * updates it in place.
 */
export async function writeBrandTheme(
  theme: BrandTheme,
  options: { collectionName?: string } = {},
): Promise<BrandWriteResult> {
  const collectionName = options.collectionName ?? theme.name;
  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  let found = collections.find((c) => c.name === collectionName);
  let addedMode = false;

  if (!found) {
    found = figma.variables.createVariableCollection(collectionName);
    found.renameMode(found.modes[0].modeId, theme.name);
    addedMode = true;
  }
  const collection = found;

  let modeId = collection.modes.find((m) => m.name === theme.name)?.modeId;
  if (!modeId) {
    try {
      modeId = collection.addMode(theme.name);
      addedMode = true;
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      throw new Error(
        `"${collection.name}" cannot take another mode (${why}). Write to a new collection name instead.`,
      );
    }
  }

  const existing = new Map(
    (await figma.variables.getLocalVariablesAsync())
      .filter((v) => v.variableCollectionId === collection.id)
      .map((v) => [v.name, v]),
  );

  let created = 0;
  let updated = 0;
  const upsert = (name: string, type: VariableResolvedDataType, setup: (v: Variable) => void) => {
    let variable = existing.get(name);
    if (variable && variable.resolvedType !== type) {
      throw new Error(`"${name}" already exists in ${collection.name} as a ${variable.resolvedType.toLowerCase()}`);
    }
    if (variable) {
      updated++;
    } else {
      variable = figma.variables.createVariable(name, collection, type);
      setup(variable);
      created++;
    }
    return variable;
  };

  for (const slot of theme.slots) {
    const variable = upsert(slot.name, 'COLOR', (v) => {
      v.scopes = COLOR_SCOPES;
      // Shared by every brand's mode, so it says what the slot is for, not its value.
      v.description = slot.usage;
    });
    variable.setValueForMode(modeId, { r: slot.rgb.r, g: slot.rgb.g, b: slot.rgb.b, a: slot.rgb.a });
  }

  const label = upsert(THEME_NAME_VARIABLE, 'STRING', (v) => {
    v.scopes = ['TEXT_CONTENT'];
  });
  label.setValueForMode(modeId, theme.name);

  return { collection, addedMode, created, updated };
}

/* Documentation sheet ------------------------------------------------------ */

const INK: RGB = { r: 0x1f / 255, g: 0x1f / 255, b: 0x1f / 255 }; // DDS neutral-88
const MUTED: RGB = { r: 0x5c / 255, g: 0x5c / 255, b: 0x5c / 255 }; // DDS neutral-64
const HAIRLINE: RGB = { r: 0xe0 / 255, g: 0xe0 / 255, b: 0xe0 / 255 }; // DDS neutral-12

const SHEET_WIDTH = 1040;
const SHEET_PAD = 48;
const CONTENT = SHEET_WIDTH - SHEET_PAD * 2;
const CELL_GAP = 12;
const CELL = Math.floor((CONTENT - CELL_GAP * 5) / 6);

type InterStyle = 'Regular' | 'Medium' | 'Semi Bold' | 'Bold';

async function loadInter(): Promise<(style: InterStyle) => FontName> {
  const loaded = new Set<InterStyle>();
  for (const style of ['Regular', 'Medium', 'Semi Bold', 'Bold'] as InterStyle[]) {
    try {
      await figma.loadFontAsync({ family: 'Inter', style });
      loaded.add(style);
    } catch {
      // A missing weight falls back to Regular below.
    }
  }
  if (!loaded.has('Regular')) throw new Error('The documentation sheet needs the Inter font');
  return (style) => ({ family: 'Inter', style: loaded.has(style) ? style : 'Regular' });
}

function stack(name: string, direction: 'VERTICAL' | 'HORIZONTAL', spacing: number): FrameNode {
  const frame = figma.createFrame();
  frame.name = name;
  frame.layoutMode = direction;
  frame.itemSpacing = spacing;
  frame.primaryAxisSizingMode = 'AUTO';
  frame.counterAxisSizingMode = 'AUTO';
  frame.fills = [];
  return frame;
}

function label(characters: string, font: FontName, size: number, color: RGB, width?: number): TextNode {
  const node = figma.createText();
  node.fontName = font;
  node.fontSize = size;
  node.characters = characters;
  node.fills = [{ type: 'SOLID', color }];
  if (width) {
    // Fixed width first, then let the height follow the wrapped text.
    node.resize(width, node.height);
    node.textAutoResize = 'HEIGHT';
  }
  return node;
}

function slotPaint(slot: BrandSlot, variable?: Variable): SolidPaint {
  const paint: SolidPaint = {
    type: 'SOLID',
    color: { r: slot.rgb.r, g: slot.rgb.g, b: slot.rgb.b },
    // A bound variable carries its own alpha; doubling it would fade the swatch.
    opacity: variable ? 1 : slot.rgb.a,
  };
  return variable ? figma.variables.setBoundVariableForPaint(paint, 'color', variable) : paint;
}

function outline(node: GeometryMixin & MinimalStrokesMixin) {
  node.strokes = [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 }, opacity: 0.08 }];
  node.strokeWeight = 1;
  node.strokeAlign = 'INSIDE';
}

function slotValue(slot: BrandSlot): string {
  return slot.rgb.a < 1
    ? `${slot.hex} at ${Math.round(slot.rgb.a * 100)}%`
    : `${slot.hex} · step ${stepLabel(slot.step)}`;
}

/** The white -> base -> black path, with a dot wherever a slot sits on it. */
function spectrumStrip(slots: BrandSlot[], base: BrandSlot): FrameNode {
  const strip = figma.createFrame();
  strip.name = 'spectrum';
  strip.resize(CONTENT, 16);
  strip.fills = [];
  strip.clipsContent = false;

  const bar = figma.createRectangle();
  bar.name = 'white → base → black';
  bar.resize(CONTENT, 16);
  bar.cornerRadius = 8;
  bar.fills = [
    {
      type: 'GRADIENT_LINEAR',
      gradientTransform: [
        [1, 0, 0],
        [0, 1, 0],
      ],
      gradientStops: spectrum(base.hex, 4).map((s) => ({
        position: Math.min(1, Math.max(0, s.step / 100)),
        color: { ...(parseHex(s.hex) as RGB), a: 1 },
      })),
    },
  ];
  outline(bar);
  strip.appendChild(bar);

  for (const slot of slots) {
    const dot = figma.createEllipse();
    dot.name = slot.key;
    dot.resize(10, 10);
    dot.x = Math.min(CONTENT - 10, Math.max(0, (CONTENT * slot.step) / 100 - 5));
    dot.y = 3;
    dot.fills = [slotPaint(slot)];
    dot.strokes = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];
    dot.strokeWeight = 2;
    dot.strokeAlign = 'OUTSIDE';
    strip.appendChild(dot);
  }
  return strip;
}

/**
 * Draw a token sheet for a brand theme: per group, the slots on their spectrum, a swatch
 * per slot from light to dark, then a row per variable with its value and usage. When the
 * theme's variables exist (in the collection named after the brand, unless `collectionName`
 * says otherwise), every swatch is bound to them.
 */
export async function paintBrandDoc(
  theme: BrandTheme,
  options: { collectionName?: string } = {},
): Promise<{ frame: FrameNode; bound: boolean }> {
  const font = await loadInter();
  const collectionName = options.collectionName ?? theme.name;

  // Bind to the written variables when they are there, so the sheet follows later edits.
  const collection = (await figma.variables.getLocalVariableCollectionsAsync()).find(
    (c) => c.name === collectionName,
  );
  const mode = collection?.modes.find((m) => m.name === theme.name);
  const variables = new Map<string, Variable>();
  if (collection && mode) {
    for (const v of await figma.variables.getLocalVariablesAsync('COLOR')) {
      if (v.variableCollectionId === collection.id) variables.set(v.name, v);
    }
  }
  const bound = variables.size > 0;

  const sheet = stack(`${theme.name} color tokens`, 'VERTICAL', 40);
  sheet.resize(SHEET_WIDTH, 100);
  sheet.counterAxisSizingMode = 'FIXED';
  sheet.primaryAxisSizingMode = 'AUTO';
  sheet.paddingTop = sheet.paddingBottom = sheet.paddingLeft = sheet.paddingRight = SHEET_PAD;
  sheet.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];
  if (bound && collection && mode) sheet.setExplicitVariableModeForCollection(collection, mode.modeId);

  const header = stack('header', 'VERTICAL', 8);
  header.appendChild(label(`${theme.name.toUpperCase()} COLOR TOKENS`, font('Bold'), 28, INK));
  header.appendChild(
    label(
      'DDS theme generated by Palette Maker. Step = round(100 × (1 − luma)). Tints mix the base ' +
        'with white and shades mix it with black, following the recipe fitted to the DDS brand themes.' +
        (bound ? ` Swatches are bound to the "${collectionName}" variables.` : ''),
      font('Regular'),
      13,
      MUTED,
      CONTENT,
    ),
  );
  sheet.appendChild(header);

  for (const group of BRAND_GROUPS) {
    const slots = theme.slots.filter((s) => s.group === group);
    const base = slots.find((s) => s.part === 'base');
    if (!base) continue;
    const ladder = BRAND_LIGHT_TO_DARK[group]
      .map((part) => slots.find((s) => s.part === part))
      .filter((s): s is BrandSlot => Boolean(s));

    // Attach containers before their children ask to fill them: FILL only resolves
    // against a parent whose width is already fixed.
    const section = stack(group, 'VERTICAL', 16);
    sheet.appendChild(section);
    section.layoutSizingHorizontal = 'FILL';

    const title = stack('title', 'HORIZONTAL', 12);
    title.counterAxisAlignItems = 'BASELINE';
    title.appendChild(label(group.toUpperCase(), font('Semi Bold'), 14, INK));
    title.appendChild(label(`${base.hex} · step ${stepLabel(base.step)}`, font('Regular'), 12, MUTED));
    section.appendChild(title);

    const rule = figma.createRectangle();
    rule.name = 'rule';
    rule.resize(CONTENT, 1);
    rule.fills = [{ type: 'SOLID', color: HAIRLINE }];
    section.appendChild(rule);

    section.appendChild(spectrumStrip(ladder, base));

    const swatches = stack('swatches', 'HORIZONTAL', CELL_GAP);
    for (const slot of ladder) {
      const cell = stack(slot.key, 'VERTICAL', 6);
      const chip = figma.createRectangle();
      chip.name = 'swatch';
      chip.resize(CELL, 88);
      chip.cornerRadius = 8;
      chip.fills = [slotPaint(slot, variables.get(slot.name))];
      outline(chip);
      cell.appendChild(chip);
      cell.appendChild(label(slot.key, font('Medium'), 12, INK, CELL));
      cell.appendChild(label(`${slot.hex} · ${stepLabel(slot.step)}`, font('Regular'), 11, MUTED, CELL));
      swatches.appendChild(cell);
    }
    section.appendChild(swatches);

    const table = stack('variables', 'VERTICAL', 0);
    section.appendChild(table);
    table.layoutSizingHorizontal = 'FILL';
    for (const slot of slots) {
      const line = stack(slot.name, 'HORIZONTAL', 16);
      line.counterAxisAlignItems = 'CENTER';
      line.paddingTop = line.paddingBottom = 10;
      line.strokes = [{ type: 'SOLID', color: HAIRLINE }];
      line.strokeTopWeight = 0;
      line.strokeLeftWeight = 0;
      line.strokeRightWeight = 0;
      line.strokeBottomWeight = 1;

      const dot = figma.createEllipse();
      dot.name = 'swatch';
      dot.resize(24, 24);
      dot.fills = [slotPaint(slot, variables.get(slot.name))];
      outline(dot);
      line.appendChild(dot);
      line.appendChild(label(slot.name, font('Medium'), 13, INK, 240));
      line.appendChild(label(slotValue(slot), font('Regular'), 12, INK, 170));
      line.appendChild(label(slot.usage, font('Regular'), 12, MUTED, CONTENT - 24 - 240 - 170 - 16 * 3));

      table.appendChild(line);
      line.layoutSizingHorizontal = 'FILL';
    }
  }

  return { frame: sheet, bound };
}
