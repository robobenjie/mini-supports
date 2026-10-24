import './style.css';
import { createIcons, Upload, ArrowUpRight, Download, RotateCcw, Rotate3d, Move, Maximize, Layers, X, Check, ChevronDown, Box, SlidersHorizontal, ShieldCheck, Sprout, CircleHelp, LoaderCircle, MoveUpRight, Eye, FileBox, Plus, Trash2 } from 'lucide';
import { Viewer } from './viewer';
import type { Settings, WorkerReply, WorkerRequest } from './types';
import type { PlateSnapshot, PreparedPlate } from './plate';
const icons={Upload,ArrowUpRight,Download,RotateCcw,Rotate3d,Move,Maximize,Layers,X,Check,ChevronDown,Box,SlidersHorizontal,ShieldCheck,Sprout,CircleHelp,LoaderCircle,MoveUpRight,Eye,FileBox,Plus,Trash2};
const icon=(name:string)=>`<i data-lucide="${name}"></i>`;
const $=<T extends HTMLElement=HTMLElement>(selector:string)=>document.querySelector<T>(selector)!;
$('#app').innerHTML=`
<header class="app-header"><a class="brand" href="/" aria-label="Mini Supports home">mini<br/>supports<span class="brand-dot">.</span></a><div class="header-right"><span class="local-badge"><span class="dot"></span> Runs on your device</span><a href="https://github.com/moshinette/arborfdm" target="_blank" rel="noreferrer">ArborFDM ${icon('arrow-up-right')}</a></div></header>
<main class="workspace">
<aside class="sidebar">
<section class="control-section" id="model-controls" hidden>
<div class="file-card" id="file-card" hidden><div class="file-symbol">${icon('file-box')}</div><div class="file-detail"><strong id="file-name"></strong><span id="file-meta"></span></div><button class="icon-button" id="remove-model" title="Clear plate" aria-label="Clear plate">${icon('x')}</button></div>
<details class="model-editor"><summary>Edit model ${icon('chevron-down')}</summary><div class="mini-controls" id="transforms" hidden>
<p id="import-note" class="import-note" hidden></p>
<label class="mini-picker" for="mini-select">Selected mini<select id="mini-select" aria-label="Selected mini"></select></label>
<div id="mini-status" class="mini-status" aria-live="polite"></div>
<div class="segmented transform-tools" role="group" aria-label="Transform tool"><button data-tool="translate" class="selected" aria-pressed="true">${icon('move')} Move</button><button data-tool="rotate" aria-pressed="false">${icon('rotate-3d')} Rotate</button></div>
<div id="move-fields"><div class="angle-fields">${(['x','y','z'] as const).map(axis=>`<label class="angle-${axis}">${axis.toUpperCase()}<span class="input-unit"><input data-position="${axis}" type="number" value="0" step="0.1" ${axis==='z'?'min="0"':''} aria-label="Position ${axis.toUpperCase()} millimeters"/>mm</span></label>`).join('')}</div></div>
<div id="rotate-fields" hidden><div class="angle-fields">${(['x','y','z'] as const).map(axis=>`<label class="angle-${axis}">${axis.toUpperCase()}<span class="input-unit"><input data-angle="${axis}" type="number" value="0" step="0.1" aria-label="Rotation ${axis.toUpperCase()} degrees"/>°</span></label>`).join('')}</div>
<div class="rotation-options"><label><input id="rotation-snap" type="checkbox"/> Snap 15°</label><button id="reset-rotation" class="text-button">Reset rotation</button></div>
</div>
<div class="transform-toolbar"><label>Scale <span class="input-unit"><input id="scale" type="number" value="100" min="1" max="1000" step="5" aria-label="Selected mini scale percent"/>%</span></label><button id="delete-mini" class="secondary" title="Delete selected mini (Delete / Backspace)" aria-label="Delete selected mini">${icon('trash-2')} Delete</button></div>
<p id="transform-hint" class="rotation-hint">Move the model, supports, and raft together. Enter positions in mm; Z is the model’s height above the bed before raft clearance.</p>
</div></details>
</section>
<section class="control-section"><div class="section-heading"><h2><span>01</span>Support settings</h2></div>



<details class="advanced"><summary>${icon('sliders-horizontal')} Fine-tune ${icon('chevron-down')}</summary><div class="advanced-fields"><div class="label-row"><label id="nozzle-label">Nozzle diameter</label><span>mm</span></div><div class="segmented nozzle" role="group" aria-labelledby="nozzle-label"><button data-nozzle="02" class="selected" aria-pressed="true"><span class="nozzle-mark small"></span>0.2 <small>Fine detail</small></button><button data-nozzle="04" aria-pressed="false"><span class="nozzle-mark"></span>0.4 <small>Everyday</small></button></div><label class="toggle-row"><span><strong>Add a raft</strong></span><input id="raft" type="checkbox" checked role="switch"/><span class="switch" aria-hidden="true"></span></label><div class="label-row"><label id="density-label">Support density</label><span id="density-hint">Balanced</span></div><div class="segmented" role="group" aria-labelledby="density-label"><button data-density="light" aria-pressed="false">Light</button><button data-density="normal" class="selected" aria-pressed="true">Balanced</button><button data-density="dense" aria-pressed="false">Dense</button></div><div class="parallel-control"><label for="parallel-parts">Parallel parts</label><select id="parallel-parts" aria-describedby="parallel-hint"></select><p id="parallel-hint"></p></div><p id="support-method" class="rotation-hint">Targeted underside patches with breakaway grips; tapered trees and braces for taller supports.</p><label class="toggle-row"><span><strong>Split large or enclosing rafts</strong><small>Slot pads wider than 12.7 mm; preserve support roots</small></span><input id="raft-split" type="checkbox" checked role="switch"/><span class="switch" aria-hidden="true"></span></label><label class="toggle-row"><span><strong>5 mm patch grid</strong><small>Divide broad patches into smaller removable sections</small></span><input id="patch-grid" type="checkbox" checked role="switch"/><span class="switch" aria-hidden="true"></span></label><label>Overhang angle <span class="input-unit"><input id="overhang" type="number" min="10" max="80" step="1" value="55"/>°</span></label><label>Tip Z gap <span class="input-unit"><input id="gap" type="number" min="0" max="0.4" step="0.01" value="0.06"/>mm</span></label><p>Angles are measured from vertical. A larger tip gap makes removal easier but reduces contact.</p></div></details>
</section>
<div class="sidebar-bottom"><span>Open source</span><a href="https://github.com/robobenjie/mini-supports" id="source-link" target="_blank" rel="noreferrer" title="View source on GitHub (GPL-3.0-or-later)">Source ${icon('arrow-up-right')}</a></div>
</aside>
<section class="stage-panel">
<div class="support-actions" role="group" aria-label="Support actions"><div class="generation-action"><button id="generate" class="primary" disabled><span>Generate supports</span>${icon('arrow-up-right')}</button></div><button class="download" id="download" disabled>${icon('download')} Download 3MF</button><button id="cancel" class="cancel" hidden>Cancel generation</button><div id="generation-progress"><div id="progress-section" class="progress-section" hidden><div><span id="progress-message">Starting engine…</span><span id="progress-percent">0%</span></div><div class="progress-track"><div id="progress-bar" role="progressbar" aria-label="Support generation progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"></div></div><span class="runtime-note" id="elapsed">0:00 elapsed</span></div></div></div>
<input id="file-input" type="file" accept=".stl,.3mf" multiple hidden/>

<div class="viewport-wrap" id="drop-target" role="region" aria-label="Plate preview. Drop STL or 3MF files here."><div id="viewport"></div><div class="viewport-top"><span class="view-label"><span class="dot"></span> PERSPECTIVE <span class="slash">/</span> MM</span><div class="view-tools"><button id="add-models" data-import class="add-models" aria-label="Add STL or 3MF files" title="Add STL or 3MF files">${icon('plus')}<span>Add files</span></button><span></span><button id="xray" class="icon-button" aria-pressed="false" title="Toggle transparent model" aria-label="Toggle transparent model">${icon('eye')}</button><button id="top-view" class="icon-button" title="Top view" aria-label="Top view">${icon('layers')}</button><span></span><button id="fit" class="icon-button" title="Fit model" aria-label="Fit model">${icon('maximize')}</button></div></div>
<div id="empty-state" class="empty-state">${icon('upload')}<h3>Drop models onto the plate</h3><p>STL or 3MF · files stay on your device</p><button id="empty-upload" data-import class="secondary">${icon('plus')} Choose files</button></div>
<div class="model-dimensions" id="dimensions"></div><div class="axis-gizmo" aria-hidden="true"><span class="z">Z</span><span class="y">Y</span><span class="x">X</span><svg viewBox="0 0 70 70"><path d="M35 38V9" stroke="#597a53"/><path d="M35 38 10 53" stroke="#b65d2c"/><path d="M35 38 61 53" stroke="#4b6c91"/><circle cx="35" cy="38" r="3" fill="#44494c"/></svg></div>
<div class="viewport-bottom"><span class="grid-note">10 mm grid</span></div><div class="drop-overlay">${icon('upload')}<strong>Add models to your plate</strong><span>STLs fill nearby spaces on your plate</span></div><div id="import-overlay" class="import-overlay" hidden><section class="import-dialog" role="dialog" aria-modal="true" aria-labelledby="import-title"><h2 id="import-title">Importing models</h2><div id="import-progress"></div><div id="import-actions"></div></section></div></div>
<div class="stage-heading"><h1 id="stage-title">Plate preview</h1><div class="stage-heading-tools"><button class="text-button" id="reset-view">${icon('rotate-ccw')} Reset view</button><button id="help" class="icon-button" aria-label="How it works" title="How it works">${icon('circle-help')}</button></div></div>
<div class="output-panel"><div class="output-header"><div class="output-title"><div><h2>Support summary</h2><p id="output-description">Add models to the plate to generate supports.</p></div></div><span id="status-pill" class="status-pill" aria-live="polite">Awaiting supports</span></div>

<div class="output-bottom"><div class="metrics"><div><span id="contact-count">—</span><small>Contact points</small></div><div><span id="tree-count">—</span><small>Support trees</small></div><div><span id="material-count">—</span><small>Support PLA, est.</small></div></div></div>
<div id="report" class="report" hidden><details><summary id="report-title"></summary><div id="report-list"></div></details></div>
<div class="slicer-note">${icon('layers')} Each mini keeps its original mesh, supports, and raft together. Use your printer and filament preset with automatic supports off. For the 0.2 mm profile: 0.06 mm layers and 6 bottom layers on the model (3 on supports).</div></div>
<footer class="workspace-footer"><span>Modified ArborFDM engine · WebAssembly</span><a href="/LICENSE.txt" target="_blank">GPL-3.0-or-later ${icon('arrow-up-right')}</a></footer>
</section></main>
<div id="toast" role="alert" hidden></div>
<dialog id="help-dialog"><button id="close-help" class="icon-button" aria-label="Close help">${icon('x')}</button><span class="eyebrow">FROM MODEL TO SLICER</span><h2>Using Mini Supports</h2><ol><li><strong>Add STL or 3MF files.</strong> A 3MF keeps its printable parts’ rotations, spacing, and relative heights. The whole arrangement is centered and placed on the bed together. Drop more STLs to place them in nearby spaces while keeping existing supports. Clear the plate to start again. STL units are millimeters; 3MF units are converted automatically.</li><li><strong>Move, rotate, and grow.</strong> Select a mini, then choose Move or Rotate. Drag a mini directly to select and move or rotate it in one gesture. Use the XYZ handles or enter exact positions and angles for precise edits. Delete or Backspace removes the selected mini and its supports. Moving keeps the model, supports, and raft together. Rotation and scaling clear only that mini’s supports. Z is the model’s height above the bed before raft clearance. Generate supports processes only minis that need it.  Our modified ArborFDM engine adds targeted underside patches, breakaway grips, tapered trees, braces, and raft splits locally. The 0.2 mm profile includes the print-tested improvements; the 0.4 mm profile retains the original tree settings.</li><li><strong>Download the 3MF.</strong> Open in OrcaSlicer or Bambu Studio. Each mini is an assembly with aligned model, support, and raft parts. Disable automatic supports, match the selected nozzle, and inspect the layer preview. The 0.2 mm export carries 0.06 mm layer height and six model bottom layers for Bambu Studio / OrcaSlicer; verify these after import, especially if opening geometry only. Printer and filament presets, temperatures, speed, slicing, and sending the print remain in your slicer.</li></ol><p class="help-warning">Experimental, like the upstream project. Geometry checks cannot guarantee a successful print. Import a single plate’s geometry. Each mini can be up to 250 mm after scaling. File size, triangle count, and expanded 3MF model data are uncapped; available browser memory and processing time determine practical capacity. 3MF imports geometry and placement; printer presets, colors, modifiers, and painted supports are not retained. Supports are generated per mini; leave room between minis and inspect overlaps after rotation. Manual contact editing and mesh repair are not included.</p><a href="https://github.com/moshinette/arborfdm" target="_blank" rel="noreferrer">Explore the original project ↗</a></dialog>`;
createIcons({icons});
let viewer:Viewer;
try { viewer=new Viewer($('#viewport')); } catch {
  $('#viewport').innerHTML='<div class="webgl-error">This workspace needs WebGL. Enable hardware acceleration or open it in a current desktop browser.</div>';
  throw new Error('WebGL unavailable');
}
let nozzle='02', density='normal', busy=false, plateWorker:Worker|undefined, pendingImport:Worker|undefined, plateOutput:Uint8Array|undefined;
let modelName='Plate', uploadVersion=0, partCount=0, generationRun=0, plateRequest=0;
let fileNames:string[]=[], has3mf=false, skippedItems=0;
let queue: { id:string; revision:number }[] = [], queueIndex=0, completedJobs=0;
let workers:Worker[]=[];
const activeJobs=new Map<Worker,{name:string;fraction:number}>();
const cpuThreads=Math.max(1,Math.floor(navigator.hardwareConcurrency||2));
const autoWorkers=Math.min(12,Math.max(1,cpuThreads-1));
const parallelParts=$<HTMLSelectElement>('#parallel-parts');
parallelParts.add(new Option(`Auto · up to ${autoWorkers}`, 'auto'));
for(let count=1;count<=cpuThreads;count++)parallelParts.add(new Option(String(count),String(count)));
function workerLimit() {return parallelParts.value==='auto'?autoWorkers:Number(parallelParts.value)}
function trimWorkers(count:number) {
  // Only called while idle or before dispatching a new run. Termination releases
  // the separate Python/WASM heaps when the requested concurrency is reduced.
  for(const worker of workers.splice(count)){worker.onmessage=null;worker.onerror=null;worker.terminate()}
}
function parallelInfo() {
  $('#parallel-hint').textContent=`Up to ${workerLimit()} parts at once · ${cpuThreads} CPU ${cpuThreads===1?'thread':'threads'} available. More parallel parts use more memory.`;
}
parallelParts.onchange=()=>{if(!busy)trimWorkers(workerLimit());parallelInfo()};
parallelInfo();
let startedAt=0, elapsedTimer:ReturnType<typeof setInterval>|undefined;
let progressKind:'generation'|'import'='generation';
let importFocus:HTMLElement|undefined;
const importBackground=Array.from(document.querySelectorAll<HTMLElement>('.app-header,.sidebar,.support-actions,.stage-heading,.output-panel,.workspace-footer,.viewport-wrap > :not(#import-overlay)'));
function showProgress() {
  const importing=busy&&progressKind==='import';
  const overlay=$('#import-overlay'),cancel=$<HTMLButtonElement>('#cancel');
  if(importing&&overlay.hidden)importFocus=document.activeElement instanceof HTMLElement?document.activeElement:undefined;
  const closing=!importing&&!overlay.hidden;
  overlay.hidden=!importing;
  importBackground.forEach(element=>element.inert=importing);
  (importing?$('#import-actions'):$('.support-actions')).append(cancel);
  $('#progress-section').hidden=!startedAt||(progressKind==='import'&&!busy);
  if(importing&&document.activeElement!==cancel)cancel.focus({preventScroll:true});
  if(closing){
    const target=importFocus?.isConnected&&!importFocus.matches(':disabled')?importFocus:$('#add-models');
    target.focus({preventScroll:true});importFocus=undefined;
  }
}
function beginProgress(message:string,kind:'generation'|'import'='generation') {
  progressKind=kind;
  (kind==='import'?$('#import-progress'):$('#generation-progress')).append($('#progress-section'));
  $('#progress-bar').setAttribute('aria-label',kind==='import'?'Import progress':'Support generation progress');
  startedAt=performance.now();clearInterval(elapsedTimer);
  elapsedTimer=setInterval(()=>{$('#elapsed').textContent=`${Math.floor((performance.now()-startedAt)/60000)}:${String(Math.floor((performance.now()-startedAt)/1000)%60).padStart(2,'0')} elapsed`},250);
  updateProgress(0,message);$('#elapsed').textContent='0:00 elapsed';
}
function updateProgress(fraction:number,message:string) {
  const percent=Math.min(100,Math.max(0,Math.round(fraction*100)));
  $('#progress-message').textContent=message;$('#progress-percent').textContent=`${percent}%`;
  $('#progress-bar').style.width=`${percent}%`;$('#progress-bar').setAttribute('aria-valuenow',String(percent));
}

let timer:ReturnType<typeof setTimeout>;
function toast(message:string) {clearTimeout(timer);$('#toast').textContent=message;$('#toast').hidden=false;timer=setTimeout(()=>$('#toast').hidden=true,8000)}
function modelInfo() {
  const size=viewer.dimensions();
  $('#dimensions').textContent=viewer.minis.length?`${size.x.toFixed(1)} × ${size.y.toFixed(1)} × ${size.z.toFixed(1)} mm`:'';
  $('#file-meta').textContent=`${viewer.minis.length} ${viewer.minis.length===1?'mini':'minis'} · ${viewer.triangles().toLocaleString()} triangles`;
}
function selectionInfo(force=false) {
  const selected=viewer.selected, select=$<HTMLSelectElement>('#mini-select');
  // Keep selection and its generation state visible to keyboard and screen-reader users.
  select.replaceChildren(...viewer.minis.map((mini,i)=>{
    const option=document.createElement('option');option.value=mini.id;
    option.textContent=`${i+1}. ${mini.name} — ${mini.result?'supports ready':'needs supports'}`;return option;
  }));
  if(selected) {
    select.value=selected.id;
    const scale=$<HTMLInputElement>('#scale');if(force||document.activeElement!==scale)scale.value=String(selected.scale);
    selected.angles().forEach((angle,i)=>{const input=$<HTMLInputElement>(`[data-angle="${['x','y','z'][i]}"]`);if(force||document.activeElement!==input)input.value=String(Math.round(angle*100)/100)});
    selected.coordinates().forEach((position,i)=>{const input=$<HTMLInputElement>(`[data-position="${['x','y','z'][i]}"]`);if(force||document.activeElement!==input)input.value=String(Math.round(position*100)/100)});
    $('#mini-status').textContent=selected.result?'Supports ready for this mini':'This mini needs supports';
    $('#mini-status').classList.toggle('ready',!!selected.result);
  }
  modelInfo();
}
function renderState() {
  const completed=viewer.minis.filter(mini=>mini.result), pending=viewer.minis.length-completed.length;
  const ready=completed.length>0&&pending===0;
  const summaries=completed.map(mini=>mini.result!.summary);
  const issues=completed.flatMap(mini=>mini.result!.summary.issues.map(issue=>({...issue,message:`${mini.name}: ${issue.message}`})));
  const errors=issues.filter(issue=>issue.severity==='error').length, warnings=issues.filter(issue=>issue.severity==='warning').length;
  $('#contact-count').textContent=completed.length?summaries.reduce((n,s)=>n+s.contacts,0).toLocaleString():'—';
  $('#tree-count').textContent=completed.length?summaries.reduce((n,s)=>n+s.trees,0).toLocaleString():'—';
  $('#material-count').textContent=completed.length?`${summaries.reduce((n,s)=>n+Number(s.stats.support_mass_g??0),0).toFixed(2)} g`:'—';
  if(!busy) {
    $('#status-pill').textContent=!viewer.minis.length?'Add models':pending?(completed.length?`${completed.length}/${viewer.minis.length} minis ready`:'Awaiting supports'):errors?'Ready · errors reported':warnings?'Ready · review notes':'Ready to download';
    $('#status-pill').className=`status-pill ${ready?(errors||warnings?'review':'ready'):''}`;
    $('#output-description').textContent=pending&&completed.length?`${completed.length} ${completed.length===1?'mini keeps its':'minis keep their'} supports. Generate supports for ${pending} changed ${pending===1?'mini':'minis'}.`:ready?`${completed.length} supported ${completed.length===1?'mini':'minis'} · original detail preserved`:viewer.minis.length?'Generate supports for the parts on this plate.':'Add models to the plate to generate supports.';
  }
  $('#generate span').textContent=busy?'Working…':!viewer.minis.length?'Generate supports':pending&&completed.length?`Generate supports (${pending} ${pending===1?'mini':'minis'})`:pending?'Generate supports':'Supports up to date';
  $('#generate').toggleAttribute('disabled',busy||!viewer.minis.length||!pending);
  $('#download').toggleAttribute('disabled',busy||!ready);
  $('#report').hidden=!issues.length;
  $('#report-title').textContent=[`${errors} ${errors===1?'error':'errors'}`,`${warnings} ${warnings===1?'warning':'warnings'}`,`${issues.filter(i=>i.severity==='info').length} ${issues.filter(i=>i.severity==='info').length===1?'note':'notes'}`].join(' · ');
  $('#report-list').replaceChildren();
  for(const issue of issues){const el=document.createElement('p');el.className=issue.severity;const label=document.createElement('strong');label.textContent=issue.severity.toUpperCase();el.append(label,document.createTextNode(' '+issue.message));$('#report-list').append(el)}
  selectionInfo();
}
function invalidatePlate() {plateOutput=undefined;renderState()}
function invalidateAll() {viewer.invalidateAll();invalidatePlate()}
viewer.onSelection=()=>selectionInfo(true);
viewer.onEdit=invalidatePlate;
function setBusy(value:boolean) {
  busy=value;viewer.setLocked(value);
  if(!value){clearInterval(elapsedTimer);if(startedAt)$('#elapsed').textContent=`Completed in ${((performance.now()-startedAt)/1000).toFixed(1)}s`;}
  document.querySelectorAll<HTMLButtonElement|HTMLInputElement|HTMLSelectElement>('.sidebar button,.sidebar input,.sidebar select,[data-import]').forEach(e=>e.disabled=value);
  $<HTMLInputElement>('#raft-split').disabled=value||!$<HTMLInputElement>('#raft').checked;
  $('#cancel').hidden=!value;$<HTMLButtonElement>('#cancel').disabled=false;
  $('#generate').classList.toggle('working',value);renderState();showProgress();
}
function updateImportNote() {
    $('#import-note').hidden=!has3mf;
    $('#import-note').textContent=`${partCount} parts in ${viewer.minis.length} selectable ${viewer.minis.length===1?'mini':'minis'}. 3MF arrangements preserved. Fast analysis uses a 0.02 mm simplification target; original mesh detail is preserved in the download. Slicer settings are not imported.${skippedItems?` ${skippedItems} non-printable items skipped.`:''}`;
}
async function loadFiles(files:File[], append=viewer.minis.length>0&&files.every(file=>/\.stl$/i.test(file.name))) {
  if(!files.length||busy)return;
  const version=++uploadVersion;
  beginProgress('Reading local files…','import');setBusy(true);$('#cancel').textContent='Cancel import';
  try {
    if(files.some(f=>! /\.(stl|3mf)$/i.test(f.name)))throw new Error('Please choose STL (ASCII or binary) or 3MF files.');
    pendingImport=new Worker(new URL('./plate.worker.ts',import.meta.url),{type:'module'});
    const candidate=pendingImport;
    const {result:imported,addition}=await new Promise<{result:PreparedPlate;addition?:PlateSnapshot}>((resolve,reject)=>{
      candidate.onmessage=event=>{
        if(version!==uploadVersion)return;
        const message=event.data;
        if(message.type==='progress')updateProgress(message.fraction,message.message);
        else if(message.type==='imported')resolve(message);
        else if(message.type==='error')reject(new Error(message.message));
      };
      candidate.onerror=event=>reject(new Error(event.message||'Import failed.'));
      candidate.postMessage({type:'import',files,placement:append?viewer.additionPlacement():undefined});
    });
    if(version!==uploadVersion)return;
    if(append) {
      if(!plateWorker||!addition)throw new Error('The plate changed. Add the files again.');
      // Parsing is isolated in the candidate. Only commit after it succeeds, so
      // cancelling or rejecting an addition never destroys the current plate.
      $<HTMLButtonElement>('#cancel').disabled=true;
      const current=plateWorker,requestId=++plateRequest;
      await new Promise<void>((resolve,reject)=>{
        current.onmessage=event=>{if(event.data.requestId!==requestId)return;if(event.data.type==='appended')resolve();else if(event.data.type==='error')reject(new Error(event.data.message))};
        current.onerror=event=>reject(new Error(event.message||'Could not add the models.'));
        const buffers=new Set(addition.sources.flatMap(source=>[...source.members.values()].map(member=>member.compressed.buffer)));
        current.postMessage({type:'append',addition,requestId},[...buffers]);
      });
      candidate.terminate();
    } else {plateWorker?.terminate();plateWorker=candidate;}
    pendingImport=undefined;
    viewer.loadPrepared(imported,append);
    partCount=(append?partCount:0)+imported.partCount;
    has3mf=(append&&has3mf)||imported.has3mf;
    skippedItems=(append?skippedItems:0)+imported.skippedItems;
    fileNames=[...(append?fileNames:[]),...files.map(f=>f.name)];modelName=fileNames.length===1?fileNames[0].replace(/\.(stl|3mf)$/i,''):`${viewer.minis.length} miniatures`;
    updateImportNote();
    $('#file-name').textContent=fileNames.length===1?fileNames[0]:`${fileNames.length} files`;$('#file-name').title=fileNames.join(', ');
    $('#stage-title').textContent=modelName;
    $('#model-controls').hidden=false;$('#file-card').hidden=false;$('#transforms').hidden=false;$('#empty-state').hidden=true;
    invalidatePlate();setBusy(false);
    if(append)updateProgress(1,`Added ${imported.minis.length} ${imported.minis.length===1?'mini':'minis'} · existing parts and supports kept`);
  }catch(e){pendingImport?.terminate();pendingImport=undefined;setBusy(false);toast(e instanceof Error?e.message:String(e))}
}
for(const button of document.querySelectorAll<HTMLButtonElement>('[data-import]'))button.onclick=()=>$('#file-input').click();
$('#file-input').onchange=(e)=>{const input=e.target as HTMLInputElement;void loadFiles(Array.from(input.files??[]));input.value=''};
function clearPlate() {
  ++uploadVersion;startedAt=0;plateWorker?.terminate();plateWorker=undefined;viewer.clear();invalidatePlate();partCount=0;fileNames=[];has3mf=false;skippedItems=0;
  $('#import-note').hidden=true;$('#file-card').hidden=true;$('#transforms').hidden=true;$('#empty-state').hidden=false;$('#model-controls').hidden=true;$('#stage-title').textContent='Plate preview';setBusy(false);
}
$('#remove-model').onclick=clearPlate;
async function deleteSelected() {
  if(busy||viewer.isManipulating()||!viewer.selected||!plateWorker)return;
  if(viewer.minis.length===1){clearPlate();return}
  const mini=viewer.selected,index=viewer.minis.indexOf(mini),current=plateWorker,requestId=++plateRequest;
  beginProgress('Removing selected mini…');setBusy(true);$('#cancel').hidden=true;
  try {
    partCount=await new Promise<number>((resolve,reject)=>{
      current.onmessage=event=>{const message=event.data;if(message.requestId!==requestId)return;if(message.type==='removed')resolve(message.partCount);else if(message.type==='error')reject(new Error(message.message))};
      current.onerror=event=>reject(new Error(event.message||'Could not remove the mini.'));
      current.postMessage({type:'remove',index,requestId});
    });
    viewer.remove(mini.id);invalidatePlate();
    modelName=viewer.minis.length===1?viewer.minis[0].name:`${viewer.minis.length} miniatures`;$('#stage-title').textContent=modelName;$('#file-name').textContent=`${viewer.minis.length} ${viewer.minis.length===1?'mini':'minis'}`;
    updateImportNote();updateProgress(1,`Removed ${mini.name}`);setBusy(false);
  } catch(error) {setBusy(false);toast(error instanceof Error?error.message:String(error))}
}
$('#delete-mini').onclick=()=>void deleteSelected();
window.addEventListener('keydown',event=>{
  if(!['Delete','Backspace'].includes(event.key)||event.repeat||event.ctrlKey||event.metaKey||event.altKey||document.querySelector('dialog[open]'))return;
  const target=event.target;
  if(target instanceof HTMLElement&&(target.closest('input,textarea,select')||target.isContentEditable))return;
  if(!viewer.selected||busy||viewer.isManipulating())return;
  event.preventDefault();void deleteSelected();
});
let dragDepth=0;
const dropTarget=$('#drop-target');
dropTarget.addEventListener('dragenter',e=>{if(e.dataTransfer?.types.includes('Files')){e.preventDefault();dragDepth++;if(!busy)dropTarget.classList.add('dragover')}});
dropTarget.addEventListener('dragleave',()=>{dragDepth=Math.max(0,dragDepth-1);if(!dragDepth)dropTarget.classList.remove('dragover')});
document.addEventListener('dragover',e=>{if(e.dataTransfer?.types.includes('Files'))e.preventDefault()});
document.addEventListener('drop',e=>{e.preventDefault();dragDepth=0;dropTarget.classList.remove('dragover');if(e.dataTransfer&&e.target instanceof Node&&dropTarget.contains(e.target))void loadFiles(Array.from(e.dataTransfer.files))});
for(const button of document.querySelectorAll<HTMLButtonElement>('[data-nozzle]'))button.onclick=()=>{
  nozzle=button.dataset.nozzle!;document.querySelectorAll<HTMLButtonElement>('[data-nozzle]').forEach(b=>{b.classList.toggle('selected',b===button);b.setAttribute('aria-pressed',String(b===button))});
  $('#support-method').textContent=nozzle==='02'?'Targeted underside patches with breakaway grips; tapered trees and braces for taller supports.':'Original 0.4 mm tree profile. The patch and grip print tests used a 0.2 mm nozzle.';
  $<HTMLInputElement>('#gap').value='0.06';invalidateAll();
};
for(const button of document.querySelectorAll<HTMLButtonElement>('[data-density]'))button.onclick=()=>{
  density=button.dataset.density!;document.querySelectorAll<HTMLButtonElement>('[data-density]').forEach(b=>{b.classList.toggle('selected',b===button);b.setAttribute('aria-pressed',String(b===button))});
  $('#density-hint').textContent=density==='light'?'Fewer contact marks':density==='dense'?'More contact points':'Balanced';invalidateAll();
};
for(const id of ['raft','raft-split','patch-grid','overhang','gap'])$('#'+id).addEventListener('input',()=>{
  $<HTMLInputElement>('#raft-split').disabled=busy||!$<HTMLInputElement>('#raft').checked;
  invalidateAll();
});
$('#mini-select').onchange=()=>viewer.select($<HTMLSelectElement>('#mini-select').value);
$('#scale').onchange=()=>{const input=$<HTMLInputElement>('#scale');if(!input.checkValidity()||!Number.isFinite(input.valueAsNumber)){input.value=String(viewer.selected?.scale??100);return}viewer.setScale(input.valueAsNumber)};
for(const input of document.querySelectorAll<HTMLInputElement>('[data-angle]')) {
  input.oninput=()=>{if(Number.isFinite(input.valueAsNumber))viewer.rotate(input.dataset.angle as 'x'|'y'|'z',input.valueAsNumber)};
  input.onchange=()=>{if(!Number.isFinite(input.valueAsNumber))input.value=String(viewer.selected?.angles()[['x','y','z'].indexOf(input.dataset.angle!)]??0)};
}
$('#reset-rotation').onclick=()=>viewer.resetRotation();
$('#rotation-snap').onchange=()=>viewer.transformTool.setRotationSnap($<HTMLInputElement>('#rotation-snap').checked?Math.PI/12:null);
for(const input of document.querySelectorAll<HTMLInputElement>('[data-position]')) {
  input.oninput=()=>{if(input.checkValidity()&&Number.isFinite(input.valueAsNumber))viewer.move(input.dataset.position as 'x'|'y'|'z',input.valueAsNumber)};
  input.onblur=()=>selectionInfo(true);
}
for(const button of document.querySelectorAll<HTMLButtonElement>('[data-tool]'))button.onclick=()=>{
  const mode=button.dataset.tool as 'translate'|'rotate';viewer.setTool(mode);
  document.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach(b=>{b.classList.toggle('selected',b===button);b.setAttribute('aria-pressed',String(b===button))});
  $('#move-fields').hidden=mode!=='translate';$('#rotate-fields').hidden=mode!=='rotate';
  $('#transform-hint').textContent=mode==='translate'?'Move the model, supports, and raft together. Enter positions in mm; Z is the model’s height above the bed before raft clearance.':'Drag a mini to rotate freely, or use an XYZ ring or exact angles. Only this mini’s supports are cleared.';
};
$('#fit').onclick=()=>viewer.home();$('#reset-view').onclick=()=>viewer.home();$('#top-view').onclick=()=>viewer.home(true);
$('#xray').onclick=()=>{const enabled=$('#xray').getAttribute('aria-pressed')!=='true';$('#xray').setAttribute('aria-pressed',String(enabled));viewer.xray(enabled)};
$('#help').onclick=()=>$<HTMLDialogElement>('#help-dialog').showModal();$('#close-help').onclick=()=>$<HTMLDialogElement>('#help-dialog').close();
$('#import-overlay').addEventListener('keydown',event=>{
  if(event.key==='Escape'){event.preventDefault();$('#cancel').click();}
  if(event.key==='Tab'){event.preventDefault();$('#cancel').focus();}
});
$('#cancel').onclick=()=>{
  generationRun++;uploadVersion++;queue=[];workers.forEach(w=>w.terminate());workers=[];activeJobs.clear();
  pendingImport?.terminate();pendingImport=undefined;setBusy(false);updateProgress(0,'Cancelled — completed minis keep their supports');
  toast('Cancelled. Completed minis keep their supports.');
};
function settings(name:string):Settings {return{profile:`nozzle_${nozzle}_${density}`,raft:$<HTMLInputElement>('#raft').checked,raftSplit:$<HTMLInputElement>('#raft-split').checked,patchGrid:$<HTMLInputElement>('#patch-grid').checked,overhang:$<HTMLInputElement>('#overhang').valueAsNumber,gap:$<HTMLInputElement>('#gap').valueAsNumber,name}}
function failure(message:string) {
  generationRun++;queue=[];workers.forEach(w=>w.terminate());workers=[];activeJobs.clear();setBusy(false);
  const lines=message.trim().split('\n');updateProgress(0,'Generation stopped');toast(lines.at(-1)||'Generation failed.');console.error(message);
}
function packPlate() {
  if(!plateWorker){failure('Import the plate again before exporting.');return}
  updateProgress(0,'Packing original model detail…');
  const run=generationRun,requestId=++plateRequest;
  plateWorker.onmessage=event=>{
    if(run!==generationRun||!busy)return;
    const message=event.data;if(message.requestId!==requestId)return;
    if(message.type==='progress')updateProgress(message.fraction,message.message);
    else if(message.type==='exported'){plateOutput=message.output;updateProgress(1,`${viewer.minis.length} ${viewer.minis.length===1?'part':'parts'} ready · original detail preserved`);setBusy(false);savePlate()}
    else if(message.type==='error')failure(message.message);
  };
  plateWorker.onerror=event=>{if(run===generationRun&&busy)failure(event.message||'Plate export failed.')};
  plateWorker.postMessage({type:'export',requestId,parts:viewer.minis.map(mini=>({output:mini.result!.output,lift:-mini.result!.summary.plateZ,transform:mini.exportTransform(),supportOffset:mini.exportSupportOffset(),name:mini.name}))});
}
function finishGeneration() {
  updateProgress(1,`${viewer.minis.length} / ${viewer.minis.length} · Supports ready`);
  setBusy(false);
}
function nextMini(worker:Worker) {
  activeJobs.delete(worker);
  if(queueIndex>=queue.length){if(completedJobs===queue.length)finishGeneration();else generationProgress();return}
  const entry=queue[queueIndex++],mini=viewer.minis.find(m=>m.id===entry.id)!;
  activeJobs.set(worker,{name:mini.name,fraction:0});
  generationProgress();
  const data=mini.exportMesh();const request:WorkerRequest={type:'generate',id:mini.id,revision:entry.revision,data,settings:settings(mini.name)};
  worker.postMessage(request,data instanceof ArrayBuffer?[data]:[data.vertices,data.indices]);
}
function generationProgress(detail='Growing supports…') {
  const fraction=(completedJobs+[...activeJobs.values()].reduce((n,j)=>n+j.fraction,0))/queue.length;
  updateProgress(fraction,`${completedJobs} / ${queue.length} · ${detail}`);
}
$('#generate').onclick=()=>{
  if(busy||!viewer.minis.length)return;
  const overhang=$<HTMLInputElement>('#overhang'),gap=$<HTMLInputElement>('#gap');
  if(!overhang.checkValidity()||!gap.checkValidity()||!Number.isFinite(overhang.valueAsNumber)||!Number.isFinite(gap.valueAsNumber)){toast('Use an overhang angle from 10–80° and a tip gap from 0–0.4 mm.');return}
  invalidatePlate();queue=viewer.minis.filter(mini=>!mini.result).map(mini=>({id:mini.id,revision:mini.revision}));queueIndex=0;completedJobs=0;activeJobs.clear();
  beginProgress('Starting local engine…');setBusy(true);$('#cancel').textContent='Cancel generation';$('#status-pill').textContent='Growing…';
  const run=++generationRun;
  if(!queue.length){finishGeneration();return}
  const count=Math.min(queue.length,workerLimit());
  trimWorkers(count);
  while(workers.length<count)workers.push(new Worker(new URL('./engine.worker.ts',import.meta.url),{type:'module'}));
  for(const worker of workers.slice(0,count)){
    worker.onmessage=(event:MessageEvent<WorkerReply>)=>{
      if(run!==generationRun||!busy)return;
      const message=event.data;
      if(message.type==='progress'){
        const job=activeJobs.get(worker);if(!job)return;job.fraction=Math.max(job.fraction,message.fraction);
        generationProgress(message.message);
      }else if(message.type==='result'){
        if(!viewer.applyResult(message.id,message.revision,message.result)){failure('The mini changed during generation. Grow its supports again.');return}
        completedJobs++;renderState();nextMini(worker);
      }else if(message.type==='error')failure(message.message);
    };
    worker.onerror=event=>{if(run===generationRun&&busy)failure(event.message||'Could not start the engine.')};
    nextMini(worker);
  }
};
$('#download').onclick=()=>{
  if(busy||!viewer.minis.length||viewer.minis.some(mini=>!mini.result))return;
  if(plateOutput){savePlate();return}
  generationRun++;beginProgress('Packing original model detail…');setBusy(true);
  $('#cancel').textContent='Cancel export';
  packPlate();
};
function savePlate() {
  if(!plateOutput)return;
  const blob=new Blob([plateOutput.slice().buffer],{type:'model/3mf'}),url=URL.createObjectURL(blob);
  const a=document.createElement('a');a.href=url;a.download=`${modelName.replace(/[^a-zA-Z0-9_-]/g,'-')}-supported.3mf`;a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);
}
window.addEventListener('keydown',e=>{if(e.key==='Enter'&&(e.target===document.body||e.target===$('#generate')))$('#generate').click()});
setBusy(false);
