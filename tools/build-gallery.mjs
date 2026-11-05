// Usage: node build-gallery.mjs "<photo folder>" [--out <dir>] [--title "Title"] [--full-base URL] [--zip URL]
// Makes thumbs/ (800px) + web/ (2400px) + photos.json in wedding/. Re-runnable: skips photos already done.
import sharp from 'sharp';
import { readdir, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, parse } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const a = process.argv.slice(2);
const opt = (k, d = '') => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
const src = a[0];
if (!src || src.startsWith('--')) { console.error('Usage: node build-gallery.mjs "<photo folder>" [--out dir] [--title T] [--full-base URL] [--zip URL]'); process.exit(1); }
const out = opt('--out', fileURLToPath(new URL('../wedding', import.meta.url)));
const fullBase = opt('--full-base', 'https://github.com/onlyfeetasia/onlyfeet-site/releases/download/wedding-originals/');

sharp.cache(false);
await mkdir(join(out, 'thumbs'), { recursive: true });
await mkdir(join(out, 'web'), { recursive: true });
const files = (await readdir(src)).filter(f => /\.(jpe?g|png|tiff?|webp)$/i.test(f))
  .sort((x, y) => x.localeCompare(y, undefined, { numeric: true }));
if (!files.length) { console.error('No images found in', src); process.exit(1); }

const photos = new Array(files.length);
let next = 0, done = 0;
async function worker() {
  while (next < files.length) {
    const i = next++, f = files[i], stem = parse(f).name;
    const id = stem.replace(/[^\w.-]+/g, '_');
    if (id !== stem) console.warn(`\n  note: "${f}" has unusual characters; rename it before uploading the original`);
    const t = join(out, 'thumbs', id + '.jpg'), w = join(out, 'web', id + '.jpg');
    let info;
    if (existsSync(t) && existsSync(w)) info = await sharp(t).metadata();
    else {
      const base = sharp(join(src, f), { failOn: 'none', limitInputPixels: false }).rotate();
      [info] = await Promise.all([
        base.clone().resize(800, 800, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 72, mozjpeg: true }).toFile(t),
        base.clone().resize(2400, 2400, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 80, mozjpeg: true }).toFile(w),
      ]);
    }
    photos[i] = { id, w: info.width, h: info.height, f };
    process.stdout.write(`\r${++done}/${files.length}`);
  }
}
await Promise.all(Array.from({ length: Math.min(4, os.cpus().length) }, worker));
await writeFile(join(out, 'photos.json'), JSON.stringify({ title: opt('--title', 'Wedding Photos'), fullBase, zip: opt('--zip'), photos }));
console.log(`\nDone: ${photos.length} photos -> ${out}`);
