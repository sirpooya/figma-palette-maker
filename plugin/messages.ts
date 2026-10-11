/** Message contract between the UI iframe and the plugin sandbox. */

import { BrandInput, BrandRecipe, BrandTheme } from '../src/brand';
import { PaletteConfig, PaletteStop } from '../src/palette';

export interface WindowSize {
  width: number;
  height: number;
}

/** The two tools the window switches between. */
export type Tool = 'curves' | 'brand';

/** Everything the Brand tool needs to come back exactly as it was left. */
export interface BrandSettings {
  input: BrandInput;
  recipe: BrandRecipe;
  /** Variable collection the theme layer is written to, "🌈 Theme" by default. */
  collectionName: string;
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
  /** Writes the DDS-shaped theme layer: one mode per brand in `collectionName`. */
  | { type: 'create-brand-variables'; theme: BrandTheme; collectionName: string }
  /** Draws the token sheet; binds it to `collectionName`'s variables when they exist. */
  | { type: 'create-brand-doc'; theme: BrandTheme; collectionName: string }
  | { type: 'save-brand'; brand: BrandSettings; tool: Tool }
  /** Sent continuously while an edge is dragged; `commit` marks the drag end. */
  | { type: 'resize'; size: WindowSize; commit: boolean };

export type PluginToUi =
  | {
      type: 'restore-config';
      config: PaletteConfig | null;
      brand?: BrandSettings | null;
      tool?: Tool | null;
    }
  | { type: 'done'; message: string }
  | { type: 'error'; message: string };
