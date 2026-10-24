"""Model-sized conformal underside patches on routed tree branches.

Connected downward-facing model surfaces determine each patch footprint.
Angular fans attach a continuous negative of the underside to branches; they do not project walls
from the interface to the bed. Full-solid collision
checks reject fans which would cross the sculpture. Point tips remain the
fallback when no printable crown fits.
"""
from __future__ import annotations

import math
import numpy as np
import manifold3d as mf

from .contacts import VerticalCaster
from .types import Contact, ContactReason, NodeKind


class _CollisionWindows:
    """Reuse exact local pieces of the sculpture for thousands of tiny fans.

    Every window encloses the entire candidate fan (with a margin). Intersecting
    against this clipped solid therefore gives the same collision volume as the
    full sculpture, without revisiting distant triangles for every roof tile.
    """
    def __init__(self, model, keepout, face_count):
        self.solids = (model, keepout)
        self.cache = {}
        # Small meshes are already cheap to intersect; clipping them first can
        # cost more than it saves. This selects the check, not the geometry.
        self.enabled = face_count > 12000

    def at(self, low, high):
        if not self.enabled:
            return self.solids
        low = np.floor((np.asarray(low) - .01) / 4) * 4
        high = np.ceil((np.asarray(high) + .01) / 4) * 4
        key = (*low, *high)
        if key not in self.cache:
            if len(self.cache) >= 256:
                self.cache.clear()
            box = mf.Manifold.cube(high-low).translate(low)
            self.cache[key] = tuple(s ^ box for s in self.solids)
        return self.cache[key]


def add_corner_contacts(mesh, analysis, contacts, params):
    """Catch small advancing regions connected to an existing model section.

    Existing island detection alone misses these. Cluster across neighbouring
    layers so a growing corner receives one crown, not a wall of crowns.
    """
    if not params.underside_patches:
        return contacts
    caster = VerticalCaster(mesh)
    out = list(contacts)
    # Tiny hole ceilings often have material on both sides within a few bead
    # widths. Avoid filling these cavities with unremovable short pillars.
    # Never waive islands or low points; record every omitted contact.
    from shapely.geometry import Point
    microbridges = []
    microledges = []
    if analysis.layer_polygons is not None:
        for c in out:
            if c.manual or c.reason not in (ContactReason.EDGE, ContactReason.SURFACE, ContactReason.CORNER):
                continue
            k = int(np.searchsorted(analysis.layer_z, c.position[2] - 2 * params.layer_height)) - 1
            if k < 0 or k >= len(analysis.layer_polygons):
                continue
            poly = analysis.layer_polygons[k]
            if poly.is_empty or poly.contains(Point(c.position[:2])):
                continue
            # A connected detail projecting less than one bead beyond existing
            # material over two layers is not a new island. Resin-style edge
            # sampling otherwise fills every tiny dimple/rim with a pillar.
            distance = float(poly.distance(Point(c.position[:2])))
            if distance <= params.line_width:
                c.enabled = False
                c.note = f"Experimental microledge: {distance:.3f} mm from two-layer foundation"
                microledges.append(dict(contactId=c.id, reachMm=distance))
                continue
            found = False
            for radius in (.3, .4, .5, .6):
                for angle in np.arange(8) * np.pi / 8:
                    delta = radius * np.array([np.cos(angle), np.sin(angle)])
                    if all(poly.contains(Point(c.position[:2] + s * delta)) for s in (-1, 1)):
                        c.enabled = False
                        c.note = f"Experimental microbridge: opposing foundations within {2*radius:.2f} mm"
                        microbridges.append(dict(contactId=c.id, spanMm=2*radius))
                        found = True
                        break
                if found:
                    break
    analysis.stats["microbridge_contacts_omitted"] = microbridges
    analysis.stats["microledge_contacts_omitted"] = microledges
    next_id = max((c.id for c in out), default=-1) + 1
    for region in sorted(analysis.regions, key=lambda r: r.z):
        if region.kind != "overhang" or not .03 <= region.area <= params.contact_spacing ** 2:
            continue
        q = region.polygon.representative_point()
        p = np.array([q.x, q.y, region.z - params.layer_height * 1.1])
        z, f = caster.cast(p[None])
        if f[0] < 0:
            continue
        p[2] = z[0]
        if p[2] <= params.layer_height:
            continue
        if any(np.linalg.norm(p - c.position) < .65 * params.contact_spacing for c in out):
            continue
        out.append(Contact(next_id, p, mesh.face_normals[f[0]], ContactReason.CORNER,
                           note="Local patch candidate at an advancing underside"))
        next_id += 1
    return out


def patch_removal_axis(mesh, contacts, params):
    """Prefer a split between nearby underside contact clusters.

    A bounding-box-only split cuts through the elbow's developing bottom.
    Evaluate both axes using 3D proximity, so contacts on the same small feature
    tend to stay together. Keep the original choice without automatic anchors.
    """
    fallback = int(np.argmin(mesh.extents[:2]))
    seeds = [c for c in contacts if c.enabled and c.reason in
             (ContactReason.ISLAND, ContactReason.LOW_POINT, ContactReason.CORNER)]
    if len(seeds) < 2:
        return fallback
    xyz = np.array([c.position for c in seeds])
    distance = np.linalg.norm(xyz[:, None] - xyz[None, :], axis=2)
    weights = np.exp(-distance / params.contact_spacing)
    np.fill_diagonal(weights, 0)
    centre = mesh.bounds.mean(axis=0)
    def score(axis):
        sides = xyz[:, axis] < centre[axis]
        if sides.all() or not sides.any():
            return (2., axis != fallback)
        crossing = np.sum(weights * (sides[:, None] != sides[None, :])) / max(weights.sum(), 1e-9)
        balance = abs(2 * sides.mean() - 1)
        return (crossing + .08 * balance, axis != fallback)
    return min((0, 1), key=score)


def _surface_regions(mesh, contacts, caster, params):
    """Connected underside faces; holes and separate surfaces stay separate."""
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import connected_components
    mask = mesh.face_normals[:, 2] <= -math.cos(math.radians(params.patch_slope_deg))
    adjacency = mesh.face_adjacency
    adjacency = adjacency[mask[adjacency].all(axis=1)]
    graph = coo_matrix((np.ones(len(adjacency)), adjacency.T),
                       shape=(len(mesh.faces), len(mesh.faces)))
    _, labels = connected_components(graph, directed=False)
    labels[~mask] = -1
    points = np.array([c.position for c in contacts], float)
    if not len(points):
        return labels, {}
    points[:, 2] -= .01
    _, faces = caster.cast(points)
    regions = {}
    for c, face in zip(contacts, faces):
        if face >= 0 and labels[face] >= 0:
            regions.setdefault(int(labels[face]), []).append(c)
    return labels, regions


def _extrude_downward_surface(mesh, faces, depth):
    """Close an oriented underside into a vertical slab, preserving holes.

    Extruding the surface, rather than subtracting translated model volumes,
    also works when the model itself is thinner than the gap or roof.
    """
    selected = np.asarray(mesh.faces)[faces]
    indices, remap = np.unique(selected, return_inverse=True)
    f = remap.reshape(-1, 3)
    top = np.asarray(mesh.vertices)[indices]
    n = len(top)
    vertices = np.vstack([top, top - [0, 0, depth]])
    # Original faces point down: reverse the upper copy, keep the lower copy.
    triangles = [f[:, ::-1], f + n]
    edges = np.concatenate([f[:, [0, 1]], f[:, [1, 2]], f[:, [2, 0]]])
    _, inverse, counts = np.unique(np.sort(edges, axis=1), axis=0,
                                   return_inverse=True, return_counts=True)
    boundary = edges[counts[inverse] == 1]
    a, b = boundary.T
    triangles.extend([np.c_[a, b, b + n], np.c_[a, b + n, a + n]])
    result = mf.Manifold(mf.Mesh(np.asarray(vertices, dtype=np.float32),
                                np.asarray(np.vstack(triangles), dtype=np.uint32)))
    return result


def _startup_patch_mask(centers, heights, pitch, contacts, params, flat=None):
    """Keep the early growth around supported minima, rather than whole roofs.

    Quantized height plateaus drain to lower neighbours, defining local basins
    without depending on triangulation density. A positive patch_start_rise_mm
    keeps the surface within that vertical rise of each seeded basin minimum;
    otherwise retain the legacy lowest-area-fraction experiment.
    Two-layer quantization suppresses sub-layer surface noise;
    three layers of rise prevent a single-row patch at a sharp point.
    This is an experimental geometric proxy for fragile startup regions, not a
    prediction of layer adhesion or whether a feature is self-supporting.
    Broad, nearly horizontal underside areas remain covered even when they
    share a basin with a lower point.
    """
    if not len(centers):
        return np.zeros(0, dtype=bool), []
    cells = np.rint((centers - centers.min(axis=0)) / pitch).astype(int)
    lookup = {tuple(xy): i for i, xy in enumerate(cells)}
    edges = [(i, lookup[(x + dx, y + dy)]) for i, (x, y) in enumerate(cells)
             for dx, dy in ((1, 0), (0, 1)) if (x + dx, y + dy) in lookup]
    quantum = max(2 * params.layer_height, .01)
    levels = np.floor((heights - heights.min()) / quantum + 1e-7).astype(int)
    parent = np.arange(len(cells))
    def root(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i
    for a, b in edges:
        if levels[a] == levels[b]:
            ra, rb = root(a), root(b)
            parent[max(ra, rb)] = min(ra, rb)
    plateaus = np.array([root(i) for i in range(len(cells))])
    # Each plateau has one downhill destination; links strictly decrease in
    # quantized height, so following them always terminates.
    downhill = {}
    for a, b in edges:
        if levels[a] == levels[b]:
            continue
        high, low = (a, b) if levels[a] > levels[b] else (b, a)
        source = plateaus[high]
        candidate = (levels[low], heights[low], int(plateaus[low]))
        if source not in downhill or candidate < downhill[source]:
            downhill[source] = candidate
    drains = {}
    for plateau in np.unique(plateaus):
        trail, here = [], int(plateau)
        while here in downhill and here not in drains:
            trail.append(here)
            here = downhill[here][2]
        destination = drains.get(here, here)
        drains[here] = destination
        for ancestor in trail:
            drains[ancestor] = destination
    basins = np.array([drains[int(p)] for p in plateaus])
    seeds = [c for c in contacts if c.reason in
             (ContactReason.ISLAND, ContactReason.LOW_POINT, ContactReason.CORNER)]
    seeded = set()
    for c in seeds:
        # A sample represents a square cell, not a point. Measure to the cell
        # so grid alignment at a bevel or rim cannot discard a nearby island
        # that should seed a startup patch.
        cell_distance = np.linalg.norm(np.maximum(
            np.abs(centers - c.position[:2]) - pitch / 2, 0), axis=1)
        nearby = (cell_distance <= 2 * pitch) & (
            np.abs(heights-c.position[2]) <= 2 * pitch * math.tan(math.radians(params.patch_slope_deg)))
        # A contact on a discretized saddle can border several basins. Seed
        # each touching basin, rather than letting grid alignment choose one.
        seeded.update(int(b) for b in basins[nearby])
    keep = np.zeros(len(cells), dtype=bool)
    report = []
    for basin in sorted(seeded):
        indices = np.flatnonzero(basins == basin)
        z = heights[indices]
        floor = float(z.min())
        cutoff = max(floor + params.patch_start_rise_mm if params.patch_start_rise_mm > 0
                     else float(np.quantile(z, params.patch_start_fraction)),
                     floor + 3 * params.layer_height)
        broad_flat = np.ptp(z) <= 3 * params.layer_height
        selected = indices if broad_flat else indices[z <= cutoff + 1e-8]
        keep[selected] = True
        report.append(dict(basinId=basin, areaMm2=len(z) * pitch**2,
                           selectedAreaMm2=len(selected) * pitch**2,
                           riseMm=cutoff - floor,
                           selection="height_threshold" if params.patch_start_rise_mm > 0 else "area_fraction",
                           reason="Flat underside retains its full patch" if broad_flat
                           else "Low portion of a seeded underside basin"))
    if flat is not None and np.any(flat):
        from scipy.ndimage import label
        grid = np.zeros(cells.max(axis=0) + 1, dtype=bool)
        grid[cells[:, 0], cells[:, 1]] = flat
        components, count = label(grid)
        for component in range(1, count + 1):
            indices = np.flatnonzero(components[cells[:, 0], cells[:, 1]] == component)
            if len(indices) * pitch**2 < params.contact_spacing**2:
                continue
            keep[indices] = True
            report.append(dict(areaMm2=len(indices) * pitch**2,
                               selectedAreaMm2=len(indices) * pitch**2,
                               reason="Broad low-curvature underside retained"))
    # A heel/bevel can advance above an already established sole. It is not a
    # new basin minimum and need not be flat, but the layer analysis still
    # marks its advancing edge as needing support. Keep a local ribbon around
    # those contacts instead of extending the whole basin up the sculpture.
    # Disabled microledges/microbridges must not grow back into patches here.
    edge_mask = np.zeros(len(cells), dtype=bool)
    reach = max(2 * pitch, .75 * params.edge_spacing)
    for c in contacts:
        if not c.enabled or c.reason not in (
                ContactReason.EDGE, ContactReason.ISLAND, ContactReason.LOW_POINT, ContactReason.CORNER):
            continue
        # A layer-detected island can sit on a curved region which drains to
        # a different, lower minimum. Its own startup must still get a patch.
        distance = np.linalg.norm(np.maximum(np.abs(centers-c.position[:2])-pitch/2, 0), axis=1)
        if c.reason != ContactReason.EDGE and not np.any(
                (distance <= 2 * pitch) & (np.abs(heights-c.position[2]) <= reach)):
            continue
        rise = reach
        if c.reason != ContactReason.EDGE and params.patch_start_rise_mm > 0:
            rise = min(rise, max(3 * params.layer_height, params.patch_start_rise_mm))
        edge_mask |= (distance <= reach) & (heights >= c.position[2]-reach) & (heights <= c.position[2]+rise)
    added = edge_mask & ~keep
    if np.any(added):
        keep |= edge_mask
        report.append(dict(selectedAreaMm2=int(added.sum()) * pitch**2,
                           reason="Local patch around an advancing edge or startup contact"))
    return keep, report


def _broad_surface_tiles(centers, normals, pitch):
    """Broad tilted soles need a roof too, even above their startup corner.

    Retain near-horizontal surfaces and gently changing slopes up to 45 degrees.
    Compare a full neighbouring-cell ring so bevels and small detailed dimples
    do not turn into broad sheets. The caller enforces a connected-area minimum.
    """
    if not len(centers):
        return np.zeros(0, dtype=bool)
    near_horizontal = (normals[:, :, 2] <= -math.cos(math.radians(15))).all(axis=1)
    smooth = (normals[:, :, 2] <= -math.cos(math.radians(45))).all(axis=1)
    central = normals[:, -1]
    cosine = math.cos(math.radians(8))
    smooth &= (np.einsum('ijk,ik->ij', normals, central) >= cosine).all(axis=1)
    cells = np.rint((centers-centers.min(axis=0))/pitch).astype(int)
    lookup = {tuple(cell): i for i, cell in enumerate(cells)}
    for i, (x,y) in enumerate(cells):
        if not smooth[i]: continue
        neighbours = [lookup[(x+dx,y+dy)] for dx in (-1,0,1) for dy in (-1,0,1)
                      if (dx or dy) and (x+dx,y+dy) in lookup]
        if len(neighbours)<3 or np.any(central[neighbours]@central[i] < cosine):
            smooth[i] = False
    return near_horizontal | smooth


def _patch_panels(centers, tops, pitch, params):
    """Select 5 mm cells only for connected footprints larger than the threshold.

    The roof and angular fan both stop at the seam. Existing tree branches may
    still share a lower trunk: these are peel panels, not independent rafts.
    """
    if not len(centers):
        return []
    if not params.patch_grid:
        return [(centers, tops, None)]
    from scipy.ndimage import label
    origin = centers.min(axis=0)
    cells = np.rint((centers-origin)/pitch).astype(int)
    grid = np.zeros(cells.max(axis=0)+1, dtype=bool)
    grid[cells[:,0],cells[:,1]] = True
    components, count = label(grid)
    panels = []
    for component in range(1,count+1):
        selected = components[cells[:,0],cells[:,1]] == component
        xy, z = centers[selected], tops[selected]
        if max(np.ptp(xy,axis=0)+pitch) <= params.patch_grid_threshold:
            panels.append((xy,z,None)); continue
        step = params.patch_grid_pitch
        # Center the grid on the feature, avoiding a seam through its low point.
        zero = (xy.min(axis=0)+xy.max(axis=0))/2-step/2
        ids = np.floor((xy-zero)/step).astype(int)
        gap = max(params.patch_grid_gap,params.line_width)
        for cell in np.unique(ids,axis=0):
            lo = zero+cell*step+gap/2
            hi = zero+(cell+1)*step-gap/2
            keep = ((xy+pitch/2 > lo)&(xy-pitch/2 < hi)).all(axis=1)
            if keep.any():
                panels.append((xy[keep],z[keep],np.r_[lo,hi]))
    return panels


def _patch_grip(tree, node_ids, params, model, keepout, panel):
    """Thicken an attached stem downwards; never start a dangling peg in air.

    Follow the existing branch toward its foundation, tapering into the old
    radius. Short/cramped stems keep their available length or omit the grip.
    """
    from .build import cone_between
    if params.patch_grip_length <= 0:
        return None, None
    for nid in sorted(node_ids,key=lambda i:tree.nodes[i].position[2],reverse=True):
        top = tree.nodes[nid]; node = top; pieces = []; length = 0.; last_segment = None
        while node.parent is not None and length < params.patch_grip_length:
            parent = tree.nodes[node.parent]
            delta = parent.position-node.position
            distance = float(np.linalg.norm(delta))
            if distance < 1e-6: break
            take = min(distance,params.patch_grip_length-length)
            end = node.position+delta*take/distance
            # A grip should not extend into the raft/collar.
            if end[2] < getattr(tree,"z_base",0)+params.collar_height+.2: break
            radius = params.patch_grip_diameter/2
            lower = radius if take+length < params.patch_grip_length-1e-6 else min(radius,parent.radius)
            solid = cone_between(end,node.position,lower,radius,params.circle_segments)
            if solid is not None:
                pieces.append(solid)
                last_segment = (end, node.position, min(radius,parent.radius), radius)
            length += take; node = parent
        if length < 1.5 or not pieces: continue
        # The final segment tapers even when a short branch ends the grip early.
        pieces[-1] = cone_between(*last_segment, params.circle_segments)
        grip = mf.Manifold.batch_boolean(pieces,mf.OpType.Add)
        if (grip^model).volume()>1e-7 or (grip^keepout).volume()>1e-7: continue
        vertices=np.asarray(grip.to_mesh().vert_properties)[:,:3]
        bounds=np.r_[vertices.min(axis=0),vertices.max(axis=0)]
        if panel is not None and (np.any(bounds[:2]<panel[:2]) or np.any(bounds[3:5]>panel[2:])): continue
        # Taper the bottom into the existing stem, including shortened grips.
        return grip,dict(lengthMm=length,diameterMm=params.patch_grip_diameter,
                         attachment="existing_branch",bounds=bounds.tolist())
    return None,None


def _surface_samples(mesh, region, labels, caster, params, low, high):
    """Reuse geometry samples when automatic removal splitting reroutes trees.

    Routing groups, gaps and contact choices do not change these surface rays.
    Trimesh invalidates its cache when vertices/faces change; the settings key
    covers the two parameters that affect this sampling. Keep only small NumPy
    arrays here, never live Boolean solids or model copies.
    """
    settings = (params.line_width, params.patch_slope_deg)
    cached = mesh._cache["arbor_patch_samples"]
    if cached is None or cached[0] != settings:
        cached = (settings, {}, [0])
        mesh._cache["arbor_patch_samples"] = cached
    entries, size = cached[1:]
    if region in entries:
        return entries[region]
    pitch = max(params.line_width*1.15, .25, min(.8, math.sqrt(np.prod(high[:2]-low[:2])/6000)))
    offsets = np.array([[-.5,-.5],[.5,-.5],[.5,.5],[-.5,.5],[0,0]])*pitch
    offsets[:4] += np.sign(offsets[:4])*.002 # include the fan tiles' joining overlap
    counts = np.maximum(1, np.ceil((high[:2] - low[:2]) / pitch).astype(int))
    x, y = [low[a] + (np.arange(counts[a]) + .5) * pitch for a in range(2)]
    xx, yy = np.meshgrid(x, y)
    centers = np.c_[xx.ravel(), yy.ravel()]
    points = (centers[:, None] + offsets[None]).reshape(-1, 2)
    z, face = caster.cast(np.c_[points, np.full(len(points), low[2] - .01)])
    z = z.reshape(-1, 5); face = face.reshape(-1, 5)
    on_surface = (face >= 0) & (labels[np.maximum(face, 0)] == region) & np.isfinite(z)
    # Keep partial cells at a curved rim. Requiring every corner to hit the
    # same underside erodes exactly the advancing edges we need to support.
    # The fan's roof is clipped to the actual surface outline below.
    ok = on_surface.any(axis=1)
    local_z = np.where(on_surface, z, np.nan)
    span = np.max(np.where(on_surface, z, -np.inf), axis=1) - np.min(np.where(on_surface, z, np.inf), axis=1)
    # Reject folds and deep stairs under a steep wall, as in the original fit.
    ok &= span <= pitch * math.tan(math.radians(params.patch_slope_deg)) * 1.5
    centers = centers[ok]
    heights = np.nanmin(local_z[ok], axis=1)
    representative = np.where(on_surface[:, -1], 4, np.argmax(on_surface, axis=1))
    fallback = face[np.arange(len(face)), representative]
    normal_faces = np.where(on_surface[ok], face[ok], fallback[ok, None])
    normals = mesh.face_normals[normal_faces]
    boundary = ~on_surface[ok].all(axis=1)
    result = (pitch, centers, heights, normals, boundary)
    nbytes = sum(a.nbytes for a in result[1:])
    # This is a disposable speed cache, not an input or generation limit.
    if size[0] + nbytes <= 8 * 1024 * 1024:
        entries[region] = result
        size[0] += nbytes
    return result


def _route_patch_anchor(tree, anchor, radius, node_ids, model, keepout, params):
    """Route a local patch feeder, provisionally until it actually carries skin."""
    from .build import cone_between
    possible = []
    for nid in node_ids:
        n = tree.nodes[nid]
        rise = anchor[2]-n.position[2]
        distance = np.linalg.norm(anchor[:2]-n.position[:2])
        if rise > .3 and distance <= rise*math.tan(math.radians(params.branch_angle_deg)):
            possible.append((rise+.2*distance, nid))
    for _, nid in sorted(possible):
        parent = tree.nodes[nid]
        solid = cone_between(parent.position, anchor, max(radius,parent.radius), radius, params.circle_segments)
        if solid is not None and (solid^model).volume()<1e-7 and (solid^keepout).volume()<1e-7:
            child = tree.add(anchor,radius,NodeKind.BRANCH,parent=nid)
            return [child.id]
    base = np.r_[anchor[:2],getattr(tree,'z_base',0)]
    if anchor[2] <= base[2]+params.collar_height+.3:
        return []
    solid = cone_between(base,anchor,radius,radius,params.circle_segments)
    if solid is None or (solid^model).volume()>1e-7 or (solid^keepout).volume()>1e-7:
        return []
    foot = tree.add(base,radius,NodeKind.FOOT)
    child = tree.add(anchor,radius,NodeKind.BRANCH,parent=foot.id)
    return [foot.id,child.id]


def build_patches(mesh, contacts, tree, params, progress=None):
    """Fit a continuous model-derived roof over angular branch fans.

    Tile size controls approximation, not patch size. Each roof tile grows at
    <=45 degrees from a collision-free routed hub; unreachable strips request
    local feeders. Multiple branches may feed one roof. Removal groups remain
    separated through the whole fan.
    """
    from .build import trimesh_to_manifold
    if not params.underside_patches:
        return
    tree.patch_solids = []
    tree.patch_report = []
    tree.patch_contact_keepouts = []
    caster = VerticalCaster(mesh)
    model = trimesh_to_manifold(mesh)
    if model.status() != mf.Error.NoError:
        tree.patch_report.append(dict(status="skipped", reason="Exact model solid unavailable"))
        return
    keepout = model.translate([0, 0, -params.patch_gap])
    collision_windows = _CollisionWindows(model, keepout, len(mesh.faces))
    by_contact = {n.contact_id: n for n in tree.nodes.values() if n.kind == NodeKind.TIP}
    active = [c for c in contacts if c.enabled and c.id in by_contact]
    labels, regions = _surface_regions(mesh, active, caster, params)
    pitch = max(params.line_width * 1.15, .25)
    # Broad patches are supplied by several local branches. Reaching down an
    # entire tall tree makes deep sheets around the model and wastes collision
    # searches. This bounds fan depth by branch sampling, not roof area.
    max_drop = max(2 * params.tip_length, 2 * params.contact_spacing + params.tip_length)
    offsets = np.array([[-.5, -.5], [.5, -.5], [.5, .5], [-.5, .5], [0, 0]]) * pitch
    split = params.removal_groups and hasattr(tree, "contact_groups")
    # Existing branch nodes, including ancestors, allow a wide roof to be fed by
    # several nearby trunks instead of forcing it through one short tip cone.
    for ri, (region, cs) in enumerate(regions.items()):
        if progress is not None:
            progress.update(ri / max(1, len(regions)), f"Fitting underside patch {ri + 1}/{len(regions)}")
        vertices = mesh.vertices[mesh.faces[labels == region]].reshape(-1, 3)
        low, high = vertices.min(axis=0), vertices.max(axis=0)
        region_faces = np.flatnonzero(labels == region)
        skin_surface = _extrude_downward_surface(mesh, region_faces, params.patch_roof_thickness)
        gap_surface = _extrude_downward_surface(mesh, region_faces, params.patch_gap)
        if skin_surface.status() != mf.Error.NoError or gap_surface.status() != mf.Error.NoError:
            tree.patch_report.append(dict(status="skipped", reason="Underside surface could not form a closed skin"))
            continue
        underside_skin = skin_surface.translate([0, 0, -params.patch_gap])
        # Preserve other material after clipping to the selected footprint below;
        # constructing clearance for an entire unselected underside wastes work.
        lower_clearance = model.translate([0, 0, params.z_gap])
        # Reuse the exact same samples when automatic cage splitting causes
        # a second fit. The model-derived contact skin is unchanged.
        pitch, centers, heights, normals, boundary = _surface_samples(
            mesh, region, labels, caster, params, low, high)
        boundary_cells = {tuple(xy) for xy in centers[boundary]}
        outline_prism = None
        fan_inset = .01
        tops = heights - params.patch_gap - fan_inset
        basin_report = []
        full_candidate_area = len(centers) * pitch**2
        if params.patch_mode == "startup":
            flat = _broad_surface_tiles(centers, normals, pitch)
            selected, basin_report = _startup_patch_mask(
                centers, tops + params.patch_gap + fan_inset, pitch, cs, params, flat=flat)
            centers, tops = centers[selected], tops[selected]
        sides = [-1, 1] if split else [0]
        panels = _patch_panels(centers, tops, pitch, params)
        jobs = [(side, panel) for side in sides for panel in panels]
        for side_index, (side, (centers, tops, panel_bounds)) in enumerate(jobs):
            members = [c for c in cs if not split or tree.contact_groups[c.id] == side]
            if not members:
                continue
            node_ids = set()
            for c in members:
                node = tree.nodes[by_contact[c.id].parent] if by_contact[c.id].parent is not None else None
                while node is not None:
                    # A low fan can meet a foot, but its hub starts above the
                    # collar. Never extend a roof as a full-height vertical wall.
                    node_ids.add(node.id)
                    node = tree.nodes[node.parent] if node.parent is not None else None
            panel_pillar = None
            # A panel's route is provisional until its fan and skin both fit.
            # Rejected panels must not leave a bare post or diagonal behind.
            panel_nodes = []
            if panel_bounds is not None:
                from .build import cone_between
                radius = max(params.branch_min_diameter/2,.45)
                # Border panels can contain only a narrow curved strip. Put
                # their pillar beneath that strip, not beneath the empty
                # middle of the grid square.
                xy = np.clip(centers.mean(axis=0), panel_bounds[:2]+radius+.002,
                             panel_bounds[2:]-radius-.002)
                reach = np.max(np.linalg.norm(centers-xy,axis=1))+pitch/math.sqrt(2)
                anchor = np.r_[xy, float(tops.min())-params.patch_roof_thickness-max(.3,reach-radius)-.05]
                possible = []
                for nid in node_ids:
                    n = tree.nodes[nid]
                    rise = anchor[2]-n.position[2]
                    distance = np.linalg.norm(anchor[:2]-n.position[:2])
                    if rise > .3 and distance <= rise*math.tan(math.radians(params.branch_angle_deg)):
                        possible.append((rise+.2*distance,nid))
                for _,nid in sorted(possible):
                    parent = tree.nodes[nid]
                    solid = cone_between(parent.position,anchor,max(radius,parent.radius),radius,params.circle_segments)
                    if solid is None or (solid^model).volume()>1e-7 or (solid^keepout).volume()>1e-7:
                        continue
                    child = tree.add(anchor,radius,NodeKind.BRANCH,parent=nid)
                    panel_nodes.append(child.id)
                    node_ids.add(child.id)
                    panel_pillar = dict(nodeId=child.id,parentNodeId=nid)
                    break
                if panel_pillar is None and anchor[2] > getattr(tree,"z_base",0)+params.collar_height+.3:
                    base = np.r_[xy,getattr(tree,"z_base",0)]
                    solid = cone_between(base,anchor,max(radius,params.branch_min_diameter/2),radius,params.circle_segments)
                    if solid is not None and (solid^model).volume()<1e-7 and (solid^keepout).volume()<1e-7:
                        foot = tree.add(base,max(radius,params.branch_min_diameter/2),NodeKind.FOOT)
                        child = tree.add(anchor,radius,NodeKind.BRANCH,parent=foot.id)
                        panel_nodes.extend([foot.id, child.id])
                        node_ids.add(child.id)
                        panel_pillar = dict(nodeId=child.id,parentNodeId=foot.id)
                if panel_pillar is None:
                    tree.patch_report.append(dict(status="skipped",reason="Grid panel needs clearance for its own pillar",
                                                  panelBounds=panel_bounds.tolist()))
                    continue
            local_feeders = []
            if panel_bounds is None and len(centers):
                # Plan a feeder for selected roof cells beyond the existing
                # trees' printable reach. A sole's far rim should not disappear
                # merely because its point contacts routed toward the ankle.
                anchors = [tree.nodes[n] for n in node_ids if tree.nodes[n].kind not in (NodeKind.FOOT,NodeKind.MODEL_FOOT)]
                unreachable = np.ones(len(centers),dtype=bool)
                for n in anchors:
                    distance = np.linalg.norm(centers-n.position[:2],axis=1)+pitch/math.sqrt(2)
                    rise = tops-params.patch_roof_thickness-n.position[2]
                    unreachable &= ~((np.maximum(.12,distance-min(n.radius,.6))<=rise)&(rise<=max_drop))
                if split:
                    unreachable &= side*(centers[:,tree.removal_axis]-tree.removal_center) >= params.raft_split_gap/2+pitch/2
                missing = np.flatnonzero(unreachable)
                if len(missing):
                    feeder_parents = set(node_ids)
                    groups = np.floor((centers[missing]-centers.min(axis=0))/max(2,params.contact_spacing)).astype(int)
                    for group in np.unique(groups,axis=0):
                        indices = missing[(groups==group).all(axis=1)]
                        if len(indices)<4:
                            continue
                        xy = centers[indices].mean(axis=0)
                        radius = max(params.branch_min_diameter/2,.45)
                        reach = np.max(np.linalg.norm(centers[indices]-xy,axis=1))+pitch/math.sqrt(2)
                        anchor = np.r_[xy,float(tops[indices].min())-params.patch_roof_thickness-max(.3,reach-radius)-.1]
                        if split and side*(xy[tree.removal_axis]-tree.removal_center)<params.raft_split_gap/2+radius:
                            continue
                        added = _route_patch_anchor(tree,anchor,radius,feeder_parents,model,keepout,params)
                        if added:
                            local_feeders.append(added)
                            panel_nodes.extend(added)
                            node_ids.add(added[-1])
            hubs = []
            hub_nodes = []
            for nid in sorted(node_ids):
                n = tree.nodes[nid]
                anchor = n.position.copy()
                if n.kind in (NodeKind.FOOT, NodeKind.MODEL_FOOT):
                    continue
                radius = min(n.radius, .6)
                if panel_bounds is not None and (np.any(anchor[:2]-radius < panel_bounds[:2])
                                                or np.any(anchor[:2]+radius > panel_bounds[2:])):
                    continue
                solid = mf.Manifold.cylinder(.16, radius, radius, 16).translate(anchor - [0, 0, .08])
                hubs.append((anchor, radius, solid))
                hub_nodes.append(nid)
            tiles, accepted_xy, used_hubs = [], [], set()
            # Evaluate nearby hubs in NumPy instead of a Python norm/call for
            # every tile/hub pair. Keep the same costs, ordering and exact solid
            # collision checks below; only candidate lookup changes.
            hub_positions = np.array([h[0] for h in hubs]).reshape(-1, 3)
            hub_radii = np.array([h[1] for h in hubs])
            for ti, (xy, top) in enumerate(zip(centers, tops)):
                if progress is not None and ti % 64 == 0:
                    done = (side_index + ti / max(1, len(centers))) / max(1,len(jobs))
                    progress.update((ri + done) / max(1, len(regions)),
                                    f"Fitting underside patch {ri + 1}/{len(regions)}")
                if split and side * (xy[tree.removal_axis] - tree.removal_center) < params.raft_split_gap / 2 + pitch / 2:
                    continue
                roof = None
                # Try the highest nearby feasible anchor first: broad interfaces
                # stay local and leave open space below for removal.
                distances = np.linalg.norm(xy - hub_positions[:, :2], axis=1) + pitch / math.sqrt(2)
                rises = top - params.patch_roof_thickness - hub_positions[:, 2]
                candidates = np.flatnonzero((np.maximum(.12, distances - hub_radii) <= rises) & (rises <= max_drop))
                order = np.argsort((rises + .15 * distances)[candidates], kind='stable')
                for hi in candidates[order]:
                    anchor, radius, hub = hubs[hi]
                    # A ray through the interior of this convex fan is a cheap
                    # exact rejection before building/intersecting its solid.
                    # It only rejects; accepted fans still pass both Booleans.
                    roof_center = [xy[0], xy[1], top - params.patch_roof_thickness / 2]
                    if model.ray_cast(anchor, roof_center) or keepout.ray_cast(anchor, roof_center):
                        continue
                    rays = [anchor + [radius * dx, radius * dy, 0]
                            for dx, dy in ((.8, 0), (-.8, 0), (0, .8), (0, -.8))]
                    if any(model.ray_cast(start, roof_center) or keepout.ray_cast(start, roof_center)
                           for start in rays):
                        continue
                    if roof is None:
                        roof = mf.Manifold.cube([pitch + .004, pitch + .004, params.patch_roof_thickness]).translate(
                            [xy[0] - pitch / 2 - .002, xy[1] - pitch / 2 - .002, top - params.patch_roof_thickness])
                        if tuple(xy) in boundary_cells:
                            if outline_prism is None:
                                outline_prism = mf.Manifold.extrude(
                                    skin_surface.project(), high[2]-low[2]+max_drop+2
                                ).translate([0, 0, low[2]-max_drop-1])
                            roof = roof ^ outline_prism
                            if roof.is_empty():
                                break
                    if panel_bounds is not None:
                        # Clip the actual surface/fan at the seam rather than
                        # discarding entire sampling cells along the border.
                        for axis in (0,1):
                            normal=np.zeros(3);normal[axis]=1
                            roof=roof.trim_by_plane(normal,panel_bounds[axis])
                            roof=roof.trim_by_plane(-normal,-panel_bounds[axis+2])
                        if roof.is_empty(): continue
                    fan = mf.Manifold.batch_hull([hub, roof])
                    if tuple(xy) in boundary_cells:
                        # Hulls are convex: even a clipped roof can pull a
                        # sliver of its upper fan across a hole or outside a
                        # curved rim. Keep the interface band inside the exact
                        # outline while allowing the lower fan to reach its hub.
                        fan_low = np.minimum(xy-pitch/2-.01, anchor[:2]-radius-.01)
                        fan_high = np.maximum(xy+pitch/2+.01, anchor[:2]+radius+.01)
                        band = mf.Manifold.cube(np.r_[fan_high-fan_low,
                            params.patch_roof_thickness+.02]).translate(
                                np.r_[fan_low,top-params.patch_roof_thickness])
                        fan = fan - (band - outline_prism)
                    if split:
                        normal = np.zeros(3); normal[tree.removal_axis] = side
                        seam = side * tree.removal_center + params.raft_split_gap / 2
                        # Most fans lie wholly on their own side. A convex hull
                        # of two shapes inside the half-space cannot cross it.
                        if min(side*anchor[tree.removal_axis]-radius,
                               side*xy[tree.removal_axis]-pitch/2-.002) < seam:
                            fan = fan.trim_by_plane(normal, seam)
                            if fan.is_empty() or (fan ^ hub).volume() < 1e-6:
                                continue
                    roof_low = np.r_[xy-pitch/2-.002, top-params.patch_roof_thickness]
                    roof_high = np.r_[xy+pitch/2+.002, top]
                    local_model, local_keepout = collision_windows.at(
                        np.minimum(anchor-[radius,radius,.08], roof_low),
                        np.maximum(anchor+[radius,radius,.08], roof_high))
                    if (fan ^ local_keepout).volume() > 1e-7 or (fan ^ local_model).volume() > 1e-7:
                        continue
                    tiles.append(fan); accepted_xy.append(xy); used_hubs.add(hi)
                    break
            if len(tiles) < 4:
                for nid in reversed(panel_nodes):
                    del tree.nodes[nid]
                tree.patch_report.append(dict(contactId=members[0].id, status="skipped",
                                              reason="Insufficient reachable underside area"))
                continue
            crown = mf.Manifold.batch_boolean(tiles, mf.OpType.Add)
            contours = [xy + np.array([[-1, -1], [1, -1], [1, 1], [-1, 1]])
                        * (pitch / 2 + .002) for xy in accepted_xy]
            footprint = mf.CrossSection(contours, mf.FillRule.Positive)
            bottom = low[2] - params.patch_gap - params.patch_roof_thickness - .01
            ceiling = high[2] - params.patch_gap + .01
            prism = mf.Manifold.extrude(footprint, ceiling - bottom).translate([0, 0, bottom])
            if panel_bounds is not None:
                for axis in (0,1):
                    normal=np.zeros(3);normal[axis]=1
                    prism=prism.trim_by_plane(normal,panel_bounds[axis])
                    prism=prism.trim_by_plane(-normal,-panel_bounds[axis+2])
            skin = (underside_skin ^ prism) - model - lower_clearance
            if split:
                normal = np.zeros(3); normal[tree.removal_axis] = side
                skin = skin.trim_by_plane(normal, side * tree.removal_center + params.raft_split_gap / 2)
            attached, rejected_skin = [], []
            for piece in skin.decompose():
                volume = piece.volume()
                if volume <= 1e-6:
                    continue
                # A column can also see another underside farther above. Only
                # retain skin connected to this patch's routed branch fans.
                if (piece ^ crown).volume() <= 1e-6:
                    rejected_skin.append(dict(volumeMm3=volume, reason="No branch-fan attachment"))
                elif (piece ^ model).volume() > 1e-7:
                    rejected_skin.append(dict(volumeMm3=volume, reason="Model collision"))
                else:
                    attached.append(piece)
            if not attached:
                for nid in reversed(panel_nodes):
                    del tree.nodes[nid]
                tree.patch_report.append(dict(contactId=members[0].id, status="skipped",
                                              reason="No collision-free conformal skin could attach",
                                              rejectedSkin=rejected_skin))
                continue
            if attached:
                attached_skin = mf.Manifold.batch_boolean(attached, mf.OpType.Add)
                crown = crown + attached_skin
                # Point tips beneath a patch must not protrude through its
                # contact skin at the smaller ordinary-tip gap.
                contact_prism = mf.Manifold.extrude(
                    footprint, ceiling - bottom + max(params.tip_base_diameter, params.tip_diameter)
                ).translate([0, 0, bottom])
                # The swept surface fills the entire gap even beside thin
                # walls, where a translated model volume alone leaves holes.
                # Clip each solid before unioning it: distant sculpture detail
                # cannot affect this contact footprint (intersection distributes
                # over union), and otherwise makes this union needlessly huge.
                clip = (keepout ^ contact_prism) + (gap_surface ^ contact_prism)
                if split:
                    clip = clip.trim_by_plane(normal, side * tree.removal_center + params.raft_split_gap / 2)
                tree.patch_contact_keepouts.append(clip)
            pieces = crown.decompose()
            scraps = [p.volume() for p in pieces if p.volume() <= 1e-6]
            if scraps:
                crown = mf.Manifold.batch_boolean([p for p in pieces if p.volume() > 1e-6], mf.OpType.Add)
            if panel_pillar is not None and panel_pillar["nodeId"] not in {hub_nodes[i] for i in used_hubs}:
                # An existing branch can win every tile. Do not leave the
                # provisional alternative pillar standing with an empty top.
                for nid in reversed(panel_nodes):
                    del tree.nodes[nid]
                panel_pillar = None
            for feeder in local_feeders:
                if feeder[-1] not in {hub_nodes[i] for i in used_hubs}:
                    for nid in reversed(feeder):
                        del tree.nodes[nid]
            grip, grip_report = _patch_grip(tree,[hub_nodes[i] for i in used_hubs],params,
                                             model,keepout,panel_bounds)
            if grip is not None:
                crown = crown + grip
            tree.patch_solids.append(crown)
            verts = np.asarray(crown.to_mesh().vert_properties)[:, :3]
            anchors = [hubs[hi][0].tolist() for hi in sorted(used_hubs)]
            tree.patch_report.append(dict(contactId=members[0].id, contactIds=[c.id for c in members],
                status="built", sizing=("startup_basins" if params.patch_mode == "startup"
                                        else "connected_model_underside"),
                startupBasins=basin_report, fullRegionCandidateAreaMm2=full_candidate_area,
                surface="conformal_negative",
                panelBounds=None if panel_bounds is None else panel_bounds.tolist(),
                gridPitchMm=params.patch_grid_pitch if panel_bounds is not None else None,
                grip=grip_report, panelPillar=panel_pillar,
                localFeederNodeIds=[ids[-1] for ids in local_feeders if ids[-1] in tree.nodes],
                conformalSkinComponents=len(attached),
                rejectedSkin=rejected_skin,
                regionId=region, removalSide=side,
                tiles=len(tiles), projectedAreaMm2=float(attached_skin.project().area()),
                removedNumericalVolumesMm3=scraps,
                candidateAreaMm2=len(centers) * pitch ** 2, gap=params.patch_gap,
                anchor=anchors[0], anchors=anchors,
                bounds=np.r_[verts.min(axis=0), verts.max(axis=0)].tolist(),
                roofBounds=np.r_[np.min(accepted_xy, axis=0)-pitch/2,
                                  np.max(accepted_xy, axis=0)+pitch/2].tolist()))
