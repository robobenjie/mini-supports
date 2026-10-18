/** Append the Y-braced T3 coupon while retaining every existing specimen pose. */
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {STLLoader} from 'three/addons/loaders/STLLoader.js';
const dir=path.resolve(process.argv[2]??'test-results/research/unified-print-kit');
const baselineDir=path.join(dir,'prior-25-layout');await mkdir(baselineDir,{recursive:true});
const hash=b=>createHash('sha256').update(b).digest('hex');
const current=JSON.parse(await readFile(path.join(dir,'plate-manifest.json')));
if(current.specimens.length===25){
  for(const name of ['assemble.json','plate-manifest.json','plate-map.svg'])
    await writeFile(path.join(baselineDir,name),await readFile(path.join(dir,name)),{flag:'wx'});
}
const baselineBytes=await readFile(path.join(baselineDir,'plate-manifest.json'));
const manifest=JSON.parse(baselineBytes),assembly=JSON.parse(await readFile(path.join(baselineDir,'assemble.json')));
if(manifest.specimens.length!==25||manifest.specimens.some(s=>s.id==='T3'))throw Error('Expected a frozen 25-specimen baseline.');
const t2=manifest.specimens.find(s=>s.id==='T2');
const reportPath=path.join(dir,'stability-T3/geometry-validation.json'),reportBytes=await readFile(reportPath),report=JSON.parse(reportBytes);
if(report.geometryGate!=='pass'||report.addedYZBraceCount!==6||report.retainedXZBraceCount!==4||report.supportSelfSliceRegions.length)throw Error('T3 geometry checks failed.');
if(report.hashes.model!==t2.meshes.find(m=>path.basename(m.path)==='model.stl').sha256)throw Error('T3 model differs from T2.');
const loader=new STLLoader(),meshes=[];
for(const [key,file]of Object.entries(report.files)){
  const data=await readFile(file);if(hash(data)!==report.hashes[key])throw Error('T3 mesh changed after checks.');
  const g=loader.parse(data.buffer.slice(data.byteOffset,data.byteOffset+data.byteLength));g.computeBoundingBox();
  meshes.push({path:file,sha256:hash(data),triangles:g.attributes.position.count/3,min:g.boundingBox.min.toArray(),max:g.boundingBox.max.toArray()});g.dispose();
}
const min=[0,1,2].map(d=>Math.min(...meshes.map(m=>m.min[d]))),max=[0,1,2].map(d=>Math.max(...meshes.map(m=>m.max[d])));
// Unused space behind T2 accepts a 24 x 18 mm pad with 7 mm clearances.
const translation=[t2.translation[0],t2.plateBounds.max[1]+7-min[1],0];
const plateBounds={min:min.map((v,d)=>v+translation[d]),max:max.map((v,d)=>v+translation[d])};
const contacts=structuredClone(t2.contacts),settings={enable_support:'0'};
const item={id:'T3',label:'T2 plus Y lateral braces',files:meshes.map(m=>m.path),addLabel:false,contacts,
  geometryGate:report.geometryGate,settings,meshes,min,max,geometryBounds:{min:[...min],max:[...max]},
  width:max[0]-min[0],height:max[1]-min[1],assemblyIndex:26,translation,plateBounds,
  plateContacts:contacts.map(c=>({...c,xy_mm:c.xy_mm.map((v,d)=>v+translation[d])})),
  stabilitySummary:reportPath,
  sourcePlateProvenance:{kit:'matched-T2-Y-brace-extension',manifestPath:reportPath,sha256:hash(reportBytes),
    matchedSpecimen:'T2',sourceModelSha256:report.source.modelSha256,sourceSupportSha256:report.source.supportsSha256},
  study:{question:'Does lateral Y bracing reduce bed-axis sway compared with the same XZ-braced support columns?',
    fixed:'Original model, contact gaps and caps, 1.8 mm columns, existing XZ braces and pad dimensions.',
    difference:'Six additional 1.0 mm YZ braces rooted in the pad and joined at z23 mm; raised identifier T3.',
    limit:'Additional bracing also adds material; this does not isolate equal-mass redistribution or prove an inertia model.'}};
let minimumClearance=Infinity;
for(const old of manifest.specimens){
  const delta=[0,1].map(d=>Math.max(old.plateBounds.min[d]-plateBounds.max[d],plateBounds.min[d]-old.plateBounds.max[d],0));
  const distance=Math.hypot(...delta);minimumClearance=Math.min(minimumClearance,distance);
  if(distance<7-1e-7)throw Error(`Insufficient T3 clearance from ${old.id}: ${distance}`);
}
if(plateBounds.min.slice(0,2).some(n=>n<12)||plateBounds.max.slice(0,2).some(n=>n>244))throw Error('T3 exceeds usable bed.');
for(const mesh of meshes)assembly.plates[0].objects.push({path:mesh.path,count:1,filaments:[1],assemble_index:[26],pos_x:[translation[0]],pos_y:[translation[1]],pos_z:[0],print_params:{}});
assembly.plates[0].assembled_params.push({assemble_index:26,print_params:settings});
manifest.specimens.push(item);
manifest.sourceProvenance.push({kit:'matched-T2-Y-brace-extension',manifestPath:reportPath,sha256:hash(reportBytes),specimenIds:['T3']});
manifest.study.questions.push({id:'bed-Y-lateral-stability',specimens:['T2','T3'],comparison:item.study.question});
manifest.layoutValidation={...manifest.layoutValidation,specimenCount:26,zPreserved:26,
  checks:[...manifest.layoutValidation.checks,{id:'T3',matchedT2ModelUnchanged:true,zUnchanged:true,nativeSupportReserveMm:0}],
  minimumActualSpecimenClearanceMm:minimumClearance,
  appendedT3:{priorManifest:path.join(baselineDir,'plate-manifest.json'),priorManifestSha256:hash(baselineBytes),
    unchangedExistingSpecimenPoses:25,translation,bounds:plateBounds,geometryReport:reportPath,geometryReportSha256:hash(reportBytes)}};
const pad=30,s=640/256,X=pad+plateBounds.min[0]*s,Y=pad+(256-plateBounds.max[1])*s,W=24*s,H=18*s;
const map=(await readFile(path.join(baselineDir,'plate-map.svg'),'utf8')).replace('</svg>',`<g><rect x="${X}" y="${Y}" width="${W}" height="${H}" rx="4" fill="#dbe9d6" stroke="#758773"/><text x="${X+W/2}" y="${Y+H/2}" text-anchor="middle" dominant-baseline="middle" font-family="sans-serif" font-size="15" fill="#17271d">T3</text></g></svg>`);
for(const [name,data]of [['plate-manifest.json',JSON.stringify(manifest,null,2)+'\n'],['assemble.json',JSON.stringify(assembly,null,2)+'\n'],['plate-map.svg',map]])await writeFile(path.join(dir,name),data);
console.log(JSON.stringify({specimens:26,volumes:manifest.specimens.reduce((n,s)=>n+s.meshes.length,0),originals:manifest.specimens.filter(s=>s.meshes.some(m=>path.basename(m.path)==='model.stl')).length,minimumClearance,translation,unchangedExistingPoses:25,assembly:path.join(dir,'assemble.json')},null,2));
