import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { DOMParser } from '@xmldom/xmldom';
import { BoxGeometry, Mesh, Vector3 } from 'three';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';
import { zipSync, strToU8 } from 'fflate';
import { importModels, parse3MF } from '../src/model-import.ts';
import { archive, arrangedShelves, meshXML, modelXML, relsXML } from './3mf-fixtures.mjs';

// The application uses the browser's native DOMParser. This supplies the same DOM API in Node.
globalThis.DOMParser = DOMParser;
const buffer = bytes => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const parse = (root, others, path) => parse3MF(buffer(archive(root, others, path)));
const close = (actual, expected) => assert(Math.abs(actual - expected) < Math.max(1e-5, Math.abs(expected) * 1e-6), `${actual} != ${expected}`);
const box = new BoxGeometry(2, 4, 6).toNonIndexed(); box.translate(1, 2, 3);
const object = `<object id="1">${meshXML(box.getAttribute('position').array)}</object>`;
const volume = positions => {
  let result = 0;
  const a = new Vector3(), b = new Vector3(), c = new Vector3();
  for (let i = 0; i < positions.length; i += 9) result += a.fromArray(positions, i).dot(b.fromArray(positions, i + 3).cross(c.fromArray(positions, i + 6))) / 6;
  return result;
};

// Root relationship, cross-file reference, repeated instance, component + item transforms,
// prefixed Core nodes, a mirror, and a non-printable build item.
const assemblies = '<object id="3"><components><component objectid="1" p:path="/3D/Objects/box%20one.model" transform="1 0 0 0 1 0 0 0 1 5 2 0"/></components></object>' +
  '<object id="4"><components><component objectid="3"/></components></object>';
const items = '<item objectid="4" transform="0 1 0 -1 0 0 0 0 1 40 30 3"/>' +
  '<item objectid="1" p:path="/3D/Objects/box%20one.model" transform="-1 0 0 0 1 0 0 0 1 70 20 9"/>' +
  '<item objectid="999" printable="0"/>';
const external = modelXML(object).replace('<model xmlns=', '<c:model xmlns:c=').replace('</model>', '</c:model>')
  .replace(/<(\/?)(resources|build|object|mesh|vertices|vertex|triangles|triangle)(?=[\s/>])/g, '<$1c:$2');
const input = archive(modelXML(assemblies, items, 'millimeter', 'requiredextensions="p"'), { '3D/Objects/box one.model': external }, '3D/build.model');
const raw = parse3MF(buffer(input));
assert.equal(raw.partCount, 2); assert.equal(raw.skippedItems, 1);
const positions = raw.geometry.getAttribute('position').array;
const half = positions.length / 2;
const bounds = values => {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < values.length; i++) { min[i % 3] = Math.min(min[i % 3], values[i]); max[i % 3] = Math.max(max[i % 3], values[i]); }
  return { min, max };
};
assert.deepEqual(bounds(positions.slice(0, half)), { min: [34, 35, 3], max: [38, 37, 9] });
assert.deepEqual(bounds(positions.slice(half)), { min: [68, 20, 9], max: [70, 24, 15] });
close(volume(positions.slice(0, half)), 48); close(volume(positions.slice(half)), 48);
const imported = importModels([{ name: 'arranged.3MF', data: buffer(input) }]);
const centered = imported.geometry.getAttribute('position').array;
assert.deepEqual(bounds(centered.slice(0, half)), { min: [-18, 6.5, 0], max: [-14, 8.5, 6] });
assert.deepEqual(bounds(centered.slice(half)), { min: [16, -8.5, 6], max: [18, -4.5, 12] });
console.log('PASS placements: nested components, external files, rotation, translation, mirrored winding, copies, relative heights');

for (const [unit, factor] of Object.entries({ micron: .001, millimeter: 1, centimeter: 10, inch: 25.4, foot: 304.8, meter: 1000 })) {
  const value = parse(modelXML(object, '<item objectid="1" transform="1 0 0 0 1 0 0 0 1 2 0 0"/>', unit));
  const b = bounds(value.geometry.getAttribute('position').array);
  close(b.min[0], 2 * factor); close(b.max[0], 4 * factor); close(b.max[2], 6 * factor);
}
const unitMix = parse(modelXML('<object id="2"><components><component objectid="1" p:path="/3D/inches.model" transform="1 0 0 0 1 0 0 0 1 10 0 0"/></components></object>', '<item objectid="2"/>'), { '3D/inches.model': modelXML(object, '', 'inch') });
close(bounds(unitMix.geometry.getAttribute('position').array).max[0], 60.8);
console.log('PASS units: all Core units and cross-file unit conversion');

const bad = (xml, pattern) => assert.throws(() => parse(xml), pattern);
bad(modelXML(object, '<item objectid="9"/>'), /missing object/);
bad(modelXML('<object id="1"><components><component objectid="1"/></components></object>', '<item objectid="1"/>'), /circular/);
bad(modelXML(object, '<item objectid="1" transform="1 2 3"/>'), /transform/);
bad(modelXML(object, '<item objectid="1" transform="0 0 0 0 0 0 0 0 0 0 0 0"/>'), /scale/);
bad(modelXML(object.replace('x="2"', 'x="NaN"'), '<item objectid="1"/>'), /value/);
bad(modelXML(object.replace('v1="0"', 'v1="9999"'), '<item objectid="1"/>'), /missing vertex/);
bad(modelXML(object, '<item objectid="1" p:path="https://example.com/a.model"/>'), /paths/);
bad(modelXML(object, '<item objectid="1" p:path="/3D/missing.model"/>'), /missing a referenced file/);
bad(modelXML(object, '<item objectid="1" printable="false"/>'), /no printable/);
bad(modelXML(object, '<item objectid="1"/>', 'parsecs'), /unit/);
bad(modelXML(object, '<item objectid="1"/>', 'millimeter', 'requiredextensions="unknown"'), /unsupported extension/);
bad('<!DOCTYPE model [<!ENTITY bad "hello">]>' + modelXML(object, '<item objectid="1"/>'), /entity/);
assert.throws(() => parse3MF(new ArrayBuffer(0)), /truncated/);
assert.throws(() => parse3MF(new ArrayBuffer(100)), /open this 3MF/);
const duplicates = zipSync({ '_rels/.rels': strToU8(relsXML('/3D/3dmodel.model')), '3D/3dmodel.model': strToU8(modelXML(object)), '3D/./3dmodel.model': strToU8(modelXML(object)) });
assert.throws(() => parse3MF(buffer(duplicates)), /duplicate/);
console.log('PASS invalid inputs: missing references, cycles, transforms, indices, units, extensions, corrupt archives and duplicate paths');

const stl = new STLExporter().parse(new Mesh(box), { binary: true }).buffer;
const mixed = importModels([{ name: 'box.stl', data: stl }, { name: 'assembly.3mf', data: buffer(input) }]);
assert.equal(mixed.partCount, 3); assert.equal(mixed.has3mf, true);
assert.equal(mixed.geometry.getAttribute('position').count / 3, 36);
assert.equal(bounds(mixed.geometry.getAttribute('position').array).max[0] - bounds(mixed.geometry.getAttribute('position').array).min[0], 50);
console.log('PASS mixed STL + 3MF upload: spacing between files, arrangement within the 3MF');

await mkdir('test-results', { recursive: true });
const shelves = await arrangedShelves();
await writeFile('test-results/arranged-shelves.3mf', shelves);
const plate = importModels([{ name: 'arranged-shelves.3mf', data: buffer(shelves) }]);
assert.equal(plate.partCount, 2);
await writeFile('test-results/arranged-shelves.stl', new Uint8Array(new STLExporter().parse(new Mesh(plate.geometry), { binary: true }).buffer));
// Export a bad file for browser error-state QA without replacing the currently loaded plate.
await writeFile('test-results/missing-object.3mf', archive(modelXML(object, '<item objectid="999"/>')));
console.log('3MF import tests passed. End-to-end fixture: test-results/arranged-shelves.3mf');
