/** Message contract between the UI iframe and the plugin sandbox. */

import { BrandInput, BrandRecipe, BrandTheme } from '../src/brand';
import { PaletteConfig, PaletteStop } from '../src/palette';

export interface WindowSize {
  width: number;
  height: number;
}

/** The two tools the window switches between. */
export type Tool = 'curves' | 'brand';

/**
 * Everything the Brand tool needs to come back exactly as it was left. The plugin ships no
 * recipe: both are null until the user imports one.
 */
export interface BrandSettings {
  input: BrandInput;
  /** The recipe in use, including any slider edits. */
  recipe: BrandRecipe | null;
  /** The recipe as imported, for "Reset to <name>". */
  imported: { name: string; recipe: BrandRecipe } | null;
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
  /** Writes the DDS-shaped theme layer into a collection named after the brand. */
  | { type: 'create-brand-variables'; theme: BrandTheme }
  /** Draws the token sheet; binds it to the brand's variables when they exist. */
  | { type: 'create-brand-doc'; theme: BrandTheme }
  | { type: 'save-brand'; brand: BrandSettings; tool: Tool }
  /** Feedback shows as Figma's own toast, not as text in the panel. */
  | { type: 'notify'; message: string; error?: boolean }
  /** Sent continuously while an edge is dragged; `commit` marks the drag end. */
  | { type: 'resize'; size: WindowSize; commit: boolean };

export type PluginToUi =
  | {
      type: 'restore-config';
      config: PaletteConfig | null;
      brand?: BrandSettings | null;
      tool?: Tool | null;
    };
