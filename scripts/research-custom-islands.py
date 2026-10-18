"""Executed by research-custom-islands.mjs inside its pinned Pyodide runtime."""
import json, math
import numpy as np
from shapely.geometry import LineString, Point, Polygon, box
from shapely import union_all

GRID = .000001
OWN_TOL = .001
OTHER_EXCLUSION = .005
MIN_PATH = .015


def local_rows(rows, region, pad=0.):
    if region.is_empty or not len(rows):
        return rows[:0]
    a, b, c, d = region.bounds
    return rows[(np.minimum(rows[:, 1], rows[:, 3]) <= c+pad) &
                (np.maximum(rows[:, 1], rows[:, 3]) >= a-pad) &
                (np.minimum(rows[:, 2], rows[:, 4]) <= d+pad) &
                (np.maximum(rows[:, 2], rows[:, 4]) >= b-pad)]


def split_centerline(line, own, other):
    """Exclusive ownership: coincident geometry is never support evidence."""
    raw = line.intersection(own.buffer(OWN_TOL))
    classified = raw.difference(other.buffer(OTHER_EXCLUSION))
    return raw, classified


def cap_target_halfplane(center, normal, z, region):
    """The side of the cap plane pointing toward the intended upper model."""
    a, b, c, d = region.bounds
    vertices = [(a, b), (c, b), (c, d), (a, d)]
    def signed(p):
        return normal[0]*(p[0]-center[0])+normal[1]*(p[1]-center[1])+normal[2]*(z-center[2])
    clipped = []
    for p, q in zip(vertices, vertices[1:]+vertices[:1]):
        dp, dq = signed(p), signed(q)
        if dp >= 0:
            clipped.append(p)
        if (dp >= 0) != (dq >= 0):
            t = dp/(dp-dq)
            clipped.append((p[0]+t*(q[0]-p[0]), p[1]+t*(q[1]-p[1])))
    return Polygon(clipped).intersection(region) if len(clipped) >= 3 else Polygon()


def evidence(rows, own, other, region=None):
    region = own if region is None else region.intersection(own)
    raw_length, length, ambiguous = 0., 0., 0.
    beads, raw_beads, first = [], [], None
    for row in local_rows(rows, region, OWN_TOL):
        raw, classified = split_centerline(LineString([(row[1], row[2]), (row[3], row[4])]), region, other)
        raw_length += raw.length
        length += classified.length
        ambiguous += max(0., raw.length-classified.length)
        if raw.length > 1e-8:
            raw_beads.append(raw.buffer(row[5]/2))
        if classified.length > 1e-8:
            beads.append(classified.buffer(row[5]/2))
            first = int(row[7]) if first is None else min(first, int(row[7]))
    return dict(raw_length=raw_length, length=length, ambiguous_length=ambiguous,
                footprint=union_all(beads, grid_size=GRID), raw_footprint=union_all(raw_beads, grid_size=GRID), first_line=first)


def self_test():
    line = LineString([(-2, 0), (2, 0)])
    model, support = box(-1, -1, 1, 1), box(-1, -1, 1, 1)
    assert split_centerline(line, support, model)[1].length == 0, 'Coincident model cannot count as support'
    left, right = box(-2, -1, 0, 1), box(0, -1, 2, 1)
    lm = split_centerline(line, left, right)[1]
    ls = split_centerline(line, right, left)[1]
    assert lm.intersection(ls).length == 0, 'Classifications must never overlap'
    assert 1.99 < lm.length < 2 and 1.99 < ls.length < 2
    rows = np.array([[.1, -2, 0, 2, 0, .22, .1, 42, 0]], float)
    e = evidence(rows, support, model)
    assert e['raw_length'] > 2 and e['length'] == 0 and e['footprint'].is_empty
    e = evidence(rows, right, left, box(.5, -.1, 1.5, .1))
    assert e['length'] > 1 and e['first_line'] == 42 and e['footprint'].area > .2
    half = cap_target_halfplane(np.array([0., 0., 0.]), np.array([1., 0., 1.]), 0., box(-1, -1, 1, 1))
    assert abs(half.area-2) < 1e-8 and half.bounds == (0., -1., 1., 1.)
    assert cap_target_halfplane(np.zeros(3), np.array([0., 0., 1.]), -.1, box(-1, -1, 1, 1)).is_empty
    return json.dumps(dict(passed=True, checks=['Coincident model excluded', 'Disjoint ownership with boundary exclusion', 'Ambiguous footprints excluded', 'Regional clipping retains actual path witness', 'Cap target halfspace excludes the lower attachment side']))


def run_audit():
    import sys
    from pathlib import Path
    sys.path.insert(0, '/engine')
    import wasm_compat, trimesh, manifold3d as mf
    from arbor.engine.build import trimesh_to_manifold
    from arbor.engine.analysis import cs_components
    translation = np.asarray(json.loads(plate_translation_json), float)
    source = json.loads(summary_json)
    focus_contacts = json.loads(cap_contact_filter_json)
    first, height = float(first_model_layer_height), float(regular_model_layer_height)
    gap = float(source['params']['z_gap'])
    max_gap = gap+height
    max_root_gap = height*2
    min_overlap = .05
    solids, triangles = {}, {}
    for name in ('model', 'support'):
        positions = np.frombuffer(Path('/'+name+'.positions').read_bytes(), dtype=np.float32).reshape(-1, 3).astype(float)
        vertices, indices = np.unique(positions, axis=0, return_inverse=True)
        mesh = trimesh.Trimesh(vertices=vertices+translation, faces=indices.reshape(-1, 3), process=False)
        triangles[name] = len(mesh.faces)
        solid = trimesh_to_manifold(mesh)
        assert solid.status() == mf.Error.NoError, name+' must be a valid solid'
        solids[name] = solid
    paths = np.frombuffer(Path('/segments.f64').read_bytes(), dtype=np.float64).reshape(-1, 9)
    layer_numbers = np.rint((paths[:, 0]-first)/height).astype(int)
    assert np.max(np.abs(paths[:, 0]-(first+layer_numbers*height))) < .0002, 'Ordinary mesh path outside fixed layer schedule'
    assert layer_numbers.min() >= 0
    groups = {int(n): paths[layer_numbers == n] for n in np.unique(layer_numbers)}
    empty = paths[:0]
    section_cache = {}

    def layer(n):
        z = round(first+n*height, 5)
        h = first if n == 0 else height
        return z, h, z-h/2

    def section(name, n):
        key = name, n
        if key not in section_cache:
            polys = [p for _, p in cs_components(solids[name].slice(layer(n)[2]))]
            section_cache[key] = (polys, union_all(polys, grid_size=GRID))
        return section_cache[key]

    def classified(name, n, region):
        other = 'support' if name == 'model' else 'model'
        return evidence(groups.get(n, empty), section(name, n)[1], section(other, n)[1], region)

    def witnesses(target, footprint, base, before_n, name, max_depth=.5):
        result = []
        if footprint.is_empty:
            return result
        # These are true preceding layer paths, even when slicer emits bridge
        # HEIGHT equal to the nozzle diameter rather than layer thickness.
        for n in range(before_n-1, -1, -1):
            z, _, _ = layer(n)
            if z < base-max_depth-1e-6:
                break
            if z > base+.00001:
                continue
            rows = groups.get(n, empty)
            pad = float(rows[:, 5].max())/2 if len(rows) else 0
            e = classified(name, n, target.buffer(pad+.001))
            under_bead = e['footprint'].intersection(footprint)
            overlap = under_bead.intersection(target)
            if overlap.area > 1e-8:
                result.append(dict(extrusion_z_mm=z, nominal_layer_envelope_gap_mm=base-z,
                                   overlap_area_mm2=float(overlap.area), target_section_area_fraction=float(overlap.area/target.area),
                                   emitted_footprint_overlap_area_mm2=float(under_bead.area), first_gcode_line=e['first_line']))
        return result

    previous, starts, births, flags = [], [], [], []
    next_birth = 0
    for n in range(int(layer_numbers.max())+1 if focus_contacts is None else 0):
        z, h, mid = layer(n)
        polygons = section('model', n)[0]
        current = []
        for poly in polygons:
            parents = [p for p in previous if poly.intersects(p['poly'])]
            inherited = any(p['printed'] for p in parents)
            ids = set().union(*(p['ids'] for p in parents)) if parents else {next_birth}
            if not parents:
                births.append(dict(id=next_birth, slice_midplane_z_mm=mid, area_mm2=float(poly.area), centroid_plate_xy_mm=list(poly.centroid.coords[0])))
                next_birth += 1
            if inherited:
                current.append(dict(poly=poly, printed=True, ids=ids))
                continue
            e = classified('model', n, poly)
            # Raw model occupancy determines first emission timing. Do not
            # silently move an ambiguous first start to a later easier layer.
            printed = e['raw_length'] >= MIN_PATH
            if printed:
                on_bed = n == 0
                ws = [] if on_bed else witnesses(poly, e['footprint'], z-h, n, 'support')
                closest = ws[0] if ws else None
                adequate = [w for w in ws if w['nominal_layer_envelope_gap_mm'] <= max_gap+.00001 and w['target_section_area_fraction'] >= min_overlap]
                causes = []
                if e['length'] < MIN_PATH:
                    causes.append('First model emission is ambiguous with support geometry; exclusive original-model path is insufficient.')
                if not on_bed:
                    if not closest:
                        causes.append('No earlier exclusive custom-support bead intersects the original first-emission section and model bead footprint.')
                    else:
                        if closest['nominal_layer_envelope_gap_mm'] > max_gap+.00001:
                            causes.append('Closest support witness exceeds requested gap plus one layer.')
                        if closest['target_section_area_fraction'] < min_overlap:
                            causes.append('Closest support witness covers less than 5% of the first-emission section.')
                record = dict(index=len(starts), birth_ids=sorted(ids), model_slice_midplane_z_mm=mid,
                              first_model_extrusion_z_mm=z, model_layer_height_mm=h, area_mm2=float(poly.area),
                              centroid_plate_xy_mm=list(poly.centroid.coords[0]), bounds_plate_xy_mm=list(poly.bounds),
                              raw_model_centerline_length_mm=e['raw_length'], exclusive_model_centerline_length_mm=e['length'],
                              ambiguous_centerline_length_mm=e['ambiguous_length'], first_model_gcode_line=e['first_line'],
                              status='bed-start' if on_bed else 'custom-support-witness' if ws else 'no-custom-support-witness',
                              closest_custom_support=closest, adequate_witness_within_gap=adequate[0] if adequate else None,
                              custom_support_layers_with_overlap=len(ws), custom_support_witnesses=ws,
                              first_extrusion_footprint_area_mm2=float(e['footprint'].area), flags=causes)
                starts.append(record)
                if causes:
                    flags.append(dict(kind='model-start', index=record['index'], first_model_extrusion_z_mm=z, causes=causes, closest_witness=closest, adequate_witness_within_gap=record['adequate_witness_within_gap']))
            current.append(dict(poly=poly, printed=printed, ids=ids))
        previous = current

    nodes = {node['id']: node for node in source['treeNodes']}
    roots, tips = [], []
    for node in nodes.values():
        if node['kind'] not in ('model_foot', 'tip'):
            continue
        if focus_contacts is not None and (node['kind'] != 'tip' or node.get('contact_id') not in focus_contacts):
            continue
        center = np.asarray(node['position'], float)+translation
        radius = float(node['radius'])
        if node['kind'] == 'model_foot':
            # The lower root plane is horizontal. The next 0.30mm is a narrow
            # neck for the experimental model-root construction; clip against
            # the actual support section, never infer deposited material from
            # node radii alone.
            lo, hi = center[2], center[2]+.30
            probe = Point(center[:2]).buffer(radius+.015)
            rows = []
            for n in range(max(0, int(math.floor((lo-first)/height))), min(int(layer_numbers.max())+1, int(math.ceil((hi-first)/height))+2)):
                z, h, mid = layer(n)
                if not lo-1e-5 <= mid <= hi+1e-5:
                    continue
                e = classified('support', n, probe)
                if e['length'] < MIN_PATH:
                    continue
                actual_region = probe.intersection(section('support', n)[1])
                ws = witnesses(actual_region, e['footprint'], z-h, n, 'model')
                rows.append(dict(extrusion_z_mm=z, slice_midplane_z_mm=mid, exclusive_support_centerline_length_mm=e['length'], ambiguous_centerline_length_mm=e['ambiguous_length'], first_gcode_line=e['first_line'], closest_original_model_below=ws[0] if ws else None))
            causes = []
            if not rows:
                causes.append('No exclusive custom-support neck path survives within 0.30mm above this planned model root.')
            elif not rows[0]['closest_original_model_below']:
                causes.append('First exclusive root-neck path has no earlier exclusive original-model footprint directly beneath it in 0.5mm.')
            elif rows[0]['closest_original_model_below']['nominal_layer_envelope_gap_mm'] > max_root_gap+.00001:
                causes.append('First exclusive root-neck path is more than two model layers above its original-model witness.')
            record = dict(node_id=node['id'], root_position_plate_mm=list(center), root_radius_mm=radius, exclusive_neck_layers=rows, flags=causes)
            roots.append(record)
            if causes:
                flags.append(dict(kind='model-root', node_id=node['id'], root_position_plate_mm=list(center), causes=causes, first_neck_layer=rows[0] if rows else None))
        else:
            parent = nodes.get(node['parent'])
            if parent is None:
                continue
            lower = np.asarray(parent['position'], float)+translation
            delta = center-lower
            length = float(np.linalg.norm(delta))
            # A surface-aligned tip can terminate on a different plane from
            # its incoming branch axis. Prefer the actual recorded cap plane.
            recorded_normal = node.get('cap_normal')
            normal = np.asarray(recorded_normal if recorded_normal is not None else delta/max(length, 1e-9), float)
            normal /= max(float(np.linalg.norm(normal)), 1e-9)
            cap_dz = radius*math.sqrt(max(0., 1.-normal[2]**2))
            cap_low, cap_high = center[2]-cap_dz, center[2]+cap_dz
            lo, hi = max(lower[2]+.005, cap_low-.18), cap_low-.06
            rows = []
            if hi >= lo:
                for n in range(max(0, int(math.floor((lo-first)/height))), min(int(layer_numbers.max())+1, int(math.ceil((hi-first)/height))+2)):
                    z, h, mid = layer(n)
                    if not lo-1e-5 <= mid <= hi+1e-5:
                        continue
                    fraction = (mid-lower[2])/max(delta[2], 1e-9)
                    axis = lower+delta*fraction
                    r = float(parent['radius'])+(radius-float(parent['radius']))*fraction
                    probe = Point(axis[:2]).buffer(max(r, radius)+.015)
                    e = classified('support', n, probe)
                    if e['length'] >= MIN_PATH:
                        rows.append(dict(extrusion_z_mm=z, slice_midplane_z_mm=mid, exclusive_support_centerline_length_mm=e['length'], ambiguous_centerline_length_mm=e['ambiguous_length'], first_gcode_line=e['first_line']))
            # Very short cavity pillars have no 0.06-0.18mm pre-cap neck.
            # Leave their absence explicit instead of calling them vanished.
            screenable = bool(hi >= lo and hi-lo >= height-.00001)
            causes = ['No exclusive custom-support tip-neck path survives in the planned pre-cap probe interval.'] if screenable and not rows else []
            # A positive geometry gap does not prevent same-layer slicer beads
            # from touching sideways across an inclined interface. Inspect the
            # actual emitted footprints near the cap independently of the
            # pre-cap neck survival test. This is a fusion-risk observation,
            # not a measured physical bead envelope.
            cap_rows = []
            cap_region = Point(center[:2]).buffer(radius/max(.1, abs(float(normal[2])))+.22)
            cap_lo, cap_hi = cap_low-height/2, cap_high+gap+height/2
            for n in range(max(0, int(math.floor((cap_lo-first)/height))), min(int(layer_numbers.max())+1, int(math.ceil((cap_hi-first)/height))+2)):
                z, h, mid = layer(n)
                if not cap_lo-1e-5 <= mid <= cap_hi+1e-5:
                    continue
                support_e = classified('support', n, cap_region)
                model_e = classified('model', n, cap_region)
                bead_overlap = support_e['footprint'].intersection(model_e['footprint']).intersection(cap_region)
                ambiguous = min(support_e['ambiguous_length'], model_e['ambiguous_length'])
                geometry_overlap = section('support', n)[1].intersection(section('model', n)[1]).intersection(cap_region)
                inside_both_length = sum(LineString([(row[1], row[2]), (row[3], row[4])]).intersection(geometry_overlap).length for row in local_rows(groups.get(n, empty), geometry_overlap))
                target_side = cap_target_halfplane(center, normal, mid, cap_region)
                if bead_overlap.area > 1e-8 or ambiguous >= MIN_PATH:
                    observation = dict(extrusion_z_mm=z, slice_midplane_z_mm=mid,
                                         nominal_bead_overlap_area_mm2=float(bead_overlap.area),
                                         ambiguous_emitted_centerline_length_mm=ambiguous,
                                         original_support_section_overlap_area_mm2=float(geometry_overlap.area),
                                         cap_target_side_bead_overlap_area_mm2=float(bead_overlap.intersection(target_side).area),
                                         cap_target_side_solid_overlap_area_mm2=float(geometry_overlap.intersection(target_side).area),
                                         emitted_centerline_inside_both_solids_mm=inside_both_length,
                                         exclusive_support_centerline_length_mm=support_e['length'],
                                         exclusive_model_centerline_length_mm=model_e['length'],
                                         first_support_gcode_line=support_e['first_line'], first_model_gcode_line=model_e['first_line'])
                    if focus_contacts is not None:
                        from shapely.affinity import translate
                        def svg_shape(geometry, color):
                            return translate(geometry, xoff=-center[0], yoff=-center[1]).svg(scale_factor=.003, fill_color=color)
                        svg = '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="650" viewBox="-.6 -.6 1.2 1.3"><rect x="-.6" y="-.6" width="1.2" height="1.3" fill="white"/><g transform="scale(1,-1)">'
                        svg += svg_shape(section('model', n)[1].intersection(cap_region), '#dddddd')
                        svg += svg_shape(section('support', n)[1].intersection(cap_region), '#b6e8cd')
                        svg += svg_shape(model_e['footprint'].intersection(cap_region), '#ffa833')
                        svg += svg_shape(support_e['footprint'].intersection(cap_region), '#5577ff')
                        svg += svg_shape(bead_overlap, '#ed2233')
                        svg += svg_shape(geometry_overlap, '#000000')
                        svg += '</g><text x="-.55" y=".60" font-size=".035">Contact '+str(node.get('contact_id'))+' at Z '+str(z)+' mm</text><text x="-.55" y=".65" font-size=".026">Orange: model bead. Blue: support bead. Red: overlap. Black: solid overlap.</text></svg>'
                        observation['svg'] = svg
                    cap_rows.append(observation)
            if cap_rows:
                causes.append('Nominal same-layer model/support beads overlap or emitted paths have ambiguous ownership near the cap. For short model-root pillars this neighborhood also includes the lower attachment; it does not prove upper-tip fusion.')
            record = dict(node_id=node['id'], contact_id=node.get('contact_id'), cap_center_plate_mm=list(center), cap_plane_upward_normal=list(normal), cap_z_interval_mm=[cap_low, cap_high], probe_midplane_z_interval_mm=[lo, hi], screenable=screenable, exclusive_neck_layers=rows, direct_parent_kind=parent['kind'], direct_model_root_position_plate_mm=list(lower) if parent['kind']=='model_foot' else None, cap_same_layer_overlap_observations=cap_rows, flags=causes)
            tips.append(record)
            if causes:
                flags.append(dict(kind='tip-contact', node_id=node['id'], contact_id=node.get('contact_id'), cap_center_plate_mm=list(center), causes=causes, cap_same_layer_overlap_observations=cap_rows))
    return json.dumps(dict(auditMode='full-starts-and-contacts' if focus_contacts is None else 'selected-contact-detail-only', selectedContactIds=focus_contacts, original_triangles=triangles['model'], support_triangles=triangles['support'], model_layers=int(layer_numbers.max())+1,
                           geometric_births=len(births), geometric_birth_records=births, printed_component_starts=starts,
                           model_root_necks=roots, contact_tip_necks=tips, inspectionFlags=flags,
                           classification={"ownGeometryToleranceMm":OWN_TOL,"otherGeometryExclusionMm":OTHER_EXCLUSION,"minimumEmittedCenterlineMm":MIN_PATH,"polygonUnionGridMm":GRID},
                           inspectionScreen={"maxClosestWitnessEnvelopeGapMm":max_gap,"minimumClosestWitnessSectionAreaFraction":min_overlap,"maxModelRootWitnessEnvelopeGapMm":max_root_gap},
                           summary=dict(bedStarts=sum(s['status']=='bed-start' for s in starts),
                                        aboveBedStarts=sum(s['status']!='bed-start' for s in starts),
                                        startsWithSupportWitness=sum(s['status']=='custom-support-witness' for s in starts),
                                        startsWithoutSupportWitness=sum(s['status']=='no-custom-support-witness' for s in starts),
                                        modelStartScreenFlags=sum(f['kind']=='model-start' for f in flags),
                                        modelRoots=len(roots),modelRootScreenFlags=sum(f['kind']=='model-root' for f in flags),
                                        plannedTipNecks=len(tips),screenableTipNecks=sum(t['screenable'] for t in tips),
                                        tipNeckScreenFlags=sum(t['screenable'] and not t['exclusive_neck_layers'] for t in tips),
                                        capSameLayerOverlapFlags=sum(bool(t['cap_same_layer_overlap_observations']) for t in tips))))


self_test() if audit_self_test else run_audit()
