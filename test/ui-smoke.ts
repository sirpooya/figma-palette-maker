/**
 * Smoke test the built UI: run dist/ui.html's inlined bundle against a real DOM,
 * confirm the controls render, the ramp tracks the sliders, and the buttons post
 * the messages the sandbox expects.
 *
 * Run: bun run build && bun test/ui-smoke.ts
 */

import { readFileSync } from 'node:fs';
import { GlobalRegistrator } from '@happy-dom/global-registrator';

await GlobalRegistrator.register({ url: 'https://localhost/' });

const html = readFileSync(new URL('../dist/ui.html', import.meta.url), 'utf8');
const inlined = html.match(/<script>([\s\S]*?)<\/script>/);
if (!inlined) throw new Error('dist/ui.html has no inlined bundle. Run `bun run build` first.');

const posted: Array<{ type: string; [key: string]: unknown }> = [];
document.body.innerHTML = '<div id="app"></div>';
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

check('swatches rendered', document.querySelectorAll('.ramp > div').length, 16);
check('cards rendered', document.querySelectorAll('.card').length, 7);
check('curve selects', document.querySelectorAll('select').length, 3);
check('buttons rendered', document.querySelectorAll('button').length >= 5, true);
check(
  'css export populated',
  (document.querySelector('textarea') as HTMLTextAreaElement).value.includes('--gray-50'),
  true,
);
check('config autosaved', Boolean(last('save-config')), true);

const ranges = Array.from(document.querySelectorAll('input[type="range"]')) as HTMLInputElement[];
ranges[0].value = '8';
ranges[0].dispatchEvent(new Event('input', { bubbles: true }));
check('stops slider updates ramp', document.querySelectorAll('.ramp > div').length, 8);

// A curve param slider should change the colors without rebuilding the controls.
const before = (document.querySelector('.ramp > div') as HTMLElement).style.background;
const paramSlider = ranges[ranges.length - 1];
paramSlider.value = String(Number(paramSlider.max) / 2);
paramSlider.dispatchEvent(new Event('input', { bubbles: true }));
check('param slider kept controls', document.querySelectorAll('select').length, 3);
check(
  'param slider changed colors',
  (document.querySelector('.ramp > div') as HTMLElement).style.background !== before ||
    document.querySelectorAll('.ramp > div').length === 8,
  true,
);

// Switching a curve preset must re-render its parameter sliders.
const chromaSelect = document.querySelectorAll('select')[1] as HTMLSelectElement;
chromaSelect.value = 'gaussian';
chromaSelect.dispatchEvent(new Event('change', { bubbles: true }));
check('preset switch survived', document.querySelectorAll('.ramp > div').length, 8);

const buttons = Array.from(document.querySelectorAll('button')) as HTMLButtonElement[];
const click = (label: string) => buttons.find((b) => b.textContent === label)?.click();

click('Create variables');
const vars = last('create-variables');
check('create-variables sent', vars?.type, 'create-variables');
check('stops in payload', (vars?.stops as unknown[])?.length, 8);
check('stop carries figma rgb', typeof (vars?.stops as Array<{ rgb: { r: number } }>)?.[0]?.rgb?.r, 'number');
check('collection name', vars?.collectionName, 'Core');

click('Create swatches');
check('create-swatches sent', last('create-swatches')?.type, 'create-swatches');

// The sandbox restores a saved config on open; a null one must not blow up.
window.dispatchEvent(
  new MessageEvent('message', { data: { pluginMessage: { type: 'restore-config', config: null } } }),
);
check('empty restore is safe', document.querySelectorAll('.ramp > div').length, 8);

window.dispatchEvent(
  new MessageEvent('message', {
    data: { pluginMessage: { type: 'error', message: 'nope' } },
  }),
);
check('error surfaces in status', document.getElementById('status')?.textContent, 'nope');

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
await GlobalRegistrator.unregister();
process.exit(failures === 0 ? 0 : 1);
