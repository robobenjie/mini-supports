/** Adversarial geometric diagnostics. These do not substitute for sliced paths or prints.
 * Run: node scripts/test-support-principles.mjs [--strict]
 * Known limitations are recorded as failed principles; --strict makes them fail CI.
 */
import { loadPyodide } from 'pyodide';
import Module from 'manifold-3d';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
const manifold = await Module(); manifold.setup();
const py = await loadPyodide({indexURL:path.resolve('public/runtime') + '/'});
py.registerJsModule('manifold_js',{api:manifold});
py.registerJsModule('browser_bridge',{progress:()=>{}});
await py.loadPackage(['numpy','scipy','shapely']);
for(const filename of ['networkx-3.4.2-py3-none-any.whl','arbor-engine.zip','trimesh-5.1.1-py3-none-any.whl'])
  py.unpackArchive(new Uint8Array(await readFile(`public/runtime/${filename}`)),'zip',{extractDir:'/engine'});
// Test source under development, rather than accidentally testing a stale packed engine.
for(const filename of ['params','analysis','contacts','tree','build','verify','placement','pipeline','types'])
  py.FS.writeFile(`/engine/arbor/engine/${filename}.py`,await readFile(`vendor/arborfdm/arbor/engine/${filename}.py`));
const report = JSON.parse(await py.runPythonAsync(`
import sys, json, math
sys.path.insert(0, '/engine')
import wasm_compat
import numpy as np
import trimesh
from shapely.geometry import box as polygon_box
from arbor.engine import tree as T, verify as V
from arbor.engine.analysis import analyze, max_layer_step
from arbor.engine.params import load_profiles
from arbor.engine.types import Contact, ContactReason, AnalysisResult, SupportRegion, SupportTree, NodeKind, Progress
p = load_profiles()['nozzle_02_normal'].params.updated(layer_height=.06, raft_enabled=False)
checks=[]
def record(id, criterion, passed, observations):
    checks.append(dict(id=id, criterion=criterion, passed=bool(passed), observations=observations))
def box(size, bottom):
    m=trimesh.creation.box(extents=size)
    m.apply_translation([0,0,bottom+size[2]/2])
    return m
# A requested geometric gap should remain after applying the tip's penetration.
contact=Contact(0,np.array([0.,0.,10.]),np.array([0.,0.,-1.]),ContactReason.MANUAL,manual=True)
tree=T.build_tree(box([4,4,1],10),[contact],p.updated(z_gap=.03),Progress())
tip=next(n for n in tree.nodes.values() if n.kind == NodeKind.TIP)
actual_gap=10.-float(tip.position[2])
record('gap-contract','A 0.03 mm requested gap means a 0.03 mm net vertical clearance on a flat underside',
       abs(actual_gap-.03)<1e-6,dict(requested_gap_mm=.03,penetration_mm=p.tip_penetration,actual_tip_center_gap_mm=actual_gap,
                                  note='This documents ambiguous legacy semantics, not a claim that all gaps are bad.'))
# One layer can geometrically fit after the requested air gap: do not subtract the gap twice.
short_p=p.updated(z_gap=.06,tip_penetration=0)
short_c=Contact(0,np.array([0.,0.,.15]),np.array([0.,0.,-1.]),ContactReason.MANUAL,manual=True)
short=T.build_tree(box([2,2,.5],.15),[short_c],short_p,Progress())
record('short-support-single-gap','A 0.15 mm cavity with a 0.06 mm top gap leaves 0.09 mm, enough for one 0.06 mm support layer',
       any(n.kind==NodeKind.TIP for n in short.nodes.values()),dict(total_free_height_mm=.15,net_height_mm=.09,failures=short.failed))
# Region checks must detect uncovered area, not just one contact near a region edge.
a=AnalysisResult(.06,np.array([10.]),regions=[SupportRegion('island',10.,polygon_box(0,0,20,20),400.)])
c=Contact(0,np.array([-.5,0,10.]),np.array([0,0,-1.]),ContactReason.ISLAND)
issues=[]; V._check_regions(a,[c],{0},p,issues)
record('regional-coverage','An island 20 x 20 mm with only one off-edge contact must fail coverage',
       any(i.code=='unsupported_region' for i in issues),dict(island_area_mm2=400,contacts=1,largest_xy_distance_mm=math.hypot(20.5,20),issues=[i.code for i in issues]))
# Global volume budget can hide an intersection far from all contact neighborhoods.
model=box([2,1,1],0); support=model.copy()
contacts=[Contact(i,np.array([100.+i,100.,10.]),np.array([0.,0.,-1.]),ContactReason.MANUAL) for i in range(100)]
issues=[]; V._check_mesh(model,support,SupportTree(),contacts,p,issues)
record('localized-collision','A 2 mm3 support intrusion unrelated to contact neighborhoods must be reported',
       any(i.code=='model_collision' for i in issues),dict(collision_mm3=2.,unrelated_contacts=100,issues=[i.code for i in issues],
          note='Adversarial checker-only fixture: the contacts are intentionally remote to test locality, not a normal generated tree.'))
# Surface growth limit should match model analysis at extreme user-supported overhang settings.
wide=p.updated(overhang_angle_deg=80)
analysis_step,source=max_layer_step(wide)
legacy_check_step=wide.layer_height*math.tan(math.radians(wide.overhang_angle_deg))
# Read implementation to distinguish old formula from a future shared helper.
import inspect
body=inspect.getsource(V.support_layer_regions)
shared=('max_layer_step(params)' in body or 'max_layer_step(P)' in body)
record('same-overlap-rule','Model and support analysis must share the line-width-capped maximum layer step',
       shared or abs(legacy_check_step-analysis_step)<1e-9,dict(analysis_step_mm=analysis_step,legacy_support_step_mm=legacy_check_step,cap_source=source))
# A tiny isolated printable feature must not disappear from the analysis silently.
tiny=box([.2,.2,.18],1.02)
a=analyze(tiny,p,Progress())
record('tiny-island-detection','A disconnected 0.2 x 0.2 mm feature must be surfaced for review even below region-area filtering',
       any(r.kind=='island' for r in a.regions),dict(n_islands=a.stats['n_islands'],small_islands_dropped=a.stats['n_small_islands_dropped'],area_mm2=.04,
          note='Toolpath survival still depends on variable-line-width settings. This tests detection only, not final contact placement.'))
# The routing policy already has a useful FDM invariant.
route=T.routing_angle_deg(p)
record('branch-angle-policy','Routing tilt stays below the configured branch angle and printable surface angle',
       route<=p.branch_angle_deg and route<=T.printable_angle_deg(p),dict(routing_angle_deg=route,branch_angle_deg=p.branch_angle_deg,printable_angle_deg=T.printable_angle_deg(p)))
json.dumps(dict(schema_version=1,layer_height_mm=.06,nozzle_mm=.2,checks=checks))
`));
await mkdir('research',{recursive:true});
await writeFile('research/principle-diagnostics.json',JSON.stringify(report,null,2)+'\n');
for(const check of report.checks)console.log(`${check.passed?'PASS':'LIMITATION'} ${check.id}: ${check.criterion}`);
console.log(`Recorded ${report.checks.filter(c=>c.passed).length}/${report.checks.length} satisfied principles. No physical-print claim is made.`);
if(process.argv.includes('--strict')&&report.checks.some(c=>!c.passed))process.exitCode=1;
