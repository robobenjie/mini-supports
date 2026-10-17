import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { DOMParser } from '@xmldom/xmldom';
import { Mesh, Matrix4, Vector3 } from 'three';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';
import { parse3MF, centerOnPlate } from '../src/model-import.ts';
import { simplifyMesh, simplifierReady } from '../src/simplify.ts';
globalThis.DOMParser = DOMParser;
await simplifierReady;
const file = process.argv[2];
if (!file) throw new Error('Pass the path to a local 3MF to benchmark.');
await mkdir('test-results/plate', { recursive: true });
const start = performance.now(), data = await readFile(file);
const imported = parse3MF(data.buffer.slice(data.byteOffset,data.byteOffset+data.byteLength), { simplify: simplifyMesh, progress: (f, s) => console.log(`${((performance.now()-start)/1000).toFixed(1)}s ${s}`) });
imported.geometry.computeBoundingBox();
const offset=imported.geometry.boundingBox.getCenter(new Vector3()).negate();offset.z=-imported.geometry.boundingBox.min.z;
let triangles=0, proxy=0;
for (const [i, mini] of imported.minis.entries()) {
 mini.geometry.translate(offset.x,offset.y,offset.z);
 triangles+=mini.triangles;proxy+=mini.geometry.getAttribute('position').count/3;
 if(mini.topology){
  const vertices=mini.topology.vertices;
  for(let j=0;j<vertices.length;j+=3){vertices[j]+=offset.x;vertices[j+1]+=offset.y;vertices[j+2]+=offset.z}
  await writeFile(`test-results/plate/${i}.vertices`,new Uint8Array(vertices.buffer));
  await writeFile(`test-results/plate/${i}.indices`,new Uint8Array(mini.topology.indices.buffer));
 }
 await writeFile(`test-results/plate/${i}.stl`,new Uint8Array(new STLExporter().parse(new Mesh(mini.geometry),{binary:true}).buffer));
}
await writeFile('test-results/plate/import.json',JSON.stringify({seconds:(performance.now()-start)/1000,parts:imported.minis.length,triangles,proxy},null,2));
console.log({seconds:(performance.now()-start)/1000,parts:imported.minis.length,triangles,proxy});
