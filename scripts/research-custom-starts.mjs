/** Original-model first-emission geometry screen for a custom-support candidate.
 * Usage: node scripts/research-custom-starts.mjs candidate-directory [native-audit.json]
 * Uses an earlier audited model-only print schedule as witnesses; this is not a
 * substitute for checking the new sliced G-code. Never writes source geometry.
 */
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {loadPyodide} from 'pyodide';
import Module from 'manifold-3d';
import {STLLoader} from 'three/examples/jsm/loaders/STLLoader.js';
const directory=path.resolve(process.argv[2]);
const witnessPath=path.resolve(process.argv[3]||'test-results/research/print-kit/native-island-audit.json');
const witnessBytes=await readFile(witnessPath),witness=JSON.parse(witnessBytes);
const summary=JSON.parse(await readFile(path.join(directory,'summary.json')));
const modelBytes=await readFile(path.join(directory,'model.stl')),supportBytes=await readFile(path.join(directory,'supports.stl'));
const hash=b=>createHash('sha256').update(b).digest('hex');
if(hash(modelBytes)!==witness.originalModelSha256)throw Error('Candidate model differs from audited original pose/mesh; derive fresh model witnesses before comparison.');
const loader=new STLLoader();
const model=loader.parse(modelBytes.buffer.slice(modelBytes.byteOffset,modelBytes.byteOffset+modelBytes.byteLength));
const support=loader.parse(supportBytes.buffer.slice(supportBytes.byteOffset,supportBytes.byteOffset+supportBytes.byteLength));
const mf=await Module();mf.setup();const py=await loadPyodide({indexURL:path.resolve('public/runtime')+'/'});
py.registerJsModule('manifold_js',{api:mf});await py.loadPackage(['numpy','scipy','shapely']);
for(const f of ['networkx-3.4.2-py3-none-any.whl','arbor-engine.zip','trimesh-5.1.1-py3-none-any.whl'])py.unpackArchive(new Uint8Array(await readFile('public/runtime/'+f)),'zip',{extractDir:'/engine'});
for(const [name,geometry]of [['model',model],['support',support]])py.FS.writeFile('/'+name+'.positions',new Uint8Array(geometry.attributes.position.array.buffer));
py.globals.set('witness_json',JSON.stringify(witness));py.globals.set('candidate_gap',summary.params.z_gap);
const checks=JSON.parse(await py.runPythonAsync(`
import sys,json,math
sys.path.insert(0,'/engine')
import wasm_compat,numpy as np,trimesh,manifold3d as mf
from pathlib import Path
from shapely.ops import unary_union
from arbor.engine.build import trimesh_to_manifold
from arbor.engine.analysis import cs_components
w=json.loads(witness_json)
translation=np.asarray(w['plateTranslationMm'],float)
def solid(name):
    positions=np.frombuffer(Path('/'+name+'.positions').read_bytes(),dtype=np.float32).reshape(-1,3).astype(float)
    v,f=np.unique(positions,axis=0,return_inverse=True)
    result=trimesh_to_manifold(trimesh.Trimesh(vertices=v+translation,faces=f.reshape(-1,3),process=False))
    assert result.status()==mf.Error.NoError,name+' must form a valid solid'
    return result
model=solid('model');support=solid('support')
first=w['modelSliceSchedule']['firstLayerMm'];height=w['modelSliceSchedule']['regularLayerMm']
cache={};results=[]
for start in w['printed_component_starts']:
    if start['status']=='bed-start':continue
    z=start['first_model_extrusion_z_mm'];base=z-start['model_layer_height_mm']
    polys=[p for _,p in cs_components(model.slice(start['model_slice_midplane_z_mm']))]
    target=np.asarray(start['centroid_plate_xy_mm'])
    poly=min(polys,key=lambda p:np.linalg.norm(np.asarray(p.centroid.coords[0])-target))
    assert np.linalg.norm(np.asarray(poly.centroid.coords[0])-target)<.0001,'Original section identity changed'
    assert abs(poly.area-start['area_mm2'])<.0001,'Original section area changed'
    witnesses=[]
    top=math.floor((base-first+.000001)/height)
    for layer in range(top,max(-1,top-math.ceil(.5/height)), -1):
        layer_z=round(first+layer*height,5)
        if layer_z not in cache:
            mid=layer_z-(first/2 if layer==0 else height/2)
            cache[layer_z]=unary_union([p for _,p in cs_components(support.slice(mid))])
        overlap=poly.intersection(cache[layer_z]).area
        if overlap>1e-8:witnesses.append(dict(support_layer_z_mm=layer_z,nominal_envelope_gap_mm=base-layer_z,intersection_area_mm2=overlap,original_start_area_fraction=overlap/poly.area))
    closest=witnesses[0] if witnesses else None
    adequate=[q for q in witnesses if q['nominal_envelope_gap_mm']<=candidate_gap+height+.00001 and q['original_start_area_fraction']>=.05]
    flags=[]
    if not closest:flags.append('No support cross-section overlaps the original first-emission island in the preceding 0.5 mm')
    else:
        if closest['nominal_envelope_gap_mm']>candidate_gap+height+.00001:flags.append('Closest positive overlap is farther than requested top gap plus one model layer')
        if closest['original_start_area_fraction']<.05:flags.append('Closest overlap covers less than 5% of original first-emission island')
    results.append(dict(index=start['index'],first_model_extrusion_z_mm=z,original_section_area_mm2=poly.area,centroid_plate_xy_mm=start['centroid_plate_xy_mm'],closest_geometry_witness=closest,overlapping_layer_count=len(witnesses),geometry_witnesses=witnesses,adequate_witness_within_gap=adequate[0] if adequate else None,flags=flags))
json.dumps(results)
`));
const result={schemaVersion:1,candidate:directory,sourceWitnessPath:witnessPath,sourceWitnessSha256:hash(witnessBytes),originalModelSha256:hash(modelBytes),supportSha256:hash(supportBytes),modelPoseIdentical:true,scope:'Geometry screen at the independently observed original-model first-emission sections, using support cross-sections at fixed slicer layer midplanes. Requires subsequent actual G-code confirmation; excludes established connected overhangs.',screen:{maximumNominalEnvelopeGapMm:summary.params.z_gap+witness.modelSliceSchedule.regularLayerMm,minimumOriginalSectionOverlapFraction:.05,minimumPositiveIntersectionMm2:1e-8},starts:checks,summary:{aboveBedOriginalStarts:checks.length,screenFlags:checks.filter(c=>c.flags.length).length,startsWithoutAdequateOverlapWithinGap:checks.filter(c=>!c.adequate_witness_within_gap).length},passed:checks.every(c=>!c.flags.length)};
const output=path.join(directory,'original-start-geometry-audit.json');await writeFile(output,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({output,passed:result.passed,...result.summary,flagged:checks.filter(c=>c.flags.length).map(c=>({index:c.index,closest:c.closest_geometry_witness,adequateWithinGap:c.adequate_witness_within_gap,flags:c.flags}))},null,2));
