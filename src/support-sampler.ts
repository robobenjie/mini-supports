// GPL-3.0-or-later. Batched equivalent of ArborFDM's upward VerticalCaster.
// A uniform XY grid avoids expanding all candidate pairs into NumPy arrays.
type Triangle = {
  a: number[]; e1: number[]; e2: number[]; det: number;
  n: number[]; d: number; face: number; priority: number;
};
export type SupportSampleIndex = {
  cell: number; low: number[]; nx: number; ny: number;
  grid: number[][]; large: number[]; triangles: Triangle[];
};
export function createIndex(
  vertices: Float64Array, faces: Uint32Array, normals: Float64Array,
  facePriority?: Int32Array,
): SupportSampleIndex {
  if (vertices.length % 3 || faces.length % 3 || normals.length !== faces.length
      || (facePriority && facePriority.length !== faces.length / 3))
    throw new Error('Invalid sampling mesh buffers');
  const low = [Infinity, Infinity], high = [-Infinity, -Infinity];
  for (let p = 0; p < vertices.length; p += 3) {
    if (!Number.isFinite(vertices[p + 2])) throw new Error('Non-finite sampling mesh');
    for (let a = 0; a < 2; a++) {
      if (!Number.isFinite(vertices[p + a])) throw new Error('Non-finite sampling mesh');
      low[a] = Math.min(low[a], vertices[p + a]); high[a] = Math.max(high[a], vertices[p + a]);
    }
  }
  if (!vertices.length) return {cell: 1, low: [0, 0], nx: 1, ny: 1, grid: [[]], large: [], triangles: []};
  const span = [high[0] - low[0], high[1] - low[1]];
  const pad = 2e-7 * Math.max(...span) + 1e-9;
  for (let a = 0; a < 2; a++) { low[a] -= pad; high[a] += pad; }
  // Coarser SEARCH cells on a huge model keep indexing memory bounded. This
  // does not change sampled locations, triangle precision or accepted inputs.
  const cell = Math.max(1, Math.sqrt(span[0] * span[1] / 100000), span[0] / 100000, span[1] / 100000);
  const nx = Math.ceil((high[0] - low[0]) / cell) + 1, ny = Math.ceil((high[1] - low[1]) / cell) + 1;
  const grid: number[][] = Array.from({length: nx * ny}, () => []), triangles: Triangle[] = [], large: number[] = [];
  for (let fi = 0; fi < faces.length; fi += 3) {
    if (![normals[fi], normals[fi + 1], normals[fi + 2]].every(Number.isFinite))
      throw new Error('Non-finite sampling normal');
    if (normals[fi + 2] >= -1e-9) continue;
    const ai = faces[fi] * 3, bi = faces[fi + 1] * 3, ci = faces[fi + 2] * 3;
    if (Math.max(ai, bi, ci) + 2 >= vertices.length) throw new Error('Invalid sampling face');
    const a = Array.from(vertices.subarray(ai, ai + 3));
    const b = Array.from(vertices.subarray(bi, bi + 3));
    const c = Array.from(vertices.subarray(ci, ci + 3));
    const e1 = b.map((v, i) => v - a[i]), e2 = c.map((v, i) => v - a[i]);
    const det = e1[0] * e2[1] - e1[1] * e2[0];
    if (Math.abs(det) <= 1e-14) continue;
    // Keep the reference normal and plane arithmetic for shared-edge labels.
    const n = Array.from(normals.subarray(fi, fi + 3));
    const d = n[0] * a[0] + n[1] * a[1] + n[2] * a[2];
    const ti = triangles.length;
    triangles.push({a, e1, e2, det, n, d, face: fi / 3, priority: facePriority?.[fi / 3] ?? fi / 3});
    const xmin = Math.max(0, Math.floor((Math.min(a[0], b[0], c[0]) - pad - low[0]) / cell));
    const xmax = Math.min(nx - 1, Math.floor((Math.max(a[0], b[0], c[0]) + pad - low[0]) / cell));
    const ymin = Math.max(0, Math.floor((Math.min(a[1], b[1], c[1]) - pad - low[1]) / cell));
    const ymax = Math.min(ny - 1, Math.floor((Math.max(a[1], b[1], c[1]) + pad - low[1]) / cell));
    // Long CAD triangles stay in one list instead of being copied into
    // thousands of cells. Rays still test them at full precision.
    if ((xmax - xmin + 1) * (ymax - ymin + 1) > 256) { large.push(ti); continue; }
    for (let y = ymin; y <= ymax; y++) for (let x = xmin; x <= xmax; x++) grid[y * nx + x].push(ti);
  }
  return {cell, low, nx, ny, grid, large, triangles};
}

export function cast(index: SupportSampleIndex, points: Float64Array, tolerance = 1e-6) {
  if (points.length % 3 || !Number.isFinite(tolerance)) throw new Error('Invalid sampling rays');
  const count = points.length / 3, z = new Float64Array(count), ids = new Int32Array(count);
  for (let i = 0; i < count; i++) {
    const px = points[i * 3], py = points[i * 3 + 1], pz = points[i * 3 + 2];
    if (![px, py, pz].every(Number.isFinite)) throw new Error('Non-finite sampling ray');
    const x = Math.floor((px - index.low[0]) / index.cell), y = Math.floor((py - index.low[1]) / index.cell);
    let best = Infinity, id = -1, bestPriority = Infinity;
    const consider = (candidates: number[]) => {
      for (const ti of candidates) {
        const t = index.triangles[ti], dx = px - t.a[0], dy = py - t.a[1];
        const u = (dx * t.e2[1] - dy * t.e2[0]) / t.det, v = (t.e1[0] * dy - t.e1[1] * dx) / t.det;
        if (u < -1e-7 || v < -1e-7 || u + v > 1 + 1e-7) continue;
        const height = (t.d - t.n[0] * px - t.n[1] * py) / t.n[2];
        if (height >= pz - tolerance && (height < best || (height === best && t.priority < bestPriority))) {
          best = height; id = t.face; bestPriority = t.priority;
        }
      }
    };
    if (x >= 0 && y >= 0 && x < index.nx && y < index.ny) consider(index.grid[y * index.nx + x]);
    consider(index.large);
    z[i] = id >= 0 ? best : NaN; ids[i] = id;
  }
  return {z, ids};
}

export function createSupportSamplerBridge() {
  const indices = new Map<number, SupportSampleIndex>();
  let nextId = 1;
  return {
    create(vertices: Float64Array, faces: Uint32Array, normals: Float64Array, priority?: Int32Array) {
      const index = createIndex(vertices, faces, normals, priority), id = nextId++;
      indices.set(id, index); return id;
    },
    query(id: number, points: Float64Array, tolerance: number) {
      const index = indices.get(id);
      if (!index) throw new Error('Sampling mesh has been released');
      return cast(index, points, tolerance);
    },
    destroy(id: number) { indices.delete(id); },
  };
}
