/**
 * Figma-side helpers. Import these only from the plugin's sandbox code
 * (the file that has access to the `figma` global), never from the UI iframe.
 */

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
