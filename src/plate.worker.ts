/// <reference lib="webworker" />
import { DOMParser } from '@xmldom/xmldom';
import { Plate } from './plate';
import { SimplifyPool } from './simplify-pool';
import type { AdditionPlacement, ExportPart, PlateSnapshot } from './plate';
// Workers do not expose the browser's DOMParser; only tiny XML skeletons use it.
Object.assign(globalThis, {DOMParser});
const plate = new Plate();
self.onmessage = async (event: MessageEvent<{type:'import';files:File[];placement?:AdditionPlacement} | {type:'append';addition:PlateSnapshot;requestId:number} | {type:'remove';index:number;requestId:number} | {type:'export';parts:ExportPart[];requestId:number}>) => {
  const requestId=event.data.type!=='import'?event.data.requestId:undefined;
  const progress = (fraction:number,message:string) => self.postMessage({type:'progress',fraction,message,requestId});
  try {
    if (event.data.type === 'import') {
      progress(0,'Reading local files…');
      const inputs = [];
      for (const file of event.data.files) inputs.push({name:file.name,data:await file.arrayBuffer()});
      const pool = new SimplifyPool();
      let result;
      try { result = await plate.load(inputs,progress,event.data.placement,pool.simplify); }
      finally { pool.dispose(); }
      const addition = event.data.placement ? plate.snapshot() : undefined;
      const transfer = new Set(result.minis.flatMap(part=>[part.positions.buffer,...(part.topology?[part.topology.vertices.buffer,part.topology.indices.buffer]:[])]));
      if (addition) for (const source of addition.sources) for (const member of source.members.values()) transfer.add(member.compressed.buffer);
      self.postMessage({type:'imported',result,addition}, {transfer:[...transfer]});
    } else if (event.data.type === 'append') {
      plate.append(event.data.addition);
      self.postMessage({type:'appended',requestId});
    } else if (event.data.type === 'remove') {
      const partCount = plate.remove(event.data.index);
      self.postMessage({type:'removed',requestId,partCount});
    } else {
      const output = plate.export(event.data.parts, progress);
      self.postMessage({type:'exported',output,requestId}, {transfer:[output.buffer]});
    }
  } catch(error) { self.postMessage({type:'error',requestId,message:error instanceof Error?error.message:String(error)}); }
};
