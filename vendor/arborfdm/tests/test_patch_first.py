"""Focused obligations for patch planning before shared tree routing."""
import numpy as np
import trimesh

from arbor.engine.params import load_profiles
from arbor.engine.patch_first import plan_patches, attach_patches
from arbor.engine.tree import build_tree
from arbor.engine.build import mesh_tree_manifold, trimesh_to_manifold
from arbor.engine.types import Contact, ContactReason, NodeKind, Progress


def _params(**kw):
    return load_profiles()["nozzle_02_normal"].params.updated(
        **dict(dict(raft_split=False, removal_groups=False, patch_grid=False,
                    patch_release=False), **kw))


def _box(center=(0, 0, 7), extents=(6, 6, 2)):
    mesh = trimesh.creation.box(extents=extents)
    mesh.apply_translation(center)
    return mesh


def _contact(ident, point, terminal=False):
    return Contact(ident, np.array(point, float), np.array([0., 0., -1.]),
                   ContactReason.ISLAND if not terminal else ContactReason.SURFACE,
                   support_terminal=terminal, tip_diameter=.48 if terminal else None)


def test_patch_terminal_ends_at_joint_without_model_gap_or_penetration():
    params = _params(z_gap=.12, tip_penetration=.1, surface_aligned_tips=False,
                     fit_short_contacts=False)
    contact = _contact(4, [0, 0, 5], terminal=True)
    tree = build_tree(_box(center=(20, 20, 7)), [contact], params, Progress())
    tip = next(n for n in tree.nodes.values() if n.kind == NodeKind.TIP)
    np.testing.assert_allclose(tip.position, contact.position)
    assert tree.support_terminal_ids == {4}
    assert tree.stats()["tips"] == 0
    assert tree.stats()["patch_terminals"] == 1


def test_planned_flat_patch_replaces_redundant_pins_without_forcing_grips():
    mesh = _box()
    original = mesh.vertices.copy()
    contacts = [_contact(i, [x, y, 6]) for i, (x, y) in enumerate(
        [(-2, -2), (-2, 2), (2, -2), (2, 2)])]
    params = _params()
    plan = plan_patches(mesh, contacts, params)
    assert plan.patches
    assert all(p.report["grip"] is None for p in plan.patches)
    tree = build_tree(mesh, contacts + [p.terminal for p in plan.patches], params, Progress())
    attach_patches(tree, plan, mesh, params)
    support = mesh_tree_manifold(tree, params)
    depth = max(params.patch_gap, params.z_gap) + params.layer_height + .005
    assert all(support.ray_cast(c.position - [0, 0, depth], c.position - [0, 0, .001])
               for c in contacts)
    assert tree.patch_covered_contacts
    assert tree.stats()["tips"] == len(contacts) - len(tree.patch_covered_contacts)
    assert tree.patch_first_report["routedTerminals"] == len(plan.patches)
    assert all(cid in tree.support_terminal_ids for cid in tree.patch_terminal_top_z)
    np.testing.assert_array_equal(mesh.vertices, original)


def test_patch_pin_coverage_preserves_holes_edges_heights_and_manual_anchors():
    import manifold3d as mf
    from types import SimpleNamespace
    from arbor.engine.patch_first import _patch_covered_contacts
    params = _params()
    roof = mf.Manifold.cube([4, 4, .3]).translate([-2, -2, 6 - params.patch_gap - .3])
    roof -= mf.Manifold.cylinder(1, .3, .3, 24).translate([1, 0, 5])
    patch = SimpleNamespace(roof=roof, terminal=_contact(20, [0, 0, 4], True))
    contacts = [_contact(i, p) for i, p in enumerate(
        [[0, 0, 6], [1, 0, 6], [1.95, 0, 6], [0, 0, 9], [-1, 0, 6], [1.4, 0, 6]])]
    contacts[4].manual = True
    # ID 5's center has a roof but its contact rim reaches the hole.
    assert _patch_covered_contacts(contacts, [patch], params) == {0: [20]}


def test_patch_pin_pruning_preserves_shared_routes_and_failed_patch_fallbacks():
    from types import SimpleNamespace
    from arbor.engine.patch_first import PatchPlan, PlannedPatch
    from arbor.engine.types import SupportTree
    from arbor.engine.verify import _check_unrouted
    params, mesh = _params(), _box()
    contacts = [_contact(0, [0, 0, 6]), _contact(1, [4, 0, 6]), _contact(2, [.5, 0, 6])]
    roof = trimesh_to_manifold(_box(center=(0, 0, 6 - params.patch_gap - .15), extents=(2, 2, .3)))
    patches = []
    for i, x in enumerate((0, 4)):
        solid = roof.translate([x, 0, 0])
        patches.append(PlannedPatch(_contact(10+i, [x, 0, 4], True), solid, solid,
            trimesh_to_manifold(_box(center=(x, 0, 5.94), extents=(2, 2, .12))), i,
            dict(contactId=i, projectedAreaMm2=4., bounds=list(solid.bounding_box()), grip=None)))
    plan = PatchPlan(patches, SimpleNamespace(model=trimesh_to_manifold(mesh)), {}, False, contacts)
    tree = SupportTree(); tree.support_terminal_ids = {10, 11}
    root = tree.add([0, 0, 0], .7, NodeKind.FOOT)
    hub = tree.add([0, 0, 2], .5, NodeKind.TRUNK, parent=root.id)
    terminal = tree.add([0, 0, 4], .24, NodeKind.TIP, parent=hub.id, contact_id=10)
    twig = tree.add([0, 1, 3], .4, NodeKind.BRANCH, parent=hub.id, contact_id=0)
    redundant = tree.add([0, 0, 5.94], .18, NodeKind.TIP, parent=twig.id, contact_id=0)
    fallback = tree.add([4, 0, 5.94], .18, NodeKind.TIP, parent=hub.id, contact_id=1)
    tree.failed = {2: "No point route", 11: "No patch route"}
    tree.braces = [(hub.position, twig.position, .3), (root.position, hub.position, .3)]
    attach_patches(tree, plan, mesh, params)
    assert tree.patch_covered_contacts == {0: [10], 2: [10]}
    assert redundant.id not in tree.nodes and twig.id not in tree.nodes
    assert all(n.id in tree.nodes for n in (root, hub, terminal, fallback))
    assert len(tree.braces) == 1 and len(tree.patch_solids) == 1
    assert 2 not in tree.failed and 11 in tree.failed
    issues = []
    assert _check_unrouted(contacts, tree, issues) == {0, 1, 2}
    assert not issues


def test_redundant_pin_removes_exclusive_root_and_its_stabilizer():
    from arbor.engine.patch_first import _prune_tip_paths
    from arbor.engine.types import SupportTree
    tree = SupportTree()
    root = tree.add([0, 0, 0], .7, NodeKind.FOOT)
    tip = tree.add([0, 0, 8], .2, NodeKind.TIP, parent=root.id, contact_id=0)
    foot = tree.add([2, 0, 0], .5, NodeKind.FOOT)
    brace = (foot.position, (root.position + tip.position)/2, .4)
    tree.braces = [brace]; tree._raft_split_original_braces = [brace]
    tree._stability_braces = [(root.id, foot.id, brace)]
    tree.foot_radius = {root.id: 1., foot.id: 1.}
    assert _prune_tip_paths(tree, [tip.id], {0}) == 3
    assert not tree.nodes and not tree.braces and not tree.foot_radius
    assert not tree._raft_split_original_braces and not tree._stability_braces


def test_split_rerouting_reuses_crowns_outside_corridor():
    mesh = trimesh.util.concatenate([
        _box(center=(-6, 0, 7), extents=(4, 4, 2)),
        _box(center=(6, 0, 7), extents=(4, 4, 2))])
    contacts = [_contact(0, [-6, 0, 6]), _contact(1, [6, 0, 6])]
    params = _params()
    first = plan_patches(mesh, contacts, params)
    assert first.context.axis == 0
    split = plan_patches(mesh, contacts, params.updated(removal_groups=True), previous=first)
    assert len(split.patches) == len(first.patches) > 0
    assert split.report["tileAttempts"] == 0
    assert split.report["reusedPatches"] == len(first.patches)
    assert {p.report["removalSide"] for p in split.patches} == {-1, 1}
    assert len({p.terminal.id for p in split.patches}) == len(split.patches)
    assert not ({c.id for c in contacts} & {p.terminal.id for p in split.patches})


def test_preplanned_release_grip_retains_printable_neck_and_roof_gap():
    mesh = _box()
    contacts = [_contact(i, [x, y, 6]) for i, (x, y) in enumerate(
        [(-2, -2), (-2, 2), (2, -2), (2, 2)])]
    params = _params(patch_release=True, patch_grip_diameter=1.6,
                     patch_release_grip_length=1.6)
    plan = plan_patches(mesh, contacts, params)
    assert plan.patches
    for patch in plan.patches:
        grip = patch.report["grip"]
        assert grip is not None
        assert abs(grip["diameterMm"] - 1.6) < 1e-8
        assert abs(grip["lengthMm"] - 1.6) < 1e-8
        assert patch.terminal.tip_diameter < grip["diameterMm"] / 2
        assert abs(patch.roof.bounding_box()[5] - (6 - params.patch_gap)) < 1e-5
    tree = build_tree(mesh, contacts + [p.terminal for p in plan.patches], params, Progress())
    attach_patches(tree, plan, mesh, params)
    support = mesh_tree_manifold(tree, params)
    assert (support ^ trimesh_to_manifold(mesh)).volume() < 1e-6
    # Every component is rooted on this fixture's raft; no crown or grip starts
    # in midair after meshing and the terminal-to-grip union.
    assert all(part.bounding_box()[2] <= tree.z_base + .01
               for part in support.decompose() if part.volume() > .001)
    depth = params.patch_gap + params.layer_height + .005
    assert all(support.ray_cast(c.position - [0, 0, depth], c.position - [0, 0, .001])
               for c in contacts)


def test_narrow_attachment_keeps_roof_demands_in_tight_model_clearance():
    from types import SimpleNamespace
    from arbor.engine.patch_first import _attachment
    from arbor.engine.patches import _CollisionWindows
    params = _params(patch_release=True)
    xy = np.array([[-.2, -.2], [.2, -.2], [.2, .2], [-.2, .2]])
    for clearance, expected_radius, has_grip in [(.6, .55, True), (.5, .45, False)]:
        # The preferred 1.6 mm handle collides with both walls. A short narrow
        # handle (or ordinary feeder in the tighter slot) can carry the roof.
        mesh = trimesh.util.concatenate([
            _box(center=(-clearance-.1, 0, 4.5), extents=(.2, 3, 5)),
            _box(center=(clearance+.1, 0, 4.5), extents=(.2, 3, 5))])
        model = trimesh_to_manifold(mesh)
        keepout = model.translate([0, 0, -params.patch_gap])
        context = SimpleNamespace(windows=_CollisionWindows(model, keepout, len(mesh.faces)))
        attachment = _attachment(context, xy, np.full(4, 7.), None, 0, .25, params, 1.)
        assert attachment is not None and attachment["fallback"]
        assert abs(attachment["radius"] - expected_radius) < 1e-8
        assert (attachment["grip"] is not None) == has_grip
        solid = attachment["grip"] if has_grip else attachment["hub"]
        assert (solid ^ keepout).volume() < 1e-7
        assert (solid ^ model).volume() < 1e-7


def test_patch_notch_closing_is_local_and_preserves_candidate_outline():
    from arbor.engine.patch_first import _close_patch_notches
    assert not len(_close_patch_notches(np.empty((0, 2)), np.zeros(0, bool), .25))
    x, y = np.meshgrid(np.arange(40), np.arange(32))
    cells = np.column_stack([x.ravel(), y.ravel()])
    # A true hole in the sculpture is absent from the candidate surface.
    candidate = ~((cells[:, 0] == 7) & (cells[:, 1] == 7))
    cells = cells[candidate]
    selected = np.ones(len(cells), dtype=bool)
    short = ((cells[:, 0] >= 6) & (cells[:, 0] <= 8)
             & (cells[:, 1] >= 5) & (cells[:, 1] <= 12))
    broad = ((cells[:, 0] >= 20) & (cells[:, 0] <= 32)
             & (cells[:, 1] >= 8) & (cells[:, 1] <= 24))
    selected[short | broad] = False
    closed = _close_patch_notches(cells * .25, selected, .25)
    assert len(closed) == len(cells)
    assert np.all(closed[selected])
    assert np.all(closed[short])
    assert not closed[np.flatnonzero((cells == [26, 16]).all(axis=1))[0]]
    assert not np.any((cells[closed] == [7, 7]).all(axis=1))


def test_narrowed_patch_foundation_discards_crown_and_only_unused_routes():
    from arbor.engine.types import SupportTree
    mesh = _box()
    params = _params(patch_release=True)
    plan = plan_patches(mesh, [_contact(0, [0, 0, 6])], params)
    assert len(plan.patches) >= 2
    plan.patches = plan.patches[:2]
    tree = SupportTree()
    tree.support_terminal_ids = {p.terminal.id for p in plan.patches}
    tree.foot_radius = {}
    paths = []
    for patch in plan.patches:
        top = patch.terminal.position
        root = tree.add(top - [0, 0, 1], .12, NodeKind.MODEL_FOOT)
        branch = tree.add(top - [0, 0, .97], .095, NodeKind.BRANCH,
                          parent=root.id, contact_id=patch.terminal.id)
        tip = tree.add(top, .24, NodeKind.TIP, parent=branch.id, contact_id=patch.terminal.id)
        paths.append((root, branch, tip))
    # The second narrow route also carries an original model pin: keep it.
    original = tree.add(paths[1][1].position + [1, 0, .8], .12, NodeKind.TIP,
                        parent=paths[1][1].id, contact_id=0)
    stabilizer = tree.add(paths[0][0].position + [0, 2, 0], .5, NodeKind.FOOT)
    tree.foot_radius[stabilizer.id] = 1.
    discarded = (stabilizer.position + [0, 0, .2], paths[0][1].position, .3)
    retained = (paths[1][1].position, original.position, .3)
    tree.braces = [discarded, retained]
    tree._raft_split_original_braces = list(tree.braces)
    tree._stability_braces = [(paths[0][0].id, stabilizer.id, discarded)]
    attach_patches(tree, plan, mesh, params)
    assert not tree.patch_solids
    assert all(n.id not in tree.nodes for n in paths[0])
    assert stabilizer.id not in tree.nodes and stabilizer.id not in tree.foot_radius
    assert all(n.id in tree.nodes for n in paths[1][:2])
    assert paths[1][2].id not in tree.nodes and original.id in tree.nodes
    assert len(tree.braces) == len(tree._raft_split_original_braces) == 1
    assert np.array_equal(tree.braces[0][0], retained[0])
    assert not tree._stability_braces
    assert all("below one printable line" in tree.failed[cid] for cid in tree.support_terminal_ids)
    assert tree.stats()["tips"] == 1 and tree.stats()["patch_terminals"] == 0


def test_floating_check_ignores_numeric_residue_but_reports_real_disconnected_support():
    from arbor.engine.types import SupportTree
    from arbor.engine.verify import _check_mesh
    model, params = _box(center=(20, 0, 5)), _params()
    for dimensions, floating in [((.01, .01, .0001), False), ((1, 1, .2), True)]:
        issues = []
        _check_mesh(model, _box(center=(0, 0, 10), extents=dimensions),
                    SupportTree(), [], params, issues)
        assert any(i.code == 'floating_support' for i in issues) == floating
