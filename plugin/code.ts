/// <reference types="@figma/plugin-typings" />

/**
 * Plugin sandbox entry. Owns everything that touches the document:
 * creating swatch frames, writing variables, and persisting config and window size.
 */

import { PaletteConfig } from '../src/palette';
import { paintBrandDoc, paintSwatchRow, writeBrandTheme, writeVariables } from '../src/figma';
import { BrandSettings, PluginToUi, Tool, UiToPlugin, WindowSize } from './messages';

const CONFIG_KEY = 'palette-maker:config';
const BRAND_KEY = 'palette-maker:brand';
const TOOL_KEY = 'palette-maker:tool';
const SIZE_KEY = 'palette-maker:size';
const DEFAULT_SIZE: WindowSize = { width: 420, height: 720 };

function post(message: PluginToUi) {
  figma.ui.postMessage(message);
}

/** clientStorage is a convenience here, so a failure must never break the plugin. */
async function load<T>(key: string): Promise<T | null> {
  try {
    return ((await figma.clientStorage.getAsync(key)) as T | undefined) ?? null;
  } catch {
    return null;
  }
}

async function save(key: string, value: unknown): Promise<void> {
  try {
    await figma.clientStorage.setAsync(key, value);
  } catch {
    // No manifest id, or storage unavailable. Not worth interrupting the user.
  }
}

/** Drop a new frame at the center of the view, selected and in sight. */
function place(frame: FrameNode) {
  frame.x = Math.round(figma.viewport.center.x - frame.width / 2);
  frame.y = Math.round(figma.viewport.center.y - frame.height / 2);
  figma.currentPage.appendChild(frame);
  figma.currentPage.selection = [frame];
  figma.viewport.scrollAndZoomIntoView([frame]);
}

function isSize(value: unknown): value is WindowSize {
  const size = value as WindowSize | null;
  return (
    !!size &&
    Number.isFinite(size.width) &&
    Number.isFinite(size.height) &&
    size.width >= 260 &&
    size.height >= 320
  );
}

async function main(): Promise<void> {
  // Reopen at the size the user last left the window.
  const savedSize = await load<WindowSize>(SIZE_KEY);
  const size = isSize(savedSize) ? savedSize : DEFAULT_SIZE;

  figma.showUI(__html__, {
    width: size.width,
    height: size.height,
    themeColors: true,
  });

  figma.ui.onmessage = async (message: UiToPlugin) => {
    try {
      switch (message.type) {
        case 'create-swatches': {
          const frame = await paintSwatchRow(message.stops, { label: message.label });
          place(frame);
          figma.notify(`Created ${message.stops.length} swatches`);
          break;
        }

        case 'create-brand-variables': {
          const result = await writeBrandTheme(message.theme);
          const total = result.created + result.updated;
          figma.notify(
            result.created
              ? `Created "${result.collection.name}" with ${total} variables`
              : `Updated the ${total} variables in "${result.collection.name}"`,
          );
          break;
        }

        case 'create-brand-doc': {
          const { frame, bound } = await paintBrandDoc(message.theme);
          place(frame);
          figma.notify(`Created the ${message.theme.name} token sheet` + (bound ? ', bound to variables' : ''));
          break;
        }

        case 'notify': {
          figma.notify(message.message, { error: message.error });
          break;
        }

        case 'save-brand': {
          await save(BRAND_KEY, message.brand);
          await save(TOOL_KEY, message.tool);
          break;
        }

        case 'create-variables': {
          const collection = await writeVariables(message.stops, {
            collectionName: message.collectionName,
            groupName: message.groupName,
            modeName: message.modeName,
          });
          figma.notify(`Wrote ${message.stops.length} variables to ${collection.name}`);
          break;
        }

        case 'save-config': {
          await save(CONFIG_KEY, message.config);
          break;
        }

        case 'resize': {
          figma.ui.resize(message.size.width, message.size.height);
          // Only persist on drag end, not on every frame of the drag.
          if (message.commit) await save(SIZE_KEY, message.size);
          break;
        }
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      figma.notify(text, { error: true });
    }
  };

  const [config, brand, tool] = await Promise.all([
    load<PaletteConfig>(CONFIG_KEY),
    load<BrandSettings>(BRAND_KEY),
    load<Tool>(TOOL_KEY),
  ]);
  post({ type: 'restore-config', config, brand, tool });
}

void main();
