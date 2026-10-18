# Mini Supports

A browser application for **STL / arranged 3MF → ArborFDM tree supports → multipart 3MF**.
Designed for static hosting on Vercel. Geometry generation runs entirely on the
user's device in Web Workers. There are no upload endpoints, server functions,
accounts, API keys, or model storage.

## Run

Requires Node.js 22.12+ (or Node 24+).

```sh
npm ci
npm run setup:runtime
npm run dev
```

Open the URL printed by Vite. The app starts with an empty plate. Drop binary/ASCII
STLs or a 3MF containing an arranged plate onto the preview, or use **Choose files**
/ **Add files** inside it. Choose a nozzle and density, optionally adjust position,
rotation, or scale, then use **Generate supports** and **Download 3MF** in the bar
above the preview. Import and generation progress appears below the preview.

3MF import preserves each printable mesh instance's orientation, scale, spacing,
and relative height, including nested assemblies and Production-extension model
files used by slicer projects. The whole arrangement is translated together to
center it and place its lowest point on the bed. It is never rearranged into
individual parts. Each build item becomes a selectable mini; its component meshes move together.
Supports are generated and cached independently for each mini. The **Parallel
parts** control selects how many dedicated engine workers can run at once. Auto
uses up to four workers, leaving one logical CPU available on smaller machines;
you can select any count up to the browser's reported logical CPU count. Workers
take the next pending mini as soon as they finish. Each worker has its own Python
and WASM memory, so higher counts use more memory and may not always be faster.
Lowering the count releases unused workers; changing it preserves all cached
supports. Only dirty minis enter the queue. Import, generation, and packing have
a visible progress bar with completed/running part counts, current stage,
elapsed time, and cancellation.

Large 3MFs use a lightweight analysis/preview mesh generated with meshoptimizer,
with a 0.02 mm error target in source units converted to millimeters. This is an
approximation for support planning, not a certified maximum surface deviation;
scaling a mini also scales the approximation. Vertex connectivity is retained
through the WASM handoff instead of being discarded through an STL conversion.
The downloaded 3MF keeps the original full-resolution vertices and triangles,
using component transforms for placement, rotation, and scale. Original resources
are copied byte-for-byte when their IDs are unique; colliding resource IDs are
renumbered without changing mesh data. Supports and raft geometry are new.
The UI identifies the analysis simplification explicitly.
Separate uploaded files (STL, 3MF, or a mixture) are packed into a compact cluster as units,
with 6 mm between their XY bounding boxes. 3MF arrangements stay intact.
Dropping or browsing for additional STLs finds nearby gaps on the current plate,
without changing existing transforms or cached supports. Import is staged so a
failed or cancelled addition leaves the plate intact. **Clear plate** starts over.
Opening a 3MF continues to load a new plate.
Each mini is exported as its own assembly containing model, support, and raft
parts, with the arrangement preserved.
STLs use millimeters; 3MF measurement units are converted to millimeters.

Select a mini by clicking it in the preview or using **Selected mini**. Drag the
XYZ handles using the **Move / Rotate** toggle; Move is selected initially.
Dragging a mini directly selects and edits it in one gesture: Move stays in the XY
plane, while Rotate turns freely relative to the camera and honors rotation snapping.
**Delete** / **Backspace**, or the sidebar Delete button, removes the selected mini
and its supports from the preview and export. Other minis keep their cached supports.
Movement carries the model, supports, and raft together, preserving cached
geometry. The download is repacked automatically when every mini has supports.
XYZ position fields use millimeters; XY is the model center and Z is its height
above the bed before raft clearance. Raising a supported assembly also raises
its raft. Choose Rotate for arbitrary rotation rings or exact XYZ degree values.
Angles are relative to the imported orientation. Optional **Snap 15°** constrains
ring drags. **Reset rotation** restores the imported orientation. Rotation keeps
the mini's XY position and places its lowest point back at its chosen bed height.
Scale also applies only to the selected mini. Moving never regenerates supports;
rotation and scaling regenerate them in the mini's new frame.

Rotating or scaling clears only that mini's support/raft cache. Other minis keep
their existing supports, placement, and generation results. **Generate supports**
regenerates only the missing results, then repackages the whole plate. Downloads
are disabled while any mini needs regeneration. Changing nozzle, density, gap,
overhang, or raft settings invalidates all minis. Cancelling retains any minis
that already completed; a subsequent run resumes the remaining work.

Each newly generated assembly is lifted by its own raft clearance so its raft
rests on the bed. Moving a completed assembly in Z moves its raft too. Trees do not join between minis. Leave space between minis
and inspect potential overlaps after rotation; inter-mini collision avoidance is
not part of the independent generation path.

**Split enclosing rafts** looks for a useful full-depth seam when support feet
surround a model. It subtracts a narrow strip from the existing broad pad, first
trying straight cuts and then a bounded search for bent cuts around obstacles.
It keeps the feet and model foundation intact, retains substantial
raft sections, and keeps braces within each section. The final support-and-raft
geometry is checked for connections across the split; a split that remains joined
is discarded and the original bracing is restored. The support summary explains
whether a split was applied or skipped. This is a removal heuristic, not an
extraction-path guarantee: branches may still need clipping. Disable the option
for an intact-raft comparison. The engine parameter is opt-in (`raft_split`);
the browser enables the automatic attempt while **Add a raft** is on.
The seam is at least 0.6 mm or two extrusion widths, whichever is larger.

This is a geometry import, not a slicer project round-trip. Printer/filament/process
settings, colors, painted supports, and modifier semantics are not retained.
Export a single plate's printable geometry from your slicer, without modifier
volumes. Build items marked non-printable are skipped and counted in the UI.

```sh
npm test                 # importer + real WASM engine + 3MF round-trip tests
npm run test:import      # placement, units, mirrors, instances, and invalid inputs
npm run test:plate       # original mesh bytes, compact packing, append/delete, source paths
npm run test:drag        # direct movement/rotation, support caching, snapping
npm run test:raft-split  # removal seams, anchoring, braces, and actual solid connectivity
npm run build            # runtime assets + typecheck + static build + source archive
npm run preview
```

The first setup needs internet access to download pinned scientific wheels.
Subsequent builds reuse `public/runtime`. The worker itself downloads all runtime
assets from the app's own origin. The first generation has a runtime download and
startup cost; later generations reuse the worker. Cancel terminates the worker,
so the next generation reinitializes it. Models are held only in memory.

## Vercel

Import this repository in Vercel, using the included `vercel.json`:

- Framework: Vite
- Install: `npm ci`
- Build: `npm run build`
- Output directory: `dist`
- No environment variables, database, backend, or paid compute required.

The build fetches the pinned Pyodide scientific packages and bundles them as
static assets. No cross-origin isolation headers are needed; computation is
single-threaded within each dedicated worker; parallelism is between independent minis. `npm run build` includes the
corresponding source archive linked in the app. Keep that archive and license
available when distributing the app. A Vercel deployment is not automatically
created by these local scripts.

## Architecture

- `src/main.ts`, `viewer.ts`, `style.css`: TypeScript UI, selection, Three.js
  TransformControls move/rotate gizmos, and incremental generation queue.
- `src/mini.ts`: per-mini transforms, revision checks, cached results, and previews.
- `src/model-import.ts`: typed-array mesh parser plus small XML skeletons; Core and
  Production-extension transforms, units, instance checks, and STL layout.
- `src/plate.worker.ts`, `plate.ts`: responsive off-thread import, original model
  retention, and multipart export with full-detail source references.
- `src/simplify.ts`: meshoptimizer analysis proxies; source geometry is retained.
- `src/zip-archive.ts`: lazy ZIP inflation and compressed-member reuse during export.
- `src/engine.worker.ts`: Pyodide and Manifold WASM lifecycle, local file transfer,
  generation progress, indexed per-mini jobs, and transferable result buffers.
- `python/manifold3d.py`: thin adapter from the upstream Python binding API to
  official `manifold-3d` WASM (3.5.4). Includes explicit native object disposal.
- `python/wasm_compat.py`: range-checked 32-bit NumPy index adaptation.
- `python/browser_engine.py`: input limits, profile selection, upstream generation,
  upstream 3MF export and read-back validation, preview meshes, check reports,
  and packaging of cached mini assemblies without regenerating their meshes.
- `vendor/arborfdm/`: upstream Python source, profiles, and tests, with the local
  experimental support changes documented in [research/README.md](research/README.md).
- `scripts/setup-runtime.mjs`: pinned runtime downloads and engine archive.
- `scripts/test-engine.mjs`: executes the actual WASM path under Node, exercises
  transforms/booleans/slicing, generates supports, and validates 3MF parts.

The original five-stage pipeline is retained: layer/face analysis → contact
placement → collision-aware tree routing → manifold union → verification.
Python's NumPy/SciPy/Shapely run in Pyodide; the official Manifold WASM library
handles solid geometry through the binding adapter. This avoids a partial
TypeScript reimplementation of the original engine.

## Current boundaries

- Desktop browsers with WebGL and WebAssembly are the primary target. Mobile
  layout is responsive but large meshes may exceed mobile memory.
- No caps on upload file size, triangle count, or expanded 3MF model XML. Each
  mini can be up to 250 mm after scaling. Analysis simplification is shown in the UI;
  original 3MF model meshes are not decimated in the download.
  Available browser memory and processing time determine practical capacity.
- STL and Core / Production mesh 3MF inputs. Other required extensions are
  rejected explicitly. Sliced toolpath-only 3MFs and multiple-plate selection are
  not supported.
- No manual contacts, orientation search, mesh repair, project saving,
  hollow supports UI, or printer-specific slicing/G-code generation.
- Preview triangle coordinates are float32. Original winding is preserved.
- Profiles and geometric verification come from upstream; this browser adaptation
  has not been physically print-tested. Review warnings and slicer layers.
  Reported geometry issues stay visible without blocking the completed 3MF download.
- 3MF uses Core components with direct Production-extension mesh references and
  globally unique IDs for Bambu Studio compatibility. Nested source assemblies
  are flattened into transforms, retaining their full geometry and placement.
  Studio's “not from Bambu Lab, load geometry data only” notice is expected: this
  portable 3MF contains no Bambu printer presets. Accept it to import the plate.
  Disable slicer automatic supports and match the nozzle to
  the selected profile. Printer/material/process profiles are not embedded.
- Full parity across all desktop features and all real-world model files is not claimed.

## Verification (October 16, 2026)

- Production build and TypeScript checks pass; npm audit reports no known vulnerabilities.
- The actual WASM engine passes affine transform, solid boolean, slicing, invalid
  topology, wasm32 index, and 3MF round-trip checks.
- Fixtures: shelf (78 contacts / 5 trees), cube (0 / 0), suspended arm (19 / 2),
  and an open mesh exercising fallback slicing and visible diagnostic reporting.
- In the browser: imported two STL files, generated 0.4 mm supports with the raft
  disabled (51 contacts / 5 trees), and cancelled a generation successfully.
- The 62,016-triangle sample miniature produced 114 contacts / 21 trees with the
  0.2 mm Balanced profile, in about four seconds after engine startup on the test
  machine. Its downloaded 3MF was inspected independently: model, supports, raft,
  one components assembly, and one build item. No browser console errors were
  observed during the successful production generation.
- 3MF import tests cover nested transforms, separate mesh files, prefixed XML,
  rotations, mirrored winding, repeated instances, all Core units, mixed STL/3MF
  uploads, non-printable items, missing references, cycles, and corrupt archives.
- A two-model arranged 3MF with one model rotated 90° produced supports on both
  models (159 contacts / 11 trees with the test profile). An independent upstream
  reader confirmed the exported model vertices preserve their relative placement.
  The browser upload → generation → download path also passed, including a
  malformed-file error that leaves the previous valid plate and output intact.
- Incremental generation tests rotate one of two minis through arbitrary XYZ
  angles, confirm the other mini's support/raft/model meshes are unchanged,
  reject stale worker results, regenerate only the edited mini, and validate
  the combined 3MF with both rafts on the same bed.
- Browser verification covers click selection, dragging a rotation ring, exact
  XYZ angles (-20.5°, 12.4°, 27.3°), switching minis, selective invalidation,
  cancellation, and regeneration. Comparing actual downloaded 3MFs confirms
  that the untouched mini's model, supports, and raft meshes are identical.
- Bambu Studio 02.04.00.70 opened the corrected full-detail 53-part plate with all
  53 objects selected and models, supports, and rafts visible. The previous export
  used nested cross-file references and reused mesh IDs, which Studio did not
  interpret correctly. Regression checks now enforce direct mesh references,
  globally unique IDs, relationships, and the conventional root model path.
- No physical print or deployed Vercel URL was tested.

## Large-plate performance (October 16, 2026)

Tested the user's 346 MB `printready_arms_not_oriented_well.3mf` locally: 53
printable instances, 19,950,960 original triangles, and 648,260 analysis triangles.
The two-worker baseline took **30.8 seconds to import + 78.6 seconds to generate
and package** (109.4 seconds total), using 0.2 mm / Balanced / raft enabled.
This includes fresh worker startup. These are measurements on this test machine,
not a performance guarantee for other devices or files.

With the new Auto setting (four workers on this machine, which reports 14 logical
CPUs), generation and packaging took **34.4 seconds**, about **2.3× faster** than
the two-worker baseline. Changing the worker setting kept all 53 cached results.
Editing and resetting the last mini then regenerating took **1.2 seconds**,
including repacking the original detail. The other 52 support resources remained
byte-for-byte identical in the actual downloaded archive. The queue used only one
worker for that one dirty mini, even with a higher parallel count selected.
Full-plate generation still reported 52 errors and 227 warnings.

The 371 MB downloaded archive passes ZIP CRC validation, contains 53 assemblies,
and retains all 45 referenced original mesh resources byte-for-byte. Independent
export tests check arbitrary rotation/scale, mirrored placements, mixed units,
colliding input paths, and preserved geometry. Editing one part retains the other
52 cached results.

The orientation still produces **52 unrouted-contact errors**, along with mesh,
removal, and other warnings. They remain visible alongside the download.
The speed target is met; these poses are not certified
print-ready. Checks operate on the analysis proxy, and no physical print was made.

## Reproducing a large-plate benchmark

Pass a local file path; proprietary models stay out of the repository and source
archive. Benchmark outputs are written only to ignored `test-results/plate/`.

```sh
node --experimental-strip-types scripts/benchmark-plate.mjs /path/to/plate.3mf
node scripts/benchmark-supports.mjs 53
```

The support benchmark is serial to expose per-part stage timings. The app uses
the selected parallel worker count. Browser timings include runtime startup and final packaging;
benchmark imports include local fixture preparation.

## License

GPL-3.0-or-later. Based on [ArborFDM](https://github.com/moshinette/arborfdm).
See `NOTICE.md`, `LICENSE`, and the retained upstream notices. Source is served at
`/mini-supports-source.zip` in production builds.
