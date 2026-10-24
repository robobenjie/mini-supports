import { indexSTL, simplifyMesh, simplifierReady, type IndexedMesh } from './simplify.ts';
import type { AsyncSimplifier } from './model-import.ts';

export const IMPORT_CONCURRENCY = 8;
type PoolWorker = Pick<Worker, 'postMessage' | 'terminate' | 'onmessage' | 'onerror' | 'onmessageerror'>;
interface Job {
  mesh: IndexedMesh | Float32Array;
  unit: number;
  resolve: (mesh: IndexedMesh) => void;
  reject: (error: Error) => void;
}

/** One job per mesh, shared across all files in an import. Buffers change owners. */
export class SimplifyPool {
  private workers = new Map<PoolWorker, Job | undefined>();
  private queue: Job[] = [];
  private closed?: Error;
  private createWorker: () => PoolWorker;
  constructor(createWorker: () => PoolWorker = () => new Worker(new URL('./simplify.worker.ts', import.meta.url), {type: 'module'})) { this.createWorker = createWorker; }

  simplify: AsyncSimplifier = async (mesh, unit = 1) => {
    if (this.closed) throw this.closed;
    // Tiny meshes cost less than a worker startup and do not need reduction.
    if ((mesh instanceof Float32Array ? mesh.length / 3 : mesh.indices.length) <= 12000) {
      await simplifierReady;
      if (this.closed) throw this.closed;
      return simplifyMesh(mesh instanceof Float32Array ? indexSTL(mesh) : mesh, unit);
    }
    return new Promise<IndexedMesh>((resolve, reject) => {
      this.queue.push({mesh, unit, resolve, reject});
      this.dispatch();
    });
  };

  private dispatch() {
    try {
      while (this.queue.length && !this.closed) {
        let worker = [...this.workers].find(([,job]) => !job)?.[0];
        if (!worker) {
          if (this.workers.size >= IMPORT_CONCURRENCY) return;
          worker = this.createWorker();
          const current = worker;
          worker.onmessage = event => {
            const job = this.workers.get(current);
            if (!job) return;
            if (event.data.error) { this.dispose(new Error(event.data.error)); return; }
            this.workers.set(current, undefined);
            job.resolve(event.data.mesh);
            this.dispatch();
          };
          worker.onerror = event => this.dispose(new Error(event.message || 'Mesh simplification failed.'));
          worker.onmessageerror = () => this.dispose(new Error('Could not read the simplified mesh.'));
          this.workers.set(worker, undefined);
        }
        const job = this.queue.shift()!;
        this.workers.set(worker, job);
        const buffers = job.mesh instanceof Float32Array ? [job.mesh.buffer] : [job.mesh.vertices.buffer, job.mesh.indices.buffer];
        worker.postMessage({mesh: job.mesh, unit: job.unit}, [...new Set(buffers)]);
      }
    } catch (error) { this.dispose(error instanceof Error ? error : new Error(String(error))); }
  }

  dispose(error = new Error('Import stopped.')) {
    this.closed = error;
    for (const [worker, job] of this.workers) { worker.terminate(); job?.reject(error); }
    this.workers.clear();
    for (const job of this.queue.splice(0)) job.reject(error);
  }
}

/** Limit concurrent file preparation and keep the user's file order. */
export async function mapImportFiles<T, R>(inputs: T[], prepare: (input: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(inputs.length);
  let next = 0, failed = false;
  await Promise.all(Array.from({length: Math.min(IMPORT_CONCURRENCY, inputs.length)}, async () => {
    while (!failed && next < inputs.length) {
      const index = next++;
      try { results[index] = await prepare(inputs[index], index); }
      catch (error) { failed = true; throw error; }
    }
  }));
  return results;
}
