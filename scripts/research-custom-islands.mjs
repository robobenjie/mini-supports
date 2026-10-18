/** Audit actual emitted paths for a miniature with ordinary-mesh custom supports.
 * node scripts/research-custom-islands.mjs --manifest plate-manifest.json --specimen H0 --gcode plate_1.gcode
 * node scripts/research-custom-islands.mjs --self-test
 * Read-only with respect to geometry and G-code. The JSON report is deliberately
 * a limited digital inspection screen, never certification of physical printing.
 */
import {GcodeParser} from './research-toolpaths.mjs';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createInterface} from 'node:readline';
import {Readable} from 'node:stream';
import {gzipSync} from 'node:zlib';
import path from 'node:path';
import {loadPyodide} from 'pyodide';
import Module from 'manifold-3d';
import {STLLoader} from 'three/examples/jsm/loaders/STLLoader.js';

const args={};for(let i=2;i<process.argv.length;i++){const key=process.argv[i];if(!key.startsWith('--'))throw Error(`Unexpected argument ${key}`);args[key.slice(2)]=process.argv[i+1]?.startsWith('--')||i+1===process.argv.length?true:process.argv[++i];}
const hash=b=>createHash('sha256').update(b).digest('hex');
const py=await loadPyodide({indexURL:path.resolve('public/runtime')+'/'});
await py.loadPackage(['numpy','shapely']);
const helpers=await readFile(new URL('./research-custom-islands.py',import.meta.url),'utf8');
if(args['self-test']){
  py.globals.set('audit_self_test',true);
  console.log(await py.runPythonAsync(helpers));
  process.exit(0);
}
if(!args.manifest||!args.gcode)throw Error('--manifest and --gcode are required.');
const manifestPath=path.resolve(args.manifest),manifestBytes=await readFile(manifestPath),manifest=JSON.parse(manifestBytes);
const specimen=manifest.specimens.find(s=>s.id===(args.specimen??'H0'));
if(!specimen)throw Error('Custom specimen is absent from the manifest.');
if(!specimen.researchSummary)throw Error('A researchSummary is required to check planned tips and model roots.');
const summaryBytes=await readFile(specimen.researchSummary),summary=JSON.parse(summaryBytes);
const modelPath=specimen.files.find(f=>path.basename(f)==='model.stl');
const supportPath=specimen.files.find(f=>path.basename(f)==='supports.stl');
if(!modelPath||!supportPath)throw Error('Separate full-resolution model.stl and supports.stl are required.');
const modelBytes=await readFile(modelPath),supportBytes=await readFile(supportPath);
for(const [file,bytes]of [[modelPath,modelBytes],[supportPath,supportBytes]]){
  const recorded=specimen.meshes?.find(m=>m.path===file);
  if(recorded?.sha256&&recorded.sha256!==hash(bytes))throw Error(`Geometry changed since plate assembly: ${file}`);
}
if(summary.originalGeometryIntegrity?.modelStlSha256!==hash(modelBytes))throw Error('Candidate original model does not match its integrity record.');
const gcodePath=path.resolve(args.gcode),gcodeBytes=await readFile(gcodePath);
const output=path.resolve(args.out??path.join(path.dirname(manifestPath),'custom-island-audit.json'));
const inputSnapshot=path.join(path.dirname(output),`custom-audit-input-${hash(gcodeBytes).slice(0,16)}.gcode.gz`);
await writeFile(inputSnapshot,gzipSync(gcodeBytes));
const labelIds=gcodeBytes.subarray(0,20000).toString().match(/; model label id:\s*([\d,]+)/)?.[1].split(',');
const objectId=labelIds?.[specimen.assemblyIndex-1];
if(!objectId)throw Error('Cannot resolve custom specimen object ID from the G-code header.');
const chunks=[];let active=new Float64Array(9*32768),used=0,count=0,nativeSegments=0;
const parser=new GcodeParser(s=>{
  if(s.objectId!==objectId||s.role==='Custom')return;
  if(Math.abs(s.a[2]-s.b[2])>1e-4)throw Error('Nonplanar extrusion inside the specimen is unsupported.');
  if(!(s.width>0&&s.height>0))throw Error('Extrusion lacks explicit width or height.');
  const native=/^support(?:\s|$)/i.test(s.role);
  if(native){nativeSegments++;return;}
  if(used===active.length){chunks.push(active);active=new Float64Array(9*32768);used=0;}
  active.set([s.b[2],s.a[0],s.a[1],s.b[0],s.b[1],s.width,s.height,s.line,0],used);used+=9;count++;
});
// Parse the exact bytes whose hash and compressed snapshot are retained. The
// slicer may overwrite its output path while a long geometry audit is running.
for await(const line of createInterface({input:Readable.from(gcodeBytes),crlfDelay:Infinity}))parser.feed(line);
if(parser.errors.length)throw Error(JSON.stringify(parser.errors));
if(!count)throw Error('The custom specimen has no emitted ordinary-mesh paths.');
chunks.push(active.subarray(0,used));
const segmentBytes=Buffer.concat(chunks.map(c=>Buffer.from(c.buffer,c.byteOffset,c.byteLength)));
const mf=await Module();mf.setup();py.registerJsModule('manifold_js',{api:mf});await py.loadPackage(['scipy']);
for(const f of ['networkx-3.4.2-py3-none-any.whl','arbor-engine.zip','trimesh-5.1.1-py3-none-any.whl'])py.unpackArchive(new Uint8Array(await readFile('public/runtime/'+f)),'zip',{extractDir:'/engine'});
for(const [name,bytes]of [['model',modelBytes],['support',supportBytes]]){
  const g=new STLLoader().parse(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));
  py.FS.writeFile('/'+name+'.positions',new Uint8Array(g.attributes.position.array.buffer));
}
py.FS.writeFile('/segments.f64',segmentBytes);
const first=Number(parser.config.initial_layer_print_height??parser.config.first_layer_height??.10),regular=Number(parser.config.layer_height??.06);
py.globals.set('audit_self_test',false);py.globals.set('plate_translation_json',JSON.stringify(specimen.translation));
py.globals.set('first_model_layer_height',first);py.globals.set('regular_model_layer_height',regular);
py.globals.set('summary_json',JSON.stringify(summary));
py.globals.set('cap_contact_filter_json',JSON.stringify(args['cap-contacts']?String(args['cap-contacts']).split(',').map(Number):null));
console.log(`Auditing ${specimen.id}, object ${objectId}: ${count} ordinary-mesh extrusion segments.`);
const audit=JSON.parse(await py.runPythonAsync(helpers));
for(const tip of audit.contact_tip_necks)for(const observation of tip.cap_same_layer_overlap_observations??[]){
  if(!observation.svg)continue;
  observation.svgPath=path.join(path.dirname(output),`contact-${tip.contact_id}-z-${observation.extrusion_z_mm.toFixed(2)}.svg`);
  await writeFile(observation.svgPath,observation.svg);delete observation.svg;
}
for(const flag of audit.inspectionFlags)for(const observation of flag.cap_same_layer_overlap_observations??[])delete observation.svg;
const report={schemaVersion:1,createdAt:new Date().toISOString(),specimenId:specimen.id,objectId,sourceManifestPath:manifestPath,sourceManifestSha256:hash(manifestBytes),gcodePath,gcodeSha256:hash(gcodeBytes),gcodeInputGzipSnapshot:inputSnapshot,originalModelPath:modelPath,originalModelSha256:hash(modelBytes),supportPath,supportSha256:hash(supportBytes),candidateSummarySha256:hash(summaryBytes),plateTranslationMm:specimen.translation,modelSliceSchedule:{firstLayerMm:first,regularLayerMm:regular},nativeSupportSegmentsExcluded:nativeSegments,scope:'Actual ordinary-mesh extrusion witnesses for original-model component starts, planned contact necks and on-model root necks. Limited digital inspection; not exhaustive overhang coverage or physical validation.',method:['Use original full-resolution model and separate custom-support solid at fixed model-layer midplanes. Bridge bead HEIGHT is not used as slice thickness.','Clip each emitted centerline to the intended solid section with 0.001 mm tolerance, then subtract the other solid section expanded by 0.005 mm. Ambiguous pieces are reported and excluded. The same emitted centerline fragment cannot serve as both original model and custom support.','Track original section ancestry on every fixed layer. Inspect the first actual centerline emission of at least 0.015 mm for every component without an already printed ancestor, including tiny geometry whose printing begins later.','Construct nominal-width bead footprints only from classified centerline fragments. A start witness intersects the original start section, its classified emitted footprint, and an earlier classified custom-support bead footprint.','Independently inspect each planned model-root neck and routed tip neck for exclusive-support emitted paths; inspect model-root beginnings for earlier exclusive-original-model bead footprints.','Inspect actual same-layer nominal model/support bead overlap and ambiguously assigned cap paths near every routed contact for fusion/removal risk.'],limitations:['Nominal bead footprints and layer-envelope gaps are not measured physical bead shapes or air gaps.','The nearest 5% overlap screen is deliberately an inspection flag, not an empirically calibrated success threshold; wider lower witnesses are reported separately.','Connected overhangs, all bridge endpoints, support strength, cooling, adhesion and removability require further inspection or a real print.','Coincident original/support geometry is ambiguous and excluded from ownership evidence. On-model roots can intentionally touch the miniature and may leave marks.'],...audit};
if(nativeSegments)report.inspectionFlags.push({kind:'unexpected-native-support',causes:[`${nativeSegments} native support-role segments exist for the custom specimen.`]});
report.summary.inspectionFlags=report.inspectionFlags.length;
report.digitalStatus=report.inspectionFlags.length?'limited-custom-witness-audit-with-inspection-flags':'limited-custom-witness-audit-no-screen-flags';
if(args['cap-contacts']){
  report.scope='Selected routed tip caps only: emitted footprint overlap and geometry ownership inspection. Original component starts and model-root foundations are not checked in this diagnostic mode.';
  report.digitalStatus='selected-contact-inspection-only';
}
await writeFile(output,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({output,...report.summary,inspectionFlags:report.inspectionFlags},null,2));
