import { MeshoptSimplifier } from 'meshoptimizer';
export const ANALYSIS_ERROR_MM = 0.02;
export const simplifierReady = MeshoptSimplifier.ready;
export interface IndexedMesh { vertices: Float32Array; indices: Uint32Array }
export function simplifyMesh(mesh: IndexedMesh, unit = 1): IndexedMesh {
  if (mesh.indices.length <= 12000) return mesh;
  // Keep the extrema so the preview and the original have the same bed placement.
  const locked = new Uint8Array(mesh.vertices.length / 3);
  for (let axis = 0; axis < 3; axis++) {
    let lo = axis, hi = axis;
    for (let i = axis; i < mesh.vertices.length; i += 3) { if (mesh.vertices[i] < mesh.vertices[lo]) lo = i; if (mesh.vertices[i] > mesh.vertices[hi]) hi = i; }
    locked[Math.floor(lo / 3)] = locked[Math.floor(hi / 3)] = 1;
  }
  const [indices] = MeshoptSimplifier.simplifyWithAttributes(mesh.indices, mesh.vertices, 3, new Float32Array(0), 0, [], locked, 12000, ANALYSIS_ERROR_MM / unit, ['ErrorAbsolute', 'LockBorder']);
  const [remap, count] = MeshoptSimplifier.compactMesh(indices);
  const vertices = new Float32Array(count * 3);
  for (let i = 0; i < remap.length; i++) if (remap[i] !== 0xffffffff) vertices.set(mesh.vertices.subarray(i * 3, i * 3 + 3), remap[i] * 3);
  return { vertices, indices };
}
