// Erzeugt das helle Logo für dunkle/Bordeaux-Flächen (Seitenleiste): weiß, Deckkraft aus der Helligkeit des Originals.
// Aufruf: node scripts/logo-light.mjs → assets/web/logo-hell.png
import { readFileSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';

const src = PNG.sync.read(readFileSync(new URL('../assets/web/logo.png', import.meta.url)));
const out = new PNG({ width: src.width, height: src.height, colorType: 6 });
for (let i = 0; i < src.width * src.height; i++) {
  const [r, g, b] = [src.data[i * 4], src.data[i * 4 + 1], src.data[i * 4 + 2]];
  const lum = 0.299 * r + 0.587 * g + 0.114 * b;
  out.data[i * 4] = out.data[i * 4 + 1] = out.data[i * 4 + 2] = 255;
  out.data[i * 4 + 3] = Math.max(0, Math.min(255, Math.round((255 - lum) * 1.25)));
}
writeFileSync(new URL('../assets/web/logo-hell.png', import.meta.url), PNG.sync.write(out));
console.log('assets/web/logo-hell.png', src.width, 'x', src.height);

// Original-Farben mit durchsichtigem statt weißem Hintergrund (Handy-App auf farbigem Hintergrund)
const tr = new PNG({ width: src.width, height: src.height, colorType: 6 });
for (let i = 0; i < src.width * src.height; i++) {
  const c = [src.data[i * 4], src.data[i * 4 + 1], src.data[i * 4 + 2]];
  const a = 255 - Math.min(...c);
  for (let k = 0; k < 3; k++) tr.data[i * 4 + k] = a ? Math.round(((c[k] - (255 - a)) * 255) / a) : 0;
  tr.data[i * 4 + 3] = a;
}
writeFileSync(new URL('../assets/web/logo-transparent.png', import.meta.url), PNG.sync.write(tr));
console.log('assets/web/logo-transparent.png');
