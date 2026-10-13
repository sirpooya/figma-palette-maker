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

// Feedback is Figma's toast: the panel asks the sandbox to notify, and shows no status line.
check('no status line in the panel', Boolean($('#status')), false);
click('Copy to clipboard');
check('feedback goes to a toast', last('notify')?.message, 'Copied JSON');

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
check('no tabs in the Brand tool', tabs().length, 0);
check('brand fields sit above the tabs', Boolean($('#form .color-field')), true);

// Empty fields fall back to their placeholders, so the starter theme shows at once.
const nameField = () => rowNamed('Name')?.querySelector('input') as HTMLInputElement;
const footerButtons = () => $$('#footer button') as HTMLButtonElement[];
const previewEmpty = () => $('#preview')?.children.length === 0;
const recipeEmptyState = () => $('#panels .empty-state button')?.textContent;
check('placeholders give a theme', $$('.spectrum').length, 3);
check('no preview without a theme', previewEmpty(), true);
check('name starts empty', nameField().value, '');
check('colors start empty', hexFields().map((f) => f.value).join(','), ',,');
check('placeholders hint the colors', hexFields().map((f) => f.placeholder).join(','), 'ED1944,1672DD,333333');
check('theme shows before a name', $$('.token-group').length > 0, true);
check('the starter recipe is loaded', recipeEmptyState(), undefined);

// Importing goes through the real file input.
const recipeInput = () => $('input[type="file"]') as HTMLInputElement;
const pick = async (name: string, text: string) => {
  Object.defineProperty(recipeInput(), 'files', {
    value: [new File([text], name, { type: 'application/json' })],
    configurable: true,
  });
  fire(recipeInput(), 'change');
  await wait(50);
};
await pick('dds.json', await Bun.file(new URL('../recipes/dds.json', import.meta.url)).text());
check('import is reported', last('notify')?.message, 'Imported dds.json: same rules as the recipe already in use');
check('still nothing to preview without colors', previewEmpty(), true);
const resetShown = (name: string) => {
  const button = ($$('button') as HTMLButtonElement[]).find((b) => b.textContent === 'Reset');
  return Boolean(button) && !button!.disabled && button!.title === `Back to ${name}, as imported`;
};
check('no reset while the recipe is as imported', resetShown('DDS fit'), false);
check('an imported file can be cleared', ($$('#panels .card button') as HTMLButtonElement[]).some((b) => b.textContent === 'Clear' && !b.disabled), true);

// The preview runs on placeholders, but Create waits for a typed name.
const looksOff = () => footerButtons().every((b) => b.getAttribute('aria-disabled') === 'true');
check('no name, Create looks disabled', looksOff(), true);
click('Create variables');
check('no name, nothing created', last('create-brand-variables'), undefined);
check('no name gets a toast', last('notify')?.message, 'Add a brand name first');
check('and the cursor goes to Name', document.activeElement, nameField());
nameField().value = 'New brand';
fire(nameField(), 'input');
check('a typed name enables Create', looksOff() || footerButtons().some((b) => b.disabled), false);
fire(nameField(), 'input');
hexFields()[0].value = '#ed1944';
fire(hexFields()[0], 'change');
check('one color typed, the other from its placeholder', $$('.spectrum').length, 3);
hexFields()[1].value = '#1672dd';
fire(hexFields()[1], 'change');
check('one spectrum per group', $$('.spectrum').length, 3);
check('primary has six slot markers', $$('.spectrum')[0].querySelectorAll('.marker').length, 6);
check('base marker sits at its step', marker('primary-base')?.style.left, '63%');
check('tint-1 marker at step 3', marker('primary-tint-1')?.style.left, '3%');
check('actions enabled once there is a theme', footerButtons().every((b) => !b.disabled), true);

// The hex field drives the theme.
hexFields()[0].value = '#7f53ef';
fire(hexFields()[0], 'change');
check('hex shows without the #', hexFields()[0].value, '7F53EF');
hexFields()[1].value = '1672dd';
fire(hexFields()[1], 'change');
check('typing without the # works', hexFields()[1].value, '1672DD');
check('primary drives the spectrum', marker('primary-base')?.style.left, '55%');

hexFields()[0].value = 'not a color';
fire(hexFields()[0], 'change');
check('bad hex is refused', hexFields()[0].value, '7F53EF');
check('bad hex is reported', last('notify')?.error, true);

// Left empty, the tertiary is the recipe's fixed set; a color runs the recipe.
check('tertiary left empty', hexFields()[2].value, '');
check('empty tertiary uses the recipe set', marker('tertiary-tint-1')?.style.left, '7%');
check('a fixed tertiary has no handles', marker('tertiary-tint-1')?.classList.contains('draggable'), false);
hexFields()[2].value = '#2bb5b2';
fire(hexFields()[2], 'change');
check('custom tertiary runs the recipe', marker('tertiary-base')?.style.left, '45%');
check('and gets handles', marker('tertiary-tint-1')?.classList.contains('draggable'), true);

// No gradient control: primary-gradient simply follows the primary.
check('no gradient row', rowNamed('Gradient'), undefined);

// The dots are the recipe: drag one, or focus it and use the arrow keys. (happy-dom has no
// layout, so this drives them by keyboard; the drag itself is checked in real Chrome.)
const nudge = (key: string, steps: number) => {
  for (let i = 0; i < Math.abs(steps); i++) {
    marker(key)!.dispatchEvent(
      new KeyboardEvent('keydown', { key: steps > 0 ? 'ArrowRight' : 'ArrowLeft', bubbles: true }),
    );
  }
};
const stripLabel = (i: number) => ($$('.spectrum-row .name')[i] as HTMLElement).textContent;
check('no per-slot sliders any more', rowNamed('Tint 1'), undefined);
check('strips live in the recipe card', Boolean($('#panels .card .strips .spectra')), true);
check('nothing pinned above the tabs but the fields', previewEmpty(), true);
check(
  'one column: strips, then the two rules',
  $$('.recipe-rows .spectrum-row .name').map((n) => n.textContent).join(','),
  'Primary,Secondary,Tertiary,On-color,Alpha',
);
check('on-color prints a ratio', ($$('.strip-value')[0] as HTMLElement).textContent, '2.0:1');
check('alpha starts at the recipe value', ($$('.strip-value')[1] as HTMLElement).textContent, '12%');
const alphaBar = $$('.strip-range')[1] as HTMLInputElement;
alphaBar.value = '20';
fire(alphaBar, 'input');
check('alpha prints its value in the bar', ($$('.strip-value')[1] as HTMLElement).textContent, '20%');
check('alpha bar edits the recipe', resetShown('DDS fit'), true);
alphaBar.value = '12';
fire(alphaBar, 'input');
check('alpha back', resetShown('DDS fit'), false);
const onColorBar = $$('.strip-range')[0] as HTMLInputElement;
onColorBar.value = '3';
fire(onColorBar, 'input');
check('on-color bar edits the recipe', resetShown('DDS fit'), true);
onColorBar.value = '2';
fire(onColorBar, 'input');
check('and back', resetShown('DDS fit'), false);
check('tint dots are draggable', marker('primary-tint-1')?.classList.contains('draggable'), true);
check('the base dot is not', marker('primary-base')?.classList.contains('draggable'), false);
check('a dot names its rule', marker('primary-tint-1')?.title.endsWith('(step 03)'), true);
check('mix rules read as percentages', marker('primary-shade-1')?.title.endsWith('(55%)'), true);
nudge('primary-tint-1', 7);
check('a dot moves its slot', marker('primary-tint-1')?.style.left, '10%');
check('the strip label reads out the rule', stripLabel(0), 'Tint 1 step 10');
check('an edit shows the reset', resetShown('DDS fit'), true);
nudge('primary-tint-1', -7);
check('back to the imported value hides it', resetShown('DDS fit'), false);
nudge('primary-shade-1', 5);
check('a mix dot moves by a share', marker('primary-shade-1')?.title.endsWith('(55%)'), false);
nudge('primary-tint-1', 7);
click('Reset');
check('reset restores the imported recipe', marker('primary-tint-1')?.style.left, '3%');
check('and hides itself again', resetShown('DDS fit'), false);

// Export hands over the recipe as a JSON file named after the brand.
let downloadName = '';
let downloadBlob: Blob | null = null;
const realCreate = URL.createObjectURL;
const realAnchorClick = HTMLAnchorElement.prototype.click;
URL.createObjectURL = (blob: Blob) => ((downloadBlob = blob), 'blob:recipe');
HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
  downloadName = this.download;
};
check(
  'recipe actions sit on the heading row',
  (Array.from($('.card-head .head-actions')!.querySelectorAll('button')) as HTMLButtonElement[])
    .filter((b) => b.style.display !== 'none')
    .map((b) => b.textContent)
    .join(','),
  'Reset,Clear,Import,URL,Export',
);
click('Export');
URL.createObjectURL = realCreate;
HTMLAnchorElement.prototype.click = realAnchorClick;
check('export downloads a recipe file', downloadName, 'new-brand-recipe.json');
const exportedRecipe = JSON.parse(await (downloadBlob as Blob | null)!.text());
check('export is a recipe file', exportedRecipe.format, 'manshur-theme-recipe');
check('export carries the rules', JSON.stringify(exportedRecipe.primary['tint-2']), '{"white":88}');
check('export carries the fixed colors', exportedRecipe.tertiaryDefault?.base, '#333333');

// Another import replaces it; a broken one is refused without touching the recipe.
await pick('mine.json', JSON.stringify({ ...exportedRecipe, primary: { ...exportedRecipe.primary, 'tint-1': { step: 9 } } }));
check('import applies the recipe', marker('primary-tint-1')?.style.left, '9%');
check('import updates the dots', marker('primary-tint-1')?.title.endsWith('(step 09)'), true);
check('a fresh import has nothing to reset', resetShown('New brand'), false);
await pick('broken.json', '{"primary": {}}');
check('broken import keeps the recipe', marker('primary-tint-1')?.style.left, '9%');
check('broken import says why', last('notify')?.message, 'broken.json: primary tint-1 is missing');
check('as an error toast', last('notify')?.error, true);

// A recipe can come from a JSON endpoint too, through the same strict parse.
const realFetch = globalThis.fetch;
const served: Record<string, { status: number; body: string }> = {
  'http://localhost:3000/served.json': {
    status: 200,
    body: JSON.stringify({ ...exportedRecipe, name: 'Served', primary: { ...exportedRecipe.primary, 'tint-1': { step: 7 } } }),
  },
  'http://localhost:3000/bad.json': { status: 200, body: '{"primary": {}}' },
  'http://localhost:3000/missing.json': { status: 404, body: '' },
};
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const hit = served[String(input)];
  if (!hit) throw new TypeError('Failed to fetch');
  return new Response(hit.body, { status: hit.status });
}) as typeof fetch;
const loadUrl = async (url: string) => {
  const field = $('.url-row input') as HTMLInputElement;
  field.value = url;
  click('Load');
  await wait(50);
};
click('URL');
check('URL opens the field', Boolean($('.url-row input')), true);
await loadUrl('http://localhost:3000/served.json');
check('URL load applies the recipe', marker('primary-tint-1')?.style.left, '7%');
check('URL load is reported', last('notify')?.message, 'Imported the recipe from http://localhost:3000/served.json');
check('URL load closes the field', $('.url-row'), null);
check('URL load takes the JSON name', resetShown('Served'), false);
click('URL');
check('the last URL is offered again', ($('.url-row input') as HTMLInputElement).value, 'http://localhost:3000/served.json');
await loadUrl('http://localhost:3000/bad.json');
check('a bad URL recipe keeps the recipe', marker('primary-tint-1')?.style.left, '7%');
check('a bad URL recipe says why', last('notify')?.message, 'http://localhost:3000/bad.json: primary tint-1 is missing');
await loadUrl('http://localhost:3000/missing.json');
check('an HTTP error says so', last('notify')?.message, 'http://localhost:3000/missing.json: the server answered 404');
await loadUrl('http://localhost:9999/x.json');
check('an unreachable URL is an error', last('notify')?.error, true);
await wait(300);
check('the URL is saved', (last('save-brand') as { brand: { recipeUrl?: string } } | undefined)?.brand?.recipeUrl, 'http://localhost:9999/x.json');
globalThis.fetch = realFetch;
click('URL');
await pick('mine.json', JSON.stringify({ ...exportedRecipe, primary: { ...exportedRecipe.primary, 'tint-1': { step: 9 } } }));

// Theme tab lists every variable, and the export has the DDS shape.
check('theme table lists the 20 colors', $$('.token').length, 20);
check('no root theme row', $$('.token-group').map((g) => g.textContent).join(','), 'Primary,Secondary,Tertiary');
check('the theme list follows the recipe card', Boolean($('#panels .theme-host .token')), true);
check('no JSON box in the panel', Boolean($('#panels textarea')), false);
let copied = '';
const realExec = document.execCommand;
(document as unknown as { execCommand: () => boolean }).execCommand = () => {
  copied = ($('textarea.clipboard') as HTMLTextAreaElement | null)?.value ?? '';
  return true;
};
click('Copy JSON');
(document as unknown as { execCommand: typeof realExec }).execCommand = realExec;
check('copy sits on the theme heading', Boolean($('.card-head .head-actions button')), true);
check('copy leaves no textarea behind', Boolean($('textarea.clipboard')), false);
const brandJson = JSON.parse(copied);
check('export keyed by brand', Object.keys(brandJson).join(','), 'new-brand');
check('export alpha slot', brandJson['new-brand'].primary['primary-base-alpha-12'].$value, 'rgba(127,83,239,0.12)');

click('Create variables');
const brandVars = last('create-brand-variables');
check('create-brand-variables sent', brandVars?.type, 'create-brand-variables');
check('theme carries 20 slots', (brandVars?.theme as { slots: unknown[] })?.slots?.length, 20);
check('no collection field in the panel', rowNamed('Collection'), undefined);
check('collection comes from the brand name', (brandVars?.theme as { name: string })?.name, 'New brand');

click('Create documentation');
check('create-brand-doc sent', last('create-brand-doc')?.type, 'create-brand-doc');

// The recipe is saved with the rest of the Brand settings (clientStorage, per user).
await wait(300);
// Snapshot it: the stub postMessage passes the live object, where Figma's would copy it.
const saved = JSON.parse(JSON.stringify(last('save-brand'))) as
  | { brand: { input: { primary: string }; recipe: unknown; imported: { name: string } }; tool: string }
  | undefined;
check('brand settings saved', saved?.brand?.input?.primary, '#7F53EF');
check('recipe saved', Boolean(saved?.brand?.recipe), true);
check('imported name saved', saved?.brand?.imported?.name, 'New brand');
check('tool saved', saved?.tool, 'brand');

// Clear removes the recipe entirely; Use starter brings the built-in one back.
const own = JSON.parse(await Bun.file(new URL('../recipes/dds.json', import.meta.url)).text());
own.name = 'Own';
own.alpha = 20;
await pick('own.json', JSON.stringify(own));
const clearLive = () => ($$('#panels .card button') as HTMLButtonElement[]).some((b) => b.textContent === 'Clear' && !b.disabled);
check('own recipe makes Clear live', clearLive(), true);
check('own recipe applies', ($$('.strip-value')[1] as HTMLElement).textContent, '20%');
click('Clear');
check('clear empties the panel', recipeEmptyState(), 'Import recipe');
check('clear removes the strips', $$('.spectrum').length, 0);
check('nothing to create after clear', footerButtons().every((b) => b.disabled), true);
check('clear names what it removed', last('notify')?.message, 'Removed the recipe "Own"');
check('clear keeps the colors', hexFields()[0].value, '7F53EF');
await wait(300);
check('clear is saved', (last('save-brand') as { brand: { recipe: unknown } } | undefined)?.brand?.recipe, null);
click('Use starter');
check('starter is back', ($$('.strip-value')[1] as HTMLElement).textContent, '12%');
await wait(300);
check('starter is saved', (last('save-brand') as { brand: { imported: { name: string } } } | undefined)?.brand?.imported?.name, 'Starter');

// A saved cleared recipe stays cleared; a saved recipe comes straight back.
const restore = (brand: unknown) =>
  window.dispatchEvent(
    new MessageEvent('message', {
      data: { pluginMessage: { type: 'restore-config', config: null, tool: 'brand', brand } },
    }),
  );
restore({ input: { name: 'Saved', primary: '#00a049', secondary: '#1672dd' } });
check('restored brand name', nameField().value, 'Saved');
check('restored primary', hexFields()[0].value, '00A049');
check('a cleared recipe stays cleared', recipeEmptyState(), 'Import recipe');
restore(saved?.brand);
check('saved recipe comes back', $$('.spectrum').length, 3);

// Back to curves: the curve tool is untouched.
tools()[0].click();
check('curves pressed again', tools()[0].getAttribute('aria-pressed'), 'true');
check('brand fields leave with the tool', $('#form')?.children.length, 0);
check('ramp is back', $$('.ramp > div').length, 8);

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
await GlobalRegistrator.unregister();
process.exit(failures === 0 ? 0 : 1);
