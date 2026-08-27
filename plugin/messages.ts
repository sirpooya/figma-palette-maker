/** Message contract between the UI iframe and the plugin sandbox. */

import { PaletteConfig, PaletteStop } from '../src/palette';

export type UiToPlugin =
  | { type: 'create-swatches'; stops: PaletteStop[]; label: boolean }
  | {
      type: 'create-variables';
      stops: PaletteStop[];
      collectionName: string;
      groupName: string;
      modeName: string;
    }
  | { type: 'save-config'; config: PaletteConfig }
  | { type: 'resize'; height: number };

export type PluginToUi =
  | { type: 'restore-config'; config: PaletteConfig | null }
  | { type: 'done'; message: string }
  | { type: 'error'; message: string };
