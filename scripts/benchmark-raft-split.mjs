/** Local STL integration check. Files stay under ignored test-results/raft-split.
 * node scripts/benchmark-raft-split.mjs model.stl [another.stl ...]
 */
import {loadPyodide} from 'pyodide';
import Module from 'manifold-3d';
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const files=process.argv.slice(2);
if(!files.length)throw Error('Pass one or more local STL paths');
const manifold=await Module();manifold.setup();
const py=await loadPyodide({indexURL:path.resolve('public/runtime')+'/'});
py.registerJsModule('manifold_js',{api:manifold});
py.registerJsModule('browser_bridge',{progress:()=>{}});
await py.loadPackage(['numpy','scipy','shapely']);
for(const file of ['networkx-3.4.2-py3-none-any.whl','arbor-engine.zip','trimesh-5.1.1-py3-none-any.whl'])
  py.unpackArchive(new Uint8Array(await readFile(`public/runtime/${file}`)),'zip',{extractDir:'/engine'});
await py.runPythonAsync("import sys\nsys.path.insert(0,'/engine')\nimport browser_engine");
const directory=path.resolve('test-results/raft-split/collection');
await mkdir(directory,{recursive:true});
const results=[];
try {
  for(const [index,file] of files.entries()) {
    py.FS.writeFile('/input.stl',await readFile(file));
    const pair=[];
    for(const raftSplit of [false,true]) {
      py.globals.set('settings',JSON.stringify({profile:'nozzle_02_normal',raft:true,raftSplit,
        overhang:55,gap:.03,name:path.basename(file,'.stl'),preserve_frame:true}));
      const start=performance.now();
      const summary=JSON.parse(await py.runPythonAsync('browser_engine.run(settings)'));
      const variant=raftSplit?'split':'intact';
      await writeFile(path.join(directory,`${index}-${variant}.3mf`),py.FS.readFile('/output.3mf'));
      const result={model:path.basename(file),variant,seconds:(performance.now()-start)/1000,...summary};
      pair.push(result);results.push(result);
      assert(summary.supportWatertight,'Generated support mesh must stay closed');
      console.log(JSON.stringify({model:result.model,variant,seconds:result.seconds,
        contacts:summary.contacts,raftSplit:summary.raftSplit,
        errors:summary.issues.filter(i=>i.severity==='error').map(i=>i.code)}));
    }
    assert.equal(pair[0].contacts,pair[1].contacts,'Raft splitting must retain contact count');
    assert.equal(pair[0].trees,pair[1].trees,'Raft splitting must retain rooted support trees');
    assert.deepEqual(pair[0].issues.filter(i=>i.severity==='error'),pair[1].issues.filter(i=>i.severity==='error'),
      'Raft splitting must not introduce engine errors');
    await writeFile(path.join(directory,'results.json'),JSON.stringify(results,null,2)+'\n');
  }
} catch(error) {console.error(error.message);process.exitCode=1;}
