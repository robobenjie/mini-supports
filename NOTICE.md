# Attribution and corresponding source

Mini Supports is a browser adaptation of **ArborFDM** by moshinette and contributors:
https://github.com/moshinette/arborfdm

The upstream code in `vendor/arborfdm` is pinned at commit
`20b1e83d541a52f335a07af88f6f8381b02fb5c0` (retrieved October 16, 2026).
It remains unmodified. Its original README and third-party notices are included.
The upstream engine, profiles, loader, and exporter are used under GPL-3.0-or-later.
The browser application and Python/JavaScript binding adapter added October 16,
2026 are also GPL-3.0-or-later. See LICENSE.

This is an independent adaptation, not an official ArborFDM release. The browser
work adds a TypeScript interface, a Web Worker, a Manifold WASM binding adapter, 32-bit NumPy compatibility,
resource limits, local runtime packaging, and tests. No support heuristics were
replaced. Python scientific package versions differ from the upstream desktop
build; numerical output can differ and is not claimed bit-identical.

Every production build includes `mini-supports-source.zip`, linked from the UI,
with corresponding application and vendored engine source, dependency lockfile,
and build scripts. Runtime dependencies retain their own licenses in their
packages/wheels. Pyodide (MPL-2.0), Manifold (Apache-2.0), Three.js (MIT), lucide
(ISC), fflate (MIT), and DM Sans / Manrope fonts (SIL OFL-1.1) are independent upstream projects. The Pyodide runtime
package lock records the scientific package versions, hashes, and source URLs.
Example STL meshes are generated fixtures from ArborFDM, supplied under its GPL.
