import type { PreparedPlate } from './plate';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { importModels, type ModelInput } from './model-import.ts';
import { Mini } from './mini.ts';
import { MiniDrag } from './mini-drag.ts';
import type { EngineResult } from './types.ts';

export class Viewer {
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(35, 1, .05, 5000);
  renderer: THREE.WebGLRenderer;
  controls: OrbitControls;
  transformTool: TransformControls;
  minis: Mini[] = [];
  selected?: Mini;
  onSelection = () => {};
  onEdit = () => {};
  onPlacement = () => {};
  grid: THREE.GridHelper;
  plate: THREE.Mesh;
  private width = 180;
  private locked = false;
  private transparent = false;
  private visible = { model: true, supports: true, raft: true };
  private nextMiniId = 1;
  private bodyDrag?: { pointerId: number; drag: MiniDrag };
  constructor(public container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); this.renderer.setClearColor(0x000000, 0);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace; this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.25; container.append(this.renderer.domElement);
    const canvas = this.renderer.domElement;
    canvas.tabIndex = 0;
    canvas.setAttribute('aria-label', 'Interactive 3D preview. Drag a mini to select and move or rotate it. XYZ handles constrain the axis. Delete removes the selected mini. Drag empty space to orbit.');
    this.camera.up.set(0, 0, 1);
    this.controls = new OrbitControls(this.camera, canvas); this.controls.enableDamping = true; this.controls.maxPolarAngle = Math.PI * .94;
    this.transformTool = new TransformControls(this.camera, canvas);
    this.transformTool.setMode('translate'); this.transformTool.setSpace('world'); this.transformTool.setSize(.9);
    this.scene.add(this.transformTool.getHelper());
    this.transformTool.addEventListener('dragging-changed', event => { this.controls.enabled = !event.value; });
    this.transformTool.addEventListener('objectChange', () => {
      if (this.locked || !this.selected) return;
      const changed = this.transformTool.mode === 'translate' ? this.selected.commitMove() : this.selected.commitRotation(false);
      if (changed) { this.refreshMaterials(); this.onEdit(); }
    });
    this.transformTool.addEventListener('mouseUp', () => {
      if (!this.locked && this.selected) {
        if (this.transformTool.mode === 'rotate') this.selected.ground();
        this.fitPlate(); this.onSelection();
        if (this.transformTool.mode === 'translate') this.onPlacement();
      }
    });
    const rayAt = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      const ray = new THREE.Raycaster();
      ray.setFromCamera(new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1), this.camera);
      return ray;
    };
    canvas.addEventListener('pointerdown', event => {
      if (this.bodyDrag) { event.stopImmediatePropagation(); return; }
      if (this.locked || event.button !== 0 || this.transformTool.dragging) return;
      this.scene.updateMatrixWorld(true);
      const ray = rayAt(event);
      const hit = ray.intersectObjects(this.minis.filter(m => m.model.visible).map(m => m.model), false)[0];
      if (!hit) { canvas.focus({preventScroll:true}); return; }
      // Keep handles on the selected mini usable. A different mini's body takes
      // priority so selection and manipulation can begin in the same gesture.
      if (hit.object === this.selected?.model && this.transformTool.axis) { canvas.focus({preventScroll:true}); return; }
      this.select(hit.object.userData.miniId);
      this.transformTool.axis = null;
      this.bodyDrag = {pointerId:event.pointerId, drag:new MiniDrag(this.selected!,this.transformTool.mode as 'translate'|'rotate',new THREE.Vector2(event.clientX,event.clientY),hit.point,this.camera.quaternion.clone(),this.transformTool.rotationSnap)};
      this.controls.enabled = false;
      canvas.setPointerCapture(event.pointerId); canvas.focus({preventScroll:true});
      event.preventDefault(); event.stopImmediatePropagation();
    }, {capture:true});
    canvas.addEventListener('pointermove', event => {
      if (!this.bodyDrag || this.bodyDrag.pointerId !== event.pointerId) return;
      if (this.bodyDrag.drag.update(new THREE.Vector2(event.clientX,event.clientY),rayAt(event).ray)) {
        this.refreshMaterials(); this.onEdit();
      }
      event.preventDefault(); event.stopImmediatePropagation();
    }, {capture:true});
    const finishDrag = (event: PointerEvent) => {
      if (!this.bodyDrag || this.bodyDrag.pointerId !== event.pointerId) return;
      const {drag} = this.bodyDrag; this.bodyDrag = undefined;
      drag.finish();
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      this.controls.enabled = true;
      if (drag.changed) { this.fitPlate(); this.onSelection(); if (drag.mode === 'translate') this.onPlacement(); }
      event.stopImmediatePropagation();
    };
    canvas.addEventListener('pointerup',finishDrag,{capture:true});
    canvas.addEventListener('pointercancel',finishDrag,{capture:true});
    canvas.addEventListener('lostpointercapture',finishDrag);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x697078, 2.3));
    for (const [pos, intensity] of [[[-40, -50, 100], 3], [[60, 30, 70], 2]] as const) {
      const light = new THREE.DirectionalLight(0xffffff, intensity); light.position.set(pos[0], pos[1], pos[2]); this.scene.add(light);
    }
    this.grid = new THREE.GridHelper(180, 18, 0x969ea3, 0xb9bfc3); this.grid.rotation.x = Math.PI / 2; this.scene.add(this.grid);
    this.plate = new THREE.Mesh(new THREE.PlaneGeometry(180, 180), new THREE.MeshBasicMaterial({ color: 0xd6dadd, transparent: true, opacity: .7, side: THREE.DoubleSide }));
    this.plate.position.z = -.08; this.scene.add(this.plate);
    const resize = () => { const { width, height } = container.getBoundingClientRect(); this.renderer.setSize(width, height); this.camera.aspect = width / height; this.camera.updateProjectionMatrix(); };
    new ResizeObserver(resize).observe(container); resize(); this.home();
    this.renderer.setAnimationLoop(() => { if (this.controls.enabled) this.controls.update(); this.renderer.render(this.scene, this.camera); });
  }
  load(inputs: ModelInput[]) {
    const imported = importModels(inputs);
    this.clear();
    this.minis = imported.minis.map(part => new Mini(`mini-${this.nextMiniId++}`, part.name, part));
    imported.geometry.dispose();
    for (const mini of this.minis) this.scene.add(mini.root);
    this.select(this.minis[0]?.id); this.fitPlate(); this.home();
    return imported;
  }
  loadPrepared(imported: PreparedPlate, append = false) {
    if (!append) this.clear();
    const added = imported.minis.map(part => {
      const geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(part.positions,3));
      geometry.computeVertexNormals();
      return new Mini(`mini-${this.nextMiniId++}`, part.name, {name:part.name,geometry,triangles:part.triangles,topology:part.topology});
    });
    this.minis.push(...added);
    for (const mini of added) this.scene.add(mini.root);
    this.select(added[0]?.id); this.fitPlate(); this.home();
  }
  additionPlacement() {
    return {occupied:this.minis.map(mini=>{
      mini.root.updateMatrixWorld(true);
      const bounds = new THREE.Box3().setFromObject(mini.root,true);
      return {minX:bounds.min.x,minY:bounds.min.y,maxX:bounds.max.x,maxY:bounds.max.y};
    })};
  }
  isManipulating() { return !!this.bodyDrag || this.transformTool.dragging; }
  remove(id: string) {
    const index = this.minis.findIndex(mini=>mini.id===id);
    if (index < 0) return;
    this.transformTool.detach();
    this.minis.splice(index,1)[0].dispose();
    this.select(this.minis[Math.min(index,this.minis.length-1)]?.id); this.fitPlate();
  }
  clear() { this.transformTool.detach(); this.minis.forEach(mini => mini.dispose()); this.minis = []; this.selected = undefined; this.home(); }
  select(id?: string) { this.selected = this.minis.find(mini => mini.id === id); this.refreshMaterials(); this.updateTool(); this.onSelection(); }
  setLocked(value: boolean) { this.locked = value; this.updateTool(); }
  setTool(mode: 'translate' | 'rotate') { this.transformTool.setMode(mode); this.updateTool(); }
  private updateTool() {
    this.transformTool.enabled = !this.locked && this.visible.model;
    if (this.selected && this.transformTool.enabled) this.transformTool.attach(this.selected.model); else this.transformTool.detach();
  }
  private refreshMaterials() {
    for (const mini of this.minis) {
      const material = mini.model.material as THREE.MeshStandardMaterial;
      material.emissive.setHex(mini === this.selected ? 0x191b1e : 0x000000);
      material.transparent = this.transparent; material.opacity = this.transparent ? .27 : 1;
      material.depthWrite = !this.transparent; material.needsUpdate = true;
      for (const part of ['model', 'supports', 'raft'] as const) { const mesh = mini[part]; if (mesh) mesh.visible = this.visible[part]; }
    }
  }
  invalidateAll() { this.minis.forEach(mini => mini.invalidate()); this.refreshMaterials(); }
  applyResult(id: string, revision: number, result: EngineResult) {
    const applied = this.minis.find(mini => mini.id === id)?.applyResult(result, revision);
    this.refreshMaterials(); return applied;
  }
  rotate(axis: 'x' | 'y' | 'z', degrees: number) {
    if (!this.locked && this.selected?.setRotation(axis, degrees)) { this.fitPlate(); this.onEdit(); }
  }
  move(axis: 'x' | 'y' | 'z', value: number) {
    if (!this.locked && this.selected?.setPosition(axis, value)) { this.fitPlate(); this.refreshMaterials(); this.onEdit(); }
  }
  resetRotation() {
    if (this.locked || !this.selected) return;
    this.selected.model.rotation.set(0, 0, 0);
    if (this.selected.commitRotation()) { this.fitPlate(); this.onEdit(); }
  }
  setScale(percent: number) { if (!this.locked && this.selected?.setScale(percent)) { this.fitPlate(); this.onEdit(); } }
  bounds() {
    const bounds = new THREE.Box3();
    for (const mini of this.minis) { mini.root.updateMatrixWorld(true); bounds.union(new THREE.Box3().setFromObject(mini.model, true)); }
    return bounds;
  }
  dimensions() { return this.minis.length ? this.bounds().getSize(new THREE.Vector3()) : new THREE.Vector3(); }
  triangles() { return this.minis.reduce((sum, mini) => sum + mini.originalTriangles, 0); }
  fitPlate() {
    const bounds = this.bounds();
    const width = this.minis.length ? Math.max(100, Math.ceil(Math.max(Math.abs(bounds.min.x), Math.abs(bounds.max.x), Math.abs(bounds.min.y), Math.abs(bounds.max.y)) * 2 / 10) * 10 + 40) : 180;
    this.scene.remove(this.grid); this.grid.geometry.dispose(); (this.grid.material as THREE.Material).dispose();
    this.grid = new THREE.GridHelper(width, width / 10, 0x969ea3, 0xb9bfc3); this.grid.rotation.x = Math.PI / 2; this.scene.add(this.grid);
    this.plate.scale.multiplyScalar(width / this.width); this.width = width;
  }
  home(top = false) {
    const bounds = this.bounds(), size = this.dimensions(), extent = Math.max(40, size.x, size.y, size.z);
    const center = this.minis.length ? bounds.getCenter(new THREE.Vector3()) : new THREE.Vector3(0, 0, 15);
    this.controls.target.copy(center); this.camera.position.copy(center).add(top ? new THREE.Vector3(0, -.01, extent * 3) : new THREE.Vector3(extent * 1.65, -extent * 2.25, extent * 1.65)); this.controls.update();
  }
  xray(enabled: boolean) { this.transparent = enabled; this.refreshMaterials(); }
  visibility(part: 'model' | 'supports' | 'raft', visible: boolean) { this.visible[part] = visible; this.refreshMaterials(); this.updateTool(); }
}
