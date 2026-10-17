/** Private, reproducible research sweep. Source models never enter public/ or dist/.
 * node scripts/research-generate.mjs --models bare-arm --variants B0,C1
 * All source poses/scales are preserved; only center XY and ground Z. Variants freeze B0 lift.
 */
import { loadPyodide } from 'pyodide';
import Module from 'manifold-3d';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { DOMParser } from '@xmldom/xmldom';
import { Mesh, Matrix4 } from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';
import { Plate } from '../src/plate.ts';
globalThis.DOMParser=DOMParser;
const option=(key,fallback)=>{const i=process.argv.indexOf(key);return i<0?fallback:process.argv[i+1]};
const modelIds=option('--models','bare-arm,spanner-hand').split(',');
const variantIds=option('--variants','B0,B1,C1,C2,C3').split(',');
const rotateY=Number(option('--rotate-y','0'));if(!Number.isFinite(rotateY))throw Error('Invalid Y rotation');
const outputRoot=path.resolve('test-results/research/generated');
await mkdir(outputRoot,{recursive:true});
const candidates=JSON.parse(await readFile('test-results/research/candidate-inventory.json','utf8'));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const variants={
 B0:{label:'Legacy profile on fixed analysis proxy, .08 analysis',overrides:{}},
 B1:{label:'Process-matched .06 analysis',overrides:{layer_height:.06}},
 C1:{label:'Explicit .06 gap, .36 contact',overrides:{layer_height:.06,tip_penetration:0,z_gap:.06,tip_diameter:.36}},
 C2:{label:'C1 with stronger support structure',overrides:{layer_height:.06,tip_penetration:0,z_gap:.06,tip_diameter:.36,branch_min_diameter:1.2,trunk_diameter:2.8,brace_diameter:1.1,brace_spacing_z:6}},
 C3:{label:'C1 with denser contacts',overrides:{layer_height:.06,tip_penetration:0,z_gap:.06,tip_diameter:.36,contact_spacing:1.8,edge_spacing:1.2}},
 R1:{label:'C1 with model-foot supports disabled',overrides:{layer_height:.06,tip_penetration:0,z_gap:.06,tip_diameter:.36,allow_on_model:false}},
 R2:{label:'C2 with model-foot supports disabled',overrides:{layer_height:.06,tip_penetration:0,z_gap:.06,tip_diameter:.36,branch_min_diameter:1.2,trunk_diameter:2.8,brace_diameter:1.1,brace_spacing_z:6,allow_on_model:false}},
 R3:{label:'R2 with footprint raft',overrides:{layer_height:.06,tip_penetration:0,z_gap:.06,tip_diameter:.36,branch_min_diameter:1.2,trunk_diameter:2.8,brace_diameter:1.1,brace_spacing_z:6,allow_on_model:false,raft_enabled:true,raft_lift_auto:false,raft_lift:0}}
};
for(const id of variantIds)if(!variants[id])throw Error(`Unknown variant ${id}`);
const manifestPath=path.join(outputRoot,'manifest.json');
let manifest={schemaVersion:1,generatedAt:new Date().toISOString(),generatorCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),generatorSourceHash:hash(await readFile('scripts/research-generate.mjs')),engineArchiveHash:hash(await readFile('public/runtime/arbor-engine.zip')),notes:['Private local user collection only.','All models retain original source scale. Arm/hand preserve source pose; Spore is rotated -90 degrees about X to put its circular base down. Translation centers XY and grounds Z.','B0 uses exact deployed settings but a documented offline proxy; unlike deployed STL import, the offline proxy is simplified. Thus B0 is a parameter baseline, not byte-identical STL analysis.','B1/C1/C2/C3 freeze the model lift returned by B0 to keep model and raft placement matched.','Geometry pass is not a physical-print pass. Final Bambu toolpath validation is separate.'],specimens:[]};
try{const prior=JSON.parse(await readFile(manifestPath,'utf8'));manifest.specimens=prior.specimens||[]}catch{}
const manifold=await Module();manifold.setup();
const py=await loadPyodide({indexURL:path.resolve('public/runtime')+'/'});
py.registerJsModule('manifold_js',{api:manifold});
let lastStage='';
py.registerJsModule('browser_bridge',{progress:(f,s)=>{const stage=Math.floor(f*10);if(stage!==lastStage){console.log(`${Math.round(f*100)}% ${s}`);lastStage=stage}}});
await py.loadPackage(['numpy','scipy','shapely']);
for(const file of ['networkx-3.4.2-py3-none-any.whl','arbor-engine.zip','trimesh-5.1.1-py3-none-any.whl'])py.unpackArchive(new Uint8Array(await readFile(`public/runtime/${file}`)),'zip',{extractDir:'/engine'});
await py.runPythonAsync(`
import sys,json,gc,math
sys.path.insert(0,'/engine')
import numpy as np, trimesh, manifold3d as mf, wasm_compat
from pathlib import Path
from arbor.engine.params import load_profiles
from arbor.engine.pipeline import generate
from arbor.engine.types import Progress,NodeKind
from arbor.engine.build import trimesh_to_manifold,manifold_to_trimesh
from arbor.io.export import export_3mf,export_stl,validate_export
from browser_engine import _clean
from browser_bridge import progress
PROFILES=load_profiles(Path('/engine/profiles'))
def generate_research(config_json):
    cfg=json.loads(config_json)
    vertices=np.frombuffer(Path('/proxy.vertices').read_bytes(),dtype=np.float32).reshape(-1,3).astype(float)
    faces=np.frombuffer(Path('/proxy.indices').read_bytes(),dtype=np.uint32).reshape(-1,3)
    vertices=vertices@np.array(cfg['rotation_matrix']).reshape(4,4,order='F')[:3,:3].T
    before_proxy_vertices=len(vertices)
    vertices, remap=np.unique(vertices,axis=0,return_inverse=True)
    faces=remap[faces]
    keep=(faces[:,0]!=faces[:,1])&(faces[:,1]!=faces[:,2])&(faces[:,0]!=faces[:,2])
    proxy_collapsed=int((~keep).sum());faces=faces[keep]
    vertices+=np.array(cfg['translation'])
    model=trimesh.Trimesh(vertices=vertices,faces=faces,process=False)
    params=PROFILES['nozzle_02_normal'].params.updated(raft_enabled=True,overhang_angle_deg=55,z_gap=.03).updated(**cfg['overrides'])
    if cfg.get('fixed_lift') is not None:params=params.updated(raft_lift_auto=False,raft_lift=cfg['fixed_lift'])
    result=generate(model,params,progress=Progress(progress))
    # Export small proxy archive solely as the support/raft source for Plate.export.
    export_3mf('/proxy.3mf',model,result.support_mesh,result.raft_mesh,params=params,model_name=cfg['id'],layout='components',positive_octant=False)
    bed_shift=-result.plate_z
    for name,mesh in [('supports',result.support_mesh),('raft',result.raft_mesh)]:
        if mesh is not None and len(mesh.faces):
            bed_mesh=mesh.copy();bed_mesh.apply_translation((0,0,bed_shift));export_stl(bed_mesh,'/'+name+'.stl',weld=False)
        elif Path('/'+name+'.stl').exists():Path('/'+name+'.stl').unlink()
    # Exact-coordinate dedup only. This changes topology indexing, never the sculpture surface.
    allv=np.frombuffer(Path('/original.positions').read_bytes(),dtype=np.float32).reshape(-1,3).astype(float)
    allv+=np.array(cfg['translation'])
    original_v,original_inv=np.unique(allv,axis=0,return_inverse=True)
    original=trimesh.Trimesh(vertices=original_v,faces=original_inv.reshape(-1,3),process=False)
    full_check={'watertight':bool(original.is_watertight),'winding_consistent':bool(original.is_winding_consistent),'faces':len(original.faces)}
    try:
        full_man=trimesh_to_manifold(original);sup_man=trimesh_to_manifold(result.support_mesh)
        full_check['manifold_status']=str(full_man.status())
        if full_man.status()==mf.Error.NoError and sup_man.status()==mf.Error.NoError:
            intersection=full_man ^ sup_man
            full_check['support_intersection_volume_mm3']=float(intersection.volume())
            # Explicit local neighborhoods, not a global volume allowance. These do not
            # certify contact quality: they separate cap/pad effects from body collisions.
            routed_ids={n.contact_id for n in result.tree.nodes.values() if n.kind==NodeKind.TIP}
            masks=[]
            for c in result.contacts:
                if c.id in routed_ids:
                    rr=max(params.tip_base_diameter, (c.tip_diameter or params.tip_diameter)+params.tip_base_diameter-params.tip_diameter)
                    masks.append(mf.Manifold.sphere(rr,24).translate(c.position))
            for n in result.tree.nodes.values():
                if n.kind==NodeKind.MODEL_FOOT:masks.append(mf.Manifold.sphere(max(2*n.radius,.3),24).translate(n.position))
            outside=intersection-mf.Manifold.batch_boolean(masks,mf.OpType.Add) if masks else intersection
            full_check['intersection_outside_contact_neighborhoods_mm3']=float(outside.volume())
            full_check['contact_neighborhood_definition']='Spheres around routed surface contacts of radius equal to full tip-base diameter; model-foot spheres radius=max(foot diameter,0.3 mm). This is a locality diagnostic, not permission for all enclosed overlap.'
            full_check['intersection_components_bed']=[]
            for part in intersection.decompose():
                mm=manifold_to_trimesh(part)
                full_check['intersection_components_bed'].append(dict(volume_mm3=float(part.volume()),bounds=(mm.bounds+[0,0,bed_shift]).tolist()))
        else:full_check['collision_check']='unavailable: non-manifold source or support'
    except Exception as e:full_check['collision_check']='unavailable: '+str(e)
    # Vertical projection of each candidate onto original triangles near its proxy contact.
    tri=original.vertices[original.faces];lo=tri.min(axis=1);hi=tri.max(axis=1)
    contacts=[]
    for c in result.contacts:
        x,y,z=np.asarray(c.position,float)
        ids=np.where((lo[:,0]<=x)&(hi[:,0]>=x)&(lo[:,1]<=y)&(hi[:,1]>=y)&(hi[:,2]>=z-.25)&(lo[:,2]<=z+.25))[0]
        t=tri[ids];hits=[]
        if len(t):
            a=t[:,0];u=t[:,1]-a;v=t[:,2]-a;den=u[:,0]*v[:,1]-u[:,1]*v[:,0]
            mask=np.abs(den)>1e-14;a=a[mask];u=u[mask];v=v[mask];den=den[mask]
            w1=((x-a[:,0])*v[:,1]-(y-a[:,1])*v[:,0])/den
            w2=(u[:,0]*(y-a[:,1])-u[:,1]*(x-a[:,0]))/den
            inside=(w1>=-1e-8)&(w2>=-1e-8)&(w1+w2<=1+1e-8)
            hits=(a[:,2]+w1*u[:,2]+w2*v[:,2])[inside]
        nearest=float(hits[np.argmin(np.abs(hits-z))]) if len(hits) else None
        contact=c.to_dict();contact['position_bed_mm']=(np.asarray(c.position)+[0,0,bed_shift]).tolist()
        contact['original_vertical_surface_z_mm']=nearest
        contact['original_minus_proxy_z_mm']=None if nearest is None else nearest-z
        contact['routed']=any(n.kind==NodeKind.TIP and n.contact_id==c.id for n in result.tree.nodes.values()) and c.id not in getattr(result.tree,'failed',{})
        contacts.append(contact)
    nodes=[dict(id=n.id,kind=n.kind.value,position=(n.position+[0,0,bed_shift]).tolist(),radius=n.radius,parent=n.parent,contact_id=n.contact_id) for n in result.tree.nodes.values()]
    issues=[dict(severity=i.severity,code=i.code,message=i.message,position=None if i.position is None else (i.position+[0,0,bed_shift]).tolist(),contact_id=i.contact_id) for i in result.issues]
    summary=dict(params=params.to_dict(),modelLift=result.model_lift,plateZ=result.plate_z,bedShift=bed_shift,contacts=contacts,treeNodes=nodes,treeFailed=getattr(result.tree,'failed',{}),stats=result.stats,timings=result.timings,issues=issues,originalMeshCheck=full_check,
      geometry=dict(supportWatertight=bool(result.support_mesh.is_watertight),supportWindingConsistent=bool(result.support_mesh.is_winding_consistent),supportTriangles=len(result.support_mesh.faces),raftTriangles=len(result.raft_mesh.faces) if result.raft_mesh is not None else 0),
      proxy=dict(triangles=len(model.faces),watertight=bool(model.is_watertight),winding_consistent=bool(model.is_winding_consistent),exact_coordinate_weld=dict(vertices_merged=before_proxy_vertices-len(vertices),zero_area_collapsed_faces_removed=proxy_collapsed)),exportValidation=validate_export('/proxy.3mf'))
    del result,original,original_v,original_inv,allv,tri,lo,hi,model
    gc.collect()
    return json.dumps(_clean(summary),allow_nan=False)
`);
for(const modelId of modelIds){
 const candidate=candidates.find(c=>c.id===modelId);if(!candidate)throw Error(`Unknown model ${modelId}`);
 const bytes=await readFile(candidate.path),original=new STLLoader().parse(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));
 const rotation=new Matrix4();if(modelId==='spore')rotation.makeRotationX(-Math.PI/2);if(rotateY)rotation.premultiply(new Matrix4().makeRotationY(rotateY*Math.PI/180));original.applyMatrix4(rotation);
 const poseKey=rotateY?`ry${rotateY}`:'source';
 original.computeBoundingBox();const box=original.boundingBox,translation=[-(box.min.x+box.max.x)/2,-(box.min.y+box.max.y)/2,-box.min.z];
 const plateBytes=(modelId==='spore'||rotateY)?new Uint8Array(new STLExporter().parse(new Mesh(original),{binary:true}).buffer):bytes;
 const plate=new Plate();await plate.load([{name:candidate.filename,data:plateBytes.buffer.slice(plateBytes.byteOffset,plateBytes.byteOffset+plateBytes.byteLength)}],()=>{});
 py.FS.writeFile('/original.positions',new Uint8Array(original.attributes.position.array.buffer));
 py.FS.writeFile('/proxy.vertices',await readFile(`test-results/research/${modelId}.vertices`));
 py.FS.writeFile('/proxy.indices',await readFile(`test-results/research/${modelId}.indices`));
 let fixedLift;
 const priorBaseline=manifest.specimens.find(s=>s.modelId===modelId&&(s.poseKey||'source')===poseKey&&s.variantId==='B0');
 if(priorBaseline)fixedLift=JSON.parse(await readFile(priorBaseline.files.summary,'utf8')).modelLift;
 const runIds=fixedLift===undefined&&!variantIds.includes('B0')?['B0',...variantIds]:variantIds;
 for(const variantId of runIds){
  const variant=variants[variantId],id=`${modelId}${rotateY?'-ry'+rotateY:''}-${variantId}`,dir=path.join(outputRoot,id);await mkdir(dir,{recursive:true});
  console.log(`START ${id}`);lastStage='';const began=performance.now();
  const overrides={...(modelId==='spore'?{raft_enabled:false}:{}),...variant.overrides};
  py.globals.set('research_config',JSON.stringify({id,translation,rotation_matrix:rotation.toArray(),overrides,fixed_lift:variantId==='B0'?null:fixedLift}));
  let summary;
  try{summary=JSON.parse(await py.runPythonAsync('generate_research(research_config)'))}catch(error){await writeFile(path.join(dir,'generation-error.txt'),String(error));throw error}
  if(variantId==='B0')fixedLift=summary.modelLift;
  summary.id=id;summary.modelId=modelId;summary.variantId=variantId;summary.variantLabel=variant.label;summary.sourcePath=candidate.path;summary.sourceSha256=hash(bytes);summary.sourceTriangles=original.attributes.position.count/3;summary.translation=translation;summary.rotationXYZ=[modelId==='spore'?-90:0,rotateY,0];summary.scaleXYZ=[1,1,1];summary.fixedLiftControl=variantId!=='B0';summary.elapsedSeconds=(performance.now()-began)/1000;
  const files={summary:path.join(dir,'summary.json'),model:path.join(dir,'model.stl'),supports:path.join(dir,'supports.stl'),raft:path.join(dir,'raft.stl'),assembly:path.join(dir,'assembly.3mf')};
  for(const kind of ['supports','raft'])if(py.FS.analyzePath('/'+kind+'.stl').exists)await writeFile(files[kind],py.FS.readFile('/'+kind+'.stl'));else files[kind]=null;
  const fullModel=original.clone();fullModel.translate(translation[0],translation[1],translation[2]+summary.bedShift);
  const modelBytes=new Uint8Array(new STLExporter().parse(new Mesh(fullModel),{binary:true}).buffer);
  await writeFile(files.model,modelBytes);
  const roundtrip=new STLLoader().parse(modelBytes.buffer),expected=fullModel.attributes.position.array,actual=roundtrip.attributes.position.array;
  if(actual.length!==expected.length)throw Error('Original triangle count changed');
  let maxCoordinateError=0;for(let i=0;i<actual.length;i++)maxCoordinateError=Math.max(maxCoordinateError,Math.abs(actual[i]-expected[i]));
  if(maxCoordinateError!==0)throw Error('Original model vertices changed in STL export');
  summary.originalGeometryIntegrity={trianglesPreserved:actual.length/9===summary.sourceTriangles,maximumRoundtripVertexErrorMm:maxCoordinateError,modelStlSha256:hash(modelBytes),note:'Original full-resolution triangles preserved after the recorded rigid transform; no decimation in the output model.'};
  roundtrip.dispose();fullModel.dispose();
  const proxyArchive=py.FS.readFile('/proxy.3mf').slice();
  const assembly=plate.export([{name:id,output:proxyArchive,lift:summary.bedShift,transform:new Matrix4().toArray()}],()=>{});await writeFile(files.assembly,assembly);
  const errors=summary.issues.filter(i=>i.severity==='error'),collision=summary.originalMeshCheck.support_intersection_volume_mm3;
  summary.digitalGate={engineErrors:errors.length,engineWarnings:summary.issues.filter(i=>i.severity==='warning').length,supportClosed:summary.geometry.supportWatertight&&summary.geometry.supportWindingConsistent,originalCollisionMeasured:Number.isFinite(collision),originalCollisionVolumeMm3:collision??null,outsideContactCollisionVolumeMm3:summary.originalMeshCheck.intersection_outside_contact_neighborhoods_mm3??null,status:errors.length||!summary.geometry.supportWatertight?'reject-engine-errors':summary.originalMeshCheck.intersection_outside_contact_neighborhoods_mm3>1e-5?'reject-branch-body-collision':'pending-slicer-and-local-contact-review',physicalValidation:'not printed'};
  await writeFile(files.summary,JSON.stringify(summary,null,2)+'\n');
  manifest.specimens=manifest.specimens.filter(s=>s.id!==id);
  manifest.specimens.push({id,modelId,poseKey,variantId,label:variant.label,sourceSha256:summary.sourceSha256,sourceTriangles:summary.sourceTriangles,files,gate:summary.digitalGate});
  await writeFile(manifestPath,JSON.stringify(manifest,null,2)+'\n');
  console.log(JSON.stringify({id,seconds:summary.elapsedSeconds,contacts:summary.contacts.length,routed:summary.contacts.filter(c=>c.routed).length,issues:summary.issues.map(i=>`${i.severity}:${i.code}`),originalMesh:{watertight:summary.originalMeshCheck.watertight,collision:summary.originalMeshCheck.support_intersection_volume_mm3,outsideContactCollision:summary.originalMeshCheck.intersection_outside_contact_neighborhoods_mm3},gate:summary.digitalGate}));
 }
 original.dispose();
}
console.log(`Manifest: ${manifestPath}`);
