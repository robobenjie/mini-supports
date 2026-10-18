/** Bind the final native GUI exports to geometry and actual-path audits.
 * Review flags remain visible. An exact, written per-flag disposition is required;
 * this cannot turn routing errors, missing emitted starts or invalid geometry into a pass.
 */
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {unzipSync} from 'fflate';
const dir=path.resolve(process.argv[2]);
const sha=x=>createHash('sha256').update(x).digest('hex');
const bytes=f=>readFile(path.join(dir,f));
const json=async f=>JSON.parse(await bytes(f));
const [slice,geometry,custom,native,manifest,review]=await Promise.all(['gui-sliced/slice-result.json','gui-sliced/volume-roundtrip.json','custom-island-audit.json','native-island-audit.json','plate-manifest.json','reviewed-flags.json'].map(json));
const originalGeometry=await json('gui-sliced/original-geometry.json');
const demand=(condition,message)=>{if(!condition)throw Error(message)};
const h0=manifest.specimens.find(s=>s.id==='H0'),n5=manifest.specimens.find(s=>s.id==='N5');
demand(h0&&n5&&manifest.specimens.length===2,'Exactly the matched H0 and N5 pair is required.');
const candidate=JSON.parse(await readFile(h0.researchSummary));
demand(custom.auditMode==='full-starts-and-contacts','A selected-contact diagnostic cannot validate a print.');
demand(custom.summary.aboveBedStarts>0&&custom.summary.aboveBedStarts===native.summary.supportedStartWitnesses,'Incomplete or mismatched original-model start coverage.');
demand(custom.summary.plannedTipNecks===candidate.contacts.filter(c=>c.routed).length,'Audit omitted routed contact tips.');
demand(custom.summary.modelRoots===candidate.treeNodes.filter(n=>n.kind==='model_foot').length,'Audit omitted model-root necks.');
for(const tip of custom.contact_tip_necks.filter(t=>!t.screenable)){
 const node=candidate.treeNodes.find(n=>n.id===tip.node_id),parent=candidate.treeNodes.find(n=>n.id===node?.parent);
 const root=custom.model_root_necks.find(r=>r.node_id===parent?.id);
 demand(parent?.kind==='model_foot'&&root?.exclusive_neck_layers.length&&!root.flags.length,'A short tip lacks an independently checked direct model-root neck.');
}
const gcodeHash=sha(await bytes('gui-sliced/plate_1.gcode')),manifestHash=sha(await bytes('plate-manifest.json'));
for(const key of ['editable','printOnly'])demand(sha(await readFile(slice[key].path))===slice[key].sha256,`Export changed: ${key}`);
demand(slice.printOnly.gcode.sha256===gcodeHash,'Extracted G-code differs from the recorded print-only export.');
const archiveGcode=Object.entries(unzipSync(await readFile(slice.printOnly.path),{filter:entry=>entry.name.endsWith('.gcode')}));
demand(archiveGcode.length===1&&sha(archiveGcode[0][1])===gcodeHash,'The delivered archive contains different G-code.');
for(const report of [custom,native]){
 demand(report.gcodeSha256===gcodeHash,'Path audit does not describe the final G-code.');
 demand(report.sourceManifestSha256===manifestHash,'Path audit manifest changed.');
}
demand(geometry.inputSha256===slice.editable.sha256&&geometry.manifestSha256===manifestHash,'Geometry provenance mismatch.');
demand(originalGeometry.inputSha256===slice.editable.sha256&&originalGeometry.manifestSha256===manifestHash,'Original triangle audit provenance mismatch.');
demand(originalGeometry.originals.length===2&&originalGeometry.originals.map(o=>o.specimen).sort().join(',')==='H0,N5','Both original-model coordinate records are required.');
demand(originalGeometry.passed&&originalGeometry.originalCount===2&&originalGeometry.expectedOriginalCount===2&&originalGeometry.toleranceMm<=.00002&&originalGeometry.originals.every(o=>o.passed&&o.sourceHashUnchanged&&o.orientedFacesPreserved),'Original triangle coordinates or winding changed.');
for(const original of originalGeometry.originals)demand(sha(await readFile(original.sourcePath))===original.sourceSha256&&original.sourceSha256===custom.originalModelSha256&&original.sourceSha256===native.originalModelSha256,'Original source differs between coordinate and path audits.');
demand(custom.candidateSummarySha256===sha(await readFile(h0.researchSummary)),'Candidate changed since path audit.');
demand(custom.originalModelSha256===native.originalModelSha256,'The miniature pose/geometry must match.');
demand(custom.supportSha256===sha(await readFile(custom.supportPath)),'Custom support geometry changed.');
demand(slice.passed&&geometry.passed&&!slice.skippedObjects.length,'GUI settings, geometry or skipped-object check failed.');
demand(geometry.volumes.filter(v=>v.part==='model.stl').every(v=>v.triangleDelta===0),'Original model faces changed.');
demand(candidate.originalGeometryIntegrity.trianglesPreserved&&candidate.originalGeometryIntegrity.maximumRoundtripVertexErrorMm===0,'Original export changed.');
demand(candidate.digitalGate.engineErrors===0&&candidate.digitalGate.supportClosed,'Engine routing or closed-mesh check failed.');
demand(Number.isFinite(candidate.digitalGate.outsideContactCollisionVolumeMm3)&&candidate.digitalGate.outsideContactCollisionVolumeMm3<=1e-5,'Branch-body intersection remains.');
demand(custom.summary.startsWithoutSupportWitness===0&&custom.summary.modelRootScreenFlags===0&&custom.summary.tipNeckScreenFlags===0,'Missing model start, root or tip-neck extrusion.');
demand(custom.nativeSupportSegmentsExcluded===0,'H0 unexpectedly uses native supports.');
demand(native.summary.startFlags===0&&native.inspectionFlags.length===0,'Native reference has unresolved start inspection flags.');
demand(review.customAuditSha256===sha(await bytes('custom-island-audit.json')),'Written review is for another custom audit.');
const actualFlags=custom.inspectionFlags.map(f=>sha(JSON.stringify(f)));
for(const flag of custom.inspectionFlags){
 if(flag.kind==='model-start')demand(flag.causes.length===1&&flag.causes[0]==='Closest support witness covers less than 5% of the first-emission section.'&&flag.adequate_witness_within_gap,'Only a small nearest sliver with a substantial lower witness can receive a written research disposition.');
 else if(flag.kind==='tip-contact'){
  const tip=custom.contact_tip_necks.find(t=>t.node_id===flag.node_id);
  demand(tip?.direct_parent_kind==='model_foot'&&(!tip.screenable||tip.exclusive_neck_layers.length),'Contact review cannot waive a missing neck or broad long-tip overlap.');
 }else demand(false,`Non-reviewable inspection failure: ${flag.kind}`);
}
demand(review.flags.length===actualFlags.length,'Every inspection flag needs a disposition.');
for(const hash of actualFlags)demand(review.flags.some(f=>f.flagSha256===hash&&f.disposition==='accepted-for-research-print'&&f.reason&&f.evidence),'Unreviewed inspection flag.');
const p=slice.effectiveProfile;
demand(p.printer_model==='Bambu Lab A1'&&Number(p.nozzle_diameter)===.2,'Wrong machine/nozzle.');
demand(Number(p.layer_height)===.06&&Number(p.initial_layer_print_height)===.10,'Wrong layer grid.');
demand(p.curr_bed_type==='Textured PEI Plate','Wrong plate.');
demand(p.wall_generator==='classic','The validated comparison uses installed Studio Classic walls.');
const oneValue=(value,expected)=>Array.isArray(value)?value.length===1&&Number(value[0])===expected:Number(value)===expected;
for(const key of ['nozzle_temperature','nozzle_temperature_initial_layer'])demand(oneValue(p[key],220),`Unexpected temperature: ${key}`);
for(const key of ['textured_plate_temp','textured_plate_temp_initial_layer'])demand(oneValue(p[key],65),`Unexpected bed temperature: ${key}`);
demand(Array.isArray(p.filament_settings_id)&&p.filament_settings_id.length===1&&p.filament_settings_id[0].includes('Bambu PLA Matte'),'Unexpected material preset.');
const headers=slice.printOnly.gcode.header;
const time=headers.find(s=>s.startsWith('; model printing time'))?.split('total estimated time: ')[1];
const grams=headers.find(s=>s.startsWith('; total filament weight'))?.match(/[:=]\s*([\d.]+)\s*$/)?.[1];
demand(time&&grams,'Missing print estimates.');
const summary=custom.summary;
const record={schemaVersion:1,createdAt:new Date().toISOString(),status:'Digitally checked experimental comparison; physical outcomes pending',printerJobSent:false,
 estimate:`${time} · ${grams} g, Bambu Studio ${slice.applicationVersion}`,
 files:Object.fromEntries(['editable','printOnly'].map(k=>[k,{file:path.basename(slice[k].path),sha256:slice[k].sha256,bytes:slice[k].bytes}])),
 gcode:{file:'gui-sliced/plate_1.gcode',sha256:gcodeHash},plateManifestSha256:manifestHash,preparedProcess:p,
 algorithmDescription:review.algorithmDescription,
 validationSummary:`Both copies retain the same ${candidate.sourceTriangles.toLocaleString('en-US')} original model triangles. The custom generator has no routing errors and no measured branch-body collision outside contact neighborhoods. Actual emitted custom-support paths underlie all ${summary.aboveBedStarts} above-bed first-emission model starts; all ${summary.modelRoots} model-root necks and ${summary.screenableTipNecks} screenable tip necks survive slicing. ${actualFlags.length} inspection flags remain explicitly reviewed in the validation record. The native reference passes its limited first-emission screen.`,
 verification:{application:slice.applicationVersion,geometryReport:'gui-sliced/volume-roundtrip.json',volumeCount:geometry.volumeCount,maxBoundingBoxDifferenceMm:geometry.maxCoordinateDifferenceMm,originalGeometryReport:'gui-sliced/original-geometry.json',maxOriginalTriangleCoordinateDifferenceMm:originalGeometry.maxCoordinateDifferenceMm,candidateId:candidate.id,candidateGate:candidate.digitalGate,routingRetries:candidate.routingRetries,shortContactFits:candidate.shortContactFits,omittedContacts:candidate.contacts.filter(c=>!c.routed),customSummary:summary,customAudit:'custom-island-audit.json',nativeSummary:native.summary,nativeAudit:'native-island-audit.json',review,sourceEngineSha256:candidate.engineArchiveSha256,sourceGeneratorSha256:candidate.generatorSourceSha256},
 warnings:{slicer:slice.warnings,engine:candidate.issues.filter(i=>i.severity==='warning')},
 knownLimits:[
  'These are digital checks for an experimental print, not proof of adhesion, strength, surface quality or clean removal.',
  'The first-emission audit excludes connected expanding overhangs and established bridges. Three sub-layer contacts near the base remain explicitly omitted.',
  `${summary.plannedTipNecks-summary.screenableTipNecks} very short cavity contacts lack a long pre-cap neck to audit separately; their model-root extrusion checks and local contact review remain explicit.`,
  ...review.knownLimits,
  'Nominal bead footprints and layer-envelope gaps are not measured molten-bead air gaps.',
  'This compares the complete custom support package with native normal/snug supports. Individual improvement attribution comes from the separate coupon study.',
  'The original 21-specimen plate remains unchanged. No experimental algorithm changes have been deployed.'
 ],observationGuide:'PRINT-ME.html'};
await writeFile(path.join(dir,'validation.json'),JSON.stringify(record,null,2)+'\n');console.log(record.estimate);console.log(record.validationSummary);
