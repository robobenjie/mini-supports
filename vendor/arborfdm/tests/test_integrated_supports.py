"""Geometry contracts for local crowns, release groups and gradual FDM taper."""
import numpy as np
import trimesh
from arbor.engine.params import SupportParams
from arbor.engine.types import Contact, ContactReason, SupportTree, NodeKind, Progress, AnalysisResult
from arbor.engine.patches import build_patches, add_corner_contacts, _startup_patch_mask
from arbor.engine.build import trimesh_to_manifold, manifold_to_trimesh
from arbor.engine.pipeline import generate
from arbor.engine.tree import _Router

def params(**kw):
 return SupportParams(nozzle_diameter=.2,line_width=.22,layer_height=.06,tip_diameter=.36,tip_penetration=0,z_gap=.06,patch_gap=.12,underside_patches=True,compact_junctions=True,surface_aligned_tips=True,fdm_stability=True,removal_groups=True,branch_min_diameter=.9,branch_max_diameter=2.4,trunk_diameter=2.8,trunk_growth_per_mm=.035,raft_lift_auto=False,raft_lift=0,raft_release_gap=.12,raft_thickness=.7,foot_diameter=2.4,collar_diameter=2,circle_segments=24,**kw)

def test_patch_flat_gap_and_branch_attachment():
 mesh=trimesh.creation.box([6,6,1]);mesh.apply_translation([0,0,5.5]);tree=SupportTree();f=tree.add([0,0,0],.6,NodeKind.FOOT);b=tree.add([0,0,3.5],.4,NodeKind.BRANCH,parent=f.id);tree.add([0,0,4.94],.18,NodeKind.TIP,parent=b.id,contact_id=0)
 c=Contact(0,np.array([0.,0.,5.]),np.array([0.,0.,-1.]),ContactReason.ISLAND)
 p=params();build_patches(mesh,[c],tree,p);assert len(tree.patch_solids)==1
 solid=tree.patch_solids[0];verts=np.asarray(solid.to_mesh().vert_properties)[:,:3]
 assert np.ptp(verts[:,0])>2 and np.ptp(verts[:,1])>2
 assert np.ptp(verts[:,0])<=6 and np.ptp(verts[:,1])<=6
 assert abs(verts[:,2].max()-(5-p.patch_gap))<1e-5
 assert len(solid.decompose())==1 and (solid^trimesh_to_manifold(mesh)).volume()<1e-8
 assert verts[:,2].min()>2.0 # local feeder fans, no walls extending to the raft

def test_advancing_curved_heel_gets_a_local_conformal_patch():
 from arbor.engine.contacts import VerticalCaster
 import manifold3d as mf
 mesh=trimesh.creation.icosphere(subdivisions=3,radius=3)
 mesh.apply_translation([0,0,8])
 z,f=VerticalCaster(mesh).cast(np.array([[0.,2.2,4.]]))
 c=Contact(0,np.array([0.,2.2,z[0]]),mesh.face_normals[f[0]],ContactReason.EDGE)
 tree=SupportTree();foot=tree.add([0,1.8,0],.6,NodeKind.FOOT)
 hub=tree.add([0,1.8,3.1],.45,NodeKind.BRANCH,parent=foot.id)
 tree.add(c.position-[0,0,.06],.18,NodeKind.TIP,parent=hub.id,contact_id=0)
 p=params(patch_mode='startup',patch_start_rise_mm=1.25)
 build_patches(mesh,[c],tree,p)
 assert tree.patch_solids
 crown=mf.Manifold.batch_boolean(tree.patch_solids,mf.OpType.Add)
 # Audit the emitted roof, not just the selection mask. Follow the curved
 # advancing edge well above the sphere's unseeded bottom minimum.
 xy=np.c_[np.zeros(8),np.linspace(1.7,2.5,8)]
 model_z,_=VerticalCaster(mesh).cast(np.c_[xy,np.full(8,4.)])
 roof=manifold_to_trimesh(crown)
 roof.vertices*=np.array([1,1,-1]);roof.faces=roof.faces[:,::-1]
 roof_z,_=VerticalCaster(roof).cast(np.c_[xy,-model_z+.001])
 assert np.allclose(model_z+roof_z,p.patch_gap,atol=1e-5)
 assert (crown^trimesh_to_manifold(mesh)).volume()<1e-8
 assert len(crown.decompose())==1
 assert sum(r.get('projectedAreaMm2',0) for r in tree.patch_report)<8
 c.enabled=False
 keep,_=_startup_patch_mask(xy,model_z,.25,[c],p)
 assert not keep.any() # filtered microledges cannot reappear as edge roofs

def test_partial_roof_cells_reach_the_rim_without_overhanging_it():
 from arbor.engine.contacts import VerticalCaster
 mesh=trimesh.creation.box([3,1.2,1]);mesh.apply_translation([0,0,5.5])
 tree=SupportTree();foot=tree.add([0,0,0],.5,NodeKind.FOOT)
 hub=tree.add([0,0,2.5],.4,NodeKind.BRANCH,parent=foot.id)
 tree.add([0,0,4.94],.18,NodeKind.TIP,parent=hub.id,contact_id=0)
 c=Contact(0,np.array([0.,0.,5.]),np.array([0.,0.,-1.]),ContactReason.ISLAND)
 p=params(patch_mode='startup');build_patches(mesh,[c],tree,p)
 roof=manifold_to_trimesh(tree.patch_solids[0]);bounds=roof.bounds.copy()
 assert bounds[0,0]>=-1.5021 and bounds[1,0]<=1.5021 # 2 micron fan overlap
 roof.vertices*=np.array([1,1,-1]);roof.faces=roof.faces[:,::-1]
 z,_=VerticalCaster(roof).cast(np.array([[1.49,.59,-4.999],[-1.49,-.59,-4.999]]))
 assert np.allclose(5+z,p.patch_gap,atol=1e-5)

def test_selected_far_rim_can_request_its_own_routed_feeder():
 from arbor.engine.contacts import VerticalCaster
 from arbor.engine.build import mesh_tree_manifold
 mesh=trimesh.creation.box([8,2,1]);mesh.apply_translation([0,0,6.5])
 tree=SupportTree();tree.z_base=0.
 foot=tree.add([-3,0,0],.6,NodeKind.FOOT)
 hub=tree.add([-3,0,3.5],.45,NodeKind.BRANCH,parent=foot.id)
 tree.add([-3,0,5.94],.18,NodeKind.TIP,parent=hub.id,contact_id=0)
 c=Contact(0,np.array([-3.,0.,6.]),np.array([0.,0.,-1.]),ContactReason.ISLAND)
 tree.contact_normals={0:c.normal}
 p=params(patch_mode='startup');build_patches(mesh,[c],tree,p)
 assert any(r.get('localFeederNodeIds') for r in tree.patch_report)
 solid=mesh_tree_manifold(tree,p)
 roof=manifold_to_trimesh(solid);roof.vertices*=np.array([1,1,-1]);roof.faces=roof.faces[:,::-1]
 xy=np.c_[np.full(5,3.9),np.linspace(-.8,.8,5)]
 z,_=VerticalCaster(roof).cast(np.c_[xy,np.full(5,-5.999)])
 assert np.allclose(6+z,p.patch_gap,atol=1e-5)
 assert (solid^trimesh_to_manifold(mesh)).volume()<1e-8
 assert all(piece.bounding_box()[2]<.01 for piece in solid.decompose())

def test_stability_growth_is_gradual_and_height_dependent():
 p=params();r=_Router.__new__(_Router);r.P=p;r.r_min=.45;r.r_trunk=1.4
 short=r._grow(np.array([.45]),np.array([False]),np.array([3.]))[0]
 tall=r._grow(np.array([.45]),np.array([False]),np.array([30.]))[0]
 assert .45<short<.6 and tall>short+.3
 assert r._merged_radius(np.array([.45,.45]))<.7

def test_crown_cannot_reconnect_opposite_removal_groups():
 mesh=trimesh.creation.box([6,6,1]);mesh.apply_translation([0,0,5.5])
 tree=SupportTree();f=tree.add([-.6,0,0],.4,NodeKind.FOOT)
 b=tree.add([-.6,0,3.5],.4,NodeKind.BRANCH,parent=f.id)
 tree.add([-.6,0,4.94],.18,NodeKind.TIP,parent=b.id,contact_id=0)
 tree.contact_groups={0:-1};tree.removal_axis=0;tree.removal_center=0
 c=Contact(0,np.array([-.6,0.,5.]),np.array([0.,0.,-1.]),ContactReason.ISLAND)
 p=params();build_patches(mesh,[c],tree,p);assert len(tree.patch_solids)==1
 crown=tree.patch_solids[0];verts=np.asarray(crown.to_mesh().vert_properties)[:,:3]
 assert verts[:,0].max()<=-p.raft_split_gap/2+1e-6
 hub=trimesh.creation.box([.5,.5,.2]);hub.apply_translation(b.position)
 assert (crown^trimesh_to_manifold(hub)).volume()>1e-4
 assert len(crown.decompose())==1

def test_two_groups_stay_separate_in_final_solids():
 p=params(raft_split=True,raft_split_auto=False,braces_enabled=True)
 mesh=trimesh.creation.box([6,4,1]);mesh.apply_translation([0,0,9.5])
 cs=[Contact(i,np.array([x,y,9.]),np.array([0.,0.,-1.]),ContactReason.MANUAL,manual=True) for i,(x,y) in enumerate([(-2,-1),(-2,1),(2,-1),(2,1)])]
 r=generate(mesh,p,contacts=cs,progress=Progress());assert r.tree.raft_split_report['status']=='applied',r.tree.raft_split_report
 structure=trimesh_to_manifold(r.support_mesh)+trimesh_to_manifold(r.raft_mesh)
 assert len(structure.decompose())==2
 assert len([n for n in r.tree.nodes.values() if n.kind==NodeKind.TIP and n.contact_id not in getattr(r.tree,'support_terminal_ids',set())])==4
 assert (trimesh_to_manifold(r.support_mesh)^trimesh_to_manifold(mesh)).volume()<1e-8

def test_detail_filter_never_waives_an_island_or_manual_contact():
 from shapely.geometry import box
 a=AnalysisResult(.06,np.array([.03,.09,.15]),layer_polygons=[box(-2,-2,0,2)]*3)
 mesh=trimesh.creation.box([2,2,1])
 cs=[Contact(i,np.array([.1,0,.3]),np.array([0.,0.,-1.]),reason,manual=reason==ContactReason.MANUAL)
     for i,reason in enumerate([ContactReason.EDGE,ContactReason.ISLAND,ContactReason.MANUAL])]
 out=add_corner_contacts(mesh,a,cs,params())
 assert not out[0].enabled and out[1].enabled and out[2].enabled

def test_tall_tree_receives_same_group_bed_motion_braces():
 # A 28 mm tree needs wide enough raft halves to pass the height/5 width gate.
 p=params(raft_split=True,raft_split_auto=False,braces_enabled=True,brace_diameter=1.1,brace_min_height=8,raft_margin=3.5)
 mesh=trimesh.creation.box([4,6,1]);mesh.apply_translation([0,0,28.5])
 cs=[Contact(i,np.array([x,0.,28.]),np.array([0.,0.,-1.]),ContactReason.MANUAL,manual=True)
     for i,x in enumerate([-1.5,1.5])]
 r=generate(mesh,p,contacts=cs,progress=Progress())
 assert len(r.tree._stability_braces)>=2
 assert r.tree.raft_split_report['status']=='applied',r.tree.raft_split_report
 assert len((trimesh_to_manifold(r.support_mesh)+trimesh_to_manifold(r.raft_mesh)).decompose())==2

def test_split_does_not_remove_a_stabilizing_triangle():
 # Isolate a pair of point supports. Patch terminals add legitimate rooted
 # groups on both sides, changing this fixture's single-tree premise.
 p=params(raft_split=True,raft_split_auto=False,braces_enabled=True,brace_diameter=1.1,brace_min_height=8).updated(underside_patches=False)
 mesh=trimesh.creation.box([6,4,1]);mesh.apply_translation([0,0,28.5])
 cs=[Contact(i,np.array([x,0.,28.]),np.array([0.,0.,-1.]),ContactReason.MANUAL,manual=True)
     for i,x in enumerate([-2.,2.])]
 r=generate(mesh,p,contacts=cs,progress=Progress())
 assert len(r.tree._stability_braces)>=1
 assert len(r.tree.braces)>=len(r.tree._stability_braces)
 # Both contacts merge into one tree; a brace-only foot isn't a removal group.
 assert r.tree.raft_split_report['status']=='skipped'
 assert len((trimesh_to_manifold(r.support_mesh)+trimesh_to_manifold(r.raft_mesh)).decompose())==1

def test_patch_footprint_follows_model_size():
 areas=[]
 for width in (3.,6.):
  mesh=trimesh.creation.box([width,width,1]);mesh.apply_translation([0,0,8.5])
  tree=SupportTree();f=tree.add([0,0,0],.6,NodeKind.FOOT)
  b=tree.add([0,0,1],.4,NodeKind.BRANCH,parent=f.id)
  tree.add([0,0,7.94],.18,NodeKind.TIP,parent=b.id,contact_id=0)
  c=Contact(0,np.array([0.,0.,8.]),np.array([0.,0.,-1.]),ContactReason.ISLAND)
  build_patches(mesh,[c],tree,params())
  assert len(tree.patch_solids)==1
  area=tree.patch_report[0]['projectedAreaMm2'];areas.append(area)
  assert area>width**2*.8 and area<=width**2
  assert len(tree.patch_solids[0].decompose())==1
 assert areas[1]>areas[0]*3.5

def test_patches_do_not_bridge_a_hole_or_a_separate_underside():
 import manifold3d as mf
 ring=mf.Manifold.cube([6,6,1],True)-mf.Manifold.cube([2,2,3],True)
 mesh=manifold_to_trimesh(ring.translate([0,0,8.5]))
 tree=SupportTree();f=tree.add([2,0,0],.6,NodeKind.FOOT)
 b=tree.add([2,0,3],.4,NodeKind.BRANCH,parent=f.id)
 tree.add([2,0,7.94],.18,NodeKind.TIP,parent=b.id,contact_id=0)
 c=Contact(0,np.array([2.,0.,8.]),np.array([0.,0.,-1.]),ContactReason.ISLAND)
 build_patches(mesh,[c],tree,params())
 assert len(tree.patch_solids)==1
 # Test the roof band, rather than its inclined fan underneath.
 hole=mf.Manifold.cube([1.99,1.99,.02],True).translate([0,0,7.86])
 assert (tree.patch_solids[0]^hole).volume()<1e-8

def test_upward_removal_distinguishes_under_supports_from_a_cage():
 from arbor.engine.raft_split import upward_removal_check
 model=trimesh.creation.box([4,4,1]);model.apply_translation([0,0,5.5])
 below=trimesh.creation.box([3,3,4]);below.apply_translation([0,0,2])
 assert not upward_removal_check(model,below,params())['needed']
 blocking=trimesh.creation.box([6,1,1]);blocking.apply_translation([0,0,9])
 result=upward_removal_check(model,blocking,params())
 assert result['needed'] and result['peakCollisionMm3']>1.

def test_auto_split_keeps_a_lift_off_model_on_one_pad():
 p=params(raft_split=True)
 mesh=trimesh.creation.box([6,4,1]);mesh.apply_translation([0,0,9.5])
 cs=[Contact(i,np.array([x,y,9.]),np.array([0.,0.,-1.]),ContactReason.ISLAND)
     for i,(x,y) in enumerate([(-2,-1),(-2,1),(2,-1),(2,1)])]
 r=generate(mesh,p,contacts=cs,progress=Progress())
 assert not r.stats['upward_removal']['needed']
 assert r.tree.raft_split_report['status']=='skipped'
 assert not hasattr(r.tree,'contact_groups')
 assert len((trimesh_to_manifold(r.support_mesh)+trimesh_to_manifold(r.raft_mesh)).decompose())==1
 import manifold3d as mf
 assert r.tree.patch_solids
 assert len(mf.Manifold.batch_boolean(r.tree.patch_solids,mf.OpType.Add).decompose())==1

def test_startup_patch_covers_low_growth_and_scales_with_feature():
 areas=[]
 for width in (6.,12.):
  pitch=.25
  x=np.arange(-width/2+pitch/2,width/2,pitch)
  xx,yy=np.meshgrid(x,x);xy=np.c_[xx.ravel(),yy.ravel()]
  z=np.sum(xy**2,axis=1)/width
  c=Contact(0,np.array([0.,0.,0.]),np.array([0.,0.,-1.]),ContactReason.ISLAND)
  keep,report=_startup_patch_mask(xy,z,pitch,[c],params(patch_mode="startup"))
  area=keep.sum()*pitch**2;areas.append(area)
  assert .25*width**2<area<.4*width**2
  assert keep[np.argmin(z)] and not keep[np.argmax(z)]
  assert len(report)==1
 assert 3.5<areas[1]/areas[0]<4.5

def test_startup_patch_retains_a_broad_flat_underside():
 x=np.arange(-3,3,.25);xx,yy=np.meshgrid(x,x);xy=np.c_[xx.ravel(),yy.ravel()]
 c=Contact(0,np.array([0.,0.,5.]),np.array([0.,0.,-1.]),ContactReason.ISLAND)
 keep,report=_startup_patch_mask(xy,np.full(len(xy),5.),.25,[c],params(patch_mode="startup"))
 assert keep.all() and "Flat underside" in report[0]["reason"]
 # The experiment changes patch coverage, never the enabled point contact.
 assert c.enabled

def test_startup_height_threshold_is_nested_and_not_an_area_quota():
 pitch=.25
 x=np.arange(-3,3,pitch);xx,yy=np.meshgrid(x,x);xy=np.c_[xx.ravel(),yy.ravel()]
 z=np.sum(xy**2,axis=1)/6
 c=Contact(0,np.array([0.,0.,0.]),np.array([0.,0.,-1.]),ContactReason.ISLAND)
 masks=[]
 for rise in (.2,.6,1.5):
  keep,report=_startup_patch_mask(xy,z,pitch,[c],params(patch_mode="startup",patch_start_rise_mm=rise))
  assert report[0]["selection"]=="height_threshold"
  assert np.allclose(keep,z<=z.min()+rise+1e-8)
  masks.append(keep)
 assert masks[0].sum()<masks[1].sum()<masks[2].sum()
 assert (masks[1]|~masks[0]).all() and (masks[2]|~masks[1]).all()
 # Extending the same surface upward must not grow the selected low patch.
 x=np.arange(-6,6,pitch);xx,yy=np.meshgrid(x,x);larger=np.c_[xx.ravel(),yy.ravel()]
 keep,_=_startup_patch_mask(larger,np.sum(larger**2,axis=1)/6,pitch,[c],
                           params(patch_mode="startup",patch_start_rise_mm=.6))
 assert keep.sum()==masks[1].sum()

def test_startup_patch_retains_an_upper_flat_beside_a_lower_tip():
 x=np.arange(-3,3,.25);xx,yy=np.meshgrid(x,x);xy=np.c_[xx.ravel(),yy.ravel()]
 z=np.sum(xy**2,axis=1)/6
 flat=xy[:,0]>1.
 z[flat]=4.
 c=Contact(0,np.array([0.,0.,0.]),np.array([0.,0.,-1.]),ContactReason.ISLAND)
 keep,report=_startup_patch_mask(xy,z,.25,[c],params(patch_mode="startup"),flat=flat)
 assert keep[flat].all() and not keep[~flat].all()
 assert any(r["reason"]=="Broad low-curvature underside retained" for r in report)

def test_startup_patch_only_grows_in_seeded_connected_basins():
 x=np.arange(-2,2,.25);xx,yy=np.meshgrid(x,x);local=np.c_[xx.ravel(),yy.ravel()]
 xy=np.vstack([local+[-4,0],local+[4,0]])
 z=np.tile(np.sum(local**2,axis=1),2)
 c=Contact(0,np.array([-4.,0.,0.]),np.array([0.,0.,-1.]),ContactReason.LOW_POINT)
 keep,_=_startup_patch_mask(xy,z,.25,[c],params(patch_mode="startup"))
 assert keep[:len(local)].any() and not keep[len(local):].any()

def test_startup_seed_near_a_rim_uses_cell_area_not_its_center():
 # The first valid sample lies just beyond the old centre-distance cutoff,
 # but its cell remains within reach of the island contact beside the bevel.
 pitch=.253
 x=np.arange(4)*pitch;xx,yy=np.meshgrid(x,x)
 local=np.c_[xx.ravel(),yy.ravel()]
 centers=np.vstack([local,local+[4,0]])
 heights=np.tile(xx.ravel()*.3,2)
 c=Contact(0,np.array([-.512,0.,0.]),np.array([0.,0.,-1.]),ContactReason.ISLAND)
 keep,_=_startup_patch_mask(centers,heights,pitch,[c],params())
 assert keep[:len(local)].any()
 assert not keep[len(local):].any() # the other surface stays unseeded
 distant=Contact(1,np.array([-1.,0.,0.]),np.array([0.,0.,-1.]),ContactReason.ISLAND)
 far,_=_startup_patch_mask(centers,heights,pitch,[distant],params())
 assert not far.any()


def test_patch_contact_surface_is_the_model_negative_without_xy_steps():
 from arbor.engine.contacts import VerticalCaster
 plane=trimesh.creation.box([6,6,1])
 plane.apply_transform(trimesh.transformations.rotation_matrix(np.deg2rad(20),[0,1,0]))
 plane.apply_translation([0,0,8])
 curved=trimesh.creation.icosphere(subdivisions=3,radius=3)
 curved.apply_translation([0,0,8])
 thin=trimesh.creation.box([6,6,.03])
 thin.apply_transform(trimesh.transformations.rotation_matrix(np.deg2rad(20),[0,1,0]))
 thin.apply_translation([0,0,8])
 for mesh in (plane,curved,thin):
  z,_=VerticalCaster(mesh).cast(np.array([[0.,0.,0.]]))
  tree=SupportTree();f=tree.add([0,0,0],.6,NodeKind.FOOT)
  b=tree.add([0,0,2.5],.4,NodeKind.BRANCH,parent=f.id)
  tree.add([0,0,z[0]-.06],.18,NodeKind.TIP,parent=b.id,contact_id=0)
  c=Contact(0,np.array([0.,0.,z[0]]),np.array([0.,0.,-1.]),ContactReason.ISLAND)
  p=params();build_patches(mesh,[c],tree,p)
  assert len(tree.patch_solids)==1 and tree.patch_report[0]["conformalSkinComponents"]>0
  crown=tree.patch_solids[0];support=manifold_to_trimesh(crown)
  flipped=trimesh.Trimesh(support.vertices*[1,1,-1],support.faces[:,::-1],process=False)
  x=np.arange(-1,1.01,.2);xx,yy=np.meshgrid(x,x)
  points=np.c_[xx.ravel(),yy.ravel(),np.zeros(xx.size)]
  surface,_=VerticalCaster(mesh).cast(points)
  negative,hit=VerticalCaster(flipped).cast(np.c_[points[:,:2],-surface])
  assert (hit>=0).all()
  assert np.max(np.abs(surface+negative-p.patch_gap))<2e-5
  assert len(crown.decompose())==1
  assert (crown^trimesh_to_manifold(mesh)).volume()<1e-8
  # The actual support union also includes point tips. They must not poke
  # through the new skin at their closer ordinary 0.06 mm clearance.
  from arbor.engine.build import mesh_tree_manifold
  tree.contact_normals={0:c.normal};tree.z_base=0.
  complete=manifold_to_trimesh(mesh_tree_manifold(tree,p))
  flipped=trimesh.Trimesh(complete.vertices*[1,1,-1],complete.faces[:,::-1],process=False)
  actual,hit=VerticalCaster(flipped).cast(np.array([[0.,0.,-z[0]]]))
  assert hit[0]>=0 and abs(z[0]+actual[0]-p.patch_gap)<2e-5


def test_large_patch_grid_has_separate_fans_and_own_upper_pillars():
 mesh=trimesh.creation.box([14,14,1]);mesh.apply_translation([0,0,10.5])
 tree=SupportTree();contacts=[]
 for i,(x,y) in enumerate([(x,y) for x in (-5,0,5) for y in (-5,0,5)]):
  f=tree.add([x,y,0],.7,NodeKind.FOOT)
  b=tree.add([x,y,2],.5,NodeKind.BRANCH,parent=f.id)
  tree.add([x,y,9.94],.18,NodeKind.TIP,parent=b.id,contact_id=i)
  contacts.append(Contact(i,np.array([x,y,10.]),np.array([0.,0.,-1.]),ContactReason.ISLAND))
 tree.z_base=0.;tree.contact_normals={c.id:c.normal for c in contacts}
 p=params(patch_grid=True,patch_grip_length=4)
 build_patches(mesh,contacts,tree,p)
 built=[r for r in tree.patch_report if r['status']=='built']
 assert len(built)==9 and len(tree.patch_solids)==9
 assert len({r['panelPillar']['nodeId'] for r in built})==9
 from arbor.engine.build import mesh_tree_manifold
 complete=mesh_tree_manifold(tree,p)
 import manifold3d as mf
 assert complete.status()==mf.Error.NoError
 assert len(complete.decompose())==9 # no detached roofs or accidental adjacent unions
 for i,(solid,rec) in enumerate(zip(tree.patch_solids,built)):
  vertices=np.asarray(solid.to_mesh().vert_properties)[:,:3]
  assert max(np.ptp(vertices[:,:2],axis=0))<5
  assert abs(vertices[:,2].max()-9.88)<1e-5
  assert rec['grip'] and 1.5<=rec['grip']['lengthMm']<=4
  for other in tree.patch_solids[i+1:]: assert (solid^other).volume()<1e-8
 assert (complete^trimesh_to_manifold(mesh)).volume()<1e-8


def test_patch_grid_does_not_split_small_or_disconnected_patches():
 from arbor.engine.patches import _patch_panels
 x=np.arange(-2,2,.25);xx,yy=np.meshgrid(x,x);xy=np.c_[xx.ravel(),yy.ravel()]
 islands=np.vstack([xy+[-7,0],xy+[7,0]])
 panels=_patch_panels(islands,np.ones(len(islands)),.25,params(patch_grid=True))
 assert len(panels)==2 and all(bounds is None for _,_,bounds in panels)
 assert sum(len(points) for points,_,_ in panels)==len(islands)


def test_rejected_grid_panels_leave_no_orphan_posts_or_diagonals():
 # Each removal group tries panels on both sides of the seam. Those on the
 # wrong side cannot carry a roof, even when a clear pillar route exists.
 mesh=trimesh.creation.box([14,14,1]);mesh.apply_translation([0,0,10.5])
 tree=SupportTree();contacts=[]
 for i,x in enumerate((-4.,4.)):
  f=tree.add([x,0,0],.7,NodeKind.FOOT)
  b=tree.add([x,0,2],.45,NodeKind.BRANCH,parent=f.id)
  tree.add([x,0,9.94],.18,NodeKind.TIP,parent=b.id,contact_id=i)
  contacts.append(Contact(i,np.array([x,0.,10.]),np.array([0.,0.,-1.]),ContactReason.ISLAND))
 tree.contact_groups={0:-1,1:1};tree.removal_axis=0;tree.removal_center=0
 original=dict(tree.nodes)
 build_patches(mesh,contacts,tree,params(patch_grid=True))
 built=[r for r in tree.patch_report if r['status']=='built']
 assert built and any(r['status']=='skipped' for r in tree.patch_report)
 assert len(built)==len(tree.patch_solids)
 required=set(original)
 for record in built:
  nid=record['panelPillar']['nodeId']
  while nid is not None:
   required.add(nid);nid=tree.nodes[nid].parent
 assert set(tree.nodes)==required # every new node carries a surviving patch
 assert all(tree.nodes[nid] is node for nid,node in original.items())
 # Successful roofs still attach to their pillars and stay on their own side.
 import manifold3d as mf
 for record,solid in zip(built,tree.patch_solids):
  node=tree.nodes[record['panelPillar']['nodeId']]
  hub=mf.Manifold.cylinder(.16,node.radius,node.radius,16).translate(node.position-[0,0,.08])
  assert (solid^hub).volume()>1e-6
  verts=np.asarray(solid.to_mesh().vert_properties)[:,:3]
  assert np.min(verts[:,0]*record['removalSide'])>=params().raft_split_gap/2-1e-5


def test_release_ribbons_have_grips_and_short_necks_without_model_contact():
 from arbor.engine.patch_release import release_patches
 from arbor.engine.build import mesh_tree,mesh_raft
 p=params(patch_release=True).updated(surface_aligned_tips=False)
 mesh=trimesh.creation.box([6,6,1]);mesh.apply_translation([0,0,5.5])
 tree=SupportTree();tree.z_base=0.;tree.model_xy_bounds=(-3,-3,3,3)
 from shapely.geometry import box
 tree.model_base=box(-3,-3,3,3)
 f=tree.add([0,0,0],.6,NodeKind.FOOT);b=tree.add([0,0,3.5],.4,NodeKind.BRANCH,parent=f.id);tree.add([.7,.7,4.94],.18,NodeKind.TIP,parent=b.id,contact_id=0)
 c=Contact(0,np.array([.7,.7,5.]),np.array([0.,0.,-1.]),ContactReason.ISLAND)
 build_patches(mesh,[c],tree,p)
 before=mesh_tree(tree,p);raft=mesh_raft(tree,p)
 after=release_patches(mesh,[c],tree,before,raft,p)
 applied=[r for r in tree.patch_release_report if r['status']=='applied']
 assert applied,tree.patch_release_report
 assert (trimesh_to_manifold(after)^trimesh_to_manifold(mesh)).volume()<1e-7
 for r in applied:
  assert r['neckDiameterMm']==.6 and r['gripLengthMm']==1.6
  assert r['ribbonCount']>1
 assert all(q.bounding_box()[2]<-.1 for q in (trimesh_to_manifold(after)+trimesh_to_manifold(raft)).decompose())


def test_large_raft_slots_preserve_root_material():
 import manifold3d as mf
 from arbor.engine.patch_release import divide_large_raft
 p=params(raft_split=True)
 raft=mf.Manifold.cube([28,10,.7]).translate([-14,-5,-.7])
 post=mf.Manifold.cylinder(5,1,1,20).translate([0,0,-.02])
 out,posts,report=divide_large_raft(manifold_to_trimesh(raft),manifold_to_trimesh(post),p)
 divided=trimesh_to_manifold(out)
 assert report['status']=='applied' and report['slots']==2
 assert divided.volume()<raft.volume()-1
 assert abs((divided^post).volume()-(raft^post).volume())<1e-6

def test_release_seam_cannot_remove_a_supported_startup_contact():
 from arbor.engine.patch_release import release_patches
 from arbor.engine.build import mesh_tree,mesh_raft
 from arbor.engine.contacts import VerticalCaster
 from shapely.geometry import box
 p=params(patch_release=True).updated(surface_aligned_tips=False)
 mesh=trimesh.creation.box([6,6,1]);mesh.apply_translation([0,0,5.5])
 tree=SupportTree();tree.z_base=0.;tree.model_xy_bounds=(-3,-3,3,3)
 tree.model_base=box(-3,-3,3,3)
 foot=tree.add([0,0,0],.6,NodeKind.FOOT)
 hub=tree.add([0,0,3.5],.4,NodeKind.BRANCH,parent=foot.id)
 # The startup sits on the planned gap between 2.4 mm ribbons.
 contacts=[]
 for i,x in enumerate((1.375,)):
  c=Contact(i,np.array([x,0.,5.]),np.array([0.,0.,-1.]),ContactReason.ISLAND)
  contacts.append(c);tree.add(c.position-[0,0,.06],.18,NodeKind.TIP,parent=hub.id,contact_id=i)
 build_patches(mesh,contacts,tree,p)
 result=release_patches(mesh,contacts,tree,mesh_tree(tree,p),mesh_raft(tree,p),p)
 assert any(0 in r.get('protectedContactIds',[]) for r in tree.patch_release_report)
 flipped=trimesh.Trimesh(result.vertices*[1,1,-1],result.faces[:,::-1],process=False)
 z,_=VerticalCaster(flipped).cast(np.array([[1.375,0,-4.999]]))
 assert abs(5+z[0]-p.patch_gap)<1e-5


def test_large_raft_routes_around_a_post_on_the_nominal_cut():
 import manifold3d as mf
 from arbor.engine.patch_release import divide_large_raft
 raft=mf.Manifold.cube([24,10,.7]).translate([-12,-5,-.7])
 post=mf.Manifold.cylinder(5,1,1,24).translate([0,0,-.02])
 r,s,report=divide_large_raft(manifold_to_trimesh(raft),manifold_to_trimesh(post),params(raft_split=True))
 assert report['slots']==1
 assert max(abs(x) for x,y in report['paths'][0]['pathXY'])>1.3
 assert abs(trimesh_to_manifold(s).volume()-post.volume())<1e-5
 # The root must not bridge the cut in the composite base layers.
 base=(trimesh_to_manifold(r)+trimesh_to_manifold(s)).trim_by_plane((0,0,-1),-.3)
 assert len(base.decompose())==2


def test_large_raft_notches_an_unavoidable_wide_root():
 import manifold3d as mf
 from arbor.engine.patch_release import divide_large_raft
 raft=mf.Manifold.cube([24,10,.7]).translate([-12,-5,-.7])
 root=mf.Manifold.cube([12,3,5]).translate([-6,-1.5,-.02])
 r,s,report=divide_large_raft(manifold_to_trimesh(raft),manifold_to_trimesh(root),params(raft_split=True))
 assert report['slots']==1 and report['paths'][0]['notchedSupportMm3']>0
 composite=trimesh_to_manifold(r)+trimesh_to_manifold(s)
 assert len(composite.trim_by_plane((0,0,-1),-.3).decompose())==2
 assert len(composite.decompose())==1 # upper structure can remain connected
 assert report['paths'][0]['depthMm']>.7+.3


def test_analysis_repairs_exact_seams_and_only_bounded_pinholes():
 import manifold3d as mf
 from arbor.engine.build import prepare_analysis_mesh
 box=trimesh.creation.box([2,2,2]); unwelded=trimesh.Trimesh(box.vertices[box.faces].reshape(-1,3),np.arange(len(box.faces)*3).reshape(-1,3),process=False)
 fixed,report=prepare_analysis_mesh(unwelded)
 assert report['status']=='repaired' and fixed.is_watertight
 assert abs(fixed.volume-box.volume)<1e-6
 tiny=trimesh.creation.box([.04,.04,.04]);tiny.update_faces(np.arange(len(tiny.faces))!=0)
 fixed,report=prepare_analysis_mesh(tiny)
 assert report['status']=='repaired' and report['filledHoleDiametersMm']
 assert trimesh_to_manifold(fixed).status()==mf.Error.NoError
 box.update_faces(np.arange(len(box.faces))!=0)
 fixed,report=prepare_analysis_mesh(box)
 assert report['status']=='unrepaired' and fixed is box
 assert len(box.faces)==11 # caller/export mesh has not been changed


def test_tilted_broad_sole_gets_patch_above_its_startup_corner():
 from arbor.engine.patches import _broad_surface_tiles
 x,y=np.meshgrid(np.arange(0,6,.25),np.arange(0,6,.25));xy=np.c_[x.ravel(),y.ravel()]
 normals=np.tile([0,-np.sin(np.deg2rad(38)), -np.cos(np.deg2rad(38))],(len(xy),5,1))
 flat=_broad_surface_tiles(xy,normals,.25)
 p=params(patch_mode='startup',patch_start_rise_mm=1.25)
 keep,_=_startup_patch_mask(xy,xy[:,1]*np.tan(np.deg2rad(38)),.25,[],p,flat=flat)
 assert keep.mean()>.9 # a broad surface need not have an island-labelled contact
 # A steep wall still gets pin contacts rather than a sheet.
 steep=np.tile([0,-np.sin(np.deg2rad(65)),-np.cos(np.deg2rad(65))],(len(xy),5,1))
 assert not _broad_surface_tiles(xy,steep,.25).any()


def test_section_preserves_a_post_inside_an_enclosing_ring():
 import manifold3d as mf
 from arbor.engine.patch_release import _shape
 from shapely.geometry import Point
 ring=mf.Manifold.cylinder(1,2,2,32)-mf.Manifold.cylinder(1,1,1,32)
 post=mf.Manifold.cylinder(1,.3,.3,20)
 shape=_shape((ring+post).slice(.5))
 assert shape.covers(Point(0,0))
 assert not shape.covers(Point(.7,0))
 assert shape.covers(Point(1.5,0))

def test_patch_surface_sampling_cache_tracks_geometry_and_sampling_settings():
 from arbor.engine.patches import _surface_samples, _surface_regions
 from arbor.engine.contacts import VerticalCaster
 mesh=trimesh.creation.box([4,4,1]);mesh.apply_translation([0,0,5.5])
 c=Contact(0,np.array([0.,0.,5.]),np.array([0.,0.,-1.]),ContactReason.ISLAND)
 p=params()
 class CountingCaster:
  def __init__(self, mesh): self.caster=VerticalCaster(mesh);self.calls=0
  def cast(self, points): self.calls+=1;return self.caster.cast(points)
 caster=CountingCaster(mesh)
 labels,regions=_surface_regions(mesh,[c],caster,p);region=next(iter(regions))
 low,high=mesh.vertices[mesh.faces[labels==region]].reshape(-1,3).min(axis=0),mesh.vertices[mesh.faces[labels==region]].reshape(-1,3).max(axis=0)
 first=_surface_samples(mesh,region,labels,caster,p,low,high);calls=caster.calls
 again=_surface_samples(mesh,region,labels,caster,p.updated(patch_gap=.2),low,high)
 assert first is again and caster.calls==calls
 _surface_samples(mesh,region,labels,caster,p.updated(line_width=.3),low,high)
 assert caster.calls==calls+1
 mesh.apply_translation([0,0,2]);moved=CountingCaster(mesh)
 after=_surface_samples(mesh,region,labels,moved,p,low+[0,0,2],high+[0,0,2])
 assert moved.calls==1 and np.allclose(after[2],first[2]+2)


def test_release_checkpoint_preserves_roof_gap_seams_and_attachment():
 import manifold3d as mf
 from arbor.engine.patch_release import _checkpoint
 # Two thin interface strips have separate posts and pads. Repeated cuts and
 # overlapping collars must retain the printable gap and both rooted pieces.
 pieces=[]
 for x in (-1.1,1.1):
  pad=mf.Manifold.cube([2,5,.7]).translate([x-1,-2.5,0])
  stem=mf.Manifold.cylinder(5.05,.3,.3,20).translate([x,0,.68])
  roof=mf.Manifold.cube([2,4,.18]).translate([x-1,-2,5.70])
  pieces.append(pad+stem+roof)
 original=mf.Manifold.batch_boolean(pieces,mf.OpType.Add)
 clean=_checkpoint(original)
 assert clean is not None and len(clean.decompose())==2
 assert abs(clean.volume()-original.volume())<1e-5
 assert abs(clean.bounding_box()[5]-5.88)<1e-6 # .12 mm below z=6 model
 seam=mf.Manifold.cube([.19,6,7]).translate([-.095,-3,0])
 assert (clean^seam).volume()<1e-8
 assert all(q.bounding_box()[2]<1e-6 for q in clean.decompose())


def test_patch_terminals_do_not_count_as_model_scars_but_carry_roof_height():
 from arbor.engine.verify import support_stats, _check_removal, _routed_contact_ids
 tree=SupportTree();foot=tree.add([0,0,0],.6,NodeKind.FOOT)
 branch=tree.add([0,0,3],.45,NodeKind.BRANCH,parent=foot.id)
 tree.add([0,0,5],.18,NodeKind.TIP,parent=branch.id,contact_id=0)
 for i in range(1,9):
  tree.add([.1*i,0,4],.6,NodeKind.TIP,parent=branch.id,contact_id=i)
 tree.support_terminal_ids=set(range(1,9));tree.patch_terminal_top_z={i:7. for i in range(1,9)}
 mesh=trimesh.creation.box([3,3,1]);mesh.apply_translation([0,0,8])
 issues=[];p=params()
 _check_removal(mesh,tree,p,issues)
 stats=support_stats(mesh,[],tree,trimesh.Trimesh(),None,issues,p)
 assert _routed_contact_ids(tree)=={0}
 assert stats['tip_contacts']==1 and stats['patch_terminals']==8
 assert abs(stats['contact_area_mm2']-np.pi*.18**2)<1e-8
 assert stats['max_tree_height_mm']==7.
 assert not any(i.code=='hard_to_remove' for i in issues)
