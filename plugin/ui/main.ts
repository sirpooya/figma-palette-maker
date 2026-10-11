/**
 * UI iframe entry. Owns the controls and the live preview; the sandbox owns the document.
 * The engine in ../../src is platform-agnostic, so the exact same code runs on both sides.
 *
 * Layout: the preview and the action footer are pinned, and only the middle panel
 * scrolls. Controls are grouped into tabs rather than one long column, and every
 * slider gets its own row, because a range input has an intrinsic min-width of
 * roughly 130px and two of them will not fit side by side in a 420px panel.
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
import { PluginToUi, UiToPlugin, WindowSize } from '../messages';

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
): HTMLElement {
  const decimals = step >= 1 ? 0 : step >= 0.01 ? 2 : 4;
  const fmt = (v: number) => (decimals === 0 ? String(Math.round(v)) : v.toFixed(decimals));

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
/* Update cycles                                                               */
/* -------------------------------------------------------------------------- */

/** Full rebuild: use when the set of controls changes. */
function render() {
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
  if (message.type === 'restore-config' && message.config) {
    config = message.config;
    render();
  }
  if (message.type === 'done') setStatus(message.message);
  if (message.type === 'error') setStatus(message.message, true);
};

initResize();
render();
