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
  BrandTheme,
  DDS_RECIPE,
  SlotRule,
  brandThemeToJson,
  generateBrandTheme,
  parseHex,
  spectrum,
  stepLabel,
} from '../../src/brand';
import { Channel, PRESET_LIST, PresetId } from '../../src/curves';
import { rgbToHex } from '../../src/oklch';
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
const tabsEl = document.getElementById('tabs') as HTMLDivElement;
const panelsEl = document.getElementById('panels') as HTMLDivElement;
const footerEl = document.getElementById('footer') as HTMLDivElement;

function send(message: UiToPlugin) {
  parent.postMessage({ pluginMessage: message }, '*');
}

function setStatus(text: string, isError = false) {
  const el = document.getElementById('status');
  if (!el) return;
  el.textContent = text;
  el.dataset.error = String(isError);
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
    el('div', { id: 'status' }),
  );
}

/* -------------------------------------------------------------------------- */
/* Brand tool                                                                  */
/* -------------------------------------------------------------------------- */

type BrandTab = 'colors' | 'recipe' | 'theme';

const BRAND_TAB_LABELS: Record<BrandTab, string> = {
  colors: 'Colors',
  recipe: 'Recipe',
  theme: 'Theme',
};

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

const DEFAULT_COLLECTION = '🌈 Theme';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function defaultBrand(): BrandSettings {
  return {
    input: { name: 'New brand', primary: '#ED1944', secondary: '#1672DD', tertiary: '', gradient: '' },
    recipe: clone(DDS_RECIPE),
    collectionName: DEFAULT_COLLECTION,
  };
}

/** Settings saved by an older build may lack fields; fill the gaps from the defaults. */
function restoreBrand(saved: BrandSettings): BrandSettings {
  const fallback = defaultBrand();
  const r = saved.recipe;
  const recipeOk = Boolean(
    r?.primary?.['tint-3'] &&
      r?.secondary?.['tint-2'] &&
      r?.tertiary?.['shade-1'] &&
      typeof r?.onContrast === 'number' &&
      typeof r?.alpha === 'number',
  );
  return {
    input: { ...fallback.input, ...saved.input },
    recipe: recipeOk ? r : fallback.recipe,
    collectionName: saved.collectionName || fallback.collectionName,
  };
}

let tool: Tool = 'curves';
let brandTab: BrandTab = 'colors';
let brand: BrandSettings = defaultBrand();
let brandTheme: BrandTheme = generateBrandTheme(brand.input, brand.recipe);
let brandError = '';
let saveTimer: ReturnType<typeof setTimeout> | null = null;

/** Debounced: a color picker drag fires dozens of inputs a second. */
function saveBrand() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    send({ type: 'save-brand', brand, tool });
  }, 200);
}

/** Keep the last good theme when an input is invalid, and say why. */
function regenerate() {
  try {
    brandTheme = generateBrandTheme(brand.input, brand.recipe);
    brandError = '';
  } catch (error) {
    brandError = error instanceof Error ? error.message : String(error);
  }
}

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

/** One spectrum per group: the white -> base -> black path, a marker on every slot. */
function renderBrandPreview() {
  const meta = el('div', { className: 'meta' });
  const summary = () => {
    meta.innerHTML = '';
    meta.append(
      el('span', { textContent: brandTheme.name }),
      el('span', { textContent: `${brandTheme.slots.length} colors + theme name` }),
    );
  };

  const rows = el('div', { className: 'spectra' });
  for (const group of BRAND_GROUPS) {
    const base = brandTheme.slots.find((s) => s.group === group && s.part === 'base');
    if (!base) continue;

    const bar = el('div', { className: 'spectrum' });
    const path = spectrum(base.hex, 2).map((p) => `${p.hex} ${p.step.toFixed(2)}%`);
    bar.style.background = `linear-gradient(to right, ${path.join(', ')})`;

    for (const part of BRAND_LIGHT_TO_DARK[group]) {
      const slot = brandTheme.slots.find((s) => s.group === group && s.part === part);
      if (!slot) continue;
      const marker = el('span', {
        className: 'marker',
        title: `${slot.key}  ${slot.hex}  step ${stepLabel(slot.step)}`,
      });
      marker.dataset.key = slot.key;
      marker.style.left = `${slot.step}%`;
      marker.style.background = slot.hex;
      marker.onmouseenter = () => {
        meta.innerHTML = '';
        meta.append(
          el('span', { textContent: `${slot.key}  ${slot.hex}` }),
          el('span', { textContent: `step ${stepLabel(slot.step)}` }),
        );
      };
      bar.append(marker);
    }
    bar.onmouseleave = summary;

    rows.append(
      el('div', { className: 'spectrum-row' }, [
        el('span', { className: 'name', textContent: GROUP_LABELS[group] }),
        bar,
      ]),
    );
  }
  summary();

  previewEl.innerHTML = '';
  previewEl.append(el('div', { className: 'card' }, [rows, meta]));
}

function renderBrandTabs() {
  tabsEl.innerHTML = '';
  for (const tab of ['colors', 'recipe', 'theme'] as BrandTab[]) {
    const button = el('button', { className: 'tab', textContent: BRAND_TAB_LABELS[tab] });
    button.setAttribute('aria-selected', String(tab === brandTab));
    button.onclick = () => {
      brandTab = tab;
      renderBrandTabs();
      renderBrandPanel();
    };
    tabsEl.append(button);
  }
}

/** A native color picker paired with a hex field; either one drives the other. */
function colorField(value: string, onChange: (hex: string) => void): HTMLElement {
  let current = rgbToHex(parseHex(value) ?? { r: 0, g: 0, b: 0 });
  const picker = el('input', { type: 'color', value: current.toLowerCase() });
  const text = el('input', { type: 'text', value: current, spellcheck: false });

  picker.oninput = () => {
    current = picker.value.toUpperCase();
    text.value = current;
    onChange(current);
  };
  // Commit on change, like the number fields: half-typed hex is not a color yet.
  text.onchange = () => {
    const rgb = parseHex(text.value);
    if (!rgb) {
      setStatus(`"${text.value.trim()}" is not a hex color`, true);
      text.value = current;
      return;
    }
    current = rgbToHex(rgb);
    text.value = current;
    picker.value = current.toLowerCase();
    onChange(current);
  };
  return el('div', { className: 'color-field' }, [picker, text]);
}

/** Tertiary and gradient: off by default (DDS behaviour), or a custom color. */
function optionalColorRow(
  label: string,
  offLabel: string,
  key: 'tertiary' | 'gradient',
  fallback: () => string,
): HTMLElement {
  const value = brand.input[key]?.trim() ?? '';
  const select = el('select');
  select.append(
    el('option', { value: 'off', textContent: offLabel }),
    el('option', { value: 'custom', textContent: 'Custom' }),
  );
  select.value = value ? 'custom' : 'off';
  select.onchange = () => {
    brand.input[key] = select.value === 'custom' ? fallback() : '';
    renderBrandPanel();
    refreshBrand();
  };

  const controls: Node[] = [el('div', { className: 'select-wrap' }, [select])];
  if (value) {
    controls.push(
      colorField(value, (hex) => {
        brand.input[key] = hex;
        refreshBrand();
      }),
    );
  }
  return row(label, ...controls);
}

function brandColorsCard(): HTMLElement {
  const name = el('input', { type: 'text', value: brand.input.name });
  name.oninput = () => {
    brand.input.name = name.value;
    refreshBrand();
  };

  return el('div', { className: 'card' }, [
    el('h2', { textContent: 'Brand' }),
    row('Name', name),
    row(
      'Primary',
      colorField(brand.input.primary, (hex) => {
        brand.input.primary = hex;
        refreshBrand();
      }),
    ),
    row(
      'Secondary',
      colorField(brand.input.secondary, (hex) => {
        brand.input.secondary = hex;
        refreshBrand();
      }),
    ),
    optionalColorRow('Tertiary', 'DDS neutrals', 'tertiary', () => '#333333'),
    optionalColorRow('Gradient', 'Same as primary', 'gradient', () => brand.input.primary),
  ]);
}

function brandVariablesCard(): HTMLElement {
  const input = el('input', { type: 'text', value: brand.collectionName });
  input.oninput = () => {
    brand.collectionName = input.value;
    saveBrand();
  };
  return el('div', { className: 'card' }, [
    el('h2', { textContent: 'Variables' }),
    row('Collection', input),
    el('p', {
      className: 'note',
      textContent:
        'One theme layer named as in the DDS (primary/primary-tint-1 and so on), in a mode ' +
        'named after the brand. Another brand adds a mode; the same brand updates its own.',
    }),
  ]);
}

function ruleRow(label: string, rule: SlotRule, onChange: (rule: SlotRule) => void): HTMLElement {
  if (rule.kind === 'step') {
    return sliderRow(
      label,
      rule.step,
      0,
      100,
      1,
      (v) => onChange({ kind: 'step', step: v }),
      (v) => `step ${stepLabel(Math.round(v))}`,
    );
  }
  return sliderRow(
    label,
    Math.round(rule.amount * 100),
    0,
    100,
    1,
    (v) => onChange({ kind: 'mix', amount: v / 100 }),
    (v) => `${Math.round(v)}%`,
  );
}

function recipeGroupCard(group: BrandGroup): HTMLElement {
  const rules = brand.recipe[group] as Record<string, SlotRule>;
  const title = group === 'tertiary' ? 'Tertiary (custom color only)' : GROUP_LABELS[group];
  const card = el('div', { className: 'card' }, [el('h2', { textContent: title })]);
  for (const part of Object.keys(rules)) {
    card.append(
      ruleRow(PART_LABELS[part] ?? part, rules[part], (rule) => {
        rules[part] = rule;
        refreshBrand();
      }),
    );
  }
  return card;
}

function recipeRulesCard(): HTMLElement {
  const reset = el('button', { textContent: 'Reset to the DDS fit' });
  reset.onclick = () => {
    brand.recipe = clone(DDS_RECIPE);
    renderBrandPanel();
    refreshBrand();
  };
  return el('div', { className: 'card' }, [
    el('h2', { textContent: 'Recipe' }),
    el('p', {
      className: 'note',
      textContent:
        'A step mixes until the color lands on that DDS step; a percentage is the share of ' +
        'white in a tint or of black in a shade. White text from the on-color contrast up. ' +
        'The defaults are fitted to the 20 DDS brand themes.',
    }),
    sliderRow(
      'On-color',
      brand.recipe.onContrast,
      1,
      7,
      0.1,
      (v) => {
        brand.recipe.onContrast = v;
        refreshBrand();
      },
      (v) => `${v.toFixed(1)}:1`,
    ),
    sliderRow(
      'Alpha',
      Math.round(brand.recipe.alpha * 100),
      1,
      50,
      1,
      (v) => {
        brand.recipe.alpha = v / 100;
        refreshBrand();
      },
      (v) => `${Math.round(v)}%`,
    ),
    el('div', { className: 'linkrow' }, [reset]),
  ]);
}

function themeCard(): HTMLElement {
  const card = el('div', { className: 'card' }, [el('h2', { textContent: `${brandTheme.name} theme` })]);
  for (const group of BRAND_GROUPS) {
    card.append(el('div', { className: 'token-group', textContent: GROUP_LABELS[group] }));
    for (const slot of brandTheme.slots.filter((s) => s.group === group)) {
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
  card.append(
    el('div', { className: 'token-group', textContent: 'Root' }),
    el('div', { className: 'token' }, [
      el('span', { className: 'chip text', textContent: 'Aa' }),
      el('span', { className: 'key', textContent: 'theme' }),
      el('span', { className: 'hex', textContent: brandTheme.name }),
    ]),
  );
  return card;
}

function brandExportCard(): HTMLElement {
  const textarea = el('textarea', { readOnly: true, id: 'brand-export' });
  textarea.value = brandThemeToJson(brandTheme);
  const copy = el('button', { textContent: 'Copy JSON' });
  copy.onclick = () => {
    textarea.select();
    document.execCommand('copy');
    setStatus('Copied the theme JSON');
  };
  return el('div', { className: 'card' }, [
    el('h2', { textContent: 'Export' }),
    textarea,
    el('div', { className: 'linkrow' }, [copy]),
  ]);
}

function renderBrandPanel() {
  panelsEl.innerHTML = '';
  if (brandTab === 'colors') {
    panelsEl.append(brandColorsCard(), brandVariablesCard());
  } else if (brandTab === 'recipe') {
    panelsEl.append(
      recipeRulesCard(),
      recipeGroupCard('primary'),
      recipeGroupCard('secondary'),
      recipeGroupCard('tertiary'),
    );
  } else {
    panelsEl.append(themeCard(), brandExportCard());
  }
}

function renderBrandFooter() {
  const collectionName = () => brand.collectionName.trim() || DEFAULT_COLLECTION;

  const variables = el('button', { className: 'primary', textContent: 'Create variables' });
  variables.onclick = () => {
    if (brandError) return setStatus(brandError, true);
    send({ type: 'create-brand-variables', theme: brandTheme, collectionName: collectionName() });
  };

  const doc = el('button', { textContent: 'Create documentation' });
  doc.onclick = () => {
    if (brandError) return setStatus(brandError, true);
    send({ type: 'create-brand-doc', theme: brandTheme, collectionName: collectionName() });
  };

  footerEl.innerHTML = '';
  footerEl.append(el('div', { className: 'actions' }, [doc, variables]), el('div', { id: 'status' }));
}

function renderBrand() {
  regenerate();
  renderBrandPreview();
  renderBrandTabs();
  renderBrandPanel();
  renderBrandFooter();
  if (brandError) setStatus(brandError, true);
}

/** Cheap path for the Brand tool: recolor the preview and keep the controls in place. */
function refreshBrand() {
  regenerate();
  renderBrandPreview();
  if (brandTab === 'theme') renderBrandPanel();
  setStatus(brandError, Boolean(brandError));
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
  if (message.type === 'done') setStatus(message.message);
  if (message.type === 'error') setStatus(message.message, true);
};

initResize();
render();
