"""Browser entry point for the shared support engine and validated 3MF export."""
import json
import gc
import math
from dataclasses import replace
from pathlib import Path
import numpy as np
import wasm_compat
from arbor.core.mesh_io import load_mesh
from arbor.engine.params import load_profiles
from arbor.engine.pipeline import generate
from arbor.engine.types import Progress
from arbor.io.export import export_3mf, export_stl, validate_export
from browser_bridge import progress as report
from support_sampler import install as install_sampler

install_sampler()
PROFILES = load_profiles(Path('/engine/profiles'))

def run(settings_json):
    settings = json.loads(settings_json)
    if settings.get('indexed'):
        import trimesh
        vertices = np.frombuffer(Path('/input.vertices').read_bytes(), dtype=np.float32).reshape(-1, 3)
        faces = np.frombuffer(Path('/input.indices').read_bytes(), dtype=np.uint32).reshape(-1, 3)
        model = trimesh.Trimesh(vertices=vertices, faces=faces, process=False)
    else:
        model = load_mesh('/input.stl').mesh
    if not np.all(np.isfinite(model.vertices)):
        raise ValueError('The STL contains invalid coordinates.')
    if max(model.extents) > 250:
        raise ValueError('Browser mode supports models up to 250 mm. Reduce the scale and try again.')
    params = replace(PROFILES[settings['profile']].params)
    params.raft_enabled = settings['raft']
    params.raft_split = bool(settings.get('raftSplit', False))
    params.patch_grid = bool(settings.get('patchGrid', False))
    params.removal_groups = params.removal_groups and params.raft_enabled and params.raft_split
    params.overhang_angle_deg = float(settings['overhang'])
    params.z_gap = float(settings['gap'])
    result = generate(model, params, progress=Progress(lambda f, text: report(f * 0.94, text)))
    report(0.95, 'Writing multipart 3MF')
    exported = export_3mf('/output.3mf', model, result.support_mesh, result.raft_mesh,
        params=params, model_name=settings['name'], layout='components',
        positive_octant=not settings.get('preserve_frame', False))
    report(0.98, 'Validating exported 3MF')
    errors = validate_export('/output.3mf')
    if errors:
        raise ValueError('3MF validation failed: ' + '; '.join(errors))
    for name, mesh in [('supports', result.support_mesh), ('raft', result.raft_mesh)]:
        path = Path('/' + name + '.stl')
        if mesh is not None and len(mesh.faces): export_stl(mesh, path, weld=False)
        elif path.exists(): path.unlink()
    summary = {
        'contacts': len(result.contacts),
        'trees': len(result.tree.roots()),
        'stats': result.stats,
        'timings': result.timings,
        'plateZ': result.plate_z,
        'issues': [{'severity': i.severity, 'code': i.code, 'message': i.message} for i in result.issues],
        'exportNotes': exported.notes,
        'triangles': exported.n_triangles,
        'supportWatertight': bool(result.support_mesh.is_watertight) if len(result.support_mesh.faces) else True,
        'parts': exported.objects,
        'raftSplit': getattr(result.tree, 'raft_split_report', None),
    }
    report(1, 'Ready to slice')
    del result, model
    gc.collect()
    return json.dumps(_clean(summary), allow_nan=False)

def _clean(value):
    if isinstance(value, np.ndarray): return _clean(value.tolist())
    if isinstance(value, np.generic): return _clean(value.item())
    if isinstance(value, float) and not math.isfinite(value): return None
    if isinstance(value, dict): return {str(k): _clean(v) for k,v in value.items()}
    if isinstance(value, (tuple, list)): return [_clean(v) for v in value]
    return value


def combine(manifest_json):
    """Package cached per-mini exports without regenerating or changing their meshes."""
    import copy
    import zipfile
    import xml.etree.ElementTree as ET
    from arbor.core.mesh_io import CORE_NS, read_3mf, parse_3mf_matrix, format_3mf_matrix
    from arbor.io.export import _content_types, _rels

    manifest = json.loads(manifest_json)
    if not manifest['parts']:
        raise ValueError('Generate supports for at least one mini first.')
    ns = {'m': CORE_NS}
    ET.register_namespace('', CORE_NS)
    root = ET.Element('{' + CORE_NS + '}model', unit='millimeter')
    ET.SubElement(root, '{' + CORE_NS + '}metadata', name='Title').text = manifest['name']
    resources = ET.SubElement(root, '{' + CORE_NS + '}resources')
    build = ET.SubElement(root, '{' + CORE_NS + '}build')
    combined_config = ET.Element('config')
    lower = np.array([np.inf, np.inf, np.inf])
    next_id = 1
    for index, entry in enumerate(manifest['parts']):
        lift = float(entry['lift'])
        if not np.isfinite(lift):
            raise ValueError('Invalid mini height.')
        filename = f'/plate-{index}.3mf'
        content = read_3mf(filename)
        for part in content.parts:
            lower = np.minimum(lower, part.mesh.bounds[0] + [0, 0, lift])
        with zipfile.ZipFile(filename) as archive:
            source = ET.fromstring(archive.read('3D/3dmodel.model'))
            source_config = ET.fromstring(archive.read('Metadata/model_settings.config')) if 'Metadata/model_settings.config' in archive.namelist() else None
        objects = source.findall('m:resources/m:object', ns)
        mapping = {o.attrib['id']: str(next_id + i) for i, o in enumerate(objects)}
        next_id += len(objects)
        if source_config is not None:
            for config_object in source_config.findall('object'):
                config_object = copy.deepcopy(config_object)
                config_object.set('id', mapping[config_object.get('id')])
                for part in config_object.findall('part'):
                    part.set('id', mapping[part.get('id')])
                combined_config.append(config_object)
        for obj in objects:
            obj = copy.deepcopy(obj)
            obj.set('id', mapping[obj.attrib['id']])
            for component in obj.findall('m:components/m:component', ns):
                component.set('objectid', mapping[component.attrib['objectid']])
            resources.append(obj)
        for item in source.findall('m:build/m:item', ns):
            transform = parse_3mf_matrix(item.get('transform'))
            transform[2, 3] += lift
            ET.SubElement(build, '{' + CORE_NS + '}item', objectid=mapping[item.attrib['objectid']], transform=format_3mf_matrix(transform))
    # One common XY shift preserves the plate layout; the per-mini Z lifts put
    # independently generated rafts on the same bed as shown in the viewer.
    offset = np.maximum(-lower, 0)
    for item in build:
        transform = parse_3mf_matrix(item.get('transform'))
        transform[:3, 3] += offset
        item.set('transform', format_3mf_matrix(transform))
    report(.98, 'Validating all mini assemblies')
    with zipfile.ZipFile('/plate.3mf', 'w', zipfile.ZIP_DEFLATED) as archive:
        archive.writestr('[Content_Types].xml', _content_types())
        archive.writestr('_rels/.rels', _rels())
        archive.writestr('3D/3dmodel.model', ET.tostring(root, encoding='utf-8', xml_declaration=True))
        if len(combined_config):
            archive.writestr('Metadata/model_settings.config', ET.tostring(combined_config, encoding='utf-8', xml_declaration=True))
    errors = validate_export('/plate.3mf')
    if errors:
        raise ValueError('Plate export failed validation: ' + '; '.join(errors))
    report(1, 'Ready to slice')
