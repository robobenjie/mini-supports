export interface Footprint { minX: number; minY: number; maxX: number; maxY: number }
export const PART_GAP = 6;

/** Pack new files near the plate's center without moving anything already there. */
export function placeNearby(width: number, height: number, occupied: readonly Footprint[]): Footprint {
  const at = (x: number, y: number): Footprint => ({minX:x-width/2, maxX:x+width/2, minY:y-height/2, maxY:y+height/2});
  if (!occupied.length) return at(0, 0);
  const bounds = occupied.reduce((a,b) => ({minX:Math.min(a.minX,b.minX), minY:Math.min(a.minY,b.minY), maxX:Math.max(a.maxX,b.maxX), maxY:Math.max(a.maxY,b.maxY)}));
  const cx = (bounds.minX+bounds.maxX)/2, cy = (bounds.minY+bounds.maxY)/2;
  let best: Footprint | undefined, bestScore = [Infinity, Infinity, Infinity];
  function consider(x: number, y: number) {
    const candidate = at(x,y);
    if (occupied.some(b => candidate.minX < b.maxX+PART_GAP-1e-6 && candidate.maxX > b.minX-PART_GAP+1e-6 && candidate.minY < b.maxY+PART_GAP-1e-6 && candidate.maxY > b.minY-PART_GAP+1e-6)) return;
    const w = Math.max(bounds.maxX,candidate.maxX)-Math.min(bounds.minX,candidate.minX);
    const h = Math.max(bounds.maxY,candidate.maxY)-Math.min(bounds.minY,candidate.minY);
    // Prefer a roughly square envelope, then fill gaps inside it, then stay central.
    const score = [Math.max(w,h), w*h, (x-cx)**2+(y-cy)**2];
    const difference = score.findIndex((s,i) => Math.abs(s-bestScore[i]) > 1e-6);
    if (difference >= 0 && score[difference] < bestScore[difference]) { best=candidate; bestScore=score; }
  }
  consider(cx,cy);
  // Edge-aligned and centered candidates find useful gaps without a fine grid search.
  for (const b of occupied) {
    for (const x of [b.minX-PART_GAP-width/2, b.maxX+PART_GAP+width/2])
      for (const y of [cy, (b.minY+b.maxY)/2, b.minY+height/2, b.maxY-height/2]) consider(x,y);
    for (const y of [b.minY-PART_GAP-height/2, b.maxY+PART_GAP+height/2])
      for (const x of [cx, (b.minX+b.maxX)/2, b.minX+width/2, b.maxX-width/2]) consider(x,y);
  }
  // The outermost edge always supplies at least one non-overlapping candidate.
  return best!;
}
