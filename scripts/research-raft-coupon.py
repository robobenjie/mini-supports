"""Self-contained matched cage fixture; executed by the WASM wrapper."""
import sys, copy, json, math
sys.path.insert(0, '/engine')
import wasm_compat, numpy as np
from pathlib import Path
from types import SimpleNamespace
from shapely.geometry import Point, LineString
from arbor.engine import build as B, tree as T, raft_split as R
from arbor.engine.params import SupportParams, support_base_z
from arbor.engine.types import SupportTree, NodeKind, Progress
from arbor.io.export import export_stl

P=SupportParams(nozzle_diameter=.2,line_width=.22,layer_height=.06,z_gap=.06,
 tip_penetration=0,tip_diameter=.36,tip_base_diameter=.7,tip_length=1.2,
 raft_enabled=True,raft_coverage='footprint',raft_thickness=.82,raft_release_gap=.06,
 raft_lift_auto=False,raft_lift=0,raft_margin=2,raft_split_gap=.6,
 foot_diameter=3.2,foot_height=.8,collar_diameter=2.4,collar_height=1.5,
 trunk_diameter=1.4,branch_min_diameter=1.4,branch_angle_deg=40,
 brace_diameter=.9,brace_min_height=12,brace_spacing_z=6,brace_max_length=15,
 circle_segments=24,compact_junctions=True,surface_aligned_tips=True)
assert not P.validate(),P.validate()
angles=np.radians(np.arange(8)*45+22.5)
xy=np.column_stack([12*np.cos(angles),12*np.sin(angles)])
cap_z=22.
contact_z=cap_z+P.z_gap
bed_shift=P.raft_thickness+P.raft_release_gap

# Every growing model contour is <=40 degrees from vertical. The eight arms begin
# on the eight matched support caps, then slope inward to join the central body.
core_points=np.array([[0,0,z] for z in [0,1.2,1.3,10.,14.,20.,35.2]])
core_radii=np.array([8,8,1.8,8,8,3,3])
core=B.tube(core_points,core_radii,96,[True]*len(core_points))
solids=[core]
for x,y in xy:
    arm=np.array([[x,y,contact_z],[x,y,22.8],[x/4,y/4,34.8]])
    solids.append(B.tube(arm,np.array([.22,.65,.65]),24,[True]*3))
model_solid=B.mf.Manifold.batch_boolean(solids,B.mf.OpType.Add)
model=B.manifold_to_trimesh(model_solid)
assert len(model_solid.decompose())==1 and model.is_watertight and model.is_winding_consistent

tree=SupportTree();T._init_tree_extras(tree,support_base_z(P))
tree.model_base=Point(0,0).buffer(8,48)
tree.model_xy_bounds=tuple(np.r_[model.bounds[0,:2],model.bounds[1,:2]])
tree.contact_normals={}
contacts=[]
for cid,(x,y) in enumerate(xy):
    root=tree.add([x,y,tree.z_base],.7,NodeKind.FOOT)
    tree.foot_radius[root.id]=1.6
    parent=root
    for z in [3.,9.,15.,cap_z-1.2]:
        parent=tree.add([x,y,z],.7,NodeKind.TRUNK,parent=parent.id)
    tree.add([x,y,cap_z],.18,NodeKind.TIP,parent=parent.id,contact_id=cid)
    tree.contact_normals[cid]=np.array([0.,0.,-1.])
    contacts.append(SimpleNamespace(id=cid,position=np.array([x,y,contact_z]),normal=np.array([0.,0.,-1.])))
original_nodes=[(n.id,n.position.tolist(),n.radius,n.parent) for n in tree.nodes.values()]
original_pad=B.raft_polygon(tree,P)
results={};trees={};meshes={}
for ident,split in [('R0',False),('R1',True)]:
    config=P.updated(raft_split=split)
    variant=copy.deepcopy(tree)
    plan=R.plan_split(variant,config,model)
    if split:assert plan['status']=='planned' and plan['style']=='bent',plan
    # Use the real model-grid collision test for every generated brace.
    router=T._Router(model,contacts,config,variant,Progress())
    router._prepare();router._braces()
    support=B.mesh_tree(variant,config);raft=B.mesh_raft(variant,config)
    if split:assert R.finalize_split(variant,config,support,raft),variant.raft_split_report
    support_solid=B.trimesh_to_manifold(support)+B.trimesh_to_manifold(raft)
    support=B.manifold_to_trimesh(support_solid)
    assert support.is_watertight and support.is_winding_consistent
    assert len(support_solid.decompose())==(2 if split else 1)
    collision=abs(float((support_solid ^ model_solid).volume()))
    assert collision<1e-8,collision
    pad=B.raft_polygon(variant,config)
    assert variant.model_base.difference(pad).area<1e-8
    foot_checks=[]
    for root in variant.roots():
        disk=Point(*root.position[:2]).buffer(1.6,64)
        missing=disk.difference(pad.buffer(2e-5)).area
        assert missing<1e-7,missing
        foot_checks.append({'node':root.id,'xy':root.position[:2].tolist(),'missingFoundationMm2':float(missing)})
    for component in support_solid.decompose():
        bounds=B.manifold_to_trimesh(component).bounds
        assert abs(bounds[0,2]+bed_shift)<1e-6
    assert [(n.id,n.position.tolist(),n.radius,n.parent) for n in variant.nodes.values()]==original_nodes
    if split:
        seam=LineString(plan['path_xy']).buffer(plan['gap']/2,cap_style=2,join_style=1)
        assert original_pad.difference(pad).symmetric_difference(original_pad.intersection(seam)).area<1e-8
        assert pad.difference(original_pad).area<1e-8
    directory=Path('/out')/ident;directory.mkdir(parents=True,exist_ok=True)
    bed_model=model.copy();bed_model.apply_translation([0,0,bed_shift])
    bed_support=support.copy();bed_support.apply_translation([0,0,bed_shift])
    bed_raft=raft.copy();bed_raft.apply_translation([0,0,bed_shift])
    for name,mesh in [('model',bed_model),('supports',bed_support),('raft',bed_raft)]:
        export_stl(mesh,directory/(name+'.stl'),weld=False)
    nodes=[dict(id=n.id,kind=n.kind.value,position=(n.position+[0,0,bed_shift]).tolist(),radius=n.radius,parent=n.parent,contact_id=n.contact_id,cap_normal=[0,0,1] if n.kind==NodeKind.TIP else None) for n in variant.nodes.values()]
    summary=dict(params=config.to_dict(),modelLift=0,plateZ=-bed_shift,bedShift=bed_shift,
      contacts=[dict(id=c.id,position=c.position.tolist(),normal=c.normal.tolist(),position_bed_mm=(c.position+[0,0,bed_shift]).tolist(),routed=True,tip_diameter=.36,original_vertical_surface_z_mm=float(c.position[2]),original_minus_proxy_z_mm=0) for c in contacts],
      treeNodes=nodes,treeFailed={},routingRetries=[],shortContactFits=[],issues=[],
      geometry=dict(supportWatertight=True,supportWindingConsistent=True,supportTriangles=len(bed_support.faces),raftTriangles=len(bed_raft.faces)),
      originalMeshCheck=dict(watertight=True,winding_consistent=True,faces=len(bed_model.faces),support_intersection_volume_mm3=collision,intersection_outside_contact_neighborhoods_mm3=collision),
      fixture=dict(purpose='Matched removal topology experiment; not automatic-support-coverage benchmarking.',supportAndRaftComponents=len(support_solid.decompose()),braces=len(variant.braces),raftSplitReport=getattr(variant,'raft_split_report',None),footFoundations=foot_checks,modelBaseRadius=8.,raftTopBedZ=P.raft_thickness,modelBaseBedZ=bed_shift,capTopBedZ=cap_z+bed_shift,modelArmsBottomBedZ=contact_z+bed_shift,
       bracesBed=[dict(start=(a+[0,0,bed_shift]).tolist(),end=(b+[0,0,bed_shift]).tolist(),radius=r) for a,b,r in variant.braces],
       modelBoundsBed=bed_model.bounds.tolist(),supportBoundsBed=bed_support.bounds.tolist()))
    (directory/'summary.json').write_text(json.dumps(summary,indent=2))
    results[ident]=summary['fixture'];trees[ident]=variant;meshes[ident]=support_solid
assert len(trees['R1'].braces)<len(trees['R0'].braces)
def brace_key(b):return tuple(np.round(np.r_[b[0],b[1],b[2]],8))
assert {brace_key(b) for b in trees['R1'].braces}<={brace_key(b) for b in trees['R0'].braces}
# Split mode never adds any geometry: only raft slot and cross-group braces go away.
added=float((meshes['R1']-meshes['R0']).volume())
# The independently unioned float32 triangle solids leave micrometre-scale
# numerical dust on subtraction; the exact pad and brace subset checks above
# are authoritative, while this volume screen catches meaningful additions.
assert abs(added)<1e-5,added
report=dict(passed=True,flags=[],variants=results,modelIdentical=True,allTreeNodesIdentical=True,
 allTipCapsIdentical=True,contactDiameterMm=.36,contactGapMm=.06,tipPenetrationMm=0,
 splitAddsMaterialMm3=added,modelSupportIntersectionMm3=0,
 notes=['Original inspection umbrella was not reused: its large unsupported flat roof is replaced by eight tiny supported starts and self-supporting arms.',
 'These are controlled coupons with synthetic support routes; production raft planner, support mesher, brace collision checks and final split gate are used.',
 'R1 tests the combined removal policy: pad seam plus omission of braces that would reconnect its support groups. It does not isolate the seam from brace topology.',
 'Both models stand .06 mm above the same broad pad. Bent seam leaves the entire model base foundation intact. Physical ease of base release remains to be tested.'])
Path('/out/geometry-validation.json').write_text(json.dumps(report,indent=2))
print(json.dumps({'passed':True,'variants':results},indent=2))
