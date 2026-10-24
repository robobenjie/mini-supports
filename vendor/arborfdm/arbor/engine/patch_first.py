"""Plan conformal patch roofs before routing their shared support trees.

Each accepted roof has a printable fan and an explicit support terminal. The
router sees these demands alongside the original model contacts. Failed patch
routes never leave floating roofs, and ordinary contacts remain as fallback.
"""
from __future__ import annotations

from dataclasses import dataclass, field, replace
import math
import time

import manifold3d as mf
import numpy as np

from . import patches as surfaces
from .build import cone_between, trimesh_to_manifold
from .contacts import VerticalCaster
from .params import support_base_z
from .tree import printable_angle_deg
from .types import Contact, ContactReason, NodeKind, Progress


def _union(solids):
    return mf.Manifold.batch_boolean(solids, mf.OpType.Add) if solids else mf.Manifold()


def _clip_panel(solid, bounds, lower=None, upper=None):
    if bounds is not None:
        for axis in (0, 1):
            normal = np.zeros(3)
            normal[axis] = 1
            if lower is None or lower[axis] < bounds[axis] + 1e-5:
                solid = solid.trim_by_plane(normal, bounds[axis])
            if upper is None or upper[axis] > bounds[axis + 2] - 1e-5:
                solid = solid.trim_by_plane(-normal, -bounds[axis + 2])
    return solid


@dataclass
class PlannedPatch:
    terminal: Contact
    solid: object
    roof: object
    gap: object
    region: int
    report: dict


@dataclass
class PatchPlan:
    patches: list[PlannedPatch]
    context: object
    report: dict
    split: bool
    contacts: list[Contact] = field(default_factory=list)


@dataclass
class _Context:
    mesh: object
    model: object
    keepout: object
    windows: object
    caster: object
    labels: np.ndarray
    regions: dict
    axis: int
    center: float
    prepared: dict = field(default_factory=dict)


def _close_patch_notches(centers, selected, pitch):
    """Join short notches inside an already selected underside.

    A coarse startup mask can alternate between roof and pins on one rounded
    heel. Close only short gaps between existing roof cells, then intersect
    with the original sampled surface: no outward dilation or hole bridging
    through missing sculpture is allowed. Intentional removal seams are cut
    later, after this model-derived footprint is chosen.
    """
    if not len(centers) or not np.any(selected):
        return selected.copy()
    from scipy.ndimage import binary_closing
    radius = max(1, int(round(.75 / pitch)))
    cells = np.rint((centers - centers.min(axis=0)) / pitch).astype(int) + radius
    grid = np.zeros(cells.max(axis=0) + radius + 1, dtype=bool)
    grid[cells[:, 0], cells[:, 1]] = selected
    closed = binary_closing(grid, iterations=radius)
    return selected | closed[cells[:, 0], cells[:, 1]]


def _prepare_surface(context, region, params):
    """Reuse samples and exact negative geometry when cage routing changes."""
    if region in context.prepared:
        return context.prepared[region]
    mesh = context.mesh
    faces = np.flatnonzero(context.labels == region)
    vertices = mesh.vertices[mesh.faces[faces]].reshape(-1, 3)
    low, high = vertices.min(axis=0), vertices.max(axis=0)
    pitch, centers, heights, normals, boundary = surfaces._surface_samples(
        mesh, region, context.labels, context.caster, params, low, high)
    boundary_cells = {tuple(q) for q in centers[boundary]}
    candidate_area = len(centers) * pitch**2
    basin_report = []
    if params.patch_mode == "startup":
        selected, basin_report = surfaces._startup_patch_mask(
            centers, heights, pitch, context.regions[region], params,
            flat=surfaces._broad_surface_tiles(centers, normals, pitch))
        closed = _close_patch_notches(centers, selected, pitch)
        added = int(np.count_nonzero(closed & ~selected))
        if added:
            basin_report.append(dict(selectedAreaMm2=added * pitch**2,
                                     reason="Closed short notches within the selected underside"))
        selected = closed
        centers, heights = centers[selected], heights[selected]
    raw_skin = surfaces._extrude_downward_surface(mesh, faces, params.patch_roof_thickness)
    raw_gap = surfaces._extrude_downward_surface(mesh, faces, params.patch_gap)
    if (not len(centers) or raw_skin.status() != mf.Error.NoError
            or raw_gap.status() != mf.Error.NoError):
        context.prepared[region] = None
        return None
    # Difference distributes over the later footprint clips. Calculate the
    # exact negative once per surface instead of once per attachment terminal.
    skin = (raw_skin.translate([0, 0, -params.patch_gap]) - context.model
            - context.model.translate([0, 0, params.z_gap]))
    floor = low[2] - max(7., 3 * params.contact_spacing)
    outline = mf.Manifold.extrude(raw_skin.project(), high[2] - floor + 1).translate([0, 0, floor])
    prepared = dict(pitch=pitch, centers=centers, heights=heights, boundary=boundary_cells,
                    candidate_area=candidate_area, basin_report=basin_report, raw_gap=raw_gap,
                    skin=skin, outline=outline, floor=floor, high=high)
    context.prepared[region] = prepared
    return prepared


def _reusable_regions(previous, params):
    """Only crowns completely outside the requested seam can keep their fan."""
    context = previous.context
    safe = set(context.regions)
    have = set()
    half_gap = params.raft_split_gap / 2
    for patch in previous.patches:
        have.add(patch.region)
        bounds = patch.report["bounds"]
        lo = bounds[context.axis] - context.center
        hi = bounds[context.axis + 3] - context.center
        if not (hi <= -half_gap or lo >= half_gap):
            safe.discard(patch.region)
    # Regions without a fitted crown may become feasible after partitioning.
    return safe & have


def _attachment(context, gxy, gz, panel, side, pitch, params, slope):
    """Prefer a full grip, then a narrow grip, then an ordinary feeder.

    Removal handles must not make an otherwise supportable narrow heel or
    cavity lose its roof. Every fallback retains the same exact clearance and
    printable taper checks; it only changes the local support below the skin.
    """
    base_z = support_base_z(params)
    bare_radius = max(params.branch_min_diameter / 2, 2 * params.line_width)
    options = [(params.patch_grip_diameter / 2, True)] if params.patch_release else []
    if params.patch_release:
        narrow = max(bare_radius, 2.5 * params.line_width)
        if narrow < options[0][0] - 1e-6:
            options.append((narrow, True))
    options.append((bare_radius, False))
    for option, (radius, release) in enumerate(options):
        hub_xy = (gxy.min(axis=0) + gxy.max(axis=0)) / 2
        if panel is not None:
            hub_xy = np.clip(hub_xy, panel[:2] + radius + .01, panel[2:] - radius - .01)
        if side:
            hub_xy[context.axis] = context.center + side * max(
                side * (hub_xy[context.axis] - context.center), params.raft_split_gap / 2 + radius + .03)
        reach = np.linalg.norm(gxy - hub_xy, axis=1).max() + pitch / math.sqrt(2)
        hub_z = float(gz.min()) - params.patch_gap - params.patch_roof_thickness \
            - max(.25, (reach - radius) / slope) - .03
        neck_radius = max(params.line_width, .24) if release else radius
        taper = max(.2, (radius - neck_radius) / slope)
        grip_length = (min(params.patch_release_grip_length,
                           hub_z - base_z - max(params.tip_length + .1, 3 * params.layer_height))
                       if release else 0.)
        if release and grip_length < taper + .1:
            continue
        if hub_z < base_z + max(.25, 2 * params.layer_height):
            continue
        neck = np.r_[hub_xy, hub_z - grip_length]
        hub = mf.Manifold.cylinder(.16, radius, radius, 16).translate([*hub_xy, hub_z - .08])
        grip = None
        if release:
            shoulder = neck + [0, 0, taper]
            grip = _union([
                cone_between(neck - [0, 0, params.layer_height], shoulder,
                             neck_radius, radius, params.circle_segments),
                cone_between(shoulder, np.r_[hub_xy, hub_z + .08], radius, radius, params.circle_segments)])
        checked = grip if grip is not None else hub
        local_model, local_keepout = context.windows.at(
            np.r_[hub_xy - radius, neck[2] - params.layer_height], np.r_[hub_xy + radius, hub_z + .08])
        if (checked ^ local_model).volume() > 1e-7 or (checked ^ local_keepout).volume() > 1e-7:
            continue
        return dict(hub_xy=hub_xy, hub_z=hub_z, radius=radius, neck=neck, neck_radius=neck_radius,
                    hub=hub, grip=grip, grip_length=grip_length, fallback=option > 0)
    return None


def plan_patches(mesh, contacts, params, progress=None, previous=None):
    """Return exact roofs and terminals without depending on an existing tree.

    ``previous`` is an unsplit plan for this same mesh and these same patch
    settings. Automatic cage removal reuses wholly unaffected regions, then
    rebuilds only regions crossing its seam from their cached negative skins.
    """
    progress = progress or Progress()
    start = time.perf_counter()
    active = [c for c in contacts if c.enabled and not c.support_terminal]
    if previous is not None:
        if previous.context.mesh is not mesh:
            raise ValueError("A patch plan can only be reused for its original mesh")
        context = previous.context
    else:
        model = trimesh_to_manifold(mesh)
        keepout = model.translate([0, 0, -params.patch_gap])
        caster = VerticalCaster(mesh)
        labels, regions = surfaces._surface_regions(mesh, active, caster, params)
        axis = surfaces.patch_removal_axis(mesh, active, params)
        context = _Context(mesh, model, keepout,
                           surfaces._CollisionWindows(model, keepout, len(mesh.faces)),
                           caster, labels, regions, axis, float(mesh.bounds.mean(axis=0)[axis]))
    if context.model.status() != mf.Error.NoError:
        return PatchPlan([], context, dict(seconds=time.perf_counter() - start,
                         reason="Exact model solid unavailable", terminals=0), params.removal_groups, active)
    axis, center = context.axis, context.center
    reusable = (_reusable_regions(previous, params)
                if previous is not None and params.removal_groups and not previous.split else set())
    planned = []
    if reusable:
        for patch in previous.patches:
            if patch.region not in reusable:
                continue
            side = -1 if patch.terminal.position[axis] < center else 1
            planned.append(replace(patch, report={**patch.report, "removalSide": side}))
    counts = dict(tileAttempts=0, rejectedCollision=0, rejectedTooLow=0, rejectedSmall=0,
                  selectedTiles=0, acceptedTiles=0, reusedRegions=len(reusable), reusedPatches=len(planned),
                  attachmentFallbacks=0)
    selected_area = 0.
    slope = math.tan(math.radians(min(45., printable_angle_deg(params))))
    slope = max(slope, .05)
    for ri, (region, members) in enumerate(context.regions.items()):
        progress.update(ri / max(1, len(context.regions)),
                        f"Planning underside patch {ri + 1}/{len(context.regions)}")
        data = _prepare_surface(context, region, params)
        if data is None:
            continue
        pitch, centers, heights = data["pitch"], data["centers"], data["heights"]
        selected_area += len(centers) * pitch**2
        counts["selectedTiles"] += len(centers)
        if region in reusable:
            continue
        panels = surfaces._patch_panels(centers, heights, pitch, params)
        for pxy, pz, panel in panels:
            for side in (-1, 1) if params.removal_groups else (0,):
                own = np.ones(len(pxy), dtype=bool)
                if side:
                    own &= side * (pxy[:, axis] - center) >= params.raft_split_gap / 2 + pitch / 2
                xy, z = pxy[own], pz[own]
                if len(xy) < 4:
                    continue
                # This bounds local fan reach, not the continuous skin's size.
                # Neighbouring attachment cells share their skin except at the
                # explicit peel-panel or cage-removal seams.
                cluster_pitch = max(4 * pitch, params.patch_release_width)
                groups = np.floor((xy - xy.min(axis=0)) / cluster_pitch).astype(int)
                for group in np.unique(groups, axis=0):
                    progress.check()
                    selected = (groups == group).all(axis=1)
                    gxy, gz = xy[selected], z[selected]
                    if len(gxy) < 4:
                        counts["rejectedSmall"] += len(gxy)
                        continue
                    attachment = _attachment(context, gxy, gz, panel, side, pitch, params, slope)
                    if attachment is None:
                        counts["rejectedCollision"] += len(gxy)
                        continue
                    counts["attachmentFallbacks"] += int(attachment["fallback"])
                    hub_xy, hub_z, radius = (attachment[k] for k in ("hub_xy", "hub_z", "radius"))
                    neck, neck_radius = (attachment[k] for k in ("neck", "neck_radius"))
                    hub, grip, grip_length = (attachment[k] for k in ("hub", "grip", "grip_length"))
                    tiles, accepted = [], []
                    origin = gxy.min(axis=0)
                    cells = np.rint((gxy - origin) / pitch).astype(int)
                    pending = {tuple(cell): i for i, cell in enumerate(cells)}
                    counts["tileAttempts"] += len(gxy)

                    def try_block(indices):
                        # A hull over several complete interior cells contains
                        # their individual fans. Keep the same precise skin;
                        # reject any added bulk that reaches the model gap.
                        progress.check()
                        qs, zs = gxy[indices], gz[indices]
                        boundary = len(indices) == 1 and tuple(qs[0]) in data["boundary"]
                        roofs = []
                        for q, height in zip(qs, zs):
                            top = float(height) - params.patch_gap - .01
                            roof = mf.Manifold.cube([pitch + .004, pitch + .004, params.patch_roof_thickness]).translate(
                                [q[0] - pitch / 2 - .002, q[1] - pitch / 2 - .002, top - params.patch_roof_thickness])
                            if boundary:
                                roof = roof ^ data["outline"]
                            roof = _clip_panel(roof, panel, q - pitch / 2 - .002, q + pitch / 2 + .002)
                            if roof.is_empty():
                                return False
                            roofs.append(roof)
                        top = float(zs.max()) - params.patch_gap - .01
                        fan = mf.Manifold.batch_hull([hub, *roofs])
                        lo = np.minimum(qs.min(axis=0) - pitch / 2 - .01, hub_xy - radius - .01)
                        hi = np.maximum(qs.max(axis=0) + pitch / 2 + .01, hub_xy + radius + .01)
                        if boundary:
                            band = mf.Manifold.cube(np.r_[hi - lo, params.patch_roof_thickness + .02]).translate(
                                np.r_[lo, top - params.patch_roof_thickness])
                            fan = fan - (band - data["outline"])
                        fan = _clip_panel(fan, panel, lo, hi)
                        if side:
                            normal = np.zeros(3)
                            normal[axis] = side
                            near = lo[axis] if side > 0 else -hi[axis]
                            if near < side * center + params.raft_split_gap / 2 + 1e-5:
                                fan = fan.trim_by_plane(normal, side * center + params.raft_split_gap / 2)
                        hub_inside = (panel is None or (np.all(hub_xy - radius > panel[:2] + 1e-5)
                                      and np.all(hub_xy + radius < panel[2:] - 1e-5)))
                        hub_inside &= not side or side * (hub_xy[axis] - center) - radius > params.raft_split_gap / 2 + 1e-5
                        hub_inside &= not boundary or hub_z + .08 < top - params.patch_roof_thickness - 1e-5
                        if not hub_inside and (fan ^ hub).volume() < 1e-7:
                            return False
                        local_model, local_keepout = context.windows.at(np.r_[lo, hub_z - .08], np.r_[hi, top + .02])
                        if (fan ^ local_model).volume() > 1e-7 or (fan ^ local_keepout).volume() > 1e-7:
                            return False
                        tiles.append(fan)
                        accepted.extend(qs)
                        return True

                    def fit_block(keys):
                        indices = [pending[key] for key in keys]
                        if try_block(indices):
                            return
                        if len(keys) == 1:
                            counts["rejectedCollision"] += 1
                            return
                        # Curvature or an intervening detail can obstruct a
                        # broad hull. Subdivide down to the original one-cell
                        # construction, with the same collision threshold.
                        bounds = np.array(keys)
                        middle = (bounds.min(axis=0) + bounds.max(axis=0)) / 2
                        for sx in (False, True):
                            for sy in (False, True):
                                part = [key for key in keys if (key[0] > middle[0]) == sx and (key[1] > middle[1]) == sy]
                                if part:
                                    fit_block(part)

                    while pending:
                        key = next(iter(pending))
                        block = [key]
                        # Only complete rectangles: do not fill missing cells,
                        # holes, the model's rim, or a removal-panel seam.
                        for nx, ny in ((4, 4), (4, 2), (2, 4), (2, 2), (4, 1), (1, 4), (2, 1), (1, 2)):
                            keys = [(key[0] + x, key[1] + y) for x in range(nx) for y in range(ny)]
                            if all(k in pending and tuple(gxy[pending[k]]) not in data["boundary"] for k in keys):
                                block = keys
                                break
                        fit_block(block)
                        for key in block:
                            del pending[key]
                    if len(accepted) < 4:
                        counts["rejectedSmall"] += len(accepted)
                        continue
                    # Drop construction IDs and redundant coplanar edges once
                    # this local fan is complete, without smoothing its shape.
                    fan = _union(tiles).as_original()
                    if grip is not None:
                        fan = fan + grip
                    contours = [q + np.array([[-1, -1], [1, -1], [1, 1], [-1, 1]]) * (pitch / 2 + .002)
                                for q in accepted]
                    footprint = mf.CrossSection(contours, mf.FillRule.Positive)
                    prism = _clip_panel(mf.Manifold.extrude(footprint, data["high"][2] - data["floor"] + 1)
                                        .translate([0, 0, data["floor"]]), panel)
                    if side:
                        normal = np.eye(3)[axis] * side
                        prism = prism.trim_by_plane(normal, side * center + params.raft_split_gap / 2)
                    roof = data["skin"] ^ prism
                    roof = _union([piece for piece in roof.decompose()
                                   if piece.volume() > 1e-6 and (piece ^ fan).volume() > 1e-6])
                    if roof.is_empty():
                        continue
                    solid = (fan + roof).as_original()
                    terminal = Contact(-1, neck, np.array([0., 0., -1.]), ContactReason.SURFACE,
                                       tip_diameter=2 * neck_radius, support_terminal=True,
                                       note="Routing terminal beneath an underside patch")
                    gap = (data["raw_gap"] ^ prism) + (context.keepout ^ prism)
                    bounds = list(solid.bounding_box())
                    report = dict(status="planned", contactId=members[0].id,
                        contactIds=[c.id for c in members], regionId=region, removalSide=side,
                        surface="conformal_negative", sizing="planned_before_routing",
                        startupBasins=data["basin_report"], fullRegionCandidateAreaMm2=data["candidate_area"],
                        candidateAreaMm2=len(gxy) * pitch**2, projectedAreaMm2=float(roof.project().area()),
                        gap=params.patch_gap, anchor=neck.tolist(), anchors=[neck.tolist()], bounds=bounds,
                        roofBounds=np.r_[np.min(accepted, axis=0) - pitch / 2,
                                         np.max(accepted, axis=0) + pitch / 2].tolist(),
                        panelBounds=None if panel is None else panel.tolist(), tiles=len(accepted),
                        gridPitchMm=params.patch_grid_pitch if panel is not None else None,
                        grip=(dict(lengthMm=grip_length, diameterMm=2 * radius,
                                   attachment="planned_terminal", bounds=list(grip.bounding_box()))
                              if grip is not None else None))
                    planned.append(PlannedPatch(terminal, solid, roof, gap, region, report))
                    counts["acceptedTiles"] += len(accepted)
    # Give reused and rebuilt demands one collision-free internal ID namespace.
    first_id = max((c.id for c in contacts), default=-1) + 1
    planned = [replace(patch, terminal=replace(patch.terminal, id=first_id + i))
               for i, patch in enumerate(planned)]
    report = dict(seconds=time.perf_counter() - start, selectedAreaMm2=selected_area,
                  fittedAreaMm2=sum(p.report["projectedAreaMm2"] for p in planned),
                  terminals=len(planned), axis=axis, center=center, **counts)
    progress.update(1, "Underside patches planned")
    return PatchPlan(planned, context, report, params.removal_groups, active)


def _prune_unprintable_patch_routes(tree, line_width):
    """Do not load a new crown onto a route thinner than one printable line.

    Routing near a model landing can narrow a branch after terminal creation.
    Ordinary contact tips remain untouched. Remove only exclusive dead paths
    beneath rejected terminals, and geometry attached to those dead paths.
    """
    internal = tree.support_terminal_ids
    rejected = []
    for tip in tree.nodes.values():
        if tip.kind != NodeKind.TIP or tip.contact_id not in internal:
            continue
        node = tree.nodes.get(tip.parent)
        while node is not None:
            if node.kind in (NodeKind.BRANCH, NodeKind.TRUNK) and 2 * node.radius < line_width - 1e-6:
                rejected.append(tip.id)
                break
            node = tree.nodes.get(node.parent)
    if not rejected:
        return set()
    rejected_contacts = {tree.nodes[nid].contact_id for nid in rejected}
    _prune_tip_paths(tree, rejected, internal)
    if not hasattr(tree, "failed"):
        tree.failed = {}
    for cid in rejected_contacts:
        tree.failed[cid] = "Patch foundation narrowed below one printable line; original point contacts retained"
        getattr(tree, "contact_normals", {}).pop(cid, None)
        getattr(tree, "contact_groups", {}).pop(cid, None)
    return rejected_contacts


def _prune_tip_paths(tree, tip_ids, removable_contacts):
    """Remove exclusive dead paths and their braces; retain every shared trunk."""
    children = tree.children()
    removed, segments = {}, []
    for nid in tip_ids:
        while nid in tree.nodes:
            node = tree.nodes[nid]
            if children[nid] or (node.contact_id is not None and node.contact_id not in removable_contacts):
                break
            parent = tree.nodes.get(node.parent)
            if parent is not None:
                segments.append((node.position, parent.position))
                children[parent.id].remove(nid)
            removed[nid] = tree.nodes.pop(nid)
            nid = node.parent
    if not removed:
        return 0
    removed_points = np.array([n.position for n in removed.values()])
    retained_points = np.array([n.position for n in tree.nodes.values()]).reshape(-1, 3)
    def on_removed_path(point):
        point = np.asarray(point)
        if len(retained_points) and np.any(np.linalg.norm(retained_points - point, axis=1) < 1e-7):
            return False
        if np.any(np.linalg.norm(removed_points - point, axis=1) < 1e-7):
            return True
        for a, b in segments:
            delta = b - a
            length2 = float(delta @ delta)
            if length2 > 1e-14:
                t = np.clip(float((point - a) @ delta) / length2, 0., 1.)
                if np.linalg.norm(point - (a + t * delta)) < 1e-7:
                    return True
        return False
    stability = getattr(tree, "_stability_braces", [])
    discarded_braces = []
    for root, foot, brace in stability:
        if root in removed or any(on_removed_path(p) for p in brace[:2]):
            discarded_braces.append(brace)
            if foot in tree.nodes and not children[foot]:
                removed[foot] = tree.nodes.pop(foot)
    tree._stability_braces = [b for b in stability if b[0] not in removed and b[1] not in removed]
    removed_points = np.array([n.position for n in removed.values()])
    retained_points = np.array([n.position for n in tree.nodes.values()]).reshape(-1, 3)
    def keep_brace(brace):
        if any(np.array_equal(brace[0], b[0]) and np.array_equal(brace[1], b[1])
               for b in discarded_braces):
            return False
        return not (on_removed_path(brace[0]) or on_removed_path(brace[1]))
    for attr in ("braces", "_raft_split_original_braces"):
        if hasattr(tree, attr):
            setattr(tree, attr, [b for b in getattr(tree, attr) if keep_brace(b)])
    for nid in removed:
        getattr(tree, "foot_radius", {}).pop(nid, None)
    return len(removed)


def _patch_covered_contacts(contacts, patches, params):
    """Require actual roof coverage at the contact's height, including its rim.

    Use only successfully rooted roofs, not planned tiles, fan footprints or
    bounding boxes. A center and eight perimeter probes conservatively keep
    pins beside patch seams, holes and edges. Manual contacts remain explicit.
    """
    roofs = [(p, np.asarray(p.roof.bounding_box()).reshape(2, 3)) for p in patches]
    angles = np.arange(8) * math.pi / 4
    ring = np.vstack(([0., 0.], np.column_stack((np.cos(angles), np.sin(angles)))))
    tolerance = max(.015, min(.04, params.layer_height / 2))
    covered = {}
    for contact in contacts:
        if not contact.enabled or contact.manual or contact.support_terminal or contact.normal[2] >= -.1:
            continue
        radius = max(params.line_width / 2, (contact.tip_diameter or params.tip_diameter) / 2)
        offsets = ring * radius
        probes = np.tile(contact.position, (len(offsets), 1))
        probes[:, :2] += offsets
        probes[:, 2] -= offsets @ contact.normal[:2] / contact.normal[2] + params.patch_gap
        owners = set()
        for point in probes:
            for patch, bounds in roofs:
                if np.any(point < bounds[0] - tolerance) or np.any(point > bounds[1] + tolerance):
                    continue
                if patch.roof.ray_cast(point + [0, 0, tolerance], point - [0, 0, tolerance]):
                    owners.add(patch.terminal.id)
                    break
            else:
                break
        else:
            covered[contact.id] = sorted(owners)
    return covered


def attach_patches(tree, plan, mesh, params):
    """Attach only roofs with a successfully routed terminal."""
    _prune_unprintable_patch_routes(tree, params.line_width)
    terminals = {n.contact_id for n in tree.nodes.values() if n.kind == NodeKind.TIP}
    attached = [patch for patch in plan.patches if patch.terminal.id in terminals]
    failed = [patch for patch in plan.patches if patch.terminal.id not in terminals]
    covered = _patch_covered_contacts(plan.contacts, attached, params)
    redundant = [n.id for n in tree.nodes.values()
                 if n.kind == NodeKind.TIP and n.contact_id in covered]
    removed_nodes = _prune_tip_paths(tree, redundant, set(covered))
    tree.patch_covered_contacts = covered
    for cid in covered:
        getattr(tree, "failed", {}).pop(cid, None)
        getattr(tree, "contact_normals", {}).pop(cid, None)
        getattr(tree, "contact_groups", {}).pop(cid, None)
    if hasattr(tree, "short_contact_fits"):
        tree.short_contact_fits = [r for r in tree.short_contact_fits if r["contactId"] not in covered]
    tree.patch_solids = [patch.solid for patch in attached]
    tree.patch_contact_keepouts = [patch.gap for patch in attached]
    tree.patch_report = [{**patch.report, "status": "built", "terminalId": patch.terminal.id}
                         for patch in attached]
    tree.patch_report.extend(dict(status="skipped", contactId=patch.report["contactId"],
                                  terminalId=patch.terminal.id,
                                  routeReason=getattr(tree, "failed", {}).get(patch.terminal.id),
                                  reason="Patch terminal could not reach a foundation; point contacts retained")
                             for patch in failed)
    tree.tip_keepout = plan.context.model
    tree.patch_release_preplanned = True
    tree.patch_terminal_top_z = {patch.terminal.id: patch.report["bounds"][5] for patch in attached}
    tree.patch_first_report = {**plan.report, "routedTerminals": len(attached),
        "coveredContactIds": sorted(covered), "redundantTipsRemoved": len(redundant),
        "redundantNodesRemoved": removed_nodes,
        "failedTerminals": [patch.terminal.id for patch in failed],
        "routedAreaMm2": sum(patch.report["projectedAreaMm2"] for patch in attached)}
    grips = sum(patch.report["grip"] is not None for patch in attached)
    tree.patch_release_report = [dict(status="preplanned", patches=len(attached), grips=grips,
        reason=("Patch grips and terminal necks were constructed before tree routing" if grips
                else "Patch fans were constructed before tree routing; release grips were not added"))]
