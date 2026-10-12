/**
 * The recipe the Brand tool starts with, so it works before any file is imported. Its
 * numbers match recipes/dds.json; test/brand.ts fails if the two drift apart.
 */

import { BrandRecipe, recipeFromData } from './brand';

export const STARTER_NAME = 'Starter';

export const STARTER_RECIPE: BrandRecipe = recipeFromData({
  primary: {
    'tint-1': { step: 3 },
    'tint-2': { white: 88 },
    'tint-3': { step: 21 },
    'shade-2': { black: 20 },
    'shade-1': { black: 55 },
  },
  secondary: {
    'tint-1': { step: 4 },
    'tint-2': { white: 68 },
    'shade-1': { black: 41 },
  },
  tertiary: {
    'tint-1': { step: 7 },
    'tint-2': { step: 48 },
    'shade-1': { step: 96 },
  },
  onContrast: 2,
  onDark: '#0A0A0A',
  alpha: 12,
  tertiaryDefault: {
    base: '#333333',
    'tint-1': '#ECEDEF',
    'tint-2': '#848484',
    'shade-1': '#0A0A0A',
    on: '#FFFFFF',
  },
});
