/** Bind one unified research plate to its saved GUI exports and independent audits.
 * node scripts/research-unified-validate.mjs PRIVATE_KIT_DIR
 * This records digital evidence, never a claim of physical print success.
 */
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {unzipSync} from 'fflate';
import {DOMParser} from '@xmldom/xmldom';

if(!process.argv[2])throw Error('A private unified kit directory is required.');
const dir=path.resolve(process.argv[2]);
const sha=x=>createHash('sha256').update(x).digest('hex');
const bytes=f=>readFile(path.join(dir,f));
const json=async f=>JSON.parse(await bytes(f));
const demand=(condition,message)=>{if(!condition)throw Error(message)};
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const oldIds=['P0A','P1A','P2A','P0B','P1B','P2B','I1','I2','N1','N2','T1','T2','A0','A1','A2','A3','A4','N3','S0','S1','N4'];
const allIds=[...oldIds,'H0','N5','R0','R1','T3'],specimenCount=allIds.length;
const [slice,geometry,originalGeometry,paths,custom,native,manifest,review,realContacts]=await Promise.all([
 'gui-sliced/slice-result.json','gui-sliced/volume-roundtrip.json','gui-sliced/original-geometry.json',
 'gui-audit/toolpath-validation.json','custom-island-audit.json','native-island-audit.json',
 'plate-manifest.json','reviewed-flags.json','real-contact-metadata.json'
].map(json));
const ids=manifest.specimens.map(s=>s.id),byId=new Map(manifest.specimens.map(s=>[s.id,s]));
demand(equal([...ids].sort(),[...allIds].sort()),'Exactly the original 21 specimens, H0/N5, R0/R1 and lateral-braced T3 are required.');
const h0=byId.get('H0'),n5=byId.get('N5'),candidate=JSON.parse(await readFile(h0.researchSummary));
const gcodeBytes=await bytes('gui-sliced/plate_1.gcode'),gcodeHash=sha(gcodeBytes),manifestHash=sha(await bytes('plate-manifest.json'));
const supportEquivalence=await json('gui-sliced/h0-support-prior-export-equivalence.json');
const priorSpore=manifest.sourceProvenance.find(s=>s.kit==='spore-print-kit');
demand(priorSpore,'Missing prior miniature plate provenance.');
const priorDir=path.dirname(priorSpore.manifestPath),priorValidation=JSON.parse(await readFile(path.join(priorDir,'validation.json')));
const supportSource=h0.meshes.find(m=>path.basename(m.path)==='supports.stl');
demand(priorValidation.status==='Digitally checked experimental comparison; physical outcomes pending','Prior H0 comparison was not a checked final handoff.');
demand(supportEquivalence.passed&&supportEquivalence.toleranceMm<=.00002&&supportEquivalence.new.projectSha256===slice.editable.sha256&&supportEquivalence.new.manifestSha256===manifestHash,'H0 retained support comparison does not describe this final export.');
demand(supportEquivalence.old.projectSha256===priorValidation.files.editable.sha256&&supportEquivalence.old.manifestSha256===priorSpore.sha256&&sha(await readFile(supportEquivalence.old.project))===supportEquivalence.old.projectSha256,'Prior H0 support export provenance changed.');
const retained=supportEquivalence.comparison;
demand(retained.passed&&retained.orientedFacesPreserved&&retained.triangleCount>0&&retained.matchedTriangles===retained.triangleCount&&retained.expectedTriangleCount===retained.triangleCount&&Number.isFinite(retained.maxCoordinateDifferenceMm)&&retained.maxCoordinateDifferenceMm<=supportEquivalence.toleranceMm,'Retained H0 support faces differ from the previously checked export.');
for(const version of [supportEquivalence.old,supportEquivalence.new])demand(version.specimenId==='H0'&&version.supportSourceSha256===supportSource.sha256&&version.sourceTriangles===supportSource.triangles&&version.exportedTriangles===retained.triangleCount,'H0 retained support comparison uses another source mesh.');
for(const key of ['editable','printOnly']){
 const exportPath=path.resolve(slice[key].path);
 demand(path.dirname(exportPath)===dir,`Final ${key} export must be inside this kit.`);
 demand(sha(await readFile(exportPath))===slice[key].sha256,`Export changed: ${key}`);
}
const archiveGcode=Object.entries(unzipSync(await readFile(slice.printOnly.path),{filter:entry=>entry.name.endsWith('.gcode')}));
demand(archiveGcode.length===1&&sha(archiveGcode[0][1])===gcodeHash,'Delivered print archive contains different or multiple G-code files.');
demand(slice.printOnly.gcode.sha256===gcodeHash,'Extracted G-code differs from the recorded export.');
// Read settings directly from the delivered archives as well as trusting the
// independent reports. A stale extracted config must not bind a new export.
const archives={};
for(const kind of ['editable','printOnly']){
 archives[kind]=unzipSync(await readFile(slice[kind].path),{filter:entry=>/^Metadata\/(model_settings|project_settings|slice_info)\.config$/.test(entry.name)});
 for(const file of ['model_settings.config','project_settings.config','slice_info.config']){
  const content=archives[kind][`Metadata/${file}`];
  demand(content&&sha(content)===sha(await bytes(`gui-sliced/${kind==='editable'?'editable-':''}${file}`)),`Extracted ${kind} ${file} is stale.`);
 }
}
const decode=content=>Buffer.from(content).toString('utf8');
const editableProfile=JSON.parse(decode(archives.editable['Metadata/project_settings.config']));
const printedProfile=JSON.parse(decode(archives.printOnly['Metadata/project_settings.config']));
demand(equal(editableProfile,printedProfile),'Editable and sliced archive process profiles differ.');
const xml=content=>new DOMParser().parseFromString(decode(content),'text/xml');
const elements=(node,tag)=>[...node.childNodes].filter(n=>n.nodeType===1&&n.tagName===tag);
const metadata=node=>Object.fromEntries(elements(node,'metadata').filter(m=>m.hasAttribute('key')).map(m=>[m.getAttribute('key'),m.getAttribute('value')]));
const editableMeta=xml(archives.editable['Metadata/model_settings.config']).documentElement;
const directObjects=elements(editableMeta,'object').map(object=>({id:object.getAttribute('id'),settings:metadata(object)}));
demand(equal(directObjects,slice.objectSettings),'Recorded object settings differ from the delivered editable archive.');
const printedInfo=xml(archives.printOnly['Metadata/slice_info.config']).documentElement;
const infoPlates=elements(printedInfo,'plate'),editPlates=elements(editableMeta,'plate');
demand(infoPlates.length===1&&editPlates.length===1,'Exactly one editable and sliced plate is required.');
const printedObjects=elements(infoPlates[0],'object');
demand(printedObjects.length===specimenCount&&printedObjects.every(o=>o.getAttribute('skipped')==='false'),`The final print archive must include all ${specimenCount} objects.`);
const labelIds=gcodeBytes.subarray(0,20000).toString().match(/; model label id:\s*([\d,]+)/)?.[1].split(',');
demand(labelIds?.length===specimenCount&&new Set(labelIds).size===specimenCount,'G-code object labels are missing or duplicated.');
for(const specimen of manifest.specimens){
 const name=`assemble_${specimen.assemblyIndex}`,matches=printedObjects.filter(o=>o.getAttribute('name')===name);
 demand(matches.length===1&&matches[0].getAttribute('identify_id')===labelIds[specimen.assemblyIndex-1],`${specimen.id}: G-code and archive object identity differ.`);
 const object=directObjects.find(o=>o.settings.name===name);
 const instances=elements(editPlates[0],'model_instance').map(metadata).filter(m=>m.object_id===object?.id);
 demand(instances.length===1&&instances[0].identify_id===matches[0].getAttribute('identify_id'),`${specimen.id}: editable and print archive identity differ.`);
}
demand(metadata(editPlates[0]).bed_type==='Textured PEI Plate','Editable archive has the wrong explicit plate setting.');
const configEnd=gcodeBytes.indexOf(Buffer.from('; CONFIG_BLOCK_END'));
demand(configEnd>0&&configEnd<1024*1024,'Missing or unexpected G-code profile block.');
const gcodeConfig=Object.fromEntries([...gcodeBytes.subarray(0,configEnd).toString().matchAll(/^; ([a-z0-9_]+) = (.*)$/gm)].map(m=>[m[1],m[2].trim()]));
demand(gcodeConfig.printer_model==='Bambu Lab A1'&&gcodeConfig.curr_bed_type==='Textured PEI Plate'&&gcodeConfig.wall_generator==='classic','Emitted G-code uses another machine, bed or wall process.');
for(const [key,value]of Object.entries({layer_height:.06,initial_layer_print_height:.1,nozzle_diameter:.2,nozzle_temperature:220,nozzle_temperature_initial_layer:220,textured_plate_temp:65,textured_plate_temp_initial_layer:65}))demand(Number(gcodeConfig[key])===value,`Emitted G-code ${key} differs from the prepared process.`);
demand(slice.passed&&geometry.passed&&geometry.allSourcesUnchanged&&!slice.skippedObjects.length,'GUI settings, geometry or skipped-object check failed.');
demand(geometry.inputSha256===slice.editable.sha256&&geometry.manifestSha256===manifestHash,'Geometry report provenance mismatch.');
demand(geometry.volumeCount===manifest.specimens.reduce((n,s)=>n+s.meshes.length,0),'An assembly volume is absent from the geometry check.');
for(const specimen of manifest.specimens){
 demand(specimen.translation[2]===0,`${specimen.id}: expected source Z placement changed.`);
 const originals=specimen.sourcePlateProvenance?.sourceGeometry;
 if(!['R0','R1','T3'].includes(specimen.id)){
  demand(originals?.length===specimen.meshes.length,`${specimen.id}: missing original source provenance.`);
  demand(equal(specimen.settings,specimen.sourcePlateProvenance.originalSettings),`${specimen.id}: support settings changed from previous validated study.`);
  demand(specimen.meshes.every((mesh,i)=>mesh.path===originals[i].path&&mesh.sha256===originals[i].sha256&&mesh.triangles===originals[i].triangles),`${specimen.id}: source geometry changed.`);
 }
 const actualObjects=slice.objectSettings.filter(o=>o.settings.name===`assemble_${specimen.assemblyIndex}`);
 demand(actualObjects.length===1,`${specimen.id}: missing or duplicated GUI object settings.`);
 for(const [key,value]of Object.entries(specimen.settings)){
  const actual=actualObjects[0].settings[key];
  demand(String(actual)===String(value)||(Number.isFinite(Number(actual))&&Number(actual)===Number(value)),`${specimen.id}: ${key} differs in saved project.`);
 }
 const nativeExpected=String(specimen.settings.enable_support)==='1';
 demand(nativeExpected===/^N[1-5]$/.test(specimen.id),`${specimen.id}: native supports enabled on the wrong group.`);
 demand((slice.supportRoleMarkers[`assemble_${specimen.assemblyIndex}`]>0)===nativeExpected,`${specimen.id}: native-support paths mismatch.`);
 for(const mesh of specimen.meshes)demand(sha(await readFile(mesh.path))===mesh.sha256,`${specimen.id}: source mesh changed after assembly.`);
}
for(const volume of geometry.volumes){
 demand(volume.maxCoordinateDifferenceMm<.001&&volume.sourceHashUnchanged,'Changed volume bounds or source.');
 const unchangedH0=volume.specimen==='H0'&&volume.part==='supports.stl'&&volume.triangles===supportEquivalence.new.exportedTriangles&&volume.expectedTriangles===supportEquivalence.new.sourceTriangles;
 demand(volume.triangleDelta===0||(volume.specimen==='A2'&&volume.part==='supports.stl'&&volume.triangleDelta===-2)||unchangedH0,'Unexpected mesh triangle removal/addition.');
}
for(const source of manifest.sourceProvenance??[])demand(sha(await readFile(source.manifestPath))===source.sha256,'A prior source manifest changed.');
demand(manifest.layoutValidation?.sourceGeometryAndSettingsPreserved===23&&manifest.layoutValidation?.reservedEnvelopesDisjoint,'Combined layout did not preserve original studies or has overlapping envelopes.');
const append=manifest.layoutValidation.appendedT3,priorLayoutBytes=await readFile(append.priorManifest);
demand(append.unchangedExistingSpecimenPoses===25&&sha(priorLayoutBytes)===append.priorManifestSha256&&equal(JSON.parse(priorLayoutBytes).specimens,manifest.specimens.filter(s=>s.id!=='T3')),'Adding T3 changed the earlier 25 specimen records.');
const t2=byId.get('T2'),t3=byId.get('T3'),t3Bytes=await readFile(t3.stabilitySummary),t3Geometry=JSON.parse(t3Bytes);
const meshHash=(specimen,name)=>specimen.meshes.find(m=>path.basename(m.path)===name)?.sha256;
demand(sha(t3Bytes)===append.geometryReportSha256&&sha(t3Bytes)===t3.sourcePlateProvenance.sha256,'T3 geometry report changed after layout.');
demand(t3Geometry.geometryGate==='pass'&&t3Geometry.addedYZBraceCount===6&&t3Geometry.retainedXZBraceCount===4&&t3Geometry.supportWatertight&&t3Geometry.supportWindingConsistent&&t3Geometry.supportComponents===1&&t3Geometry.supportSelfSliceRegions.length===0&&t3Geometry.supportModelCollisionMm3===0&&t3Geometry.originalStructuralMaterialRemovedMm3<=1e-6,'T3 lateral-brace geometry failed its matched-structure gate.');
demand(meshHash(t2,'model.stl')===meshHash(t3,'model.stl')&&t3Geometry.source.modelSha256===meshHash(t2,'model.stl')&&t3Geometry.source.supportsSha256===meshHash(t2,'supports.stl')&&t3Geometry.hashes.model===meshHash(t3,'model.stl')&&t3Geometry.hashes.supports===meshHash(t3,'supports.stl')&&equal(t2.contacts,t3.contacts),'T3 must retain the T2 model and exact contact plan.');
const t3Paths=await json('stability-T3/emitted-brace-audit.json');
demand(t3Paths.passed&&t3Paths.flags.length===0&&t3Paths.bracesChecked===6&&t3Paths.gcodeSha256===gcodeHash&&t3Paths.manifestSha256===manifestHash&&t3Paths.geometryReportSha256===sha(t3Bytes)&&t3Paths.objectId===labelIds[t3.assemblyIndex-1]&&t3Paths.connectivityToleranceMm<=.003,'T3 actual-brace evidence is incomplete or describes another export.');
demand(t3Paths.intermediateWitnesses.length===24&&t3Paths.junctions.length===12,'T3 must have four intermediate and two attachment checks for each added brace.');
for(let brace=0;brace<6;brace++){
 const witnesses=t3Paths.intermediateWitnesses.filter(w=>w.brace===brace),joins=t3Paths.junctions.filter(j=>j.brace===brace),root=joins.find(j=>j.kind==='pad-root'),column=joins.find(j=>j.kind==='column-junction');
 demand(witnesses.length===4&&new Set(witnesses.map(w=>w.extrusionZMm)).size===4&&witnesses.every(w=>w.centerlineLengthMm>=.1&&w.beadAreaMm2>=.02),'An added T3 brace lacks four distinct extrusion witnesses.');
 demand(joins.length===2&&root?.overlapMm2>=.05&&Math.abs(root.extrusionZMm-root.precedingPadZMm-.06)<.0001&&column?.oneBeadComponentJoinsBraceAndColumn===true,'An added T3 brace lacks pad or column attachment.');
}

const expectedOriginals=manifest.specimens.filter(s=>s.meshes.some(m=>path.basename(m.path)==='model.stl'));
demand(originalGeometry.inputSha256===slice.editable.sha256&&originalGeometry.manifestSha256===manifestHash,'Original triangle report provenance mismatch.');
demand(originalGeometry.passed&&originalGeometry.originalCount===expectedOriginals.length&&originalGeometry.expectedOriginalCount===expectedOriginals.length&&originalGeometry.toleranceMm<=.00002,'Original triangle audit is missing or incomplete.');
demand(equal(originalGeometry.originals.map(o=>o.specimen).sort(),expectedOriginals.map(s=>s.id).sort()),'Original coordinate records do not match the manifest.');
for(const original of originalGeometry.originals){
 demand(original.passed&&original.sourceHashUnchanged&&original.orientedFacesPreserved,'Original triangle coordinates or winding changed.');
 demand(sha(await readFile(original.sourcePath))===original.sourceSha256,'Original source changed after its coordinate audit.');
}
const matchedOriginal=originalGeometry.originals.filter(o=>['H0','N5'].includes(o.specimen));
demand(matchedOriginal.length===2&&matchedOriginal.every(o=>o.sourceSha256===custom.originalModelSha256&&o.sourceSha256===native.originalModelSha256),'H0/N5 original models or poses do not match.');

demand(paths.gcode_sha256===gcodeHash&&paths.plate_manifest_sha256===manifestHash,'Coupon path audit does not describe the final export and layout.');
demand(paths.real_contact_metadata_sha256===sha(await bytes('real-contact-metadata.json'))&&realContacts.sourcePlateManifestSha256===manifestHash,'Real-part contact metadata provenance mismatch.');
demand(equal([...(paths.separate_contact_audits_required??[])].sort(),['H0','N5'])&&equal([...(realContacts.excludedSpecimenIds??[])].sort(),['H0','N5']),'Only H0/N5 may delegate their contacts to the required separate full audits.');
demand(paths.digital_status==='passed'&&!paths.errors.length&&!paths.warnings.length&&!paths.collapsed_gap_pairs.length,'Coupon/real-part path audit has unresolved failures or collapsed gap settings.');
demand(equal(paths.specimens.map(s=>s.id).sort(),[...ids].sort()),'The whole plate must be included in the toolpath audit.');
const oldPaths=paths.specimens.filter(s=>oldIds.includes(s.id)||s.id==='T3');
const expectedCrowns={P0A:13,P1A:13,P2A:13,P0B:13,P1B:13,P2B:13,I1:5,I2:5,T1:3,T2:3,T3:3};
const expectedNecks={A0:20,A1:20,A2:19,A3:19,A4:21,S0:64,S1:61};
for(const record of oldPaths)for(const [key,expected]of [['crown_top_layer_counts',expectedCrowns[record.id]??0],['inclined_tip_neck_counts',expectedNecks[record.id]??0]]){
 demand(record[key].total===expected&&record[key].present===expected,`${record.id}: original contact coverage changed or paths are missing.`);
}
const totals=key=>oldPaths.reduce((a,s)=>({present:a.present+s[key].present,total:a.total+s[key].total}),{present:0,total:0});
const crowns=totals('crown_top_layer_counts'),necks=totals('inclined_tip_neck_counts');
demand(crowns.total===97&&crowns.present===97,'The 97 coupon/tower crowns, including all three T3 contacts, must survive slicing.');
demand(necks.total===224&&necks.present===224,'The 224 routed original real-part necks must all survive slicing.');
demand(oldPaths.reduce((n,s)=>n+(s.omitted_engine_contact_count??0),0)===9,'The prior nine omitted contacts must remain explicit.');

for(const report of [custom,native]){
 demand(report.gcodeSha256===gcodeHash,'Miniature path audit does not describe final G-code.');
 demand(report.sourceManifestSha256===manifestHash,'Miniature audit layout changed.');
}
demand(custom.auditMode==='full-starts-and-contacts','A selected-contact diagnostic cannot validate H0.');
demand(custom.summary.aboveBedStarts>0&&custom.summary.aboveBedStarts===native.summary.supportedStartWitnesses,'Incomplete or mismatched original-model start coverage.');
demand(custom.summary.plannedTipNecks===candidate.contacts.filter(c=>c.routed).length,'H0 audit omitted routed contacts.');
demand(custom.summary.modelRoots===candidate.treeNodes.filter(n=>n.kind==='model_foot').length,'H0 audit omitted model-root necks.');
for(const tip of custom.contact_tip_necks.filter(t=>!t.screenable)){
 const node=candidate.treeNodes.find(n=>n.id===tip.node_id),parent=candidate.treeNodes.find(n=>n.id===node?.parent);
 const root=custom.model_root_necks.find(r=>r.node_id===parent?.id);
 demand(parent?.kind==='model_foot'&&root?.exclusive_neck_layers.length&&!root.flags.length,'An unscannable H0 short tip lacks a checked direct model root.');
}
demand(custom.candidateSummarySha256===sha(await readFile(h0.researchSummary))&&custom.supportSha256===sha(await readFile(custom.supportPath)),'H0 candidate/support changed after path audit.');
demand(candidate.originalGeometryIntegrity.trianglesPreserved&&candidate.originalGeometryIntegrity.maximumRoundtripVertexErrorMm===0,'H0 original export changed.');
demand(candidate.digitalGate.engineErrors===0&&candidate.digitalGate.supportClosed,'H0 engine routing or closed mesh check failed.');
demand(Number.isFinite(candidate.digitalGate.outsideContactCollisionVolumeMm3)&&candidate.digitalGate.outsideContactCollisionVolumeMm3<=1e-5,'H0 branch-body intersection remains.');
demand(custom.summary.startsWithoutSupportWitness===0&&custom.summary.modelRootScreenFlags===0&&custom.summary.tipNeckScreenFlags===0,'Missing H0 model-start, root or tip-neck extrusion.');
demand(custom.nativeSupportSegmentsExcluded===0,'H0 unexpectedly uses native supports.');
demand(native.summary.startFlags===0&&native.inspectionFlags.length===0,'Native N5 has unresolved first-emission flags.');
demand(review.customAuditSha256===sha(await bytes('custom-island-audit.json')),'Written review describes another H0 audit.');
const actualFlags=custom.inspectionFlags.map(f=>sha(JSON.stringify(f)));
for(const flag of custom.inspectionFlags)demand(flag.kind==='model-start'&&flag.causes.length===1&&flag.causes[0]==='Closest support witness covers less than 5% of the first-emission section.'&&flag.adequate_witness_within_gap,'Only a nearest sliver with a substantial lower witness may receive a written research disposition.');
demand(review.flags.length===actualFlags.length&&new Set(review.flags.map(f=>f.flagSha256)).size===actualFlags.length,'Every H0 flag requires one exact disposition.');
for(const hash of actualFlags)demand(review.flags.some(f=>f.flagSha256===hash&&f.disposition==='accepted-for-research-print'&&f.reason&&f.evidence),'Unreviewed H0 flag.');

const raft=await json('raft-removal-audit.json');
demand(raft.passed&&raft.gcodeSha256===gcodeHash&&raft.sourceManifestSha256===manifestHash,'Raft comparison audit failed or describes a different delivered file.');
demand(Array.isArray(raft.flags)&&raft.flags.length===0,'Raft split has unresolved inspection flags.');
demand(equal([...raft.specimenIds].sort(),['R0','R1']),'Raft audit must cover R0 and R1.');
const raftSummaries=[];
demand(raft.variants?.length===2&&new Set(raft.variants.map(v=>v.id)).size===2,'Raft audit must contain two distinct variant records.');
for(const variant of raft.variants){
 const specimen=byId.get(variant.id),summaryBytes=await readFile(specimen.fixtureSummary);
 demand(variant.sourceSummarySha256===sha(summaryBytes),'Raft fixture summary changed after audit.');
 raftSummaries.push(JSON.parse(summaryBytes));
 for(const [key,basename]of [['model','model.stl'],['support','supports.stl']])demand(variant.meshHashes[key]===specimen.meshes.find(m=>path.basename(m.path)===basename)?.sha256,'Raft audit source mesh hash mismatch.');
 demand(variant.passed&&variant.nativeSegments===0&&variant.flags.length===0&&variant.custom.inspectionFlags.length===0&&variant.fixture.flags.length===0,'Raft actual-path check is incomplete or has unresolved flags.');
 const c=variant.custom.summary,f=variant.fixture.summary,b=f.modelBaseFoundation;
 demand(variant.custom.auditMode==='full-starts-and-contacts'&&c.aboveBedStarts===9&&c.startsWithSupportWitness===9&&c.startsWithoutSupportWitness===0&&c.plannedTipNecks===8&&c.screenableTipNecks===8&&variant.custom.contact_tip_necks.length===8&&c.modelRootScreenFlags===0&&c.tipNeckScreenFlags===0,'Raft fixture is missing its complete nine starts or eight contact paths.');
 demand(variant.custom.printed_component_starts.length===9&&variant.custom.printed_component_starts.every(s=>Math.abs(s.closest_custom_support.nominal_layer_envelope_gap_mm-.06)<.0001),'A raft fixture contact gap changed or collapsed in the emitted paths.');
 demand(f.padLayersChecked>0&&f.supportLayersChecked>0&&f.newFloatingSupportIslands===0&&f.crossGroupReconnects===0,'Raft split or layer-to-layer support ancestry failed.');
 demand(f.groundedSupportGroups===(variant.id==='R0'?1:2),'Raft groups are not separately grounded as designed.');
 if(variant.id==='R1')demand(f.minimumEmittedRaftSeamMm>=.3,'The emitted split raft seam is too narrow.');
 demand(b.fullBaseInteriorCoverage>=.95&&b.firstModelEmittedFootprintCoverage>=.9&&b.modelPathLengthMm>=1&&Math.abs(b.nominalEnvelopeGapMm-.06)<.0001,'Raft fixture has insufficient base foundation or changed base release gap.');
}
demand(raft.variants[0].meshHashes.model===raft.variants[1].meshHashes.model&&equal(raftSummaries[0].treeNodes,raftSummaries[1].treeNodes)&&equal(raftSummaries[0].contacts,raftSummaries[1].contacts),'Raft pair must retain identical models, routed tree nodes and contact plan.');

const p=slice.effectiveProfile;
for(const [key,value]of Object.entries(p))if(key!=='curr_bed_type')demand(equal(value,printedProfile[key]),`Recorded ${key} differs from the delivered archive.`);
demand(p.printer_model==='Bambu Lab A1'&&Number(p.nozzle_diameter)===.2,'Wrong machine/nozzle.');
demand(Number(p.layer_height)===.06&&Number(p.initial_layer_print_height)===.10,'Wrong layer grid.');
demand(p.curr_bed_type==='Textured PEI Plate'&&p.wall_generator==='classic','Expected Textured PEI and installed Studio Classic walls.');
const oneValue=(value,expected)=>Array.isArray(value)?value.length===1&&Number(value[0])===expected:Number(value)===expected;
for(const key of ['nozzle_temperature','nozzle_temperature_initial_layer'])demand(oneValue(p[key],220),`Unexpected temperature: ${key}`);
for(const key of ['textured_plate_temp','textured_plate_temp_initial_layer'])demand(oneValue(p[key],65),`Unexpected bed temperature: ${key}`);
demand(Array.isArray(p.filament_settings_id)&&p.filament_settings_id.length===1&&p.filament_settings_id[0].includes('Bambu PLA Matte'),'Unexpected material preset.');
const headers=slice.printOnly.gcode.header;
const time=headers.find(s=>s.startsWith('; model printing time'))?.split('total estimated time: ')[1];
const grams=headers.find(s=>s.startsWith('; total filament weight'))?.match(/[:=]\s*([\d.]+)\s*$/)?.[1];
demand(time&&grams,'Missing print estimates.');
const summary=custom.summary;
const reportFiles=['gui-sliced/slice-result.json','gui-sliced/volume-roundtrip.json','gui-sliced/original-geometry.json','gui-sliced/h0-support-prior-export-equivalence.json','gui-audit/toolpath-validation.json','custom-island-audit.json','native-island-audit.json','raft-removal-audit.json','reviewed-flags.json','real-contact-metadata.json',path.relative(dir,t3.stabilitySummary),'stability-T3/emitted-brace-audit.json'];
const record={schemaVersion:1,createdAt:new Date().toISOString(),status:'Digitally checked unified experimental plate; physical outcomes pending',printerJobSent:false,
 estimate:`${time} · ${grams} g, Bambu Studio ${slice.applicationVersion}`,
 files:Object.fromEntries(['editable','printOnly'].map(k=>[k,{file:path.basename(slice[k].path),sha256:slice[k].sha256,bytes:slice[k].bytes}])),
 gcode:{file:'gui-sliced/plate_1.gcode',sha256:gcodeHash},plate:{specimens:ids.length,ids,manifest:'plate-manifest.json',manifestSha256:manifestHash,study:manifest.study},preparedProcess:p,
 auditFiles:await Promise.all(reportFiles.map(async file=>({file,sha256:sha(await bytes(file))}))),
 validationSummary:`All ${specimenCount} specimens share one installed-GUI slice. All ${crowns.total} coupon/tower crowns and ${necks.total} routed real-part necks survive. H0 has support witnesses for ${summary.aboveBedStarts} above-bed model starts, ${summary.modelRoots} model roots and ${summary.screenableTipNecks} screenable tip necks; ${actualFlags.length} nearest-sliver flags retain written dispositions. N5 passes its limited start screen. The raft pair passes its saved-path separation check. All ${expectedOriginals.length} model.stl meshes retain their original oriented triangles.`,
 algorithmDescription:review.algorithmDescription,
 verification:{application:slice.applicationVersion,workflow:'Saved editable project and exported plate sliced file from installed Bambu Studio; all reports bind the resulting exact files. No printer job sent.',geometry:{volumes:geometry.volumeCount,sourceFilesUnchanged:geometry.allSourcesUnchanged,maxBoundingBoxDifferenceMm:geometry.maxCoordinateDifferenceMm,originals:originalGeometry.originalCount,maxOriginalTriangleCoordinateDifferenceMm:originalGeometry.maxCoordinateDifferenceMm,triangleCountChanges:geometry.triangleCountChanges},originalStudy:{crowns,routedTipNecks:necks,omittedContacts:9,collapsedGapPairs:paths.collapsed_gap_pairs,nativeCouponPathComparison:paths.native_coupon_path_comparison},custom:{candidateId:candidate.id,summary,candidateGate:candidate.digitalGate,shortContactFits:candidate.shortContactFits,omittedContacts:candidate.contacts.filter(c=>!c.routed),review,engineSha256:candidate.engineArchiveSha256,generatorSha256:candidate.generatorSourceSha256},native:{summary:native.summary,scope:native.scope},raft,nativeOnlyOn:ids.filter(id=>/^N[1-5]$/.test(id))},
 warnings:{slicer:slice.warnings,engine:candidate.issues.filter(i=>i.severity==='warning')},
 knownLimits:[
  'Digital checks do not prove adhesion, strength, underside finish or clean removal. Those are the physical questions this plate tests.',
  'There is one specimen per setting. This is a screening print, not a reliability study; repeat finalists at swapped positions.',
  'The prior nine omitted short-cavity contacts remain explicit in A/S specimens. H0 retains three omitted sub-layer contacts near its base.',
  `Studio retains ${retained.triangleCount.toLocaleString('en-US')} of H0's ${supportSource.triangles.toLocaleString('en-US')} source support facets, exactly matching all oriented support triangles in the previously checked GUI export within 0.00002 mm. Original miniature/model triangles are preserved in full.`,
  'First-emission checks exclude connected expanding overhangs and established bridges. Layer-envelope gaps are not measured molten-bead air gaps.',
  `${summary.plannedTipNecks-summary.screenableTipNecks} very short H0 contacts lack a long pre-cap neck; independently checked direct model roots cover those cases.`,
  ...review.knownLimits,...(raft.knownLimits??[]),
  'T2 combines diameter and XZ bracing. T3 adds six lateral Y braces to the same T2 structure and contact plan; this does not isolate equal-mass redistribution. A2 combines gap and crown changes. H0 compares a complete custom package with native supports. R1 compares the complete pad-seam and brace separation package.',
  'T3 has four emitted-path witnesses per added brace and checks of pad/root overlap and connected column joins. This is sampled digital evidence, not exhaustive every-layer ancestry or proof of buckling resistance.',
  'This tests point-contact and tree/interface strategies, not the Resin2FDM application itself. Automatic feature-based selection is not established by one plate.',
  'The earlier 21-specimen and two-miniature export files remain unchanged. Private collection geometry remains local.'
 ],observationGuide:null,observationGuideStatus:'Deferred at user request until printing has started.'};
record.verification.geometry.h0RetainedSupportEquivalence={report:'gui-sliced/h0-support-prior-export-equivalence.json',retainedTriangles:retained.triangleCount,maxCoordinateDifferenceMm:retained.maxCoordinateDifferenceMm,priorExportSha256:supportEquivalence.old.projectSha256};
record.verification.lateralStability={specimen:'T3',matchedControl:'T2',geometryReport:path.relative(dir,t3.stabilitySummary),sameOriginalAndContactPlan:true,addedYBraces:t3Geometry.addedYZBraceCount,retainedXZBraces:t3Geometry.retainedXZBraceCount,removedOriginalStructureMm3:t3Geometry.originalStructuralMaterialRemovedMm3,emittedBraceReport:'stability-T3/emitted-brace-audit.json',intermediateWitnesses:t3Paths.intermediateWitnesses.length,attachmentChecks:t3Paths.junctions.length,scope:t3Paths.scope};
record.verification.archiveBinding={directMetadataChecked:true,matchedObjectIdentities:specimenCount,gcodeProfileChecked:true};
const i1Paths=paths.specimens.find(s=>s.id==='I1');
record.warnings.interactiveGui=[{observed:'The final installed Bambu Studio GUI displayed a floating-regions warning for assemble_7 (I1), separate from the stored slice-info warnings.',specimen:'I1',review:'I1 intentionally has positive gaps between ordinary-mesh supports and model. Its five point crowns and broad interface top have emitted-path witnesses; the known warning remains visible and physical attachment is a print-test question.',crownPaths:i1Paths.crown_top_layer_counts,interfaceNominalLayerEnvelopeGapMm:i1Paths.interface_nominal_layer_envelope_gap_mm,evidence:'gui-audit/toolpath-validation.json'}];
await writeFile(path.join(dir,'validation.json'),JSON.stringify(record,null,2)+'\n');
console.log(record.estimate);console.log(record.validationSummary);
