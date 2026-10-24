"""Independent physical-geometry checks for the opt-in raft removal seam.

Fixtures are deliberately synthetic. They validate foundation/connectivity behavior,
not mechanical strength or a collision-free extraction path around a real miniature.
"""
import copy
import json
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import trimesh
from shapely.geometry import LineString, Point, box

from arbor.engine import build as B, tree as T, raft_split as R
from arbor.engine.params import SupportParams, support_base_z
from arbor.engine.types import AnalysisResult, NodeKind, Progress, SupportTree


def _params(**overrides):
    return SupportParams(nozzle_diameter=.2, line_width=.22, layer_height=.06,
                         raft_enabled=True, raft_coverage='feet', raft_margin=2.,
                         raft_thickness=.8, raft_lift_auto=False, raft_split=True,
                         raft_split_gap=.6, circle_segments=24, compact_junctions=True,
                         foot_diameter=3.2, foot_height=.8, collar_height=1.5,
                         trunk_diameter=1.4, tip_diameter=.36, tip_base_diameter=.7,
                         branch_angle_deg=40., brace_diameter=.8,
                         brace_min_height=12., brace_spacing_z=6., brace_max_length=15.
                         ).updated(**overrides)


def _fixture(params=None, coordinates=None, height=27.):
    params = params or _params()
    if coordinates is None:
        angles = np.radians(np.arange(8) * 45. + 22.5)
        coordinates = np.column_stack([12. * np.cos(angles), 12. * np.sin(angles)])
    result = SupportTree()
    T._init_tree_extras(result, support_base_z(params))
    result.model_base = Point(0., 0.).buffer(1., 32)
    result.model_xy_bounds = (-6., -6., 6., 6.)
    result.raft_keepout = Point(0., 0.).buffer(6.25, 32)
    result.contact_normals = {}
    for contact_id, (x, y) in enumerate(coordinates):
        root = result.add([x, y, result.z_base], .7, NodeKind.FOOT)
        result.foot_radius[root.id] = 1.6
        parent = root
        for z in [z for z in [3., 9., 15., 21.] if z < height - 1.2] + [height - 1.2]:
            if z > parent.position[2]:
                parent = result.add([x, y, z], .7, NodeKind.TRUNK, parent=parent.id)
        result.add([x, y, height], .18, NodeKind.TIP,
                   parent=parent.id, contact_id=contact_id)
        result.contact_normals[contact_id] = np.array([0., 0., -1.])
    return result


def _snapshot(tree):
    return {key: (tuple(n.position), n.radius, n.kind, n.parent, n.contact_id)
            for key, n in tree.nodes.items()}


def _brace_router(tree, params):
    # A deliberately empty obstacle field isolates the seam rule: no brace may
    # disappear merely because an unrelated model collision happened to block it.
    router = T._Router(trimesh.creation.box([2., 2., 2.]), [], params, tree, Progress())
    router.grid = SimpleNamespace(res=.25)
    router.mdist = lambda k, xy: (float('inf'), None)
    return router


def _union(tree, params):
    support = B.mesh_tree(tree, params)
    raft = B.mesh_raft(tree, params)
    solids = [B.trimesh_to_manifold(support)]
    if raft is not None:
        solids.append(B.trimesh_to_manifold(raft))
    return B.mf.Manifold.batch_boolean(solids, B.mf.OpType.Add), support, raft


def _assert_all_feet_founded(tree, params, raft_polygon):
    for foot in tree.roots():
        if foot.kind == NodeKind.FOOT:
            radius = max(foot.radius, tree.foot_radius.get(foot.id, params.foot_diameter / 2))
            disk = Point(*foot.position[:2]).buffer(radius, 64)
            # A different polygon tessellation can leave microscopic arcs only;
            # the full actual foot radius, not its center, must be supported.
            assert disk.difference(raft_polygon.buffer(2e-5)).area < 1e-7, foot.id


def _assert_grounded_components(solid, params, tree, expected):
    pieces = solid.decompose()
    assert len(pieces) == expected, len(pieces)
    for piece in pieces:
        mesh = B.manifold_to_trimesh(piece)
        assert mesh.is_watertight and mesh.is_winding_consistent
        assert abs(mesh.bounds[0, 2] - (tree.z_base - params.raft_thickness)) < 1e-5
        assert piece.volume() > 1.


def _assert_only_seam_removed(original, split, report):
    assert split.difference(original).area < 1e-8, 'Split added material outside original raft'
    if report.get('path_xy'):
        seam = LineString(report['path_xy']).buffer(report['gap'] / 2, cap_style=2, join_style=1)
    else:
        normal = np.asarray(report['normal'])
        tangent = np.array([-normal[1], normal[0]])
        origin = normal * report['offset']
        reach = 4 * np.linalg.norm(np.asarray(original.bounds)) + 100.
        seam = LineString([origin - reach * tangent, origin + reach * tangent]).buffer(
            report['gap'] / 2, cap_style=2)
    removed = original.difference(split)
    expected = original.intersection(seam)
    assert removed.symmetric_difference(expected).area < 1e-7, 'Raft outline changed beyond narrow seam'


def test_split_ring_produces_two_real_grounded_components_and_preserves_contacts():
    params = _params()
    tree = _fixture(params)
    before = _snapshot(tree)
    original_raft = B.raft_polygon(tree, params)
    report = R.plan_split(tree, params)
    assert report['status'] == 'planned', report
    _brace_router(tree, params)._braces()
    whole, support, raft = _union(tree, params)
    assert R.finalize_split(tree, params, support, raft), tree.raft_split_report
    assert tree.raft_split_report['status'] == 'applied'
    _assert_grounded_components(whole, params, tree, 2)
    _assert_all_feet_founded(tree, params, B.raft_polygon(tree, params))
    _assert_only_seam_removed(original_raft, B.raft_polygon(tree, params), tree.raft_split_report)
    assert _snapshot(tree) == before, 'Splitting changed a tip, support route, radius, or parent'


def test_disabled_mode_keeps_exact_raft_nodes_and_braces():
    params = _params(raft_split=False)
    tree = _fixture(params)
    _brace_router(tree, params)._braces()
    polygon = B.raft_polygon(tree, params)
    before = _snapshot(tree)
    braces = [(tuple(a), tuple(b), r) for a, b, r in tree.braces]
    whole_before, _, _ = _union(tree, params)
    R.plan_split(tree, params)
    assert B.raft_polygon(tree, params).equals_exact(polygon, 0.)
    assert _snapshot(tree) == before
    assert [(tuple(a), tuple(b), r) for a, b, r in tree.braces] == braces
    whole_after, _, _ = _union(tree, params)
    assert abs((whole_before - whole_after).volume()) < 1e-9
    assert abs((whole_after - whole_before).volume()) < 1e-9
    _assert_grounded_components(whole_after, params, tree, 1)


def test_model_on_raft_keeps_the_entire_original_model_base_foundation():
    params = _params(raft_coverage='footprint')
    tree = _fixture(params)
    original = B.raft_polygon(tree, params)
    before = _snapshot(tree)
    report = R.plan_split(tree, params)
    assert report['status'] == 'planned', report
    split = B.raft_polygon(tree, params)
    assert tree.model_base.difference(split).area < 1e-9
    _assert_all_feet_founded(tree, params, split)
    assert split.area < original.area and _snapshot(tree) == before
    _assert_only_seam_removed(original, split, report)
    whole, support, raft = _union(tree, params)
    assert R.finalize_split(tree, params, support, raft), tree.raft_split_report
    _assert_grounded_components(whole, params, tree, 2)


def test_bent_seam_preserves_a_wide_base_when_no_straight_seam_is_accepted():
    params = _params(raft_coverage='footprint')
    tree = _fixture(params)
    tree.model_base = Point(0., 0.).buffer(8., 32)
    tree.model_xy_bounds = (-8., -8., 8., 8.)
    original = B.raft_polygon(tree, params)
    before = _snapshot(tree)
    report = R.plan_split(tree, params)
    assert report['status'] == 'planned' and report['style'] == 'bent', report
    path = np.asarray(report['path_xy'])
    assert len(path) > 2 and np.linalg.matrix_rank(path - path[0]) == 2
    split = B.raft_polygon(tree, params)
    _assert_only_seam_removed(original, split, report)
    _assert_all_feet_founded(tree, params, split)
    assert tree.model_base.difference(split).area < 1e-9
    assert split.area > .95 * original.area, 'Bent slot removed too much of the broad pad'
    _brace_router(tree, params)._braces()
    whole, support, raft = _union(tree, params)
    assert R.finalize_split(tree, params, support, raft), tree.raft_split_report
    _assert_grounded_components(whole, params, tree, 2)
    assert _snapshot(tree) == before


def test_choice_is_deterministic_for_identical_geometry():
    params = _params()
    first = _fixture(params)
    second = _fixture(params)
    report_a = R.plan_split(first, params)
    report_b = R.plan_split(second, params)
    assert report_a == report_b
    assert first.raft_split_root_sides == second.raft_split_root_sides
    assert B.raft_polygon(first, params).equals_exact(B.raft_polygon(second, params), 0.)


def test_regular_and_stability_repair_braces_never_join_opposite_halves():
    params = _params()
    tree = _fixture(params)
    assert R.plan_split(tree, params)['status'] == 'planned'
    router = _brace_router(tree, params)
    original_pair = router._brace_pair
    attempted = []
    roots = [n for n in tree.roots() if n.kind == NodeKind.FOOT]

    def checked_pair(a, b, max_run, bridge=False):
        # Resolve ownership from actual trunk foot coordinates, independently of
        # the production same_half helper. Observe both ordinary and repair paths.
        first = next(n.id for n in roots if np.array_equal(n.position, a[0][0]))
        second = next(n.id for n in roots if np.array_equal(n.position, b[0][0]))
        assert tree.raft_split_root_sides[first] == tree.raft_split_root_sides[second]
        attempted.append((bridge, first, second))
        return original_pair(a, b, max_run, bridge)

    router._brace_pair = checked_pair
    router._braces()
    assert any(not repair for repair, _, _ in attempted), 'Ordinary brace loop was not exercised'
    # An empty link graph forces isolated-tree repair even when normal bracing
    # already made these particular fixtures stable.
    router._bridge_isolated(tree.children(), [])
    assert any(repair for repair, _, _ in attempted), 'Stability repair loop was not exercised'
    whole, support, raft = _union(tree, params)
    assert R.finalize_split(tree, params, support, raft), tree.raft_split_report
    _assert_grounded_components(whole, params, tree, 2)


def test_actual_branch_reconnection_rejects_the_slot_and_preserves_foundations():
    params = _params()
    tree = _fixture(params)
    original_raft = B.raft_polygon(tree, params)
    assert R.plan_split(tree, params)['status'] == 'planned'
    _brace_router(tree, params)._braces()
    _, support, raft = _union(tree, params)
    sides = tree.raft_split_root_sides
    first = next(tree.nodes[n] for n, side in sides.items() if side == -1)
    second = next(tree.nodes[n] for n, side in sides.items() if side == 1)
    points = np.array([first.position + [0., 0., 12.], second.position + [0., 0., 12.]])
    cross_link = B.tube(points, np.array([.7, .7]), params.circle_segments)
    connected = B.manifold_to_trimesh(B.trimesh_to_manifold(support) + cross_link)
    assert not R.finalize_split(tree, params, connected, raft)
    assert tree.raft_split_report['status'] == 'skipped'
    assert B.raft_polygon(tree, params).equals_exact(original_raft, 0.)
    _assert_all_feet_founded(tree, params, B.raft_polygon(tree, params))


def test_pipeline_rejection_restores_the_original_braces_and_remeshes():
    from arbor.engine import pipeline
    # Isolate cage-split rejection from the independent large-pad slotting pass.
    params = _params(raft_max_span=0)
    tree = _fixture(params)
    _brace_router(tree, params.updated(raft_split=False))._braces()
    original_braces = copy.deepcopy(tree.braces)
    baseline_whole, _, _ = _union(tree, params)
    tree._raft_split_original_braces = list(tree.braces)
    assert R.plan_split(tree, params)['status'] == 'planned'
    tree.braces = []
    _brace_router(tree, params)._braces()
    sides = tree.raft_split_root_sides
    first = next(tree.nodes[n] for n, side in sides.items() if side == -1)
    second = next(tree.nodes[n] for n, side in sides.items() if side == 1)
    cross_link = B.tube(np.array([first.position + [0., 0., 12.], second.position + [0., 0., 12.]]),
                        np.array([.7, .7]), params.circle_segments)
    saved = (pipeline._tree.build_tree, pipeline._build.mesh_tree,
             pipeline._verify.verify, pipeline._verify.support_stats)
    calls = []

    def mesh_with_incidental_reconnection(working_tree, config, progress=None):
        result = saved[1](working_tree, config, progress)
        calls.append(True)
        if len(calls) == 1:
            # Force the final geometric gate to discover a joining solid, as can
            # happen when wide branches touch despite different root ownership.
            return B.manifold_to_trimesh(B.trimesh_to_manifold(result) + cross_link)
        return result

    try:
        pipeline._tree.build_tree = lambda *args: tree
        pipeline._build.mesh_tree = mesh_with_incidental_reconnection
        pipeline._verify.verify = lambda *args: []
        pipeline._verify.support_stats = lambda *args: {}
        analysis = AnalysisResult(params.layer_height, np.array([], float))
        result = pipeline._generate(trimesh.creation.box([2., 2., 2.]), params,
                                    [], Progress(), analysis, [])
    finally:
        (pipeline._tree.build_tree, pipeline._build.mesh_tree,
         pipeline._verify.verify, pipeline._verify.support_stats) = saved
    assert len(calls) == 2, 'Rejected plan did not rebuild intact output'
    assert result.tree.raft_split_report['status'] == 'skipped'
    assert result.stats['raft_split_applied'] == 0
    assert len(result.tree.braces) == len(original_braces)
    for actual, original in zip(result.tree.braces, original_braces):
        assert all(np.array_equal(a, b) for a, b in zip(actual, original))
    whole = B.trimesh_to_manifold(result.support_mesh) + B.trimesh_to_manifold(result.raft_mesh)
    assert abs((whole - baseline_whole).volume()) < 1e-8
    assert abs((baseline_whole - whole).volume()) < 1e-8
    _assert_grounded_components(whole, params, tree, 1)


def test_gap_uses_at_least_two_lines_and_rejects_invalid_values():
    assert not SupportParams().raft_split, 'Feature must remain opt-in'
    params = _params(raft_split_gap=.01)
    tree = _fixture(params)
    report = R.plan_split(tree, params)
    assert report['status'] == 'planned', report
    assert report['gap'] >= 2 * params.line_width
    halves = list(B.raft_polygon(tree, params).geoms)
    assert len(halves) == 2 and halves[0].distance(halves[1]) >= 2 * params.line_width - 1e-8
    for invalid in [0., -.1, float('nan'), float('inf')]:
        assert any('raft_split_gap' in message for message in _params(raft_split_gap=invalid).validate())


def test_fallback_keeps_empty_single_foot_blocked_and_skinny_foundations():
    for label, params, tree in [
        ('no feet', _params(), _fixture(coordinates=[])),
        ('one foot', _params(), _fixture(coordinates=[[10., 0.]])),
        ('skinny line', _params(), _fixture(coordinates=[[-9., 0.], [-3., 0.], [3., 0.], [9., 0.]])),
        ('blocked model foundation', _params(raft_coverage='footprint'), _fixture(_params(raft_coverage='footprint'))),
    ]:
        if label == 'blocked model foundation':
            tree.model_base = box(-20., -20., 20., 20.)
        original = B.raft_polygon(tree, params)
        before = _snapshot(tree)
        report = R.plan_split(tree, params)
        assert report['status'] == 'skipped', (label, report)
        after = B.raft_polygon(tree, params)
        assert (original is None and after is None) or original.equals_exact(after, 0.), label
        assert _snapshot(tree) == before


def export_inspection_fixtures(directory):
    from arbor.io.export import export_3mf, export_stl, validate_export
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    params = _params()
    tree = _fixture(params)
    # Synthetic umbrella/body deliberately makes the surrounding support cage visible.
    # Its surface and all contacts are exactly identical in both archives.
    foot = B.mf.Manifold.cylinder(5., 1., 1., 48)
    body = B.mf.Manifold.sphere(5.5, 48).translate((0., 0., 11.))
    stem = B.mf.Manifold.cylinder(27.06, 1., 1., 48)
    roof = B.mf.Manifold.cylinder(.7, 13., 13., 64).translate((0., 0., 27.06))
    model = B.manifold_to_trimesh(B.mf.Manifold.batch_boolean([foot, body, stem, roof], B.mf.OpType.Add))
    report = {'purpose': 'Synthetic geometry inspection only; not a validated physical print.',
              'unchangedContacts': len(tree.contact_normals), 'variants': {}}
    for name, enabled in [('intact', False), ('split', True)]:
        variant = copy.deepcopy(tree)
        config = params.updated(raft_split=enabled)
        R.plan_split(variant, config)
        _brace_router(variant, config)._braces()
        whole, supports, raft = _union(variant, config)
        if enabled:
            assert R.finalize_split(variant, config, supports, raft)
        filename = directory / (name + '.3mf')
        export_3mf(filename, model, supports, raft, params=config,
                   model_name='Synthetic cage: ' + name, layout='components', positive_octant=True)
        export_stl(supports, directory / (name + '-supports.stl'))
        export_stl(raft, directory / (name + '-raft.stl'))
        report['variants'][name] = {'connectedSupportAndRaftComponents': len(whole.decompose()),
                                  'supportVolumeMm3': float(supports.volume), 'raftVolumeMm3': float(raft.volume),
                                  'braces': len(variant.braces), 'splitReport': getattr(variant, 'raft_split_report', None),
                                  'exportValidation': validate_export(filename)}
    export_stl(model, directory / 'model.stl')
    # The wide central pedestal blocks a useful straight slot. Both variants retain
    # exactly the same broad original pad outline, with only a bent seam removed.
    params = params.updated(raft_coverage='footprint')
    bent_tree = _fixture(params)
    bent_tree.model_base = Point(0., 0.).buffer(8., 32)
    bent_tree.model_xy_bounds = (-8., -8., 8., 8.)
    pedestal = B.mf.Manifold.cylinder(1., 8., 8., 128)
    bent_model = B.manifold_to_trimesh(B.trimesh_to_manifold(model) + pedestal)
    for name, enabled in [('bent-intact', False), ('bent', True)]:
        variant = copy.deepcopy(bent_tree)
        config = params.updated(raft_split=enabled)
        R.plan_split(variant, config)
        _brace_router(variant, config)._braces()
        whole, supports, raft = _union(variant, config)
        if enabled:
            assert variant.raft_split_report['style'] == 'bent'
            assert R.finalize_split(variant, config, supports, raft)
            _export_bent_preview(directory / 'bent-preview.svg', variant, config)
        filename = directory / (name + '.3mf')
        export_3mf(filename, bent_model, supports, raft, params=config,
                   model_name='Synthetic broad pad: ' + name, layout='components', positive_octant=True)
        export_stl(supports, directory / (name + '-supports.stl'))
        export_stl(raft, directory / (name + '-raft.stl'))
        report['variants'][name] = {'connectedSupportAndRaftComponents': len(whole.decompose()),
                                  'supportVolumeMm3': float(supports.volume), 'raftVolumeMm3': float(raft.volume),
                                  'braces': len(variant.braces), 'splitReport': getattr(variant, 'raft_split_report', None),
                                  'exportValidation': validate_export(filename)}
    export_stl(bent_model, directory / 'bent-model.stl')
    (directory / 'report.json').write_text(json.dumps(report, indent=2))


def _export_bent_preview(filename, tree, params):
    """Exact Shapely geometry, not a hand-drawn approximation of the selected seam."""
    original = B.raft_polygon(tree, params.updated(raft_split=False))
    halves = tree._raft_split_halves

    def polygon_path(polygon):
        rings = [polygon.exterior, *polygon.interiors]
        return ' '.join('M ' + ' L '.join(f'{x:.7f},{y:.7f}' for x, y in ring.coords) + ' Z'
                        for ring in rings)

    parts = ['<svg xmlns="http://www.w3.org/2000/svg" width="800" height="760" viewBox="0 0 100 95">',
             '<rect width="100" height="95" fill="#faf9f5"/>',
             '<text x="7" y="8" font-family="system-ui,sans-serif" font-size="3.3" font-weight="650" fill="#17212b">Single pad with a bent removal seam</text>',
             '<text x="7" y="13" font-family="system-ui,sans-serif" font-size="2" fill="#56616b">Synthetic geometry · exact top view · 0.6 mm seam</text>',
             '<g transform="translate(50,49) scale(2,-2)" fill-rule="evenodd">',
             f'<path d="{polygon_path(original)}" fill="#fff" stroke="#52606c" stroke-width=".12"/>']
    for color, half in zip(('#71afc4', '#83bfa4'), halves):
        parts.append(f'<path d="{polygon_path(half)}" fill="{color}" stroke="#344751" stroke-width=".06"/>')
    parts.append(f'<path d="{polygon_path(tree.model_base)}" fill="#faf9f5" fill-opacity=".82" stroke="#52606c" stroke-width=".1" stroke-dasharray=".3,.2"/>')
    for foot in tree.roots():
        if foot.kind == NodeKind.FOOT:
            radius = max(foot.radius, tree.foot_radius[foot.id])
            disk = Point(*foot.position[:2]).buffer(radius, 64)
            parts.append(f'<path d="{polygon_path(disk)}" fill="#eac681" stroke="#715425" stroke-width=".1"/>')
    parts += ['</g>',
              '<g font-family="system-ui,sans-serif" font-size="1.9" fill="#344751">',
              '<rect x="7" y="82" width="2.3" height="2.3" fill="#71afc4"/><text x="10.3" y="84">First raft + support group</text>',
              '<rect x="52" y="82" width="2.3" height="2.3" fill="#83bfa4"/><text x="55.3" y="84">Second raft + support group</text>',
              '<circle cx="8.15" cy="88.15" r="1.15" fill="#eac681" stroke="#715425" stroke-width=".12"/><text x="10.3" y="89">Full support-foot footprint</text>',
              '<rect x="52" y="87" width="2.3" height="2.3" fill="#faf9f5" stroke="#52606c" stroke-width=".12" stroke-dasharray=".4,.2"/><text x="55.3" y="89">Preserved model-base foundation</text>',
              '</g></svg>']
    Path(filename).write_text('\n'.join(parts))
