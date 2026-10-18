"""Fixture-specific safeguards complement the shared original/start/cap audit."""
def run_fixture_audit():
    import sys
    from pathlib import Path
    sys.path.insert(0,'/engine')
    import wasm_compat,trimesh,manifold3d as mf
    from arbor.engine.build import trimesh_to_manifold
    from arbor.engine.analysis import cs_components
    from shapely import intersection as grid_intersection
    translation=np.asarray(json.loads(plate_translation_json),float)
    source=json.loads(summary_json);f=source['fixture']
    first,height=float(first_model_layer_height),float(regular_model_layer_height)
    solids={}
    for name in ('model','support'):
        p=np.frombuffer(Path('/'+name+'.positions').read_bytes(),np.float32).reshape(-1,3).astype(float)
        v,ix=np.unique(p,axis=0,return_inverse=True)
        solid=trimesh_to_manifold(trimesh.Trimesh(vertices=v+translation,faces=ix.reshape(-1,3),process=False))
        assert solid.status()==mf.Error.NoError
        solids[name]=solid
    paths=np.frombuffer(Path('/segments.f64').read_bytes(),np.float64).reshape(-1,9)
    nums=np.rint((paths[:,0]-first)/height).astype(int)
    assert np.max(np.abs(paths[:,0]-(first+nums*height)))<.0002
    grouped={int(n):paths[nums==n] for n in np.unique(nums)}
    low=np.frombuffer(Path('/low-segments.f64').read_bytes(),np.float64).reshape(-1,9)
    low_nums=np.rint((low[:,0]-first)/height).astype(int)
    low_grouped={int(n):low[low_nums==n] for n in np.unique(low_nums)}
    empty=paths[:0];cache={};buffer_cache={};flags=[]
    def layer(n):
        z=round(first+n*height,5);h=first if n==0 else height
        return z,h,z-h/2
    def section(name,n):
        key=name,n
        if key not in cache:cache[key]=union_all([p for _,p in cs_components(solids[name].slice(layer(n)[2]))],grid_size=GRID)
        return cache[key]
    def classified(name,n,region=None):
        other='model' if name=='support' else 'support'
        own=section(name,n)
        if region is not None:own=region.intersection(own)
        key=name,n
        if region is None and key in buffer_cache:
            own_buffer,other_buffer=buffer_cache[key]
        else:
            own_buffer=own.buffer(OWN_TOL)
            other_buffer=section(other,n).buffer(OTHER_EXCLUSION)
            if region is None:buffer_cache[key]=(own_buffer,other_buffer)
        # Exactly the same operations as shared evidence(), with invariant
        # section buffers computed once rather than once per emitted segment.
        raw_length,length,ambiguous=0.,0.,0.
        beads,raw_beads,first_line=[],[],None
        for row in local_rows(grouped.get(n,empty),own,OWN_TOL):
            raw=LineString([(row[1],row[2]),(row[3],row[4])]).intersection(own_buffer)
            exclusive=raw.difference(other_buffer)
            raw_length+=raw.length;length+=exclusive.length
            ambiguous+=max(0.,raw.length-exclusive.length)
            if raw.length>1e-8:raw_beads.append(raw.buffer(row[5]/2))
            if exclusive.length>1e-8:
                beads.append(exclusive.buffer(row[5]/2))
                first_line=int(row[7]) if first_line is None else min(first_line,int(row[7]))
        return dict(raw_length=raw_length,length=length,ambiguous_length=ambiguous,
                    footprint=union_all(beads,grid_size=GRID),raw_footprint=union_all(raw_beads,grid_size=GRID),first_line=first_line)
    def polys(g):
        if g.is_empty:return []
        return [g] if g.geom_type=='Polygon' else [p for p in getattr(g,'geoms',[]) if p.geom_type=='Polygon' and not p.is_empty]
    pad_top=f['raftTopBedZ']+translation[2]
    cap_top=f['capTopBedZ']+translation[2]
    pad_layers=[];previous=[];all_roots=set();new_islands=[];reconnections=[];min_clearance=None;pad_fragment_details=[]
    support_layer_count=0;total_components=0;cache_equivalence=[]
    equivalence_only=bool(globals().get('fixture_equivalence_only',False))
    pad_only=bool(globals().get('fixture_pad_only',False))
    stop_z=pad_top if pad_only else cap_top
    check_layers=(0,25,200) if equivalence_only else range(int(math.ceil((stop_z-first)/height))+2)
    for n in check_layers:
        if n%100==0:print('Fixture support ancestry layer',n,flush=True)
        z,h,mid=layer(n)
        e=classified('support',n)
        if n in (0,25,200):
            reference=evidence(grouped.get(n,empty),section('support',n),section('model',n))
            area_difference=float(e['footprint'].symmetric_difference(reference['footprint']).area)
            length_difference=abs(e['length']-reference['length'])
            assert area_difference<1e-9 and length_difference<1e-9,('cached evidence changed',n,area_difference,length_difference)
            cache_equivalence.append(dict(layer=n,footprintSymmetricDifferenceMm2=area_difference,pathLengthDifferenceMm=length_difference))
            if equivalence_only:continue
        # Nominal round bead ends can leave tiny near-tangent numeric components;
        # retain every component with positive area and join only at 0.003 mm.
        pp=polys(e['footprint'].buffer(.0015).buffer(-.0015))
        current=[]
        for i,p in enumerate(pp):
            parents=[q for q in previous if p.distance(q['poly'])<=.003]
            if n==0:
                roots={i};all_roots.add(i)
            else:
                roots=set().union(*(q['roots'] for q in parents)) if parents else set()
                if not parents:
                    new_islands.append(dict(layer=n,extrusionZMm=z,areaMm2=float(p.area),xy=list(p.centroid.coords[0])))
            if source['params']['raft_split'] and len(roots)>1:
                reconnections.append(dict(layer=n,extrusionZMm=z,rootGroups=sorted(roots),areaMm2=float(p.area)))
            prior_footprint=union_all([q['poly'] for q in parents],grid_size=GRID)
            current.append(dict(poly=p,roots=roots,priorOverlap=float(grid_intersection(p,prior_footprint,grid_size=GRID).area)))
        if pp:support_layer_count+=1;total_components+=len(pp)
        if mid<pad_top-1e-5:
            expected=2 if source['params']['raft_split'] else 1
            represented=set().union(*(q['roots'] for q in current)) if current else set()
            pad_layers.append(dict(layer=n,extrusionZMm=z,components=len(pp),areasMm2=[float(p.area) for p in pp],connectedPadGroups=len(represented)))
            # Slicer top-skin fragments can be separate in one horizontal layer
            # while bonded to the same pad beneath. The physical requirement is
            # the expected number of grounded 3D groups, not 2D bead polygons.
            if len(represented)!=expected or any(len(q['roots'])!=1 for q in current):flags.append(dict(kind='pad-grounded-group-count',layer=n,expected=expected,observed=len(represented)))
            if len(pp)!=expected:
                pad_fragment_details.append(dict(layer=n,extrusionZMm=z,fragments=[dict(areaMm2=float(q['poly'].area),centroidXY=list(q['poly'].centroid.coords[0]),rootGroups=sorted(q['roots']),precedingLayerOverlapMm2=q['priorOverlap'],precedingLayerOverlapFraction=q['priorOverlap']/q['poly'].area) for q in current]))
                if n>0 and any(q['priorOverlap']<=1e-8 for q in current):flags.append(dict(kind='pad-fragment-without-previous-layer-overlap',layer=n))
            group_polys=[union_all([q['poly'] for q in current if root in q['roots']],grid_size=GRID) for root in sorted(represented)]
            if expected==2 and len(group_polys)==2:
                clearance=group_polys[0].distance(group_polys[1]);min_clearance=clearance if min_clearance is None else min(min_clearance,clearance)
                if clearance<.3:flags.append(dict(kind='narrow-emitted-seam',layer=n,clearanceMm=clearance))
                # Unclassified paths matter here: a native brim or slicer bridge
                # outside the intended support solid could reconnect the halves.
                region=section('support',n).buffer(1.)
                raw=[]
                for row in low_grouped.get(n,empty):
                    line=LineString([(row[1],row[2]),(row[3],row[4])]).intersection(region)
                    if line.length>1e-8:raw.append(line.buffer(row[5]/2))
                all_beads=union_all(raw,grid_size=GRID)
                for component in polys(all_beads.buffer(.0015).buffer(-.0015)):
                    if all(grid_intersection(component,half,grid_size=GRID).area>.001 for half in group_polys):
                        flags.append(dict(kind='unclassified-path-reconnects-raft-halves',layer=n,extrusionZMm=z))
        previous=current
    if equivalence_only:return json.dumps(dict(passed=True,flags=[],summary={'equivalentLayers':len(cache_equivalence)},cachedEvidenceEquivalence=cache_equivalence))
    if pad_only:return json.dumps(dict(passed=not flags,flags=flags,summary=dict(padLayersChecked=len(pad_layers),groundedSupportGroups=len(all_roots),minimumEmittedRaftSeamMm=min_clearance),padLayers=pad_layers,padFragmentDetails=pad_fragment_details))
    if new_islands:flags.append(dict(kind='floating-support-extrusion-islands',count=len(new_islands)))
    if reconnections:flags.append(dict(kind='split-support-groups-reconnected',count=len(reconnections)))
    # The fixture's entire flat original base must have a preceding solid raft
    # witness, beyond the generic 5% new-island screen used for tiny miniature tips.
    base_z=f['modelBaseBedZ']+translation[2]
    candidates=[n for n in grouped if layer(n)[2]>=base_z-1e-6]
    start=min(candidates)
    target=Point(*translation[:2]).buffer(8,96)
    model=classified('model',start,target)
    floor_n=max(n for n in grouped if layer(n)[2]<pad_top-1e-5)
    floor=classified('support',floor_n,target.buffer(.3))
    inner=target.buffer(-.12)
    coverage=float(floor['footprint'].intersection(inner).area/inner.area)
    emitted_coverage=float(floor['footprint'].intersection(model['footprint']).area/model['footprint'].area) if model['footprint'].area else 0
    gap=layer(start)[0]-layer(start)[1]-layer(floor_n)[0]
    base=dict(firstModelLayer=start,firstModelExtrusionZMm=layer(start)[0],raftWitnessZMm=layer(floor_n)[0],nominalEnvelopeGapMm=gap,fullBaseInteriorCoverage=coverage,firstModelEmittedFootprintCoverage=emitted_coverage,modelPathLengthMm=model['length'])
    if coverage<.95 or emitted_coverage<.9 or gap>source['params']['raft_release_gap']+height+1e-5 or model['length']<1:
        flags.append(dict(kind='model-base-foundation',evidence=base))
    foot_layer=min(n for n in grouped if layer(n)[2]>pad_top+1e-5)
    foot_foundations=[]
    for foot in f['footFoundations']:
        center=np.asarray(foot['xy'])+translation[:2]
        disk=Point(*center).buffer(source['params']['foot_diameter']/2,64)
        interior=disk.buffer(-.12)
        foot_paths=classified('support',foot_layer,disk.buffer(.02))
        foundation_paths=classified('support',floor_n,disk.buffer(.3))
        full_coverage=float(foundation_paths['footprint'].intersection(interior).area/interior.area)
        emitted=float(foundation_paths['footprint'].intersection(foot_paths['footprint']).area/foot_paths['footprint'].area) if foot_paths['footprint'].area else 0
        record=dict(node=foot['node'],firstFootLayer=foot_layer,firstFootExtrusionZMm=layer(foot_layer)[0],raftWitnessZMm=layer(floor_n)[0],fullFootInteriorCoverage=full_coverage,emittedFootFootprintCoverage=emitted)
        foot_foundations.append(record)
        if full_coverage<.95 or emitted<.9:flags.append(dict(kind='support-foot-foundation',evidence=record))
    return json.dumps(dict(passed=not flags,flags=flags,summary=dict(padLayersChecked=len(pad_layers),groundedSupportGroups=len(all_roots),supportLayersChecked=support_layer_count,supportComponentsChecked=total_components,newFloatingSupportIslands=len(new_islands),crossGroupReconnects=len(reconnections),minimumEmittedRaftSeamMm=min_clearance,modelBaseFoundation=base,supportFootFoundationsChecked=len(foot_foundations)),supportFootFoundations=foot_foundations,cachedEvidenceEquivalence=cache_equivalence,padLayers=pad_layers,floatingIslands=new_islands,reconnections=reconnections),allow_nan=False)
