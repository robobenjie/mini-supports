"""Progressive patch release on clear downward routes.

Preserve the selected conformal surface and gap; replace rigid crowns with
separate ribbons, grip posts and short flexible necks. Obstructed routes retain
the collision-aware tree crown. Every replacement must preserve rootedness and
all ordinary contact tips outside its footprint.
"""
from __future__ import annotations
import math
import numpy as np
import manifold3d as mf
from shapely.geometry import Polygon, Point
from shapely.ops import unary_union
from .build import cone_between, trimesh_to_manifold, manifold_to_trimesh, MIN_PART_VOLUME


def _shape(cs):
    rings = []
    for ring in cs.to_polygons():
        ring = np.asarray(ring)
        if len(ring) < 3: continue
        area = np.sum(ring[:,0]*np.roll(ring[:,1],-1)-ring[:,1]*np.roll(ring[:,0],-1))
        rings.append((Polygon(ring).buffer(0), area > 0))
    # Restore islands inside holes after subtracting their enclosing hole.
    # Unioning all outers before subtracting holes erases those islands.
    shape = Polygon()
    for polygon, positive in sorted(rings, key=lambda item: item[0].area, reverse=True):
        shape = shape.union(polygon) if positive else shape.difference(polygon)
    return shape.buffer(0)


def _checkpoint(solid):
    """Materialize geometry before combining another round of release cuts.

    The WASM kernel can abort on long Boolean histories containing coincident
    zero-volume seams. A fresh indexed mesh drops that history, using the same
    float32 boundary representation as our normal support export. Do not weld
    nearby vertices or simplify the printable geometry.
    """
    mesh = solid.to_mesh()
    fresh = mf.Manifold(mf.Mesh(
        # Native Manifold exposes read-only views but Mesh requires writable
        # arrays; explicit copies also work with the browser adapter.
        np.array(mesh.vert_properties[:, :3], dtype=np.float32, order='C', copy=True),
        np.array(mesh.tri_verts, dtype=np.uint32, order='C', copy=True)))
    return fresh if fresh.status() == mf.Error.NoError else None


def release_patches(mesh, contacts, tree, support_mesh, raft_mesh, params, progress=None):
    # Patch-first crowns already contain their grips and breakaway necks. A
    # second conversion would discard that layout and repeat costly Booleans.
    if getattr(tree, 'patch_release_preplanned', False):
        return support_mesh
    if not params.patch_release or raft_mesh is None or not getattr(tree, 'patch_solids', []):
        return support_mesh
    from .patches import _extrude_downward_surface
    support = trimesh_to_manifold(support_mesh)
    raft = trimesh_to_manifold(raft_mesh)
    model = trimesh_to_manifold(mesh)
    keepout = model + model.translate([0,0,-params.patch_gap])
    base = float(getattr(tree,'z_base',0))
    skin_all = _extrude_downward_surface(mesh,np.flatnonzero(mesh.face_normals[:,2]<-.01),params.patch_roof_thickness).translate([0,0,-params.patch_gap])
    report = []
    tree.patch_release_report = report
    for pi,crown in enumerate(tree.patch_solids):
        if progress: progress.update(pi/max(1,len(tree.patch_solids)), 'Adding removable patch grips')
        skin = skin_all ^ crown ^ support
        if skin.is_empty(): continue
        xy = _shape(skin.project())
        if xy.is_empty: continue
        bounds = np.asarray(skin.bounding_box()).reshape(2,3)
        lo,hi=bounds
        record=dict(patch=pi,status='retained',reason='Insufficient clear room for grip and neck')
        report.append(record)
        # A short branch is safer than a grip colliding with the sculpture/raft.
        if lo[2]-base < params.patch_release_grip_length+1.95: continue
        if hi[2]-base > 12:
            record['reason']='Tall patch retains the routed, braced tree foundation'
            continue
        axis=int(np.argmin(hi[:2]-lo[:2])); along=1-axis
        width=params.patch_release_width; gap=max(.35,params.line_width)
        pitch=width+gap; count=max(1,int(math.ceil((hi[axis]-lo[axis])/pitch)))
        zero=(lo[axis]+hi[axis])/2-count*pitch/2
        strips=[]; records=[]; failed=False
        for i in range(count):
            left=zero+i*pitch+gap/2; right=left+width
            size=hi-lo+[2,2,2]; origin=lo-[1,1,1]
            size[axis]=width;origin[axis]=left
            slab=mf.Manifold.cube(size).translate(origin)
            for piece in (skin^slab).decompose():
                if piece.volume()<.01: continue
                footprint=_shape(piece.project());a=np.array(footprint.bounds)
                center=np.array(footprint.representative_point().coords[0]); start=a[along];end=a[along+2]
                n=max(1,int(math.ceil((end-start)/2.2)));n+=1-n%2
                members=[piece];stems=[]
                for value in start+(np.arange(n)+.5)*(end-start)/n:
                    pos=center.copy();pos[along]=value
                    fs=hi-lo+[2,2,2];fo=lo-[1,1,1];fs[axis]=width;fo[axis]=left
                    fs[along]=1.6;fo[along]=value-.8
                    roof=piece^mf.Manifold.cube(fs).translate(fo)
                    if roof.is_empty():continue
                    local = _shape(roof.project())
                    inset = local.buffer(-.12)
                    if inset.is_empty: inset = local
                    pos = np.array(inset.representative_point().coords[0])
                    top=roof.bounding_box()[2]+.04
                    roof_vertices=np.asarray(roof.to_mesh().vert_properties)[:,:2]
                    reach=float(np.linalg.norm(roof_vertices-pos,axis=1).max())
                    fan_z=top-max(.95,reach-.8+.05)
                    grip_z=fan_z-params.patch_release_grip_length;neck_z=grip_z-.8
                    if neck_z<base+.25:failed=True;record["failure"]="height";break
                    # Broad base and short neck: flexibility stays at removal end.
                    radius=min(params.trunk_diameter/2,.4+.0175*max(0,neck_z-base-5))
                    stem=cone_between([*pos,base-.02],[*pos,neck_z+.02],radius,.4,20)
                    neck=cone_between([*pos,neck_z-.02],[*pos,grip_z+.02],.3,.3,20)
                    grip=cone_between([*pos,grip_z],[*pos,grip_z+.5],.3,.8,20)+cone_between([*pos,grip_z+.49],[*pos,fan_z+.03],.8,.8,20)
                    hub=mf.Manifold.cylinder(.06,.8,.8,20).translate([*pos,fan_z-.03])
                    fan=(mf.Manifold.batch_hull([hub,roof])-keepout)^slab
                    members += [stem,neck,grip,fan]
                    stems.append(dict(x=float(pos[0]),y=float(pos[1]),neckBottom=neck_z,gripBottom=grip_z,fanBottom=fan_z))
                if failed:break
                if not stems:failed=True;record["failure"]="no stems";break
                # Mutual bracing below the breakaway neck, never across ribbons.
                for first,second in zip(stems,stems[1:]):
                    topz=min(first['neckBottom'],second['neckBottom'])-.3
                    if topz-base<8:continue
                    for z in np.arange(base+1,topz-1,5):
                        target=min(z+3,topz)
                        brace=cone_between([first['x'],first['y'],z],[second['x'],second['y'],target],.5,.5,16)
                        members.append(brace)
                assembled=mf.Manifold.batch_boolean(members,mf.OpType.Add)
                significant=[q for q in assembled.decompose() if q.volume()>params.line_width**2*params.patch_roof_thickness]
                if len(significant)!=1 or (assembled^keepout).volume()>1e-6:
                    failed=True;record["failure"]=dict(components=[q.volume() for q in assembled.decompose()],collision=float((assembled^keepout).volume()),bounds=list(piece.bounding_box()));break
                assembled=significant[0]
                strips.append(assembled);records.append(dict(bounds=list(piece.bounding_box()),stems=stems))
            if failed:break
        if failed or not strips:
            record['reason']='A ribbon route is obstructed or lacks a printable grip';continue
        replacement=mf.Manifold.batch_boolean(strips,mf.OpType.Add)
        # Keep a tiny rim so the cut fully removes old fans at their boundaries.
        footprint=(skin.project()+replacement.project()).offset(.035)
        cut=mf.Manifold.extrude(footprint,hi[2]-base+.06).translate([0,0,base-.03])
        # Do not sever a higher tree branch or another model contact passing through.
        outside=[c for c in contacts if c.enabled and not xy.buffer(.1).covers(Point(c.position[:2]))]
        if any(cut.ray_cast(c.position-[0,0,.2],c.position+[0,0,.02]) for c in outside):
            record['reason']='Cut would alter an ordinary contact';continue
        remainder=support-cut
        if (replacement^remainder).volume()>1e-5:
            record['reason']='Existing branches would tie the removable grips together';continue
        candidate=remainder+replacement
        # New straight posts can sit outside the old tree-foot outline. Extend
        # the pad to their actual bases before testing support connectivity.
        pads=[raft]
        for ribbon in records:
            for stem in ribbon['stems']:
                pads.append(mf.Manifold.cylinder(base-raft.bounding_box()[2]+.02,1.,1.,20).translate([stem['x'],stem['y'],raft.bounding_box()[2]]))
        candidate_raft=_checkpoint(mf.Manifold.batch_boolean(pads,mf.OpType.Add))
        candidate=_checkpoint(candidate)
        if candidate is None or candidate_raft is None:
            record['reason']='Replacement could not preserve a valid support boundary'
            continue
        # Ribbon seams must not erase a startup/edge contact inside the old
        # patch footprint. The outside-contact check above protects other
        # trees, but a heel corner can also land directly on a new ribbon gap.
        # Retain the routed crown if its replacement loses such an anchor.
        contact_depth = max(params.patch_gap, params.z_gap) + params.layer_height + .005
        cut_bounds = np.asarray(cut.bounding_box()).reshape(2, 3)
        lost = []
        for c in contacts:
            if not c.enabled or np.any(c.position[:2] < cut_bounds[0,:2]) or np.any(c.position[:2] > cut_bounds[1,:2]):
                continue
            start, end = c.position-[0,0,contact_depth], c.position-[0,0,.001]
            if support.ray_cast(start,end) and not candidate.ray_cast(start,end):
                lost.append(c.id)
        if lost:
            record.update(reason='Ribbon seam would remove an existing contact', protectedContactIds=lost)
            continue
        # Boolean seams can contain closed, zero-volume fins. They cannot carry
        # a printed branch, and subtracting coincident fins from one another
        # can abort the WASM geometry kernel. Discard them before any Boolean
        # comparison, using the same fragment floor as the final tree mesher.
        original_free=[q for q in (support+raft).decompose() if q.volume()>=MIN_PART_VOLUME and q.bounding_box()[2]>raft.bounding_box()[2]+.02]
        free=mf.Manifold.batch_boolean(original_free,mf.OpType.Add) if original_free else mf.Manifold()
        unrooted=[q for q in (candidate+candidate_raft).decompose() if q.volume()>=MIN_PART_VOLUME and q.bounding_box()[2]>raft.bounding_box()[2]+.02 and (q-free).volume()>MIN_PART_VOLUME]
        # Cutting away an old fan may leave obsolete twig ends. Only discard
        # those with no new ribbon material and no ordinary contact to carry.
        disposable=[]
        for q in unrooted:
            if (q^replacement).volume()>1e-5 or any(q.ray_cast(c.position-[0,0,.25],c.position+[0,0,.02]) for c in contacts if c.enabled):
                break
            disposable.append(q)
        if len(disposable)!=len(unrooted):
            record['reason']='Replacement would leave an unrooted support'
            continue
        if disposable: candidate=candidate-mf.Manifold.batch_boolean(disposable,mf.OpType.Add)
        support=candidate;raft=candidate_raft
        tree.release_raft_mesh=manifold_to_trimesh(raft)
        record.update(status='applied',reason=None,ribbons=records,ribbonCount=len(strips),gripLengthMm=params.patch_release_grip_length,neckDiameterMm=.6,gapMm=params.patch_gap)
    # Ribbon subtraction can leave zero-volume fins or sub-printable scraps at
    # old crown seams. Apply the same fragment floor as the tree mesher and
    # restore its base plane after the intentional stem/raft overlap above.
    support = support.trim_by_plane((0,0,1),base)
    pieces = [p for p in support.decompose() if p.volume() >= MIN_PART_VOLUME]
    support = mf.Manifold.batch_boolean(pieces,mf.OpType.Add) if pieces else mf.Manifold()
    return manifold_to_trimesh(support)


def _routed_slot(axis, position, lo, hi, roots, gap, span):
    """Monotone shortest path near a grid line, avoiding inflated root footprints.

    A large obstacle penalty permits notching a foot when no clear route exists
    in the bounded corridor. Exact solid subtraction below removes that material
    too, so an unavoidable crossing never silently turns into a bridge.
    """
    from shapely import contains_xy
    from shapely.geometry import LineString
    step = max(.25, gap/2)
    along = 1-axis
    reach = min(span*.3, (hi[axis]-lo[axis])*.2)
    offsets = np.arange(-reach, reach+step*.5, step)
    offsets = np.unique(np.r_[offsets, 0.])
    cross = position+offsets
    cross = cross[(cross > lo[axis]+gap) & (cross < hi[axis]-gap)]
    travel = np.linspace(lo[along]-1, hi[along]+1, int(math.ceil((hi[along]-lo[along]+2)/step))+1)
    xx, yy = np.meshgrid(cross, travel)
    # Inflate by half a cell diagonal as well, so diagonals between samples
    # cannot sneak through the protected outline.
    protected = roots.buffer(gap/2+.08+step/math.sqrt(2))
    blocked = contains_xy(protected, xx if axis==0 else yy, yy if axis==0 else xx)
    local = 1+1000*blocked+.12*np.abs(cross-position)[None, :]
    costs = local[0].copy(); parents = []
    for row in local[1:]:
        candidates = np.vstack([np.r_[np.inf,costs[:-1]]+.42, costs, np.r_[costs[1:],np.inf]+.42])
        choice = candidates.argmin(axis=0)
        parents.append(np.arange(len(cross))+choice-1)
        costs = candidates.min(axis=0)+row
    index = int(np.argmin(costs)); path = [index]
    for parent in reversed(parents):
        index = int(parent[index]); path.append(index)
    xy = np.c_[cross[path[::-1]],travel]
    if axis: xy = xy[:, ::-1]
    line = LineString(xy).simplify(.02)
    return line, line.buffer(gap/2, cap_style=2, join_style=1)


def divide_large_raft(raft_mesh, support_mesh, params):
    """Route pad slots around roots and carry every cut through the base collars.

    Upper trees can still share branches. These slots divide the rigid base,
    not necessarily the entire support assembly. Never detach a rooted branch.
    """
    if not params.raft_split or raft_mesh is None or params.raft_max_span<=0:
        return raft_mesh,support_mesh,dict(status='disabled')
    raft=trimesh_to_manifold(raft_mesh);lo,hi=np.array(raft.bounding_box()).reshape(2,3)
    if max(hi[:2]-lo[:2])<=params.raft_max_span:
        return raft_mesh,support_mesh,dict(status='unchanged',reason='Raft fits within size threshold')
    support=trimesh_to_manifold(support_mesh)
    extra=max(.3, params.foot_height+params.collar_height+.05)
    top=hi[2]+extra
    slab=mf.Manifold.cube(hi-lo+[2,2,extra+.2]).translate(lo-[1,1,.1])
    roots=_shape((support^slab).project())
    gap=max(.6,2*params.line_width)
    reports=[]
    free=[q for q in (raft+support).decompose() if q.volume()>=MIN_PART_VOLUME and q.bounding_box()[2]>lo[2]+.02]
    original_free=mf.Manifold.batch_boolean(free,mf.OpType.Add) if free else mf.Manifold()
    for axis in (0,1):
        count=int(math.ceil((hi[axis]-lo[axis])/params.raft_max_span))
        for i in range(1,count):
            pos=lo[axis]+i*(hi[axis]-lo[axis])/count
            line,polygon=_routed_slot(axis,pos,lo,hi,roots,gap,params.raft_max_span)
            section=mf.CrossSection([np.asarray(polygon.exterior.coords)[:-1]],mf.FillRule.EvenOdd)
            cut=mf.Manifold.extrude(section,top-lo[2]+.1).translate([0,0,lo[2]-.1])
            next_raft=raft-cut;next_support=support-cut
            unrooted=[q for q in (next_raft+next_support).decompose()
                      if q.volume()>=MIN_PART_VOLUME and q.bounding_box()[2]>lo[2]+.02 and (q-original_free).volume()>MIN_PART_VOLUME]
            record=dict(pathXY=list(map(list,line.coords)),widthMm=gap,depthMm=top-lo[2],
                        notchedSupportMm3=max(0.,float((support^cut).volume())))
            if unrooted:
                record.update(status='skipped',reason='Cut would detach a support from its foundation')
            else:
                raft,support=next_raft,next_support
                record['status']='applied'
            reports.append(record)
    return manifold_to_trimesh(raft),manifold_to_trimesh(support),dict(
        status='applied' if any(r['status']=='applied' for r in reports) else 'skipped',
        thresholdMm=params.raft_max_span,slots=sum(r['status']=='applied' for r in reports),
        protectedRootBridges=False,paths=reports)
