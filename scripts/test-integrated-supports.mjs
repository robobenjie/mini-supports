/** Crown, split-group and FDM bracing regressions in the actual browser runtime.
 * Synthetic geometry only; no private model input.
 */
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {loadPyodide} from 'pyodide';
import Module from 'manifold-3d';

const manifold = await Module();
manifold.setup();
const py = await loadPyodide({indexURL: path.resolve('public/runtime') + '/'});
py.registerJsModule('manifold_js', {api: manifold});
py.registerJsModule('browser_bridge', {progress: () => {}});
await py.loadPackage(['numpy', 'scipy', 'shapely']);
for (const file of ['networkx-3.4.2-py3-none-any.whl', 'arbor-engine.zip', 'trimesh-5.1.1-py3-none-any.whl']) {
  py.unpackArchive(new Uint8Array(await readFile(`public/runtime/${file}`)), 'zip', {extractDir: '/engine'});
}
for (const file of ['params', 'analysis', 'contacts', 'tree', 'build', 'verify', 'placement', 'pipeline', 'types', 'raft_split', 'patches', 'patch_release', 'patch_first']) {
  py.FS.writeFile(`/engine/arbor/engine/${file}.py`, await readFile(`vendor/arborfdm/arbor/engine/${file}.py`));
}
py.FS.writeFile('/engine/manifold3d.py', await readFile('python/manifold3d.py'));
py.FS.writeFile('/engine/test_integrated_supports.py', await readFile('vendor/arborfdm/tests/test_integrated_supports.py'));
py.FS.writeFile('/engine/test_patch_first.py', await readFile('vendor/arborfdm/tests/test_patch_first.py'));
py.globals.set('test_prefixes_json', JSON.stringify(process.argv.slice(2)));
try {
  await py.runPythonAsync(`
import sys
import json
sys.path.insert(0, '/engine')
import wasm_compat
import test_integrated_supports as tests
import test_patch_first as patch_tests
prefixes = json.loads(test_prefixes_json)
for suite in (tests, patch_tests):
    for name in sorted(dir(suite)):
        if name.startswith('test_') and (not prefixes or any(name.startswith(prefix) for prefix in prefixes)):
            getattr(suite, name)()
            print('PASS ' + name)
`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
