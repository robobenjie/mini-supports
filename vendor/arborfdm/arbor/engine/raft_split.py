"""Conservative raft removal slots, without cutting or rerouting any support.

A narrow straight or bent slot partitions whole rooted trees. It is accepted only when both raft
halves retain their feet and the final support solids do not reconnect the halves.
This is a removal heuristic, not an extraction-path or print-strength proof.
"""
from __future__ import annotations

import math
import numpy as np

from .params import model_on_raft
from .types import NodeKind


def _skip(tree, reason, **details):
    old = getattr(tree, "raft_split_report", {})
    tree.raft_split_report = {**old, **details, "status": "skipped", "reason": reason}
    tree.raft_split_root_sides = {}
    tree._raft_split_polygon = None
    tree._raft_split_halves = None
    tree._raft_split_slot = None
    return tree.raft_split_report


def _root_ids(tree):
    roots = {}
    for nid in tree.nodes:
        path, cur = [], nid
        while cur not in roots and tree.nodes[cur].parent is not None:
            path.append(cur)
            cur = tree.nodes[cur].parent
        root = roots.get(cur, cur)
        for node in path + [cur]:
            roots[node] = root
    return roots


def same_half(tree, first, second):
    """Whether a brace may link two foot-rooted trees."""
    sides = getattr(tree, "raft_split_root_sides", {})
    return not sides or sides.get(first) == sides.get(second)


def plan_split(tree, params, mesh=None):
    """Choose a bounded, deterministic slot search; store the plan on ``tree``.

    Public report is JSON-safe. Geometry and root assignments are engine-only.
    ``mesh`` supplies the model centre when the model has no base outline.
    """
    from shapely.geometry import LineString, MultiPoint, Point
    from shapely.ops import unary_union
    from .build import raft_polygon

    if not params.raft_split:
        return None
    gap = max(float(params.raft_split_gap), 2 * float(params.line_width))
    tree.raft_split_report = {"status": "skipped", "gap": gap}
    tree._raft_split_polygon = None
    tree.raft_split_root_sides = {}
    if not params.raft_enabled:
        return _skip(tree, "Raft is disabled")
    feet = sorted((n for n in tree.nodes.values() if n.kind == NodeKind.FOOT), key=lambda n: n.id)
    if len(feet) < 4:
        return _skip(tree, "Fewer than four plate feet; no surrounding cage detected")
    poly = raft_polygon(tree, params)
    if poly is None or poly.is_empty:
        return _skip(tree, "No raft to split")
    if poly.geom_type != "Polygon":
        return _skip(tree, "Raft already has disconnected islands")
    xy = np.array([n.position[:2] for n in feet], float)
    radii = np.array([max(float(getattr(tree, "foot_radius", {}).get(n.id, params.foot_diameter / 2)),
                         float(n.radius)) for n in feet])
    bounds = getattr(tree, "model_xy_bounds", None)
    if mesh is not None and len(mesh.vertices):
        centre = np.asarray(mesh.bounds, float).mean(axis=0)[:2]
    elif bounds is not None:
        centre = (np.array(bounds[:2]) + np.array(bounds[2:])) / 2
    elif getattr(tree, "raft_keepout", None) is not None:
        centre = np.array(tree.raft_keepout.centroid.coords[0])
    else:
        return _skip(tree, "Model outline unavailable for cage detection")
    hull = MultiPoint(xy).convex_hull
    # Strict interior avoids splitting a one-sided row whose hull merely touches centre.
    if not hull.contains(Point(centre)):
        return _skip(tree, "Feet do not surround the model centre")
    angles = np.sort(np.arctan2(xy[:, 1] - centre[1], xy[:, 0] - centre[0]))
    if np.max(np.diff(np.r_[angles, angles[0] + 2 * math.pi])) >= math.pi - 1e-6:
        return _skip(tree, "Feet occupy only one side of the model")
    rim = max(float(params.line_width), 0.2)
    protected_r = radii + rim
    obstacles = [Point(p).buffer(float(r), 24) for p, r in zip(xy, protected_r)]
    base = getattr(tree, "model_base", None) if model_on_raft(params) else None
    if base is not None and not base.is_empty:
        obstacles.append(base.buffer(rim))
    protected = unary_union(obstacles)
    root_of = _root_ids(tree)
    heights = {n.id: 0.0 for n in feet}
    subtree_xy = {n.id: [] for n in feet}
    for nid, node in tree.nodes.items():
        root = root_of[nid]
        if root in heights:
            heights[root] = max(heights[root], float(node.position[2]) - float(tree.z_base))
            subtree_xy[root].append(np.asarray(node.position[:2], float))
    extent = np.linalg.norm(np.array(poly.bounds[2:]) - np.array(poly.bounds[:2]))
    reach = 2 * extent + np.linalg.norm(centre) + 10
    best = None
    examined = 0
    rejected = {"foot_clearance": 0, "foot_balance": 0, "foundation": 0,
                "component_count": 0, "area_balance": 0, "anchor_width": 0}

    def consider(path, normal, angle, offset, style):
        nonlocal examined, best
        examined += 1
        line = LineString(path)
        if not line.is_simple:
            return
        slot = line.buffer(gap / 2, cap_style=2, join_style=1)
        if slot.intersects(protected):
            rejected["foundation"] += 1
            return
        cut = poly.difference(slot)
        if cut.geom_type != "MultiPolygon" or len(cut.geoms) != 2:
            rejected["component_count"] += 1
            return
        halves = sorted(cut.geoms, key=lambda p: np.asarray(p.centroid.coords[0]) @ normal)
        areas = [float(p.area) for p in halves]
        if min(areas) < 0.2 * sum(areas):
            rejected["area_balance"] += 1
            return
        sides = np.zeros(len(feet), dtype=int)
        counts, widths = [], []
        for side, half in zip((-1, 1), halves):
            covered = half.buffer(1e-8)
            members = [i for i, disc in enumerate(obstacles[:len(feet)]) if covered.covers(disc)]
            counts.append(len(members))
            if len(members) < max(2, math.ceil(0.2 * len(feet))):
                rejected["foot_balance"] += 1
                return
            sides[members] = side
            rect = np.asarray(half.minimum_rotated_rectangle.exterior.coords)
            width = float(np.linalg.norm(np.diff(rect, axis=0), axis=1).min())
            height = max(heights[feet[i].id] for i in members)
            if width < max(4 * params.line_width, height / 5) or half.buffer(-rim).is_empty:
                rejected["anchor_width"] += 1
                return
            widths.append(width)
        if np.any(sides == 0):
            rejected["foot_clearance"] += 1
            return
        # Entire rooted trees remain unchanged. Prefer fewer that reach over the
        # opposite raft half, but the final solid connectivity gate is authoritative.
        crossed = sum(any(halves[1 if side == -1 else 0].covers(Point(q)) for q in subtree_xy[n.id])
                      for n, side in zip(feet, sides))
        balance = abs(areas[0] - areas[1]) / sum(areas)
        score = (crossed, abs(counts[0] - counts[1]) / len(feet) + 0.25 * balance,
                 float(poly.intersection(slot).area), angle, abs(offset - centre @ normal), offset)
        if best is None or score < best[0]:
            best = (score, cut, sides, angle, offset, normal, areas, counts, widths, halves,
                    np.asarray(path, float).tolist(), slot, style)

    for angle in range(0, 180, 10):
        a = math.radians(angle)
        normal = np.array([math.cos(a), math.sin(a)])
        tangent = np.array([-normal[1], normal[0]])
        proj = xy @ normal
        # A slot centre must avoid all foot-disc projection intervals. Try midpoints
        # of free gaps, plus central candidates, instead of scanning arbitrary pixels.
        intervals = list(zip(proj - protected_r - gap / 2, proj + protected_r + gap / 2))
        if base is not None and not base.is_empty:
            hull = base.convex_hull
            base_xy = np.asarray(hull.exterior.coords if hull.geom_type == "Polygon" else hull.coords)
            base_proj = base_xy @ normal
            intervals.append((float(base_proj.min()) - rim - gap / 2,
                              float(base_proj.max()) + rim + gap / 2))
        intervals.sort()
        merged = []
        for lo, hi in intervals:
            if merged and lo <= merged[-1][1]:
                merged[-1][1] = max(hi, merged[-1][1])
            else:
                merged.append([float(lo), float(hi)])
        offsets = [float(centre @ normal), float(np.median(proj))]
        for left, right in zip(merged, merged[1:]):
            if right[0] - left[1] > 1e-6:
                offsets.append((left[1] + right[0]) / 2)
                offsets.append(float(np.clip(centre @ normal, left[1] + 1e-5, right[0] - 1e-5)))
        offsets = sorted(set(round(v, 8) for v in offsets),
                         key=lambda v: (abs(np.sum(proj < v) - len(feet) / 2), abs(v - centre @ normal), v))[:24]
        for offset in sorted(offsets):
            signed = proj - offset
            if np.any(np.abs(signed) <= protected_r + gap / 2):
                examined += 1
                rejected["foot_clearance"] += 1
                continue
            origin = normal * offset
            consider([origin - tangent * reach, origin + tangent * reach], normal, angle, offset, "straight")
    if best is None:
        # At most 12 directions x 2 central offsets x 2 detour sides x 4
        # expansions. The dogleg goes around the blocking base/foot cluster;
        # expanding that cluster handles another protected foot on the detour.
        for angle in range(0, 180, 15):
            a = math.radians(angle)
            normal = np.array([math.cos(a), math.sin(a)])
            tangent = np.array([-normal[1], normal[0]])
            projected = [(np.asarray(o.exterior.coords) @ tangent,
                          np.asarray(o.exterior.coords) @ normal) for o in obstacles]
            for offset in sorted(set([float(centre @ normal), float(np.median(xy @ normal))])):
                original = LineString([normal * offset - tangent * reach, normal * offset + tangent * reach])
                initial = {i for i, o in enumerate(obstacles) if original.distance(o) <= gap / 2 + 0.05}
                if not initial:
                    continue
                for direction in (-1, 1):
                    blocked = set(initial)
                    for _ in range(4):
                        pad = gap / 2 + 0.05
                        tlo = min(float(projected[i][0].min()) for i in blocked) - pad
                        thi = max(float(projected[i][0].max()) for i in blocked) + pad
                        detour = (max(float(projected[i][1].max()) for i in blocked) + pad if direction > 0
                                  else min(float(projected[i][1].min()) for i in blocked) - pad)
                        local = [(-reach, offset), (tlo, offset), (tlo, detour),
                                 (thi, detour), (thi, offset), (reach, offset)]
                        path = [tangent * t + normal * s for t, s in local]
                        consider(path, normal, angle, offset, "bent")
                        corridor = LineString(path).buffer(gap / 2, cap_style=2, join_style=1)
                        more = {i for i, o in enumerate(obstacles) if corridor.intersects(o)} - blocked
                        if not more:
                            break
                        blocked.update(more)
    if best is None:
        return _skip(tree, "No balanced slot preserves the feet, model foundation and adequate raft width",
                     candidates_examined=examined, rejections=rejected)
    score, cut, sides, angle, offset, normal, areas, counts, widths, halves, path, slot, style = best
    tree._raft_split_polygon = cut
    tree._raft_split_halves = halves
    tree._raft_split_slot = slot
    tree.raft_split_root_sides = {n.id: int(side) for n, side in zip(feet, sides)}
    tree.raft_split_report = {
        "status": "planned", "reason": "Surrounding feet admit two protected raft halves",
        "gap": gap, "angle_deg": angle, "offset": float(offset), "normal": normal.tolist(),
        "path_xy": path, "style": style,
        "halves": [{"side": side, "area_mm2": area, "feet": count, "anchor_width_mm": width}
                   for side, area, count, width in zip((-1, 1), areas, counts, widths)],
        "straddling_trees": int(score[0]), "candidates_examined": examined,
        "rejections": rejected,
    }
    return tree.raft_split_report


def finalize_split(tree, params, support_mesh, raft_mesh):
    """Require actual support+raft solids to remain separated; never include the model.

    Return False on rejection so the caller restores original braces and meshes.
    The raft halves' bottom vertices label connected solid components without
    relying on approximate nearest-branch ownership.
    """
    report = getattr(tree, "raft_split_report", {})
    if report.get("status") != "planned":
        return True
    from .build import trimesh_to_manifold
    try:
        raft = trimesh_to_manifold(raft_mesh)
        combined = raft + trimesh_to_manifold(support_mesh) if support_mesh is not None and len(support_mesh.faces) else raft
        import manifold3d as mf
        if combined.status() != mf.Error.NoError:
            raise ValueError("support union is not manifold")
        from shapely.geometry import Point
        halves = [p.buffer(1e-4) for p in tree._raft_split_halves]
        zmid = float(tree.z_base) - float(params.raft_thickness) / 2
        owners = []
        for component in combined.decompose():
            vertices = np.asarray(component.to_mesh().vert_properties)[:, :3]
            base_vertices = vertices[vertices[:, 2] < zmid]
            if not len(base_vertices):
                continue
            sides = set()
            for vertex in base_vertices:
                matched = [side for side, half in zip((-1, 1), halves) if half.covers(Point(vertex[:2]))]
                if len(matched) != 1:
                    raise ValueError("raft vertex could not be assigned uniquely to a half")
                sides.update(matched)
            if len(sides) != 1:
                _skip(tree, "Support branches reconnect the raft halves; retained the intact raft and original braces",
                      connectivity="reconnected")
                return False
            owners.extend(sides)
        if sorted(owners) != [-1, 1]:
            raise ValueError("could not identify exactly two raft-bearing solids")
        report.update(status="applied", reason="Two separate raft/support solids; feet and model foundation preserved",
                      connectivity="two_separate_raft_groups")
        return True
    except Exception as exc:
        _skip(tree, "Could not verify independent raft halves; retained the intact raft and original braces",
              connectivity="unverified", detail=str(exc))
        return False
