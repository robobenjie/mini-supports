import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DOMParser } from '@xmldom/xmldom';
import { Box3, Matrix4, Mesh, Vector3 } from 'three';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { Plate } from '../src/plate.ts';
import { Mini } from '../src/mini.ts';
import { PART_GAP, placeNearby } from '../src/placement.ts';
import { BufferGeometry, BufferAttribute } from 'three';
import { parse3MF } from '../src/model-import.ts';
import { ZipArchive } from '../src/zip-archive.ts';
import { arrangedShelves } from './3mf-fixtures.mjs';
globalThis.DOMParser=DOMParser;
const bytes=await arrangedShelves(), data=bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);
const plate=new Plate(), imported=await plate.load([{name:'shelves.3mf',data}],()=>{});
const minis=imported.minis.map((p,i)=>new Mini(`mini-${i}`,p.name,{...p,geometry:new BufferGeometry().setAttribute('position',new BufferAttribute(p.positions,3))}));
// Use a real validated engine result, but retain only its support/raft objects in the final plate.
const generated=new Uint8Array(await readFile('test-results/shelf-supported.3mf'));
const pack=()=>plate.export(minis.map(m=>({output:generated,lift:0,transform:m.exportTransform(),name:m.name})),()=>{});
const initial=pack(), archive=new ZipArchive(initial);
const original=new ZipArchive(bytes);
assert.deepEqual(archive.read('3D/source0/3D/Objects/shelf.model'),original.read('3D/Objects/shelf.model'),'Original model XML must survive byte-for-byte');
function checkStudioReferences(bytes) {
 const archive=new ZipArchive(bytes),parser=new DOMParser(),models=new Map(),ids=new Set();
 for(const name of archive.members.keys())if(name.endsWith('.model')){
  const xml=new TextDecoder().decode(archive.read(name)).replace(/<mesh\b[^>]*>[\s\S]*?<\/mesh>/g,'<mesh/>');
  const doc=parser.parseFromString(xml,'application/xml'),objects=new Map();
  for(const object of Array.from(doc.getElementsByTagName('object'))){
   const id=object.getAttribute('id');assert(!ids.has(id),'Studio shares meshes by ID across files: every object ID must be unique');ids.add(id);objects.set(id,object);
  }
  models.set(name,{doc,objects});
 }
 const root=models.get('3D/3dmodel.model');assert(root,'Use the conventional root model path');
 const rels=parser.parseFromString(new TextDecoder().decode(archive.read('3D/_rels/3dmodel.model.rels')),'application/xml');
 const related=new Set(Array.from(rels.getElementsByTagName('Relationship')).map(r=>r.getAttribute('Target')));
 for(const component of Array.from(root.doc.getElementsByTagName('component'))){
  const path=component.getAttribute('p:path');assert(related.has(path),'Every external mesh needs a relationship');
  const object=models.get(path.slice(1))?.objects.get(component.getAttribute('objectid'));assert(object,'Every component resolves to its own mesh');
  assert.equal(object.getElementsByTagName('mesh').length,1,'Studio sub-models must be mesh leaves, not nested cross-file assemblies');
  assert.equal(object.getElementsByTagName('components').length,0);
 }
}
checkStudioReferences(initial);
const reread=parse3MF(initial.buffer);
assert.equal(reread.minis.length,2);
for(let i=0;i<2;i++){
 const actual=reread.minis[i].geometry.getAttribute('position').array;
 // All components get one common export offset. Compare relative mesh coordinates.
 const expected=imported.minis[i].positions;
 const offset=[actual[0]-expected[0],actual[1]-expected[1],actual[2]-expected[2]];
 for(let k=0;k<expected.length;k++) assert(Math.abs(actual[k]-expected[k]-offset[k%3])<1e-4);
}
const unchanged=minis[1].exportTransform();
minis[0].setRotation('x',31);minis[0].setRotation('y',-14);minis[0].setScale(125);
assert.deepEqual(minis[1].exportTransform(),unchanged);
const rotated=parse3MF(pack().buffer);assert.equal(rotated.minis.length,2);
for(let i=0;i<2;i++){
 const expected=new STLLoader().parse(minis[i].exportSTL()).getAttribute('position').array;
 const indexed=minis[i].exportMesh();
 assert(!(indexed instanceof ArrayBuffer),'3MFs should retain indexed geometry through generation');
 const vertices=new Float32Array(indexed.vertices),indices=new Uint32Array(indexed.indices);
 for(let k=0;k<indices.length;k++)for(let axis=0;axis<3;axis++)assert(Math.abs(vertices[indices[k]*3+axis]-expected[k*3+axis])<1e-4,'Indexed handoff must match the transformed preview');
 const actual=rotated.minis[i].geometry.getAttribute('position').array;
 const offset=[actual[0]-expected[0],actual[1]-expected[1],actual[2]-expected[2]];
 for(let k=0;k<expected.length;k++)assert(Math.abs(actual[k]-expected[k]-offset[k%3])<1e-4,'Original geometry must receive exactly the preview rotation and scale');
}
console.log('PASS compressed original-detail export, nested references, shared placement, independent rotation and scaling');
for(const mini of minis)mini.dispose();

// Two inputs with identical internal paths must not alias each other; units and
// mirrors must still agree between preview and exported originals.
const {archive:fixtureArchive,modelXML,meshXML}=await import('./3mf-fixtures.mjs');
const {BoxGeometry}=await import('three');
const box=new BoxGeometry(1,2,3).toNonIndexed();
const object=`<object id="1">${meshXML(box.getAttribute('position').array)}</object>`;
const files=['inch','millimeter'].map((unit,i)=>({name:`${unit}.3mf`,data:fixtureArchive(modelXML(object,'<item objectid="1" transform="-1 0 0 0 1 0 0 0 1 3 0 2"/>',unit)).buffer}));
const mixedPlate=new Plate(),mixed=await mixedPlate.load(files,()=>{});
const output=mixedPlate.export(mixed.minis.map(part=>({output:generated,lift:0,transform:new Matrix4().toArray(),name:part.name})),()=>{});
const parsed=parse3MF(output.buffer);
checkStudioReferences(output);
assert.equal(parsed.minis.length,2);
for(let i=0;i<2;i++){
 const expected=mixed.minis[i].positions,actual=parsed.minis[i].geometry.getAttribute('position').array;
 const offset=[actual[0]-expected[0],actual[1]-expected[1],actual[2]-expected[2]];
 for(let k=0;k<expected.length;k++)assert(Math.abs(actual[k]-expected[k]-offset[k%3])<1e-4,'Mixed units or mirrored placement changed');
}
console.log('PASS mixed-source export with colliding paths, unit conversion, and mirrors');
console.log('PASS Studio compatibility: direct mesh references, globally unique IDs, and complete relationships');

// An STL has no source package or component tree. It still needs a full-detail
// mesh reference, including when the engine returns no supports or raft.
const stlBytes=await readFile('public/examples/shelf.stl'),stlPlate=new Plate();
const stlImport=await stlPlate.load([{name:'shelf.stl',data:stlBytes.buffer.slice(stlBytes.byteOffset,stlBytes.byteOffset+stlBytes.byteLength)}],()=>{});
const modelOnly=fixtureArchive(modelXML(`<object id="1">${meshXML(stlImport.minis[0].positions)}</object>`));
const stlOutput=stlPlate.export([{output:modelOnly,lift:0,transform:new Matrix4().toArray(),name:'shelf'}],()=>{});
checkStudioReferences(stlOutput);
const stlRead=parse3MF(stlOutput.buffer);
assert.equal(stlRead.minis.length,1);
const stlActual=stlRead.minis[0].geometry.getAttribute('position').array,stlExpected=stlImport.minis[0].positions;
assert.equal(stlActual.length,stlExpected.length,'STL triangle count must survive export');
const stlOffset=[stlActual[0]-stlExpected[0],stlActual[1]-stlExpected[1],stlActual[2]-stlExpected[2]];
for(let k=0;k<stlExpected.length;k++)assert(Math.abs(stlActual[k]-stlExpected[k]-stlOffset[k%3])<1e-4,'STL geometry must survive export, apart from the common plate translation');
assert(![...new ZipArchive(stlOutput).members.keys()].some(path=>path.startsWith('3D/supports/')));
console.log('PASS STL geometry-only export with no generated support or raft meshes');

// Add an STL through the same transferable state used by the import worker.
// Existing transforms and support results must survive the commit unchanged.
const growingPlate=new Plate(),existing=await growingPlate.load([{name:'shelves.3mf',data:data.slice(0)}],()=>{});
const makeMini=(p,i)=>new Mini(`part-${i}`,p.name,{...p,geometry:new BufferGeometry().setAttribute('position',new BufferAttribute(p.positions,3))});
const existingMinis=existing.minis.map(makeMini);
existingMinis[0].setRotation('x',23);existingMinis[0].setPosition('x',-60);existingMinis[0].setPosition('z',4);
const cached={summary:JSON.parse(await readFile('test-results/shelf.json','utf8')),output:generated};
for(const mini of existingMinis)mini.applyResult(cached,mini.revision);
const beforeParts=JSON.stringify(growingPlate.parts),beforeTransforms=existingMinis.map(mini=>mini.exportTransform());
const footprint=mini=>{const b=new Box3().setFromObject(mini.root,true);return {minX:b.min.x,minY:b.min.y,maxX:b.max.x,maxY:b.max.y}};
const placement={occupied:existingMinis.map(footprint)};
const candidate=new Plate(),added=await candidate.load([{name:'shelf.stl',data:stlBytes.buffer.slice(stlBytes.byteOffset,stlBytes.byteOffset+stlBytes.byteLength)}],()=>{},placement);
assert.equal(growingPlate.parts.length,2,'Uncommitted imports must leave the current plate alone');
const snapshot=candidate.snapshot(),buffers=[...new Set(snapshot.sources.flatMap(source=>[...source.members.values()].map(m=>m.compressed.buffer)))];
growingPlate.append(structuredClone(snapshot,{transfer:buffers}));
assert.equal(growingPlate.parts.length,3);
assert.equal(JSON.stringify(growingPlate.parts.slice(0,2)),beforeParts);
for(const [i,mini] of existingMinis.entries()){
 assert.equal(mini.result,cached,'Adding a model must retain cached results');
 assert.deepEqual(mini.exportTransform(),beforeTransforms[i],'Adding a model must not reposition existing parts');
}
const addedMini=makeMini(added.minis[0],2),allMinis=[...existingMinis,addedMini];
const separated=(a,b)=>a.maxX+PART_GAP<=b.minX+1e-4||b.maxX+PART_GAP<=a.minX+1e-4||a.maxY+PART_GAP<=b.minY+1e-4||b.maxY+PART_GAP<=a.minY+1e-4;
assert(placement.occupied.every(b=>separated(footprint(addedMini),b)),'New STL must leave clearance around existing parts');
const geometryOnly=allMinis.map(mini=>({output:fixtureArchive(modelXML(`<object id="1">${meshXML(new STLLoader().parse(mini.exportSTL()).getAttribute('position').array)}</object>`)),lift:0,transform:mini.exportTransform(),name:mini.name}));
const appendedExport=growingPlate.export(geometryOnly,()=>{});checkStudioReferences(appendedExport);
const appendedRead=parse3MF(appendedExport.buffer);assert.equal(appendedRead.minis.length,3);
let commonOffset;
for(const [i,mini] of allMinis.entries()){
 const expected=new STLLoader().parse(mini.exportSTL()).getAttribute('position').array,actual=appendedRead.minis[i].geometry.getAttribute('position').array;
 assert.equal(actual.length,expected.length);
 commonOffset??=[actual[0]-expected[0],actual[1]-expected[1],actual[2]-expected[2]];
 for(let k=0;k<expected.length;k++)assert(Math.abs(actual[k]-expected[k]-commonOffset[k%3])<1e-4,'Moved originals and appended STL must export in the same working frame');
}
// Remove from the middle of a shared source, then append and remove a whole source.
const keptTransforms=[existingMinis[0].exportTransform(),addedMini.exportTransform()];
growingPlate.remove(1);
const afterDelete=growingPlate.export([geometryOnly[0],geometryOnly[2]],()=>{});
assert.equal(parse3MF(afterDelete.buffer).minis.length,2,'Deleted models must be absent from the download');
checkStudioReferences(afterDelete);
assert.equal(existingMinis[0].result,cached,'Deleting a neighbor must keep supports');
assert.deepEqual([existingMinis[0].exportTransform(),addedMini.exportTransform()],keptTransforms);
growingPlate.remove(0);
assert.equal(growingPlate.sources.length,1,'Unreferenced source archives should be released');
assert.equal(growingPlate.parts[0].source,0,'Remaining source indexes must follow compaction');
growingPlate.append(stlPlate.snapshot());
assert.equal(growingPlate.parts.length,2,'Adding after deletion must preserve the new source mapping');
const afterReAdd=growingPlate.export([geometryOnly[2],{output:modelOnly,lift:0,transform:new Matrix4().toArray(),name:'re-added'}],()=>{});
assert.equal(parse3MF(afterReAdd.buffer).minis.length,2);checkStudioReferences(afterReAdd);
growingPlate.remove(1);growingPlate.remove(0);
assert.equal(growingPlate.sources.length,0);assert.equal(growingPlate.parts.length,0);
assert.throws(()=>growingPlate.remove(-1));assert.throws(()=>growingPlate.remove(0));
console.log('PASS per-mini deletion, retained neighbors, source cleanup, re-append, and matching export');

assert.equal(existingMinis[0].setPosition('x',existingMinis[0].coordinates()[0]),false,'Unchanged positions must retain supports');
assert.equal(existingMinis[0].result,cached);
const revision=existingMinis[0].revision;
existingMinis[0].model.position.add(new Vector3(10,-3,6));assert(existingMinis[0].commitMove());
assert.equal(existingMinis[0].result,cached,'Moving must retain the existing support result');assert.equal(existingMinis[0].applyResult(cached,revision),false);
assert.deepEqual(existingMinis[0].exportSupportOffset(),[10,-3,6]);
assert.equal(existingMinis[1].result,cached,'Moving one mini must preserve the other mini’s supports');
assert.equal(existingMinis[0].coordinates()[2],10);
existingMinis[0].setRotation('y',-17);existingMinis[0].setScale(130);
assert.equal(existingMinis[0].result,undefined,'Rotation still invalidates the moved mini');
assert.deepEqual(existingMinis[0].exportSupportOffset(),[0,0,0],'Regenerated supports start in the current frame');
assert(Math.abs(new Box3().setFromObject(existingMinis[0].model,true).min.z-10)<1e-4,'Rotation and scaling must preserve the moved height');
existingMinis[0].setPosition('z',-20);assert.equal(existingMinis[0].coordinates()[2],0,'Moves stop at the bed');
assert(Math.abs(new Box3().setFromObject(existingMinis[0].model,true).min.z)<1e-4);
allMinis.forEach(mini=>mini.dispose());
console.log('PASS staged STL append, retained placement and supports, move gizmo edits, height, and full-detail combined export');

// The actual import path must pack a batch as a compact clump, not a horizontal row.
const batchPlate=new Plate(),batch=await batchPlate.load(Array.from({length:16},(_,i)=>({name:`shelf-${i}.stl`,data:stlBytes.buffer.slice(stlBytes.byteOffset,stlBytes.byteOffset+stlBytes.byteLength)})),()=>{});
const batchMinis=batch.minis.map(makeMini),rectangles=batchMinis.map(footprint);
for(let i=0;i<rectangles.length;i++)for(let j=0;j<i;j++)assert(separated(rectangles[i],rectangles[j]));
const allBounds=new Box3();batchMinis.forEach(mini=>allBounds.union(new Box3().setFromObject(mini.root,true)));
const batchSize=allBounds.getSize(new Vector3());
assert(Math.max(batchSize.x,batchSize.y)/Math.min(batchSize.x,batchSize.y)<1.7,'A batch should grow in both XY directions');
const hole=rectangles[5],withHole=rectangles.filter((_,i)=>i!==5);
const fill=placeNearby(hole.maxX-hole.minX,hole.maxY-hole.minY,withHole);
assert(fill.minX>=allBounds.min.x-1e-4&&fill.maxX<=allBounds.max.x+1e-4&&fill.minY>=allBounds.min.y-1e-4&&fill.maxY<=allBounds.max.y+1e-4,'Use nearby gaps before growing the envelope');
const varying=[];
for(let i=0;i<150;i++){
 const rect=placeNearby(4+(i*7)%31,5+(i*13)%27,varying);
 assert(varying.every(other=>separated(rect,other)),'Different sized parts must not overlap');varying.push(rect);
}
batchMinis.forEach(mini=>mini.dispose());
console.log(`PASS compact batch placement (${batchSize.x} × ${batchSize.y} mm), gap filling, and 150 varied footprints`);
