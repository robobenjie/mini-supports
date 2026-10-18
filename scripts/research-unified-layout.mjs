/** Recombine the saved support experiments without changing their source geometry.
 * Usage: node scripts/research-unified-layout.mjs --raft-manifest private-fixtures.json
 *   --out test-results/research/unified-print-kit
 * All manifests with private paths and generated geometry remain under test-results/.
 */
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {buildResearchPlate} from './research-layout.mjs';

const args=process.argv.slice(2), options={};
for(let i=0;i<args.length;i+=2)options[args[i].replace(/^--/,'')]=args[i+1];
if(!options['raft-manifest'])throw Error('Required --raft-manifest with R0 and R1 specimens.');
const out=path.resolve(options.out??'test-results/research/unified-print-kit');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const requireCondition=(condition,message)=>{if(!condition)throw Error(message)};
const previousKits=['print-kit','spore-print-kit'];
const specimens=new Map(), provenance=[];
const obsoleteLayoutKeys=['meshes','min','max','geometryBounds','width','height','assemblyIndex','translation','plateBounds','plateContacts'];

for(const kit of previousKits){
  const manifestPath=path.resolve(`test-results/research/${kit}/plate-manifest.json`);
  const manifestBytes=await readFile(manifestPath), manifest=JSON.parse(manifestBytes);
  const source={kit,manifestPath,sha256:hash(manifestBytes),specimenIds:manifest.specimens.map(s=>s.id)};
  provenance.push(source);
  for(const original of manifest.specimens){
    requireCondition(!specimens.has(original.id),`Duplicate original ID: ${original.id}`);
    for(const mesh of original.meshes){
      requireCondition(hash(await readFile(mesh.path))===mesh.sha256,`Source mesh changed since previous plate: ${mesh.path}`);
    }
    const item=structuredClone(original);
    for(const key of obsoleteLayoutKeys)delete item[key];
    // Reuse the printed label mesh, too. Only new R0/R1 labels need generating.
    item.files=original.meshes.map(m=>m.path);
    item.addLabel=false;
    item.sourcePlateProvenance={...source,originalAssemblyIndex:original.assemblyIndex,
      originalTranslation:original.translation,sourceGeometry:original.meshes,
      originalSettings:original.settings,reusedPrintedLabel:original.addLabel===true};
    specimens.set(item.id,item);
  }
}
requireCondition(specimens.size===23,'Expected the original 21 specimens plus the matched H0/N5 pair.');
const raftManifestPath=path.resolve(options['raft-manifest']);
const raftBytes=await readFile(raftManifestPath), raftManifest=JSON.parse(raftBytes);
requireCondition(raftManifest.specimens?.length===2,'The raft fixture manifest must contain exactly R0 and R1.');
for(const original of raftManifest.specimens){
  requireCondition(['R0','R1'].includes(original.id)&&!specimens.has(original.id),'Unexpected or duplicate raft fixture ID.');
  const item=structuredClone(original);
  for(const key of obsoleteLayoutKeys)delete item[key];
  requireCondition(item.files?.length>=2,`${item.id} requires model and support mesh files.`);
  item.settings={enable_support:'0',...item.settings};
  requireCondition(item.settings.enable_support==='0','Raft fixtures must not receive native supports.');
  item.addLabel=true;
  item.sourcePlateProvenance={kit:'raft-removal-fixture',manifestPath:raftManifestPath,sha256:hash(raftBytes)};
  specimens.set(item.id,item);
}

const rowIds=[
  ['P0A','P1A','P2A','P0B','P1B','P2B','I1','I2'],
  ['N1','N2','A0','A1','A2','A3','A4','N3'],
  ['T1','T2','S0','S1','N4'],
  ['H0','N5','R0','R1'],
];
const spec={title:'A1 0.2 mm — unified support and removal experiment',bed:'Textured PEI Plate',
  margin:12,gap:8,rowGap:10,rows:rowIds.map(row=>row.map(id=>{
    requireCondition(specimens.has(id),`Missing specimen ${id}`);return specimens.get(id);
  }))};
await mkdir(out,{recursive:true});
await writeFile(path.join(out,'layout-spec.json'),JSON.stringify(spec,null,2)+'\n');
const built=await buildResearchPlate(spec,out);
const manifest=JSON.parse(await readFile(built.manifest));
manifest.sourceProvenance=[...provenance,{kit:'raft-removal-fixture',manifestPath:raftManifestPath,sha256:hash(raftBytes),specimenIds:['R0','R1']}];
manifest.study={questions:[
  {id:'contact-gap-and-diameter',specimens:['P0A','P1A','P2A','P0B','P1B','P2B'],comparison:'Crossed nominal gap (0/.06/.12 mm) and point-cap diameter (.26/.36 mm).'},
  {id:'point-versus-interface',specimens:['P1B','I1','P2B','I2'],comparison:'Matched gap and geometry; point contacts versus micro-interface.'},
  {id:'native-coupon-controls',specimens:['P2B','I2','N1','N2'],comparison:'Same model; external contact package versus native tree slim and hybrid.'},
  {id:'tall-support-stability',specimens:['T1','T2'],comparison:'Thin columns versus thicker braced columns; combined structural package.'},
  {id:'arm-algorithm-sweep',specimens:['A0','A1','A2','A3','A4','N3'],comparison:'Legacy, matched analysis layers, gap/crown, stronger structure, contact density and native hybrid.'},
  {id:'spanner-removal-challenge',specimens:['S0','S1','N4'],comparison:'Legacy versus explicit gap versus native hybrid on the same spanner part.'},
  {id:'complete-miniature',specimens:['H0','N5'],comparison:'Same full-resolution miniature and pose; experimental compact supports versus native normal/snug.'},
  {id:'split-raft-removal',specimens:['R0','R1'],comparison:'Same cage fixture and contacts; intact broad pad versus seam-cut pad and separated brace groups.'},
],physicalOutcomesPending:true,replicatesPerVariant:1,
  limits:['One specimen per variant does not quantify print-to-print variability.',
    'XY placement changes; native supports and all actual toolpaths must be checked again after final slicing.',
    'Raft splitting tests the complete seam-and-brace separation behavior, not the seam in isolation.']};

const checks=[];
for(const item of manifest.specimens){
  const source=item.sourcePlateProvenance;
  if(source.sourceGeometry){
    requireCondition(item.meshes.length===source.sourceGeometry.length,`Volume count changed for ${item.id}`);
    for(let i=0;i<item.meshes.length;i++){
      const actual=item.meshes[i],expected=source.sourceGeometry[i];
      requireCondition(actual.path===expected.path&&actual.sha256===expected.sha256&&actual.triangles===expected.triangles,`Source geometry changed for ${item.id}`);
    }
    requireCondition(JSON.stringify(item.settings)===JSON.stringify(source.originalSettings),`Original settings changed for ${item.id}`);
  }
  requireCondition(item.translation[2]===0,`Z was changed for ${item.id}`);
  requireCondition(item.plateBounds.min.slice(0,2).every(n=>n>=12)&&item.plateBounds.max.slice(0,2).every(n=>n<=244),`Insufficient bed margin for ${item.id}`);
  checks.push({id:item.id,sourceMeshesUnchanged:!!source.sourceGeometry,zUnchanged:true,
    originalSettingsUnchanged:!!source.originalSettings,nativeSupportReserveMm:item.reserveMm??0});
}
for(let i=0;i<manifest.specimens.length;i++)for(let j=i+1;j<manifest.specimens.length;j++){
  const a=manifest.specimens[i],b=manifest.specimens[j];
  const overlaps=[0,1].every(d=>a.plateBounds.min[d]<b.plateBounds.max[d]&&b.plateBounds.min[d]<a.plateBounds.max[d]);
  requireCondition(!overlaps,`Reserved plate envelopes overlap: ${a.id}/${b.id}`);
}
manifest.layoutValidation={checkedAt:new Date().toISOString(),specimenCount:manifest.specimens.length,
  dimensionsMm:built.dimensions,minimumBedMarginMm:12,betweenSpecimensMm:8,betweenRowsMm:10,
  sourceGeometryAndSettingsPreserved:23,zPreserved:25,reservedEnvelopesDisjoint:true,checks};
await writeFile(built.manifest,JSON.stringify(manifest,null,2)+'\n');
await writeFile(path.join(out,'layout-result.json'),JSON.stringify({...built,validation:manifest.layoutValidation},null,2)+'\n');
console.log(JSON.stringify({...built,sourceGeometryAndSettingsPreserved:23,zPreserved:25},null,2));
