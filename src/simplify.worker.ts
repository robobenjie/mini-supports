/// <reference lib="webworker" />
import { indexSTL, simplifyMesh, simplifierReady, type IndexedMesh } from './simplify.ts';

self.onmessage = async (event: MessageEvent<{mesh: IndexedMesh | Float32Array; unit: number}>) => {
  try {
    await simplifierReady;
    const input = event.data.mesh;
    const mesh = simplifyMesh(input instanceof Float32Array ? indexSTL(input) : input, event.data.unit);
    self.postMessage({mesh}, {transfer: [mesh.vertices.buffer, mesh.indices.buffer]});
  } catch (error) {
    self.postMessage({error: error instanceof Error ? error.message : String(error)});
  }
};
