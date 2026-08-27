/// <reference types="@figma/plugin-typings" />

/**
 * Plugin sandbox entry. Owns everything that touches the document:
 * creating swatch frames, writing variables, and persisting config and window size.
 */

import { PaletteConfig } from '../src/palette';
import { paintSwatchRow, writeVariables } from '../src/figma';
import { PluginToUi, UiToPlugin, WindowSize } from './messages';

const CONFIG_KEY = 'palette-maker:config';
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
          frame.x = figma.viewport.center.x - frame.width / 2;
          frame.y = figma.viewport.center.y - frame.height / 2;
          figma.currentPage.appendChild(frame);
          figma.currentPage.selection = [frame];
          figma.viewport.scrollAndZoomIntoView([frame]);
          post({ type: 'done', message: `Created ${message.stops.length} swatches` });
          break;
        }

        case 'create-variables': {
          const collection = await writeVariables(message.stops, {
            collectionName: message.collectionName,
            groupName: message.groupName,
            modeName: message.modeName,
          });
          post({
            type: 'done',
            message: `Wrote ${message.stops.length} variables to ${collection.name}`,
          });
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
      post({ type: 'error', message: text });
      figma.notify(text, { error: true });
    }
  };

  const config = await load<PaletteConfig>(CONFIG_KEY);
  post({ type: 'restore-config', config });
}

void main();
