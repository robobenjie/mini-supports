import { zipSync, strToU8 } from 'fflate';
import { readFile } from 'node:fs/promises';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';

export const CORE = 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02';
export const PRODUCTION = 'http://schemas.microsoft.com/3dmanufacturing/production/2015/06';
export const modelXML = (resources, build = '', unit = 'millimeter', extra = '') =>
  `<model xmlns="${CORE}" xmlns:p="${PRODUCTION}" unit="${unit}" ${extra}><resources>${resources}</resources><build>${build}</build></model>`;
export const relsXML = target => `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" Target="${target}"/></Relationships>`;
export function archive(root, others = {}, rootPath = '3D/3dmodel.model') {
  return zipSync(Object.fromEntries(Object.entries({
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>',
    '_rels/.rels': relsXML('/' + rootPath), [rootPath]: root, ...others,
  }).map(([path, value]) => [path, strToU8(value)])), { level: 6 });
}
export function meshXML(positions) {
  let vertices = '', triangles = '';
  for (let i = 0; i < positions.length; i += 3) vertices += `<vertex x="${positions[i]}" y="${positions[i + 1]}" z="${positions[i + 2]}"/>`;
  for (let i = 0; i < positions.length / 3; i += 3) triangles += `<triangle v1="${i}" v2="${i + 1}" v3="${i + 2}"/>`;
  return `<mesh><vertices>${vertices}</vertices><triangles>${triangles}</triangles></mesh>`;
}

// Two overhanging shelves, one turned 90 degrees. Production-style separate mesh file.
export async function arrangedShelves() {
  const bytes = await readFile('public/examples/shelf.stl');
  const geometry = new STLLoader().parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const resource = `<object id="1" type="model">${meshXML(geometry.getAttribute('position').array)}</object>`;
  geometry.dispose();
  return archive(modelXML('<object id="2" type="model"><components><component objectid="1" p:path="/3D/Objects/shelf.model"/></components></object>',
    '<item objectid="2" transform="1 0 0 0 1 0 0 0 1 30 35 0"/><item objectid="2" transform="0 1 0 -1 0 0 0 0 1 90 40 0"/>',
    'millimeter', 'requiredextensions="p"'), {
    '3D/Objects/shelf.model': modelXML(resource),
    '3D/_rels/build.model.rels': relsXML('/3D/Objects/shelf.model'),
  }, '3D/build.model');
}
