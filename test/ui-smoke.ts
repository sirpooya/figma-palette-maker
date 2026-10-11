/**
 * Smoke test the built UI: run dist/ui.html's inlined bundle against a real DOM,
 * confirm the controls render, the ramp tracks the sliders, and the buttons post
 * the messages the sandbox expects.
 *
 * Run: pnpm build && bun test/ui-smoke.ts
 */

import { readFileSync } from 'node:fs';
import { GlobalRegistrator } from '@happy-dom/global-registrator';

await GlobalRegistrator.register({ url: 'https://localhost/' });

const html = readFileSync(new URL('../dist/ui.html', import.meta.url), 'utf8');
const inlined = html.match(/<script>([\s\S]*?)<\/script>/);
if (!inlined) throw new Error('dist/ui.html has no inlined bundle. Run `pnpm build` first.');

const posted: Array<{ type: string; [key: string]: unknown }> = [];
// Mount the real shell from dist/ui.html (minus its script) so this harness cannot
// drift out of sync with the actual page structure.
document.body.innerHTML = html.replace(/<script>[\s\S]*?<\/script>/, '');
(globalThis as unknown as { parent: unknown }).parent = {
  postMessage: (envelope: { pluginMessage: { type: string } }) => posted.push(envelope.pluginMessage),
};
(document as unknown as { execCommand: () => boolean }).execCommand = () => true;

// The bundle is an IIFE, so evaluating it in global scope is exactly what Figma does.
new Function(inlined[1])();

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = String(actual) === String(expected);
  if (!ok) failures++;
  console.log(
    `${ok ? 'pass' : 'FAIL'}  ${label.padEnd(28)} ${actual}${ok ? '' : `   expected ${expected}`}`,
  );
}

const last = (type: string) => [...posted].reverse().find((m) => m.type === type);
const $ = <T extends Element>(sel: string) => document.querySelector(sel) as T | null;
const $$ = (sel: string) => Array.from(document.querySelectorAll(sel));
const tabs = () => $$('#tabs .tab') as HTMLButtonElement[];
const openTab = (label: string) => tabs().find((t) => t.textContent === label)?.click();
const ranges = () => $$('input[type="range"]') as HTMLInputElement[];
const click = (label: string) =>
  ($$('button') as HTMLButtonElement[]).find((b) => b.textContent === label)?.click();
const fire = (node: Element, type: string) =>
  node.dispatchEvent(new Event(type, { bubbles: true }));

// The shell mounts five regions; only the middle one scrolls.
check('tool switch mounted', Boolean($('#tool .toolbar')), true);
check('preview mounted', Boolean($('#preview .ramp')), true);
check('tabs mounted', tabs().length, 4);
check('footer mounted', Boolean($('#footer .actions')), true);
check('swatches rendered', $$('.ramp > div').length, 16);
check('config autosaved', Boolean(last('save-config')), true);

// Lightness opens first, showing the ramp card plus one curve card.
check('lightness tab active', tabs()[0].getAttribute('aria-selected'), 'true');
check('one curve select at a time', $$('select').length, 1);
check('equation shown', $('.equation')?.textContent?.includes('atan'), true);

// Stops is the first slider on every channel tab.
const stopsSlider = ranges()[0];
stopsSlider.value = '8';
fire(stopsSlider, 'input');
check('stops slider updates ramp', $$('.ramp > div').length, 8);

// Param sliders live below the dashed rule and must not rebuild the controls.
const params = $$('.params input[type="range"]') as HTMLInputElement[];
check('param sliders rendered', params.length >= 3, true);
// Compare the whole ramp, not stop 0: the lightest stop is usually clamped to white,
// so it can legitimately stay put while every other stop moves.
const rampColors = () => $$('.ramp > div').map((d) => (d as HTMLElement).style.background).join(',');
const beforeColors = rampColors();
const lastParam = params[params.length - 1];
lastParam.value = String((Number(lastParam.min) + Number(lastParam.max)) / 2);
fire(lastParam, 'input');
check('param slider kept controls', $$('select').length, 1);
check('param slider recolored ramp', rampColors() !== beforeColors, true);

// Every param gets its own row, which is what stops the 420px overflow.
const paramRows = $$('.params .row');
check('one param per row', paramRows.every((r) => r.querySelectorAll('input').length <= 1), true);

// Switching tabs swaps the curve panel.
openTab('Chroma');
check('chroma tab active', tabs()[1].getAttribute('aria-selected'), 'true');
check('chroma curve shown', ($('select') as HTMLSelectElement).value, 'flat');
check('ramp survives tab switch', $$('.ramp > div').length, 8);

// Changing a preset re-renders that channel's params.
const chromaSelect = $('select') as HTMLSelectElement;
chromaSelect.value = 'gaussian';
fire(chromaSelect, 'change');
check('preset switch applied', ($('select') as HTMLSelectElement).value, 'gaussian');
check('gaussian params rendered', $$('.params input[type="range"]').length >= 4, true);

// Output tab carries naming plus the export panel.
openTab('Output');
check('naming inputs', $$('input[type="text"]').length, 3);
check('css export populated', ($('textarea') as HTMLTextAreaElement).value.includes('--gray-50'), true);
click('JSON');
check('json export populated', ($('textarea') as HTMLTextAreaElement).value.includes('"token"'), true);

// Renaming the group must flow into the export text.
const groupInput = ($$('input[type="text"]') as HTMLInputElement[])[1];
groupInput.value = 'violet';
fire(groupInput, 'input');
check('group rename in export', ($('textarea') as HTMLTextAreaElement).value.includes('"violet"'), true);

// The footer actions are pinned, so they work from any tab.
click('Create variables');
const vars = last('create-variables');
check('create-variables sent', vars?.type, 'create-variables');
check('stops in payload', (vars?.stops as unknown[])?.length, 8);
check('stop carries figma rgb', typeof (vars?.stops as Array<{ rgb: { r: number } }>)?.[0]?.rgb?.r, 'number');
check('group name flows through', vars?.groupName, 'violet');

click('Create swatches');
check('create-swatches sent', last('create-swatches')?.type, 'create-swatches');

// The sandbox restores a saved config on open; a null one must not blow up.
window.dispatchEvent(
  new MessageEvent('message', { data: { pluginMessage: { type: 'restore-config', config: null } } }),
);
check('empty restore is safe', $$('.ramp > div').length, 8);

window.dispatchEvent(
  new MessageEvent('message', {
    data: { pluginMessage: { type: 'error', message: 'nope' } },
  }),
);
check('error surfaces in status', document.getElementById('status')?.textContent, 'nope');

/* -------------------------------------------------------------------------- */
/* Resizing                                                                    */
/* -------------------------------------------------------------------------- */

// Three invisible edge zones, and no grip glyph anywhere in the markup.
check('resize zones present', $$('.grab').length, 3);
check('corner zone exists', Boolean($('#grab-xy')), true);
check(
  'no grip icon drawn',
  $$('.grab').every((z) => z.textContent === '' && z.children.length === 0),
  true,
);

// Dragging the corner should stream resize messages and clamp to the minimum.
const corner = $('#grab-xy') as HTMLElement;
const pointer = (type: string, screenX: number, screenY: number) =>
  corner.dispatchEvent(
    Object.assign(new Event(type, { bubbles: true }), { pointerId: 1, screenX, screenY }),
  );

(corner as unknown as { setPointerCapture: (id: number) => void }).setPointerCapture = () => {};
(corner as unknown as { releasePointerCapture: (id: number) => void }).releasePointerCapture = () => {};

pointer('pointerdown', 500, 500);
check('resizing flag set', document.body.dataset.resizing, 'true');
pointer('pointermove', 700, 800);
await new Promise((r) => requestAnimationFrame(() => r(null)));
const grow = last('resize');
check('resize streamed while dragging', grow?.type, 'resize');
check('resize not committed mid-drag', grow?.commit, false);
check('width grew', (grow?.size as { width: number })?.width > 0, true);

// Drag far past the minimum: the UI must clamp rather than send a silly size.
pointer('pointermove', -5000, -5000);
await new Promise((r) => requestAnimationFrame(() => r(null)));
const clamped = last('resize');
check('width clamped to min', (clamped?.size as { width: number })?.width, 260);
check('height clamped to min', (clamped?.size as { height: number })?.height, 320);

pointer('pointerup', -5000, -5000);
check('resizing flag cleared', document.body.dataset.resizing, undefined);
check('final size committed', last('resize')?.commit, true);

/* -------------------------------------------------------------------------- */
/* Responsive layout                                                           */
/* -------------------------------------------------------------------------- */

// The param grid must be a single column when narrow and multi-column when wide,
// which is what the auto-fit + min(100%, 240px) floor buys.
openTab('Lightness');
// happy-dom does not run layout, so this asserts on the declared track list rather
// than measured widths. Real overflow still needs a browser to confirm.
const gridCols = getComputedStyle($('.params') as HTMLElement).gridTemplateColumns;
check('params use an auto-fit grid', gridCols.includes('auto-fit'), true);
check('params floor is overflow-safe', gridCols.includes('min(100%'), true);


/* -------------------------------------------------------------------------- */
/* Brand tool                                                                  */
/* -------------------------------------------------------------------------- */

const tools = () => $$('#tool .tool') as HTMLButtonElement[];
const marker = (key: string) => $(`.marker[data-key="${key}"]`) as HTMLElement | null;
const hexFields = () => $$('.color-field input[type="text"]') as HTMLInputElement[];
const rowNamed = (label: string) =>
  ($$('.row') as HTMLElement[]).find((r) => r.querySelector('label')?.textContent === label);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

check('tools are Curves and Brand', tools().map((t) => t.textContent).join(','), 'Curves,Brand');
check('curves is the default tool', tools()[0].getAttribute('aria-pressed'), 'true');

tools()[1].click();
check('brand tool pressed', tools()[1].getAttribute('aria-pressed'), 'true');
check('brand tabs', tabs().map((t) => t.textContent).join(','), 'Colors,Recipe,Theme');
check('one spectrum per group', $$('.spectrum').length, 3);
check('primary has six slot markers', $$('.spectrum')[0].querySelectorAll('.marker').length, 6);
check('base marker sits at its step', marker('primary-base')?.style.left, '63%');
check('tint-1 marker at step 3', marker('primary-tint-1')?.style.left, '3%');

// The hex field drives the theme.
hexFields()[0].value = '#7f53ef';
fire(hexFields()[0], 'change');
check('hex is normalized', hexFields()[0].value, '#7F53EF');
check('primary drives the spectrum', marker('primary-base')?.style.left, '55%');

hexFields()[0].value = 'not a color';
fire(hexFields()[0], 'change');
check('bad hex is refused', hexFields()[0].value, '#7F53EF');
check('bad hex is reported', document.getElementById('status')?.dataset.error, 'true');

// Tertiary starts on the DDS neutrals; picking Custom adds a color field.
const tertiarySelect = () => ($$('select') as HTMLSelectElement[])[0];
check('tertiary defaults to neutrals', tertiarySelect().value, 'off');
tertiarySelect().value = 'custom';
fire(tertiarySelect(), 'change');
check('custom tertiary adds a color field', hexFields().length, 3);

// Recipe sliders move the slots live.
openTab('Recipe');
const tint1 = rowNamed('Tint 1')?.querySelector('input[type="range"]') as HTMLInputElement;
check('recipe shows steps', rowNamed('Tint 1')?.querySelector('.value')?.textContent, 'step 03');
tint1.value = '10';
fire(tint1, 'input');
check('tint-1 slider moves the marker', marker('primary-tint-1')?.style.left, '10%');
check('mix rules read as percentages', rowNamed('Shade 1')?.querySelector('.value')?.textContent, '55%');
click('Reset to the DDS fit');
check('reset restores the fit', marker('primary-tint-1')?.style.left, '3%');

// Theme tab lists every variable, and the export has the DDS shape.
openTab('Theme');
check('theme table has 21 rows', $$('.token').length, 21);
const brandJson = JSON.parse(($('#brand-export') as HTMLTextAreaElement).value);
check('export keyed by brand', Object.keys(brandJson).join(','), 'new-brand');
check('export alpha slot', brandJson['new-brand'].primary['primary-base-alpha-12'].$value, 'rgba(127,83,239,0.12)');

click('Create variables');
const brandVars = last('create-brand-variables');
check('create-brand-variables sent', brandVars?.type, 'create-brand-variables');
check('theme carries 20 slots', (brandVars?.theme as { slots: unknown[] })?.slots?.length, 20);
check('default collection', brandVars?.collectionName, '🌈 Theme');

click('Create documentation');
check('create-brand-doc sent', last('create-brand-doc')?.type, 'create-brand-doc');

await wait(300);
const saved = last('save-brand') as { brand: { input: { primary: string } }; tool: string } | undefined;
check('brand settings saved', saved?.brand?.input?.primary, '#7F53EF');
check('tool saved', saved?.tool, 'brand');

// A restore from an older build without a recipe falls back to the fit.
window.dispatchEvent(
  new MessageEvent('message', {
    data: {
      pluginMessage: {
        type: 'restore-config',
        config: null,
        tool: 'brand',
        brand: { input: { name: 'Saved', primary: '#00a049', secondary: '#1672dd' }, collectionName: '' },
      },
    },
  }),
);
openTab('Colors');
check('restored brand name', ($('.row input[type="text"]') as HTMLInputElement).value, 'Saved');
check('restored primary', hexFields()[0].value, '#00A049');

// Back to curves: the curve tool is untouched.
tools()[0].click();
check('curves pressed again', tools()[0].getAttribute('aria-pressed'), 'true');
check('ramp is back', $$('.ramp > div').length, 8);

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
await GlobalRegistrator.unregister();
process.exit(failures === 0 ? 0 : 1);
