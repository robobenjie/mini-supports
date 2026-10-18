"""Meshing of the support tree: manifold union of cones, junction spheres, feet, braces.

Every solid is a manifold3d primitive (Manifold.cylinder / Manifold.sphere) placed with an
affine transform; everything is merged with one Manifold.batch_boolean(Add) call per
independent group so the result is watertight by construction.
"""
from __future__ import annotations

import math
from functools import lru_cache
from typing import Optional

import manifold3d as mf
import numpy as np
import trimesh

from .params import SupportParams, model_on_raft, support_base_z
from .tree import JOINT_INSET, printable_angle_deg
from .types import NodeKind, Progress, SupportTree

_EMPTY = trimesh.Trimesh(np.zeros((0, 3)), np.zeros((0, 3), np.int64), process=False)


def _frame(d: np.ndarray) -> np.ndarray:
    """3x3 rotation whose third column is the unit vector d."""
    z = d / np.linalg.norm(d)
    a = np.array([1.0, 0.0, 0.0]) if abs(z[0]) < 0.9 else np.array([0.0, 1.0, 0.0])
    x = np.cross(a, z)
    x /= np.linalg.norm(x)
    y = np.cross(z, x)
    return np.column_stack([x, y, z])


def cone_between(p0, p1, r0: float, r1: float, segs: int) -> Optional[mf.Manifold]:
    """Truncated cone from p0 (radius r0) to p1 (radius r1)."""
    p0 = np.asarray(p0, float)
    p1 = np.asarray(p1, float)
    d = p1 - p0
    h = float(np.linalg.norm(d))
    if h < 1e-6:
        return None
    r0 = max(float(r0), 1e-3)
    r1 = max(float(r1), 1e-3)
    c = mf.Manifold.cylinder(h, r0, r1, segs)
    M = np.zeros((3, 4))
    M[:, :3] = _frame(d)
    M[:, 3] = p0
    return c.transform(M)


def sphere_at(p, r: float, segs: int) -> mf.Manifold:
    # turned by half a facet about Z: a tube ring of the same radius around the same
    # centre (bend breaks: the next chain starts with the node radius) otherwise shares
    # vertices exactly with the sphere's equator and the union leaves zero-volume
    # slivers. Half a facet keeps the sphere mirror symmetric (symmetric models).
    return mf.Manifold.sphere(float(r), segs).rotate((0.0, 0.0, 180.0 / segs)) \
        .translate(tuple(float(v) for v in p))


def manifold_to_trimesh(m: mf.Manifold) -> trimesh.Trimesh:
    if m.status() != mf.Error.NoError:
        raise RuntimeError(f"manifold error: {m.status()}")
    if m.is_empty():
        return _EMPTY.copy()
    mesh = m.to_mesh()
    v = np.asarray(mesh.vert_properties, dtype=np.float64)[:, :3]
    f = np.asarray(mesh.tri_verts, dtype=np.int64)
    # process=False: manifold3d output is already indexed and manifold; trimesh's merge
    # of nearly coincident vertices would pinch thin features and break watertightness
    return trimesh.Trimesh(v, f, process=False)


def trimesh_to_manifold(t: trimesh.Trimesh) -> mf.Manifold:
    v = np.ascontiguousarray(t.vertices, dtype=np.float32)
    f = np.ascontiguousarray(t.faces, dtype=np.uint32)
    return mf.Manifold(mf.Mesh(vert_properties=v, tri_verts=f))


def joint_at(p, R: float, below, r_below_at, phi_deg: float, segs: int) -> mf.Manifold:
    """Sphere of radius R at p (junction, ball tip), with its underside made printable.

    A sphere wider than the branch under it hangs out beyond the overhang angle (its
    bottom is a flat dome). The sphere is merged (convex hull) with a smaller sphere
    placed down the branch axis, inside the branch, far enough that the conical skirt
    between them leans at most phi from vertical: the bottom of the joint is then
    buried in the branch instead of floating around it.

    below: the node under p (parent); r_below_at(s): radius of the branch at distance
    s from p along it."""
    p = np.asarray(p, float)
    ball = sphere_at(p, R, segs)
    if below is None:
        return ball
    v = np.asarray(below, float) - p
    L = float(np.linalg.norm(v))
    if L < 1e-6:
        return ball
    u = v / L
    theta = math.atan2(float(np.linalg.norm(u[:2])), max(-float(u[2]), 1e-12))  # tilt of the branch
    room = math.radians(phi_deg) - theta
    r0, rL = r_below_at(0.0), r_below_at(L)
    k = (rL - r0) / L                      # < 0: the branch gets thinner downwards
    if R <= r0 + 1e-6 and k >= -1e-9:
        return ball                        # the branch is at least as wide: covered
    sin_room = math.sin(max(room, 0.0))
    # skirt end: a sphere JOINT_INSET thinner than the branch at distance s down its
    # axis; smallest s with (R - r(s) + inset) / s <= sin(room) (skirt half-angle). A
    # branch thinning downwards is followed to its lower end.
    if k < 0:
        s_ = L
    else:
        s_ = (R - r0 + JOINT_INSET) / (sin_room + k) if sin_room + k > 1e-6 else math.inf
    if s_ >= L:
        # the skirt reaches the node below: keep the sphere small enough for the skirt
        # to stay printable (large junction_radius_factor, steep or thinning branch;
        # tree._limit_widening keeps node radii within this bound)
        s_ = L
        R_ok = rL - JOINT_INSET + L * sin_room
        if R > R_ok:
            R = max(R_ok, 1e-3)
            ball = sphere_at(p, R, segs)
    r_s = max(min(r_below_at(s_) - JOINT_INSET, R), 1e-3)
    low = sphere_at(p + u * s_, r_s, segs)
    return mf.Manifold.batch_hull([ball, low])


def _sphere_segs(segs: int) -> int:
    return max(8, int(math.ceil(segs / 4.0)) * 4)


@lru_cache(maxsize=None)
def _sphere_inradius(segs: int) -> float:
    """Distance from the centre to the nearest facet of Manifold.sphere(1, segs)."""
    m = mf.Manifold.sphere(1.0, segs).to_mesh()
    v = np.asarray(m.vert_properties, float)[:, :3]
    f = np.asarray(m.tri_verts, np.int64)
    a, b, c = v[f[:, 0]], v[f[:, 1]], v[f[:, 2]]
    n = np.cross(b - a, c - a)
    n /= np.linalg.norm(n, axis=1)[:, None]
    return float(np.abs((n * a).sum(axis=1)).min())


def joint_radius_factors(params: SupportParams) -> tuple[float, float]:
    """(junction, bend) sphere radius / node radius. A chain starts at a junction or a
    bend with a ring of the node radius around the node; the faceted sphere must
    contain it strictly (a ring vertex on a facet or a vertex leaves zero-volume
    slivers in the union), hence at least 1 / inradius of the faceted sphere."""
    cover = 1.01 / _sphere_inradius(_sphere_segs(int(params.circle_segments)))
    return max(float(params.junction_radius_factor), cover), cover


def tube(points: np.ndarray, radii: np.ndarray, segs: int,
         horizontal: Optional[list[bool]] = None,
         ring_normals: Optional[list[Optional[np.ndarray]]] = None) -> Optional[mf.Manifold]:
    """One closed tube through points (bottom to top) with linearly varying radius.

    Rings are perpendicular to the bisector of the adjacent segments and use a parallel
    transported frame (no twist). Callers split chains at sharp bends so rings never
    overlap. Returns None if manifold3d rejects the mesh."""
    pts = np.asarray(points, float)
    rad = np.maximum(np.asarray(radii, float), 1e-3)
    n = len(pts)
    if n < 2:
        return None
    seg = np.diff(pts, axis=0)
    L = np.linalg.norm(seg, axis=1)
    if np.any(L < 1e-6):
        return None
    seg /= L[:, None]
    dirs = np.empty((n, 3))
    dirs[0], dirs[-1] = seg[0], seg[-1]
    if n > 2:
        b = seg[:-1] + seg[1:]
        dirs[1:-1] = b / np.linalg.norm(b, axis=1)[:, None]
    if horizontal is not None:
        # Experimental structural sections follow the router's horizontal slabs.
        # Tip end rings can retain their contact-oriented cap plane.
        dirs[np.asarray(horizontal, dtype=bool)] = (0., 0., 1.)
    if ring_normals is not None:
        for i, direction in enumerate(ring_normals):
            if direction is not None:
                d = np.asarray(direction, dtype=float)
                length = float(np.linalg.norm(d))
                if length < 1e-9:
                    raise ValueError("A contact cap needs a nonzero normal")
                dirs[i] = d / length
    ang = np.arange(segs) * (2 * math.pi / segs)
    ca, sa = np.cos(ang), np.sin(ang)
    F0 = _frame(dirs[0])
    u, v = F0[:, 0], F0[:, 1]
    verts = np.empty((n * segs + 2, 3))
    for i in range(n):
        if i > 0:
            u = u - np.dot(u, dirs[i]) * dirs[i]
            u /= np.linalg.norm(u)
            v = np.cross(dirs[i], u)
        # circular ring in the bisector plane (bends are <= 25 deg, so the section of
        # the tube is pinched by at most 1 - cos(12.5 deg) = 2.4 %)
        verts[i * segs:(i + 1) * segs] = pts[i] + rad[i] * (np.outer(ca, u) + np.outer(sa, v))
    verts[n * segs] = pts[0]
    verts[n * segs + 1] = pts[-1]
    k = np.arange(segs)
    k1 = (k + 1) % segs
    faces = []
    for i in range(n - 1):
        a0, b0 = i * segs + k, i * segs + k1
        a1, b1 = a0 + segs, b0 + segs
        faces.append(np.column_stack([a0, b0, b1]))
        faces.append(np.column_stack([a0, b1, a1]))
    c0, c1 = n * segs, n * segs + 1
    faces.append(np.column_stack([np.full(segs, c0), k1, k]))
    top = (n - 1) * segs
    faces.append(np.column_stack([np.full(segs, c1), top + k, top + k1]))
    f = np.vstack(faces).astype(np.uint32)
    m = mf.Manifold(mf.Mesh(vert_properties=np.ascontiguousarray(verts, np.float32),
                            tri_verts=np.ascontiguousarray(f)))
    if m.status() != mf.Error.NoError or m.is_empty():
        return None
    if m.volume() < 0:
        return None
    return m


def fit_short_contact(mesh: trimesh.Trimesh, pos, normal, tip_radius: float,
                      floor_z: float, params: SupportParams,
                      model_manifold=None) -> dict:
    """Prefer wider cavity contacts, retaining the collision-checked one-line fallback.

    The preference sizes the root and projected cap; it does not guarantee that an
    inclined loft's horizontal layers survive a particular slicer. Both attempts use
    identical gap, intersection, foundation, angle and layer-height requirements.
    """
    preferred = max(float(params.line_width), float(params.short_contact_preferred_width))
    if model_manifold is None:
        model_manifold = trimesh_to_manifold(mesh)
    first = _fit_short_contact_with_width(mesh, pos, normal, tip_radius, floor_z, params,
                                          model_manifold, preferred)
    first["preferredWidth"] = preferred
    first["preferredWidthMet"] = first["status"] == "fitted"
    if first["status"] == "fitted" or preferred <= params.line_width + 1e-9:
        return first
    fallback = _fit_short_contact_with_width(mesh, pos, normal, tip_radius, floor_z, params,
                                             model_manifold, params.line_width)
    fallback["preferredWidth"] = preferred
    fallback["preferredWidthMet"] = False
    fallback["preferredWidthFallbackReason"] = first["reason"]
    fallback["preferredCandidatesTested"] = first["candidatesTested"]
    fallback["candidatesTested"] += first["candidatesTested"]
    return fallback


def _fit_short_contact_with_width(mesh: trimesh.Trimesh, pos, normal, tip_radius: float,
                      floor_z: float, params: SupportParams,
                      model_manifold=None, minimum_width=None) -> dict:
    """Fit a short model-to-model support while retaining the requested contact point.

    Experimental and deliberately bounded: try smaller printable caps, small tangent
    offsets (the requested XY point stays inside the cap), and nearby landings. The
    exact original triangle planes set cap clearance and landing height; a Boolean
    against the original solid rejects body intersections. Nothing is subtracted from
    the support to force a fit. A failed search is explicit, for callers to warn about.
    Coordinates and clearances are geometry, not predictions of deposited bead shape.
    """
    from shapely.geometry import Polygon, Point

    P = params
    minimum_width = max(P.line_width, float(minimum_width or P.line_width))
    if not (getattr(P, "compact_junctions", False) and
            getattr(P, "surface_aligned_tips", False)):
        raise ValueError("Short-contact fitting requires compact junctions and surface-aligned tips")
    if P.tip_penetration != 0 or P.tip_shape != "cone":
        raise ValueError("Short-contact fitting requires cone tips with zero penetration")
    pos = np.asarray(pos, dtype=float)
    normal = np.array(normal, dtype=float, copy=True)
    normal /= np.linalg.norm(normal)
    cap_normal = -normal
    record = {"status": "unfitted", "requestedContact": pos.tolist(),
              "requestedGap": float(P.z_gap), "requestedTipRadius": float(tip_radius),
              "candidatesTested": 0, "fitWidthConstraint": minimum_width}
    if cap_normal[2] <= 1e-6:
        return dict(record, reason="The contact normal does not face downward")
    segs = max(8, int(P.circle_segments))
    facet = math.cos(math.pi / segs)
    min_radius = math.ceil(minimum_width / (2 * cap_normal[2] * facet) * 1.01 / .005) * .005
    if min_radius > tip_radius + 1e-9:
        return dict(record, reason="The requested cap projects to less than the required fit width")
    if model_manifold is None:
        model_manifold = trimesh_to_manifold(mesh)
    if model_manifold.status() != mf.Error.NoError:
        return dict(record, reason="Exact short-contact fitting requires a closed model solid")

    # This neighbourhood contains every tested loft. Localizing the Boolean saves
    # work on large original meshes without changing its intersection with a loft.
    step = min(.05, minimum_width / 4)
    span = max(.35, 2 * tip_radius)
    zspan = max(1., float(pos[2] - floor_z) + .6)
    largest_root = max(P.on_model_tip_diameter / 2, minimum_width / (2 * facet) * 1.01, tip_radius)
    reach = span + largest_root + .15
    region = model_manifold ^ mf.Manifold.cube((2 * reach, 2 * reach, 2 * zspan)).translate(
        tuple(pos - [reach, reach, zspan]))
    all_tri = np.asarray(mesh.vertices, float)[np.asarray(mesh.faces, np.int64)]
    all_lo, all_hi = all_tri.min(axis=1), all_tri.max(axis=1)
    near = ((all_hi[:, 0] >= pos[0] - reach) & (all_lo[:, 0] <= pos[0] + reach) &
            (all_hi[:, 1] >= pos[1] - reach) & (all_lo[:, 1] <= pos[1] + reach) &
            (all_hi[:, 2] >= pos[2] - zspan) & (all_lo[:, 2] <= pos[2] + zspan))
    tri = all_tri[near]
    lo, hi = tri.min(axis=1), tri.max(axis=1)
    cross = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    planes = []
    for i, t in enumerate(tri):
        if abs(cross[i, 2]) < 1e-12:
            planes.append(None)
        else:
            planes.append((-cross[i, 0] / cross[i, 2], -cross[i, 1] / cross[i, 2],
                           float(np.dot(cross[i], t[0]) / cross[i, 2])))
    polygons = [Polygon(t[:, :2]) if planes[i] is not None else None for i, t in enumerate(tri)]

    def surface_extreme(footprint, up, reference, ceiling=None, cap_plane=None):
        """Exact extrema of triangle/footprint intersections, including interior edges."""
        x0, y0, x1, y1 = footprint.bounds
        ids = np.where((hi[:, 0] >= x0) & (lo[:, 0] <= x1) &
                       (hi[:, 1] >= y0) & (lo[:, 1] <= y1) &
                       (hi[:, 2] >= reference - .5) & (lo[:, 2] <= reference + .5) &
                       ((cross[:, 2] > 1e-12) if up else (cross[:, 2] < -1e-12)))[0]
        values = []
        for i in ids:
            intersection = footprint.intersection(polygons[i])
            if intersection.is_empty:
                continue
            geoms = list(intersection.geoms) if hasattr(intersection, "geoms") else [intersection]
            for g in geoms:
                if g.geom_type == "Polygon":
                    coordinates = np.asarray(g.exterior.coords)
                elif hasattr(g, "coords"):
                    coordinates = np.asarray(g.coords)
                else:
                    continue
                xy = coordinates[:, :2]
                a, b, c = planes[i]
                zz = a * xy[:, 0] + b * xy[:, 1] + c
                if ceiling is not None:
                    zz = zz[zz < ceiling - 1e-6]
                if not len(zz):
                    continue
                if cap_plane is not None:
                    # No ceiling filtering in this branch: coordinates stay aligned.
                    aa, bb, cc = cap_plane
                    zz = zz - (aa * xy[:, 0] + bb * xy[:, 1] + cc)
                values.extend(zz.tolist())
        return (max(values) if up else min(values)) if values else None

    angles = np.arange(segs) * (2 * math.pi / segs)
    # Match tube's parallel-transported frame exactly, starting at its horizontal root.
    root_u = _frame(np.array([0., 0., 1.]))[:, 0]
    cap_u = root_u - np.dot(root_u, cap_normal) * cap_normal
    cap_u /= np.linalg.norm(cap_u)
    cap_v = np.cross(cap_normal, cap_u)
    cap_unit = np.outer(np.cos(angles), cap_u) + np.outer(np.sin(angles), cap_v)
    root_unit = np.column_stack([np.sin(angles), -np.cos(angles)])
    bound = int(math.ceil(span / step))
    offsets = [(i * step, j * step) for i in range(-bound, bound + 1)
               for j in range(-bound, bound + 1) if math.hypot(i * step, j * step) <= span + 1e-9]
    offsets.sort(key=lambda d: (d[0] ** 2 + d[1] ** 2, d[0], d[1]))
    root_min = max(P.on_model_tip_diameter / 2, minimum_width / (2 * facet) * 1.01)
    root_radii = [float(root_min), float(minimum_width / (2 * facet) * 1.01)]
    root_radii = list(dict.fromkeys(root_radii + [float(max(root_min, tip_radius))]))
    floors = {}
    max_slope = math.tan(math.radians(min(printable_angle_deg(P), P.branch_angle_deg)))
    radii = sorted(set([float(tip_radius), float(max(min_radius, .85 * tip_radius)),
                        float(min_radius)]), reverse=True)
    source_point = Point(float(pos[0]), float(pos[1]))
    cap_options = []
    for radius in radii:
        cap_offsets = [(0., 0.)]
        for distance in (min(.05, min_radius * .4), min_radius * .7, radius * .85):
            for angle in np.arange(8) * math.pi / 4:
                dx, dy = distance * math.cos(angle), distance * math.sin(angle)
                dz = -(cap_normal[0] * dx + cap_normal[1] * dy) / cap_normal[2]
                shift = np.array([dx, dy, dz])
                # The last ring is measured in the tangent plane, keeping the
                # requested point away from the cap boundary by at least 15%.
                if distance == radius * .85:
                    shift *= distance / np.linalg.norm(shift)
                if np.linalg.norm(shift) <= radius * .86:
                    cap_offsets.append((float(shift[0]), float(shift[1])))
        for dx, dy in cap_offsets:
            shift = np.array([dx, dy, -(cap_normal[0] * dx + cap_normal[1] * dy) / cap_normal[2]])
            tip = pos - [0., 0., P.z_gap] + shift
            vertices = tip + radius * cap_unit
            footprint = Polygon(vertices[:, :2])
            if not footprint.covers(source_point):
                continue
            a, b = -cap_normal[0] / cap_normal[2], -cap_normal[1] / cap_normal[2]
            plane = (a, b, tip[2] - a * tip[0] - b * tip[1])
            gap = surface_extreme(footprint, False, pos[2], cap_plane=plane)
            if gap is None:
                continue
            lowered = max(0., P.z_gap - gap) + 1e-5
            tip = tip - [0., 0., lowered]
            vertices = vertices - [0., 0., lowered]
            cap_options.append((lowered, radius, shift, tip, vertices, gap + lowered))
    # Prefer a cap close to its original requested point's Z gap; shrinking a
    # footprint is preferable to moving its entire plane far from that contact.
    cap_options.sort(key=lambda x: (round(x[0], 5), -x[1], float(np.linalg.norm(x[2]))))
    for lowered, radius, shift, tip, vertices, guaranteed_gap in cap_options:
        for root_radius in root_radii:
          for oi, (rx, ry) in enumerate(offsets):
            xy = pos[:2] + [rx, ry]
            key = (root_radius, oi)
            if key not in floors:
                poly = Polygon(xy + root_radius * root_unit)
                floors[key] = surface_extreme(poly, True, floor_z, ceiling=pos[2] - P.z_gap)
            root_z = floors[key]
            if root_z is None or min(vertices[:, 2]) - root_z < P.layer_height - 1e-9:
                continue
            # A long steep source triangle can cross the local query box while
            # its actual landing at this XY lies below it. Never certify a loft
            # using a Boolean that omitted part of that loft.
            candidate_lo = np.minimum(vertices.min(axis=0), [xy[0] - root_radius, xy[1] - root_radius, root_z])
            candidate_hi = np.maximum(vertices.max(axis=0), [xy[0] + root_radius, xy[1] + root_radius, root_z])
            region_lo = pos - [reach, reach, zspan]
            region_hi = pos + [reach, reach, zspan]
            if np.any(candidate_lo < region_lo) or np.any(candidate_hi > region_hi):
                continue
            # The root disk is inscribed by this circle. Every cap vertex inside its
            # expanding cone is a conservative <=phi envelope from that foundation.
            slopes = ((np.linalg.norm(vertices[:, :2] - xy, axis=1) - root_radius * facet) /
                      (vertices[:, 2] - root_z))
            if max(slopes) > max_slope + 1e-9:
                continue
            root = np.array([xy[0], xy[1], root_z])
            solid = tube(np.array([root, tip]), np.array([root_radius, radius]), segs,
                         [True, False], [None, cap_normal])
            if solid is None:
                continue
            record["candidatesTested"] += 1
            volume = abs(float((solid ^ region).volume()))
            if volume > 1e-7:
                continue
            return dict(record, status="fitted", tipPosition=tip.tolist(), tipRadius=radius,
                        rootPosition=root.tolist(), rootRadius=root_radius,
                        minimumCapGap=float(guaranteed_gap), projectedCapWidth=float(2 * radius * cap_normal[2] * facet),
                        overlapVolume=volume, maxSlope=float(max(0., max(slopes))),
                        capLowered=float(lowered), requestedPointGap=float(P.z_gap + lowered),
                        capTangentOffset=shift.tolist(),
                        requestedPointInCap=True, minimumHeight=float(min(vertices[:, 2]) - root_z),
                        landingGap=0., searchRadius=float(span))
    return dict(record, reason="No collision-free, one-line-wide, one-layer-high short contact fits the bounded neighbourhood at the requested top gap")


def _chains(tree: SupportTree, ch: dict, max_bend_deg: float = 25.0):
    """Split the tree into unbranched chains [bottom, ..., top] (node ids). A chain starts
    at a root or a junction and stops at a tip, a junction or a bend that is too sharp
    for a single lofted tube (ring overlap)."""
    nodes = tree.nodes
    cos_lim = math.cos(math.radians(max_bend_deg))
    out = []
    starts = [(r.id, c) for r in tree.roots() for c in ch[r.id]]
    while starts:
        b, c = starts.pop()
        chain = [b, c]
        cur = c
        while ch[cur]:
            # continue along the thickest child (the main stem); the others start chains
            kids = sorted(ch[cur], key=lambda i: -nodes[i].radius)
            nxt = kids[0]
            d0 = nodes[cur].position - nodes[chain[-2]].position
            d1 = nodes[nxt].position - nodes[cur].position
            l0, l1 = float(np.linalg.norm(d0)), float(np.linalg.norm(d1))
            if l0 < 1e-6 or l1 < 1e-6:
                break
            cs = float(np.dot(d0, d1) / (l0 * l1))
            if cs < cos_lim:
                break
            half = 0.5 * math.acos(min(1.0, cs))
            if 2.0 * nodes[cur].radius * math.tan(half) > 0.8 * min(l0, l1):
                break
            chain.append(nxt)
            for k in kids[1:]:
                starts.append((cur, k))
            cur = nxt
        out.append(chain)
        for k in ch[cur]:
            starts.append((cur, k))
    return out


def tree_solids(tree: SupportTree, params: SupportParams, progress: Optional[Progress] = None,
                tubes: bool = True) -> list[mf.Manifold]:
    """Solids of the tree, not yet merged.

    tubes=True: one lofted tube per unbranched chain (far fewer boolean operands);
    tubes=False: one truncated cone (Manifold.cylinder) per segment. Both add spheres at
    junctions (radius x junction_radius_factor) and at chain breaks, feet with collars,
    on-model pads and braces."""
    P = params
    segs = int(P.circle_segments)
    ssegs = _sphere_segs(segs)
    phi = printable_angle_deg(P)
    f_junction, f_bend = joint_radius_factors(P)
    nodes = tree.nodes
    ch = tree.children()
    out: list[mf.Manifold] = []
    foot_radius = getattr(tree, "foot_radius", {})
    z_base = getattr(tree, "z_base", support_base_z(P))
    ball = P.tip_shape == "ball"
    surface_caps = getattr(P, "surface_aligned_tips", False)
    if surface_caps and ball:
        raise ValueError("Surface-aligned contact caps require cone tips")
    root_floors: dict[int, Optional[float]] = {}
    root_limits: dict[int, Optional[tuple[mf.Manifold, float]]] = {}

    def at_root_plane(solid: Optional[mf.Manifold], node_id: int) -> Optional[mf.Manifold]:
        """Preserve the planned bottom plane of a support standing on the model.

        Inclined cone end rings and the lower sphere of a joint skirt extend below
        their centre. A MODEL_FOOT's position is the requested bottom of the support,
        not a sphere centre: letting those primitives dip below it introduces
        unplanned penetration and can create an early support island. Trim only
        solids belonging to that root; a neighbouring tree may start lower down.
        """
        if solid is None:
            return None
        trail = []
        cur = node_id
        while cur not in root_floors and nodes[cur].parent is not None:
            trail.append(cur)
            cur = nodes[cur].parent
        if cur not in root_floors:
            root_floors[cur] = float(nodes[cur].position[2]) if nodes[cur].kind == NodeKind.MODEL_FOOT else None
        floor = root_floors[cur]
        for nid in trail:
            root_floors[nid] = floor
        if floor is None:
            return solid
        solid = solid.trim_by_plane((0.0, 0.0, 1.0), floor)
        # Cache the actual root as well: a previously visited descendant in
        # root_floors may have ended the walk above before reaching it.
        while nodes[cur].parent is not None:
            cur = nodes[cur].parent
        if cur not in root_limits:
            root_limits[cur] = None
            root = nodes[cur]
            children = [nodes[cid] for cid in ch[cur]]
            # Short cavity contacts already have a narrow constant section. Only
            # constrain a landing that grows into a branch/junction shoulder.
            if children and all(c.kind in (NodeKind.BRANCH, NodeKind.TRUNK) for c in children):
                height = min(float(c.position[2]) for c in children) - floor
                radius = float(root.radius)
                upper = max(float(np.linalg.norm(c.position[:2] - root.position[:2])) +
                            c.radius * (f_junction if len(ch[c.id]) > 1 else f_bend)
                            for c in children)
                slope = math.tan(math.radians(min(phi, float(P.branch_angle_deg))))
                if height > 1e-6 and slope > 1e-6 and upper > radius:
                    neck = min(float(P.tip_length), height - (upper - radius) / slope)
                    # A thinner-than-one-line neck is not made longer; its
                    # printability must instead be resolved by parameter validation.
                    if neck >= P.layer_height and 2.0 * radius >= P.line_width:
                        mid = root.position + [0.0, 0.0, neck]
                        top = root.position + [0.0, 0.0, height + 1e-4]
                        upper_radius = radius + slope * (height + 1e-4 - neck)
                        stem = cone_between(root.position, mid, radius, radius, segs)
                        taper = cone_between(mid, top, radius, upper_radius, segs)
                        envelope = mf.Manifold.batch_boolean([stem, taper], mf.OpType.Add)
                        root_limits[cur] = (envelope, floor + height)
        limit = root_limits[cur]
        if limit is not None:
            envelope, shoulder_z = limit
            # Trim the unchecked landing span to a printable contact neck and
            # taper. This also removes spherical skirt bulges in that span. The
            # already-routed tree above the first shoulder is preserved exactly.
            solid = (solid ^ envelope) + solid.trim_by_plane((0.0, 0.0, 1.0), shoulder_z)
        return solid

    def seg_radii(child_id: int) -> tuple[float, float]:
        """(bottom, top) radius of the segment child -> parent."""
        n = nodes[child_id]
        par = nodes[n.parent]
        r_top = n.radius * (0.6 if (ball and n.kind == NodeKind.TIP) else 1.0)
        r_low = n.radius if par.kind == NodeKind.FOOT else par.radius
        return r_low, r_top

    def cap_normals(node_ids):
        if not surface_caps:
            return None
        normals = []
        for node_id in node_ids:
            node = nodes[node_id]
            normal = None
            if node.kind == NodeKind.TIP:
                source = getattr(tree, "contact_normals", {}).get(node.contact_id)
                if source is None:
                    raise ValueError(f"Contact {node.contact_id} has no surface normal for its cap")
                normal = -np.asarray(source, dtype=float)
                if not np.all(np.isfinite(normal)) or normal[2] <= 1e-6:
                    raise ValueError(f"Contact {node.contact_id} cap does not face upward")
            normals.append(normal)
        return normals

    def joint(n, R: float):
        """Sphere of radius R at node n whose underside is buried in the branch below."""
        if getattr(P, "compact_junctions", False) and n.kind in (NodeKind.BRANCH, NodeKind.TRUNK) and n.parent is not None:
            # Experimental slab-aligned envelope: contain the horizontal
            # structural rings rather than an entire sphere (or inclined rings)
            # protruding below the slabs checked by routing. The lower ring
            # follows the existing incoming branch, keeping a supported convex
            # transition instead of a flat floating underside.
            parent = nodes[n.parent]
            incoming = n.position - parent.position
            length = float(np.linalg.norm(incoming))
            if length > 1e-6:
                incoming /= length
                axes = [np.array([0., 0., 1.])]
                # Circumscribe any parallel-transported polygon phase with a
                # small strict overlap. No spherical inradius inflation needed.
                cover = 1.001 / math.cos(math.pi / segs)
                radius = n.radius * cover * (max(1., P.junction_radius_factor) if len(ch[n.id]) > 1 else 1.)
                epsilon = 1e-3
                rings = [cone_between(n.position - axis * epsilon,
                                      n.position + axis * epsilon,
                                      radius, radius, segs) for axis in axes]
                lower_radius, _ = seg_radii(n.id)
                rings.append(cone_between(parent.position - axes[0] * epsilon,
                                          parent.position + axes[0] * epsilon,
                                          lower_radius, lower_radius, segs))
                return at_root_plane(mf.Manifold.batch_hull(rings), n.id)
        if n.parent is None:
            return at_root_plane(sphere_at(n.position, R, ssegs), n.id)
        rl, rt = seg_radii(n.id)
        L = float(np.linalg.norm(nodes[n.parent].position - n.position))
        return at_root_plane(joint_at(n.position, R, nodes[n.parent].position,
                        lambda s_: rt + (rl - rt) * min(s_ / max(L, 1e-9), 1.0), phi, ssegs), n.id)

    if tubes:
        chains = _chains(tree, ch)
        for ci, chain in enumerate(chains):
            if progress is not None and ci % 500 == 0:
                progress.update(0.3 * ci / max(len(chains), 1), "Building support solids")
            pts = np.array([nodes[i].position for i in chain])
            rad = np.empty(len(chain))
            for k in range(1, len(chain)):
                rl, rt = seg_radii(chain[k])
                rad[k] = rt
                if k == 1:
                    rad[0] = rl
            compact = getattr(P, "compact_junctions", False)
            horizontal = [nodes[i].kind != NodeKind.TIP for i in chain] if compact else None
            normals = cap_normals(chain)
            m = tube(pts, rad, segs, horizontal, normals) if len(chain) > 2 or compact or surface_caps else None
            if m is not None:
                out.append(at_root_plane(m, chain[-1]))
            else:
                for k in range(1, len(chain)):
                    rl, rt = seg_radii(chain[k])
                    lower = rl if k == 1 else rad[k - 1]
                    s_ = tube(pts[k - 1:k + 1], np.array([lower, rt]), segs,
                              horizontal[k - 1:k + 1] if horizontal else None,
                              normals[k - 1:k + 1] if normals else None) if compact or surface_caps else cone_between(pts[k - 1], pts[k], lower, rt, segs)
                    if s_ is None and (compact or surface_caps):
                        raise RuntimeError(f"Invalid experimental support loft on edge {chain[k - 1]} -> {chain[k]}")
                    if s_ is not None:
                        out.append(at_root_plane(s_, chain[k]))
            top = nodes[chain[-1]]
            if len(ch[top.id]) == 1 and top.kind in (NodeKind.BRANCH, NodeKind.TRUNK):
                out.append(joint(top, top.radius * f_bend))   # bend break
            if len(ch[top.id]) > 1 and top.kind in (NodeKind.BRANCH, NodeKind.TRUNK):
                # the chain stopped at a junction because of a sharp bend: the junction
                # sphere is added below; nothing else to do
                pass
    else:
        for n in nodes.values():
            if n.parent is None:
                continue
            rl, rt = seg_radii(n.id)
            compact = getattr(P, "compact_junctions", False)
            s_ = tube(np.array([nodes[n.parent].position, n.position]), np.array([rl, rt]), segs,
                      [True, n.kind != NodeKind.TIP] if compact else None,
                      cap_normals([n.parent, n.id])) if compact or surface_caps else cone_between(nodes[n.parent].position, n.position, rl, rt, segs)
            if s_ is None and (compact or surface_caps):
                raise RuntimeError(f"Invalid experimental support loft on edge {n.parent} -> {n.id}")
            if s_ is not None:
                out.append(at_root_plane(s_, n.id))
            if len(ch[n.id]) == 1 and n.kind in (NodeKind.BRANCH, NodeKind.TRUNK):
                out.append(joint(n, n.radius * f_bend))

    for n in nodes.values():
        k = ch[n.id]
        if ball and n.kind == NodeKind.TIP:
            out.append(joint(n, n.radius))
        if n.kind in (NodeKind.BRANCH, NodeKind.TRUNK, NodeKind.MODEL_FOOT) and len(k) > 1:
            out.append(joint(n, n.radius * f_junction))
        elif n.kind == NodeKind.FOOT:
            fr = max(float(foot_radius.get(n.id, P.foot_diameter / 2)), n.radius)
            base = np.array([n.position[0], n.position[1], z_base])
            fsegs = max(segs, 24)
            r_top = max([nodes[c].radius for c in k], default=n.radius)
            if any(nodes[c].kind == NodeKind.TIP for c in k):
                # short support (contact just above the plate): the foot disk may not
                # rise into the overhang above it, and a collar would swallow the tip
                room = min(nodes[c].position[2] for c in k) - z_base
                fh = min(P.foot_height, 0.5 * room)
                if fh > 1e-3:
                    out.append(cone_between(base, base + [0, 0, fh], fr, fr, fsegs))
                continue
            out.append(cone_between(base, base + [0, 0, P.foot_height], fr, fr, fsegs))
            collar_r = min(max(P.collar_diameter / 2, r_top), fr)
            top = base + [0, 0, P.foot_height + P.collar_height]
            out.append(cone_between(base + [0, 0, 0.5 * P.foot_height], top, collar_r, r_top, fsegs))
    for p0, p1, rb in getattr(tree, "braces", []):
        s_ = cone_between(p0, p1, rb, rb, max(8, segs // 2))
        if s_ is not None:
            out.append(s_)
    return [s_ for s_ in out if s_ is not None]


HOLLOW_SKIP_KINDS = (NodeKind.TIP, NodeKind.MODEL_FOOT)


def hollow_min_radius(params: SupportParams) -> float:
    """Smallest section radius that gets a void: hollow_wall of wall all around a hole
    of at least 2 line widths (a narrower hole is filled by the slicer's gap fill
    anyway and only adds a travel and a retraction per layer)."""
    return float(params.hollow_wall + params.line_width)


def hollow_cores(tree: SupportTree, params: SupportParams) -> list[mf.Manifold]:
    """Sealed inner voids of the wide trunk / branch sections (hollow_supports).

    Along every unbranched chain (same chains as the tube meshing), the runs of
    consecutive segments whose radius stays >= hollow_min_radius get a core: the same
    axis with radius r - hollow_wall, shortened by hollow_wall at both ends of the run.
    Each core lies at least hollow_wall (x cos of the taper, ~1) inside its own solid,
    hence inside the union, so the void is closed: no hole at the top, the slicer prints
    perimeters around it and a small bridge over it. Tips, on-model pads, thin branches,
    junction spheres, feet, collars and the raft stay solid."""
    P = params
    nodes = tree.nodes
    ch = tree.children()
    w = float(P.hollow_wall)
    rmin = hollow_min_radius(P)
    segs = int(P.circle_segments)
    out: list[mf.Manifold] = []
    for chain in _chains(tree, ch):
        run: list[int] = []

        def flush():
            if len(run) < 2:
                return
            pts = np.array([nodes[i].position for i in run], float)
            rad = np.array([nodes[i].radius for i in run], float) - w
            if nodes[run[0]].kind == NodeKind.FOOT:
                rad[0] = nodes[run[1]].radius - w      # outer tube: the child's radius
                # the chain starts on a foot: the void starts above the foot disc + collar
                z0 = float(pts[0][2]) + P.foot_height + P.collar_height + w
                while len(pts) >= 2 and pts[1][2] <= z0:
                    pts, rad = pts[1:], rad[1:]
                if len(pts) < 2:
                    return
                d = pts[1] - pts[0]
                if pts[0][2] < z0 and d[2] > 1e-9:
                    t = (z0 - pts[0][2]) / d[2]
                    pts[0] = pts[0] + t * d
                    rad[0] = rad[0] + t * (rad[1] - rad[0])
            else:
                d = pts[1] - pts[0]
                L0 = float(np.linalg.norm(d))
                if L0 <= w + 1e-6:
                    pts, rad = pts[1:], rad[1:]
                else:
                    pts[0] = pts[0] + d / L0 * w
            if len(pts) < 2:
                return
            d = pts[-1] - pts[-2]
            L1 = float(np.linalg.norm(d))
            if L1 <= w + 1e-6:
                pts, rad = pts[:-1], rad[:-1]
            else:
                pts[-1] = pts[-1] - d / L1 * w
            if len(pts) < 2 or float(np.linalg.norm(pts[-1] - pts[0])) < 2 * w:
                return
            if np.any(rad < P.line_width - 1e-9):
                return
            m = tube(pts, rad, segs) if len(pts) > 2 else None
            if m is not None:
                out.append(m)
            else:
                for k in range(1, len(pts)):
                    c = cone_between(pts[k - 1], pts[k], rad[k - 1], rad[k], segs)
                    if c is not None:
                        out.append(c)

        for k in range(1, len(chain)):
            a, b = nodes[chain[k - 1]], nodes[chain[k]]
            ok = (b.kind not in HOLLOW_SKIP_KINDS and a.kind not in HOLLOW_SKIP_KINDS
                  and min(a.radius, b.radius) >= rmin)
            if ok:
                if not run:
                    run.append(a.id)
                run.append(b.id)
            else:
                flush()
                run = []
        flush()
    return out


def _tree_groups(tree: SupportTree) -> list[list[int]]:
    """Node ids grouped by tree (root)."""
    root_of: dict[int, int] = {}
    for i in tree.nodes:
        path = []
        cur = i
        while cur not in root_of and tree.nodes[cur].parent is not None:
            path.append(cur)
            cur = tree.nodes[cur].parent
        r = root_of.get(cur, cur)
        root_of[cur] = r
        for p in path:
            root_of[p] = r
    groups: dict[int, list[int]] = {}
    for i, r in root_of.items():
        groups.setdefault(r, []).append(i)
    return list(groups.values())


MIN_PART_VOLUME = 1e-3   # mm3: separate support fragments below this are dropped


def mesh_tree_manifold(tree: SupportTree, params: SupportParams,
                       progress: Optional[Progress] = None) -> mf.Manifold:
    solids = tree_solids(tree, params, progress)
    if progress is not None:
        progress.update(0.45, f"Union of {len(solids)} solids")
    if not solids:
        return mf.Manifold()
    union = mf.Manifold.batch_boolean(solids, mf.OpType.Add)
    # Tilted tube ends and spheres near the feet can dip below the support base; nothing may
    # exist under it (plate, or raft top which the raft mesh fills).
    z_base = getattr(tree, "z_base", support_base_z(params))
    union = union.trim_by_plane((0.0, 0.0, 1.0), float(z_base))
    # Two solids that almost touch can leave a separate fragment of (near) zero volume after
    # the union; it cannot be printed and would show up as a floating sliver in a slicer.
    parts = union.decompose()
    if len(parts) > 1:
        keep = [q for q in parts if q.volume() >= MIN_PART_VOLUME]
        if 0 < len(keep) < len(parts):
            union = mf.Manifold.compose(keep)
    if params.hollow_supports:
        # after the fragment filter: decompose() returns each sealed void as its own part
        cores = hollow_cores(tree, params)
        if cores:
            union = union - mf.Manifold.batch_boolean(cores, mf.OpType.Add)
    return union


def mesh_tree(tree: SupportTree, params: SupportParams, progress: Optional[Progress] = None
              ) -> trimesh.Trimesh:
    """Watertight mesh of every support (tips, branches, trunks, feet, braces)."""
    m = mesh_tree_manifold(tree, params, progress)
    out = manifold_to_trimesh(m)
    if progress is not None:
        progress.update(1.0, "Support mesh done")
    return out


# ---------------------------------------------------------------------------
# raft
# ---------------------------------------------------------------------------
def _feet_disks(tree: SupportTree, params: SupportParams):
    """(xy (n, 2), radius (n,)) of the plate / raft feet."""
    feet = [n for n in tree.nodes.values() if n.kind == NodeKind.FOOT]
    fr = getattr(tree, "foot_radius", {})
    xy = np.array([n.position[:2] for n in feet]).reshape(-1, 2)
    rad = np.array([max(fr.get(n.id, params.foot_diameter / 2), n.radius) for n in feet])
    return xy, rad


def raft_polygon(tree: SupportTree, params: SupportParams):
    """2D raft outline (shapely) or None, according to raft_coverage:

    "feet"      convex hull of each cluster of feet, offset by raft_margin, minus the
                model footprint keep-out (pieces joined by a ring around the footprint);
    "footprint" one plate: convex hull of the model base (tree.model_base) and of the
                feet, offset by raft_margin; the model rests on it;
    "bed"       bounding rectangle of the model (tree.model_xy_bounds) and of the feet,
                offset by raft_margin (never the physical build plate)."""
    from shapely.geometry import MultiPoint, Point, box
    from shapely.ops import unary_union

    P = params
    split = getattr(tree, "_raft_split_polygon", None)
    if P.raft_split and split is not None:
        return split
    if model_on_raft(P):
        xy, rad = _feet_disks(tree, P)
        disks = [Point(xy[i]).buffer(rad[i], 16) for i in range(len(xy))]
        base = getattr(tree, "model_base", None)
        if P.raft_coverage == "bed":
            parts = list(disks)
            b = getattr(tree, "model_xy_bounds", None)
            if b is not None:
                parts.append(box(*b))
            if base is not None:
                parts.append(base)
            if not parts:
                return None
            poly = box(*unary_union(parts).bounds).buffer(P.raft_margin, join_style=2)
        else:
            pts = [pt for d in disks for pt in d.exterior.coords]
            if base is not None and not base.is_empty:
                pts += list(base.convex_hull.exterior.coords) if base.convex_hull.geom_type == "Polygon" \
                    else list(base.convex_hull.coords)
            if not pts:
                return None
            poly = MultiPoint(pts).convex_hull.buffer(P.raft_margin, 16)
        if poly.is_empty or poly.area < 1e-6:
            return None
        return poly
    return _raft_polygon_feet(tree, P)


def _raft_polygon_feet(tree: SupportTree, params: SupportParams):
    """raft_coverage "feet" (v0.1 behaviour), see raft_polygon."""
    from shapely.geometry import MultiPoint, Point
    from shapely.ops import unary_union
    from scipy.spatial import cKDTree

    P = params
    feet = [n for n in tree.nodes.values() if n.kind == NodeKind.FOOT]
    if not feet:
        return None
    fr = getattr(tree, "foot_radius", {})
    xy = np.array([n.position[:2] for n in feet])
    rad = np.array([max(fr.get(n.id, P.foot_diameter / 2), n.radius) for n in feet])
    link = 2 * (rad.max() + P.raft_margin) + P.merge_distance
    parent = list(range(len(feet)))

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    for a, b in cKDTree(xy).query_pairs(link):
        parent[find(a)] = find(b)
    clusters: dict[int, list[int]] = {}
    for i in range(len(feet)):
        clusters.setdefault(find(i), []).append(i)
    polys = []
    for mem in clusters.values():
        disks = [Point(xy[i]).buffer(rad[i] + P.raft_margin, 16) for i in mem]
        polys.append(MultiPoint([pt for d in disks for pt in d.exterior.coords]).convex_hull)
    poly = unary_union(polys)
    keep = getattr(tree, "raft_keepout", None)
    if keep is not None and not keep.is_empty:
        # never remove the area right under a foot
        must = unary_union([Point(xy[i]).buffer(rad[i], 16) for i in range(len(feet))])
        poly = poly.difference(keep.difference(must))
        if getattr(poly, "geoms", None) is not None and len(poly.geoms) > 1:
            # The model footprint cut the raft into islands (first print test: small pads
            # came loose). Join them with a ring around the footprint, inside the hull of
            # all feet so the raft does not grow around the whole model needlessly.
            hull = MultiPoint([pt for d in [Point(xy[i]).buffer(rad[i] + P.raft_margin, 16)
                                            for i in range(len(feet))]
                               for pt in d.exterior.coords]).convex_hull
            ring_w = max(P.raft_margin, 2.0)
            ring = keep.buffer(ring_w).difference(keep)
            joined = unary_union([poly, ring.intersection(hull.buffer(ring_w))])
            if len(getattr(joined, "geoms", [joined])) < len(poly.geoms):
                poly = joined
    if poly.is_empty or poly.area < 1e-6:
        return None
    return poly


def mesh_raft(tree: SupportTree, params: SupportParams) -> Optional[trimesh.Trimesh]:
    if not params.raft_enabled:
        return None
    poly = raft_polygon(tree, params)
    if poly is None:
        return None
    geoms = list(poly.geoms) if hasattr(poly, "geoms") else [poly]
    contours = []
    for g in geoms:
        if g.geom_type != "Polygon" or g.area < 1e-6:
            continue
        contours.append(np.asarray(g.exterior.coords)[:-1])
        for hole in g.interiors:
            contours.append(np.asarray(hole.coords)[:-1])
    if not contours:
        return None
    cs = mf.CrossSection(contours, mf.FillRule.EvenOdd)
    m = mf.Manifold.extrude(cs, float(params.raft_thickness))
    # the raft top is the support base: [0, t] under the feet only (the model is on the
    # plate), [-t, 0] when the model rests on the raft (params.support_base_z)
    z_top = float(getattr(tree, "z_base", support_base_z(params)))
    m = m.translate((0.0, 0.0, z_top - float(params.raft_thickness)))
    return manifold_to_trimesh(m)
