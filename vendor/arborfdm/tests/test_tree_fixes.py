"""Regression tests for the tree router fixes (tree.py):

- ModelGrid.top_below never reports a "surface" beside a wall (point inside material);
- tips next to a wall / leg tilt away from it so their branch can reach the plate;
- node radii keep clearance in the slab below the node too (trunks passing over a low
  ledge or the figurine base disk do not dig into it);
- landing on the model never drops a segment through an intervening part.
"""
from __future__ import annotations

from functools import lru_cache

import manifold3d as mf
import numpy as np
import pytest

from arbor.engine import build, params, pipeline
from arbor.engine import tree as T
from arbor.engine.types import Contact, ContactReason, NodeKind, Progress, SupportTree
from tests.models import synthetic as S


@lru_cache(maxsize=None)
def prm():
    return params.load_profiles()["nozzle_04_normal"].params


_RES: dict = {}


def run(name):
    if name not in _RES:
        _RES[name] = pipeline.generate(S.GENERATORS[name]().copy(), prm())
    return _RES[name]


def overlap(support_mesh, solid: mf.Manifold) -> float:
    return (build.trimesh_to_manifold(support_mesh) ^ solid).volume()


def _router(mesh, contact_pos, z_base: float = 0.0):
    c = Contact(0, np.asarray(contact_pos, float), np.array([0.0, 0.0, -1.0]), ContactReason.MANUAL)
    tree = SupportTree()
    T._init_tree_extras(tree, z_base)
    r = T._Router(mesh, [c], prm(), tree, Progress())
    r._prepare()
    r.landed, r.fail_nodes = [], {}
    return r


# ---------------------------------------------------------------------------
def test_top_below_ignores_material_beside_point():
    m = S.shelf()                     # wall x 0..4 (z 0..30), shelf x 3.5..19, z 20..23
    g = T.ModelGrid(m, 0.25)
    assert g.top_below((2.0, 10.0), 15.0) is None        # inside the wall: no surface
    assert g.top_below((10.0, 10.0), 15.0) is None       # under the shelf: nothing below
    assert g.top_below((10.0, 10.0), 25.0) == pytest.approx(23.0, abs=1e-6)
    assert g.top_below((2.0, 10.0), 35.0) == pytest.approx(30.0, abs=1e-6)


def test_shelf_tips_near_wall_tilt_away_and_reach_plate():
    res = run("shelf")
    nodes = res.tree.nodes
    near = [n for n in nodes.values() if n.kind == NodeKind.TIP and n.position[0] < 5.0]
    assert near, "expected contacts close to the wall"
    def wall_dist(p):          # XY distance to the wall footprint x 0..4, y 0..20
        dx = max(0.0, p[0] - 4.0, -p[0])
        dy = max(0.0, p[1] - 20.0, -p[1])
        return float(np.hypot(dx, dy))

    for n in near:
        base = nodes[n.parent]
        assert wall_dist(base.position) > wall_dist(n.position) + 0.5, \
            "tip next to the wall not tilted away"
    assert res.tree.stats()["model_feet"] == 0
    assert all(not c.rests_on_model for c in res.contacts if c.enabled)


def test_crossing_case_trunks_do_not_dig_into_base_plate():
    res = run("crossing_case")
    base = mf.Manifold.cube((26.0, 16.0, 2.0)).translate((0.0, -2.0, 0.0))
    # was ~8 mm3 when node radii only respected the slab above the node
    assert overlap(res.support_mesh, base) < 2.0


def test_figurine_supports_do_not_cross_legs():
    res = run("figurine")
    for sx in (-1, 1):
        leg = mf.Manifold.cylinder(23.0, 2.5, 2.5, 64).translate((sx * 4.0, 0.0, 3.0))
        # was ~15 mm3 per leg: blocked nodes dropped a straight segment through the leg
        assert overlap(res.support_mesh, leg) < 0.5


def test_landing_path_rejects_drop_through_model():
    floor = S._box((-15, -15, 0), (15, 15, 3))
    bar = S._box((-5, -15, 8), (5, 15, 10))
    blocked = _router(S._to_trimesh(S._union([floor, bar])), (0.0, 0.0, 16.0))
    free = _router(S._to_trimesh(floor), (0.0, 0.0, 16.0))
    for r, expect in ((blocked, False), (free, True)):
        n = r.tree.add([0.0, 0.0, 14.0], 0.5, NodeKind.BRANCH)
        assert r._land_path_clear(n.id, np.array([0.0, 0.0]), 14.0, 3.0) is expect
    # a tilted landing beyond the bar still crosses it
    n = blocked.tree.add([0.0, 0.0, 14.0], 0.5, NodeKind.BRANCH)
    assert not blocked._land_path_clear(n.id, np.array([8.0, 0.0]), 14.0, 3.0)


@pytest.mark.parametrize("lip_x, clearance, expected_clear", [
    (None, 0.1, True), (0.08, 0.1, False), (0.08, 0.01, False),
    (0.16, 0.1, False), (0.16, 0.01, True),
])
def test_landing_neck_checks_model_above_local_contact(lip_x, clearance, expected_clear):
    """A thin stem must not enter a lip below its previously checked tip base."""
    p = params.SupportParams(layer_height=0.06, z_gap=0.06, tip_penetration=0,
                             raft_enabled=False, allow_on_model=True,
                             on_model_tip_diameter=0.24, line_width=0.22, tip_length=1.2,
                             model_neck_clearance=clearance)
    solids = [S._box((-3, -3, 0), (3, 3, 1))]
    if lip_x is not None:
        # The lip crosses the narrow stem 0.15–0.65mm above the landing floor,
        # entirely below the 1.2mm tip base checked by the former planner.
        solids.append(S._box((lip_x, -0.5, 1.15), (lip_x + 0.1, 0.5, 1.65)))
    mesh = S._to_trimesh(S._union(solids))
    c = Contact(0, np.array([0., 0., 6.]), np.array([0., 0., -1.]), ContactReason.MANUAL)
    tree = SupportTree()
    T._init_tree_extras(tree, 0)
    router = T._Router(mesh, [c], p, tree, Progress())
    router._prepare()
    node = tree.add([0., 0., 4.], 0.5, NodeKind.BRANCH)
    assert router._land_path_clear(node.id, np.array([0., 0.]), 4., 1.) is expected_clear


def test_failed_tip_route_retries_another_axis_without_dropping_contact(monkeypatch):
    """A free tip centre in a narrow slot can still trap its first full branch."""
    p = params.SupportParams(layer_height=0.06, z_gap=0.06, tip_penetration=0,
                             raft_enabled=False, allow_on_model=True,
                             on_model_tip_diameter=0.24, line_width=0.22,
                             tip_length=1.2, model_neck_clearance=0.01,
                             compact_junctions=True, branch_angle_deg=40,
                             branch_min_diameter=1.2, braces_enabled=False)
    mesh = S._to_trimesh(S._union([
        S._box((-4, -5, 0), (4, 5, 0.4)),
        S._box((0.25, -5, 0.4), (0.5, 5, 9.4)),
        S._box((1.05, -5, 0.4), (1.4, 5, 9.4)),
        S._box((-0.5, -0.5, 10), (0.5, 0.5, 10.5)),
    ]))
    contact = Contact(0, np.array([0., 0., 10.]), np.array([0., 0., -1.]), ContactReason.MANUAL)
    trapped = np.array([np.sin(np.radians(40)), 0., -np.cos(np.radians(40))])
    monkeypatch.setattr(T._Router, "_tip_dir", lambda self, pos, normal: trapped.copy())
    retry = T._Router._retry_failed_tips
    monkeypatch.setattr(T._Router, "_retry_failed_tips", lambda self: None)
    before = T.build_tree(mesh, [contact], p, Progress())
    assert 0 in before.failed
    monkeypatch.setattr(T._Router, "_retry_failed_tips", retry)
    after = T.build_tree(mesh, [contact], p, Progress())
    assert 0 not in after.failed
    assert any(n.kind == NodeKind.TIP and n.contact_id == 0 for n in after.nodes.values())
    assert after.routing_retries[0]["accepted"]
    np.testing.assert_allclose(after.contact_normals[0], [0, 0, -1])
    np.testing.assert_allclose(contact.normal, [0, 0, -1])

    # Add a good distant branch and inspect the isolated retry operation before
    # subsequent widening/brace stages. Its graph and dimensions must survive.
    two_model = S._to_trimesh(S._union([
        build.trimesh_to_manifold(mesh), S._box((-8.5, -0.5, 10), (-7.5, 0.5, 10.5)),
        S._box((-11, -3, 0), (-5, 3, 0.4)),
    ]))
    second = Contact(1, np.array([-8., 0., 10.]), np.array([0., 0., -1.]), ContactReason.MANUAL)
    main = SupportTree()
    T._init_tree_extras(main, 0)
    router = T._Router(two_model, [contact, second], p, main, Progress())
    router._prepare()
    router._make_tips()
    router._route()
    router._cleanup()
    assert 0 in main.failed and 1 not in main.failed
    snapshot = {key: (n.position.copy(), n.radius, n.parent, n.kind, n.contact_id)
                for key, n in main.nodes.items()}
    assert snapshot
    router._retry_failed_tips()
    assert 0 not in main.failed
    for key, (position, radius, parent, kind, contact_id) in snapshot.items():
        node = main.nodes[key]
        np.testing.assert_array_equal(node.position, position)
        assert (node.radius, node.parent, node.kind, node.contact_id) == (radius, parent, kind, contact_id)


@pytest.mark.parametrize("lip_x, expected_clear", [(-0.13, True), (0.0, False)])
def test_compact_landing_checks_intersection_of_root_and_inclined_tube(lip_x, expected_clear):
    """A nearby lip outside the inclined tube must not block its vertical envelope."""
    p = params.SupportParams(layer_height=0.06, z_gap=0.06, tip_penetration=0,
                             raft_enabled=False, allow_on_model=True,
                             on_model_tip_diameter=0.24, line_width=0.22,
                             tip_length=1.2, model_neck_clearance=0.01,
                             compact_junctions=True, branch_angle_deg=40)
    floor = S._box((-3, -3, 0), (3, 3, 1))
    lip = S._box((lip_x, -0.15, 1.65), (lip_x + 0.03, 0.15, 1.70))
    mesh = S._to_trimesh(S._union([floor, lip]))
    c = Contact(0, np.array([0., 0., 6.]), np.array([0., 0., -1.]), ContactReason.MANUAL)
    tree = SupportTree()
    T._init_tree_extras(tree, 0)
    router = T._Router(mesh, [c], p, tree, Progress())
    router._prepare()
    node = tree.add([0.35, 0., 2.2], 0.35, NodeKind.BRANCH)
    assert router._land_path_clear(node.id, np.array([0., 0.]), 2.2, 1.) is expected_clear


@pytest.mark.parametrize("angle", [0.0, 15.0])
def test_landing_uses_exact_surface_at_candidate_xy(angle):
    import trimesh
    p = params.SupportParams(layer_height=0.06, z_gap=0.06, tip_penetration=0,
                             raft_enabled=False, allow_on_model=True,
                             on_model_tip_diameter=0.24, line_width=0.22,
                             tip_length=1.2, model_neck_clearance=0.01)
    mesh = trimesh.creation.box(extents=[6, 6, 1])
    mesh.apply_transform(trimesh.transformations.rotation_matrix(np.radians(angle), [0, 1, 0]))
    mesh.apply_translation([0, 0, 1])
    c = Contact(0, np.array([0., 0., 8.]), np.array([0., 0., -1.]), ContactReason.MANUAL)
    tree = SupportTree()
    T._init_tree_extras(tree, 0)
    router = T._Router(mesh, [c], p, tree, Progress())
    router._prepare()
    router.landed, router.fail_nodes = [], {}
    node = tree.add([0., 0., 5.], 0.5, NodeKind.BRANCH)
    exact_top = 1 + 0.5 / np.cos(np.radians(angle))
    # A cell-centre sample can differ from the chosen XY on a slope. Preserve
    # the candidate but deliberately bias its coarse height to test correction.
    router.grid.top_below = lambda q, z: exact_top + 0.15 if np.linalg.norm(q) < 1e-9 else None
    router._blocked(node.id, np.array([0., 0.]), 5., 0.5)
    feet = [n for n in tree.nodes.values() if n.kind == NodeKind.MODEL_FOOT]
    assert len(feet) == 1
    assert feet[0].position[2] == pytest.approx(exact_top, abs=1e-7)


def test_blocked_node_fails_instead_of_cutting_through():
    """A node boxed in above a bar with no clear landing spot is reported, not landed."""
    floor = S._box((-15, -15, 0), (15, 15, 3))
    bar = S._box((-12, -12, 8), (12, 12, 10))
    r = _router(S._to_trimesh(S._union([floor, bar])), (0.0, 0.0, 16.0))
    n = r.tree.add([0.0, 0.0, 10.5], 0.5, NodeKind.BRANCH)
    r._blocked(n.id, np.array([0.0, 0.0]), 10.5, 0.5)
    # lands on the bar top (z = 10) right below, never on the floor through the bar
    feet = [m for m in r.tree.nodes.values() if m.kind == NodeKind.MODEL_FOOT]
    assert len(feet) == 1 and feet[0].position[2] > 9.0
    n2 = r.tree.add([0.0, 0.0, 7.5], 0.5, NodeKind.BRANCH)   # under the bar
    r._blocked(n2.id, np.array([0.0, 0.0]), 7.5, 0.5)
    feet = [m for m in r.tree.nodes.values() if m.kind == NodeKind.MODEL_FOOT]
    assert len(feet) == 2 and min(f.position[2] for f in feet) < 3.5


# ---------------------------------------------------------------------------
# short supports: contact less than a tip length above a surface
# ---------------------------------------------------------------------------
def _budget(n_contacts, p):
    r = p.tip_base_diameter / 2
    return n_contacts * np.pi * r * r * (p.tip_penetration + 0.15) + 0.5


def test_sphere_on_plate_short_supports_stand_on_model_plate():
    p = prm()
    m = S.sphere_on_plate()
    res = pipeline.generate(m.copy(), p)
    act = [c for c in res.contacts if c.enabled]
    assert act and not res.tree.failed, res.tree.failed
    feet = [n for n in res.tree.nodes.values() if n.kind == NodeKind.MODEL_FOOT]
    assert len(feet) == len(act)
    for f in feet:   # on the model plate top (z = 2), sunk by tip_penetration
        assert f.position[2] == pytest.approx(2.0 - p.tip_penetration, abs=1e-3)
    assert all(c.rests_on_model for c in act)
    assert res.support_mesh.is_watertight
    assert overlap(res.support_mesh, build.trimesh_to_manifold(m)) <= _budget(len(act), p)


def test_short_support_to_build_plate_has_low_foot_and_no_collar():
    # no raft: this test is about a short support down to the bare plate (the raft is on
    # by default since the raft-coverage iteration)
    p = prm().updated(raft_enabled=False)
    m = S.floating_cube(10.0, 1.0)        # underside 1 mm above the plate
    res = pipeline.generate(m.copy(), p)
    act = [c for c in res.contacts if c.enabled]
    assert act and not res.tree.failed, res.tree.failed
    st = res.tree.stats()
    assert st["model_feet"] == 0 and st["feet"] == len(act)
    sm = res.support_mesh
    assert sm.is_watertight and sm.bounds[0, 2] >= -1e-6
    assert overlap(sm, build.trimesh_to_manifold(m)) <= _budget(len(act), p)


def test_contact_below_one_layer_is_reported_not_built():
    p = prm()
    m = S.floating_cube(10.0, 0.1)        # 0.1 mm < layer_height (0.12): nothing printable
    cs = [Contact(i, np.array([x, 0.0, 0.1]), np.array([0.0, 0.0, -1.0]), ContactReason.MANUAL,
                  manual=True) for i, x in enumerate((-2.0, 2.0))]
    res = pipeline.generate(m.copy(), p, contacts=cs)
    tips = {n.contact_id for n in res.tree.nodes.values() if n.kind == NodeKind.TIP}
    for c in cs:
        assert c.id not in tips
        assert "less than one layer" in res.tree.failed[c.id]


def test_short_support_on_model_respects_allow_on_model():
    p = prm().updated(allow_on_model=False)
    res = pipeline.generate(S.sphere_on_plate(), p)
    act = [c for c in res.contacts if c.enabled]
    assert act
    for c in act:
        assert "supports on the model are disabled" in res.tree.failed[c.id]
    assert res.tree.stats()["model_feet"] == 0


@pytest.mark.parametrize("free_height,expected", [(0.15, True), (0.11, False)])
def test_short_support_counts_top_air_gap_once(free_height, expected):
    """The air gap is reserved once; a remaining full layer can support the roof."""
    p = prm().updated(layer_height=0.06, z_gap=0.06, tip_penetration=0,
                      raft_enabled=False, allow_on_model=True)
    floor = S._box((-3, -3, 0), (3, 3, 1))
    roof = S._box((-2, -2, 1 + free_height), (2, 2, 2))
    mesh = S._to_trimesh(S._union([floor, roof]))
    contact = Contact(0, np.array([0.0, 0.0, 1 + free_height]),
                      np.array([0.0, 0.0, -1.0]), ContactReason.MANUAL, manual=True)
    tree = T.build_tree(mesh, [contact], p, Progress())
    tips = [n for n in tree.nodes.values() if n.kind == NodeKind.TIP]
    assert bool(tips) is expected
    if expected:
        assert not tree.failed
        tip = tips[0]
        foot = tree.nodes[tip.parent]
        assert foot.kind == NodeKind.MODEL_FOOT
        assert tip.position[2] - foot.position[2] == pytest.approx(free_height - p.z_gap)
        assert tip.position[2] - foot.position[2] >= p.layer_height
    else:
        assert "less than one layer" in tree.failed[contact.id]


def test_ray_down_is_exact():
    m = S.sphere_on_plate()
    r = _router(m, (0.0, 0.0, 16.0))
    assert r._ray_down(np.array([4.75, 0.0, 2.15])) == pytest.approx(2.0, abs=1e-6)
    assert r._ray_down(np.array([20.0, 0.0, 5.0])) is None
    fl = r._floor_below(np.array([4.75, 0.0, 2.15]))
    assert fl is not None and fl[0] == pytest.approx(2.0, abs=1e-6) and not fl[1]


# ---------------------------------------------------------------------------
# QA-9: routing levels shift with z_base (raft); tip clearance must not depend on it
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("z_base", [0.0, 0.8])
def test_tip_base_clearance_ignores_material_below_its_segment(z_base):
    """A ledge top 1.5 mm under a vertical tip base, 0.5 mm aside: the base and its first
    segment never reach the ledge, whatever the level offset (raft or not)."""
    ledge = S._to_trimesh(S._box((0, -5, 0), (10, 5, 10)))
    r = _router(ledge, (10.5, 0.0, 13.1), z_base=z_base)
    c = r._base_clearance(np.array([10.5, 0.0, 13.1]), np.array([0.0, 0.0, -1.0]))
    assert c > 2.0, c


def test_raft_keeps_every_figurine_contact_routed():
    p = prm()
    m = S.figurine()
    a = pipeline.generate(m.copy(), p.updated(raft_enabled=False))
    b = pipeline.generate(m.copy(), p.updated(raft_enabled=True))
    assert not a.tree.failed and not b.tree.failed, b.tree.failed
    n = sum(c.enabled for c in b.contacts)
    assert overlap(b.support_mesh, build.trimesh_to_manifold(m)) <= _budget(n, p)
    # results are in the model frame: with the model resting on the raft the plate is at
    # b.plate_z (< 0) and the supports start on the raft top
    assert b.support_mesh.bounds[0, 2] >= b.plate_z + p.raft_thickness - 1e-3
