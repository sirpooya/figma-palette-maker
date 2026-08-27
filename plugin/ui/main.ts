/**
 * UI iframe entry. Owns the controls and the live preview; the sandbox owns the document.
 * The engine in ../../src is platform-agnostic, so the exact same code runs on both sides.
 */

import { Channel, PRESET_LIST, PresetId } from '../../src/curves';
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
import { PluginToUi, UiToPlugin } from '../messages';

const CHANNEL_LABELS: Record<Channel, string> = {
  l: 'Lightness',
  c: 'Chroma',
  h: 'Hue',
};

const CHANNEL_STEP: Record<Channel, number> = { l: 0.01, c: 0.001, h: 0.1 };

let config: PaletteConfig = defaultConfig();
let stops: PaletteStop[] = [];
let exportFormat: 'css' | 'json' = 'css';
let naming = { collectionName: 'Core', groupName: 'gray', modeName: 'Value' };

const app = document.getElementById('app') as HTMLDivElement;

function send(message: UiToPlugin) {
  parent.postMessage({ pluginMessage: message }, '*');
}

function setStatus(text: string, isError = false) {
  const el = document.getElementById('status');
  if (!el) return;
  el.textContent = text;
  el.dataset.error = String(isError);
}

/* -------------------------------------------------------------------------- */
/* Controls                                                                    */
/* -------------------------------------------------------------------------- */

function numberRow(
  label: string,
  value: number,
  step: number,
  onChange: (v: number) => void,
): HTMLElement {
  const row = document.createElement('div');
  row.className = 'row';
  const l = document.createElement('label');
  l.textContent = label;
  const input = document.createElement('input');
  input.type = 'number';
  input.step = String(step);
  input.value = String(Number(value.toFixed(4)));
  input.oninput = () => {
    const v = Number(input.value);
    if (Number.isFinite(v)) onChange(v);
  };
  row.append(l, input);
  return row;
}

function sliderRow(
  label: string,
  value: number,
  min: number,
  max: number,
  step: number,
  onChange: (v: number) => void,
): HTMLElement {
  const row = document.createElement('div');
  row.className = 'row';
  const l = document.createElement('label');
  l.textContent = label;
  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  const out = document.createElement('span');
  out.className = 'value';
  const fmt = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(step < 0.01 ? 4 : 2));
  out.textContent = fmt(value);
  input.oninput = () => {
    const v = Number(input.value);
    out.textContent = fmt(v);
    onChange(v);
  };
  row.append(l, input, out);
  return row;
}

function channelCard(channel: Channel): HTMLElement {
  const cfg = config[channel];
  const card = document.createElement('div');
  card.className = 'card';

  const heading = document.createElement('h2');
  heading.textContent = CHANNEL_LABELS[channel];
  card.append(heading);

  const presetRow = document.createElement('div');
  presetRow.className = 'row';
  const presetLabel = document.createElement('label');
  presetLabel.textContent = 'Curve';
  const select = document.createElement('select');
  for (const preset of PRESET_LIST[channel]) {
    const option = document.createElement('option');
    option.value = preset.id;
    option.textContent = preset.label;
    option.selected = preset.id === cfg.preset;
    select.append(option);
  }
  select.onchange = () => {
    config[channel] = reanchorChannel(channel, select.value as PresetId, cfg.min, cfg.max);
    render();
  };
  presetRow.append(presetLabel, select);
  card.append(presetRow);

  const equation = PRESET_LIST[channel].find((p) => p.id === cfg.preset)?.equation ?? '';
  const eq = document.createElement('div');
  eq.className = 'meta';
  eq.textContent = equation;
  card.append(eq);

  const step = CHANNEL_STEP[channel];
  card.append(
    numberRow('Min', cfg.min, step, (v) => {
      config[channel] = reanchorChannel(channel, cfg.preset, v, config[channel].max);
      render();
    }),
    numberRow('Max', cfg.max, step, (v) => {
      config[channel] = reanchorChannel(channel, cfg.preset, config[channel].min, v);
      render();
    }),
  );

  // Live parameter sliders, straight off the preset's own spec.
  const specs = PRESET_LIST[channel].find((p) => p.id === cfg.preset)?.params ?? [];
  if (specs.length) {
    const grid = document.createElement('div');
    grid.className = 'params';
    for (const spec of specs) {
      const current = cfg.params[spec.name] ?? spec.default;
      grid.append(
        sliderRow(spec.label, current, spec.min, spec.max, spec.step, (v) => {
          config[channel].params[spec.name] = v;
          refresh();
        }),
      );
    }
    card.append(grid);
  }

  return card;
}

/* -------------------------------------------------------------------------- */
/* Render                                                                      */
/* -------------------------------------------------------------------------- */

function rampView(): HTMLElement {
  const wrap = document.createElement('div');
  const ramp = document.createElement('div');
  ramp.className = 'ramp';
  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.innerHTML = '<span></span><span></span>';

  for (const stop of stops) {
    const cell = document.createElement('div');
    cell.style.background = stop.hex;
    cell.title = `${stop.token}  ${stop.hex}  ${stop.oklch}`;
    cell.onmouseenter = () => {
      meta.innerHTML = '';
      const left = document.createElement('span');
      left.textContent = `${stop.token}  ${stop.hex}`;
      const right = document.createElement('span');
      right.textContent = stop.oklch;
      meta.append(left, right);
    };
    ramp.append(cell);
  }
  ramp.onmouseleave = () => {
    meta.innerHTML = `<span>${stops.length} stops</span><span>${stops[0]?.token} to ${
      stops[stops.length - 1]?.token
    }</span>`;
  };
  ramp.onmouseleave(new MouseEvent('mouseleave'));

  wrap.append(ramp, meta);
  return wrap;
}

function render() {
  stops = generatePalette(config);
  app.innerHTML = '';

  const preview = document.createElement('div');
  preview.className = 'card';
  preview.append(rampView());
  app.append(preview);

  const ramp = document.createElement('div');
  ramp.className = 'card';
  const rampHeading = document.createElement('h2');
  rampHeading.textContent = 'Ramp';
  ramp.append(
    rampHeading,
    sliderRow('Stops', config.stops, MIN_STOPS, MAX_STOPS, 1, (v) => {
      config.stops = v;
      config.stopOverrides = [];
      refresh();
    }),
    numberRow('Token start', config.tokenStart, 1, (v) => {
      config.tokenStart = v;
      refresh();
    }),
  );
  app.append(ramp);

  app.append(channelCard('l'), channelCard('c'), channelCard('h'));

  // Naming + actions
  const out = document.createElement('div');
  out.className = 'card';
  const outHeading = document.createElement('h2');
  outHeading.textContent = 'Output';
  out.append(outHeading);

  for (const key of ['collectionName', 'groupName', 'modeName'] as const) {
    const row = document.createElement('div');
    row.className = 'row';
    const label = document.createElement('label');
    label.textContent = { collectionName: 'Collection', groupName: 'Group', modeName: 'Mode' }[key];
    const input = document.createElement('input');
    input.type = 'text';
    input.value = naming[key];
    input.oninput = () => {
      naming[key] = input.value;
    };
    row.append(label, input);
    out.append(row);
  }

  const actions = document.createElement('div');
  actions.className = 'actions';
  actions.style.marginTop = '8px';

  const variables = document.createElement('button');
  variables.className = 'primary';
  variables.textContent = 'Create variables';
  variables.onclick = () =>
    send({
      type: 'create-variables',
      stops,
      collectionName: naming.collectionName.trim() || 'Core',
      groupName: naming.groupName.trim() || 'gray',
      modeName: naming.modeName.trim() || 'Value',
    });

  const swatches = document.createElement('button');
  swatches.textContent = 'Create swatches';
  swatches.onclick = () => send({ type: 'create-swatches', stops, label: true });

  actions.append(variables, swatches);
  out.append(actions);

  const status = document.createElement('div');
  status.id = 'status';
  out.append(status);
  app.append(out);

  // Export
  const exportCard = document.createElement('div');
  exportCard.className = 'card';
  const exportHeading = document.createElement('h2');
  exportHeading.textContent = 'Export';
  const toggle = document.createElement('div');
  toggle.className = 'actions';
  toggle.style.marginBottom = '6px';
  for (const format of ['css', 'json'] as const) {
    const button = document.createElement('button');
    button.textContent = format.toUpperCase();
    if (format === exportFormat) button.className = 'primary';
    button.onclick = () => {
      exportFormat = format;
      render();
    };
    toggle.append(button);
  }
  const textarea = document.createElement('textarea');
  textarea.readOnly = true;
  const name = naming.groupName.trim() || 'gray';
  textarea.value =
    exportFormat === 'css' ? toCssVariables(stops, name) : toJson(stops, name);

  const copy = document.createElement('button');
  copy.textContent = 'Copy';
  copy.style.marginTop = '6px';
  copy.style.width = '100%';
  copy.onclick = () => {
    textarea.select();
    document.execCommand('copy');
    setStatus(`Copied ${exportFormat.toUpperCase()} to clipboard`);
  };

  exportCard.append(exportHeading, toggle, textarea, copy);
  app.append(exportCard);

  send({ type: 'save-config', config });
}

/** Cheap path: regenerate the ramp without rebuilding every control. */
function refresh() {
  stops = generatePalette(config);
  const preview = app.querySelector('.card');
  if (preview) {
    preview.innerHTML = '';
    preview.append(rampView());
  }
  const textarea = app.querySelector('textarea');
  if (textarea) {
    const name = naming.groupName.trim() || 'gray';
    textarea.value =
      exportFormat === 'css' ? toCssVariables(stops, name) : toJson(stops, name);
  }
  send({ type: 'save-config', config });
}

window.onmessage = (event: MessageEvent) => {
  const message = event.data?.pluginMessage as PluginToUi | undefined;
  if (!message) return;
  if (message.type === 'restore-config' && message.config) {
    config = message.config;
    render();
  }
  if (message.type === 'done') setStatus(message.message);
  if (message.type === 'error') setStatus(message.message, true);
};

render();
