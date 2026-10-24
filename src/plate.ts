import { Box3, BufferAttribute, BufferGeometry, Matrix4, Vector3 } from 'three';
import { strFromU8 } from 'fflate';
import { importModels, parse3MFAsync, type AsyncSimplifier, type ImportedModel, type SourceReference, type SourcePackage } from './model-import.ts';
import { indexSTL, simplifyMesh, simplifierReady, type IndexedMesh } from './simplify.ts';
import { mapImportFiles } from './simplify-pool.ts';
import { ZipArchive, textMembers, packMembers, type ZipMember } from './zip-archive.ts';
import { placeNearby, type Footprint } from './placement.ts';
const CORE = 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02';
const PRODUCTION = 'http://schemas.microsoft.com/3dmanufacturing/production/2015/06';
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const MODEL_REL = 'http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel';
const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const transform = (m: Matrix4) => [0,1,2,4,5,6,8,9,10,12,13,14].map(i => m.elements[i]).join(' ');
const model = (resources: string, build = '') => `<model xmlns="${CORE}" xmlns:p="${PRODUCTION}" requiredextensions="p" unit="millimeter"><resources>${resources}</resources><build>${build}</build></model>`;
const rels = (paths: string[]) => `<Relationships xmlns="${REL}">${paths.map((p,i)=>`<Relationship Id="r${i}" Type="${MODEL_REL}" Target="/${escape(p)}"/>`).join('')}</Relationships>`;
export interface PreviewPart { name: string; positions: Float32Array; triangles: number; topology?: IndexedMesh }
export interface PreparedPlate { minis: PreviewPart[]; partCount: number; has3mf: boolean; skippedItems: number }
export interface ExportPart { output: Uint8Array; lift: number; transform: number[]; supportOffset?: number[]; name: string }
interface OriginalPart { source: number; references: SourceReference[] }
export interface PlateSnapshot {
  sources: {members: Map<string, ZipMember>; references: SourcePackage['references']; objectIds: SourcePackage['objectIds']}[];
  parts: OriginalPart[];
}
export interface AdditionPlacement { occupied: Footprint[] }

/** Original compressed sculpture meshes stay in this worker; the UI gets lightweight previews. */
export class Plate {
  sources: SourcePackage[] = [];
  parts: OriginalPart[] = [];
  async load(inputs: {name: string; data: ArrayBuffer}[], progress: (f: number, text: string) => void, placement?: AdditionPlacement, simplify?: AsyncSimplifier): Promise<PreparedPlate> {
    if (!simplify) {
      await simplifierReady;
      simplify = async (mesh, unit = 1) => simplifyMesh(mesh instanceof Float32Array ? indexSTL(mesh) : mesh, unit);
    }
    const simplifyImport = simplify;
    const minis: PreviewPart[] = [], sources: SourcePackage[] = [], parts: OriginalPart[] = [];
    let partCount = 0, skippedItems = 0, has3mf = false;
    const occupied = [...(placement?.occupied ?? [])];
    const bounds = new Box3();
    const fractions = inputs.map(() => 0);
    const importedInputs = await mapImportFiles(inputs, async (input, fileIndex) => {
      const report = (fraction: number, message: string) => {
        fractions[fileIndex] = Math.max(fractions[fileIndex], fraction);
        progress(fractions.reduce((sum, value) => sum + value, 0) / inputs.length * .95, message);
      };
      let imported: ImportedModel;
      if (/\.3mf$/i.test(input.name)) imported = await parse3MFAsync(input.data, simplifyImport, report);
      else {
        imported = importModels([input]);
        const vertices = imported.geometry.getAttribute('position').array;
        let xml = '<object id="1"><mesh><vertices>';
        for (let i = 0; i < vertices.length; i += 3) xml += `<vertex x="${vertices[i]}" y="${vertices[i+1]}" z="${vertices[i+2]}"/>`;
        xml += '</vertices><triangles>';
        for (let i = 0; i < vertices.length / 3; i += 3) xml += `<triangle v1="${i}" v2="${i+1}" v3="${i+2}"/>`;
        xml += '</triangles></mesh></object>';
        const members = textMembers({'3D/stl.model': model(xml)});
        imported.source = {archive: new ZipArchive(packMembers(members)), references: new Map([['3D/stl.model', new Map()]]), objectIds: new Map([['3D/stl.model', ['1']]])};
        imported.minis[0].sources = [{ path: '3D/stl.model', objectId: '1', transform: new Matrix4().toArray(), unit: 1 }];
        // Keep the original above for export; only preview/support analysis uses
        // the same error-bounded simplification already used for 3MF inputs.
        report(.25, 'Simplifying meshes for support placement');
        const triangles = vertices.length / 9;
        const topology = await simplifyImport(vertices as Float32Array);
        const positions = new Float32Array(topology.indices.length * 3);
        for (let i = 0; i < topology.indices.length; i++) positions.set(topology.vertices.subarray(topology.indices[i]*3, topology.indices[i]*3+3), i*3);
        const geometry = new BufferGeometry().setAttribute('position', new BufferAttribute(positions, 3));
        imported.minis[0].geometry.dispose(); imported.geometry.dispose();
        imported.minis[0].geometry = geometry;
        imported.minis[0].triangles = triangles;
        imported.minis[0].topology = topology;
        imported.geometry = geometry;
      }
      report(1, 'Arranging models…');
      return imported;
    });
    for (const imported of importedInputs) {
      imported.geometry.computeBoundingBox(); const box = imported.geometry.boundingBox!;
      const size = box.getSize(new Vector3()), footprint = placeNearby(size.x,size.y,occupied);
      // A 3MF is placed as one unit, keeping its internal arrangement intact.
      const offset = new Vector3(footprint.minX-box.min.x, footprint.minY-box.min.y, -box.min.z);
      occupied.push(footprint);
      for (const part of imported.minis) {
        part.geometry.translate(offset.x, offset.y, offset.z); part.geometry.computeBoundingBox(); bounds.union(part.geometry.boundingBox!);
        minis.push({ name: part.name, positions: part.geometry.getAttribute('position').array as Float32Array, triangles: part.triangles ?? part.geometry.getAttribute('position').count / 3, topology: part.topology });
        if(part.topology)for(let j=0;j<part.topology.vertices.length;j+=3){part.topology.vertices[j]+=offset.x;part.topology.vertices[j+1]+=offset.y;part.topology.vertices[j+2]+=offset.z}
        const references = part.sources!;
        for(const reference of references)reference.transform = new Matrix4().makeTranslation(offset.x, offset.y, offset.z).multiply(new Matrix4().fromArray(reference.transform)).toArray();
        parts.push({ source: sources.length, references }); part.geometry.dispose();
      }
      sources.push(imported.source!); imported.geometry.dispose();
      partCount += imported.partCount; skippedItems += imported.skippedItems; has3mf ||= imported.has3mf;
    }
    const offset = bounds.getCenter(new Vector3()).negate(); offset.z = -bounds.min.z;
    if (placement) { offset.x = 0; offset.y = 0; }
    for (const [i, mini] of minis.entries()) {
      for (let j = 0; j < mini.positions.length; j += 3) { mini.positions[j] += offset.x; mini.positions[j+1] += offset.y; mini.positions[j+2] += offset.z; }
      if(mini.topology)for(let j=0;j<mini.topology.vertices.length;j+=3){mini.topology.vertices[j]+=offset.x;mini.topology.vertices[j+1]+=offset.y;mini.topology.vertices[j+2]+=offset.z}
      for(const reference of parts[i].references)reference.transform = new Matrix4().makeTranslation(offset.x,offset.y,offset.z).multiply(new Matrix4().fromArray(reference.transform)).toArray();
    }
    this.sources = sources; this.parts = parts;
    progress(1, `Loaded ${minis.length} parts`);
    return {minis, partCount, skippedItems, has3mf};
  }
  snapshot(): PlateSnapshot {
    return {sources: this.sources.map(source=>({members:source.archive.members,references:source.references,objectIds:source.objectIds})), parts:this.parts};
  }
  append(addition: PlateSnapshot) {
    const sources = addition.sources.map(source=>({archive:new ZipArchive(source.members),references:source.references,objectIds:source.objectIds}));
    const parts = addition.parts.map(part=>({...part,source:part.source+this.sources.length}));
    this.sources.push(...sources); this.parts.push(...parts);
  }
  remove(index: number) {
    if (!Number.isInteger(index) || index < 0 || index >= this.parts.length) throw new Error('The selected mini is no longer on this plate.');
    this.parts.splice(index,1);
    const used = [...new Set(this.parts.map(part=>part.source))];
    this.sources = used.map(source=>this.sources[source]);
    this.parts = this.parts.map(part=>({...part,source:used.indexOf(part.source)}));
    return this.parts.reduce((count,part)=>count+part.references.length,0);
  }
  export(parts: ExportPart[], progress: (f: number, text: string) => void): Uint8Array {
    if (parts.length !== this.parts.length) throw new Error('The imported plate changed. Regenerate supports.');
    const members: ZipMember[] = [], resources: string[] = [], build: string[] = [], paths: string[] = [], configs: string[] = [];
    // Studio's sub-model reader ignores cross-file component paths, and its mesh
    // cache uses object IDs without file paths. Reference original mesh leaves
    // directly from the root and assign IDs that are unique across the package.
    const files=new Map<string,{source:number;path:string;name:string;ids:Map<string,string>}>();
    for(const part of this.parts)for(const ref of part.references){
      const key=`${part.source}/${ref.path}`;
      if(!files.has(key))files.set(key,{source:part.source,path:ref.path,name:`3D/source${part.source}/${ref.path}`,ids:new Map()});
    }
    const used=new Set<string>();
    for(const file of files.values())for(const id of this.sources[file.source].objectIds.get(file.path)!)used.add(id);
    let nextId=1;
    const allocate=()=>{while(used.has(String(nextId)))nextId++;const id=String(nextId++);used.add(id);return id};
    const assigned=new Set<string>();
    for(const file of files.values()){
      const source=this.sources[file.source];
      for(const id of source.objectIds.get(file.path)!){const unique=assigned.has(id)?allocate():id;file.ids.set(id,unique);assigned.add(unique)}
      paths.push(file.name);
      if([...file.ids].every(([before,after])=>before===after))members.push({...source.archive.members.get(file.path)!,name:file.name});
      else {
        // Only IDs change for colliding input packages; mesh XML stays exact.
        const xml=strFromU8(source.archive.read(file.path)).replace(/(<(?:[\w.-]+:)?(?:object|component|item)\b[^>]*?\b(?:objectid|id)\s*=\s*["'])(\d+)(["'])/g,
          (whole,start,id,end)=>file.ids.has(id)?start+file.ids.get(id)+end:whole);
        members.push(...textMembers({[file.name]:xml}));
      }
    }
    // One common XY shift preserves spacing and avoids negative plate coordinates.
    const offset = new Vector3(Infinity, Infinity, 0);
    for (const [i, part] of parts.entries()) {
      progress(i / parts.length * .8, `Packing original detail ${i+1} of ${parts.length}`);
      const generated = new ZipArchive(part.output), path = `3D/supports/part-${i}.model`;
      const xml = strFromU8(generated.read('3D/3dmodel.model'));
      // Read only the small resource headers; geometry itself stays compressed.
      const objects = [...xml.matchAll(/<object\b([^>]+)>\s*<mesh>/g)].map(match => match[1].match(/\bid="(\d+)"/)![1]);
      if (!objects.length) throw new Error('Generated 3MF has no meshes.');
      const supportIds=new Map(objects.slice(1).map(id=>[id,allocate()]));
      const supportObjects=[...xml.matchAll(/<object\b([^>]*)>([\s\S]*?)<\/object>/g)].flatMap(match=>{
        const id=match[1].match(/\bid="(\d+)"/)?.[1], mapped=id&&supportIds.get(id);
        return mapped?[`<object${match[1].replace(/\bid="\d+"/,`id="${mapped}"`)}>${match[2]}</object>`]:[];
      });
      if(supportObjects.length){members.push(...textMembers({[path]:model(supportObjects.join(''))}));paths.push(path)}
      const original = this.parts[i], delta = new Matrix4().fromArray(part.transform);
      let components = '';
      const partConfigs: string[] = [];
      const configPath = 'Metadata/model_settings.config';
      const generatedConfig = generated.members.has(configPath) ? new DOMParser().parseFromString(strFromU8(generated.read(configPath)), 'application/xml') : undefined;
      const thickSkin = generatedConfig && Array.from(generatedConfig.getElementsByTagName('metadata')).some(m => m.getAttribute('key') === 'bottom_shell_layers' && m.getAttribute('value') === '6');
      const layerHeight = generatedConfig && Array.from(generatedConfig.getElementsByTagName('metadata')).find(m => m.getAttribute('key') === 'layer_height')?.getAttribute('value');
      for(const ref of original.references){
        const file=files.get(`${original.source}/${ref.path}`)!;
        const originalMatrix=delta.clone().multiply(new Matrix4().fromArray(ref.transform));
        // A reference inherits its resource file's units; the matrix carries only placement.
        originalMatrix.multiply(new Matrix4().makeScale(1/ref.unit,1/ref.unit,1/ref.unit));
        partConfigs.push(`<part id="${file.ids.get(ref.objectId)}" subtype="normal_part"><metadata key="name" value="${escape(part.name)}"/>${thickSkin ? '<metadata key="bottom_shell_layers" value="6"/><metadata key="bottom_shell_thickness" value="0"/>' : ''}</part>`);
        components+=`<component objectid="${file.ids.get(ref.objectId)}" p:path="/${escape(file.name)}" transform="${transform(originalMatrix)}"/>`;
      }
      const shift = part.supportOffset ?? [0,0,0];
      for (const id of supportIds.values()) components += `<component objectid="${id}" p:path="/${path}" transform="1 0 0 0 1 0 0 0 1 ${shift.join(' ')}"/>`;
      for (const id of supportIds.values()) partConfigs.push(`<part id="${id}" subtype="normal_part"><metadata key="name" value="Supports"/>${thickSkin ? '<metadata key="bottom_shell_layers" value="3"/><metadata key="bottom_shell_thickness" value="0"/>' : ''}</part>`);
      const assemblyId=allocate();
      configs.push(`<object id="${assemblyId}"><metadata key="name" value="${escape(part.name)}"/><metadata key="enable_support" value="0"/>${layerHeight ? `<metadata key="layer_height" value="${escape(layerHeight)}"/>` : ''}${partConfigs.join('')}</object>`);
      resources.push(`<object id="${assemblyId}" type="model" name="${escape(part.name)}"><components>${components}</components></object>`);
      build.push(`<item objectid="${assemblyId}" transform="1 0 0 0 1 0 0 0 1 0 0 ${part.lift}"/>`);
      // The generated model and support geometry already share the same working frame.
      for (const match of xml.matchAll(/<vertex\s+x="([^"]+)"\s+y="([^"]+)"/g)) { offset.x = Math.min(offset.x,Number(match[1])+shift[0]); offset.y = Math.min(offset.y,Number(match[2])+shift[1]); }
    }
    const x = Math.max(0,-offset.x), y = Math.max(0,-offset.y);
    const items = build.map(item=>item.replace('1 0 0 0 1 0 0 0 1 0 0 ',`1 0 0 0 1 0 0 0 1 ${x} ${y} `)).join('');
    const main = '3D/3dmodel.model';
    members.push(...textMembers({
      '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/><Default Extension="config" ContentType="application/xml"/></Types>',
      'Metadata/model_settings.config': `<config>${configs.join('')}</config>`,
      '_rels/.rels': rels([main]), '3D/_rels/3dmodel.model.rels': rels(paths), [main]: model(resources.join(''), items),
    }));
    progress(.9,'Assembling download with original mesh detail');
    const output = packMembers(members); progress(1,'Ready to slice'); return output;
  }
}
