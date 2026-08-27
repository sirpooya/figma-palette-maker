/// <reference types="@figma/plugin-typings" />

/**
 * Plugin sandbox entry. Owns everything that touches the document:
 * creating swatch frames, writing variables, and persisting the last config.
 */

import { PaletteConfig } from '../src/palette';
import { paintSwatchRow, writeVariables } from '../src/figma';
import { PluginToUi, UiToPlugin } from './messages';

const CONFIG_KEY = 'palette-maker:config';

function post(message: PluginToUi) {
  figma.ui.postMessage(message);
}

figma.showUI(__html__, { width: 420, height: 720, themeColors: true });

figma.clientStorage
  .getAsync(CONFIG_KEY)
  .then((config: PaletteConfig | undefined) => {
    post({ type: 'restore-config', config: config ?? null });
  })
  .catch(() => post({ type: 'restore-config', config: null }));

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
        await figma.clientStorage.setAsync(CONFIG_KEY, message.config);
        break;
      }

      case 'resize': {
        figma.ui.resize(420, Math.max(400, Math.min(1200, Math.round(message.height))));
        break;
      }
    }
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    post({ type: 'error', message: text });
    figma.notify(text, { error: true });
  }
};
