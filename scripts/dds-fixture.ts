/**
 * Rebuild test/fixtures/dds-themes.json from the Digikala Design System tokens.
 *
 *   bun scripts/dds-fixture.ts               fetch https://assets.alamut.digikala.com/api/tokens
 *   bun scripts/dds-fixture.ts tokens.json   read a downloaded copy instead
 *
 * Keeps only what the brand recipe is fitted and tested against: every core color, and
 * every theme's slot references. Values stay exactly as the DDS writes them (hex or rgba).
 */

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const SOURCE = 'https://assets.alamut.digikala.com/api/tokens';
const OUT = resolve(import.meta.dir, '../test/fixtures/dds-themes.json');

interface Leaf {
  $value: unknown;
}
type Tree = { [key: string]: Tree | Leaf };

function isLeaf(node: Tree | Leaf): node is Leaf {
  return typeof node === 'object' && node !== null && '$value' in node;
}

function* leaves(node: Tree, path: string[] = []): Generator<[string[], Leaf]> {
  for (const [key, child] of Object.entries(node)) {
    if (isLeaf(child)) yield [[...path, key], child];
    else if (typeof child === 'object' && child !== null) yield* leaves(child, [...path, key]);
  }
}

const file = process.argv[2];
const raw = file
  ? JSON.parse(await readFile(file, 'utf8'))
  : await (await fetch(SOURCE)).json();
const data = (raw.data ?? raw) as { core: { color: Tree }; theme: Tree };

const colors: Record<string, string> = {};
for (const [path, leaf] of leaves(data.core.color)) {
  if (typeof leaf.$value === 'string') colors[path.join('.')] = leaf.$value;
}

// Slot values are references like {core.color.brand.shop.pomegranate-62}; keep the part
// after core.color so they index straight into `colors`.
const themes: Record<string, Record<string, Record<string, string>>> = {};
for (const [name, theme] of Object.entries(data.theme)) {
  themes[name] = {};
  for (const [path, leaf] of leaves(theme as Tree)) {
    const value = String(leaf.$value);
    const group = path.length > 1 ? path[0] : 'root';
    themes[name][group] ??= {};
    themes[name][group][path[path.length - 1]] = value.startsWith('{core.color.')
      ? value.slice('{core.color.'.length, -1)
      : value;
  }
}

const fixture = {
  source: SOURCE,
  commit: raw.lastChanged?.commitHash ?? null,
  committed: raw.lastChanged?.timestamp ? new Date(raw.lastChanged.timestamp).toISOString() : null,
  colors,
  themes,
};

await writeFile(OUT, JSON.stringify(fixture, null, 2) + '\n');
console.log(
  `wrote ${OUT}\n  ${Object.keys(colors).length} core colors, ${Object.keys(themes).length} themes` +
    (fixture.commit ? `, commit ${String(fixture.commit).slice(0, 7)}` : ''),
);
