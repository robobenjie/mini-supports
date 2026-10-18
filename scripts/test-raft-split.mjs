/** Raft-split regressions in the browser's actual Python/Manifold WASM runtime.
 * Also exports synthetic split/intact inspection fixtures; no private model input.
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
for (const file of ['params', 'analysis', 'contacts', 'tree', 'build', 'verify', 'placement', 'pipeline', 'types', 'raft_split']) {
  py.FS.writeFile(`/engine/arbor/engine/${file}.py`, await readFile(`vendor/arborfdm/arbor/engine/${file}.py`));
}
py.FS.writeFile('/engine/test_raft_split.py', await readFile('vendor/arborfdm/tests/test_raft_split.py'));
try {
  await py.runPythonAsync(`
import sys
sys.path.insert(0, '/engine')
import wasm_compat
import test_raft_split as tests
for name in sorted(dir(tests)):
    if name.startswith('test_'):
        getattr(tests, name)()
        print('PASS ' + name)
tests.export_inspection_fixtures('/fixtures')
`);
  const output = path.resolve('test-results/raft-split');
  await mkdir(output, {recursive: true});
  for (const file of py.FS.readdir('/fixtures').filter(name => !name.startsWith('.'))) {
    await writeFile(path.join(output, file), py.FS.readFile(`/fixtures/${file}`));
  }
  console.log(`Synthetic inspection fixtures: ${output}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
