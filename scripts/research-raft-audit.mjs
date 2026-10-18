/** Final emitted-path audit of the matched cage fixtures. Geometry is read-only. */
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createInterface} from 'node:readline';
import {Readable} from 'node:stream';
import {gzipSync} from 'node:zlib';
import path from 'node:path';
import {loadPyodide} from 'pyodide';
import Module from 'manifold-3d';
import {STLLoader} from 'three/examples/jsm/loaders/STLLoader.js';
import {GcodeParser} from './research-toolpaths.mjs';

const args={};for(let i=2;i<process.argv.length;i+=2)args[process.argv[i].replace(/^--/,'')]=process.argv[i+1];
const equivalenceOnly=args.mode==='equivalence';
const padOnly=args.mode==='pad';
const hash=b=>createHash('sha256').update(b).digest('hex');
if(args.reconcile){
  if(!args['pad-report']||!args.out)throw Error('--pad-report and --out required');
  const priorBytes=await readFile(args.reconcile),prior=JSON.parse(priorBytes),padBytes=await readFile(args['pad-report']),pad=JSON.parse(padBytes);
  if(prior.auditMode!=='full-fixture-audit'||pad.auditMode!=='pad-topology-only'||!pad.passed||pad.flags.length)throw Error('Complete prior audit and passing bounded pad proof required');
  for(const field of ['gcodeSha256','sourceManifestSha256'])if(prior[field]!==pad[field])throw Error('Pad proof input mismatch: '+field);
  if(prior.methodSourceSha256.customIslands!==pad.methodSourceSha256.customIslands)throw Error('Shared contact/start method changed');
  const resolved=[];
  for(const variant of prior.variants){
    const correction=pad.variants.find(v=>v.id===variant.id),expected=variant.id==='R0'?1:2;
    if(!correction||!correction.passed||correction.sourceSummarySha256!==variant.sourceSummarySha256||JSON.stringify(correction.meshHashes)!==JSON.stringify(variant.meshHashes))throw Error('Fixture input mismatch');
    const before=variant.fixture.padLayers,after=correction.fixture.padLayers;
    if(before.length!==after.length||after.some(p=>p.connectedPadGroups!==expected))throw Error('Incomplete pad group proof');
    for(let i=0;i<before.length;i++){
      if(before[i].layer!==after[i].layer||before[i].components!==after[i].components||before[i].areasMm2.some((v,j)=>Math.abs(v-after[i].areasMm2[j])>1e-8))throw Error('Recomputed pad footprint changed');
    }
    if(variant.id==='R1'&&correction.fixture.summary.minimumEmittedRaftSeamMm<.3)throw Error('Emitted seam failed');
    for(const flag of variant.flags){
      if(flag.kind!=='pad-component-count')throw Error('An unrelated full-audit flag remains');
      const row=after.find(p=>p.layer===flag.layer),detail=correction.fixture.padFragmentDetails.find(p=>p.layer===flag.layer);
      if(!row||row.components!==flag.observed||row.connectedPadGroups!==flag.expected||!detail||detail.fragments.length!==flag.observed||detail.fragments.some(p=>p.rootGroups.length!==1||p.precedingLayerOverlapMm2<=1e-8))throw Error('Flag lacks actual preceding-layer bonding proof');
      resolved.push({specimen:variant.id,...flag,disposition:'Separate nominal bead fragments in this horizontal top-skin layer are bonded to the same existing pad beneath; actual grounded 3D group count is correct.',connectedPadGroups:row.connectedPadGroups,precedingLayerOverlapFractions:detail.fragments.map(p=>p.precedingLayerOverlapFraction)});
    }
    variant.originalInspectionFlags=variant.flags;
    variant.flags=[];variant.passed=true;
    variant.fixture.flags=[];variant.fixture.passed=true;
    variant.fixture.padLayers=after;variant.fixture.padFragmentDetails=correction.fixture.padFragmentDetails;
    variant.fixture.summary.minimumEmittedRaftSeamMm=correction.fixture.summary.minimumEmittedRaftSeamMm;
  }
  const priorSnapshot=path.join(path.dirname(path.resolve(args.out)),'raft-complete-prior-'+hash(priorBytes).slice(0,16)+'.json');await writeFile(priorSnapshot,priorBytes);
  prior.createdAt=new Date().toISOString();prior.auditMode='full-fixture-audit-with-pad-topology-correction';prior.passed=true;prior.flags=[];prior.resolvedInspectionFlags=resolved;
  prior.padTopologyCorrection={priorCompleteAuditPath:priorSnapshot,priorCompleteAuditSha256:hash(priorBytes),boundedPadAuditPath:path.resolve(args['pad-report']),boundedPadAuditSha256:hash(padBytes),methodSourceSha256:pad.methodSourceSha256,statement:'All upper-support ancestry, model starts, tip gaps and full base/foot foundations are retained from the complete audit. Only the invalid one-2D-polygon-per-pad-layer screen is replaced by actual bonded 3D pad groups, recomputed for every pad layer from identical bead footprints. Numerical gap, overlap and connectivity tolerances are unchanged.'};
  await writeFile(args.out,JSON.stringify(prior,null,2)+'\n');
  console.log(JSON.stringify({output:path.resolve(args.out),passed:true,gcodeSha256:prior.gcodeSha256,resolvedInspectionFlags:resolved,variants:prior.variants.map(v=>({id:v.id,summary:v.fixture.summary}))},null,2));
  process.exit(0);
}
if(args.merge){
  if(!args.out)throw Error('--out required for merge');
  const inputs=await Promise.all(args.merge.split(',').map(async file=>{const bytes=await readFile(file);return {path:path.resolve(file),sha256:hash(bytes),report:JSON.parse(bytes)};}));
  if(inputs.length!==2)throw Error('Exactly two independent fixture reports required');
  const a=inputs[0].report,b=inputs[1].report;
  for(const field of ['gcodeSha256','sourceManifestSha256','sourceManifestPath'])if(a[field]!==b[field])throw Error('Mismatched audit inputs: '+field);
  if(JSON.stringify(a.methodSourceSha256)!==JSON.stringify(b.methodSourceSha256))throw Error('Mismatched audit methods');
  if(inputs.some(x=>x.report.auditMode!=='partial-fixture-audit'))throw Error('Only complete per-fixture audits can be merged');
  const variants=inputs.flatMap(x=>x.report.variants).sort((x,y)=>x.id.localeCompare(y.id));
  if(variants.map(v=>v.id).join(',')!=='R0,R1')throw Error('Both unique R0/R1 proofs required');
  const flags=variants.flatMap(v=>v.flags.map(f=>({specimen:v.id,...f})));
  const result={...a,createdAt:new Date().toISOString(),auditMode:'full-fixture-audit',specimenIds:['R0','R1'],variants,flags,passed:variants.every(v=>v.passed)&&flags.length===0,mergedFrom:inputs.map(({path,sha256})=>({path,sha256}))};
  await writeFile(args.out,JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify({output:path.resolve(args.out),passed:result.passed,flags,variants:variants.map(v=>({id:v.id,summary:v.fixture.summary}))},null,2));
  process.exit(result.passed?0:2);
}
if(!args.manifest||!args.gcode)throw Error('--manifest and --gcode required');
const manifestPath=path.resolve(args.manifest),manifestBytes=await readFile(manifestPath),manifest=JSON.parse(manifestBytes);
const gcodePath=path.resolve(args.gcode),gcode=await readFile(gcodePath),output=path.resolve(args.out??path.join(path.dirname(manifestPath),'raft-audit.json'));
const manifestSnapshot=path.join(path.dirname(output),'raft-audit-manifest-'+hash(manifestBytes).slice(0,16)+'.json');
await writeFile(manifestSnapshot,manifestBytes);
const labels=gcode.subarray(0,20000).toString().match(/; model label id:\s*([\d,]+)/)?.[1].split(',');
if(labels?.length!==manifest.specimens.length)throw Error('G-code object inventory does not match plate manifest');
const requestedIds=args.specimens?args.specimens.split(','):['R0','R1'];
if(!requestedIds.length||requestedIds.some(id=>!['R0','R1'].includes(id))||new Set(requestedIds).size!==requestedIds.length)throw Error('Only R0/R1 fixture IDs are supported');
const entries=manifest.specimens.filter(s=>requestedIds.includes(s.id));
if(entries.length!==requestedIds.length)throw Error('Requested fixture missing');
const maps=new Map(entries.map(s=>[labels?.[s.assemblyIndex-1],{spec:s,rows:[],native:0,lowRows:[]}]));
for(const entry of maps.values())entry.sourceSummary=JSON.parse(await readFile(entry.spec.fixtureSummary,'utf8'));
if(maps.has(undefined))throw Error('Missing fixture object ID');
const parser=new GcodeParser(s=>{
  if(s.width>0&&s.height>0&&Math.abs(s.a[2]-s.b[2])<.0001){
    for(const entry of maps.values()){
      const t=entry.spec.translation,b=entry.sourceSummary.fixture.supportBoundsBed;
      if(s.b[2]<=entry.sourceSummary.fixture.raftTopBedZ+t[2]+.06&&s.b[2]>0&&Math.min(s.a[0],s.b[0])<=b[1][0]+t[0]+2&&Math.max(s.a[0],s.b[0])>=b[0][0]+t[0]-2&&Math.min(s.a[1],s.b[1])<=b[1][1]+t[1]+2&&Math.max(s.a[1],s.b[1])>=b[0][1]+t[1]-2)
        entry.lowRows.push(s.b[2],s.a[0],s.a[1],s.b[0],s.b[1],s.width,s.height,s.line,0);
    }
  }
  const entry=maps.get(s.objectId);if(!entry||s.role==='Custom')return;if(/^support(?:\s|$)/i.test(s.role)){entry.native++;return;}if(!(s.width>0&&s.height>0)||Math.abs(s.a[2]-s.b[2])>.0001)throw Error('Invalid ordinary fixture extrusion');entry.rows.push(s.b[2],s.a[0],s.a[1],s.b[0],s.b[1],s.width,s.height,s.line,0);
});
for await(const line of createInterface({input:Readable.from(gcode),crlfDelay:Infinity}))parser.feed(line);
if(parser.errors.length)throw Error(JSON.stringify(parser.errors));
const mf=await Module();mf.setup();
const py=await loadPyodide({indexURL:path.resolve('public/runtime')+'/'});py.registerJsModule('manifold_js',{api:mf});
await py.loadPackage(['numpy','scipy','shapely']);
for(const f of ['networkx-3.4.2-py3-none-any.whl','arbor-engine.zip','trimesh-5.1.1-py3-none-any.whl'])py.unpackArchive(new Uint8Array(await readFile('public/runtime/'+f)),'zip',{extractDir:'/engine'});
const commonSource=await readFile('scripts/research-custom-islands.py','utf8');
await py.runPythonAsync(commonSource.slice(0,commonSource.lastIndexOf('\nself_test() if audit_self_test')));
const fixtureSource=await readFile(new URL('./research-raft-audit.py',import.meta.url),'utf8');
await py.runPythonAsync(fixtureSource);
py.globals.set('fixture_equivalence_only',equivalenceOnly);
py.globals.set('fixture_pad_only',padOnly);
const variants=[];
for(const [objectId,entry]of maps){
  const spec=entry.spec,summaryBytes=await readFile(spec.fixtureSummary),summary=JSON.parse(summaryBytes),meshHashes={};
  for(const name of ['model','support']){
    const file=spec.files.find(f=>path.basename(f)===(name==='support'?'supports.stl':'model.stl')),bytes=await readFile(file);
    if(spec.meshes?.find(m=>m.path===file)?.sha256!==hash(bytes))throw Error('Fixture mesh changed after assembly: '+file);
    if(name==='model'&&summary.originalGeometryIntegrity.modelStlSha256!==hash(bytes))throw Error('Original fixture changed');
    meshHashes[name]=hash(bytes);const geom=new STLLoader().parse(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));
    py.FS.writeFile('/'+name+'.positions',new Uint8Array(geom.attributes.position.array.buffer));
  }
  py.FS.writeFile('/segments.f64',new Uint8Array(new Float64Array(entry.rows).buffer));
  py.FS.writeFile('/low-segments.f64',new Uint8Array(new Float64Array(entry.lowRows).buffer));
  py.globals.set('plate_translation_json',JSON.stringify(spec.translation));py.globals.set('summary_json',JSON.stringify(summary));
  py.globals.set('cap_contact_filter_json','null');py.globals.set('first_model_layer_height',Number(parser.config.initial_layer_print_height??.1));py.globals.set('regular_model_layer_height',Number(parser.config.layer_height??.06));
  console.log('Auditing '+spec.id+' actual component starts, caps, pad seam and support ancestry');
  let custom,fixture;
  try{custom=equivalenceOnly||padOnly?{summary:{diagnosticOnly:true},inspectionFlags:[]}:JSON.parse(await py.runPythonAsync('run_audit()'));console.log(spec.id+' shared start/cap audit finished: '+JSON.stringify(custom.summary));if(!equivalenceOnly&&!padOnly)await writeFile(output+'.'+spec.id+'.custom.json',JSON.stringify(custom,null,2));fixture=JSON.parse(await py.runPythonAsync('run_fixture_audit()'));console.log(spec.id+' fixture ancestry finished');}
  catch(error){console.error(error.message);process.exit(1);}
  const flags=[...custom.inspectionFlags,...fixture.flags];if(entry.native)flags.push({kind:'unexpected-native-support',segments:entry.native});
  variants.push({id:spec.id,objectId,sourceSummarySha256:hash(summaryBytes),meshHashes,ordinarySegments:entry.rows.length/9,nativeSegments:entry.native,custom,fixture,flags,passed:flags.length===0});
  if(!equivalenceOnly)await writeFile(output+'.'+spec.id+'.variant.json',JSON.stringify(variants.at(-1),null,2)+'\n');
}
const snapshot=path.join(path.dirname(output),'raft-audit-input-'+hash(gcode).slice(0,16)+'.gcode.gz');await writeFile(snapshot,gzipSync(gcode));
const report={schemaVersion:1,createdAt:new Date().toISOString(),passed:variants.every(v=>v.passed),specimenIds:variants.map(v=>v.id),flags:variants.flatMap(v=>v.flags.map(f=>({specimen:v.id,...f}))),sourceManifestPath:manifestPath,sourceManifestSha256:hash(manifestBytes),gcodePath,gcodeSha256:hash(gcode),gcodeInputGzipSnapshot:snapshot,methodSourceSha256:{customIslands:hash(commonSource),fixture:hash(fixtureSource)},variants,scope:'Actual original component starts, tip necks, nominal model/support gap, full base foundation, pad separation and layer-to-layer support-bead ancestry. Physical removal remains untested.',knownLimits:['This controlled cage permits axial escape once its contacts and modelbase release; it tests pad peel/flexibility and cage handling, not mechanically trapped cavity extraction.','The bent seam preserves the entire modelbase foundation, so one half retains the central base peel.','R1 combines a pad seam and omission of reconnecting cross-half braces; the print does not isolate those changes.'],limitations:['Nominal bead footprints use commanded width; actual bead squish and cooling are unknown.','Support footprint ancestry proves prior-layer geometric attachment, not adequate bond strength or cooling.','3 micrometre connectivity tolerance accounts for rounded G-code coordinates and arc chord approximation.']};
report.auditMode=equivalenceOnly?'buffer-equivalence-only':padOnly?'pad-topology-only':entries.length===2?'full-fixture-audit':'partial-fixture-audit';
report.sourceManifestSnapshot=manifestSnapshot;
if(equivalenceOnly)report.scope='Three selected layers per fixture only: equivalence of cached and uncached section-buffer arithmetic. Does not establish print readiness.';
if(padOnly)report.scope='All pad layers only: actual bead ancestry through the pad, including fragmented top skin and any unclassified paths reconnecting the groups. Combine with a matching full audit for upper supports and model contacts.';
await writeFile(output,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({output,passed:report.passed,flags:report.flags,variants:variants.map(v=>({id:v.id,summary:v.custom.summary,fixture:v.fixture.summary}))},null,2));
if(!report.passed)process.exitCode=2;
