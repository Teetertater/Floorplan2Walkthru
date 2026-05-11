import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { FurniturePlacement } from '../state/types';
import { getFurnitureById } from '../assets/catalog';

const ASSETS_BASE = '/assets/furniture/';

const loader = new GLTFLoader();
const gltfCache = new Map<string, THREE.Group>();

async function loadModel(assetId: string): Promise<THREE.Group> {
  const cached = gltfCache.get(assetId);
  if (cached) return cached.clone();

  const meta = getFurnitureById(assetId);
  if (!meta) throw new Error(`Unknown furniture asset: ${assetId}`);

  const gltf = await loader.loadAsync(ASSETS_BASE + meta.gltfPath);
  const model = gltf.scene;

  // Ensure all meshes cast/receive shadows
  model.traverse(child => {
    if ((child as THREE.Mesh).isMesh) {
      child.castShadow = true;
      child.receiveShadow = true;
    }
  });

  gltfCache.set(assetId, model);
  return model.clone();
}

export class FurnitureManager {
  private group: THREE.Group;
  private instances = new Map<string, THREE.Object3D>();

  constructor() {
    this.group = new THREE.Group();
    this.group.name = 'furniture';
  }

  getGroup(): THREE.Group {
    return this.group;
  }

  async place(placement: FurniturePlacement): Promise<void> {
    // Remove existing instance with same ID
    this.remove(placement.instanceId);

    const model = await loadModel(placement.assetId);
    const [x, y, z] = placement.position;
    model.position.set(x, y, z);
    model.rotation.y = THREE.MathUtils.degToRad(placement.rotation);
    if (placement.scale !== 1) {
      model.scale.setScalar(placement.scale);
    }

    model.userData = {
      type: 'furniture',
      instanceId: placement.instanceId,
      assetId: placement.assetId,
      roomId: placement.roomId,
    };

    this.instances.set(placement.instanceId, model);
    this.group.add(model);
  }

  remove(instanceId: string): void {
    const obj = this.instances.get(instanceId);
    if (obj) {
      this.group.remove(obj);
      this.instances.delete(instanceId);
    }
  }

  clear(): void {
    for (const [id] of this.instances) {
      this.remove(id);
    }
  }

  async loadAll(placements: FurniturePlacement[]): Promise<void> {
    this.clear();
    await Promise.all(placements.map(p => this.place(p)));
  }
}
