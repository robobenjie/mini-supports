import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { DOMParser } from '@xmldom/xmldom';
import { SphereGeometry, Mesh, Matrix4 } from 'three';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';
import { archive, modelXML } from './3mf-fixtures.mjs';
import { parse3MF, parse3MFAsync } from '../src/model-import.ts';
import { simplifyMesh, simplifierReady } from '../src/simplify.ts';
import { SimplifyPool } from '../src/simplify-pool.ts';
import { Plate } from '../src/plate.ts';
globalThis.DOMParser = DOMParser;
await simplifierReady;
let active = 0, peak = 0, jobs = 0, created = 0, terminated = 0;
const workerURL = new URL('../src/simplify.worker.ts', import.meta.url).href;
// Run the actual browser worker module in real Node threads, including transfers.
function createWorker() {
  created++;
  const thread = new Worker(`const {parentPort}=require('node:worker_threads');
    globalThis.self={postMessage:(data,options)=>parentPort.postMessage(data,options.transfer)};
    import(${JSON.stringify(workerURL)}).then(()=>parentPort.on('message',data=>self.onmessage({data})));`, {eval:true});
  const worker = {
    onmessage:null,onerror:null,onmessageerror:null,
    postMessage(data,transfer) { jobs++; active++; peak=Math.max(peak,active); thread.postMessage(data,transfer); },
    terminate() { terminated++; void thread.terminate(); },
  };
  thread.on('message',data=>{active--;worker.onmessage?.({data});});
  thread.on('error',error=>worker.onerror?.({message:error.message}));
  return worker;
}
const geometry = new SphereGeometry(10,80,64);
const vertices = geometry.getAttribute('position').array, indices = geometry.index.array;
let xml='<mesh><vertices>';
for(let i=0;i<vertices.length;i+=3)xml+=`<vertex x="${vertices[i]}" y="${vertices[i+1]}" z="${vertices[i+2]}"/>`;
xml+='</vertices><triangles>';
for(let i=0;i<indices.length;i+=3)xml+=`<triangle v1="${indices[i]}" v2="${indices[i+1]}" v3="${indices[i+2]}"/>`;
xml+='</triangles></mesh>';
const resources=Array.from({length:10},(_,i)=>`<object id="${i+1}" name="Part ${i+1}">${xml}</object>`).join('');
const build=Array.from({length:10},(_,i)=>`<item objectid="${i+1}" transform="1 0 0 0 1 0 0 0 1 ${i*30} 0 0"/>`).join('')+'<item objectid="1" transform="-1 0 0 0 1 0 0 0 1 0 30 0"/>';
const input=archive(modelXML(resources,build,'centimeter')).buffer;
const serial=parse3MF(input,{simplify:simplifyMesh});
const pool=new SimplifyPool(createWorker);
try {
  const progress=[];
  const parallel=await parse3MFAsync(input,pool.simplify,f=>progress.push(f));
  assert.equal(peak,8);assert.equal(created,8);assert.equal(jobs,10,'Repeated instances must simplify once');
  assert.equal(parallel.minis.length,11);
  for(let i=0;i<parallel.minis.length;i++){
    assert.deepEqual(parallel.minis[i].geometry.getAttribute('position').array,serial.minis[i].geometry.getAttribute('position').array);
    assert.deepEqual(parallel.minis[i].topology,serial.minis[i].topology);
    assert.equal(parallel.minis[i].triangles,indices.length/3);
  }
  assert(progress.every((f,i)=>!i||f>=progress[i-1]));assert.equal(progress.at(-1),1);
  assert.deepEqual(parallel.source.archive.read('3D/3dmodel.model'),serial.source.archive.read('3D/3dmodel.model'));
  console.log('PASS eight real workers, queued meshes, repeated instances, mirrors, units, exact serial geometry and original source');

  const stl=new STLExporter().parse(new Mesh(geometry),{binary:true});
  const files=Array.from({length:10},(_,i)=>({name:`part-${i}.stl`,data:stl.buffer.slice(0)}));
  const expected=await new Plate().load(files,()=>{});
  const plate=new Plate(),fractions=[];
  const actual=await plate.load(files,f=>fractions.push(f),undefined,pool.simplify);
  assert.deepEqual(actual,expected,'Parallel STL placements, topology, and file order must match');
  assert(fractions.every((f,i)=>!i||f>=fractions[i-1]));
  assert.equal(created,8,'One shared pool across all files');
  const generated=archive(modelXML(`<object id="1">${xml}</object>`));
  const output=plate.export(actual.minis.map(p=>({name:p.name,output:generated,lift:0,transform:new Matrix4().toArray()})),()=>{});
  const reread=parse3MF(output.buffer);
  for(const mini of reread.minis)assert.equal(mini.triangles,indices.length/3,'Exports retain original full-detail triangles');
  console.log('PASS multi-STL parallel import, deterministic placement, monotonic progress, full-detail export');
} finally {pool.dispose();}
assert.equal(terminated,created);

const cloneMesh=()=>({vertices:vertices.slice(),indices:new Uint32Array(indices)});
const cancelled=new SimplifyPool(createWorker);
const pending=Array.from({length:12},()=>cancelled.simplify(cloneMesh()));
const settled=Promise.allSettled(pending);
cancelled.dispose(new Error('Cancelled import'));
assert((await settled).every(r=>r.status==='rejected'&&r.reason.message==='Cancelled import'));
assert.equal(terminated,created);
await assert.rejects(cancelled.simplify(cloneMesh()),/Cancelled import/);
const broken=new SimplifyPool(()=>{throw new Error('Worker unavailable');});
await assert.rejects(broken.simplify(cloneMesh()),/Worker unavailable/);
console.log('PASS cancellation terminates workers and rejects active/queued jobs; startup errors propagate');
geometry.dispose();
