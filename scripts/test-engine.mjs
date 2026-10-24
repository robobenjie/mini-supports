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
// Binding parity: affine transforms, booleans, holes, cap direction, slicing.
await py.runPythonAsync(`
import manifold3d as mf
import numpy as np
from arbor.engine.build import cone_between
box = mf.Manifold.cube((2,3,4))
assert abs(box.volume()-24)<1e-6
assert abs(box.slice(2).area()-6)<1e-6
assert abs(box.trim_by_plane((0,0,1),2).volume()-12)<1e-6
assert abs((box ^ box.translate((1,0,0))).volume()-12)<1e-6
assert abs((box - box.translate((1,0,0))).volume()-12)<1e-6
cone = cone_between([2,3,4],[2,3,14],1,1,32)
verts=cone.to_mesh().vert_properties
assert np.allclose(verts.min(axis=0),[1,2,4],atol=1e-5)
assert np.allclose(verts.max(axis=0),[3,4,14],atol=1e-5)
assert cone.volume() > 30
assert box.status() == mf.Error.NoError
invalid = mf.Manifold(mf.Mesh(vert_properties=np.array([[0,0,0],[1,0,0],[0,1,0]],dtype=np.float32), tri_verts=np.array([[0,1,2]],dtype=np.uint32)))
assert invalid.status() != mf.Error.NoError
assert invalid.is_empty()
assert np.array_equal(np.repeat([2,3],np.array([1,2],dtype=np.int64)),[2,3,3])
assert np.array_equal(np.bincount(np.array([0,2,2],dtype=np.int64)),[1,0,2])
`);
await mkdir('test-results',{recursive:true});
for (const fixture of (process.argv.slice(2).length ? process.argv.slice(2) : ['shelf','cube','suspended_arm','arranged-shelves'])) {
 py.FS.writeFile('/input.stl',await readFile(fixture === 'arranged-shelves' ? 'test-results/arranged-shelves.stl' : `public/examples/${fixture}.stl`));
 py.globals.set('settings',JSON.stringify({profile:'nozzle_02_normal',raft:true,overhang:55,gap:0,name:fixture}));
 const summary = JSON.parse(await py.runPythonAsync('browser_engine.run(settings)'));
 const output=py.FS.readFile('/output.3mf');
 const entries=unzipSync(output);
 assert(entries['[Content_Types].xml']); assert(entries['_rels/.rels']);
 const xml=strFromU8(entries['3D/3dmodel.model']);
 assert(xml.includes('<components>')); assert(xml.includes('unit="millimeter"'));
 assert(summary.supportWatertight, 'Support mesh must be watertight');
 assert(summary.triangles>0);
 if (fixture==='cube') assert.equal(summary.contacts,0);
 if (fixture==='shelf' || fixture==='suspended_arm') assert(summary.contacts>0);
 if (fixture === 'arranged-shelves') {
  assert(summary.contacts > 0 && summary.trees > 1);
  // Both separated, differently oriented models must receive supports. Independently
  // read the exported Core geometry and compare with the original imported plate.
  await py.runPythonAsync(`
from arbor.core.mesh_io import read_3mf, load_mesh
import trimesh
before = load_mesh('/input.stl').mesh
support = trimesh.load('/supports.stl', force='mesh')
assert np.any(support.vertices[:,0] < -10) and np.any(support.vertices[:,0] > 10), 'Both models need supports'
parts = read_3mf('/output.3mf').parts
after = parts[0].mesh
assert len(before.faces) == len(after.faces)
# The exporter translates the entire assembly into the positive octant.
a = np.unique(np.round(before.vertices - before.bounds[0], 4), axis=0)
b = np.unique(np.round(after.vertices - after.bounds[0], 4), axis=0)
assert a.shape == b.shape and np.allclose(a, b, atol=1e-4), '3MF round-trip changed model placements'
`);
 }
 await writeFile(`test-results/${fixture}-supported.3mf`, output);
 await writeFile(`test-results/${fixture}.json`, JSON.stringify(summary,null,2));
 console.log(`PASS ${fixture}: ${summary.contacts} contacts, ${summary.trees} trees, ${summary.issues.length} issues, ${Math.round(Object.values(summary.timings).reduce((a,b)=>a+b,0))}s`);
}
console.log('WASM engine and 3MF round-trip tests passed.');

// The actual incremental browser path: independent mini results, edit one mini,
// regenerate only that mini, then pack retained + regenerated meshes together.
const { DOMParser } = await import('@xmldom/xmldom'); globalThis.DOMParser = DOMParser;
const { importModels } = await import('../src/model-import.ts');
const { Mini } = await import('../src/mini.ts');
const { arrangedShelves } = await import('./3mf-fixtures.mjs');
const { Box3, Vector3, Quaternion, MathUtils } = await import('three');
const bytes = await arrangedShelves();
const imported = importModels([{name:'arranged.3mf',data:bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)}]);
assert.equal(imported.minis.length,2,'Each build item should be independently selectable');
const minis = imported.minis.map((part,i)=>new Mini(`mini-${i}`,`Mini ${i+1}`,part));
const runs = [0,0];
async function generateMini(i) {
 const mini=minis[i];runs[i]++;
 py.FS.writeFile('/input.stl',new Uint8Array(mini.exportSTL()));
 py.globals.set('settings',JSON.stringify({profile:'nozzle_02_normal',raft:true,overhang:55,gap:.03,name:mini.name,preserve_frame:true}));
 const summary=JSON.parse(await py.runPythonAsync('browser_engine.run(settings)'));
 const optional=path=>py.FS.analyzePath(path).exists?py.FS.readFile(path).slice():undefined;
 const result={summary,output:py.FS.readFile('/output.3mf').slice(),supports:optional('/supports.stl'),raft:optional('/raft.stl')};
 assert(mini.applyResult(result,mini.revision));return result;
}
async function pack(name) {
 for(let i=0;i<minis.length;i++)py.FS.writeFile(`/plate-${i}.3mf`,minis[i].result.output);
 py.globals.set('manifest',JSON.stringify({name,parts:minis.map(mini=>({lift:-mini.result.summary.plateZ}))}));
 await py.runPythonAsync('browser_engine.combine(manifest)');
 await py.runPythonAsync(`
import zipfile, xml.etree.ElementTree as ET
with zipfile.ZipFile('/plate.3mf') as archive:
    config = ET.fromstring(archive.read('Metadata/model_settings.config'))
    objects = config.findall('object')
    assert len(objects) == 2
    assert len({o.get('id') for o in objects}) == 2
    for obj in objects:
        assert any(m.get('key') == 'bottom_shell_layers' and m.get('value') == '6'
                   for part in obj.findall('part') for m in part.findall('metadata')), 'Model skin settings lost during combine'
`);
 return py.FS.readFile('/plate.3mf').slice();
}
await generateMini(0);await generateMini(1);
const initialPlate=await pack('Initial plate');
const other=minis[1],unchanged={result:other.result,model:new Uint8Array(other.exportSTL()),support:other.supports.geometry.getAttribute('position').array.slice(),lift:other.root.position.z,revision:other.revision};
assert.equal(minis[0].setRotation('x',0),false,'An unchanged angle must preserve supports');
assert(minis[0].result);
const oldRevision=minis[0].revision,oldResult=minis[0].result;
minis[0].setRotation('x',37.5);minis[0].setRotation('y',-12.4);minis[0].setRotation('z',22.2);
assert.equal(minis[0].result,undefined);assert.equal(minis[0].supports,undefined);assert.equal(minis[0].raft,undefined);
assert.equal(minis[0].applyResult(oldResult,oldRevision),false,'Stale worker results must not restore invalid supports');
assert.equal(other.result,unchanged.result);assert.equal(other.revision,unchanged.revision);
assert.deepEqual(new Uint8Array(other.exportSTL()),unchanged.model);
assert.deepEqual(other.supports.geometry.getAttribute('position').array,unchanged.support);
assert.equal(other.root.position.z,unchanged.lift);
assert(Math.abs(new Box3().setFromObject(minis[0].model,true).min.z)<1e-5,'Rotated mini must stay grounded');
const angleValues=minis[0].angles();assert(Math.abs(angleValues[0]-37.5)<1e-8);assert(Math.abs(angleValues[1]+12.4)<1e-8);assert(Math.abs(angleValues[2]-22.2)<1e-8);
await generateMini(0);
assert.deepEqual(runs,[2,1]);
const finalPlate=await pack('Rotated plate');
py.FS.writeFile('/initial-plate.3mf',initialPlate);
await py.runPythonAsync(`
import zipfile, xml.etree.ElementTree as ET
ns = {'m':'http://schemas.microsoft.com/3dmanufacturing/core/2015/02'}
def objects(path):
    with zipfile.ZipFile(path) as archive:
        root = ET.fromstring(archive.read('3D/3dmodel.model'))
    assert len(root.findall('m:build/m:item', ns)) == 2
    return {o.get('name'): o for o in root.findall('m:resources/m:object', ns)}
a, b = objects('/initial-plate.3mf'), objects('/plate.3mf')
for name in ['Mini 2', 'Mini 2 supports', 'Mini 2 raft']:
    assert ET.tostring(a[name].find('m:mesh',ns)) == ET.tostring(b[name].find('m:mesh',ns)), name + ' unexpectedly changed'
assert ET.tostring(a['Mini 1'].find('m:mesh',ns)) != ET.tostring(b['Mini 1'].find('m:mesh',ns))
from arbor.core.mesh_io import read_3mf
content = read_3mf('/plate.3mf')
assert len(content.parts) >= 4
for part in content.parts:
    assert part.mesh.is_watertight
    if part.name.endswith('raft'):
        assert abs(part.mesh.bounds[0,2]) < 1e-5, 'All rafts must rest on one shared bed'
`);
await writeFile('test-results/rotated-plate.3mf',finalPlate);
// Move cached, real support geometry without another engine invocation.
const { Plate } = await import('../src/plate.ts');
const { parse3MF } = await import('../src/model-import.ts');
const movePlate=new Plate();await movePlate.load([{name:'arranged.3mf',data:bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)}],()=>{});
const packMoved=()=>movePlate.export(minis.map(mini=>({output:mini.result.output,lift:-mini.result.summary.plateZ,transform:mini.exportTransform(),supportOffset:mini.exportSupportOffset(),name:mini.name})),()=>{});
const beforeMove=parse3MF(packMoved().buffer);
const movedSupport=other.supports.geometry.getAttribute('position').array.slice(),movedResult=other.result;
other.setPosition('x',other.coordinates()[0]+17.25);other.setPosition('y',other.coordinates()[1]-6.5);other.setPosition('z',4.25);
assert.equal(other.result,movedResult);assert.deepEqual(runs,[2,1],'Moving must not rerun the engine');
assert.deepEqual(other.supports.geometry.getAttribute('position').array,movedSupport,'Support mesh data is retained');
assert.deepEqual(other.supports.position.toArray(),[17.25,-6.5,4.25]);
assert.deepEqual(other.raft.position.toArray(),[17.25,-6.5,4.25]);
const movedPlate=packMoved(),afterMove=parse3MF(movedPlate.buffer),delta=[17.25,-6.5,4.25];
const firstBefore=beforeMove.minis[0].geometry.getAttribute('position').array,firstAfter=afterMove.minis[0].geometry.getAttribute('position').array;
const common=[firstAfter[0]-firstBefore[0],firstAfter[1]-firstBefore[1],firstAfter[2]-firstBefore[2]];
for(let i=0;i<2;i++){
 const a=beforeMove.minis[i].geometry.getAttribute('position').array,b=afterMove.minis[i].geometry.getAttribute('position').array;
 assert.equal(a.length,b.length);
 for(let k=0;k<a.length;k++)assert(Math.abs(b[k]-a[k]-common[k%3]-(i===1?delta[k%3]:0))<1e-4,'Model, supports, and raft must move together in the exported 3MF');
}
await writeFile('test-results/moved-plate.3mf',movedPlate);
console.log('PASS moving cached supports: unchanged geometry, no engine runs, and aligned model/support/raft export');
// Exercise the gizmo's quaternion path and scaling independently of a WebGL context.
minis[0].model.quaternion.premultiply(new Quaternion().setFromAxisAngle(new Vector3(0,0,1),MathUtils.degToRad(17)));
assert(minis[0].commitRotation(false));minis[0].ground();
assert.equal(other.result,unchanged.result);
minis[0].setScale(125);assert.equal(other.result,unchanged.result);
for(const mini of minis)mini.dispose();imported.geometry.dispose();
console.log('PASS incremental rotation: arbitrary XYZ + quaternion gizmo, per-mini invalidation, retained support bytes, stale results, shared bed, validated 3MF export');
