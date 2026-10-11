/**
 * UI iframe entry. Owns the controls and the live preview; the sandbox owns the document.
 * The engine in ../../src is platform-agnostic, so the exact same code runs on both sides.
 *
 * Layout: the preview and the action footer are pinned, and only the middle panel
 * scrolls. Controls are grouped into tabs rather than one long column, and every
 * slider gets its own row, because a range input has an intrinsic min-width of
 * roughly 130px and two of them will not fit side by side in a 420px panel.
 */

import {
  BRAND_GROUPS,
  BRAND_LIGHT_TO_DARK,
  BrandGroup,
  BrandRecipe,
  BrandTheme,
  SlotRule,
  brandSlug,
  brandThemeToJson,
  generateBrandTheme,
  blackForStep,
  parseHex,
  parseRecipe,
  recipeToJson,
  whiteForStep,
  spectrum,
  stepLabel,
} from '../../src/brand';
import { Channel, PRESET_LIST, PresetId } from '../../src/curves';
import { Rgb, rgbToHex } from '../../src/oklch';
import {
  MAX_STOPS,
  MIN_STOPS,
  PaletteConfig,
  PaletteStop,
  defaultConfig,
  generatePalette,
  reanchorChannel,
  toCssVariables,
  toJson,
} from '../../src/palette';
import { BrandSettings, PluginToUi, Tool, UiToPlugin, WindowSize } from '../messages';

type Tab = 'l' | 'c' | 'h' | 'output';

const CHANNEL_LABELS: Record<Channel, string> = {
  l: 'Lightness',
  c: 'Chroma',
  h: 'Hue',
};

const TAB_LABELS: Record<Tab, string> = {
  l: 'Lightness',
  c: 'Chroma',
  h: 'Hue',
  output: 'Output',
};

/** Step size for the min/max number inputs, per channel scale. */
const CHANNEL_STEP: Record<Channel, number> = { l: 0.1, c: 0.001, h: 0.1 };

let config: PaletteConfig = defaultConfig();
let stops: PaletteStop[] = [];
let activeTab: Tab = 'l';
let exportFormat: 'css' | 'json' = 'css';
const naming = { collectionName: 'Core', groupName: 'gray', modeName: 'Value' };

const toolEl = document.getElementById('tool') as HTMLDivElement;
const previewEl = document.getElementById('preview') as HTMLDivElement;
const formEl = document.getElementById('form') as HTMLDivElement;
const tabsEl = document.getElementById('tabs') as HTMLDivElement;
const panelsEl = document.getElementById('panels') as HTMLDivElement;
const footerEl = document.getElementById('footer') as HTMLDivElement;

function send(message: UiToPlugin) {
  parent.postMessage({ pluginMessage: message }, '*');
}

/** Feedback goes to Figma's own toast at the bottom of the canvas, not into the panel. */
function setStatus(text: string, isError = false) {
  if (text) send({ type: 'notify', message: text, error: isError });
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  children: Array<Node | string> = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children);
  return node;
}

/* -------------------------------------------------------------------------- */
/* Control primitives                                                          */
/* -------------------------------------------------------------------------- */

function row(label: string, ...control: Node[]): HTMLElement {
  return el('div', { className: 'row' }, [
    el('label', { textContent: label }),
    el('div', { className: 'control' }, control),
  ]);
}

function numberRow(
  label: string,
  value: number,
  step: number,
  onCommit: (v: number) => void,
): HTMLElement {
  const input = el('input', {
    type: 'number',
    step: String(step),
    value: String(Number(value.toFixed(4))),
  });
  // Commit on change, not on every keystroke: re-solving mid-typing fights the caret.
  input.onchange = () => {
    const v = Number(input.value);
    if (Number.isFinite(v)) onCommit(v);
  };
  return row(label, input);
}

function sliderRow(
  label: string,
  value: number,
  min: number,
  max: number,
  step: number,
  onInput: (v: number) => void,
  format?: (v: number) => string,
): HTMLElement {
  const decimals = step >= 1 ? 0 : step >= 0.01 ? 2 : 4;
  const fmt =
    format ?? ((v: number) => (decimals === 0 ? String(Math.round(v)) : v.toFixed(decimals)));

  const input = el('input', {
    type: 'range',
    min: String(min),
    max: String(max),
    step: String(step),
    value: String(value),
  });
  const readout = el('span', { className: 'value', textContent: fmt(value) });
  // Chromium has no range-progress pseudo-element, so the track gradient reads this.
  const paintFill = (v: number) =>
    input.style.setProperty('--fill', `${max > min ? ((v - min) / (max - min)) * 100 : 0}%`);
  paintFill(value);

  input.oninput = () => {
    const v = Number(input.value);
    readout.textContent = fmt(v);
    paintFill(v);
    onInput(v);
  };
  return row(label, input, readout);
}

/* -------------------------------------------------------------------------- */
/* Preview                                                                     */
/* -------------------------------------------------------------------------- */

function renderPreview() {
  const ramp = el('div', { className: 'ramp' });
  const meta = el('div', { className: 'meta' });

  const summary = () => {
    meta.innerHTML = '';
    meta.append(
      el('span', { textContent: `${stops.length} stops` }),
      el('span', {
        textContent: `${stops[0]?.token ?? ''} to ${stops[stops.length - 1]?.token ?? ''}`,
      }),
    );
  };

  for (const stop of stops) {
    const cell = el('div');
    cell.style.background = stop.hex;
    cell.title = `${stop.token}  ${stop.hex}  ${stop.oklch}`;
    cell.onmouseenter = () => {
      meta.innerHTML = '';
      meta.append(
        el('span', { textContent: `${stop.token}  ${stop.hex}` }),
        el('span', { textContent: stop.oklch }),
      );
    };
    ramp.append(cell);
  }
  ramp.onmouseleave = summary;
  summary();

  previewEl.innerHTML = '';
  previewEl.append(el('div', { className: 'card' }, [ramp, meta]));
}

/* -------------------------------------------------------------------------- */
/* Panels                                                                      */
/* -------------------------------------------------------------------------- */

function renderTabs() {
  tabsEl.innerHTML = '';
  for (const tab of ['l', 'c', 'h', 'output'] as Tab[]) {
    const button = el('button', { className: 'tab', textContent: TAB_LABELS[tab] });
    button.setAttribute('aria-selected', String(tab === activeTab));
    button.onclick = () => {
      activeTab = tab;
      renderTabs();
      renderPanel();
    };
    tabsEl.append(button);
  }
}

function rampCard(): HTMLElement {
  return el('div', { className: 'card' }, [
    el('h2', { textContent: 'Ramp' }),
    sliderRow('Stops', config.stops, MIN_STOPS, MAX_STOPS, 1, (v) => {
      config.stops = v;
      config.stopOverrides = [];
      refresh();
    }),
    numberRow('Token start', config.tokenStart, 1, (v) => {
      config.tokenStart = v;
      refresh();
    }),
  ]);
}

function channelCard(channel: Channel): HTMLElement {
  const cfg = config[channel];
  const presets = PRESET_LIST[channel];
  const active = presets.find((p) => p.id === cfg.preset);

  const select = el('select');
  for (const preset of presets) {
    select.append(el('option', { value: preset.id, textContent: preset.label }));
  }
  // Set the selection only after the options are attached: an `option.selected` set
  // before its `select` has adopted it is discarded, which silently lands on the
  // wrong preset.
  select.value = cfg.preset;
  select.onchange = () => {
    config[channel] = reanchorChannel(
      channel,
      select.value as PresetId,
      config[channel].min,
      config[channel].max,
    );
    renderPanel();
    refresh();
  };

  const card = el('div', { className: 'card' }, [
    el('h2', { textContent: `${CHANNEL_LABELS[channel]} curve` }),
    row('Curve', el('div', { className: 'select-wrap' }, [select])),
    el('p', { className: 'equation', textContent: active?.equation ?? '' }),
    numberRow('Min', cfg.min, CHANNEL_STEP[channel], (v) => {
      config[channel] = reanchorChannel(channel, cfg.preset, v, config[channel].max);
      renderPanel();
      refresh();
    }),
    numberRow('Max', cfg.max, CHANNEL_STEP[channel], (v) => {
      config[channel] = reanchorChannel(channel, cfg.preset, config[channel].min, v);
      renderPanel();
      refresh();
    }),
  ]);

  // Live parameter sliders, generated straight off the preset's own spec.
  const specs = active?.params ?? [];
  if (specs.length) {
    const params = el('div', { className: 'params' });
    for (const spec of specs) {
      const current = cfg.params[spec.name] ?? spec.default;
      // A solved param can sit outside the original slider range, so widen to fit.
      const min = Math.min(spec.min, current);
      const max = Math.max(spec.max, current);
      params.append(
        sliderRow(spec.label, current, min, max, spec.step, (v) => {
          config[channel].params[spec.name] = v;
          refresh();
        }),
      );
    }
    const reset = el('button', { textContent: 'Re-solve from min/max' });
    reset.onclick = () => {
      config[channel] = reanchorChannel(channel, cfg.preset, cfg.min, cfg.max);
      renderPanel();
      refresh();
    };
    params.append(el('div', { className: 'linkrow' }, [reset]));
    card.append(params);
  }

  return card;
}

function outputCard(): HTMLElement {
  const card = el('div', { className: 'card' }, [el('h2', { textContent: 'Naming' })]);

  const labels: Record<keyof typeof naming, string> = {
    collectionName: 'Collection',
    groupName: 'Group',
    modeName: 'Mode',
  };

  for (const key of ['collectionName', 'groupName', 'modeName'] as const) {
    const input = el('input', { type: 'text', value: naming[key] });
    input.oninput = () => {
      naming[key] = input.value;
      refreshExport();
    };
    card.append(row(labels[key], input));
  }
  return card;
}

function exportCard(): HTMLElement {
  const toggle = el('div', { className: 'actions' });
  for (const format of ['css', 'json'] as const) {
    const button = el('button', {
      textContent: format.toUpperCase(),
      className: format === exportFormat ? 'primary' : '',
    });
    button.onclick = () => {
      exportFormat = format;
      renderPanel();
    };
    toggle.append(button);
  }

  const textarea = el('textarea', { readOnly: true, id: 'export' });
  textarea.value = exportText();

  const copy = el('button', { textContent: 'Copy to clipboard' });
  copy.onclick = () => {
    textarea.select();
    document.execCommand('copy');
    setStatus(`Copied ${exportFormat.toUpperCase()}`);
  };

  const spacer = el('div');
  spacer.style.height = '8px';

  return el('div', { className: 'card' }, [
    el('h2', { textContent: 'Export' }),
    toggle,
    spacer,
    textarea,
    el('div', { className: 'linkrow' }, [copy]),
  ]);
}

function exportText(): string {
  const name = naming.groupName.trim() || 'gray';
  return exportFormat === 'css' ? toCssVariables(stops, name) : toJson(stops, name);
}

function renderPanel() {
  panelsEl.innerHTML = '';
  if (activeTab === 'output') {
    panelsEl.append(rampCard(), outputCard(), exportCard());
  } else {
    panelsEl.append(rampCard(), channelCard(activeTab));
  }
}

function renderFooter() {
  const variables = el('button', { className: 'primary', textContent: 'Create variables' });
  variables.onclick = () =>
    send({
      type: 'create-variables',
      stops,
      collectionName: naming.collectionName.trim() || 'Core',
      groupName: naming.groupName.trim() || 'gray',
      modeName: naming.modeName.trim() || 'Value',
    });

  const swatches = el('button', { textContent: 'Create swatches' });
  swatches.onclick = () => send({ type: 'create-swatches', stops, label: true });

  footerEl.innerHTML = '';
  footerEl.append(
    el('div', { className: 'actions' }, [swatches, variables]),
  );
}

/* -------------------------------------------------------------------------- */
/* Brand tool                                                                  */
/* -------------------------------------------------------------------------- */

/*
 * Headless: the plugin ships no recipe and no colors. Nothing generates until the user
 * imports a recipe file, which is then kept in clientStorage (on their machine) with the
 * rest of the Brand settings. The DDS recipe is recipes/dds.json in the repo.
 */

const GROUP_LABELS: Record<BrandGroup, string> = {
  primary: 'Primary',
  secondary: 'Secondary',
  tertiary: 'Tertiary',
};

const PART_LABELS: Record<string, string> = {
  'tint-1': 'Tint 1',
  'tint-2': 'Tint 2',
  'tint-3': 'Tint 3',
  'shade-2': 'Shade 2',
  'shade-1': 'Shade 1',
};

/** Hints only: shown in the empty fields, never used as values. */
const PLACEHOLDERS = { name: 'Brand name', primary: '#ED1944', secondary: '#1672DD', tertiary: '#333333' };

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function defaultBrand(): BrandSettings {
  return {
    input: { name: '', primary: '', secondary: '', tertiary: '' },
    recipe: null,
    imported: null,
  };
}

/** A recipe from storage, checked through the file format; anything malformed is dropped. */
function storedRecipe(value: unknown): BrandRecipe | null {
  try {
    return value ? parseRecipe(recipeToJson(value as BrandRecipe)) : null;
  } catch {
    return null;
  }
}

/** Settings saved by an older build may lack fields; fill the gaps, never invent a recipe. */
function restoreBrand(saved: BrandSettings): BrandSettings {
  const recipe = storedRecipe(saved.recipe);
  const importedRecipe = storedRecipe(saved.imported?.recipe);
  return {
    input: { ...defaultBrand().input, ...saved.input, gradient: '' },
    recipe,
    imported:
      recipe && importedRecipe
        ? { name: String(saved.imported?.name || 'imported recipe'), recipe: importedRecipe }
        : recipe
          ? { name: 'imported recipe', recipe: clone(recipe) }
          : null,
  };
}

let tool: Tool = 'curves';
let brand: BrandSettings = defaultBrand();
let brandTheme: BrandTheme | null = null;
/** Why there is no theme yet: no recipe, or colors still to fill in. */
let brandNotice = '';
let brandError = '';
let saveTimer: ReturnType<typeof setTimeout> | null = null;
const brandActions: HTMLButtonElement[] = [];

/** Debounced: a color picker drag fires dozens of inputs a second. */
function saveBrand() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    send({ type: 'save-brand', brand, tool });
  }, 200);
}

function regenerate() {
  brandTheme = null;
  brandError = '';
  brandNotice = '';
  if (!brand.recipe) {
    brandNotice = 'Import a recipe to start.';
    return;
  }
  const missing = [
    !brand.input.name.trim() && 'a brand name',
    !brand.input.primary.trim() && 'a primary color',
    !brand.input.secondary.trim() && 'a secondary color',
  ].filter((x): x is string => Boolean(x));
  if (missing.length) {
    const list = missing.length > 1 ? `${missing.slice(0, -1).join(', ')} and ${missing.at(-1)}` : missing[0];
    brandNotice = `Add ${list}.`;
    return;
  }
  try {
    brandTheme = generateBrandTheme(brand.input, brand.recipe);
  } catch (error) {
    brandError = error instanceof Error ? error.message : String(error);
  }
}

/* Recipe files -------------------------------------------------------------- */

/** One hidden file input serves every "Import recipe" button. */
const recipeFile = el('input', { type: 'file', accept: '.json,application/json' });
recipeFile.hidden = true;
document.body.append(recipeFile);

// Import replaces the whole recipe or nothing: parseRecipe refuses a file with any missing
// or out-of-range slot and says which one.
recipeFile.onchange = async () => {
  const picked = recipeFile.files?.[0];
  recipeFile.value = '';
  if (!picked) return;
  try {
    const text = await picked.text();
    const recipe = parseRecipe(text);
    const named = (JSON.parse(text) as { name?: unknown }).name;
    const name = typeof named === 'string' && named.trim() ? named.trim() : picked.name.replace(/\.json$/i, '');
    brand.recipe = recipe;
    brand.imported = { name, recipe: clone(recipe) };
    render();
    saveBrand();
    setStatus(`Imported the recipe from ${picked.name}`);
  } catch (error) {
    setStatus(`${picked.name}: ${error instanceof Error ? error.message : String(error)}`, true);
  }
};

function importButton(label = 'Import recipe'): HTMLButtonElement {
  const button = el('button', { textContent: label });
  button.onclick = () => recipeFile.click();
  return button;
}

/** Hand a text file to the user; Figma's plugin iframe allows downloads. */
function downloadText(filename: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = el('a', { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* Shell --------------------------------------------------------------------- */

function renderTool() {
  const bar = el('div', { className: 'toolbar' });
  for (const [id, text] of [
    ['curves', 'Curves'],
    ['brand', 'Brand'],
  ] as Array<[Tool, string]>) {
    const button = el('button', { className: 'tool', textContent: text });
    button.setAttribute('aria-pressed', String(tool === id));
    button.onclick = () => {
      if (tool === id) return;
      tool = id;
      render();
      saveBrand();
    };
    bar.append(button);
  }
  toolEl.innerHTML = '';
  toolEl.append(bar);
}

/** A short, centered message in place of a panel that has nothing to show yet. */
function emptyState(text: string, actions: HTMLElement[] = []): HTMLElement {
  return el('div', { className: 'empty-state' }, [
    el('p', { textContent: text }),
    ...(actions.length ? [el('div', { className: 'linkrow' }, actions)] : []),
  ]);
}

/** The recipe rule behind a dot, or null for the base and for a fixed tertiary set. */
function ruleFor(group: BrandGroup, part: string): SlotRule | null {
  const recipe = brand.recipe;
  if (!recipe) return null;
  if (group === 'tertiary' && tertiaryIsFixed()) return null;
  return (recipe[group] as Record<string, SlotRule>)[part] ?? null;
}

/** True when the tertiary is the recipe's fixed set: left empty, or set to its base. */
function tertiaryIsFixed(): boolean {
  const fixed = brand.recipe?.tertiaryDefault;
  if (!fixed) return false;
  const typed = brand.input.tertiary?.trim() ?? '';
  const color = typed ? parseHex(typed) : null;
  return !typed || (color !== null && rgbToHex(color) === fixed.base);
}

/** How a rule reads: `step 03` or `88%`. */
function ruleLabel(rule: SlotRule): string {
  return rule.kind === 'step' ? `step ${stepLabel(rule.step)}` : `${Math.round(rule.amount * 100)}%`;
}

/**
 * The rule that lands this slot on `step` for the current base. A step rule takes the step
 * itself; a mix rule takes the share of white or black that lands there, in whole percent.
 */
function ruleAtStep(group: BrandGroup, part: string, step: number): SlotRule | null {
  const rule = ruleFor(group, part);
  const base = brandTheme?.slots.find((s) => s.group === group && s.part === 'base');
  if (!rule || !base) return null;
  const target = Math.min(100, Math.max(0, Math.round(step)));
  if (rule.kind === 'step') return { kind: 'step', step: target };
  const color = parseHex(base.hex) as Rgb;
  const amount = part.startsWith('tint') ? whiteForStep(color, target) : blackForStep(color, target);
  return { kind: 'mix', amount: Math.round(amount * 100) / 100 };
}

function setRule(group: BrandGroup, part: string, rule: SlotRule) {
  if (!brand.recipe) return;
  (brand.recipe[group] as Record<string, SlotRule>)[part] = rule;
  regenerate();
  placeMarkers();
  renderThemeList();
  syncBrandActions();
  syncReset();
  saveBrand();
}

/** Where the strips live: the recipe card, above the on-color and alpha bars. */
let stripsHost: HTMLElement | null = null;
/** Where the theme list lives: under the recipe card. */
let themeHost: HTMLElement | null = null;

/** Move and recolor the dots in place: rebuilding mid-drag would drop the pointer. */
function placeMarkers() {
  if (!brandTheme || !stripsHost) return;
  for (const slot of brandTheme.slots) {
    const marker = stripsHost.querySelector(`.marker[data-key="${slot.key}"]`) as HTMLElement | null;
    if (!marker) continue;
    marker.style.left = `${slot.step}%`;
    marker.style.background = slot.hex;
    const rule = ruleFor(slot.group, slot.part);
    marker.title = `${slot.key}  ${slot.hex}  step ${stepLabel(slot.step)}` + (rule ? `  (${ruleLabel(rule)})` : '');
  }
}

/** Drag a dot along its strip, or nudge it with the arrow keys, to edit its recipe rule. */
function makeDraggable(marker: HTMLElement, bar: HTMLElement, name: HTMLElement, group: BrandGroup, part: string) {
  const label = GROUP_LABELS[group];
  const show = () => {
    const rule = ruleFor(group, part);
    name.textContent = rule ? `${PART_LABELS[part] ?? part} ${ruleLabel(rule)}` : label;
  };
  const hide = () => (name.textContent = label);

  marker.tabIndex = 0;
  marker.classList.add('draggable');
  marker.onmouseenter = show;
  marker.onmouseleave = () => !marker.dataset.dragging && hide();
  marker.onfocus = show;
  marker.onblur = hide;

  marker.addEventListener('pointerdown', (event: PointerEvent) => {
    event.preventDefault();
    marker.setPointerCapture?.(event.pointerId);
    marker.dataset.dragging = 'true';
    marker.focus();
    const move = (e: PointerEvent) => {
      const rect = bar.getBoundingClientRect();
      if (!rect.width) return;
      const rule = ruleAtStep(group, part, ((e.clientX - rect.left) / rect.width) * 100);
      if (rule) setRule(group, part, rule);
      show();
    };
    const up = () => {
      delete marker.dataset.dragging;
      marker.removeEventListener('pointermove', move);
      marker.removeEventListener('pointerup', up);
      marker.removeEventListener('pointercancel', up);
    };
    marker.addEventListener('pointermove', move);
    marker.addEventListener('pointerup', up);
    marker.addEventListener('pointercancel', up);
  });

  marker.addEventListener('keydown', (event: KeyboardEvent) => {
    const delta = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
    const slot = brandTheme?.slots.find((s) => s.group === group && s.part === part);
    if (!delta || !slot) return;
    event.preventDefault();
    const rule = ruleAtStep(group, part, slot.step + delta * (event.shiftKey ? 10 : 1));
    if (rule) setRule(group, part, rule);
    show();
  });
}

/**
 * One strip per group: the white -> base -> black path with a dot on every slot. The dots
 * are the recipe: drag one (or use the arrow keys) to move that tint or shade, and the
 * strip's label reads out its rule while you do.
 */
function renderBrandPreview() {
  if (!stripsHost) return;
  stripsHost.innerHTML = '';
  // Nothing to show yet: the Recipe tab and the disabled actions say what is missing.
  if (!brandTheme) return;

  const rows = el('div', { className: 'spectra' });
  for (const group of BRAND_GROUPS) {
    const base = brandTheme.slots.find((s) => s.group === group && s.part === 'base');
    if (!base) continue;

    const name = el('span', { className: 'name', textContent: GROUP_LABELS[group] });
    const bar = el('div', { className: 'spectrum' });
    const path = spectrum(base.hex, 2).map((p) => `${p.hex} ${p.step.toFixed(2)}%`);
    bar.style.background = `linear-gradient(to right, ${path.join(', ')})`;

    for (const part of BRAND_LIGHT_TO_DARK[group]) {
      const slot = brandTheme.slots.find((s) => s.group === group && s.part === part);
      if (!slot) continue;
      const marker = el('span', { className: 'marker' });
      marker.dataset.key = slot.key;
      if (ruleFor(group, part)) makeDraggable(marker, bar, name, group, part);
      bar.append(marker);
    }

    rows.append(el('div', { className: 'spectrum-row' }, [name, bar]));
  }
  stripsHost.append(rows);
  placeMarkers();
}

/** The Brand tool has no tabs: recipe and theme share one panel. */
function renderBrandTabs() {
  tabsEl.innerHTML = '';
}

/* Colors -------------------------------------------------------------------- */

/**
 * A native color picker paired with a hex field; either one drives the other. Empty is a
 * valid state: the field shows the placeholder and the swatch shows it faded.
 */
function colorField(value: string, placeholder: string, onChange: (hex: string) => void): HTMLElement {
  // Shown without the "#", like Figma's own color fields; typed or pasted either way.
  const bare = (hex: string) => hex.replace(/^#/, '');
  const parsed = value.trim() ? parseHex(value) : null;
  let current = parsed ? rgbToHex(parsed) : '';
  const picker = el('input', { type: 'color', value: (current || placeholder).toLowerCase() });
  const text = el('input', { type: 'text', value: bare(current), placeholder: bare(placeholder), spellcheck: false });
  const field = el('div', { className: 'color-field' }, [picker, text]);
  const mark = () => field.classList.toggle('empty', !current);
  mark();

  picker.oninput = () => {
    current = picker.value.toUpperCase();
    text.value = bare(current);
    mark();
    onChange(current);
  };
  // Commit on change, like the number fields: half-typed hex is not a color yet.
  text.onchange = () => {
    if (!text.value.trim()) {
      current = '';
      picker.value = placeholder.toLowerCase();
      mark();
      onChange('');
      return;
    }
    const rgb = parseHex(text.value);
    if (!rgb) {
      setStatus(`"${text.value.trim()}" is not a hex color`, true);
      text.value = bare(current);
      return;
    }
    current = rgbToHex(rgb);
    text.value = bare(current);
    picker.value = current.toLowerCase();
    mark();
    onChange(current);
  };
  return field;
}

/**
 * The brand's name and colors, pinned under the preview so they are always in reach. Only
 * rebuilt on full renders: refreshes leave it alone, so typing and picker drags keep focus.
 */
function renderBrandForm() {
  const name = el('input', { type: 'text', value: brand.input.name, placeholder: PLACEHOLDERS.name });
  name.oninput = () => {
    brand.input.name = name.value;
    refreshBrand();
  };
  // Colors sit side by side, label on top of each field, with the name under them.
  const color = (label: string, key: 'primary' | 'secondary' | 'tertiary', placeholder: string) =>
    el('div', { className: 'color-cell' }, [
      el('label', { textContent: label }),
      colorField(brand.input[key] ?? '', placeholder, (hex) => {
        brand.input[key] = hex;
        refreshBrand();
      }),
    ]);

  formEl.innerHTML = '';
  formEl.append(
    el('div', { className: 'color-grid' }, [
      color('Primary', 'primary', PLACEHOLDERS.primary),
      color('Secondary', 'secondary', PLACEHOLDERS.secondary),
      // Left empty, the tertiary is the recipe's fixed set (the DDS neutrals in the DDS recipe).
      color('Tertiary', 'tertiary', brand.recipe?.tertiaryDefault?.base ?? PLACEHOLDERS.tertiary),
    ]),
    row('Name', name),
  );
}

/* Recipe -------------------------------------------------------------------- */

function recipeRulesCard(recipe: BrandRecipe): HTMLElement {
  const exportButton = el('button', { textContent: 'Export' });
  exportButton.onclick = () => {
    const name = brand.input.name.trim() || brand.imported?.name || 'recipe';
    const filename = `${brandSlug(name)}-recipe.json`;
    downloadText(filename, recipeToJson(recipe, { name }));
    setStatus(`Exported ${filename}`);
  };

  // Section actions sit on the heading row, Figma style: reset (only after an edit),
  // clear, import and export.
  const actions: HTMLElement[] = [];
  const imported = brand.imported;
  if (imported) {
    const reset = el('button', { textContent: 'Reset', title: `Back to ${imported.name}, as imported` });
    reset.onclick = () => {
      brand.recipe = clone(imported.recipe);
      renderBrandPanel();
      refreshBrand();
    };
    resetRow = reset;
    actions.push(reset);
    syncReset();
  } else {
    resetRow = null;
  }
  // Clear drops the recipe (and its saved copy) and returns the tool to its empty start.
  const clear = el('button', { textContent: 'Clear', title: 'Remove the current recipe' });
  clear.onclick = () => {
    brand.recipe = null;
    brand.imported = null;
    render();
    saveBrand();
    setStatus('Removed the recipe');
  };
  actions.push(clear, importButton('Import'), exportButton);

  const strips = el('div', { className: 'strips' });
  stripsHost = strips;
  renderBrandPreview();

  // The two rules that are not slots, drawn like the strips so the column reads as one:
  // same label width, bar height, dot and gap, with the value printed in the bar.
  const onColor = stripSlider(
    'On-color',
    recipe.onContrast,
    1,
    Math.max(7, recipe.onContrast),
    0.1,
    (v) => `${v.toFixed(1)}:1`,
    // A ratio, not a color: a plain neutral bar.
    () => 'var(--color-bg-secondary)',
    () => '#fff',
    (v) => {
      recipe.onContrast = v;
      applyRecipeEdit();
    },
  );
  const alphaMax = Math.max(50, Math.round(recipe.alpha * 100));
  // Opacity, not any group's color: neutral black fading in over a checkerboard. It applies
  // to every base-alpha-12 slot, primary and secondary alike.
  const alpha = stripSlider(
    'Alpha',
    Math.round(recipe.alpha * 100),
    0,
    alphaMax,
    1,
    (v) => `${Math.round(v)}%`,
    () =>
      `linear-gradient(to right, ${withAlpha('#000000', 0)}, ${withAlpha('#000000', alphaMax / 100)}), ` +
      'repeating-conic-gradient(#ddd 0 25%, #fff 0 50%) 0 0 / 8px 8px',
    (v) => withAlpha('#000000', v / 100),
    (v) => {
      recipe.alpha = v / 100;
      applyRecipeEdit();
    },
  );

  return el('div', { className: 'card' }, [
    el('div', { className: 'card-head' }, [el('div', { className: 'head-actions' }, actions)]),
    el('div', { className: 'recipe-rows' }, [strips, onColor, alpha]),
  ]);
}

function withAlpha(hex: string, alpha: number): string {
  const c = parseHex(hex) ?? { r: 0, g: 0, b: 0 };
  return `rgb(${Math.round(c.r * 255)} ${Math.round(c.g * 255)} ${Math.round(c.b * 255)} / ${alpha})`;
}

/**
 * A range input dressed as a strip: the bar is `track()`, the thumb a dot filled with
 * `dot(value)`, and the value is printed at the bar's right end.
 */
function stripSlider(
  label: string,
  value: number,
  min: number,
  max: number,
  step: number,
  format: (v: number) => string,
  track: () => string,
  dot: (v: number) => string,
  onInput: (v: number) => void,
): HTMLElement {
  const name = el('span', { className: 'name', textContent: label });
  const readout = el('span', { className: 'strip-value' });
  const input = el('input', {
    type: 'range',
    className: 'strip-range',
    min: String(min),
    max: String(max),
    step: String(step),
    value: String(value),
  });
  const paint = () => {
    const v = Number(input.value);
    input.style.setProperty('--track', track());
    input.style.setProperty('--dot', dot(v));
    input.title = `${label} ${format(v)}`;
    readout.textContent = format(v);
  };
  input.oninput = () => {
    onInput(Number(input.value));
    paint();
  };
  paint();
  return el('div', { className: 'spectrum-row' }, [name, el('div', { className: 'strip-field' }, [input, readout])]);
}

/** A recipe-wide rule changed: regenerate without rebuilding any control. */
function applyRecipeEdit() {
  regenerate();
  placeMarkers();
  renderThemeList();
  syncBrandActions();
  syncReset();
  saveBrand();
}

/** The reset button, shown only while the recipe differs from the file it was imported from. */
let resetRow: HTMLElement | null = null;

function syncReset() {
  if (!resetRow) return;
  const edited = JSON.stringify(brand.recipe) !== JSON.stringify(brand.imported?.recipe);
  resetRow.style.display = edited ? '' : 'none';
}

/* Theme --------------------------------------------------------------------- */

/** Copy text through a throwaway textarea: the async clipboard API is blocked in Figma's iframe. */
function copyText(text: string) {
  const area = el('textarea', { value: text, className: 'clipboard', readOnly: true });
  document.body.append(area);
  area.select();
  document.execCommand('copy');
  area.remove();
}

function themeCard(theme: BrandTheme): HTMLElement {
  const copy = el('button', { textContent: 'Copy JSON' });
  copy.onclick = () => {
    copyText(brandThemeToJson(theme));
    setStatus('Copied the theme JSON');
  };
  const card = el('div', { className: 'card' }, [
    el('div', { className: 'card-head' }, [el('div', { className: 'head-actions' }, [copy])]),
  ]);
  for (const group of BRAND_GROUPS) {
    card.append(el('div', { className: 'token-group', textContent: GROUP_LABELS[group] }));
    for (const slot of theme.slots.filter((s) => s.group === group)) {
      const chip = el('span', { className: 'chip' });
      const { r, g, b, a } = slot.rgb;
      chip.style.setProperty(
        '--chip',
        `rgb(${Math.round(r * 255)} ${Math.round(g * 255)} ${Math.round(b * 255)} / ${a})`,
      );
      const value = a < 1 ? `${slot.hex} ${Math.round(a * 100)}%` : slot.hex;
      card.append(
        el('div', { className: 'token', title: slot.usage }, [
          chip,
          el('span', { className: 'key', textContent: slot.key }),
          el('span', { className: 'hex', textContent: value }),
          el('span', { className: 'step', textContent: stepLabel(slot.step) }),
        ]),
      );
    }
  }
  return card;
}

/** One panel: the recipe's controls, then the theme they produce. */
function renderBrandPanel() {
  panelsEl.innerHTML = '';
  stripsHost = null;
  themeHost = null;
  const recipe = brand.recipe;
  if (!recipe) {
    panelsEl.append(
      emptyState(
        'No recipe yet. Import a recipe file to start; it is kept in the plugin on this ' +
          'computer, so it is still here next time.',
        [importButton()],
      ),
    );
    return;
  }
  themeHost = el('div', { className: 'theme-host' });
  panelsEl.append(recipeRulesCard(recipe), themeHost);
  renderThemeList();
}

/** The theme list, or what is still missing before there is one. */
function renderThemeList() {
  if (!themeHost) return;
  themeHost.innerHTML = '';
  themeHost.append(brandTheme ? themeCard(brandTheme) : emptyState(brandError || brandNotice));
}

function renderBrandFooter() {
  const variables = el('button', { className: 'primary', textContent: 'Create variables' });
  variables.onclick = () => brandTheme && send({ type: 'create-brand-variables', theme: brandTheme });

  const doc = el('button', { textContent: 'Create documentation' });
  doc.onclick = () => brandTheme && send({ type: 'create-brand-doc', theme: brandTheme });

  brandActions.splice(0, brandActions.length, doc, variables);
  syncBrandActions();
  footerEl.innerHTML = '';
  footerEl.append(el('div', { className: 'actions' }, [doc, variables]));
}

/** Nothing to create until there is a theme. */
function syncBrandActions() {
  for (const button of brandActions) button.disabled = !brandTheme;
}

function renderBrand() {
  regenerate();
  // The Brand tool keeps its strips in the Recipe tab; the top preview is the Curves ramp's.
  previewEl.innerHTML = '';
  renderBrandForm();
  renderBrandTabs();
  renderBrandPanel();
  renderBrandFooter();
  notifyBrandError();
}

/** Toast a theme error once when it appears, not again on every keystroke while it lasts. */
let shownBrandError = '';
function notifyBrandError() {
  if (brandError && brandError !== shownBrandError) setStatus(brandError, true);
  shownBrandError = brandError;
}

/** Cheap path for the Brand tool: recolor the preview and keep the controls in place. */
function refreshBrand() {
  regenerate();
  renderBrandPreview();
  renderThemeList();
  syncBrandActions();
  syncReset();
  notifyBrandError();
  saveBrand();
}

/* -------------------------------------------------------------------------- */
/* Update cycles                                                               */
/* -------------------------------------------------------------------------- */

/** Full rebuild: use when the set of controls changes. */
function render() {
  renderTool();
  if (tool === 'brand') {
    renderBrand();
    return;
  }
  formEl.innerHTML = '';
  stops = generatePalette(config);
  renderPreview();
  renderTabs();
  renderPanel();
  renderFooter();
  send({ type: 'save-config', config });
}

/** Cheap path: recolor the preview and refresh the export without touching controls. */
function refresh() {
  stops = generatePalette(config);
  renderPreview();
  refreshExport();
  send({ type: 'save-config', config });
}

function refreshExport() {
  const textarea = document.getElementById('export') as HTMLTextAreaElement | null;
  if (textarea) textarea.value = exportText();
}

/* -------------------------------------------------------------------------- */
/* Window resizing                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Figma gives plugins no native window resizing and no resize event, so the only
 * lever is figma.ui.resize(). The iframe edges act as the drag targets. They carry
 * a resize cursor and nothing else, so there is no grip icon in the corner.
 */
const SIZE_LIMITS = { minWidth: 260, minHeight: 320, maxWidth: 1600, maxHeight: 1600 };

function clampSize(size: WindowSize): WindowSize {
  return {
    width: Math.round(
      Math.min(SIZE_LIMITS.maxWidth, Math.max(SIZE_LIMITS.minWidth, size.width)),
    ),
    height: Math.round(
      Math.min(SIZE_LIMITS.maxHeight, Math.max(SIZE_LIMITS.minHeight, size.height)),
    ),
  };
}

function initResize() {
  const zones: Array<[string, 'x' | 'y' | 'both']> = [
    ['grab-x', 'x'],
    ['grab-y', 'y'],
    ['grab-xy', 'both'],
  ];

  for (const [id, axis] of zones) {
    const zone = document.getElementById(id);
    if (!zone) continue;

    zone.addEventListener('pointerdown', (event: PointerEvent) => {
      event.preventDefault();
      zone.setPointerCapture(event.pointerId);

      const startX = event.screenX;
      const startY = event.screenY;
      const startWidth = window.innerWidth;
      const startHeight = window.innerHeight;
      document.body.dataset.resizing = 'true';

      let frame = 0;
      let pending: WindowSize | null = null;

      const flush = () => {
        frame = 0;
        if (pending) send({ type: 'resize', size: pending, commit: false });
        pending = null;
      };

      const onMove = (move: PointerEvent) => {
        pending = clampSize({
          width: axis === 'y' ? startWidth : startWidth + (move.screenX - startX),
          height: axis === 'x' ? startHeight : startHeight + (move.screenY - startY),
        });
        // Coalesce to one resize per frame; the sandbox round trip is not free.
        if (!frame) frame = requestAnimationFrame(flush);
      };

      const onUp = () => {
        zone.removeEventListener('pointermove', onMove);
        zone.removeEventListener('pointerup', onUp);
        zone.removeEventListener('pointercancel', onUp);
        if (frame) cancelAnimationFrame(frame);
        delete document.body.dataset.resizing;
        // Commit the final size so it is the one that gets remembered.
        send({
          type: 'resize',
          size: clampSize({ width: window.innerWidth, height: window.innerHeight }),
          commit: true,
        });
      };

      zone.addEventListener('pointermove', onMove);
      zone.addEventListener('pointerup', onUp);
      zone.addEventListener('pointercancel', onUp);
    });
  }
}

window.onmessage = (event: MessageEvent) => {
  const message = event.data?.pluginMessage as PluginToUi | undefined;
  if (!message) return;
  if (message.type === 'restore-config') {
    // Each part restores on its own; an empty restore must leave the defaults alone.
    let changed = false;
    if (message.config) {
      config = message.config;
      changed = true;
    }
    if (message.brand) {
      brand = restoreBrand(message.brand);
      changed = true;
    }
    if (message.tool === 'curves' || message.tool === 'brand') {
      tool = message.tool;
      changed = true;
    }
    if (changed) render();
  }
};

initResize();
render();
