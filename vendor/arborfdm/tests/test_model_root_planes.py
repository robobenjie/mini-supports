"""A model-root position is its planned bottom plane, not a sphere's centre."""
import numpy as np

from arbor.engine import build, verify
from arbor.engine.params import SupportParams
from arbor.engine.types import NodeKind, SupportTree


def _tree(root_z=2.4, x=0.0):
    tree = SupportTree()
    tree.z_base = 0.0
    root = tree.add([x, 0.0, root_z], 0.12, NodeKind.MODEL_FOOT)
    neck = tree.add([x + 0.35, 0.0, root_z + 1.4], 0.45, NodeKind.BRANCH, parent=root.id)
    bend = tree.add([x + 0.4, 0.0, root_z + 2.3], 0.45, NodeKind.BRANCH, parent=neck.id)
    tree.add([x + 0.4, 0.0, root_z + 3.5], 0.18, NodeKind.TIP, parent=bend.id)
    return tree


def _params():
    return SupportParams(nozzle_diameter=.2, line_width=.22, layer_height=.06,
                         min_region_area=.001, raft_enabled=False, braces_enabled=False)


def test_inclined_model_root_keeps_release_plane_in_both_mesh_modes():
    """Before the fix the skirt starts .07mm below the root; the inclined cap also dips."""
    for tubes in (False, True):
        solids = build.tree_solids(_tree(), _params(), tubes=tubes)
        whole = build.mf.Manifold.batch_boolean(solids, build.mf.OpType.Add)
        mesh = build.manifold_to_trimesh(whole)
        assert mesh.is_watertight and mesh.is_winding_consistent
        assert abs(mesh.bounds[0, 2] - 2.4) < 1e-5
        assert abs(mesh.bounds[1, 2] - 5.9) < 1e-5
        # Nothing may consume the declared .06mm release gap over a flat model surface.
        model = build.mf.Manifold.cube((4., 4., 2.34)).translate((-2., -2., 0.))
        assert abs((whole ^ model).volume()) < 1e-9


def test_each_model_root_is_trimmed_at_its_own_height():
    tree = _tree()
    root = tree.add([10., 0., 6.0], .12, NodeKind.MODEL_FOOT)
    branch = tree.add([10.35, 0., 7.4], .45, NodeKind.BRANCH, parent=root.id)
    tree.add([10.35, 0., 8.6], .18, NodeKind.TIP, parent=branch.id)
    solid = build.mesh_tree_manifold(tree, _params())
    bottoms = sorted(float(build.manifold_to_trimesh(part).bounds[0, 2]) for part in solid.decompose())
    assert len(bottoms) == 2
    assert np.allclose(bottoms, [2.4, 6.0], atol=1e-5)


def test_trimmed_skirt_still_supports_itself_above_a_model_surface():
    # Zero root gap isolates the skirt's self-support shape from intentional release-gap
    # validation, which is a separate model/toolpath policy.
    model = build.manifold_to_trimesh(build.mf.Manifold.cube((4., 4., 2.4)).translate((-2., -2., 0.)))
    mesh = build.mesh_tree(_tree(), _params())
    regions = verify.support_layer_regions(mesh, _params(), model_mesh=model)
    assert regions == [], [(r['kind'], r['z'], r['area']) for r in regions]


def test_model_landing_has_a_printable_constant_width_neck():
    """A wide shoulder must not immediately flare inside the unchecked root span."""
    tree = SupportTree()
    tree.z_base = 0.0
    root = tree.add([0., 0., 2.4], .12, NodeKind.MODEL_FOOT)
    shoulder = tree.add([0., 0., 3.6], .6, NodeKind.BRANCH, parent=root.id)
    tree.add([0., 0., 4.8], .18, NodeKind.TIP, parent=shoulder.id)
    params = _params()
    solid = build.mesh_tree_manifold(tree, params)
    model = build.manifold_to_trimesh(build.mf.Manifold.cube((4., 4., 2.4)).translate((-2., -2., 0.)))
    mesh = build.manifold_to_trimesh(solid)
    # The old bottom cone/joint hull already widened substantially at this height.
    cross_section = solid.slice(2.58)
    assert 0.035 < cross_section.area() <= np.pi * .12 ** 2 + 1e-6
    assert mesh.is_watertight and len(solid.decompose()) == 1
    regions = verify.support_layer_regions(mesh, params, model_mesh=model)
    assert regions == [], [(r['kind'], r['z'], r['area']) for r in regions]


def test_compact_ring_junctions_are_closed_and_self_supporting():
    """A steep fork remains connected without a full-radius spherical underside."""
    tree = SupportTree()
    tree.z_base = 0.
    parent = tree.add([0., 0., 0.], 1.3, NodeKind.FOOT)
    for z in range(1, 9):
        parent = tree.add([z * np.tan(np.deg2rad(40.)), 0., z], 1.3,
                          NodeKind.TRUNK, parent=parent.id)
    for sign in [-1, 1]:
        child = tree.add(parent.position + [sign * 2., 0., 3.], .8,
                         NodeKind.BRANCH, parent=parent.id)
        tree.add(child.position + [0., 0., 1.6], .18, NodeKind.TIP, parent=child.id)
    params = _params().updated(circle_segments=24, junction_radius_factor=1.)
    params.compact_junctions = True
    for tubes in (False, True):
        solid = build.mf.Manifold.batch_boolean(build.tree_solids(tree, params, tubes=tubes), build.mf.OpType.Add)
        solid = solid.trim_by_plane((0., 0., 1.), 0.)
        mesh = build.manifold_to_trimesh(solid)
        assert mesh.is_watertight and mesh.is_winding_consistent
        assert len(solid.decompose()) == 1
        regions = verify.support_layer_regions(mesh, params.updated(min_region_area=.02))
        assert regions == [], [(r['kind'], r['z'], r['area']) for r in regions]
        assert solid.volume() > 0


def test_horizontal_structural_rings_stay_inside_planned_z_slabs():
    points = np.array([[0., 0., 3.], [.8, 0., 4.]])
    radii = np.array([1.4, 1.6])
    original = build.manifold_to_trimesh(build.tube(points, radii, 24))
    compact = build.manifold_to_trimesh(build.tube(points, radii, 24, [True, True]))
    assert original.bounds[0, 2] < 2.2
    assert np.allclose(compact.bounds[:, 2], [3., 4.], atol=1e-6)
    assert compact.is_watertight and compact.is_winding_consistent
    # A contact end ring retains the planned tip orientation when explicitly
    # excluded; the experiment changes structural branches, not contact normals.
    contact = build.manifold_to_trimesh(build.tube(points, radii, 24, [True, False]))
    assert contact.bounds[1, 2] > 4.9
