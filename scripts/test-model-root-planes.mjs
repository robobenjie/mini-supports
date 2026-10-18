/** Run focused build regressions in the same WASM runtime as the browser. */
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {loadPyodide} from 'pyodide';
import Module from 'manifold-3d';
const manifold=await Module();manifold.setup();
const py=await loadPyodide({indexURL:path.resolve('public/runtime')+'/'});
py.registerJsModule('manifold_js',{api:manifold});await py.loadPackage(['numpy','scipy','shapely']);
for(const f of ['networkx-3.4.2-py3-none-any.whl','arbor-engine.zip','trimesh-5.1.1-py3-none-any.whl'])py.unpackArchive(new Uint8Array(await readFile('public/runtime/'+f)),'zip',{extractDir:'/engine'});
for(const f of ['params','analysis','contacts','tree','build','verify','placement','pipeline','types'])py.FS.writeFile('/engine/arbor/engine/'+f+'.py',await readFile('vendor/arborfdm/arbor/engine/'+f+'.py'));
py.FS.writeFile('/engine/test_model_root_planes.py',await readFile('vendor/arborfdm/tests/test_model_root_planes.py'));
await py.runPythonAsync(`
import sys
sys.path.insert(0,'/engine')
import wasm_compat
import test_model_root_planes as tests
for name in sorted(dir(tests)):
    if name.startswith('test_'):
        getattr(tests,name)()
        print('PASS '+name)
`);
