/**
 * Build the Figma-importable bundle into dist/.
 *
 *   bun run build          one-shot, minified
 *   bun run dev            rebuild on every save
 *
 * Figma needs exactly two files: a single self-contained JS for the sandbox and a
 * single self-contained HTML for the UI. So the UI bundle is inlined into the HTML.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { watch } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');
const DIST = resolve(ROOT, 'dist');
const PLACEHOLDER = '/*__APP_JS__*/';

const watchMode = process.argv.includes('--watch');
const minify = !process.argv.includes('--no-minify') && !watchMode;

async function bundle(entry: string): Promise<string> {
  const result = await Bun.build({
    entrypoints: [resolve(ROOT, entry)],
    target: 'browser',
    format: 'iife',
    minify,
  });

  if (!result.success) {
    throw new AggregateError(result.logs, `Failed to bundle ${entry}`);
  }

  const output = result.outputs.find((o) => o.path.endsWith('.js'));
  if (!output) throw new Error(`No JS output for ${entry}`);
  return output.text();
}

async function build(): Promise<void> {
  const started = performance.now();
  await mkdir(DIST, { recursive: true });

  const [code, ui, shell] = await Promise.all([
    bundle('plugin/code.ts'),
    bundle('plugin/ui/main.ts'),
    readFile(resolve(ROOT, 'plugin/ui/index.html'), 'utf8'),
  ]);

  if (!shell.includes(PLACEHOLDER)) {
    throw new Error(`plugin/ui/index.html is missing the ${PLACEHOLDER} marker`);
  }

  // split/join, not replace: a bundle full of $& would be mangled by replace().
  const html = shell.split(PLACEHOLDER).join(ui);

  await Promise.all([
    writeFile(resolve(DIST, 'code.js'), code),
    writeFile(resolve(DIST, 'ui.html'), html),
  ]);

  const ms = Math.round(performance.now() - started);
  const kb = (n: number) => `${(n / 1024).toFixed(1)}kb`;
  console.log(
    `built in ${ms}ms  code.js ${kb(code.length)}  ui.html ${kb(html.length)}` +
      (minify ? '  (minified)' : ''),
  );
}

async function safeBuild(): Promise<void> {
  try {
    await build();
  } catch (error) {
    // Keep the watcher alive on a syntax error, otherwise every typo kills the loop.
    console.error('build failed:', error instanceof Error ? error.message : error);
    if (error instanceof AggregateError) {
      for (const log of error.errors) console.error(' ', String(log));
    }
    if (!watchMode) process.exit(1);
  }
}

await safeBuild();

if (watchMode) {
  const targets = ['src', 'plugin'];
  let timer: ReturnType<typeof setTimeout> | null = null;

  const schedule = (file: string | null) => {
    if (file && !/\.(ts|html|css)$/.test(file)) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (file) console.log(`\nchanged: ${file}`);
      void safeBuild();
    }, 60);
  };

  for (const dir of targets) {
    watch(resolve(ROOT, dir), { recursive: true }, (_event, file) => schedule(file ?? null));
  }
  watch(resolve(ROOT, 'manifest.json'), () => schedule('manifest.json'));

  console.log(`watching ${targets.join(', ')} and manifest.json. ctrl-c to stop.`);
}
