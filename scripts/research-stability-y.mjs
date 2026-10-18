/** Add a matched T3 Y-braced stability coupon without rewriting frozen T1/T2. */
import {loadPyodide} from 'pyodide';
import Module from 'manifold-3d';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
const out=path.resolve(process.argv[2]??'test-results/research/unified-print-kit/stability-T3');
await mkdir(out,{recursive:true});
const sourceDir=path.resolve('test-results/research/stability/T2');
const modelBytes=await readFile(path.join(sourceDir,'model.stl')),supportBytes=await readFile(path.join(sourceDir,'supports.stl'));
const mf=await Module();mf.setup();const py=await loadPyodide({indexURL:path.resolve('public/runtime')+'/'});
py.registerJsModule('manifold_js',{api:mf});await py.loadPackage(['numpy','scipy','shapely']);
for(const f of ['networkx-3.4.2-py3-none-any.whl','arbor-engine.zip','trimesh-5.1.1-py3-none-any.whl'])py.unpackArchive(new Uint8Array(await readFile('public/runtime/'+f)),'zip',{extractDir:'/engine'});
py.FS.writeFile('/source-model.stl',modelBytes);py.FS.writeFile('/source-support.stl',supportBytes);
const result=JSON.parse(await py.runPythonAsync(`
import sys,json,math
sys.path.insert(0,'/engine')
import wasm_compat,numpy as np,trimesh,manifold3d as mf
from arbor.engine.build import cone_between,manifold_to_trimesh,trimesh_to_manifold
from arbor.engine.params import SupportParams
from arbor.engine.verify import support_layer_regions
from arbor.io.export import export_stl
def box(lo,size):return mf.Manifold.cube(size).translate(lo)
def union(items):return mf.Manifold.batch_boolean(items,mf.OpType.Add)
model=trimesh.load_mesh('/source-model.stl',file_type='stl',process=True)
source_mesh=trimesh.load_mesh('/source-support.stl',file_type='stl',process=True)
model_man=trimesh_to_manifold(model);original=trimesh_to_manifold(source_mesh)
assert model_man.status()==mf.Error.NoError and original.status()==mf.Error.NoError
# Change only the raised identifier from T2 to T3. The pad is exactly retained.
label_box=box((-4,-7.1,.6),(8,3.3,.5))
core=original-label_box
glyph=[box((-3.2,-4.5,.6),(2.4,.6,.24)),box((-2.3,-6.9,.6),(.6,2.4,.24))]
glyph += [box((.6,y,.6),(2.4,.6,.24)) for y in (-6.9,-5.7,-4.5)]
glyph += [box((2.4,-6.9,.6),(.6,3,.24))]
braces=[];brace_solids=[]
for x in (-7.,0.,7.):
    for y in (-7.,7.):
        # Embed the entire inclined lower cap inside the existing 0.6 mm pad;
        # starting at its top would expose a rapidly widening cap wedge.
        a=(x,y,.3);b=(x,0.,23.)
        angle=math.degrees(math.atan2(abs(y),b[2]-a[2]))
        assert angle<=40
        brace_solids.append(cone_between(a,b,.5,.5,32))
        braces.append(dict(start=list(a),end=list(b),diameter_mm=1.,plane='YZ',angle_from_vertical_deg=angle))
support=union([core,*glyph,*brace_solids]);mesh=manifold_to_trimesh(support)
assert support.status()==mf.Error.NoError and mesh.is_watertight and mesh.is_winding_consistent
assert len(support.decompose())==1
removed_core=float((core-support).volume());assert abs(removed_core)<1e-6
collision=float((support^model_man).volume());assert abs(collision)<1e-8
assert np.max(np.abs(mesh.bounds-source_mesh.bounds))<1e-5
params=SupportParams(nozzle_diameter=.2,line_width=.22,layer_height=.06,overhang_angle_deg=40,raft_enabled=False,min_region_area=.001)
unsupported=support_layer_regions(mesh,params,z_base=0,model_mesh=None,support_man=support)
assert unsupported is not None
regions=[dict(kind=r['kind'],z=r['z'],area=r['area'],position=r['position'].tolist()) for r in unsupported]
assert not regions,regions
export_stl(mesh,'/T3-supports.stl',weld=False)
json.dumps(dict(id='T3',columnDiameterMm=1.8,addedBraces=braces,retainedXZBraceCount=4,addedYZBraceCount=6,
 labelOnlyReplacement='Raised T2 identifier replaced by T3; supporting pad unchanged.',
 matchedOriginal='Frozen T2 model, columns, XZ braces, .36 mm vertical caps and .06 mm nominal gap.',
 supportVolumeMm3=float(support.volume()),addedVolumeMm3=float(support.volume()-original.volume()),
 supportTriangles=len(mesh.faces),modelTriangles=len(model.faces),supportBoundsMm=mesh.bounds.tolist(),
 originalStructuralMaterialRemovedMm3=removed_core,supportModelCollisionMm3=collision,
 supportWatertight=bool(mesh.is_watertight),supportWindingConsistent=bool(mesh.is_winding_consistent),
 supportComponents=1,supportSelfSliceRegions=regions,geometryGate='pass',
 physicalLimits=['Geometric brace slope and sliceability do not establish buckling resistance or cooling.',
 'T2 versus T3 tests the addition of six lateral braces as a package; it does not isolate equal-mass redistribution.']))
`).catch(error=>{console.error(error.message);process.exit(1)}));
const hash=b=>createHash('sha256').update(b).digest('hex');
await writeFile(path.join(out,'model.stl'),modelBytes);
const generated=py.FS.readFile('/T3-supports.stl').slice();await writeFile(path.join(out,'supports.stl'),generated);
result.source={model:path.join(sourceDir,'model.stl'),modelSha256:hash(modelBytes),supports:path.join(sourceDir,'supports.stl'),supportsSha256:hash(supportBytes)};
result.files={model:path.join(out,'model.stl'),supports:path.join(out,'supports.stl')};
result.hashes={model:hash(modelBytes),supports:hash(generated)};
await writeFile(path.join(out,'geometry-validation.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({out,...result},null,2));
