/** Offline, streaming audit of Bambu extrusion paths against the synthetic coupon geometry.
 * node scripts/research-toolpaths.mjs --gcode plate_1.gcode --manifest plate-manifest.json --out audit
 * node scripts/research-toolpaths.mjs --self-test
 * This checks emitted paths. It cannot establish adhesion, sag, removability, or physical success.
 */
import {createReadStream} from 'node:fs';
import {readFile, writeFile, mkdir, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const EPS=1e-6, round=n=>Number.isFinite(n)?+n.toFixed(5):null;
const supportRole=r=>/^support(?:\s|$)/i.test(r);
const zKey=z=>(Math.round(z*100000)/100000).toFixed(5);
const point=(a,b,t)=>a.map((v,i)=>v+(b[i]-v)*t);
const len2=(a,b)=>Math.hypot(b[0]-a[0],b[1]-a[1]);

/** Motion state includes physical XYZ separately from G92's logical coordinate frame. */
export class GcodeParser {
  constructor(onSegment){
    this.onSegment=onSegment;this.xyz=[0,0,0];this.offset=[0,0,0];this.e=0;
    this.relativeXYZ=false;this.relativeE=false;this.absoluteArcCenter=false;this.plane=17;
    this.role='Custom';this.height=null;this.width=null;this.layerZ=null;this.objectId=null;
    this.line=0;this.config={};this.header={};this.layers=new Map();this.errors=[];
    this.stats={lines:0,extruding_moves:0,linear_segments:0,arc_moves:0,arc_segments:0,nonplanar_extruding_moves:0,physical_vs_comment_z_mismatches:0};
  }
  error(message){if(this.errors.length<100)this.errors.push({line:this.line,message});}
  feed(raw){
    this.line++;this.stats.lines++;
    const semi=raw.indexOf(';'), comment=semi>=0?raw.slice(semi+1).trim():'';
    let m;
    if((m=comment.match(/^(?:FEATURE|TYPE):\s*(.*)/)))this.role=m[1].trim();
    if((m=comment.match(/^(?:LAYER_HEIGHT|HEIGHT):\s*([\d.]+)/)))this.height=+m[1];
    if((m=comment.match(/^(?:Z_HEIGHT|Z):\s*([-\d.]+)/)))this.layerZ=+m[1];
    if((m=comment.match(/^(?:LINE_WIDTH|WIDTH):\s*([\d.]+)/)))this.width=+m[1];
    if((m=comment.match(/^(?:OBJECT_ID:|start printing object, unique label id:)\s*(\d+)/)))this.objectId=m[1];
    if(/^stop printing object/.test(comment))this.objectId=null;
    if((m=comment.match(/^([a-z_]+) = (.{0,150})$/)))this.config[m[1]]=m[2];
    if((m=comment.match(/^(model printing time|total layer number|total filament weight \[g\]|total filament length \[mm\])\s*:\s*(.*)/)))this.header[m[1]]=m[2];
    const code=(semi>=0?raw.slice(0,semi):raw).replace(/\([^)]*\)/g,'').trim();
    if(!code)return;
    const command=code.match(/^(?:N\d+\s+)?([GM]\d+(?:\.\d+)?)/i)?.[1]?.toUpperCase();
    if(!command)return;
    const values={};for(const word of code.matchAll(/([XYZEFIJKRP])\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/gi))values[word[1].toUpperCase()]=+word[2];
    if(command==='G90'){this.relativeXYZ=false;this.relativeE=false;return;}
    if(command==='G91'){this.relativeXYZ=true;this.relativeE=true;return;}
    if(command==='M82'){this.relativeE=false;return;}
    if(command==='M83'){this.relativeE=true;return;}
    if(command==='G90.1'){this.absoluteArcCenter=true;return;}
    if(command==='G91.1'){this.absoluteArcCenter=false;return;}
    if(['G17','G18','G19'].includes(command)){this.plane=+command.slice(1);return;}
    if(command==='G20'){this.error('Inch-unit motion is unsupported.');return;}
    if(command==='G92'){
      for(let i=0;i<3;i++){const value=values['XYZ'[i]];if(value!==undefined)this.offset[i]=this.xyz[i]-value;}
      if(values.E!==undefined)this.e=values.E;return;
    }
    if(!['G0','G00','G1','G01','G2','G02','G3','G03'].includes(command))return;
    const start=[...this.xyz],end=start.map((v,i)=>values['XYZ'[i]]===undefined?v:this.relativeXYZ?v+values['XYZ'[i]]:values['XYZ'[i]]+this.offset[i]);
    let deltaE=0;if(values.E!==undefined){deltaE=this.relativeE?values.E:values.E-this.e;this.e=this.relativeE?this.e+values.E:values.E;}
    this.xyz=end;
    if(deltaE<=EPS)return;
    const arc=+command.slice(1)>=2;
    if(!arc&&len2(start,end)<EPS)return; // Unretracting in place deposits no measurable XY path.
    this.stats.extruding_moves++;
    if(Math.abs(start[2]-end[2])>.001)this.stats.nonplanar_extruding_moves++;
    const common={role:this.role,height:this.height,width:this.width,layerZ:this.layerZ,objectId:this.objectId,line:this.line};
    if(this.layerZ!==null&&Math.abs(end[2]-this.layerZ)>.003&&this.objectId!==null)this.stats.physical_vs_comment_z_mismatches++;
    if(this.layerZ!==null)this.layers.set(zKey(end[2]),{z:end[2],height:this.height,commentZ:this.layerZ});
    if(!arc){this.stats.linear_segments++;this.onSegment({...common,a:start,b:end,e:deltaE});return;}
    this.stats.arc_moves++;
    if(this.plane!==17){this.error('Extruding G2/G3 outside XY plane is unsupported.');return;}
    let center;
    if(values.I!==undefined||values.J!==undefined){center=this.absoluteArcCenter?[values.I+this.offset[0],values.J+this.offset[1]]:[start[0]+(values.I??0),start[1]+(values.J??0)];}
    else if(values.R!==undefined){
      const chord=len2(start,end),radius=Math.abs(values.R);
      if(chord<EPS||chord>radius*2+.001){this.error('Invalid or ambiguous radius-only extruding arc.');return;}
      const h=Math.sqrt(Math.max(0,radius*radius-chord*chord/4)),sign=((+command.slice(1)===3?1:-1)*(values.R<0?-1:1));
      center=[(start[0]+end[0])/2-(end[1]-start[1])/chord*h*sign,(start[1]+end[1])/2+(end[0]-start[0])/chord*h*sign];
    }else{this.error('Extruding arc has no center or radius.');return;}
    const radius=Math.hypot(start[0]-center[0],start[1]-center[1]);
    if(!Number.isFinite(radius)||radius<EPS){this.error('Invalid extruding arc center.');return;}
    const t0=Math.atan2(start[1]-center[1],start[0]-center[0]),t1=Math.atan2(end[1]-center[1],end[0]-center[0]);
    const ccw=+command.slice(1)===3;let delta=t1-t0;
    if(ccw){while(delta<=EPS)delta+=Math.PI*2;}else{while(delta>=-EPS)delta-=Math.PI*2;}
    if(values.P>1)delta+=(ccw?1:-1)*Math.PI*2*(values.P-1);
    // Chords differ from the arc by at most 0.003mm; angular steps never exceed 10 degrees.
    const step=Math.min(Math.PI/18,2*Math.acos(Math.max(-1,1-.003/radius))),n=Math.max(1,Math.ceil(Math.abs(delta)/step));
    let a=start;
    for(let i=1;i<=n;i++){
      const t=i/n,b=i===n?end:[center[0]+radius*Math.cos(t0+delta*t),center[1]+radius*Math.sin(t0+delta*t),start[2]+(end[2]-start[2])*t];
      this.stats.arc_segments++;this.onSegment({...common,a,b,e:deltaE/n});a=b;
    }
  }
}

// Return parameter interval of a finite segment inside a rectangle or circle.
export function clipRect(a,b,min,max){
  let lo=0,hi=1;
  for(let d=0;d<2;d++){
    const v=b[d]-a[d];if(Math.abs(v)<EPS){if(a[d]<min[d]||a[d]>max[d])return null;continue;}
    let t0=(min[d]-a[d])/v,t1=(max[d]-a[d])/v;if(t0>t1)[t0,t1]=[t1,t0];lo=Math.max(lo,t0);hi=Math.min(hi,t1);if(lo>=hi)return null;
  }return [lo,hi];
}
export function clipDisk(a,b,c,r){
  const dx=b[0]-a[0],dy=b[1]-a[1],x=a[0]-c[0],y=a[1]-c[1],A=dx*dx+dy*dy;
  if(A<EPS*EPS)return null;
  const B=2*(x*dx+y*dy),C=x*x+y*y-r*r,D=B*B-4*A*C;
  if(D<=0)return null;const q=Math.sqrt(D),lo=Math.max(0,(-B-q)/(2*A)),hi=Math.min(1,(-B+q)/(2*A));return lo<hi?[lo,hi]:null;
}
const intervalIntersection=(a,b)=>a&&b&&Math.max(a[0],b[0])<Math.min(a[1],b[1])?[Math.max(a[0],b[0]),Math.min(a[1],b[1])]:null;
function record(map,segment,interval){
  if(!interval)return;const length=len2(segment.a,segment.b)*(interval[1]-interval[0]);if(length<.001)return;
  const z=(segment.a[2]+segment.b[2])/2,key=zKey(z);let row=map.get(key);
  if(!row){row={z_mm:z,height_mm:segment.height,nominal_model_layer_height_mm:segment.modelLayerHeight??null,declared_extrusion_heights_mm:new Set(),length_mm:0,roles:new Set(),first_gcode_line:segment.line,last_gcode_line:segment.line,width_min_mm:Infinity,width_max_mm:0,centerline_xy_min_mm:[Infinity,Infinity],centerline_xy_max_mm:[-Infinity,-Infinity]};map.set(key,row);}
  row.length_mm+=length;row.roles.add(segment.role);row.declared_extrusion_heights_mm.add(segment.height);row.last_gcode_line=segment.line;
  if(segment.width){row.width_min_mm=Math.min(row.width_min_mm,segment.width);row.width_max_mm=Math.max(row.width_max_mm,segment.width);}
  const clipped=[point(segment.a,segment.b,interval[0]),point(segment.a,segment.b,interval[1])];
  for(let d=0;d<2;d++){row.centerline_xy_min_mm[d]=Math.min(row.centerline_xy_min_mm[d],...clipped.map(p=>p[d]));row.centerline_xy_max_mm[d]=Math.max(row.centerline_xy_max_mm[d],...clipped.map(p=>p[d]));}
}
function rows(map){return [...map.values()].sort((a,b)=>a.z_mm-b.z_mm).map(r=>({...r,z_mm:round(r.z_mm),height_mm:round(r.height_mm),declared_extrusion_heights_mm:[...r.declared_extrusion_heights_mm],length_mm:round(r.length_mm),width_min_mm:round(r.width_min_mm),width_max_mm:round(r.width_max_mm),centerline_xy_min_mm:r.centerline_xy_min_mm.map(round),centerline_xy_max_mm:r.centerline_xy_max_mm.map(round),roles:[...r.roles]}));}
const strongRows=map=>rows(map).filter(r=>r.length_mm>=.015);
function modelInterval(segment,kind,shift,height){
  const z=(segment.a[2]+segment.b[2])/2-shift[2],sliceZ=z-height/2;
  if(kind==='flat-roof')return sliceZ>=6.1-.001&&sliceZ<6.5?clipRect(segment.a,segment.b,[shift[0]-2,shift[1]],[shift[0]+8,shift[1]+6]):null;
  if(sliceZ<4.3+.001||sliceZ>6.1)return null;
  const radius2=1.2**2-(sliceZ-5.5)**2;
  if(radius2<=0)return null;
  // The sphere is inscribed/faceted. A 0.01mm inset prevents neighboring support crowns being mistaken for model paths.
  return clipDisk(segment.a,segment.b,[shift[0]+6,shift[1]+3],Math.max(0,Math.sqrt(radius2)-.01));
}

/** A vertical-ray occupancy mask over the original, full-resolution binary STL.
 * XY binning only accelerates the exact triangle tests; it does not simplify the model.
 * Surface-adjacent points are deliberately ambiguous, never counted as support-only.
 */
async function originalMeshMask(filename,translation){
  const bytes=await readFile(filename),n=bytes.readUInt32LE(80);
  if(bytes.length!==84+n*50)throw Error(`Expected binary STL for original geometry mask: ${filename}`);
  const triangles=[],bins=new Map(),cell=.5;
  for(let i=0;i<n;i++){
    const k=84+i*50+12,a=[0,1,2].map(d=>bytes.readFloatLE(k+d*4)),b=[0,1,2].map(d=>bytes.readFloatLE(k+12+d*4)),c=[0,1,2].map(d=>bytes.readFloatLE(k+24+d*4));
    const u=b.map((v,d)=>v-a[d]),v=c.map((x,d)=>x-a[d]),den=u[0]*v[1]-u[1]*v[0];if(Math.abs(den)<1e-14)continue;
    const index=triangles.length;triangles.push({a,u,v,den});
    const min=[0,1].map(d=>Math.floor(Math.min(a[d],b[d],c[d])/cell)),max=[0,1].map(d=>Math.floor(Math.max(a[d],b[d],c[d])/cell));
    for(let x=min[0];x<=max[0];x++)for(let y=min[1];y<=max[1];y++){const key=x+','+y;let bin=bins.get(key);if(!bin){bin=[];bins.set(key,bin);}bin.push(index);}
  }
  return {triangles:n,sha256:createHash('sha256').update(bytes).digest('hex'),at(platePoint){
    const [x,y,z]=platePoint.map((v,d)=>v-translation[d]),hits=[];
    for(const index of bins.get(Math.floor(x/cell)+','+Math.floor(y/cell))??[]){
      const {a,u,v,den}=triangles[index],w1=((x-a[0])*v[1]-(y-a[1])*v[0])/den,w2=(u[0]*(y-a[1])-u[1]*(x-a[0]))/den;
      if(w1>=-1e-8&&w2>=-1e-8&&w1+w2<=1+1e-8)hits.push(a[2]+w1*u[2]+w2*v[2]);
    }
    hits.sort((a,b)=>a-b);const unique=hits.filter((v,i)=>!i||v-hits[i-1]>1e-5);
    if(unique.some(v=>Math.abs(v-z)<.005))return 'boundary';
    return unique.filter(v=>v>z).length%2?'inside':'outside';
  }};
}

export async function auditToolpaths({gcode,manifest,out,coupons,...options}){
  const manifestBytes=await readFile(manifest),plate=JSON.parse(manifestBytes);
  const realMetadataPath=options['real-contacts']??path.join(path.dirname(manifest),'real-contact-metadata.json');let realMetadata=null;
  try{realMetadata=JSON.parse(await readFile(realMetadataPath,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
  if(realMetadata?.sourcePlateManifestSha256!==undefined&&realMetadata.sourcePlateManifestSha256!==createHash('sha256').update(manifestBytes).digest('hex'))throw Error('Real-contact metadata belongs to a different plate manifest; regenerate the sidecar.');
  let variants=[];if(coupons){variants=JSON.parse(await readFile(coupons,'utf8')).variants;}
  const specimens=plate.specimens.map(s=>({...variants.find(v=>v.id===s.id),...(s.files?.some(f=>path.basename(f)==='coupon-original.stl')?{model_roof_underside_z_mm:6.1,model_round_lobe_bottom_z_mm:4.3}:{}),...s}));
  const records=specimens.map(s=>({spec:s,contacts:(s.plateContacts??[]).map(c=>({expected:c,support:new Map(),model:new Map()})),roof:new Map(),lobe:new Map(),interface:new Map(),samples:[],nativeCore:new Map(),geometryLayers:new Map()}));
  const meshMaskCache=new Map();
  for(const record of records){
    record.real=realMetadata?.specimens.find(s=>s.id===record.spec.id&&!s.nativeSupports);
    if(record.real){
      // A shared original STL can occur in several translated specimens; cache by file+translation.
      const key=record.real.originalModelBedStl+JSON.stringify(record.real.plateTranslationMm);
      if(!meshMaskCache.has(key))meshMaskCache.set(key,await originalMeshMask(record.real.originalModelBedStl,record.real.plateTranslationMm));
      record.originalMask=meshMaskCache.get(key);
      const expectedModelHash=record.real.originalGeometryIntegrity?.modelStlSha256;
      if(expectedModelHash&&expectedModelHash!==record.originalMask.sha256)throw Error(`Original STL changed after real-contact metadata was generated: ${record.spec.id}`);
      record.realContacts=record.real.contacts.map(c=>({expected:c,neck:new Map(),neckAmbiguous:new Map(),capZone:new Map()}));
    }
  }
  const objectStats=new Map(),globalRoleLengths=new Map(),hash=createHash('sha256');
  const nativeRasters=new Map(['N1','N2'].filter(id=>specimens.some(s=>s.id===id)).map(id=>[id,new Set()]));
  let relevantNonplanar=0,nonuniformModelZ=0,lastOffGridLine=null;
  const parser=new GcodeParser(segment=>{
    if(segment.layerZ===null||segment.objectId===null||segment.role==='Custom')return;
    const length=len2(segment.a,segment.b);if(length<EPS)return;
    if(!supportRole(segment.role)){
      const first=+parser.config.initial_layer_print_height||.1,regular=+parser.config.layer_height||.06,z=segment.b[2];
      segment.modelLayerHeight=Math.abs(z-first)<.003?first:regular;
      if(Math.abs((z-first)/regular-Math.round((z-first)/regular))>.002&&segment.line!==lastOffGridLine){nonuniformModelZ++;lastOffGridLine=segment.line;}
    }
    globalRoleLengths.set(segment.role,(globalRoleLengths.get(segment.role)??0)+length);
    let object=objectStats.get(segment.objectId);if(!object){object={id:segment.objectId,votes:new Map(),support:new Map(),roleLengths:new Map(),roleMoves:new Map(),lastLine:null,min:[Infinity,Infinity,Infinity],max:[-Infinity,-Infinity,-Infinity]};objectStats.set(segment.objectId,object);}
    for(let d=0;d<3;d++){object.min[d]=Math.min(object.min[d],segment.a[d],segment.b[d]);object.max[d]=Math.max(object.max[d],segment.a[d],segment.b[d]);}
    if(supportRole(segment.role)){
      record(object.support,segment,[0,1]);object.roleLengths.set(segment.role,(object.roleLengths.get(segment.role)??0)+length);
      if(object.lastLine!==segment.line)object.roleMoves.set(segment.role,(object.roleMoves.get(segment.role)??0)+1);
    }object.lastLine=segment.line;
    for(const data of records){
      const s=data.spec,core=clipRect(segment.a,segment.b,s.plateBounds.min,s.plateBounds.max);
      if(core){
        if(supportRole(segment.role)){
          record(data.nativeCore,segment,core);
          const raster=nativeRasters.get(s.id);if(raster){
            const steps=Math.ceil(length*(core[1]-core[0])/.04);
            for(let i=0;i<=steps;i++){const p=point(segment.a,segment.b,core[0]+(core[1]-core[0])*i/steps);raster.add([Math.round((p[0]-s.translation[0])*10),Math.round((p[1]-s.translation[1])*10),Math.round(p[2]*1000)].join(','));}
          }
        }
        else {
          object.votes.set(s.id,(object.votes.get(s.id)??0)+length*(core[1]-core[0]));
          data.geometryLayers.set(zKey(segment.b[2]),{z:segment.b[2],height:segment.modelLayerHeight});
        }
      }
      if(!core)continue;
      const shift=s.translation,height=segment.modelLayerHeight??segment.height??.06,z=(segment.a[2]+segment.b[2])/2,localZ=z-shift[2];
      if(data.realContacts&&!supportRole(segment.role)){
        const sliceZ=z-height/2;
        for(const contact of data.realContacts){
          const c=contact.expected,[low,high]=c.capConservativeZIntervalMm;
          if(sliceZ<low-.21||sliceZ>high+.04)continue;
          const parent=c.parentPositionPlateMm,tip=c.capCenterPlateMm,dz=tip[2]-parent[2];if(dz<=.001)continue;
          const t=(sliceZ-parent[2])/dz,axis=point(parent,tip,t),radius=c.parentRadiusMm+(c.capRadiusMm-c.parentRadiusMm)*Math.max(0,Math.min(1,t));
          if(sliceZ>=low-.18&&sliceZ<=low-.06){
            const disk=clipDisk(segment.a,segment.b,axis,radius+.003);
            if(disk){
              const probe=point(segment.a,segment.b,(disk[0]+disk[1])/2);probe[2]=sliceZ;
              const occupancy=data.originalMask.at(probe);
              record(occupancy==='outside'?contact.neck:contact.neckAmbiguous,segment,disk);
            }
          }
          // Include the final slice below a zero-thickness cap even when its Z is between layer planes.
          if(sliceZ>=low-height-.005&&sliceZ<=high+height/2+.005){
            // This deliberately remains an ambiguous occupancy measurement: merged paths may belong to either mesh.
            const capDisk=clipDisk(segment.a,segment.b,tip,c.capRadiusMm/Math.max(.1,c.capPlaneUpwardNormal[2])+(segment.width??.22)/2);
            record(contact.capZone,segment,capDisk);
          }
        }
      }
      if(data.contacts.some(c=>c.expected.kind==='stability-island')&&!supportRole(segment.role)){
        for(const contact of data.contacts){
          const c=contact.expected;if(c.kind!=='stability-island'||z<c.support_top_z_mm-.35||z>c.model_underside_z_at_xy_mm+.5)continue;
          const cap=clipDisk(segment.a,segment.b,c.xy_mm,c.cap_radius_mm+.003);
          if(z-height/2<=c.support_top_z_mm-.001)record(contact.support,segment,cap);
          const sliceZ=z-height/2,centerZ=c.model_underside_z_at_xy_mm+1.2,radius2=1.2**2-(sliceZ-centerZ)**2;
          const sphere=radius2>0?clipDisk(segment.a,segment.b,c.xy_mm,Math.max(0,Math.sqrt(radius2)-.01)):null;
          const bead=clipDisk(segment.a,segment.b,c.xy_mm,c.cap_radius_mm+(segment.width??.22)/2);
          if(sliceZ>c.model_underside_z_at_xy_mm+.001)record(contact.model,segment,intervalIntersection(sphere,bead));
        }
      }
      if(!s.model_roof_underside_z_mm)continue;
      if(localZ<3.7||localZ>6.5)continue;
      if(Math.abs(segment.a[2]-segment.b[2])>.001){relevantNonplanar++;continue;}
      if(supportRole(segment.role))continue;
      const roofMask=modelInterval(segment,'flat-roof',shift,height),lobeMask=modelInterval(segment,'round-island',shift,height);
      const flatRoi=clipRect(segment.a,segment.b,[shift[0]-1.8,shift[1]-.01],[shift[0]+4.5,shift[1]+6.01]);
      record(data.roof,segment,intervalIntersection(roofMask,flatRoi));
      record(data.lobe,segment,lobeMask);
      if(s.interface&&localZ<=s.interface.support_top_z_mm+height/2-.001&&localZ>=s.interface.support_top_z_mm-.2)record(data.interface,segment,flatRoi);
      for(const contact of data.contacts){
        const c=contact.expected,cap=clipDisk(segment.a,segment.b,c.xy_mm,c.cap_radius_mm+.003);
        // Midplane criterion bounds geometry beneath the crown, excluding model extrusion above the gap.
        if(z<=c.support_top_z_mm+height/2-.001&&z>=c.support_top_z_mm-.3)record(contact.support,segment,cap);
        const mask=c.kind==='flat-roof'?roofMask:lobeMask;
        const beadOverlap=clipDisk(segment.a,segment.b,c.xy_mm,c.cap_radius_mm+(segment.width??.22)/2);
        record(contact.model,segment,intervalIntersection(mask,beadOverlap));
      }
      // Keep only the few contact transition layers, not the whole G-code, for a compact visual record.
      if((localZ>=3.94&&localZ<=4.6)||(localZ>=5.92&&localZ<=6.17)){
        data.samples.push({a:segment.a.slice(0,2).map((v,d)=>round(v-shift[d])),b:segment.b.slice(0,2).map((v,d)=>round(v-shift[d])),z:round(localZ),role:segment.role,width:segment.width});
      }
    }
  });
  const stream=createReadStream(gcode);stream.on('data',chunk=>hash.update(chunk));
  for await(const line of createInterface({input:stream,crlfDelay:Infinity}))parser.feed(line);
  const observedLayers=[...parser.layers.values()].sort((a,b)=>a.z-b.z);
  const nearestCrownLayer=(top,data)=>[...data.geometryLayers.values()].filter(l=>l.height&&l.z-l.height/2<=top+.001&&l.z<=top+.07).sort((a,b)=>a.z-b.z).at(-1)?.z??null;
  const warnings=[],errors=[];
  if(parser.errors.length)errors.push(...parser.errors.map(e=>`G-code line ${e.line}: ${e.message}`));
  if(relevantNonplanar)errors.push(`${relevantNonplanar} relevant non-planar segments could not be assigned to a planar contact layer.`);
  if(nonuniformModelZ)errors.push(`${nonuniformModelZ} ordinary-geometry extrusion moves depart from the configured uniform model-layer grid; original-geometry slice masking requires a per-layer schedule.`);
  const objectAssignments=[...objectStats.values()].map(o=>{
    const votes=[...o.votes].sort((a,b)=>b[1]-a[1]),total=votes.reduce((n,v)=>n+v[1],0),winner=votes[0];
    const confidence=winner?winner[1]/total:0;return {object_id:o.id,specimen_id:confidence>.98?winner[0]:null,xy_assignment_fraction:round(confidence),extrusion_centerline_bounds_mm:{min:o.min.map(round),max:o.max.map(round)},candidate_votes_mm:Object.fromEntries(votes.map(([id,v])=>[id,round(v)])),native_support_lengths_by_role_mm:Object.fromEntries([...o.roleLengths].map(([k,v])=>[k,round(v)])),native_support_moves_by_role:Object.fromEntries(o.roleMoves),native_support_layers:rows(o.support)};
  });
  const results=records.map(data=>{
    const s=data.spec,roof=strongRows(data.roof),lobe=strongRows(data.lobe),face=strongRows(data.interface);
    const firstRoof=roof[0]??null,firstLobe=lobe[0]??null;
    const contactResults=data.contacts.map((contact,index)=>{
      const c=contact.expected,support=strongRows(contact.support),model=strongRows(contact.model),last=support.at(-1)??null,first=model[0]??null,expectedLayer=nearestCrownLayer(c.support_top_z_mm,data);
      const status=last===null?'missing':Math.abs(last.z_mm-expectedLayer)<.004?'present-at-top-layer':'truncated';
      const gap=last&&first?round(first.z_mm-first.nominal_model_layer_height_mm-last.z_mm):null;
      return {index,kind:c.kind,expected:c,expected_top_layer_z_mm:round(expectedLayer),crown_status:status,actual_support_top:last,first_model_path_over_cap:first,nominal_layer_envelope_gap_mm:gap,gap_status:gap===null?'unresolved':gap<-.001?'negative-layer-envelope-gap':gap<=.001?'zero-layer-envelope-gap':'positive-layer-envelope-gap',support_transition_layers:support,model_transition_layers:model.slice(0,5),gap_interpretation:'First model path Z minus nominal model layer height minus last support path Z, over the cap footprint. A layer-envelope estimate, not measured air or adhesion; bridge extrusion HEIGHT may differ from model layer spacing.'};
    });
    const ownObjects=objectAssignments.filter(o=>o.specimen_id===s.id),nativeLayers=ownObjects.flatMap(o=>o.native_support_layers),nativeLength=nativeLayers.reduce((sum,l)=>sum+l.length_mm,0),nativeExpected=String(s.settings?.enable_support)==='1';
    if(nativeExpected&&!nativeLength)errors.push(`${s.id}: requested native supports have no attributed Support/Support interface extrusion.`);
    if(!nativeExpected&&nativeLength>.01)errors.push(`${s.id}: native Support/Support interface extrusion exists despite enable_support=0.`);
    const missing=contactResults.filter(c=>c.crown_status!=='present-at-top-layer');
    if(missing.length)warnings.push(`${s.id}: ${missing.length}/${contactResults.length} crowns are missing or truncated at the geometric top layer.`);
    const lostGaps=contactResults.filter(c=>c.expected.specified_min_vertical_gap_mm>0&&c.nominal_layer_envelope_gap_mm!==null&&c.nominal_layer_envelope_gap_mm<=.001);
    if(lostGaps.length)warnings.push(`${s.id}: ${lostGaps.length} intended positive gaps have zero/negative layer-envelope separation.`);
    if(s.model_roof_underside_z_mm&&(!firstRoof||!firstLobe))errors.push(`${s.id}: model roof or rounded-island first extrusion was not located.`);
    if(s.interface&&!face.length)errors.push(`${s.id}: micro-interface top extrusion was not located.`);
    const flatGaps=[...new Set(contactResults.filter(c=>c.kind==='flat-roof').map(c=>c.nominal_layer_envelope_gap_mm))];
    const interfaceGap=firstRoof&&face.length?round(firstRoof.z_mm-firstRoof.nominal_model_layer_height_mm-face.at(-1).z_mm):null;
    const realContacts=(data.realContacts??[]).map(c=>{
      const neck=strongRows(c.neck),ambiguous=strongRows(c.neckAmbiguous),capZone=strongRows(c.capZone);
      return {contact_id:c.expected.id,reason:c.expected.reason,cap_center_plate_mm:c.expected.capCenterPlateMm,cap_z_interval_mm:c.expected.capConservativeZIntervalMm,status:neck.length?'support-only-neck-path-present':ambiguous.length?'neck-occupied-by-original-model-ambiguous':'no-neck-path-found',support_only_neck_layers:neck,original_model_ambiguous_neck_layers:ambiguous,cap_zone_occupancy_layers:capZone,cap_zone_meaning:'Paths near the inclined cap may be model, support, or merged. This is occupancy, not a measured air gap.',original_minus_proxy_z_mm:c.expected.originalMinusProxyZMm};
    });
    const realMissing=realContacts.filter(c=>c.status!=='support-only-neck-path-present');
    if(realMissing.length)warnings.push(`${s.id}: ${realMissing.length}/${realContacts.length} inclined tip necks lack unambiguous emitted support-only paths in the prescribed probe band.`);
    const noCapOccupancy=realContacts.filter(c=>!c.cap_zone_occupancy_layers.length);
    if(noCapOccupancy.length)warnings.push(`${s.id}: ${noCapOccupancy.length} inclined contacts have no local emitted paths in the cap transition layer band; inspect before claiming cap survival.`);
    if(s.researchSummary&&!nativeExpected&&!data.real)warnings.push(`${s.id}: no inclined contact metadata; only object/native-role placement audited.`);
    return {id:s.id,assembly_index:s.assemblyIndex,style:s.style??(nativeExpected?'native-control':data.real?'inclined-point-supports':'stability-control'),contact_audit_scope:contactResults.length?'analytic-model-crowns-and-layer-gaps':data.real?'inclined-neck-survival-with-original-mesh-exclusion':'native-role-presence-and-XY-assignment',nominal_gap_mm:s.gap_mm??null,cap_diameter_mm:s.tip_diameter_mm??null,object_ids:ownObjects.map(o=>o.object_id),native_support_expected:nativeExpected,native_support_extrusion_mm:round(nativeLength),native_support_roles:[...new Set(nativeLayers.flatMap(l=>l.roles))],native_support_xy_core_extrusion_mm:round(rows(data.nativeCore).reduce((n,l)=>n+l.length_mm,0)),native_support_layers:nativeLayers,first_flat_roof_extrusion:firstRoof,first_round_lobe_extrusion:firstLobe,interface_top_extrusion:face.at(-1)??null,interface_nominal_layer_envelope_gap_mm:interfaceGap,flat_point_nominal_layer_envelope_gaps_mm:flatGaps,contacts:contactResults,crown_top_layer_counts:{present:contactResults.length-missing.length,total:contactResults.length},inclined_tip_neck_counts:{present:realContacts.length-realMissing.length,total:realContacts.length},inclined_tip_contacts:realContacts,omitted_engine_contact_count:data.real?.omittedContacts?.length??null,physical_print:'not performed'};
  });
  const collapsed=[];
  for(let i=0;i<results.length;i++)for(let j=i+1;j<results.length;j++){
    const a=results[i],b=results[j];if(a.nominal_gap_mm===null||b.nominal_gap_mm===null||a.style!==b.style||a.cap_diameter_mm!==b.cap_diameter_mm||a.nominal_gap_mm===b.nominal_gap_mm)continue;
    const ga=a.style==='micro-interface'?[a.interface_nominal_layer_envelope_gap_mm]:a.flat_point_nominal_layer_envelope_gaps_mm;
    const gb=b.style==='micro-interface'?[b.interface_nominal_layer_envelope_gap_mm]:b.flat_point_nominal_layer_envelope_gaps_mm;
    if(ga.length&&JSON.stringify(ga)===JSON.stringify(gb)){collapsed.push([a.id,b.id]);warnings.push(`${a.id}/${b.id}: distinct geometric gaps produced the same measured flat-roof layer-envelope gap.`);}
  }
  for(const obj of objectAssignments)if(!obj.specimen_id&&obj.native_support_layers.length)errors.push(`Native support object ${obj.object_id} could not be assigned uniquely by XY geometry.`);
  for(const obj of objectAssignments)if(obj.extrusion_centerline_bounds_mm.min.slice(0,2).some(v=>v<0)||obj.extrusion_centerline_bounds_mm.max.slice(0,2).some((v,d)=>v>(plate.bedSizeMm?.[d]??256)))errors.push(`${obj.specimen_id??obj.object_id}: object extrusion leaves the configured plate XY bounds.`);
  let nativeCouponComparison=null;
  if(nativeRasters.size===2){const a=nativeRasters.get('N1'),b=nativeRasters.get('N2'),common=[...a].filter(v=>b.has(v)).length;nativeCouponComparison={specimens:['N1','N2'],sampled_xy_grid_mm:.1,sample_step_mm:.04,z_grid_mm:.001,occupied_cells:[a.size,b.size],common_cells:common,jaccard_fraction:round(common/(a.size+b.size-common)),interpretation:'Normalized centerline occupancy inside assembly bounds. High overlap means the two style settings yielded similar geometry on this coupon; feature-switch counts alone do not establish different geometry. Quantization and seams prevent exact equality even for similar paths.'};}
  const report={schema_version:1,created_at:new Date().toISOString(),gcode:path.resolve(gcode),gcode_sha256:hash.digest('hex'),plate_manifest:path.resolve(manifest),title:plate.title,scope:'Digital extrusion-path audit only; no physical print performed.',method:{extrusion:'Positive E with XY motion. M82/M83, G90/G91, G92 coordinate offsets; G0/G1 and XY G2/G3 arcs. Arc chord sag <=0.003mm.',layer_height:'Physical commanded Z and declared LAYER_HEIGHT are retained independently. Nominal layer-envelope gap is first model Z - model layer height - support top Z.',flat_model_mask:'Roof midplane >=6.10mm; independent flat ROI local X[-1.8,4.5], Y[-0.01,6.01], excluding grounded post and rounded lobe.',round_model_mask:'Sphere R1.2 centered at local (6,3,5.5), evaluated at each extrusion slice midplane with 0.01mm inset to reject neighboring support crowns.',crown:'Positive-length centerline extrusion inside cap radius+0.003mm at the last geometry-intersecting layer. No XY proximity-only model attribution.',object_attribution:'Non-support extrusion length inside known assembly XY bounds votes for object ID. >=98% of attributed length required; native-support role paths then inherit object identity.'},limitations:['Slicer paths do not demonstrate successful extrusion, support adhesion, surface finish, removability, or a safe/unattended print.','Layer-envelope gap is not a measured physical air gap. Bridge extrusion may have a round cross-section different from declared layer height.','Rounded-lobe analytic geometry is a conservative mask over a faceted sphere; contact-local model paths are footprint/line-width intersections, not a guarantee of contact.','Crown detection does not prove continuous structural stability from the bed; the coupon generator independently checks connected manifold geometry.','Native control ROI contact measurements are reported only when the manifest identifies this exact coupon geometry.'],header:parser.header,process:{layer_height_mm:+parser.config.layer_height,first_layer_height_mm:+parser.config.initial_layer_print_height,nozzle_diameter_mm:parser.config.nozzle_diameter,line_width_mm:parser.config.line_width},parser_stats:parser.stats,observed_layers:observedLayers.map(l=>({z_mm:round(l.z),height_mm:round(l.height),comment_z_mm:round(l.commentZ)})),role_extrusion_lengths_mm:Object.fromEntries([...globalRoleLengths].map(([k,v])=>[k,round(v)])),object_assignments:objectAssignments.map(({native_support_layers,...v})=>v),specimens:results,collapsed_gap_pairs:collapsed,errors,warnings,digital_status:errors.length?'failed':warnings.length?'review-required':'passed'};
  report.native_coupon_path_comparison=nativeCouponComparison;
  report.real_contact_metadata=realMetadata?path.resolve(realMetadataPath):null;
  report.method.inclined_tip_neck='At slice midplanes 0.06–0.18mm below the inclined cap lowest rim, find extrusion near the cone axis, then exclude midpoints inside/within0.005mm of the original STL via XY-indexed vertical-ray triangle intersection. Cap-zone occupancy remains explicitly ambiguous; no real-part air-gap inference.';
  report.method.layer_height='Model geometry uses the configured .10 first/.06 regular layer schedule, validated against all ordinary-geometry physical extrusion Z values. Bridge LAYER_HEIGHT may describe thicker extrusion and is retained separately from nominal model-layer height. Native support preserves its independently emitted heights.';
  report.parser_stats.off_model_layer_grid_moves=nonuniformModelZ;
  report.limitations.push('Real-part neck probes check existing routed tips. They do not establish complete island/overhang coverage; omitted engine contacts remain explicit in the real-contact sidecar and specimen counts.');
  await mkdir(out,{recursive:true});await writeFile(path.join(out,'toolpath-validation.json'),JSON.stringify(report,null,2)+'\n');
  await writeFile(path.join(out,'toolpath-details.html'),makeHtml(report,records));
  return report;
}

function makeHtml(report,records){
  const esc=v=>String(v??'—').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
  const summary=report.specimens.map(s=>`<tr><td><a href="#${esc(s.id)}">${esc(s.id)}</a></td><td>${esc(s.nominal_gap_mm)}</td><td>${esc(s.cap_diameter_mm)}</td><td>${s.crown_top_layer_counts.present}/${s.crown_top_layer_counts.total}</td><td>${s.inclined_tip_neck_counts.present}/${s.inclined_tip_neck_counts.total}</td><td>${esc(s.first_flat_roof_extrusion?.z_mm)}</td><td>${esc(s.interface_nominal_layer_envelope_gap_mm??s.flat_point_nominal_layer_envelope_gaps_mm.join(', '))}</td><td>${esc(s.native_support_extrusion_mm)}</td></tr>`).join('');
  const details=records.filter(d=>d.spec.model_roof_underside_z_mm).map(data=>{
    const s=data.spec,r=report.specimens.find(x=>x.id===s.id),zs=[...new Set(data.samples.map(p=>p.z))].sort((a,b)=>a-b);
    const svg=z=>{
      const lines=data.samples.filter(p=>p.z===z),scale=23,pad=20;
      const xy=p=>[(p[0]+2.6)*scale+pad,(6.7-p[1])*scale+pad];
      const paths=lines.map(p=>{const a=xy(p.a),b=xy(p.b);return `<path d="M${a.map(round).join(' ')}L${b.map(round).join(' ')}" stroke="${/bridge/i.test(p.role)?'#c04b2d':'#315c85'}" stroke-width="${Math.max(.7,(p.width??.22)*scale)}"/>`;}).join('');
      const caps=(s.contacts??[]).map(c=>{const p=xy(c.xy_mm);return `<circle cx="${p[0]}" cy="${p[1]}" r="${c.cap_radius_mm*scale}" fill="none" stroke="#e23665" stroke-width="1"/>`;}).join('');
      return `<figure><figcaption>Z ${z.toFixed(2)} mm</figcaption><svg viewBox="0 0 310 200" width="310" height="200"><g fill="none">${paths}${caps}</g></svg></figure>`;
    };
    const rows=r.contacts.map(c=>`<tr><td>${c.index} ${esc(c.kind)}</td><td>${esc(c.expected.support_top_z_mm.toFixed(3))}</td><td>${esc(c.expected_top_layer_z_mm)}</td><td>${esc(c.actual_support_top?.z_mm)}</td><td>${esc(c.first_model_path_over_cap?.z_mm)}</td><td>${esc(c.nominal_layer_envelope_gap_mm)}</td><td>${esc(c.crown_status)}</td></tr>`).join('');
    return `<section id="${esc(s.id)}"><h2>${esc(s.label??s.id)}</h2><p>Pink: designed crown disk. Blue: ordinary geometry extrusion. Orange: bridge-role extrusion. Every view uses actual commanded XY and Z; extrusion width is drawn from the G-code. These are digital paths, not print photographs.</p><div class="layers">${zs.map(svg).join('')}</div><table><thead><tr><th>Contact</th><th>CAD top Z</th><th>Expected layer Z</th><th>Actual top Z</th><th>First model Z</th><th>Layer-envelope gap</th><th>Top survives</th></tr></thead><tbody>${rows}</tbody></table></section>`;
  }).join('');
  const inclined=report.specimens.filter(s=>s.inclined_tip_contacts.length).map(s=>`<section id="${esc(s.id)}"><h2>${esc(s.id)} · inclined tip paths</h2><p>${esc(s.contact_audit_scope)}. ${s.omitted_engine_contact_count} engine contacts omitted during routing. Support-only probe paths exclude the original full-resolution STL at each sampled slice point. Cap occupancy remains ambiguous and is not an air-gap measurement.</p><table><tr><th>Contact</th><th>Reason</th><th>Neck layers</th><th>Ambiguous layers</th><th>Cap-zone layers</th><th>Status</th></tr>${s.inclined_tip_contacts.map(c=>`<tr><td>${c.contact_id}</td><td>${esc(c.reason)}</td><td>${c.support_only_neck_layers.map(l=>l.z_mm).join(', ')}</td><td>${c.original_model_ambiguous_neck_layers.map(l=>l.z_mm).join(', ')}</td><td>${c.cap_zone_occupancy_layers.map(l=>l.z_mm).join(', ')}</td><td>${esc(c.status)}</td></tr>`).join('')}</table></section>`).join('');
  return `<!doctype html><meta charset="utf-8"><title>Support coupon toolpath audit</title><style>body{font:15px system-ui;max-width:1200px;margin:32px auto;padding:0 20px;color:#22313b;background:#fcfcf9}h1,h2{font-weight:650}table{border-collapse:collapse;width:100%;font-size:13px}td,th{border-bottom:1px solid #ccd3d5;padding:7px;text-align:left}section{margin:40px 0}.layers{display:flex;flex-wrap:wrap}figure{margin:6px;border:1px solid #ddd;background:white}figcaption{padding:5px}.warn{color:#8d3c20}code{overflow-wrap:anywhere}</style><h1>Support coupon extrusion audit</h1><p>${esc(report.title)} · ${esc(report.digital_status)} · physical print not performed.</p><p class="warn">Layer-envelope gaps are inferred from commanded layer positions. They are not measured physical air gaps; bridge bead shape, sag, adhesion and removal remain print-test questions.</p><p>G-code SHA256: <code>${report.gcode_sha256}</code></p><ul>${[...report.errors,...report.warnings].map(w=>`<li>${esc(w)}</li>`).join('')}</ul><table><thead><tr><th>ID</th><th>CAD gap</th><th>Cap Ø</th><th>Crowns at top</th><th>Inclined necks</th><th>First roof Z</th><th>Flat layer-envelope gap</th><th>Native support mm</th></tr></thead><tbody>${summary}</tbody></table>${details}${inclined}`;
}

export async function selfTest(){
  const out=[],p=new GcodeParser(s=>out.push(s));
  for(const line of ['G90','M83','; Z_HEIGHT: 0.1','; LAYER_HEIGHT: 0.1','; OBJECT_ID: 1','G1 X0 Y0 Z0.1','G1 X1 E0.1','G1 E-0.8','G1 E0.8','G92 E0','M82','G1 X2 E0.1','G1 X3 E0.2','G1 X4 E0.1','G92 X0','G1 X1 E0.2','G91','M83','G1 X1 E0.1','G90','M83','G1 Z0.16','; Z_HEIGHT: 99','G1 X3 E0.1'])p.feed(line);
  assert.equal(out.length,6);assert.equal(out.at(-1).b[2],.16);assert.equal(out.at(-1).layerZ,99);assert.equal(out[3].b[0],5);assert.equal(out[4].b[0],6);
  const arcs=[],a=new GcodeParser(s=>arcs.push(s));for(const line of ['G90','M83','G1 X1 Y0','G3 X0 Y1 I-1 J0 E1'])a.feed(line);
  assert.ok(Math.abs(arcs.reduce((n,s)=>n+len2(s.a,s.b),0)-Math.PI/2)<.003);assert.ok(Math.abs(arcs.reduce((n,s)=>n+s.e,0)-1)<EPS);
  assert.deepEqual(clipRect([-2,0],[2,0],[-1,-1],[1,1]),[.25,.75]);assert.deepEqual(clipDisk([-2,0],[2,0],[0,0],1),[.25,.75]);
  // A neighboring ring crown is outside the lobe's first-layer cross-section and must not count as model.
  const fake={a:[5.35-.1,3,4.36],b:[5.35+.1,3,4.36]};assert.equal(modelInterval(fake,'round-island',[0,0,0],.06),null);
  assert.ok(modelInterval({a:[5.85,3,4.36],b:[6.15,3,4.36]},'round-island',[0,0,0],.06));
  const fixture=Buffer.alloc(84+4*50),vertices=[[0,0,0],[1,0,0],[0,1,0],[0,0,1]],faces=[[0,2,1],[0,1,3],[0,3,2],[1,2,3]];fixture.writeUInt32LE(4,80);
  faces.forEach((face,i)=>face.forEach((v,j)=>vertices[v].forEach((value,d)=>fixture.writeFloatLE(value,84+i*50+12+j*12+d*4))));
  const dir=await mkdtemp(path.join(tmpdir(),'support-path-fixture-'));
  try{const file=path.join(dir,'tetra.stl');await writeFile(file,fixture);const mask=await originalMeshMask(file,[10,20,30]);assert.equal(mask.at([10.1,20.1,30.1]),'inside');assert.equal(mask.at([10.1,20.1,31]),'outside');assert.equal(mask.at([10.1,20.1,30]),'boundary');}finally{await rm(dir,{recursive:true,force:true});}
  console.log('Toolpath fixtures passed: E modes/reset/retraction, XYZ modes/G92, physical Z, arcs, clipping, curved-model false-positive rejection, original-STL inside/outside/boundary mask.');
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv.includes('--self-test'))await selfTest();
  else{
    const args=process.argv.slice(2),opts={};for(let i=0;i<args.length;i+=2)opts[args[i].replace(/^--/,'')]=args[i+1];
    if(!opts.gcode||!opts.manifest||!opts.out)throw Error('Required: --gcode --manifest --out');
    const report=await auditToolpaths(opts);console.log(JSON.stringify({status:report.digital_status,sha256:report.gcode_sha256,errors:report.errors,warnings:report.warnings,specimens:report.specimens.map(s=>({id:s.id,crowns:s.crown_top_layer_counts,roofZ:s.first_flat_roof_extrusion?.z_mm,gaps:s.flat_point_nominal_layer_envelope_gaps_mm,interfaceGap:s.interface_nominal_layer_envelope_gap_mm,nativeSupport:s.native_support_extrusion_mm}))},null,2));
    if(report.errors.length)process.exitCode=1;
  }
}
