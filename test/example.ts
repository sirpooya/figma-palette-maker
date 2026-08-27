/** Quick visual check: a few ramps printed as ANSI blocks. Run: bun test/example.ts */
import { defaultConfig, generatePalette, reanchorChannel, toCssVariables } from '../src/palette';

function show(label: string, config = defaultConfig()) {
  const stops = generatePalette(config);
  const blocks = stops
    .map((s) => {
      const r = Math.round(s.rgb.r * 255);
      const g = Math.round(s.rgb.g * 255);
      const b = Math.round(s.rgb.b * 255);
      return `\x1b[48;2;${r};${g};${b}m   \x1b[0m`;
    })
    .join('');
  console.log(`${label.padEnd(30)} ${blocks}`);
  return stops;
}

show('default (arctan L, flat C/H)');
show('orange, gaussian chroma', {
  ...defaultConfig(),
  stops: 12,
  h: reanchorChannel('h', 'flat', 42, 42),
  c: reanchorChannel('c', 'gaussian', 0, 0.19),
});
show('hue shift across ramp', {
  ...defaultConfig(),
  stops: 14,
  h: reanchorChannel('h', 'linear', 200, 320),
  c: reanchorChannel('c', 'gaussian', 0, 0.16),
});
show('neutral binding, 24 stops', {
  ...defaultConfig(),
  stops: 24,
  l: reanchorChannel('l', 'arctan', 15.61, 99.8),
  c: reanchorChannel('c', 'flat', 0, 0.004),
});
show('expo lightness', {
  ...defaultConfig(),
  l: reanchorChannel('l', 'expo', 6, 98),
  c: reanchorChannel('c', 'flat', 0, 0.14),
});

console.log('\n' + toCssVariables(generatePalette({ ...defaultConfig(), stops: 6 }), 'violet'));
