import assert from 'node:assert/strict';
import {createIndex, cast, createSupportSamplerBridge} from '../src/support-sampler.ts';
const v = new Float64Array([
  0,0,2, 0,2,2, 2,0,2,
  0,0,4, 0,2,4, 2,0,4,
  0,0,1, 2,0,1, 0,2,1, // up-facing, deliberately excluded
  0,0,0, 0,0,2, 0,2,0, // vertical, deliberately excluded
]);
const f = new Uint32Array([0,1,2, 3,4,5, 6,7,8, 9,10,11]);
const n = new Float64Array([0,0,-1, 0,0,-1, 0,0,1, 1,0,0]);
const points=new Float64Array([.25,.25,0, .25,.25,3, .25,.25,5, 0,0,0, 1,1,0, -.00000001,0,0, -5,-5,0, .25,.25,2.0000005]);
const index=createIndex(v,f,n),result=cast(index,points);
assert.deepEqual([...result.ids],[0,1,-1,0,0,0,-1,0]);
assert.deepEqual([...result.z],[2,4,NaN,2,2,2,NaN,2]);
assert.deepEqual([...cast(index,new Float64Array()).z],[]);
assert.deepEqual([...cast(createIndex(new Float64Array(),new Uint32Array(),new Float64Array()),points).ids],Array(8).fill(-1));
assert.throws(()=>cast(index,new Float64Array([NaN,0,0])),/Non-finite/);
assert.throws(()=>cast(index,new Float64Array([0,0,Infinity])),/Non-finite/);
assert.throws(()=>cast(index,new Float64Array([0,0])),/Invalid/);
assert.throws(()=>createIndex(new Float64Array([Infinity,0,0]),new Uint32Array(),new Float64Array()),/Non-finite/);
const huge=createIndex(new Float64Array([-500,-500,2, -500,500,2, 500,-500,2]),new Uint32Array([0,1,2]),new Float64Array([0,0,-1]));
assert.equal(huge.large.length,1);
assert.deepEqual([...cast(huge,new Float64Array([-1,-1,0,600,600,0])).ids],[0,-1]);
assert(huge.grid.length<101500);
const bridge=createSupportSamplerBridge(),id=bridge.create(v,f,n);
assert.deepEqual(bridge.query(id,points,1e-6),result);
bridge.destroy(id);assert.throws(()=>bridge.query(id,points,1e-6),/released/);
// A small face must win a same-height tie against a geometrically large face,
// even when its original face ID comes later in the mesh.
const tie=createIndex(new Float64Array([-500,-500,2,-500,500,2,500,-500,2, -1,-1,2,-1,1,2,1,-1,2]),
  new Uint32Array([0,1,2,3,4,5]),new Float64Array([0,0,-1,0,0,-1]),new Int32Array([1,0]));
assert.deepEqual([...cast(tie,new Float64Array([-.5,-.5,0])).ids],[1]);
console.log('Sampler checks passed: nearest hit, supplied z, normal filtering, borders, empty/non-finite input, large triangles, lifecycle.');
