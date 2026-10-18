# FDM miniature support research

For the Bambu A1 with a 0.2 mm nozzle, the strongest candidate is a hybrid: small printable contacts for isolated details, stable branches, and local interfaces beneath broad undersides. This is a design hypothesis to test against native slicer supports; the reviewed evidence does not establish one best resin-style preset for arbitrary miniatures. Prusa's organic-support guidance explicitly favors interfaces when an underside needs dense support. [Prusa organic supports](https://help.prusa3d.com/article/organic-supports_480131)

The working app is preserved in commit `511f12f`. Research is on `codex/fdm-support-experiments`. The user subsequently authorized experimental generation and slicing. The deployed app remains unchanged; the experiments are offline scripts, with private geometry under ignored `test-results/research/`.

The printer and nozzle are user-confirmed. The prepared process uses 0.06 mm High Quality, Bambu PLA Matte and Textured PEI; the actual filament and plate remain assumptions. The saved Blitzboys plate contains different filament and support settings, so it supplies geometry rather than silently supplying the experimental process.

**The first priority is contact calibration in the actual slicer.** Exported trees are ordinary model geometry. Bambu's native support gap and interface controls do not automatically change them. A tiny mesh crown can disappear, widen, or merge when sliced. Inspect the emitted extrusion before judging a setting by its 3D preview. [Orca wall generator](https://github.com/OrcaSlicer/OrcaSlicer/wiki/quality_settings_wall_generator), [Orca support settings](https://github.com/OrcaSlicer/OrcaSlicer/wiki/support_settings_advanced)

The initial audit of the deployed baseline found concrete reasons to begin there. The later experimental fixes are recorded below; this list preserves the original findings:

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

The revised 21-specimen plate estimates 7h 13m 26s and 13.00 g. All 56 model/support/label volumes retain their bounding boxes within 0.000008 mm on roundtrip, and all original model triangle counts are unchanged. The actual-path checks retain 94 known coupon/tower crowns and 224 routed real-part tip necks. The bounding-box check does not compare every interior vertex; the stronger complete-triangle check described below was added for the subsequent matched-miniature comparison. Nine omitted short-cavity contacts remain explicit limitations. These are scoped digital checks, not a certification of complete real-part coverage or print quality.

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

The sanitized measurements from this timeboxed attempt are in [spore-challenge-results.json](spore-challenge-results.json). Reproduce the mesh and landing regressions with `node scripts/test-model-root-planes.mjs` and `node scripts/test-model-landings.mjs`, after preparing the local runtime. Both suites were extended during the renewed investigation below. Private meshes, candidate archives and detailed audits remain under ignored `test-results/research/`. The experimental code has not been deployed.

## Renewed complete-miniature investigation, 18 October 2026

The user authorized a further attempt after the timeboxed rejection. The existing 21-specimen plate remains the separate calibration study. The new two-miniature comparison contains identical full-resolution models in the same pose: H0 with custom supports and N5 with Bambu normal/snug supports. **Final E3 passed the scoped checks on its installed-GUI Classic-wall export and is ready for a physical research comparison.** Its estimate is **4h 51m 42s and 9.78 g**. No printer job was sent and no physical success is claimed. The earlier D-series record above remains a record of that attempt, not the current candidate's acceptance status.

The renewed work addresses three different geometry problems:

- **Blocked tip routes.** A contact whose first escape direction cannot route gets a bounded search of alternate directions through the same collision and landing checks. Each trial runs in a separate temporary tree. Only an accepted branch is added; existing successful node IDs, positions, radii and parent links are preserved. This recovered the remaining printable surface contact in E1. E1 routed 78 of 81 contacts, with the three sub-layer cavities still explicitly omitted, and measured no branch-body intersection outside the declared contact neighborhoods.
- **Tilted cap rims.** A tip cap aligned to the escape direction can push its rim into the underside even when its center has the requested gap. The opt-in `surface_aligned_tips` mode uses the actual contact normal for the cap plane. Structural routing direction and contact plane remain separate. This reduces one source of unintended fusion; it does not establish actual deposited-bead clearance.
- **Finite-width short contacts.** A downward ray gives only a point landing height. A short pillar can still intersect a sloped or curved surface across its footprint. The opt-in `fit_short_contacts` mode tries a bounded set of printable radii and small offsets, retains the requested contact XY inside the cap, computes cap and root clearance from the original triangle planes, and rejects candidates with actual solid intersection. It also requires a one-line projected cap width, at least one layer of free support height, and expansion within the selected branch-angle limit. It does not carve the support out of the miniature to force a fit.

E2 fitting on the original miniature accepted 18 of its 19 short contacts, including all eight sites flagged in the E1 cap-neighborhood audit. One narrow sloped cavity still cannot accommodate the fitted geometry under these constraints. Its legacy short support remains with an explicit failed-fit warning; it is not silently counted as repaired. The complete E2 geometry had 78 of 81 contacts routed, no engine errors and no measured branch-body intersection outside the declared contact neighborhoods.

The installed-GUI Classic-wall slice nevertheless omitted two planned short-support necks. All 17 above-bed first-emission model starts still had underlying witnesses, showing why start coverage alone is insufficient. The cap-overlap inspection flags had disappeared, but the missing root paths remained blocking failures. An Arachne CLI diagnostic recovered one root; the other still failed the early-foundation screen, with a center-neck witness 0.18 mm above underlying model extrusion rather than within the two-layer allowance. That diagnostic did not qualify E2 for printing.

This exposed the need to inspect actual horizontal cross-sections at the slicer's layer phases. A sufficiently wide inclined cap and root do not guarantee a sufficiently wide section between them. E3 adds an optional 0.28 mm preferred root/projected-cap width. If that preference cannot fit, the search retries the ordinary line-width constraint with the same gap, foundation, expansion-angle and exact-solid intersection checks. Metadata records the actual width constraint, whether the preference was met, and the reason for fallback. Seventeen of the 19 short contacts meet the preference; one uses the checked 0.22 mm constraint, and one retains the explicit unfitted legacy pillar. The preference defaults to zero.

The final E3 export uses **Classic walls for both miniatures, not Arachne**. The wider geometry preserved the two roots that E2 lost. In Bambu Studio 2.4.0.70, the complete final custom-path audit found underlying support witnesses for all 17 above-bed first-emission model starts, surviving extrusion at all 33 model-root necks, and all 69 separately screenable tip necks. The remaining nine very short tips have direct model-root parents whose extrusion and foundations were checked independently. There are no missing-root, missing-tip-neck or cap-neighborhood overlap screen flags. Three nearest-layer sliver flags remain explicitly reviewed: their preceding support layer overlaps 36–44% of the first emitted model section at a 0.12 mm nominal layer-envelope gap. The native reference passes its separate 17-start screen with no inspection flags.

Generation took about 21.2 seconds for this one original miniature and retained all 300,056 output triangles. It routed 78 of 81 contacts, with the same three sub-layer omissions, no engine errors and zero measured branch-body intersection outside contact neighborhoods. The total support/model intersection is still about 0.001902 mm³ within those neighborhoods. One legacy cavity fit remains unproven, one long tip retains about 0.0046 mm sampled local rim penetration, and model-root attachments have no positive bottom release gap. Existing warnings about narrow foundations, enclosed removal, small near-base overhangs and a small support overhang remain physical-print questions. These qualifications are retained in the handoff rather than hidden by the successful path checks.

The final process is A1/0.2 mm, 0.06 mm layers with a 0.10 mm first layer, Classic walls, and the assumed Bambu PLA Matte/Textured PEI combination at 220°C/65°C. Slicer warnings about bed temperature and traditional timelapse remain recorded. Exact editable/sliced export hashes, generation gates, path counts, reviewed slivers, warnings and scope are in [spore-followup-results.json](spore-followup-results.json). The local handoff also includes the editable project, actual sliced 3MF, full validation record and observation guide. A re-slice or material change requires new checks; the recorded results describe these exact files.

The verification has also become more specific:

- `research-original-geometry.py` compares every original triangle after all 3MF component/build transforms, permitting only face reordering and cyclic vertex rotations. It requires one-to-one face multiplicity and preserves winding within a fixed 0.00002 mm per-coordinate tolerance. Both originals in the final GUI archive pass with a maximum difference of 0.00000732 mm. The test rejects an internal-vertex mutation that leaves both bounds and face count unchanged.
- The custom path audit clips emitted paths against separate original-model and support cross-sections. Overlapping/ambiguous fragments cannot serve as both model and support evidence. It checks first emitted model-component starts and planned root/tip necks; connected expanding overhangs remain outside its scope. Very short tips need a successful direct model-root extrusion witness when they lack a separately screenable neck.
- Each native/custom audit hashes and parses one immutable G-code byte snapshot. Final validation binds those hashes to the G-code actually contained in the supplied sliced archive, as well as the editable geometry, source meshes, manifest and candidate summary. A selected-contact diagnostic cannot stand in for a complete audit.
- Inspection flags remain explicit. A small nearest witness can receive a written experimental-print disposition only when a substantial lower witness exists within the declared gap. Short model-root contact neighborhoods need their own written review. Neither disposition can waive routing errors, missing neck extrusion or branch-body collision. These are inspection screens, not measured thresholds for adhesion or removability.

These synthetic regressions require the prepared local WASM runtime but no private collection meshes:

```sh
node scripts/test-model-landings.mjs
node scripts/test-model-root-planes.mjs
node scripts/test-short-contact-fit.mjs
node scripts/research-custom-islands.mjs --self-test
python3 scripts/research-original-geometry.py --self-test
```

The short-contact tests rebuild the actual support mesh for flat and sloped cavities, then independently check original-solid intersection, cap gap, root contact, projected width and expansion. They reject cavities narrower than one printable layer plus the gap and caps narrower than one line. The geometry checker requires NumPy; the other tests run the actual Python/Manifold WASM path. Passing these checks qualifies a candidate for further slicing and inspection, not a claim that it prints or removes cleanly. Bracing strength, broad-underside quality, trapped material and fragile-detail survival still need the physical comparisons.

## Shared-pad removal seams

The removal-seam experiment keeps the original broad raft outline and subtracts a
narrow full-depth strip. It first searches for a straight seam, then tries bounded
doglegs around protected feet and the model base. Whole rooted supports retain
their routes and contacts. Both bracing passes stay within each raft section;
an actual support-plus-raft Boolean union checks that two grounded groups remain.
Failed separation restores the intact raft and original braces. This is an
extraction heuristic, not a proof of a collision-free removal path.

`npm run test:raft-split` runs ten synthetic regressions in the actual browser
Python/Manifold runtime. The bent fixture keeps 96.09% of the original broad pad,
all eight feet and the full model-base foundation, with four feet on each side.
The exact support/raft union changes from one connected solid to two. Tests also
cover unchanged contacts, seam-only material removal, bracing restrictions,
reproducibility, invalid settings, and intact fallback through the pipeline.
The script exports matched intact/split geometry and a top-view SVG under the
ignored `test-results/raft-split/` directory. These are geometry-inspection
fixtures, not sliced or physically validated print files.

The complete app test suite and static build passed. Browser generation on the
stock figurine completed in 10.6 seconds and correctly reported that no protected
split fit. Two full-resolution collection samples retained their intact rafts:
the bare arm had fewer than four plate feet, and the spanner hand had no accepted
seam. Split-enabled generation took 5.3 and 6.9 seconds respectively, with no new
engine errors or changes to contact/tree counts. This initial heuristic is
conservative; success on the synthetic cage does not establish coverage of all
real cages. The existing validated print kits are unchanged. Physical follow-up
should compare identical parts with intact versus split rafts, recording removal
time, necessary branch cuts, retained fragments, and print stability.
