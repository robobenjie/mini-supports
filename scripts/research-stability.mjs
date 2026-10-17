/** Controlled tall-support coupon pair; private print artifacts only. */
import {loadPyodide} from 'pyodide';
import Module from 'manifold-3d';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
const out=path.resolve('test-results/research/stability');await mkdir(out,{recursive:true});
const mf=await Module();mf.setup();const py=await loadPyodide({indexURL:path.resolve('public/runtime')+'/'});
py.registerJsModule('manifold_js',{api:mf});await py.loadPackage(['numpy','scipy','shapely']);
for(const f of ['networkx-3.4.2-py3-none-any.whl','arbor-engine.zip','trimesh-5.1.1-py3-none-any.whl'])py.unpackArchive(new Uint8Array(await readFile('public/runtime/'+f)),'zip',{extractDir:'/engine'});
const report=JSON.parse(await py.runPythonAsync(`
import sys,json,math
sys.path.insert(0,'/engine')
import wasm_compat,numpy as np,manifold3d as mf
from arbor.engine.build import cone_between,manifold_to_trimesh
from arbor.engine.params import SupportParams
from arbor.engine.verify import support_layer_regions
from arbor.io.export import export_stl

def union(items):return mf.Manifold.batch_boolean(items,mf.OpType.Add)
def box(lo,size):return mf.Manifold.cube(size).translate(lo)
def cylinder(a,b,r):return cone_between(a,b,r,r,32)
def glyph(label):
    # Rectilinear glyphs, 0.60 mm strokes, 3 mm height. Raised 0.24 mm above base.
    t=[box((-3.2,-4.5,.6),(2.4,.6,.24)),box((-2.3,-6.9,.6),(.6,2.4,.24))]
    if label=='T1':
        t += [box((1.4,-6.9,.6),(.6,3,.24)),box((.7,-6.9,.6),(2,.6,.24))]
    else:
        t += [box((.6,y,.6),(2.4,.6,.24)) for y in (-6.9,-5.7,-4.5)]
        t += [box((2.4,-5.7,.6),(.6,1.2,.24)),box((.6,-6.9,.6),(.6,1.2,.24))]
    return union(t)
xs=[-7.,0.,7.];bottoms=[28.,28.6,29.2];sphere_radius=1.2;gap=.06;cap_diameter=.36;neck_height=.24;taper_height=1.2
model_parts=[]
for x,bottom in zip(xs,bottoms):
    model_parts.append(mf.Manifold.sphere(sphere_radius,48).translate((x,0,bottom+sphere_radius)))
    # Model necks join each island to one short, doubly anchored bridge bar.
    model_parts.append(cylinder((x,0,bottom+1.5),(x,0,31.2),.5))
model_parts.append(box((-7.5,-.5,30.9),(15,1,.6)))
model=union(model_parts);model_mesh=manifold_to_trimesh(model)
assert model.status()==mf.Error.NoError and model_mesh.is_watertight
export_stl(model_mesh,'/model.stl',weld=False)
params=SupportParams(nozzle_diameter=.2,line_width=.22,layer_height=.06,overhang_angle_deg=40,raft_enabled=False,min_region_area=.001)
results=[]
for label,diameter,braced in [('T1',1.2,False),('T2',1.8,True)]:
    solids=[box((-12,-9,0),(24,18,.6)),glyph(label)]
    for x,bottom in zip(xs,bottoms):
        top=bottom-gap;neck_bottom=top-neck_height;taper_bottom=neck_bottom-taper_height
        solids.append(cylinder((x,0,.6),(x,0,taper_bottom),diameter/2))
        solids.append(cone_between((x,0,taper_bottom),(x,0,neck_bottom),diameter/2,cap_diameter/2,32))
        solids.append(cylinder((x,0,neck_bottom),(x,0,top),cap_diameter/2))
    brace_records=[]
    if braced:
        for a,b in [((-7,0,5),(0,0,14)),((7,0,5),(0,0,14)),((0,0,14),(-7,0,23)),((0,0,14),(7,0,23))]:
            angle=math.degrees(math.atan2(abs(b[0]-a[0]),abs(b[2]-a[2])))
            assert angle<=40
            solids.append(cylinder(a,b,.5))
            brace_records.append(dict(start=a,end=b,diameter_mm=1.,angle_from_vertical_deg=angle))
    support=union(solids);support_mesh=manifold_to_trimesh(support)
    assert support.status()==mf.Error.NoError and support_mesh.is_watertight and support_mesh.is_winding_consistent
    collision=float((support ^ model).volume());assert abs(collision)<1e-8
    assert np.all(support_mesh.extents[:2]<=[26,20]) and abs(support_mesh.bounds[0,2])<1e-8
    unsupported=support_layer_regions(support_mesh,params,z_base=0,model_mesh=None,support_man=support)
    assert unsupported is not None,'Support self-slicing must not be skipped'
    # Do not suppress any discovered layer failures: retain full evidence and reject.
    regions=[dict(kind=r['kind'],z=r['z'],area=r['area'],position=r['position'].tolist()) for r in unsupported]
    export_stl(support_mesh,'/'+label+'-supports.stl',weld=False)
    contacts=[dict(model_point_mm=[x,0,z],cap_top_mm=[x,0,z-gap],cap_diameter_mm=cap_diameter,cap_vertical_neck_mm=neck_height,vertical_gap_mm=gap) for x,z in zip(xs,bottoms)]
    results.append(dict(id=label,column_diameter_mm=diameter,braces=brace_records,contacts=contacts,support_volume_mm3=float(support.volume()),model_volume_mm3=float(model.volume()),support_triangles=len(support_mesh.faces),model_triangles=len(model_mesh.faces),support_bounds_mm=support_mesh.bounds.tolist(),model_bounds_mm=model_mesh.bounds.tolist(),support_model_collision_mm3=collision,support_watertight=bool(support_mesh.is_watertight),support_winding_consistent=bool(support_mesh.is_winding_consistent),support_self_slice_regions=regions,geometric_gate='pass' if not regions else 'reject-support-layer-failure'))
json.dumps(dict(schema_version=1,description='Matched tall-support stability screen. Same three hanging spherical islands, horizontal model bar and .36 mm vertical contact necks; T1 uses 1.2 mm columns, T2 uses 1.8 mm columns plus 1.0 mm diagonal braces.',stagger_reason='Island minima at 28.0/28.6/29.2 mm intentionally stagger the real features so higher columns continue printing during the first contact gap and the first real island supports print continuity during later gaps. No dummy witness geometry is added.',model_bridge_note='The upper model bar bridges about 6 mm between the connected necks. This is a real model feature shared identically across both conditions; inspect its actual native slicer bridge paths.',process=dict(nozzle_mm=.2,layer_height_mm=.06,self_support_threshold_deg_from_vertical=40,self_support_region_area_threshold_mm2=.001),physical_validation='Not printed. These are experimental specimens, not a reliability claim.',variants=results))
`));
const model=py.FS.readFile('/model.stl').slice(),hash=data=>createHash('sha256').update(data).digest('hex');
for(const variant of report.variants){const dir=path.join(out,variant.id);await mkdir(dir,{recursive:true});variant.files={model:path.join(dir,'model.stl'),supports:path.join(dir,'supports.stl')};await writeFile(variant.files.model,model);const support=py.FS.readFile('/'+variant.id+'-supports.stl').slice();await writeFile(variant.files.supports,support);variant.modelSha256=hash(model);variant.supportSha256=hash(support)}
report.originalModelIdentical=report.variants[0].modelSha256===report.variants[1].modelSha256;
await writeFile(path.join(out,'manifest.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({manifest:path.join(out,'manifest.json'),modelIdentical:report.originalModelIdentical,variants:report.variants.map(v=>({id:v.id,gate:v.geometric_gate,unsupportedRegions:v.support_self_slice_regions.length,collision:v.support_model_collision_mm3,volume:v.support_volume_mm3}))},null,2));
if(report.variants.some(v=>v.geometric_gate!=='pass'))process.exitCode=1;
