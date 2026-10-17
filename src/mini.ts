import { Box3, Group, Matrix4, MathUtils, Mesh, MeshStandardMaterial, Quaternion, Vector3 } from 'three';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import type { ImportedMini } from './model-import.ts';
import type { IndexedMesh } from './simplify';
import type { EngineResult } from './types.ts';

/** Each mini owns its transform, generation revision, and immutable support result. */
export class Mini {
  readonly root = new Group();
  readonly model: Mesh;
  supports?: Mesh;
  raft?: Mesh;
  result?: EngineResult;
  revision = 0;
  scale = 100;
  private floor: number;
  private readonly position = new Vector3();
  private readonly supportOffset = new Vector3();
  private readonly rotation = new Quaternion();
  readonly id: string;
  readonly name: string;
  readonly originalTriangles: number;
  private readonly importedCenter: Vector3;
  private readonly topology?: IndexedMesh;
  constructor(id: string, name: string, imported: ImportedMini) {
    this.id = id; this.name = name;
    imported.geometry.computeBoundingBox();
    const bounds = imported.geometry.boundingBox!, center = bounds.getCenter(new Vector3());
    this.floor = bounds.min.z;
    this.importedCenter = center.clone();
    this.topology=imported.topology;
    if(this.topology)for(let i=0;i<this.topology.vertices.length;i+=3){this.topology.vertices[i]-=center.x;this.topology.vertices[i+1]-=center.y;this.topology.vertices[i+2]-=center.z}
    this.originalTriangles = imported.triangles ?? imported.geometry.getAttribute('position').count / 3;
    imported.geometry.translate(-center.x, -center.y, -center.z);
    this.model = new Mesh(imported.geometry, new MeshStandardMaterial({ color: 0xd5d0bf, roughness: .64, metalness: .12 }));
    this.model.position.copy(center); this.position.copy(center); this.root.add(this.model);
    this.model.userData.miniId = id;
  }
  private remove(mesh?: Mesh) { if (mesh) { this.root.remove(mesh); mesh.geometry.dispose(); (mesh.material as MeshStandardMaterial).dispose(); } }
  invalidate() {
    this.revision++; this.result = undefined;
    this.remove(this.supports); this.remove(this.raft); this.supports = this.raft = undefined;
    this.root.position.z = 0;
    this.supportOffset.set(0, 0, 0);
  }
  /** Called by the numeric controls and by TransformControls after an actual edit. */
  commitRotation(ground = true): boolean {
    if (1 - Math.abs(this.rotation.dot(this.model.quaternion)) < 1e-12) return false;
    this.rotation.copy(this.model.quaternion);
    this.invalidate(); if (ground) this.ground(); return true;
  }
  setRotation(axis: 'x' | 'y' | 'z', degrees: number): boolean {
    this.model.rotation[axis] = MathUtils.degToRad(degrees);
    return this.commitRotation();
  }
  angles(): number[] { return [this.model.rotation.x, this.model.rotation.y, this.model.rotation.z].map(MathUtils.radToDeg); }
  /** XY is the model center; Z is its height above the bed before raft clearance. */
  coordinates(): number[] { return [this.model.position.x, this.model.position.y, this.floor]; }
  commitMove(): boolean {
    const dz = this.model.position.z - this.position.z;
    const floor = Math.max(0, this.floor + dz);
    this.model.position.z += floor - this.floor - dz;
    if (this.position.distanceToSquared(this.model.position) < 1e-12) return false;
    const delta = this.model.position.clone().sub(this.position);
    this.floor = floor;
    this.position.copy(this.model.position);
    this.revision++;
    if (this.result) {
      this.supportOffset.add(delta);
      this.supports?.position.add(delta); this.raft?.position.add(delta);
    }
    this.root.updateMatrixWorld(true);
    return true;
  }
  setPosition(axis: 'x' | 'y' | 'z', value: number): boolean {
    if (!Number.isFinite(value)) return false;
    if (axis === 'z') this.model.position.z += value - this.floor;
    else this.model.position[axis] = value;
    return this.commitMove();
  }
  setScale(percent: number): boolean {
    if (percent === this.scale) return false;
    this.scale = percent; this.model.scale.setScalar(percent / 100);
    this.invalidate(); this.ground(); return true;
  }
  ground() {
    // Keep XY placement and the imported height above the bed. Only this mini moves.
    this.root.updateMatrixWorld(true);
    const bounds = new Box3().setFromObject(this.model, true);
    this.model.position.z += this.floor - bounds.min.z;
    this.model.updateMatrixWorld(true);
    this.position.copy(this.model.position);
  }
  applyResult(result: EngineResult, revision: number): boolean {
    if (revision !== this.revision) return false;
    this.supportOffset.set(0, 0, 0);
    this.remove(this.supports); this.remove(this.raft); this.supports = this.raft = undefined;
    const loader = new STLLoader();
    if (result.supports) this.supports = new Mesh(loader.parse(result.supports.slice().buffer), new MeshStandardMaterial({ color: 0xb2e88f, roughness: .52, metalness: .08 }));
    if (result.raft) this.raft = new Mesh(loader.parse(result.raft.slice().buffer), new MeshStandardMaterial({ color: 0x658761, roughness: .8 }));
    if (this.supports) this.root.add(this.supports);
    if (this.raft) this.root.add(this.raft);
    this.result = result;
    // The engine works below Z=0 for raft clearance. Each completed assembly rests
    // on the shared bed without changing any other mini's placement or support data.
    this.root.position.z = -result.summary.plateZ;
    this.root.updateMatrixWorld(true);
    return true;
  }
  exportTransform(): number[] {
    this.model.updateMatrix();
    return this.model.matrix.clone().multiply(new Matrix4().makeTranslation(-this.importedCenter.x,-this.importedCenter.y,-this.importedCenter.z)).toArray();
  }
  exportSupportOffset(): number[] { return this.supportOffset.toArray(); }
  exportMesh(): ArrayBuffer | {vertices:ArrayBuffer;indices:ArrayBuffer} {
    if(!this.topology)return this.exportSTL();
    this.model.updateMatrix();
    const vertices=this.topology.vertices.slice(),point=new Vector3();
    for(let i=0;i<vertices.length;i+=3){point.fromArray(vertices,i).applyMatrix4(this.model.matrix);vertices.set([point.x,point.y,point.z],i)}
    return {vertices:vertices.buffer,indices:this.topology.indices.slice().buffer};
  }
  exportSTL(): ArrayBuffer {
    // Exclude the display lift; generation always uses the editable model's frame.
    this.model.updateMatrix();
    const geometry = this.model.geometry.clone().applyMatrix4(this.model.matrix);
    const data = new STLExporter().parse(new Mesh(geometry), { binary: true }).buffer as ArrayBuffer;
    geometry.dispose(); return data;
  }
  dispose() {
    this.remove(this.supports); this.remove(this.raft); this.remove(this.model);
    this.root.removeFromParent();
  }
}
