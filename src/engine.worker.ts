/// <reference lib="webworker" />
import Module from 'manifold-3d';
import type { PyodideInterface } from 'pyodide';
import type { WorkerRequest, WorkerReply } from './types';
import { createSupportSamplerBridge } from './support-sampler';
const scope = self as DedicatedWorkerGlobalScope;
const send = (data: WorkerReply) => scope.postMessage(data);
const progress = (fraction: number, message: string) => send({type:'progress', fraction, message});
let runtime: Promise<PyodideInterface> | undefined;
async function boot() {
  progress(0, 'Loading local WebAssembly engine…');
  const base = new URL('/runtime/', scope.location.origin).href;
  const [{ loadPyodide }, manifold] = await Promise.all([
    import(/* @vite-ignore */ `${base}pyodide.mjs`),
    Module({ locateFile: () => `${base}manifold.wasm` }),
  ]);
  manifold.setup();
  const py: PyodideInterface = await loadPyodide({indexURL:base});
  py.registerJsModule('manifold_js', {api:manifold});
  py.registerJsModule('support_sampler_js', createSupportSamplerBridge());
  py.registerJsModule('browser_bridge', {progress});
  progress(0, 'Loading geometry packages (first run takes a moment)…');
  await py.loadPackage(['numpy','scipy','shapely']);
  const fetchBytes = async (name: string) => {
    const res = await fetch(base + name);
    if (!res.ok) throw new Error(`Could not load ${name}. Reload the app and try again.`);
    return res.arrayBuffer();
  };
  const [engine, trimesh, networkx] = await Promise.all([fetchBytes('arbor-engine.zip'), fetchBytes('trimesh-5.1.1-py3-none-any.whl'), fetchBytes('networkx-3.4.2-py3-none-any.whl')]);
  py.unpackArchive(networkx, 'zip', {extractDir:'/engine'});
  py.unpackArchive(engine, 'zip', {extractDir:'/engine'});
  py.unpackArchive(trimesh, 'zip', {extractDir:'/engine'});
  await py.runPythonAsync("import sys\nsys.path.insert(0, '/engine')\nimport browser_engine");
  return py;
}
let busy = false;
scope.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  if (busy) return;
  busy = true;
  try {
    runtime ??= boot();
    const py = await runtime;
    const request = event.data;
    const read = (p: string) => py.FS.analyzePath(p).exists ? py.FS.readFile(p).slice() : undefined;
    const cleanup: string[] = [];
    try {
      if (request.type === 'generate') {
        cleanup.push('/input.vertices', '/input.indices', '/input.stl', '/output.3mf', '/supports.stl', '/raft.stl');
        const indexed=!(request.data instanceof ArrayBuffer);
        if(request.data instanceof ArrayBuffer)py.FS.writeFile('/input.stl', new Uint8Array(request.data));
        else {py.FS.writeFile('/input.vertices',new Uint8Array(request.data.vertices));py.FS.writeFile('/input.indices',new Uint8Array(request.data.indices));}
        py.globals.set('browser_settings', JSON.stringify({...request.settings, preserve_frame: true, indexed}));
        const summary = JSON.parse(await py.runPythonAsync('browser_engine.run(browser_settings)'));
        const output = read('/output.3mf')!, supports = read('/supports.stl'), raft = read('/raft.stl');
        scope.postMessage({type:'result', id:request.id, revision:request.revision, result:{summary, output, supports, raft}}, [output.buffer, ...(supports ? [supports.buffer] : []), ...(raft ? [raft.buffer] : [])]);
      } else {
        cleanup.push('/plate.3mf');
        request.parts.forEach((part, index) => {
          const path = `/plate-${index}.3mf`; cleanup.push(path); py.FS.writeFile(path, part.output);
        });
        py.globals.set('browser_manifest', JSON.stringify({name:request.name, parts:request.parts.map(part => ({lift:part.lift}))}));
        await py.runPythonAsync('browser_engine.combine(browser_manifest)');
        const output = read('/plate.3mf')!;
        scope.postMessage({type:'exported', output}, [output.buffer]);
      }
    } finally {
      for (const path of cleanup) if (py.FS.analyzePath(path).exists) py.FS.unlink(path);
    }
  } catch (error) {
    console.error(error);
    send({type:'error', message: error instanceof Error ? error.message : String(error)});
  } finally { busy = false; }
};
