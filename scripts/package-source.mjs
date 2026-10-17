import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { zipSync } from 'fflate';
const files = {};
const include = ['src', 'python', 'scripts', 'vendor', 'public/examples'];
async function walk(dir) {
 for (const ent of await readdir(dir, {withFileTypes:true})) {
  if (ent.name === '__pycache__') continue;
  const p = `${dir}/${ent.name}`;
  if (ent.isDirectory()) await walk(p); else files[p] = new Uint8Array(await readFile(p));
 }
}
for (const dir of include) await walk(dir);
for (const f of ['package.json','package-lock.json','tsconfig.json','index.html','vercel.json','LICENSE','README.md','NOTICE.md','public/icon.svg']) {
 files[f] = new Uint8Array(await readFile(f));
}
// Vercel CLI deployments omit ignore files from the remote build context.
// Include them when available, but they are not needed to build or run the app.
for (const f of ['.gitignore','.vercelignore']) {
 try { files[f] = new Uint8Array(await readFile(f)); }
 catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const dest = process.argv[2] || 'dist';
await mkdir(dest, {recursive:true});
await writeFile(`${dest}/mini-supports-source.zip`, zipSync(files,{level:6}));
console.log('Corresponding source bundled at /mini-supports-source.zip');
