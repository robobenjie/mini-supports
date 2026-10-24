import { BufferGeometry, Float32BufferAttribute, Matrix4, Vector3 } from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { strFromU8 } from 'fflate';
import { ZipArchive } from './zip-archive.ts';
import type { IndexedMesh } from './simplify.ts';

const CORE = 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02';
const PRODUCTION = 'http://schemas.microsoft.com/3dmanufacturing/production/2015/06';
const RELATIONSHIPS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const MODEL_RELATIONSHIP = 'http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel';
const UNITS: Record<string, number> = { micron: .001, millimeter: 1, centimeter: 10, inch: 25.4, foot: 304.8, meter: 1000 };

export interface ModelInput { name: string; data: ArrayBuffer }
export interface SourceReference { path: string; objectId: string; transform: number[]; unit: number }
export type AsyncSimplifier = (mesh: IndexedMesh | Float32Array, unit?: number) => Promise<IndexedMesh>;
export interface ImportOptions { simplify?: (mesh: IndexedMesh, unit: number) => IndexedMesh; progress?: (fraction: number, message: string) => void }
export interface ImportedMini { name: string; geometry: BufferGeometry; source?: SourceReference; sources?: SourceReference[]; triangles?: number; topology?: IndexedMesh }
export interface SourcePackage { archive: ZipArchive; references: Map<string, Map<string, string>>; objectIds: Map<string, string[]> }
export interface ImportedModel {
  minis: ImportedMini[];
  geometry: BufferGeometry;
  partCount: number;
  has3mf: boolean;
  skippedItems: number;
  source?: SourcePackage;
}

function children(node: Element | undefined, name: string, namespace = CORE): Element[] {
  return node ? Array.from(node.childNodes).filter((n): n is Element =>
    n.nodeType === 1 && (n as Element).localName === name && (n as Element).namespaceURI === namespace) : [];
}

function number(node: Element, attribute: string): number {
  const raw = node.getAttribute(attribute);
  if (!raw?.trim() || !Number.isFinite(Number(raw))) throw new Error(`Invalid 3MF ${attribute} value.`);
  return Number(raw);
}

function id(node: Element, attribute: string): string {
  const value = number(node, attribute);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid 3MF ${attribute}.`);
  return String(value);
}

function matrix(node: Element): Matrix4 {
  const raw = node.getAttribute('transform');
  if (raw === null || raw === '') return new Matrix4();
  const v = raw.trim().split(/\s+/).map(Number);
  if (v.length !== 12 || !v.every(Number.isFinite)) throw new Error('A 3MF placement transform is invalid.');
  // 3MF uses row vectors; Three.js uses column vectors. Translation is the last triplet.
  const result = new Matrix4().set(v[0], v[3], v[6], v[9], v[1], v[4], v[7], v[10], v[2], v[5], v[8], v[11], 0, 0, 0, 1);
  if (!Number.isFinite(result.determinant()) || result.determinant() === 0) throw new Error('A 3MF placement transform has zero or invalid scale.');
  return result;
}

function packagePath(raw: string, base = ''): string {
  // Resolve only paths inside this ZIP. Never fetch an external model reference.
  let decoded: string;
  try { decoded = decodeURIComponent(raw); } catch { throw new Error('Invalid 3MF archive path.'); }
  if (/[\\:#?\0]/.test(decoded) || decoded.startsWith('//')) throw new Error('External or invalid 3MF model paths are not supported.');
  const path: string[] = decoded.startsWith('/') ? [] : base.split('/').slice(0, -1);
  for (const segment of decoded.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') { if (!path.length) throw new Error('A 3MF path leaves the archive.'); path.pop(); }
    else path.push(segment);
  }
  return path.join('/');
}

/** Read Core meshes and Production-extension instances, with all placements baked in. */
export function parse3MF(data: ArrayBuffer, options: ImportOptions = {}): ImportedModel {
  const prepared = prepare3MF(data, options.progress);
  if (options.simplify) for (const {mesh, unit} of prepared.jobs) Object.assign(mesh, options.simplify(mesh, unit));
  return prepared.finish(!!options.simplify);
}

export async function parse3MFAsync(data: ArrayBuffer, simplify: AsyncSimplifier, progress?: ImportOptions['progress']): Promise<ImportedModel> {
  const prepared = prepare3MF(data, progress);
  let completed = 0;
  await Promise.all(prepared.jobs.map(async ({mesh, unit}) => {
    Object.assign(mesh, await simplify(mesh, unit));
    progress?.(.25 + .75 * ++completed / prepared.jobs.length, `Simplifying meshes · ${completed} / ${prepared.jobs.length}`);
  }));
  return prepared.finish(true);
}

function prepare3MF(data: ArrayBuffer, progress?: ImportOptions['progress']) {
  if (data.byteLength < 22) throw new Error('The 3MF archive is empty or truncated.');
  let archive: ZipArchive;
  try { archive = new ZipArchive(new Uint8Array(data)); }
  catch (error) { throw new Error(`Could not open this 3MF. ${error instanceof Error ? error.message : 'Invalid ZIP archive.'}`); }
  const files = new Map<string, string>();
  for (const name of archive.members.keys()) {
    if (!name.toLowerCase().endsWith('.model') && name !== '_rels/.rels') continue;
    const path = packagePath(name);
    if (files.has(path)) throw new Error('The 3MF contains duplicate model paths.');
    files.set(path, name);
  }
  for (const [path, name] of files) {
    if (path !== name) {
      archive.members.set(path, {...archive.members.get(name)!, name: path});
      archive.members.delete(name);
      files.set(path, path);
    }
  }
  const sourceReferences = new Map<string, Map<string, string>>();
  const parsedMeshes = new Map<string, { mesh: IndexedMesh; triangles: number }[]>();
  function xml(path: string): Element {
    const name = files.get(path);
    if (!name) throw new Error(`The 3MF is missing a referenced file: ${path}`);
    let source = strFromU8(archive.read(name));
    if (/<!DOCTYPE|<!ENTITY/i.test(source)) throw new Error('3MF XML with entity declarations is not supported.');
    // Numeric mesh data goes straight into typed arrays; only the small structural
    // skeleton becomes a DOM. A million faces no longer creates a million XML nodes.
    const meshes: { mesh: IndexedMesh; triangles: number }[] = [];
    source = source.replace(/<((?:[\w.-]+:)?mesh)\b[^>]*>([\s\S]*?)<\/\1\s*>/g, (_whole, tag: string, body: string) => {
      const attributes = (raw: string, names: string[]) => names.map(name => {
        const value = raw.match(new RegExp('(?:^|\\s)' + name + '\\s*=\\s*["\']([^"\']*)["\']'))?.[1];
        if (!value?.trim() || !Number.isFinite(Number(value))) throw new Error('Invalid 3MF mesh value.');
        return Number(value);
      });
      function numbers(tagName: string, names: string[], indices: boolean) {
        const pattern = new RegExp('<(?:[\\w.-]+:)?' + tagName + '\\b([^>]*?)(?:/?>)', 'g');
        let count = 0; while (pattern.exec(body)) count++;
        const values = indices ? new Uint32Array(count * 3) : new Float32Array(count * 3);
        const fast = indices ? /^\s*v1="([^"]+)"\s+v2="([^"]+)"\s+v3="([^"]+)"/ : /^\s*x="([^"]+)"\s+y="([^"]+)"\s+z="([^"]+)"/;
        pattern.lastIndex = 0; let match, i = 0;
        while ((match = pattern.exec(body))) {
          const quick = match[1].match(fast), v = quick ? [Number(quick[1]), Number(quick[2]), Number(quick[3])] : attributes(match[1], names);
          for (const value of v) {
            if (!Number.isFinite(value) || (indices && (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff))) throw new Error('Invalid 3MF mesh value.');
            values[i++] = value;
          }
        }
        return values;
      }
      const vertices = numbers('vertex', ['x', 'y', 'z'], false) as Float32Array;
      const indices = numbers('triangle', ['v1', 'v2', 'v3'], true) as Uint32Array;
      if (!vertices.every(Number.isFinite)) throw new Error('The 3MF contains coordinates outside the supported range.');
      if (!vertices.length || !indices.length) throw new Error('A printable 3MF object has no triangle geometry.');
      if (indices.some(index => index >= vertices.length / 3)) throw new Error('A 3MF triangle references a missing vertex.');
      const mesh = { vertices, indices };
      meshes.push({ mesh, triangles: indices.length / 3 });
      return `<${tag} data-mesh="${meshes.length - 1}"/>`;
    });
    parsedMeshes.set(path, meshes);
    const doc = new DOMParser().parseFromString(source, 'application/xml');
    if (!doc.documentElement || doc.getElementsByTagName('parsererror').length) throw new Error(`Invalid 3MF XML in ${path}.`);
    return doc.documentElement;
  }
  const rels = files.has('_rels/.rels') ? xml('_rels/.rels') : undefined;
  const rootRel = children(rels, 'Relationship', RELATIONSHIPS).find(r => r.getAttribute('Type') === MODEL_RELATIONSHIP);
  if (rootRel?.getAttribute('TargetMode') === 'External') throw new Error('External 3MF models are not supported.');
  const rootPath = rootRel ? packagePath(rootRel.getAttribute('Target') || '') : '3D/3dmodel.model';
  if (!files.has(rootPath)) throw new Error('The 3MF has no root model. Export a 3MF containing geometry, not only sliced toolpaths.');

  interface Model { root: Element; objects: Map<string, Element>; unit: number }
  interface Mesh extends IndexedMesh { triangles: number }
  const models = new Map<string, Model>();
  const meshes = new Map<Element, Mesh>();
  function model(path: string): Model {
    const cached = models.get(path);
    if (cached) return cached;
    const root = xml(path);
    if (root.localName !== 'model' || root.namespaceURI !== CORE) throw new Error('Unsupported 3MF model format.');
    for (const prefix of (root.getAttribute('requiredextensions') || '').trim().split(/\s+/).filter(Boolean)) {
      if (root.lookupNamespaceURI(prefix) !== PRODUCTION) throw new Error(`This 3MF requires the unsupported extension “${prefix}”. Export a geometry-only 3MF or STL.`);
    }
    const unit = UNITS[root.getAttribute('unit') || 'millimeter'];
    if (!unit) throw new Error('The 3MF uses an unsupported measurement unit.');
    const objects = new Map<string, Element>();
    for (const object of children(children(root, 'resources')[0], 'object')) {
      const key = id(object, 'id');
      if (objects.has(key)) throw new Error('The 3MF contains duplicate object IDs.');
      objects.set(key, object);
    }
    const refs = new Map<string, string>();
    for (const node of Array.from(root.getElementsByTagName('*'))) {
      const raw = node.getAttributeNS(PRODUCTION, 'path');
      if (raw) refs.set(raw, packagePath(raw, path));
    }
    sourceReferences.set(path, refs);
    const result = { root, objects, unit }; models.set(path, result); return result;
  }
  function mesh(object: Element, path: string): Mesh {
    const cached = meshes.get(object); if (cached) return cached;
    const node = children(object, 'mesh')[0];
    const parsed = parsedMeshes.get(path)?.[Number(node?.getAttribute('data-mesh'))];
    if (!parsed) throw new Error('A printable 3MF object has no triangle geometry.');
    const result = { ...parsed.mesh, triangles: parsed.triangles }; meshes.set(object, result); return result;
  }
  const instances: { mesh: Mesh; world: Matrix4; source: SourceReference }[] = [];
  let originalTriangles = 0, visited = 0, skippedItems = 0;
  const ancestors = new Set<string>();
  function visit(reference: Element, sourcePath: string, parent: Matrix4, depth = 0) {
    if (++visited > 20_000 || depth > 32) throw new Error('The 3MF has too many nested components or instances.');
    const target = reference.getAttributeNS(PRODUCTION, 'path');
    const path = target ? packagePath(target, sourcePath) : sourcePath;
    const current = model(path), source = model(sourcePath), objectId = id(reference, 'objectid');
    const object = current.objects.get(objectId), key = `${path}#${objectId}`;
    if (!object) throw new Error(`The 3MF references missing object ${objectId} in ${path}.`);
    if (ancestors.has(key)) throw new Error('The 3MF contains a circular component reference.');
    const ratio = current.unit / source.unit;
    const world = parent.clone().multiply(matrix(reference)).multiply(new Matrix4().makeScale(ratio, ratio, ratio));
    if (!world.elements.every(Number.isFinite) || !Number.isFinite(world.determinant()) || world.determinant() === 0) throw new Error('The combined 3MF placement is invalid.');
    ancestors.add(key);
    const components = children(children(object, 'components')[0], 'component');
    const hasMesh = children(object, 'mesh').length > 0;
    if (hasMesh && components.length) throw new Error('A 3MF object cannot contain both a mesh and components.');
    if (hasMesh) {
      const value = mesh(object, path); originalTriangles += value.triangles;
      instances.push({ mesh: value, world, source: {path, objectId, transform: world.toArray(), unit: current.unit} });
    } else {
      if (!components.length) throw new Error('A printable 3MF object has no triangle geometry.');
      for (const component of components) visit(component, path, world, depth + 1);
    }
    ancestors.delete(key);
  }
  const groups: { name: string; source: SourceReference; triangles: number; firstInstance: number; lastInstance: number }[] = [];
  const root = model(rootPath), scale = new Matrix4().makeScale(root.unit, root.unit, root.unit);
  const items = children(children(root.root, 'build')[0], 'item');
  for (const [index, item] of items.entries()) {
    progress?.(.25 * index / items.length, `Reading meshes · ${index + 1} / ${items.length}`);
    if (['0', 'false'].includes(item.getAttribute('printable') || '')) { skippedItems++; continue; }
    const before = originalTriangles, firstInstance = instances.length;
    visit(item, rootPath, scale);
    const target = item.getAttributeNS(PRODUCTION, 'path');
    const path = target ? packagePath(target, rootPath) : rootPath, current = model(path);
    const object = current.objects.get(id(item, 'objectid'))!;
    const transform = scale.clone().multiply(matrix(item)).multiply(new Matrix4().makeScale(current.unit / root.unit, current.unit / root.unit, current.unit / root.unit));
    groups.push({ name: object.getAttribute('name') || `Mini ${groups.length + 1}`, triangles: originalTriangles - before, firstInstance, lastInstance: instances.length,
      source: { path, objectId: id(item, 'objectid'), transform: transform.toArray(), unit: current.unit } });
  }
  if (!instances.length) throw new Error('The 3MF contains no printable mesh instances. Export a 3MF containing geometry.');
  // Repeated instances share one simplification job, before placements are baked in.
  const unique = new Map<Mesh, number>();
  for (const instance of instances) unique.set(instance.mesh, instance.source.unit);
  function finish(simplified: boolean): ImportedModel {
    const starts = [0];
    for (const {mesh} of instances) starts.push(starts[starts.length - 1] + mesh.indices.length * 3);
    const positions = new Float32Array(starts[starts.length - 1]), vertex = new Vector3();
    let cursor = 0;
    for (const { mesh, world } of instances) {
      const mirrored = world.determinant() < 0;
      for (let face = 0; face < mesh.indices.length; face += 3) {
        for (const corner of mirrored ? [0, 2, 1] : [0, 1, 2]) {
          vertex.fromArray(mesh.vertices, mesh.indices[face + corner] * 3).applyMatrix4(world);
          positions[cursor++] = vertex.x; positions[cursor++] = vertex.y; positions[cursor++] = vertex.z;
        }
      }
    }
    if (!positions.every(Number.isFinite)) throw new Error('The 3MF contains coordinates outside the supported range.');
    const geometry = new BufferGeometry().setAttribute('position', new Float32BufferAttribute(positions, 3));
    geometry.computeVertexNormals();
    const minis = groups.map(group => {
      const part = new BufferGeometry().setAttribute('position', new Float32BufferAttribute(positions.slice(starts[group.firstInstance], starts[group.lastInstance]), 3));
      part.computeVertexNormals();
      let topology: IndexedMesh | undefined;
      if (simplified) {
        const parts = instances.slice(group.firstInstance,group.lastInstance);
        const vertices = new Float32Array(parts.reduce((n,p)=>n+p.mesh.vertices.length,0));
        const indices = new Uint32Array(parts.reduce((n,p)=>n+p.mesh.indices.length,0));
        let v = 0, f = 0;
        for (const {mesh,world} of parts) {
          for(let i=0;i<mesh.vertices.length;i+=3){vertex.fromArray(mesh.vertices,i).applyMatrix4(world);vertices.set([vertex.x,vertex.y,vertex.z],v+i)}
          const mirrored=world.determinant()<0;
          for(let i=0;i<mesh.indices.length;i+=3)for(const k of mirrored?[0,2,1]:[0,1,2])indices[f++]=mesh.indices[i+k]+v/3;
          v+=mesh.vertices.length;
        }
        topology={vertices,indices};
      }
      // Keep direct references to the original mesh leaves. Exporters can flatten
      // cross-file assembly nesting without touching a vertex or triangle.
      return { name: group.name, geometry: part, source: group.source, sources: instances.slice(group.firstInstance,group.lastInstance).map(instance=>instance.source), triangles: group.triangles, topology };
    });
    return { geometry, minis, partCount: instances.length, has3mf: true, skippedItems, source: { archive, references: sourceReferences, objectIds: new Map([...models].map(([path, value])=>[path, [...value.objects.keys()]])) } };
  }
  return {jobs: [...unique].map(([mesh, unit]) => ({mesh, unit})), finish};
}

function parseSTL(data: ArrayBuffer): ImportedModel {
  if (data.byteLength < 84) throw new Error('The STL is empty or truncated.');
  const faces = new DataView(data).getUint32(80, true), length = 84 + faces * 50;
  const ascii = length !== data.byteLength && /^.{0,4}solid/s.test(new TextDecoder().decode(data.slice(0, 9)));
  if (!ascii && length !== data.byteLength) throw new Error('The binary STL is truncated or has an invalid triangle count.');
  const geometry = new STLLoader().parse(data);
  for (const attr of Object.keys(geometry.attributes)) if (attr !== 'position' && attr !== 'normal') geometry.deleteAttribute(attr);
  const values = geometry.getAttribute('position').array;
  if (!values.length || values.length % 9 !== 0 || !values.every(Number.isFinite)) { geometry.dispose(); throw new Error('The STL has no valid triangles or contains invalid coordinates.'); }
  geometry.computeVertexNormals();
  return { geometry, minis: [{ name: 'Mini', geometry: geometry.clone() }], partCount: 1, has3mf: false, skippedItems: 0 };
}

export function centerOnPlate(geometry: BufferGeometry) {
  geometry.computeBoundingBox(); const bounds = geometry.boundingBox!;
  geometry.translate(-(bounds.min.x + bounds.max.x) / 2, -(bounds.min.y + bounds.max.y) / 2, -bounds.min.z);
  geometry.computeBoundingBox();
}

/** Arrange uploaded files as units, never rearranging the parts inside a 3MF. */
export function importModels(inputs: ModelInput[]): ImportedModel {
  if (!inputs.length) throw new Error('Add an STL or 3MF first.');
  const geometries: BufferGeometry[] = [], minis: ImportedMini[] = [];
  let complete = false;
  let cursor = 0, partCount = 0, skippedItems = 0, has3mf = false;
  try {
    for (const input of inputs) {
      const imported = /\.3mf$/i.test(input.name) ? parse3MF(input.data)
        : /\.stl$/i.test(input.name) ? parseSTL(input.data) : undefined;
      if (!imported) throw new Error('Please choose STL or 3MF files.');
      const geometry = imported.geometry; geometries.push(geometry);
      geometry.computeBoundingBox();
      const offset = geometry.boundingBox!.getCenter(new Vector3()).negate();
      offset.z = -geometry.boundingBox!.min.z;
      const fileMinis = imported.minis;
      if (!imported.has3mf) fileMinis[0].name = input.name.replace(/\.stl$/i, '');
      minis.push(...fileMinis);
      centerOnPlate(geometry);
      const size = geometry.boundingBox!.getSize(new Vector3());
      if (Math.max(size.x, size.y, size.z) < .01) throw new Error('The model is too small. STL dimensions are interpreted as millimeters.');
      geometry.translate(cursor + size.x / 2, 0, 0);
      offset.x += cursor + size.x / 2;
      for (const mini of fileMinis) mini.geometry.translate(offset.x, offset.y, offset.z);
      cursor += size.x + 12;
      partCount += imported.partCount; skippedItems += imported.skippedItems; has3mf ||= imported.has3mf;
    }
    const geometry = mergeGeometries(geometries, false);
    if (!geometry) throw new Error('Could not combine these models.');
    geometry.computeBoundingBox();
    const offset = geometry.boundingBox!.getCenter(new Vector3()).negate(); offset.z = -geometry.boundingBox!.min.z;
    for (const mini of minis) mini.geometry.translate(offset.x, offset.y, offset.z);
    centerOnPlate(geometry); complete = true;
    return { geometry, minis, partCount, has3mf, skippedItems };
  } finally {
    geometries.forEach(geometry => geometry.dispose());
    if (!complete) minis.forEach(mini => mini.geometry.dispose());
  }
}
