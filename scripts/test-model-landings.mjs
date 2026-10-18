/** Focused synthetic landing and retry regressions in the browser WASM runtime. No private meshes required. */
import {loadPyodide} from 'pyodide';import Module from 'manifold-3d';import{readFile}from'node:fs/promises';import path from'node:path';
const mf=await Module();mf.setup();const py=await loadPyodide({indexURL:path.resolve('public/runtime')+'/'});py.registerJsModule('manifold_js',{api:mf});py.registerJsModule('browser_bridge',{progress:()=>{}});await py.loadPackage(['numpy','scipy','shapely']);for(const f of ['networkx-3.4.2-py3-none-any.whl','arbor-engine.zip','trimesh-5.1.1-py3-none-any.whl'])py.unpackArchive(new Uint8Array(await readFile(`public/runtime/${f}`)),'zip',{extractDir:'/engine'});py.FS.writeFile('/engine/arbor/engine/tree.py',await readFile('vendor/arborfdm/arbor/engine/tree.py'));
py.FS.writeFile('/engine/arbor/engine/params.py',await readFile('vendor/arborfdm/arbor/engine/params.py'));
py.FS.writeFile('/engine/arbor/engine/build.py',await readFile('vendor/arborfdm/arbor/engine/build.py'));
try { await py.runPythonAsync(`
import sys
sys.path.insert(0,'/engine')
import browser_engine, numpy as np, trimesh
from arbor.engine import tree as T
from arbor.engine.params import SupportParams
from arbor.engine.types import Contact,ContactReason,NodeKind,Progress,SupportTree
for free_height in [.15,.12,.11]:
 p=SupportParams(layer_height=.06,z_gap=.06,tip_penetration=0,raft_enabled=False,allow_on_model=True)
 floor=trimesh.creation.box(extents=[6,6,1]);floor.apply_translation([0,0,.5])
 roof=trimesh.creation.box(extents=[4,4,1]);roof.apply_translation([0,0,1.5+free_height])
 model=trimesh.util.concatenate([floor,roof])
 contact=Contact(0,np.array([0.,0.,1+free_height]),np.array([0.,0.,-1.]),ContactReason.MANUAL,manual=True)
 tree=T.build_tree(model,[contact],p,Progress());tips=[n for n in tree.nodes.values() if n.kind==NodeKind.TIP]
 assert bool(tips)==(free_height>=.12), (free_height,tree.failed)
 if tips:
  tip=tips[0];foot=tree.nodes[tip.parent];assert foot.kind==NodeKind.MODEL_FOOT
  assert abs((tip.position[2]-foot.position[2])-(free_height-.06))<1e-9
 print('PASS free height',free_height,'tips',len(tips),'failures',tree.failed)

p=SupportParams(layer_height=.06,z_gap=.06,tip_penetration=0,raft_enabled=False,allow_on_model=True,on_model_tip_diameter=.24,line_width=.22,tip_length=1.2)
for lip_x,clearance,expected in [(None,.1,True),(.08,.1,False),(.08,.01,False),(.16,.1,False),(.16,.01,True)]:
 p.model_neck_clearance=clearance
 floor=trimesh.creation.box(extents=[6,6,1]);floor.apply_translation([0,0,.5])
 pieces=[floor]
 if lip_x is not None:
  lip=trimesh.creation.box(extents=[.1,1,.5]);lip.apply_translation([lip_x+.05,0,1.4]);pieces.append(lip)
 model=trimesh.util.concatenate(pieces)
 c=Contact(0,np.array([0.,0.,6.]),np.array([0.,0.,-1.]),ContactReason.MANUAL,manual=True)
 tree=SupportTree();T._init_tree_extras(tree,0)
 r=T._Router(model,[c],p,tree,Progress());r._prepare()
 n=tree.add([0,0,4],.5,NodeKind.BRANCH)
 got=r._land_path_clear(n.id,np.array([0.,0.]),4.,1.)
 assert got==expected,(lip_x,clearance,got)
 print('PASS lower neck lip',lip_x,'clearance',clearance,'clear',got)

for bar_present,expected in [(False,True),(True,False)]:
 floor=trimesh.creation.box(extents=[30,30,3]);floor.apply_translation([0,0,1.5])
 pieces=[floor]
 if bar_present:
  bar=trimesh.creation.box(extents=[10,30,2]);bar.apply_translation([0,0,9]);pieces.append(bar)
 model=trimesh.util.concatenate(pieces)
 c=Contact(0,np.array([0.,0.,16.]),np.array([0.,0.,-1.]),ContactReason.MANUAL)
 tree=SupportTree();T._init_tree_extras(tree,0)
 r=T._Router(model,[c],p,tree,Progress());r._prepare()
 n=tree.add([0,0,14],.5,NodeKind.BRANCH)
 got=r._land_path_clear(n.id,np.array([0.,0.]),14.,3.)
 assert got==expected,(bar_present,got)
 print('PASS upper path obstacle',bar_present,'clear',got)

for angle in [0,15]:
 floor=trimesh.creation.box(extents=[6,6,1]);floor.apply_transform(trimesh.transformations.rotation_matrix(np.radians(angle),[0,1,0]));floor.apply_translation([0,0,1])
 c=Contact(0,np.array([0.,0.,8.]),np.array([0.,0.,-1.]),ContactReason.MANUAL)
 tree=SupportTree();T._init_tree_extras(tree,0)
 r=T._Router(floor,[c],p,tree,Progress());r._prepare();r.landed=[];r.fail_nodes={}
 n=tree.add([0,0,5],.5,NodeKind.BRANCH)
 exact=1+.5/np.cos(np.radians(angle))
 r.grid.top_below=lambda q,z: exact+.15 if np.linalg.norm(q)<1e-9 else None
 r._blocked(n.id,np.array([0.,0.]),5.,.5)
 feet=[n for n in tree.nodes.values() if n.kind==NodeKind.MODEL_FOOT]
 assert len(feet)==1,(angle,r.fail_nodes)
 assert abs(feet[0].position[2]-exact)<1e-7,(angle,feet[0].position,exact)
 print('PASS exact landing plane angle',angle,'surface',exact)

for lip_x,expected in [(-.13,True),(0.,False)]:
 p=SupportParams(layer_height=.06,z_gap=.06,tip_penetration=0,raft_enabled=False,allow_on_model=True,on_model_tip_diameter=.24,line_width=.22,tip_length=1.2,compact_junctions=True,model_neck_clearance=.01,branch_angle_deg=40)
 floor=trimesh.creation.box(extents=[6,6,1]);floor.apply_translation([0,0,.5])
 lip=trimesh.creation.box(extents=[.03,.3,.05]);lip.apply_translation([lip_x+.015,0,1.675])
 c=Contact(0,np.array([0.,0.,6.]),np.array([0.,0.,-1.]),ContactReason.MANUAL)
 tree=SupportTree();T._init_tree_extras(tree,0)
 r=T._Router(trimesh.util.concatenate([floor,lip]),[c],p,tree,Progress());r._prepare()
 n=tree.add([.35,0,2.2],.35,NodeKind.BRANCH)
 got=r._land_path_clear(n.id,np.array([0.,0.]),2.2,1.)
 assert got==expected,(lip_x,got)
 print('PASS compact inclined neck lip',lip_x,'clear',got)

p=SupportParams(layer_height=.06,z_gap=.06,tip_penetration=0,raft_enabled=False,allow_on_model=True,on_model_tip_diameter=.24,line_width=.22,tip_length=1.2,compact_junctions=True,model_neck_clearance=.01,branch_angle_deg=40,branch_min_diameter=1.2)
pieces=[]
for lo,hi in [([-4,-5,0],[4,5,.4]),([.25,-5,.4],[.5,5,9.4]),([1.05,-5,.4],[1.4,5,9.4]),([-.5,-.5,10],[.5,.5,10.5])]:
 lo=np.array(lo);hi=np.array(hi);piece=trimesh.creation.box(extents=hi-lo);piece.apply_translation((lo+hi)/2);pieces.append(piece)
mesh=trimesh.util.concatenate(pieces)
c=Contact(0,np.array([0.,0.,10.]),np.array([0.,0.,-1.]),ContactReason.MANUAL)
old_dir=T._Router._tip_dir;old_retry=T._Router._retry_failed_tips
T._Router._tip_dir=lambda self,pos,normal:np.array([np.sin(np.radians(40)),0,-np.cos(np.radians(40))])
T._Router._retry_failed_tips=lambda self:None
before=T.build_tree(mesh,[c],p,Progress())
assert 0 in before.failed,before.stats()
T._Router._retry_failed_tips=old_retry
after=T.build_tree(mesh,[c],p,Progress())
assert 0 not in after.failed,after.failed
assert any(n.kind==NodeKind.TIP and n.contact_id==0 for n in after.nodes.values())
T._Router._tip_dir=old_dir
print('PASS trapped initial tip is rerouted',getattr(after,'routing_retries',[]))

# Snapshot the already-routed tree before retry. A candidate runs in an isolated
# temporary tree and must neither merge with nor rewrite existing good branches.
extra=trimesh.creation.box(extents=[1,1,.5]);extra.apply_translation([-8,0,10.25])
extra_floor=trimesh.creation.box(extents=[6,6,.4]);extra_floor.apply_translation([-8,0,.2])
two_model=trimesh.util.concatenate([mesh,extra,extra_floor])
second=Contact(1,np.array([-8.,0.,10.]),np.array([0.,0.,-1.]),ContactReason.MANUAL)
main=SupportTree();T._init_tree_extras(main,0)
r=T._Router(two_model,[c,second],p,main,Progress());r._prepare()
T._Router._tip_dir=lambda self,pos,normal:np.array([np.sin(np.radians(40)),0,-np.cos(np.radians(40))])
r._make_tips();r._route();r._cleanup()
assert 0 in main.failed and 1 not in main.failed,main.failed
snapshot={key:(n.position.copy(),n.radius,n.parent,n.kind,n.contact_id) for key,n in main.nodes.items()}
assert snapshot
r._retry_failed_tips()
assert 0 not in main.failed,main.failed
for key,(position,radius,parent,kind,cid) in snapshot.items():
 n=main.nodes[key]
 assert np.array_equal(n.position,position) and (n.radius,n.parent,n.kind,n.contact_id)==(radius,parent,kind,cid)
T._Router._tip_dir=old_dir
print('PASS retry preserves existing branches and node identities',len(snapshot))
`); } catch (error) { console.error(error.message); process.exitCode = 1; }
