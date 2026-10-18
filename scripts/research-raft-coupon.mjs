/** Matched printable cage specimens for the private research plate.
 * The support routing is a controlled fixture; pad planning and bracing use the
 * production engine. This isolates removal topology from automatic coverage.
 */
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {loadPyodide} from 'pyodide';
import Module from 'manifold-3d';

const out=path.resolve(process.argv[2]??'test-results/research/unified-print-kit/raft-coupons');
const mf=await Module();mf.setup();
const py=await loadPyodide({indexURL:path.resolve('public/runtime')+'/'});
py.registerJsModule('manifold_js',{api:mf});
py.registerJsModule('browser_bridge',{progress:()=>{}});
await py.loadPackage(['numpy','scipy','shapely']);
for(const f of ['networkx-3.4.2-py3-none-any.whl','arbor-engine.zip','trimesh-5.1.1-py3-none-any.whl'])
  py.unpackArchive(new Uint8Array(await readFile('public/runtime/'+f)),'zip',{extractDir:'/engine'});
for(const f of ['params','tree','build','raft_split','types'])
  py.FS.writeFile('/engine/arbor/engine/'+f+'.py',await readFile('vendor/arborfdm/arbor/engine/'+f+'.py'));
py.FS.writeFile('/coupon.py',await readFile(new URL('./research-raft-coupon.py',import.meta.url)));
try{await py.runPythonAsync("exec(open('/coupon.py').read())");}
catch(error){console.error(error.message);process.exit(1);}
await mkdir(out,{recursive:true});
const sha=b=>createHash('sha256').update(b).digest('hex');
const specimens=[];
for(const id of ['R0','R1']){
  const dir=path.join(out,id);await mkdir(dir,{recursive:true});
  for(const file of py.FS.readdir('/out/'+id).filter(f=>!f.startsWith('.')))
    await writeFile(path.join(dir,file),py.FS.readFile('/out/'+id+'/'+file));
  const summary=JSON.parse(await readFile(path.join(dir,'summary.json'),'utf8'));
  summary.originalGeometryIntegrity={modelStlSha256:sha(await readFile(path.join(dir,'model.stl')))};
  await writeFile(path.join(dir,'summary.json'),JSON.stringify(summary,null,2)+'\n');
  specimens.push({id,label:id==='R0'?'Intact cage pad':'Bent split cage pad',files:['model.stl','supports.stl'].map(f=>path.join(dir,f)),fixtureSummary:path.join(dir,'summary.json'),settings:{enable_support:'0'},addLabel:true,source:'Synthetic controlled removal coupon',study:{question:'Does a bent split through a single broad raft, together with omission of cross-seam braces, make a surrounding cage easier to remove?',control:'Identical original model, tip caps, gaps, rooted trees and pad perimeter.',difference:id==='R0'?'Intact pad and full cage bracing.':'0.6 mm bent seam and no braces across the two resulting support groups.',physicalOutcomePending:true}});
}
await writeFile(path.join(out,'specimens.json'),JSON.stringify({specimens},null,2)+'\n');
await writeFile(path.join(out,'geometry-validation.json'),py.FS.readFile('/out/geometry-validation.json'));
console.log(JSON.stringify({out,specimens},null,2));
