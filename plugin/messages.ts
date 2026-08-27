/** Message contract between the UI iframe and the plugin sandbox. */

import { PaletteConfig, PaletteStop } from '../src/palette';

export interface WindowSize {
  width: number;
  height: number;
}

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
  /** Sent continuously while an edge is dragged; `commit` marks the drag end. */
  | { type: 'resize'; size: WindowSize; commit: boolean };

export type PluginToUi =
  | { type: 'restore-config'; config: PaletteConfig | null }
  | { type: 'done'; message: string }
  | { type: 'error'; message: string };
