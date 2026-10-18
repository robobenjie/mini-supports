# FDM miniature support research

For the Bambu A1 with a 0.2 mm nozzle, the strongest candidate is a hybrid: small printable contacts for isolated details, stable branches, and local interfaces beneath broad undersides. This is a design hypothesis to test against native slicer supports; the reviewed evidence does not establish one best resin-style preset for arbitrary miniatures. Prusa's organic-support guidance explicitly favors interfaces when an underside needs dense support. [Prusa organic supports](https://help.prusa3d.com/article/organic-supports_480131)

The working app is preserved in commit `511f12f`. Research is on `codex/fdm-support-experiments`. The user subsequently authorized experimental generation and slicing. The deployed app remains unchanged; the experiments are offline scripts, with private geometry under ignored `test-results/research/`.

The printer and nozzle are user-confirmed. The prepared process uses 0.06 mm High Quality, Bambu PLA Matte and Textured PEI; the actual filament and plate remain assumptions. The saved Blitzboys plate contains different filament and support settings, so it supplies geometry rather than silently supplying the experimental process.

**The first priority is contact calibration in the actual slicer.** Exported trees are ordinary model geometry. Bambu's native support gap and interface controls do not automatically change them. A tiny mesh crown can disappear, widen, or merge when sliced. Inspect the emitted extrusion before judging a setting by its 3D preview. [Orca wall generator](https://github.com/OrcaSlicer/OrcaSlicer/wiki/quality_settings_wall_generator), [Orca support settings](https://github.com/OrcaSlicer/OrcaSlicer/wiki/support_settings_advanced)

The code audit found concrete reasons to begin there:

- On a flat underside, the current 0.03 mm gap cancels the profile's 0.03 mm penetration, giving zero nominal separation at the tip center. The rim of an inclined tip needs a separate clearance check.
- The 0.2 mm nozzle profile analyzes 0.08 mm layers. Matching the selected 0.06 mm process also requires accounting for the actual first layer and contact position within the layer grid.
- Short-support routing counts the gap twice in one height test. A diagnostic reproduces rejection of a space that can geometrically contain one idealized support layer.
- Coverage and collision checks have reproduced blind spots. One nearby contact can satisfy a large region, and a global overlap allowance can hide an intrusion away from the tips.
- Simplified analysis geometry and restored original export geometry are not independently checked against each other near each contact.

These findings are detailed in [engine-audit.json](engine-audit.json). The upstream engine already contains deliberate FDM work: growing-island anchors, spaced crowns, single-row blade contacts, bracing, and support self-checks. Improving those mechanisms and their validation is better grounded than assuming the author lacked FDM knowledge.

**The design principles translate into measurable tests.**

| Principle | Test and evidence to collect |
|---|---|
| Contacts must survive slicing | Crown diameter ladder; inspect the last two support layers for emitted paths, then count failed tips and removal damage. |
| Clearance must describe actual geometry | Gap ladder with zero penetration; measure last support and first model extrusion, including sloped contacts and different layer phases. |
| Islands, overhangs, and bridges differ | Compare a growing hanging island, a one-ended blade, and a bridge anchored at both ends. Record the first unsupported path. |
| Broad undersides may need a roof | Compare sparse points, denser points, and native interface supports under a cape or shield; photograph sag and scars. |
| Trees must remain stable during printing | Compare tall thin groups, wider footprints, and bracing while keeping contact geometry fixed. Record detachments and broken branches. |
| Removal is part of successful support | Use the spanner, wheel, and bent arm; time cleanup and count broken features, inaccessible branches, and cuts. |
| Orientation has several costs | Compare a fixed source pose and documented modest tilts; measure visible scars, weapon survival, support height, and time. |
| Fast analysis must preserve critical detail | Compare proxy tolerances and inspect contact clearance against original triangles near tips, blades, and small islands. |

The stability and bridge distinctions are supported by scaffold research; transferring its particular construction to these miniatures remains experimental. Orientation, cooling, and fragile-feature concerns also appear in Prusa's small-nozzle miniature examples. [Dumas, Hergel and Lefebvre](https://www.jdumas.org/publication/2014/scaffoldings/), [Prusa miniature printing guide](https://blog.prusa3d.com/printing-great-looking-miniatures-with-a-0-25mm-nozzle-on-the-original-prusa-mini_33457/)

**The proposed print sequence starts small.**

1. Preserve the exact current app as one control. Add a separate control changing only analysis layer height to 0.06 mm. Keep raft/lift settings explicit and inspect the final layer grid.
2. Screen flat and curved coupons with zero penetration, gaps of 0, 0.06, and 0.12 mm, and crown diameters of 0.26 and 0.36 mm. These are exploratory values, not recommended production settings. Use 0.46 mm only if the smaller crowns fail to produce useful paths. Do not combine new routing, density, and orientation changes in this first test.
3. Compare the best two viable variants with Bambu's native tree support on the same original parts and orientations. Include a native normal/snug interface reference for a broad underside. Enable native supports only on the original-model controls.
4. Repeat finalists on different plate positions and a second print run. Keep filament, cooling, motion, wall generation, layer schedule, and removal procedure fixed. Record intact parts first, then underside finish, visible scars, cleanup seconds, material, and time.
5. Confirm on the complete Spore miniature and then the large Blitzboys plate. Successful export or slicing qualifies a candidate for a print test; it does not establish physical success.

**The local collection provides a useful progression.**

| Specimen | Role | Original triangles | Analysis proxy triangles |
|---|---|---:|---:|
| Bare arm | Small contact and curved underside screening | 199,996 | 4,000 |
| Spanner hand | Thin tool survival and removal damage | 226,596 | 8,744 |
| Spore miniature | Complete organic miniature on a 32 mm base | 300,056 | 38,890 |
| Steering wheel | Spokes, enclosed routes, and fragile cleanup | 454,962 | 14,014 |
| Grot biker | Later complexity and cavity challenge | 2,662,140 | 49,840 |

Spore's source file is sideways: rotate X by −90 degrees, then place its planar base on the bed. The proxies above were generated for this inventory; current standalone STL import does not apply the same simplification as 3MF import. All source models remain unchanged, and private meshes and collection paths stay under ignored `test-results/research/` outputs.

The historical 53-part Blitzboys benchmark demonstrates processing completion, not print readiness: its saved results contain error-severity issues on 19 parts. It must be rerun with recorded provenance and reviewed before selecting a print plate.

**Six improvements deserve investigation after calibration:** contacts aligned to the actual layer grid; small removable interfaces under broad areas; branch strength adapted to height and growing islands; contacts aligned to the first extrusion paths; routing that accounts for removal access and fragile surfaces; and local refinement against the original mesh after coarse analysis. Some extend existing features. Each needs a comparison that can show when it fails, and none is established as a winning setting yet.

The complete source ledger, 12 principles, 11 test cases, six hypotheses, and baseline definitions are in [support-principles.json](support-principles.json). Seven adversarial diagnostics are recorded in [principle-diagnostics.json](principle-diagnostics.json): one existing invariant passed, and six limitations were documented. Run `node scripts/test-support-principles.mjs` to reproduce them after the local runtime has been prepared; `--strict` exits nonzero while limitations remain. These diagnostics are targeted geometric checks, not seven end-to-end print tests.

## Resin2FDM and the attainable hybrid

Resin2FDM is particularly useful when a resin presupport already has a good orientation and contact plan: preserve those choices while reinforcing the structure for FDM. Its guidance distinguishes tip diameter from support diameter and recommends strengthening columns, adding bracing, and testing small sections. That is different from discovering a good contact plan for an arbitrary unsupported STL. A sculptor's contact choices can save work, but FDM still needs a printable first extrusion, enough support under broad undersides, and accessible removal routes. [Resin2FDM FAQ](https://www.clonecore.net/docs/r2fdm/faq-glossary)

The proposed best attainable system chooses support treatment by feature, then checks the sliced result:

1. Preserve good user or sculptor contact choices when supplied. Independently size the contact neck, trunk, and brace.
2. Give small islands and isolated details printable point contacts. Refine their locations against the original mesh, not only a simplified proxy.
3. Give broad downward faces a removable local roof/interface, carried by an efficient tree. Prusa's organic supports already establish the value of combining branches and interfaces.
4. Size trunks and bracing from height and lateral stability demands, while retaining the calibrated contact size.
5. Reject collisions away from intentional contacts, inaccessible trapped pillars, and uncovered starts. Use native slicer supports as a fallback when the custom generator fails its checks.
6. Validate the intended gap on the actual layer schedule and emitted paths. A mesh gap is not a measured molten-bead air gap, especially when the slicer uses bridge extrusion.

This is the design target, not a claim that an automatic feature classifier or a winning universal preset already exists. The current plate tests its constituent choices, not the Resin2FDM application itself. The custom engine's Spore candidates failed digital gates and were excluded. Native Tree Hybrid also left weak first-emission islands on that miniature, including one that tighter tree settings did not repair. Conventional snug supports repaired the flagged start and passed the limited first-emission screen: all 17 above-bed starts have nearby native-support witnesses, with nominal layer-envelope gaps of 0.06–0.12 mm. This is evidence for validating the actual extrusion rather than treating any named support style as universally best; connected overhang coverage and physical success remain outside that check.

## First physical study

The revised locally generated plate has 21 labeled specimens: a six-way gap/crown factorial, two local-interface coupons, two native coupon controls, a matched tall-column pair, five arm variants plus a native arm, two spanner variants plus a native spanner. The unmatched complete Spore control N5 was removed after the bounded follow-up below. Original model meshes are preserved; analysis proxies are used only to generate the experimental supports.

The synthetic local-interface coupon is deliberately a robust solid pedestal. It isolates underside support quality; it does not demonstrate a material-efficient finished roof algorithm. The tall pair combines thicker columns and bracing, so it tests that structural package rather than attributing its result to either change alone. The arm's legacy control runs the old parameters on the same fixed offline proxy as the other variants; it is not a byte-identical replay of the deployed STL import path.

Reproduction tools are `research-coupons.mjs`, `research-stability.mjs`, `research-generate.mjs`, `research-layout.mjs`, `research-slice.mjs`, `research-contact-metadata.mjs`, `research-toolpaths.mjs`, `research-native-islands.mjs`, and `research-print-guide.mjs` under `scripts/`. Geometry generation needs the prepared local runtime and private inventory. The installed Studio 2.4 CLI crashed on this machine; an isolated official 2.8 CLI was used for assembly preparation. The delivered files were then sliced and exported through the installed Studio 2.4.0.70 GUI. CLI and GUI paths differed, so only the exact final GUI export is the audited print candidate.

The revised 21-specimen plate estimates 7h 13m 26s and 13.00 g. It preserves all 56 model/support/label volumes within 0.000008 mm on roundtrip, all original model triangle counts, 94 known coupon/tower crowns, and 224 routed real-part tip necks. Nine omitted short-cavity contacts remain explicit limitations. These are scoped digital checks, not a certification of complete real-part coverage or print quality.

The private kit at `test-results/research/print-kit/` contains `A1-02-support-study.3mf` (editable), `A1-02-support-study.gcode.3mf` (sliced), `PRINT-ME.html` (map, instructions and score sheet), and `validation.json` (exact hashes, settings, warnings and scope). Its emitted commands use 220°C nozzle and 65°C Textured PEI bed, assuming Bambu PLA Matte. Studio still reports a high-bed-temperature filament warning and traditional-timelapse compatibility warnings; the guide records them. No printer job was sent. The first print screens these choices; repeat finalists at swapped positions before claiming reliability or a general optimum.

## Bounded Spore follow-up, 18 October 2026

The user requested a maximum 20-minute attempt to produce a matching custom-supported complete miniature, with removal of the unmatched native control if unsuccessful. Algorithm work ran from 19:40:10 to 19:59:52 UTC. Seven full-resolution variants retained every original output triangle. The final candidate still has one unrouted surface contact, so it was rejected and N5 was removed. The remaining 21 specimens keep their existing meshes and positions. The revised project was sliced and exported in the installed Bambu Studio GUI, then rechecked: 56 volumes, all 94 coupon/tower crowns, and all 224 routed real-part tip necks. The earlier 22-specimen kit is preserved locally under `revision3-before-N5-removal/`.

The useful algorithm findings are distinct from a successful print candidate:

- Full-resolution analysis removed errors introduced by the simplified proxy; it took about 15 seconds for this 300,056-triangle output miniature. This is one model's result, not a large-plate performance guarantee.
- A short-support test counted the air gap twice. Correcting it recovered five geometrically available short supports.
- Model-root rings and junction skirts could extend below the planned root. Per-root trimming and a narrow, printable taper constrain that geometry.
- The router checks horizontal slabs, but tilted structural rings extend below them. Opt-in horizontal structural rings and compact junctions eliminated all measured intersection outside contact neighborhoods on the final candidate. Ordinary contact caps retain their angled planes. The experimental `compact_junctions` setting defaults to false.
- Exact lower-neck clearance exposed invalid landings; using the actual candidate XY for blocked-route landing heights avoids a grid-cell-height mismatch. A separate neck-clearance parameter allowed testing 0.01 mm without weakening the independent full-mesh intersection check.

D6 routed 77 of 81 contacts: three were sub-layer omissions and one surface contact remained unrouted. Although all 17 independently observed original-model starts had some substantial underlying support geometry within the declared layer gap, seven topmost sliver flags remained; the candidate was not accepted for printing and its actual custom G-code was not validated. Zero body collision is not a certificate of contact quality, removability or strength. Inclined horizontal-ring branches have a smaller normal cross-section in one direction by cos(tilt), which needs a physical strength comparison before production use.

The sanitized per-variant measurements are in [spore-challenge-results.json](spore-challenge-results.json). Reproduce the six mesh regressions with `node scripts/test-model-root-planes.mjs` and the twelve landing assertions with `node scripts/test-model-landings.mjs`, after preparing the local runtime. Private meshes, candidate archives and detailed audits remain under ignored `test-results/research/`. The experimental code has not been deployed.
