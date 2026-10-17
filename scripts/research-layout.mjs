/** Arrange explicitly selected experimental assemblies without changing their Z frames.
 * node scripts/research-layout.mjs --spec private-spec.json --out test-results/research/print-kit
 * Input rows contain {id,label,files:[STL paths],settings?,contacts?,addLabel?}.
 * Private model paths and all generated geometry belong under ignored test-results/.
 */
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {STLLoader} from 'three/addons/loaders/STLLoader.js';
import Module from 'manifold-3d';

const glyphs={
  A:['010','101','111','101','101'],B:['110','101','110','101','110'],C:['111','100','100','100','111'],
  D:['110','101','101','101','110'],E:['111','100','110','100','111'],F:['111','100','110','100','100'],
  H:['101','101','111','101','101'],I:['111','010','010','010','111'],N:['101','111','111','111','101'],
  P:['110','101','110','100','100'],S:['111','100','111','001','111'],T:['111','010','010','010','010'],
  X:['101','101','010','101','101'],R:['110','101','110','101','101'],
  0:['111','101','101','101','111'],1:['010','110','010','010','111'],2:['111','001','111','100','111'],
  3:['111','001','111','001','111'],4:['101','101','111','001','001'],5:['111','100','111','001','111'],
  6:['111','100','111','101','111'],7:['111','001','010','010','010'],8:['111','101','111','101','111'],9:['111','101','111','001','111'],
};
function stlFromManifold(solid){
  if(solid.status()!=='NoError')throw Error(`Invalid plaque: ${solid.status()}`);
  const mesh=solid.getMesh(), n=mesh.triVerts.length/3, data=Buffer.alloc(84+n*50);data.writeUInt32LE(n,80);
  for(let t=0;t<n;t++)for(let k=0;k<3;k++)for(let d=0;d<3;d++)data.writeFloatLE(mesh.vertProperties[mesh.triVerts[t*3+k]*mesh.numProp+d],84+t*50+12+k*12+d*4);
  return data;
}
export async function buildResearchPlate(spec,directory){
  const out=path.resolve(directory);await mkdir(out,{recursive:true});
  const mf=await Module();mf.setup();const loader=new STLLoader();
  const geometryCache=new Map();
  async function meshInfo(filename){
    filename=path.resolve(filename);if(geometryCache.has(filename))return geometryCache.get(filename);
    const bytes=await readFile(filename), g=loader.parse(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));g.computeBoundingBox();
    const info={path:filename,sha256:createHash('sha256').update(bytes).digest('hex'),triangles:g.attributes.position.count/3,min:g.boundingBox.min.toArray(),max:g.boundingBox.max.toArray()};
    g.dispose();geometryCache.set(filename,info);return info;
  }
  const rows=[];
  for(const inputRow of spec.rows){
    const row=[];
    for(const item of inputRow){
      const meshes=await Promise.all(item.files.map(meshInfo));
      const min=[0,1,2].map(d=>Math.min(...meshes.map(m=>m.min[d]))),max=[0,1,2].map(d=>Math.max(...meshes.map(m=>m.max[d])));
      if(min[2]<-0.001)throw Error(`${item.id} extends below bed: ${min[2]}`);
      if(item.addLabel){
        const pitch=.6,width=item.id.length*4*pitch+.8,height=4.2;
        const x=(min[0]+max[0]-width)/2,y=min[1]-height-2;
        let label=mf.Manifold.cube([width,height,.64]).translate([x,y,0]);
        for(let c=0;c<item.id.length;c++){
          const glyph=glyphs[item.id[c]];if(!glyph)throw Error(`Unsupported label letter ${item.id[c]}`);
          for(let r=0;r<5;r++)for(let col=0;col<3;col++)if(glyph[r][col]==='1'){
            const pixel=mf.Manifold.cube([pitch+.015,pitch+.015,.36]).translate([x+.6+c*4*pitch+col*pitch,y+.6+(4-r)*pitch,.63]);
            const next=label.add(pixel);label.delete();pixel.delete();label=next;
          }
        }
        const filename=path.join(out,`${item.id}-label.stl`);await writeFile(filename,stlFromManifold(label));label.delete();
        const labelMesh=await meshInfo(filename);meshes.push(labelMesh);
        for(let d=0;d<3;d++){min[d]=Math.min(min[d],labelMesh.min[d]);max[d]=Math.max(max[d],labelMesh.max[d]);}
      }
      const geometryBounds={min:[...min],max:[...max]};
      const reserve=item.reserveMm??0;min[0]-=reserve;min[1]-=reserve;max[0]+=reserve;max[1]+=reserve;
      row.push({...item,meshes,min,max,geometryBounds,width:max[0]-min[0],height:max[1]-min[1]});
    }rows.push(row);
  }
  const margin=spec.margin??12,gap=spec.gap??10,rowGap=spec.rowGap??12,bed=256;
  const rowWidths=rows.map(r=>r.reduce((n,s)=>n+s.width,0)+(r.length-1)*gap), rowHeights=rows.map(r=>Math.max(...r.map(s=>s.height)));
  const height=rowHeights.reduce((a,b)=>a+b,0)+(rows.length-1)*rowGap;
  if(height>bed-2*margin||Math.max(...rowWidths)>bed-2*margin)throw Error(`Plate too large: ${Math.max(...rowWidths)} x ${height}`);
  let y=(bed-height)/2,index=0;const specimens=[],objects=[],assembled_params=[];
  for(let ri=0;ri<rows.length;ri++){
    let x=(bed-rowWidths[ri])/2;
    for(const item of rows[ri]){
      const shift=[x-item.min[0],y-item.min[1],0];index++;
      for(const mesh of item.meshes)objects.push({path:mesh.path,count:1,filaments:[1],assemble_index:[index],pos_x:[shift[0]],pos_y:[shift[1]],pos_z:[0],print_params:{}});
      const settings={enable_support:'0',...item.settings};assembled_params.push({assemble_index:index,print_params:settings});
      const specimen={...item,assemblyIndex:index,translation:shift,plateBounds:{min:item.min.map((v,d)=>v+shift[d]),max:item.max.map((v,d)=>v+shift[d])},settings};
      if(item.contacts)specimen.plateContacts=item.contacts.map(c=>({...c,xy_mm:c.xy_mm.map((v,d)=>v+shift[d])}));
      specimens.push(specimen);x+=item.width+gap;
    }y+=rowHeights[ri]+rowGap;
  }
  const assembly={plates:[{plate_name:spec.title??'A1 miniature support experiments',need_arrange:false,plate_params:{curr_bed_type:spec.bed??'Textured PEI Plate'},objects,assembled_params}]};
  const manifest={title:spec.title,createdAt:new Date().toISOString(),bedSizeMm:[bed,bed],bedType:spec.bed??'Textured PEI Plate',status:'Arranged geometry; final slicing and toolpath validation pending',specimens};
  await writeFile(path.join(out,'assemble.json'),JSON.stringify(assembly,null,2)+'\n');
  await writeFile(path.join(out,'plate-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
  const h=700,pad=30,s=(h-pad*2)/bed;
  const esc=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;');
  const rects=specimens.map(i=>{const b=i.plateBounds,X=pad+b.min[0]*s,Y=pad+(bed-b.max[1])*s,W=(b.max[0]-b.min[0])*s,H=(b.max[1]-b.min[1])*s;return `<g><rect x="${X}" y="${Y}" width="${W}" height="${H}" rx="4" fill="${i.settings.enable_support==='1'?'#dae5fa':'#dbe9d6'}" stroke="#758773"/><text x="${X+W/2}" y="${Y+H/2}" text-anchor="middle" dominant-baseline="middle" font-family="sans-serif" font-size="15" fill="#17271d">${esc(i.id)}</text></g>`}).join('');
  await writeFile(path.join(out,'plate-map.svg'),`<svg xmlns="http://www.w3.org/2000/svg" width="700" height="740" viewBox="0 0 700 740"><rect width="700" height="740" fill="#fbfaf6"/><rect x="${pad}" y="${pad}" width="${bed*s}" height="${bed*s}" fill="#f0eee7" stroke="#233b2c"/>${rects}<text x="350" y="720" text-anchor="middle" font-family="sans-serif" font-size="16">Front of A1 · blue = native support control</text></svg>`);
  return {assembly:path.join(out,'assemble.json'),manifest:path.join(out,'plate-manifest.json'),specimens:specimens.length,dimensions:[Math.max(...rowWidths),height]};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2),opts={};for(let i=0;i<args.length;i+=2)opts[args[i].replace(/^--/,'')]=args[i+1];
  if(!opts.spec||!opts.out)throw Error('Required --spec and --out');
  console.log(await buildResearchPlate(JSON.parse(await readFile(opts.spec,'utf8')),opts.out));
}
