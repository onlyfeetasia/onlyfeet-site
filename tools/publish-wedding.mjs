// Publishes a folder of photos as the onlyfeet.asia/wedding gallery.
//   1. makes thumbnails (800px) and viewer images (2200px) with sharp (HEIC photos are decoded with heic-decode)
//   2. uploads the untouched originals to a GitHub release, so guests can download them
//   3. commits wedding/thumbs, wedding/web and wedding/photos.json to the site repo and pushes
//   4. waits for the GitHub Pages deploy and the Cloudflare cache purge, then checks the live site
// Needs Node 20+, git, and a GitHub token in the GH_TOKEN environment variable.
// Safe to re-run: finished work is skipped. New photos in the folder are added.
// Usage: node publish-wedding.mjs "<photo folder>" [--title "Title"] [--yes]
//   rarely needed: --repo owner/name  --branch main  --tag wedding-originals  --draft  --no-wait  --skip-originals  --wait-only <sha>

import sharp from 'sharp';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import https from 'node:https';
import readline from 'node:readline/promises';
import { execFileSync, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const flag = (k, d = '') => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
const has = k => argv.includes(k);
const SRC = argv[0] && !argv[0].startsWith('--') ? path.resolve(argv[0]) : '';
const REPO = flag('--repo', 'onlyfeetasia/onlyfeet-site');
const BRANCH = flag('--branch', 'main');
const TAG = flag('--tag', 'wedding-originals');
const TITLE = flag('--title', 'Beejit Taylor Wedding');
const TOKEN = process.env.GH_TOKEN;
const HOME = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HOME, 'out');
const CLONE = path.join(HOME, 'repo');
const SITE = 'https://onlyfeet.asia/wedding/';
const THUMB = 800, WEB = 2200;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(...a);
const die = m => { console.error('\nERROR: ' + m); process.exit(1); };
const fmt = n => (n >= 1024 ** 3 ? (n / 1024 ** 3).toFixed(2) + ' GB' : (n / 1024 ** 2).toFixed(1) + ' MB');
const natural = (a, b) => a.localeCompare(b, undefined, { numeric: true });
const clean = s => s.replace(/[^\w.-]+/g, '_');

// ---------- GitHub API ----------
async function retry(fn, label, tries = 4) {
  for (let i = 1; ; i++) {
    try { return await fn(); } catch (e) {
      const permanent = e.status && e.status < 500 && e.status !== 429 && e.status !== 403;
      if (i >= tries || permanent) throw e;
      log(`  (retrying ${label}: ${String(e.message).slice(0, 100)})`);
      await sleep(2000 * i);
    }
  }
}

function api(method, url, body) {
  return retry(async () => {
    const res = await fetch(url.startsWith('http') ? url : 'https://api.github.com' + url, {
      method,
      headers: {
        Authorization: 'Bearer ' + TOKEN, Accept: 'application/vnd.github+json', 'User-Agent': 'wedding-publisher',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return null;
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
    if (!res.ok) {
      const e = new Error(`${method} ${url.split('?')[0]}: ${res.status} ${json?.message ?? text.slice(0, 200)}`);
      e.status = res.status; throw e;
    }
    return json;
  }, method + ' ' + url.split('?')[0]);
}

// ---------- waiting for the deploy ----------
async function waitForSite(sha, photos) {
  log('\nWaiting for GitHub Pages to deploy and the Cloudflare cache to be purged (usually 1-3 minutes)...');
  const deadline = Date.now() + 15 * 60_000;
  const st = r => (r ? r.conclusion || r.status : 'waiting');
  let last = '', purge;
  while (Date.now() < deadline) {
    const { workflow_runs: runs } = await api('GET', `/repos/${REPO}/actions/runs?head_sha=${sha}&per_page=30`);
    const pages = runs.find(r => r.name === 'pages build and deployment');
    purge = runs.find(r => r.name === 'Purge Cloudflare Cache');
    const line = `  Pages deploy: ${st(pages)}   Cache purge: ${st(purge)}`;
    if (line !== last) log(line);
    last = line;
    if (pages?.conclusion && pages.conclusion !== 'success') die('The GitHub Pages build failed: ' + pages.html_url);
    if (purge?.conclusion) break;
    await sleep(10_000);
  }
  if (purge?.conclusion !== 'success') log('  WARNING: the cache purge did not confirm success. If the page looks stale, press Ctrl+Shift+R.');
  log('\nChecking the live site:');
  const check = async (label, url, test, opts = {}) => {
    try {
      const res = await fetch(url, { cache: 'no-store', ...opts });
      const ok = res.ok && (!test || (await test(res)));
      log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}`);
      return ok;
    } catch (e) { log(`  FAIL ${label} (${e.message})`); return false; }
  };
  const t = Date.now();
  await check('gallery page', `${SITE}?t=${t}`);
  await check(photos ? `photos.json lists ${photos.length} photos` : 'photos.json', `${SITE}photos.json?t=${t}`,
    photos && (async r => (await r.json()).photos.length === photos.length));
  if (photos) {
    await check('a thumbnail', `${SITE}thumbs/${photos[0].id}.jpg`);
    await check('a viewer image', `${SITE}web/${photos[0].id}.jpg`);
    await check('an original download', `https://github.com/${REPO}/releases/download/${TAG}/${photos[0].f}`, null, { headers: { Range: 'bytes=0-0' } });
  }
}

// ---------- HEIC support (installed on first use) ----------
async function loadHeic() {
  const load = async () => (await import('heic-decode')).default;
  try { return await load(); } catch {
    log('\nInstalling the HEIC decoder (first time only)...');
    try { execSync('npm install heic-decode --no-audit --no-fund', { cwd: HOME, stdio: 'inherit' }); }
    catch { die('Could not install the HEIC decoder (npm install heic-decode failed).'); }
    return await load();
  }
}

// ---------- main ----------
async function main() {
  if (!TOKEN) die('GH_TOKEN is not set (the launcher file sets it).');
  const me = await api('GET', '/user');
  if (has('--wait-only')) { await waitForSite(flag('--wait-only'), null); return; }
  if (!SRC) die('Give the photo folder as the first argument.');
  if (!fs.existsSync(SRC)) die('Photo folder not found: ' + SRC);
  const repoInfo = await api('GET', '/repos/' + REPO);
  if (!repoInfo.permissions?.push) die(`The token can't push to ${REPO}.`);
  log(`Signed in to GitHub as ${me.login}; publishing to ${REPO}.`);

  // 1. find the photos
  const IMG = /\.(jpe?g|png|tiff?|webp|heic|heif)$/i, RAW = /\.(3fr|fff|dng|cr2|cr3|nef|arw|raf|orf|rw2)$/i;
  const walk = async dir => {
    const out = [];
    for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.') || e.name.startsWith('$')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) out.push(...(await walk(p)));
      else if (e.isFile()) out.push(p);
    }
    return out;
  };
  const files = (await walk(SRC)).sort((a, b) => natural(path.relative(SRC, a), path.relative(SRC, b)));
  const raws = files.filter(f => RAW.test(f));
  const used = new Set();
  const photos = files.filter(f => IMG.test(f)).map(p => {
    const ext = path.extname(p), stem = path.basename(p, ext);
    let id = clean(stem);
    if (used.has(id.toLowerCase())) id = clean(path.relative(SRC, p).slice(0, -ext.length).split(path.sep).join('_'));
    for (let n = 2, base = id; used.has(id.toLowerCase()); n++) id = `${base}_${n}`;
    used.add(id.toLowerCase());
    const heic = /\.hei[cf]$/i.test(p), size = fs.statSync(p).size;
    // HEIC files are converted to full-size JPEG for the downloads, because most PCs and phones can't open HEIC
    return { src: p, id, heic, f: id + (heic ? '.jpg' : ext), size, upSrc: heic ? path.join(OUT, 'full', id + '.jpg') : p, upSize: size };
  });
  const total = photos.reduce((s, p) => s + p.size, 0);
  if (!photos.length) die('No JPEG/HEIC/TIFF/PNG/WebP photos found in that folder.' + (raws.length ? ` (${raws.length} RAW files were found, but those can't be used.)` : ''));
  if (photos.length > 1000) die(`${photos.length} photos is more than one GitHub release can hold (1000).`);
  const huge = photos.filter(p => p.size >= 2 * 1024 ** 3);
  if (huge.length) die(`${huge.length} file(s) are 2 GB or larger, which GitHub releases don't allow (first: ${huge[0].src}).`);
  log(`\nFound ${photos.length} photos (${fmt(total)}):`);
  const byDir = new Map();
  for (const p of photos) { const d = path.relative(SRC, path.dirname(p.src)) || '(top level)'; byDir.set(d, (byDir.get(d) || 0) + 1); }
  for (const [d, n] of byDir) log(`  ${String(n).padStart(5)}  ${d}`);
  const nHeic = photos.filter(p => p.heic).length;
  if (nHeic) log(`  ${nHeic} are HEIC: they will be converted to full-size JPEG for the downloads (a few seconds each)`);
  if (raws.length) log(`  (${raws.length} RAW files ignored: only JPEG/TIFF/PNG/WebP/HEIC are used)`);
  if (!has('--yes')) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ans = (await rl.question(`\nPublish these ${photos.length} photos publicly at ${SITE} ? [Y/n] `)).trim().toLowerCase();
    rl.close();
    if (ans && ans !== 'y' && ans !== 'yes') { log('Cancelled. Nothing was published.'); return; }
  }

  // 2. thumbnails and viewer images
  log('\nMaking thumbnails and viewer images...');
  await fsp.mkdir(path.join(OUT, 'thumbs'), { recursive: true });
  await fsp.mkdir(path.join(OUT, 'web'), { recursive: true });
  sharp.cache(false);
  const heicDecode = photos.some(p => p.heic) ? await loadHeic() : null;
  await fsp.mkdir(path.join(OUT, 'full'), { recursive: true });
  let next = 0, done = 0;
  const worker = async () => {
    while (next < photos.length) {
      const p = photos[next++];
      const t = path.join(OUT, 'thumbs', p.id + '.jpg'), w = path.join(OUT, 'web', p.id + '.jpg');
      let info;
      const fresh = f => fs.existsSync(f) && fs.statSync(f).size > 0 && fs.statSync(f).mtimeMs > fs.statSync(p.src).mtimeMs;
      if (fresh(t) && fresh(w) && (!p.heic || fresh(p.upSrc))) info = await sharp(t).metadata();
      else if (p.heic) {
        const { width, height, data } = await heicDecode({ buffer: await fsp.readFile(p.src) });
        const base = sharp(Buffer.from(data.buffer, data.byteOffset, data.byteLength), { raw: { width, height, channels: 4 }, limitInputPixels: false }).removeAlpha();
        [info] = await Promise.all([
          base.clone().resize(THUMB, THUMB, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 72, mozjpeg: true }).toFile(t),
          base.clone().resize(WEB, WEB, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 78, mozjpeg: true }).toFile(w),
          base.clone().jpeg({ quality: 92 }).toFile(p.upSrc),
        ]);
      } else {
        const base = sharp(p.src, { failOn: 'none', limitInputPixels: false }).rotate();
        [info] = await Promise.all([
          base.clone().resize(THUMB, THUMB, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 72, mozjpeg: true }).toFile(t),
          base.clone().resize(WEB, WEB, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 78, mozjpeg: true }).toFile(w),
        ]);
      }
      p.w = info.width; p.h = info.height;
      if (p.heic) p.upSize = fs.statSync(p.upSrc).size;
      process.stdout.write(`\r  ${++done}/${photos.length}`);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(3, os.cpus().length - 1)) }, worker));
  const outBytes = photos.reduce((s, p) => s + fs.statSync(path.join(OUT, 'thumbs', p.id + '.jpg')).size + fs.statSync(path.join(OUT, 'web', p.id + '.jpg')).size, 0);
  log(`\n  gallery images: ${fmt(outBytes)}`);
  if (outBytes > 800 * 1024 ** 2) die('The gallery images total ' + fmt(outBytes) + ', too close to the ~1 GB GitHub Pages limit. Send this message to Claude and it will adjust the sizes.');
  const manifest = {
    title: TITLE, fullBase: `https://github.com/${REPO}/releases/download/${TAG}/`, zip: '',
    photos: photos.map(({ id, w, h, f }) => ({ id, w, h, f })),
  };
  await fsp.writeFile(path.join(OUT, 'photos.json'), JSON.stringify(manifest));

  // 3. originals -> GitHub release
  if (has('--skip-originals')) log('\nSkipping the originals upload (--skip-originals).');
  else await (async () => {
  log('\nUploading the original files to the GitHub release (this is the slow part)...');
  let rel = null;
  for (let page = 1; !rel; page++) {
    const list = await api('GET', `/repos/${REPO}/releases?per_page=100&page=${page}`);
    rel = list.find(r => r.tag_name === TAG) || null;
    if (list.length < 100) break;
  }
  if (!rel) {
    rel = await api('POST', `/repos/${REPO}/releases`, {
      tag_name: TAG, target_commitish: repoInfo.default_branch, name: 'Wedding originals',
      body: 'Original-resolution photos for ' + SITE, draft: has('--draft'), prerelease: false, make_latest: 'false',
    });
  }
  const listAssets = async () => {
    const out = [];
    for (let page = 1; ; page++) {
      const a = await api('GET', `/repos/${REPO}/releases/${rel.id}/assets?per_page=100&page=${page}`);
      out.push(...a);
      if (a.length < 100) return out;
    }
  };
  const have = new Map((await listAssets()).map(a => [a.name, a]));
  const todo = [];
  for (const p of photos) {
    const a = have.get(p.f);
    if (a && a.size === p.upSize && a.state === 'uploaded') continue;
    if (a) await api('DELETE', `/repos/${REPO}/releases/assets/${a.id}`);
    todo.push(p);
  }
  log(`  ${photos.length - todo.length} already uploaded, ${todo.length} to upload (${fmt(todo.reduce((s, p) => s + p.upSize, 0))})`);
  const uploadBase = rel.upload_url.split('{')[0];
  const uploadOnce = p => new Promise((resolve, reject) => {
    const type = /\.png$/i.test(p.f) ? 'image/png' : /\.tiff?$/i.test(p.f) ? 'image/tiff' : /\.webp$/i.test(p.f) ? 'image/webp' : 'image/jpeg';
    const req = https.request(`${uploadBase}?name=${encodeURIComponent(p.f)}`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + TOKEN, Accept: 'application/vnd.github+json', 'User-Agent': 'wedding-publisher', 'Content-Type': type, 'Content-Length': p.upSize },
    }, res => {
      let b = ''; res.on('data', d => (b += d));
      res.on('end', () => {
        if (res.statusCode < 300) return resolve();
        const e = new Error(`upload ${p.f}: ${res.statusCode} ${b.slice(0, 150)}`); e.status = res.statusCode; reject(e);
      });
    });
    req.on('error', reject);
    fs.createReadStream(p.upSrc).on('error', reject).pipe(req);
  });
  const putAsset = async p => {
    for (let attempt = 1; ; attempt++) {
      try { await uploadOnce(p); return; } catch (e) {
        if (attempt >= 4) throw e;
        log(`  (retrying ${p.f}: ${e.message.slice(0, 100)})`);
        await sleep(3000 * attempt);
        const stale = (await listAssets()).find(a => a.name === p.f);
        if (stale) await api('DELETE', `/repos/${REPO}/releases/assets/${stale.id}`);
      }
    }
  };
  let ni = 0, nd = 0;
  const upWorker = async () => {
    while (ni < todo.length) {
      const p = todo[ni++];
      await putAsset(p);
      log(`  [${++nd}/${todo.length}] ${p.f}  ${fmt(p.upSize)}`);
    }
  };
  await Promise.all([upWorker(), upWorker()]);
  const after = new Map((await listAssets()).map(a => [a.name, a]));
  const bad = photos.filter(p => { const a = after.get(p.f); return !a || a.size !== p.upSize || a.state !== 'uploaded'; });
  if (bad.length) die(`${bad.length} originals did not upload correctly (first: ${bad[0].f}). Run the file again to retry them.`);
  log('  all originals are in the release.');
  })();

  // 4. gallery files -> site repo
  log('\nPublishing the gallery to the site...');
  const AUTH = 'Authorization: Basic ' + Buffer.from(`${me.login}:${TOKEN}`).toString('base64');
  const git = (args, cwd) => {
    try {
      return execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'http.postBuffer=524288000', '-c', 'http.extraheader=' + AUTH,
        '-c', 'user.name=' + me.login, '-c', `user.email=${me.login}@users.noreply.github.com`, ...args], { cwd, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' });
    } catch (e) { throw new Error(`git ${args[0]} failed (exit ${e.status})`); }
  };
  const gitRetry = async (args, cwd) => retry(async () => git(args, cwd), 'git ' + args[0], 3);
  const url = `https://github.com/${REPO}.git`;
  if (!fs.existsSync(path.join(CLONE, '.git'))) {
    fs.rmSync(CLONE, { recursive: true, force: true });
    await gitRetry(['clone', '--depth', '1', '--branch', repoInfo.default_branch, url, CLONE]);
  } else {
    await gitRetry(['fetch', '--depth', '1', 'origin', repoInfo.default_branch], CLONE);
    git(['reset', '--hard', 'FETCH_HEAD'], CLONE);
    git(['clean', '-fdq'], CLONE);
  }
  if (!fs.existsSync(path.join(CLONE, 'wedding', 'index.html'))) die('wedding/index.html is missing from the repo.');
  await fsp.mkdir(path.join(CLONE, 'wedding', 'thumbs'), { recursive: true });
  await fsp.mkdir(path.join(CLONE, 'wedding', 'web'), { recursive: true });
  const rels = photos.flatMap(p => [`wedding/thumbs/${p.id}.jpg`, `wedding/web/${p.id}.jpg`]);
  for (const r of rels) await fsp.copyFile(path.join(OUT, r.slice('wedding/'.length)), path.join(CLONE, r));
  await fsp.copyFile(path.join(OUT, 'photos.json'), path.join(CLONE, 'wedding', 'photos.json'));
  rels.push('wedding/photos.json');

  // commit in chunks of ~100 MB; chunks go to a staging branch first so an interrupted upload keeps its progress
  const staged = () => { try { git(['diff', '--cached', '--quiet'], CLONE); return false; } catch { return true; } };
  let batch = [], bytes = 0, chunk = 0, committed = false, usedStaging = false;
  const commitBatch = async final => {
    for (let i = 0; i < batch.length; i += 100) git(['add', '--', ...batch.slice(i, i + 100)], CLONE);
    batch = []; bytes = 0;
    if (!staged()) return;
    git(['commit', '-q', '-m', final ? 'Add wedding photos' : `Add wedding photos (part ${++chunk})`], CLONE);
    committed = true;
    if (!final) { usedStaging = true; log(`  uploading part ${chunk}...`); await gitRetry(['push', '-q', '--force', 'origin', 'HEAD:refs/heads/ofw-staging'], CLONE); }
  };
  for (const r of rels) {
    batch.push(r); bytes += fs.statSync(path.join(CLONE, r)).size;
    if (bytes > 100 * 1024 ** 2 && r !== rels[rels.length - 1]) await commitBatch(false);
  }
  await commitBatch(true);
  if (!committed) { log('  the site already has these photos; nothing to publish.'); return; }
  log('  publishing...');
  try { await gitRetry(['push', '-q', 'origin', `HEAD:refs/heads/${BRANCH}`], CLONE); } catch {
    await gitRetry(['fetch', '--depth', '1', 'origin', BRANCH], CLONE);
    git(['rebase', 'FETCH_HEAD'], CLONE);
    await gitRetry(['push', '-q', 'origin', `HEAD:refs/heads/${BRANCH}`], CLONE);
  }
  if (usedStaging) { try { git(['push', '-q', 'origin', '--delete', 'ofw-staging'], CLONE); } catch { /* already gone */ } }
  const sha = git(['rev-parse', 'HEAD'], CLONE).trim();
  log('  pushed ' + sha.slice(0, 7));

  // 5. wait for the deploy
  if (has('--no-wait') || BRANCH !== 'main') { log('\nDone (not waiting for the deploy).'); return; }
  await waitForSite(sha, photos);
  log(`\nDONE. Gallery: ${SITE}\n  ${photos.length} photos; originals: https://github.com/${REPO}/releases/tag/${TAG}`);
}

main().catch(e => die(e.message));
