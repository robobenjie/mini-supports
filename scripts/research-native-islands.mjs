/** Limited original-model island-start audit. No geometry, layout or G-code mutations. */
import {GcodeParser} from './research-toolpaths.mjs';
import {createReadStream} from 'node:fs';
import {readFile,writeFile} from 'node:fs/promises';
import {createInterface} from 'node:readline';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {loadPyodide} from 'pyodide';
import Module from 'manifold-3d';
import {STLLoader} from 'three/examples/jsm/loaders/STLLoader.js';

const folder=path.resolve(process.argv[2]||'test-results/research/print-kit');
const manifestBytes=await readFile(path.join(folder,'plate-manifest.json')),manifest=JSON.parse(manifestBytes);
const specimen=manifest.specimens.find(s=>s.id==='N5');
if(!specimen)throw Error('N5 native held-out miniature is required.');
const gcodePath=path.resolve(process.argv[3]||path.join(folder,'gui-sliced/plate_1.gcode')),hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const gcodeHash=createHash('sha256');for await(const chunk of createReadStream(gcodePath))gcodeHash.update(chunk);
// The slicer identifies objects in assembly order; derive the IDs from its header, never assume 730.
const header=(await readFile(gcodePath)).subarray(0,12000).toString();
const labelIds=header.match(/; model label id:\s*([\d,]+)/)?.[1].split(',');
const objectId=labelIds?.[specimen.assemblyIndex-1];
if(!objectId)throw Error('Cannot resolve N5 object ID from G-code header.');
const chunks=[];let active=new Float64Array(9*32768),used=0,count=0;
const parser=new GcodeParser(s=>{
 if(s.objectId!==objectId||s.role==='Custom')return;
 if(Math.abs(s.a[2]-s.b[2])>1e-4)throw Error('Nonplanar extrusion inside N5 is unsupported.');
 if(!(s.width>0&&s.height>0))throw Error('Extrusion lacks explicit width or height.');
 if(used===active.length){chunks.push(active);active=new Float64Array(9*32768);used=0;}
 const row=[s.b[2],s.a[0],s.a[1],s.b[0],s.b[1],s.width,s.height,s.line,/^support(?:\s|$)/i.test(s.role)?1:0];
 active.set(row,used);used+=9;count++;
});
for await(const line of createInterface({input:createReadStream(gcodePath),crlfDelay:Infinity}))parser.feed(line);
if(parser.errors.length)throw Error(JSON.stringify(parser.errors));
chunks.push(active.subarray(0,used));const segmentBytes=Buffer.concat(chunks.map(c=>Buffer.from(c.buffer,c.byteOffset,c.byteLength)));
console.log(`Auditing N5 object ${objectId}: ${count} emitted path segments.`);
const modelPath=specimen.files.find(f=>path.basename(f)==='model.stl'),modelBytes=await readFile(modelPath);
const original=new STLLoader().parse(modelBytes.buffer.slice(modelBytes.byteOffset,modelBytes.byteOffset+modelBytes.byteLength));
const mf=await Module();mf.setup();const py=await loadPyodide({indexURL:path.resolve('public/runtime')+'/'});
py.registerJsModule('manifold_js',{api:mf});await py.loadPackage(['numpy','scipy','shapely']);
for(const f of ['networkx-3.4.2-py3-none-any.whl','arbor-engine.zip','trimesh-5.1.1-py3-none-any.whl'])py.unpackArchive(new Uint8Array(await readFile('public/runtime/'+f)),'zip',{extractDir:'/engine'});
py.FS.writeFile('/model.positions',new Uint8Array(original.attributes.position.array.buffer));
py.FS.writeFile('/segments.f64',segmentBytes);
py.globals.set('plate_translation_json',JSON.stringify(specimen.translation));
py.globals.set('first_model_layer_height',Number(parser.config.initial_layer_print_height??parser.config.first_layer_height??.10));
py.globals.set('regular_model_layer_height',Number(parser.config.layer_height??.06));
const audit=JSON.parse(await py.runPythonAsync(`
import sys,json,math
sys.path.insert(0,'/engine')
import wasm_compat,numpy as np,trimesh,manifold3d as mf
from pathlib import Path
from shapely.geometry import LineString,Polygon
from shapely.ops import unary_union
from shapely import union_all
from arbor.engine.build import trimesh_to_manifold
from arbor.engine.analysis import cs_components
vertices=np.frombuffer(Path('/model.positions').read_bytes(),dtype=np.float32).reshape(-1,3).astype(float)
vertices,indices=np.unique(vertices,axis=0,return_inverse=True)
vertices+=np.array(json.loads(plate_translation_json))
mesh=trimesh.Trimesh(vertices=vertices,faces=indices.reshape(-1,3),process=False)
solid=trimesh_to_manifold(mesh)
assert solid.status()==mf.Error.NoError,'Original model cannot be sliced as a valid solid'
paths=np.frombuffer(Path('/segments.f64').read_bytes(),dtype=np.float64).reshape(-1,9)
keys=np.round(paths[:,0],5)
groups={float(z):paths[keys==z] for z in np.unique(keys)}
model_layers=[]
for z,rows in groups.items():
    model=rows[rows[:,8]==0]
    if len(model):
        # Bridge extrusion HEIGHT is the bead diameter (.2mm here), not model slice thickness.
        layer_number=round((z-first_model_layer_height)/regular_model_layer_height)
        assert abs(z-(first_model_layer_height+layer_number*regular_model_layer_height))<.0002,'Model extrusion off fixed layer schedule'
        height=first_model_layer_height if layer_number==0 else regular_model_layer_height
        model_layers.append((z,float(height),model))
support_groups={z:rows[rows[:,8]==1] for z,rows in groups.items() if np.any(rows[:,8]==1)}
prev=[];starts=[];births=[];tiny_births=0;next_id=0;empty_slices=0
def local_rows(rows,poly,pad=0.):
    a,b,c,d=poly.bounds
    return rows[(np.minimum(rows[:,1],rows[:,3])<=c+pad)&(np.maximum(rows[:,1],rows[:,3])>=a-pad)&(np.minimum(rows[:,2],rows[:,4])<=d+pad)&(np.maximum(rows[:,2],rows[:,4])>=b-pad)]
def path_lines(rows,poly):
    lines=[];total=0.;first=None
    for row in local_rows(rows,poly,.001):
        line=LineString([(row[1],row[2]),(row[3],row[4])]);length=line.intersection(poly.buffer(.001)).length
        if length>1e-8:
            total+=length;lines.append(line.buffer(row[5]/2));first=int(row[7]) if first is None else min(first,int(row[7]))
    return total,lines,first
for layer_index,(z,height,model_paths) in enumerate(model_layers):
    slice_z=z-height/2
    polys=[p for _,p in cs_components(solid.slice(slice_z))]
    if not polys:empty_slices+=1
    current=[]
    for poly in polys:
        parents=[p for p in prev if poly.intersects(p['poly'])]
        inherited_print=any(p['printed'] for p in parents)
        birth_ids=set().union(*(p['birth_ids'] for p in parents)) if parents else set()
        if not parents:
            birth_ids={next_id};next_id+=1
            births.append(dict(id=min(birth_ids),slice_midplane_z_mm=slice_z,area_mm2=float(poly.area),centroid_plate_xy_mm=list(poly.centroid.coords)[0]))
            if poly.area<.001:tiny_births+=1
        # Once ancestry already has printed material this is outside the start audit;
        # avoid constructing millions of irrelevant bead buffers for established walls.
        if inherited_print:
            current.append(dict(poly=poly,printed=True,birth_ids=birth_ids))
            continue
        length,model_footprints,first_line=path_lines(model_paths,poly)
        has_print=length>=.015
        if has_print and not inherited_print:
            witnesses=[]
            bead_witnesses=[]
            slab_base=z-height
            onbed=layer_index==0 and abs(slab_base)<.005
            footprint=None if onbed else union_all(model_footprints,grid_size=.000001)
            for support_z,support_paths in support_groups.items():
                if onbed:break
                if support_z>slab_base+.002 or support_z<slab_base-.5:continue
                overlap=[];bead_overlap=[];first_support_line=None;first_bead_line=None;maxwidth=float(support_paths[:,5].max())
                for row in local_rows(support_paths,poly,maxwidth/2+float(model_paths[:,5].max())/2):
                    bead=LineString([(row[1],row[2]),(row[3],row[4])]).buffer(row[5]/2)
                    bead_intersection=bead.intersection(footprint)
                    if bead_intersection.area>1e-8:
                        bead_overlap.append(bead_intersection);first_bead_line=int(row[7]) if first_bead_line is None else min(first_bead_line,int(row[7]))
                    intersection=bead_intersection.intersection(poly)
                    if intersection.area>1e-8:
                        overlap.append(intersection);first_support_line=int(row[7]) if first_support_line is None else min(first_support_line,int(row[7]))
                if overlap:
                    witnesses.append(dict(native_support_extrusion_z_mm=support_z,nominal_model_layer_envelope_gap_mm=slab_base-support_z,overlap_area_mm2=float(union_all(overlap,grid_size=.000001).area),first_gcode_line=first_support_line))
                if bead_overlap:
                    bead_witnesses.append(dict(native_support_extrusion_z_mm=support_z,nominal_model_layer_envelope_gap_mm=slab_base-support_z,overlap_area_mm2=float(union_all(bead_overlap,grid_size=.000001).area),first_gcode_line=first_bead_line))
            witnesses.sort(key=lambda x:x['native_support_extrusion_z_mm'],reverse=True)
            bead_witnesses.sort(key=lambda x:x['native_support_extrusion_z_mm'],reverse=True)
            starts.append(dict(index=len(starts),birth_ids=sorted(birth_ids),model_slice_midplane_z_mm=slice_z,first_model_extrusion_z_mm=z,model_layer_height_mm=height,area_mm2=float(poly.area),centroid_plate_xy_mm=list(poly.centroid.coords)[0],bounds_plate_xy_mm=list(poly.bounds),centerline_length_in_island_mm=length,first_model_gcode_line=first_line,status='bed-start' if onbed else 'native-support-witness' if witnesses else 'no-native-support-witness',closest_native_support=witnesses[0] if witnesses else None,native_support_layers_with_overlap=len(witnesses),first_extrusion_footprint_area_mm2=None if footprint is None else float(footprint.area),closest_native_support_under_full_extrusion_footprint=bead_witnesses[0] if bead_witnesses else None))
        current.append(dict(poly=poly,printed=inherited_print or has_print,birth_ids=birth_ids))
    prev=current
json.dumps(dict(original_triangles=len(mesh.faces),original_coordinate_welded_vertices=len(mesh.vertices),original_trimesh_watertight=bool(mesh.is_watertight),original_manifold_status=str(solid.status()),model_layers=len(model_layers),model_empty_sections=empty_slices,geometric_births=len(births),tiny_geometric_births_under_001_mm2=tiny_births,geometric_birth_records=births,printed_component_starts=starts))
`));
const report={schemaVersion:1,createdAt:new Date().toISOString(),specimenId:'N5',objectId,sourceManifestSha256:hash(manifestBytes),gcodePath,gcodeSha256:gcodeHash.digest('hex'),originalModelPath:modelPath,originalModelSha256:hash(modelBytes),plateTranslationMm:specimen.translation,scope:'Limited first-emission witness audit for original-model section components; not an exhaustive support-coverage or physical-print validation.',method:['Slice the unsimplified original at actual model-role layer midplanes on the validated fixed layer grid (.10mm first/.06mm regular); never use native support intermediate Z or bridge bead HEIGHT as a model slice thickness.','Track section-component ancestry across consecutive model layers. A component with no previously printed ancestor is checked when at least 0.015mm of actual model extrusion centerline first overlaps it (0.001mm geometric tolerance). Tiny geometric births without emitted paths do not become failed printed starts.','At each above-bed first-emission component, intersect its geometry and model bead footprint with native support/interface path footprints from the previous 0.5mm of Z. Bead footprints use commanded nominal line width.','Native support witness means positive overlap beneath some emitted path; it does not establish adequate contact area or support for the complete island. The nominal layer-envelope gap is not a measured physical air gap.'],limitations:['Connected expanding overhangs and bridges are outside this island-start test.','Model components that separate after inheriting printed ancestry are not new starts.','Slicer bead shape, sag, cooling, adhesion and removal require a real print.','A no-witness result is an audit flag for inspection, not proof that printing must fail.'],...audit};
report.summary={bedStarts:audit.printed_component_starts.filter(x=>x.status==='bed-start').length,supportedStartWitnesses:audit.printed_component_starts.filter(x=>x.status==='native-support-witness').length,startFlags:audit.printed_component_starts.filter(x=>x.status==='no-native-support-witness').length};
report.auditPolygonUnionGridMm=.000001;
report.nativeSettingsFromPlateManifest=specimen.settings;
report.modelSliceSchedule={firstLayerMm:Number(parser.config.initial_layer_print_height??parser.config.first_layer_height??.10),regularLayerMm:Number(parser.config.layer_height??.06)};
report.inspectionScreen={maxClosestWitnessEnvelopeGapMm:Number(specimen.settings.support_top_z_distance)+Number(parser.config.layer_height??.06),minClosestWitnessIslandOverlapRatio:.05,note:'Conservative inspection screens, not empirically calibrated print pass/fail thresholds. A wider lower witness is still not a closer interface.'};
report.inspectionFlags=audit.printed_component_starts.filter(s=>s.status!=='bed-start').flatMap(s=>{
 const w=s.closest_native_support,causes=[];
 if(!w)causes.push('No native support witness in previous 0.5mm.');
 else{
  if(w.nominal_model_layer_envelope_gap_mm>report.inspectionScreen.maxClosestWitnessEnvelopeGapMm+.00001)causes.push('Closest overlapping native path exceeds configured gap plus one model layer.');
  if(w.overlap_area_mm2/s.area_mm2<report.inspectionScreen.minClosestWitnessIslandOverlapRatio)causes.push('Closest native path overlaps less than 5% of the first emitted island section.');
 }
 return causes.length?[{printedStartIndex:s.index,firstModelExtrusionZMm:s.first_model_extrusion_z_mm,centroidPlateXYMm:s.centroid_plate_xy_mm,firstModelGcodeLine:s.first_model_gcode_line,causes,closestWitness:w}]:[];
});
report.summary.inspectionFlags=report.inspectionFlags.length;
report.digitalStatus=report.inspectionFlags.length?'limited-witness-audit-with-inspection-flags':'limited-witness-audit-no-screen-flags';
// Keep bead HEIGHT evidence beside each flag: a bridge diameter must not silently
// become the nominal model slice thickness used for the section/clearance check.
if(report.inspectionFlags.length){
 const evidence=new Map(report.inspectionFlags.map(f=>[f.printedStartIndex,{roles:new Set(),heights:new Set(),widths:new Set(),segments:0}]));
 const localParser=new GcodeParser(s=>{
  if(s.objectId!==objectId||/^support(?:\s|$)/i.test(s.role)||s.role==='Custom')return;
  for(const f of report.inspectionFlags){
   const start=audit.printed_component_starts[f.printedStartIndex],b=start.bounds_plate_xy_mm;
   if(Math.abs(s.b[2]-start.first_model_extrusion_z_mm)>1e-5||Math.max(s.a[0],s.b[0])<b[0]||Math.min(s.a[0],s.b[0])>b[2]||Math.max(s.a[1],s.b[1])<b[1]||Math.min(s.a[1],s.b[1])>b[3])continue;
   const e=evidence.get(f.printedStartIndex);e.roles.add(s.role);e.heights.add(s.height);e.widths.add(s.width);e.segments++;
  }
 });
 for await(const line of createInterface({input:createReadStream(gcodePath),crlfDelay:Infinity}))localParser.feed(line);
 for(const f of report.inspectionFlags){const e=evidence.get(f.printedStartIndex);f.firstModelBoundingBoxPathEvidence={roles:[...e.roles],commandedBeadHeightsMm:[...e.heights],commandedWidthsMm:[...e.widths],segments:e.segments,note:'Actual paths intersecting the start-region bounding box; nominal model-layer thickness remains separately validated.'};}
}
const output=path.join(folder,'native-island-audit.json');await writeFile(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({output,...report.summary,geometricBirths:audit.geometric_births,modelLayers:audit.model_layers,inspectionFlags:report.inspectionFlags},null,2));
