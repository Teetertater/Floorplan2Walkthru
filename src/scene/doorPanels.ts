import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const DOOR_GLTF = '/assets/doors/door_723/scene.gltf';

const loader = new GLTFLoader();
let templatePromise: Promise<THREE.Group> | null = null;

// Native model orientation after GLTF root transform (applied by Three.js automatically):
// X = door width axis, Y = up, Z = wall-normal direction (handle protrudes along +X / -X).
// We compute the model's bounding box once on first load so each placement can be
// scaled to match its target doorframe width/height exactly.

interface TemplateMeta {
  template: THREE.Group;
  size: THREE.Vector3;
  min: THREE.Vector3;
}

let cachedMeta: TemplateMeta | null = null;

async function loadTemplate(): Promise<TemplateMeta> {
  if (cachedMeta) return cachedMeta;
  if (!templatePromise) {
    templatePromise = loader.loadAsync(DOOR_GLTF).then(g => g.scene as THREE.Group);
  }
  const template = await templatePromise;
  // Bake bounds from the *flattened* world transform of the gltf root.
  // Cloning later preserves the relative offsets.
  template.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(template);
  const size = box.getSize(new THREE.Vector3());
  cachedMeta = { template, size, min: box.min.clone() };
  return cachedMeta;
}

export interface DoorPanelDescriptor {
  doorId: string;
  width: number;       // meters — door opening width
  height: number;      // meters — door opening height
  centerX: number;     // world X of doorframe center
  centerZ: number;     // world Z of doorframe center
  angle: number;       // wall angle (radians)
  material: THREE.MeshStandardMaterial; // shared with doorframe so styling stays in sync
}

export class DoorPanelManager {
  private group: THREE.Group;
  private panels = new Map<string, THREE.Object3D>();

  constructor() {
    this.group = new THREE.Group();
    this.group.name = 'door_panels';
  }

  getGroup(): THREE.Group {
    return this.group;
  }

  /** Whether door panels are currently visible (default: true) */
  get visible(): boolean {
    return this.group.visible;
  }

  setVisible(v: boolean) {
    this.group.visible = v;
  }

  toggle() {
    this.group.visible = !this.group.visible;
  }

  clear() {
    for (const obj of this.panels.values()) this.group.remove(obj);
    this.panels.clear();
  }

  async place(desc: DoorPanelDescriptor): Promise<void> {
    const meta = await loadTemplate();
    const clone = meta.template.clone(true);

    // Replace every mesh material with the shared doorframe material so that
    // texture/colour edits on the frame propagate to the panel automatically.
    clone.traverse(child => {
      if ((child as THREE.Mesh).isMesh) {
        (child as THREE.Mesh).material = desc.material;
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });

    // Compute a per-axis scale so the model exactly fills the doorframe opening.
    // Native model size after GLTF root transform: x = width, y = height, z = depth.
    const sx = meta.size.x > 1e-6 ? desc.width / meta.size.x : 1;
    const sy = meta.size.y > 1e-6 ? desc.height / meta.size.y : 1;
    // Depth: keep the door slim relative to its width so it doesn't poke through walls.
    const sz = sx;

    const wrapper = new THREE.Group();
    // Re-anchor: lift so the model's bottom sits at y=0, and recenter X around 0
    // and Z so the panel sits in the wall plane.
    const centerX = (meta.min.x + meta.size.x / 2);
    const centerZ = (meta.min.z + meta.size.z / 2);
    clone.position.set(-centerX * sx, -meta.min.y * sy, -centerZ * sz);
    clone.scale.set(sx, sy, sz);
    wrapper.add(clone);

    // Orient like the doorframe: local X along the wall, Y up, Z = wall-normal.
    const cosA = Math.cos(desc.angle);
    const sinA = Math.sin(desc.angle);
    const m = new THREE.Matrix4();
    m.makeBasis(
      new THREE.Vector3(cosA, 0, sinA),
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(-sinA, 0, cosA),
    );
    wrapper.setRotationFromMatrix(m);
    wrapper.position.set(desc.centerX, 0, desc.centerZ);

    wrapper.userData = { type: 'door_panel', doorId: desc.doorId };

    // If a previous panel for this door exists, remove it first.
    const existing = this.panels.get(desc.doorId);
    if (existing) this.group.remove(existing);

    this.panels.set(desc.doorId, wrapper);
    this.group.add(wrapper);
  }

  async placeAll(descs: DoorPanelDescriptor[]): Promise<void> {
    this.clear();
    await Promise.all(descs.map(d => this.place(d)));
  }

  remove(doorId: string) {
    const obj = this.panels.get(doorId);
    if (obj) {
      this.group.remove(obj);
      this.panels.delete(doorId);
    }
  }
}
