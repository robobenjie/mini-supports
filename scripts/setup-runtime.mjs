import { mkdir, readFile, writeFile, readdir, copyFile, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { zipSync, strToU8 } from 'fflate';

// Everything the worker needs is served from the same origin. No runtime CDN calls.
const root = path.resolve('public/runtime');
await mkdir(root, { recursive: true });
await writeFile(path.join(root, 'package.json'), '{"type":"commonjs"}');
const cdn = 'https://cdn.jsdelivr.net/pyodide/v0.29.3/full/';
async function download(url, file, sha) {
  const dest = path.join(root, file);
  try {
    const cached = await readFile(dest);
    if (!sha || createHash('sha256').update(cached).digest('hex') === sha) return cached;
  } catch {}
  console.log(`Downloading ${file}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  const data = Buffer.from(await response.arrayBuffer());
  if (sha && createHash('sha256').update(data).digest('hex') !== sha) throw new Error(`Checksum mismatch: ${file}`);
  await writeFile(dest, data);
  return data;
}
for (const file of await readdir('node_modules/pyodide')) {
  if (/\.(mjs|js|wasm|zip|json)$/.test(file) && !file.includes('package')) {
    await copyFile(`node_modules/pyodide/${file}`, `${root}/${file}`);
  }
}
const lock = JSON.parse(await readFile(`${root}/pyodide-lock.json`, 'utf8'));
const packages = new Set();
function collect(name) {
  if (packages.has(name)) return;
  const pkg = lock.packages[name];
  if (!pkg) throw new Error(`Missing Pyodide package: ${name}`);
  packages.add(name);
  pkg.depends.forEach(collect);
}
['numpy', 'scipy', 'shapely'].forEach(collect);
// NetworkX core is pure Python; its optional plotting stack is unnecessary.
packages.add('networkx');
for (const [name, pkg] of Object.entries(lock.packages)) {
  if (!packages.has(name)) {
    try { await unlink(path.join(root, pkg.file_name)); } catch {}
  }
}
await Promise.all([...packages].map(name => {
  const p = lock.packages[name];
  return download(cdn + p.file_name, p.file_name, p.sha256);
}));
// Pin the pure Python mesh library; compiled geometry comes from Manifold WASM.
const wheelName = 'trimesh-5.1.1-py3-none-any.whl';
let wheel;
try { wheel = await readFile(`${root}/${wheelName}`); } catch {
  const meta = await (await fetch('https://pypi.org/pypi/trimesh/5.1.1/json')).json();
  const asset = meta.urls.find(f => f.filename === wheelName);
  if (!asset) throw new Error('Pinned trimesh wheel unavailable');
  wheel = await download(asset.url, wheelName, asset.digests.sha256);
}
const files = {};
async function addTree(dir, prefix) {
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    if (ent.name === '__pycache__') continue;
    const key = `${prefix}/${ent.name}`;
    if (ent.isDirectory()) await addTree(`${dir}/${ent.name}`, key);
    else files[key] = new Uint8Array(await readFile(`${dir}/${ent.name}`));
  }
}
await addTree('vendor/arborfdm/arbor/engine', 'arbor/engine');
await addTree('vendor/arborfdm/arbor/core', 'arbor/core');
await addTree('vendor/arborfdm/arbor/io', 'arbor/io');
files['arbor/__init__.py'] = new Uint8Array(await readFile('vendor/arborfdm/arbor/__init__.py'));
await addTree('vendor/arborfdm/profiles', 'profiles');
await addTree('python', '');
// ZIP paths must be relative for extraction into the worker's private filesystem.
const cleanFiles = Object.fromEntries(Object.entries(files).map(([k,v]) => [k.replace(/^\//,''), v]));
await writeFile(`${root}/arbor-engine.zip`, zipSync(cleanFiles, { level: 6 }));
await copyFile('LICENSE', 'public/LICENSE.txt');
await copyFile('node_modules/manifold-3d/manifold.wasm', `${root}/manifold.wasm`);
console.log(`Browser runtime ready (${packages.size} scientific packages).`);
