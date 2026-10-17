import { loadPyodide } from 'pyodide';
import Module from 'manifold-3d';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { unzipSync, strFromU8 } from 'fflate';
process.on('uncaughtException', e => { console.error(e.message); process.exit(1); });
const manifold = await Module(); manifold.setup();
const py = await loadPyodide({indexURL:path.resolve('public/runtime') + '/'});
py.registerJsModule('manifold_js',{api:manifold});
let stage = '';
py.registerJsModule('browser_bridge',{progress:(f,s) => { const v = Math.floor(f*10); if (stage!==v) { console.log(`${Math.round(f*100)}% ${s}`); stage=v; } }});
await py.loadPackage(['numpy','scipy','shapely']);
py.unpackArchive(new Uint8Array(await readFile('public/runtime/networkx-3.4.2-py3-none-any.whl')),'zip',{extractDir:'/engine'});
py.unpackArchive(new Uint8Array(await readFile('public/runtime/arbor-engine.zip')),'zip',{extractDir:'/engine'});
py.unpackArchive(new Uint8Array(await readFile('public/runtime/trimesh-5.1.1-py3-none-any.whl')),'zip',{extractDir:'/engine'});
await py.runPythonAsync("import sys\nsys.path.insert(0, '/engine')\nimport browser_engine");

const started=performance.now(), results=[];
for (let i=0;i<Number(process.argv[2]||53);i++) {
 py.FS.writeFile('/input.vertices',await readFile(`test-results/plate/${i}.vertices`));
 py.FS.writeFile('/input.indices',await readFile(`test-results/plate/${i}.indices`));
 py.globals.set('settings',JSON.stringify({profile:'nozzle_02_normal',raft:true,overhang:55,gap:.03,name:`Mini ${i+1}`,preserve_frame:true,indexed:true}));
 const before=performance.now();
 const summary=JSON.parse(await py.runPythonAsync('browser_engine.run(settings)'));
 const seconds=(performance.now()-before)/1000;
 await writeFile(`test-results/plate/${i}-supported.3mf`,py.FS.readFile('/output.3mf'));
 results.push({i,seconds,...summary});
 console.log(JSON.stringify({part:i+1,seconds,elapsed:(performance.now()-started)/1000,contacts:summary.contacts,timings:summary.timings}));
 await writeFile('test-results/plate/generation.json',JSON.stringify(results,null,2));
}
