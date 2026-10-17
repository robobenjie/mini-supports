/**
 * Generate controlled, original FDM support coupons. No private model inputs.
 * Run: node scripts/research-coupons.mjs [output-directory]
 * The meshes are digitally checked here; slicing and physical printing are
 * separate gates. Import each model + supports pair as one multipart object.
 */
import Module from 'manifold-3d';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';

const api = await Module();
api.setup();
const { Manifold: M } = api;
const output = path.resolve(process.argv[2] ?? 'test-results/research/coupons');
await mkdir(output, { recursive: true });

const processAssumption = {
  printer: 'Bambu Lab A1', nozzle_mm: 0.2,
  first_layer_height_mm: 0.10, layer_height_mm: 0.06,
  first_layer_line_width_mm: 0.25, line_width_mm: 0.22,
  evidence: 'Installed A1 0.2 / 0.06mm High Quality process inheritance; final G-code must confirm these values.',
};
const roofZ = 6.10;
const lobeRadius = 1.20;
const lobeCenter = [6, 3, 5.50];
const lobeBottomZ = lobeCenter[2] - lobeRadius;
const baseTop = 0.70;
const tubeRadius = 0.60;
const tipLength = 1.20;
const circleSegments = 48;
const toGrid = z => (z - processAssumption.first_layer_height_mm) / processAssumption.layer_height_mm;
assert(Math.abs(toGrid(roofZ) - Math.round(toGrid(roofZ))) < 1e-8);
assert(Math.abs(toGrid(lobeBottomZ) - Math.round(toGrid(lobeBottomZ))) < 1e-8);

function box(size, min) { return M.cube(size).translate(min); }
function union(parts) { return M.union(parts); }
function cylinder(height, low, high, xy, z) {
  return M.cylinder(height, low, high, circleSegments).translate([xy[0], xy[1], z]);
}
function components(solid) {
  const parts = solid.decompose();
  const count = parts.length;
  for (const p of parts) p.delete();
  return count;
}
function solidInfo(solid) {
  assert.equal(solid.status(), 'NoError');
  assert(!solid.isEmpty());
  const bounds = solid.boundingBox();
  const volume = solid.volume();
  assert(volume > 0 && Number.isFinite(volume));
  return { triangles: solid.numTri(), volume_mm3: volume, bounds_mm: bounds, components: components(solid), status: solid.status() };
}
function binarySTL(solid, description) {
  const mesh = solid.getMesh();
  const { vertProperties: v, triVerts: faces, numProp: stride } = mesh;
  const buffer = Buffer.alloc(84 + faces.length / 3 * 50);
  buffer.write(description.slice(0, 79), 0, 'ascii');
  buffer.writeUInt32LE(faces.length / 3, 80);
  let out = 84;
  for (let t = 0; t < faces.length; t += 3) {
    const p = [0, 1, 2].map(i => Array.from(v.slice(faces[t + i] * stride, faces[t + i] * stride + 3)));
    const a = p[1].map((n, i) => n - p[0][i]);
    const b = p[2].map((n, i) => n - p[0][i]);
    const n = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const length = Math.hypot(...n);
    assert(length > 0);
    for (const x of [...n.map(x => x / length), ...p.flat()]) {
      assert(Number.isFinite(x));
      buffer.writeFloatLE(x, out); out += 4;
    }
    out += 2;
  }
  return buffer;
}
async function save(solid, filename, description) {
  const data = binarySTL(solid, description);
  await writeFile(path.join(output, filename), data);
  return { file: filename, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex'), ...solidInfo(solid) };
}

// 5 x 7 block lettering: 0.50 mm strokes and 0.36 mm embossing, fused to base.
const font = {
  P: ['11110','10001','10001','11110','10000','10000','10000'],
  I: ['11111','00100','00100','00100','00100','00100','11111'],
  A: ['01110','10001','10001','11111','10001','10001','10001'],
  B: ['11110','10001','10001','11110','10001','10001','11110'],
  N: ['10001','11001','11001','10101','10011','10011','10001'],
  T: ['11111','00100','00100','00100','00100','00100','00100'],
  '0': ['01110','10001','10011','10101','11001','10001','01110'],
  '1': ['00100','01100','00100','00100','00100','00100','01110'],
  '2': ['01110','10001','00001','00010','00100','01000','11111'],
};
function label(id) {
  const pixels = [];
  for (const [index, char] of [...id].entries()) {
    assert(font[char], `Unknown label ${char}`);
    for (const [row, cells] of font[char].entries()) {
      for (const [col, cell] of [...cells].entries()) {
        if (cell === '1') pixels.push(box([0.50, 0.50, 0.38], [-6 + index * 3.6 + col * 0.60, -5.40 + (6 - row) * 0.60, baseTop - 0.02]));
      }
    }
  }
  return union(pixels);
}
function supportBase(id) {
  const raw = box([20, 16, baseTop], [-8, -6, 0]);
  // The model's bed-grounded post is not glued into the support base.
  const postClearance = box([3.70, 6.70, 2], [-5.85, -0.35, -0.10]);
  return union([raw.subtract(postClearance), label(id)]);
}

// One unchanged model for every condition: a grounded post, broad cantilever
// underside, and a round lobe which first appears as a disconnected small island.
const model = union([
  box([3, 6, 7.30], [-5.50, 0, 0]),
  box([11, 6, 1.20], [-3, 0, roofZ]),
  M.sphere(lobeRadius, 96).translate(lobeCenter),
]);
assert.equal(components(model), 1, 'The test model must be a single connected part.');
const original = await save(model, 'coupon-original.stl', 'Original coupon model; identical for all conditions');

function undersideAt(x, y) {
  const hits = model.rayCast([x, y, baseTop + 0.01], [x, y, 8]);
  assert(hits.length, `No model surface above ${x},${y}`);
  // rayCast distance is a normalized fraction of this segment.
  return hits[0].position[2];
}
function pointColumn(x, y, top, radius) {
  const coneBottom = top - tipLength;
  assert(coneBottom > baseTop + 0.1);
  return union([
    cylinder(coneBottom - baseTop + 0.04, tubeRadius, tubeRadius, [x, y], baseTop - 0.02),
    cylinder(tipLength, tubeRadius, radius, [x, y], coneBottom),
  ]);
}
const flatXY = [[-1, 1], [-1, 5], [1.5, 1], [1.5, 5], [4, 1], [4, 5], [7, 1], [7, 5]];
const lobeXY = [[6, 3], [5.35, 3], [6.65, 3], [6, 2.35], [6, 3.65]];
function pointContacts(gap, diameter, flat) {
  const radius = diameter / 2;
  const contacts = [];
  const solids = [];
  for (const [kind, xy] of [...(flat ? flatXY.map(xy => ['flat-roof', xy]) : []), ...lobeXY.map(xy => ['round-island', xy])]) {
    const [x, y] = xy;
    const z = undersideAt(x, y);
    let referenceZ = z;
    if (kind === 'round-island') {
      // For a flat circular crown under a sphere, its nearest point to the
      // sphere axis sees the lowest underside. An analytic enclosing sphere
      // gives a conservative lower bound for the faceted mesh's underside.
      const rho = Math.max(0, Math.hypot(x - lobeCenter[0], y - lobeCenter[1]) - radius);
      referenceZ = lobeCenter[2] - Math.sqrt(lobeRadius ** 2 - rho ** 2);
    }
    const top = referenceZ - gap;
    solids.push(pointColumn(x, y, top, radius));
    contacts.push({ kind, xy_mm: xy, model_underside_z_at_xy_mm: z,
      lowest_underside_over_cap_reference_z_mm: referenceZ,
      support_top_z_mm: top, cap_radius_mm: radius,
      specified_min_vertical_gap_mm: gap,
      center_vertical_gap_mm: z - top,
      reference: kind === 'flat-roof' ? 'Exact planar underside' : 'Conservative analytic sphere lower envelope over flat cap; measure sliced behavior',
    });
  }
  return { solids, contacts };
}

function microInterface(gap) {
  const top = roofZ - gap;
  const roofThickness = 0.12;
  const pedestalTop = top - roofThickness;
  // Convex tapered pedestal grows gently outwards from the common base. Its
  // steepest outward slope is under 25 degrees from vertical, so the interface
  // itself is not a roof floating above sparse tips.
  const bottom = box([6, 2, 0.04], [0.15, 2.00, baseTop - 0.02]);
  const upper = box([10.30, 6.40, 0.04], [-2.00, -0.20, pedestalTop - 0.02]);
  const pedestal = M.hull([bottom, upper]);
  const roof = box([10.30, 6.40, roofThickness + 0.02], [-2.00, -0.20, pedestalTop - 0.02]);
  // A vertical clearance channel preserves the same point-supported lobe.
  const lobeKeepout = cylinder(top + 1, 1.75, 1.75, [6, 3], 0);
  return { solid: union([pedestal, roof]).subtract(lobeKeepout),
    interface: { xy_bounds_mm: [[-2, -0.2], [8.3, 6.2]],
      model_underside_z_mm: roofZ, support_top_z_mm: top,
      roof_thickness_mm: roofThickness, specified_vertical_gap_mm: gap,
      lobe_clearance_radius_mm: 1.75,
      pedestal_max_outward_angle_deg: Math.atan2(2.2, pedestalTop - baseTop) * 180 / Math.PI,
      note: 'Solid geometric local roof on a tapered pedestal. This tests interface area/finish, not material efficiency or an optimized sparse roof.' } };
}

const conditions = [];
for (const diameter of [0.26, 0.36]) {
  for (const [index, gap] of [0, 0.06, 0.12].entries()) {
    conditions.push({ id: `P${index}${diameter === 0.26 ? 'A' : 'B'}`, style: 'points', gap_mm: gap, tip_diameter_mm: diameter });
  }
}
for (const [index, gap] of [0.06, 0.12].entries()) {
  conditions.push({ id: `I${index + 1}`, style: 'micro-interface', gap_mm: gap, tip_diameter_mm: 0.36 });
}

const variants = [];
for (const condition of conditions) {
  const base = supportBase(condition.id);
  assert.equal(components(base), 1, 'Embossed ID must be attached to its base.');
  const { solids, contacts } = pointContacts(condition.gap_mm, condition.tip_diameter_mm, condition.style === 'points');
  let interfaceData = null;
  if (condition.style === 'micro-interface') {
    const generated = microInterface(condition.gap_mm);
    solids.push(generated.solid);
    interfaceData = generated.interface;
  }
  const supports = union([base, ...solids]);
  assert.equal(components(supports), 1, 'Every support and ID must connect to the base.');
  const collision = model.intersect(supports);
  assert(collision.volume() < 1e-7, `Unintended model/support intrusion in ${condition.id}: ${collision.volume()} mm3`);
  const combined = union([model, supports]);
  const supportFile = await save(supports, `${condition.id}-supports.stl`, `${condition.id}: explicit support geometry and attached label`);
  const modelFile = await save(model, `${condition.id}-model.stl`, 'Original coupon model; identical for all conditions');
  assert.equal(modelFile.sha256, original.sha256, 'All model files must be byte-identical.');
  const combinedFile = await save(combined, `${condition.id}-assembly.stl`, `${condition.id}: complete coupon assembly`);
  variants.push({ ...condition, model: modelFile, supports: supportFile, assembly: combinedFile,
    model_support_intersection_volume_mm3: collision.volume(), contacts,
    interface: interfaceData,
    model_roof_underside_z_mm: roofZ, model_round_lobe_bottom_z_mm: lobeBottomZ,
    first_model_roof_path_expected_z_mm: roofZ + processAssumption.layer_height_mm,
    first_lobe_path_expected_z_mm: lobeBottomZ + processAssumption.layer_height_mm,
    support_column_diameter_mm: tubeRadius * 2, tip_length_mm: tipLength,
    tip_max_outward_angle_deg: 0,
    support_part_is_connected_to_bed: true,
    base_bounds_xy_mm: [[-8, -6], [12, 10]], base_thickness_mm: baseTop,
    label: { text: condition.id, stroke_width_mm: 0.50, height_above_base_mm: 0.36 },
    digital_checks: { manifold: 'pass', one_connected_model: 'pass', one_connected_support_with_attached_label: 'pass', no_volumetric_model_collision: 'pass', identical_model_bytes: 'pass', final_slicer_paths: 'pending', physical_print: 'not performed' },
  });
  console.log(`${condition.id}: ${condition.style}, gap ${condition.gap_mm}, cap ${condition.tip_diameter_mm}; ${supportFile.triangles} support triangles`);
}

const nativeBase = await save(supportBase('NAT'), 'native-control-base.stl', 'Optional attached NAT label base, no generated supports');
const manifest = {
  schema_version: 1, title: 'Controlled miniature-support contact coupons',
  generated_on: '2026-10-16', generator: 'scripts/research-coupons.mjs',
  process_assumption: processAssumption,
  purpose: 'Screen gap and crown diameter; compare sparse points with a local solid interface using identical test model geometry. Curved island is a separate feature on each coupon.',
  source_license: 'Original synthetic geometry generated for this project; GPL-3.0-or-later with repository source.',
  status: 'Geometry checked. Requires final slicing/path inspection and physical printing; no physical success is claimed.',
  coordinate_system: 'Millimeters, Z up. All files for one assembly share the exact coordinate frame. Keep model/support positions together; never drop a raised component independently to bed.',
  import_instructions: 'Import each *-assembly.stl for a simple single-object experimental coupon, with native support generation disabled. Alternatively import its *-model.stl and *-supports.stl together as one multipart object. For native controls import coupon-original.stl with native supports enabled. The optional native-control-base.stl is supplied for label consistency, but must be positioned and evaluated as ordinary geometry, not silently treated as native support.',
  interpretation: [
    'A=0.26 mm crown; B=0.36 mm crown; P0/P1/P2 use 0/0.06/0.12 mm gap; I1/I2 use the .36 mm lobe crowns plus local interface roof at .06/.12 mm gap.',
    'Zero gap is a deliberate touching-contact control, potentially difficult to separate, not an endorsed production setting.',
    'Use P1B vs I1 and P2B vs I2 for roof comparisons. Do not compare different gaps and call the result an interface-only effect.',
    'The micro-interface pedestal is intentionally robust and materially expensive. This isolates underside support behavior; it is not a claimed efficient support innovation.',
    'These short coupons do not test tall-tree lateral stability. Longer branches require a separate real-mini or tower test.',
    'Flat-roof gap is exact geometric separation. Ring crowns under the curved lobe use a conservative lower-envelope clearance; their center gap is larger and recorded individually.',
    'Reported expected path heights assume the slicer uses .10 first and .06 regular layers without adaptive layers. Confirm from G-code; geometric validity alone does not prove extrusion survival.',
    'Never discard a genuine floating extrusion solely because custom support meshes are present.'
  ],
  original_model: original, optional_native_control_base: nativeBase, variants,
};
await writeFile(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Wrote ${variants.length} conditions and identical unsupported control to ${output}`);
