/** Independent synthetic checks for the opt-in cavity-contact fitter. No private models. */
import {loadPyodide} from 'pyodide';
import Module from 'manifold-3d';
import {readFile} from 'node:fs/promises';
import path from 'node:path';

const mf=await Module();mf.setup();
const py=await loadPyodide({indexURL:path.resolve('public/runtime')+'/'});
py.registerJsModule('manifold_js',{api:mf});
py.registerJsModule('browser_bridge',{progress:()=>{}});
await py.loadPackage(['numpy','scipy','shapely']);
for(const file of ['networkx-3.4.2-py3-none-any.whl','arbor-engine.zip','trimesh-5.1.1-py3-none-any.whl'])
  py.unpackArchive(new Uint8Array(await readFile(`public/runtime/${file}`)),'zip',{extractDir:'/engine'});
for(const file of ['tree.py','params.py','build.py'])
  py.FS.writeFile(`/engine/arbor/engine/${file}`,await readFile(`vendor/arborfdm/arbor/engine/${file}`));
try {
  await py.runPythonAsync(`
import sys,math
sys.path.insert(0,'/engine')
import browser_engine,numpy as np,trimesh
from shapely.geometry import MultiPoint,Point
from arbor.engine import build as B
from arbor.engine.params import SupportParams
from arbor.engine.types import SupportTree,NodeKind

p=SupportParams(layer_height=.06,z_gap=.06,tip_penetration=0,raft_enabled=False,
 allow_on_model=True,on_model_tip_diameter=.24,line_width=.22,tip_length=1.2,
 circle_segments=24,compact_junctions=True,surface_aligned_tips=True,branch_angle_deg=40)

def cavity(floor_angle,roof_angle,free_height):
 floor=trimesh.creation.box(extents=[6,6,1]);floor.apply_translation([0,0,.5])
 floor.apply_transform(trimesh.transformations.rotation_matrix(math.radians(floor_angle),[0,1,0],point=[0,0,1]))
 roof_z=1+free_height
 roof=trimesh.creation.box(extents=[6,6,.4]);roof.apply_translation([0,0,roof_z+.2])
 roof.apply_transform(trimesh.transformations.rotation_matrix(math.radians(roof_angle),[0,1,0],point=[0,0,roof_z]))
 model=trimesh.util.concatenate([floor,roof])
 normal=np.array([-math.sin(math.radians(roof_angle)),0.,-math.cos(math.radians(roof_angle))])
 return model,np.array([0.,0.,roof_z]),normal

for floor_angle,roof_angle,free_height in [(0,0,.38),(15,0,.46),(15,-12,.40)]:
 model,pos,normal=cavity(floor_angle,roof_angle,free_height)
 fit=B.fit_short_contact(model,pos,normal,.18,1.,p)
 assert fit['status']=='fitted',(floor_angle,roof_angle,fit)
 # Rebuild through the production mesher. Do not treat fitter-reported metrics as proof.
 tree=SupportTree();tree.z_base=0.;tree.contact_normals={0:normal}
 root=tree.add(fit['rootPosition'],fit['rootRadius'],NodeKind.MODEL_FOOT)
 tip=tree.add(fit['tipPosition'],fit['tipRadius'],NodeKind.TIP,parent=root.id,contact_id=0)
 solid=B.mesh_tree_manifold(tree,p)
 mesh=B.manifold_to_trimesh(solid)
 assert mesh.is_watertight and solid.volume()>0
 overlap=abs(float((solid ^ B.trimesh_to_manifold(model)).volume()))
 assert overlap<=1e-7,('actual meshed intrusion',overlap,fit)
 vertices=np.asarray(mesh.vertices,float)
 cap_axis=-normal
 cap=vertices[np.abs((vertices-tip.position)@cap_axis)<2e-6]
 foot=vertices[np.abs(vertices[:,2]-root.position[2])<2e-6]
 assert len(cap)>=p.circle_segments and len(foot)>=p.circle_segments
 cap_poly=MultiPoint(cap[:,:2]).convex_hull
 assert cap_poly.covers(Point(*pos[:2])),('requested contact left cap',fit)
 # Exact minimum polygon width from edge-normal projections, independent of fit formula.
 boundary=np.asarray(cap_poly.exterior.coords)[:-1]
 directions=np.roll(boundary,-1,axis=0)-boundary
 directions=np.column_stack([-directions[:,1],directions[:,0]])
 directions/=np.linalg.norm(directions,axis=1)[:,None]
 widths=np.ptp(boundary@directions.T,axis=0)
 assert widths.min()>=p.line_width-2e-6,('cap less than one line',widths.min(),fit)
 # Analytic source planes permit checking every emitted cap/root vertex directly.
 roof_height=pos[2]-math.tan(math.radians(roof_angle))*cap[:,0]
 gaps=roof_height-cap[:,2]
 assert gaps.min()>=p.z_gap-2e-6,('cap gap smaller than requested',gaps.min(),fit)
 floor_height=1-math.tan(math.radians(floor_angle))*foot[:,0]
 landing=foot[:,2]-floor_height
 assert landing.min()>=-2e-6 and landing.min()<2e-5,('root intersects or floats above the exact floor',landing.min(),fit)
 assert cap[:,2].min()-foot[:,2].max()>=p.layer_height-2e-6
 # The emitted cap remains in a <=40-degree expansion envelope from the root polygon.
 inradius=root.radius*math.cos(math.pi/p.circle_segments)
 slopes=(np.linalg.norm(cap[:,:2]-root.position[:2],axis=1)-inradius)/(cap[:,2]-root.position[2])
 assert slopes.max()<=math.tan(math.radians(p.branch_angle_deg))+2e-5
 print('PASS fitted short contact: floor/roof angles',floor_angle,roof_angle,'gap',round(float(gaps.min()),6),'collision',overlap)

model,pos,normal=cavity(0,0,.11)
fit=B.fit_short_contact(model,pos,normal,.18,1.,p)
assert fit['status']=='unfitted',fit
print('PASS cavity smaller than one layer plus top gap is rejected')
model,pos,normal=cavity(0,0,.4)
fit=B.fit_short_contact(model,pos,normal,.08,1.,p)
assert fit['status']=='unfitted',fit
print('PASS cap narrower than one extrusion is rejected')

# A wider preference is optional; failure must retain the actual validated minimum,
# not emit an oversized colliding cap or silently drop an otherwise printable support.
p_wide=p.updated(short_contact_preferred_width=.28)
model,pos,normal=cavity(0,0,.4)
fit=B.fit_short_contact(model,pos,normal,.125,1.,p_wide)
assert fit['status']=='fitted' and not fit['preferredWidthMet'],fit
assert fit['preferredWidth']==.28 and fit['fitWidthConstraint']==p.line_width
assert fit['preferredWidthFallbackReason'] and p.line_width<=fit['projectedCapWidth']<.28
solid=B.tube(np.array([fit['rootPosition'],fit['tipPosition']]),np.array([fit['rootRadius'],fit['tipRadius']]),p.circle_segments,[True,False],[None,-normal])
assert abs(float((solid ^ B.trimesh_to_manifold(model)).volume()))<=1e-7
assert fit['minimumCapGap']>=p.z_gap and fit['minimumHeight']>=p.layer_height
print('PASS infeasible width preference falls back to a collision-free one-line contact and records why')
fit=B.fit_short_contact(model,pos,normal,.18,1.,p_wide)
assert fit['status']=='fitted' and fit['preferredWidthMet'] and fit['projectedCapWidth']>=.28,fit
assert 2*fit['rootRadius']*math.cos(math.pi/p.circle_segments)>=.28
assert any('short_contact_preferred_width' in message for message in p.updated(short_contact_preferred_width=-.1).validate())
print('PASS feasible width preference widens root and cap; negative preferences are rejected')
`);
} catch(error) {
  console.error(error.message);
  process.exitCode=1;
}
