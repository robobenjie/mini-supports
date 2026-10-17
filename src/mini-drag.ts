import { Plane, Quaternion, Ray, Vector2, Vector3 } from 'three';
import type { Mini } from './mini.ts';

/** A body drag moves along the plate or freely rotates in the camera's frame. */
export class MiniDrag {
  private plane: Plane;
  private position: Vector3;
  private rotation: Quaternion;
  readonly mini: Mini;
  readonly mode: 'translate' | 'rotate';
  private start: Vector2;
  private hit: Vector3;
  private cameraRotation: Quaternion;
  private rotationSnap: number | null;
  changed = false;
  constructor(
    mini: Mini,
    mode: 'translate' | 'rotate',
    start: Vector2,
    hit: Vector3,
    cameraRotation: Quaternion,
    rotationSnap: number | null,
  ) {
    this.mini=mini;this.mode=mode;this.start=start;this.hit=hit;this.cameraRotation=cameraRotation;this.rotationSnap=rotationSnap;
    this.plane = new Plane(new Vector3(0,0,1),-hit.z);
    this.position = mini.model.position.clone();
    this.rotation = mini.model.quaternion.clone();
  }
  update(pointer: Vector2, ray: Ray): boolean {
    const delta = pointer.clone().sub(this.start);
    if (!this.changed && delta.length() < 3) return false;
    let changed = false;
    if (this.mode === 'translate') {
      const point = ray.intersectPlane(this.plane,new Vector3());
      if (!point) return false;
      this.mini.model.position.copy(this.position).add(point.sub(this.hit));
      changed = this.mini.commitMove();
    } else {
      let angle = delta.length()*.008;
      if (this.rotationSnap) angle = Math.round(angle/this.rotationSnap)*this.rotationSnap;
      const axis = new Vector3(delta.y,delta.x,0).normalize().applyQuaternion(this.cameraRotation);
      this.mini.model.quaternion.copy(new Quaternion().setFromAxisAngle(axis,angle).multiply(this.rotation));
      changed = this.mini.commitRotation(false);
    }
    this.changed ||= changed;
    return changed;
  }
  finish() { if (this.changed && this.mode === 'rotate') this.mini.ground(); }
}
