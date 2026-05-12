import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { FurniturePlacement } from '../state/types';
import { getFurnitureById } from '../assets/catalog';

const ASSETS_BASE = '/assets/furniture/';

const loader = new GLTFLoader();
const gltfCache = new Map<string, THREE.Group>();
const autoScaleCache = new Map<string, number>();

async function loadModel(assetId: string): Promise<{ model: THREE.Group; baseScale: number }> {
  const cached = gltfCache.get(assetId);
  if (cached) return { model: cached.clone(), baseScale: autoScaleCache.get(assetId) ?? 1 };

  const meta = getFurnitureById(assetId);
  if (!meta) throw new Error(`Unknown furniture asset: ${assetId}`);

  const gltf = await loader.loadAsync(ASSETS_BASE + meta.gltfPath);
  const rawModel = gltf.scene;

  // Compute auto-scale factor
  const box = new THREE.Box3().setFromObject(rawModel);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxActual = Math.max(size.x, size.y, size.z);
  const maxCatalog = Math.max(meta.dimensions.w, meta.dimensions.h, meta.dimensions.d);
  let baseScale = 1;

  if (maxActual > 0.001 && maxCatalog > 0.001) {
    const ratio = maxCatalog / maxActual;
    if (ratio < 0.8 || ratio > 1.2) {
      baseScale = ratio;
      console.log(`Auto-scale ${assetId}: ${baseScale.toFixed(3)}x (was ${maxActual.toFixed(2)}m, target ${maxCatalog.toFixed(2)}m)`);
    }
  }

  // Wrap in a container group. Offset the raw model so that:
  // - XZ center is at local origin (scaling stays centered horizontally)
  // - Bottom (min.y) is at local y=0 (model sits on ground)
  rawModel.position.set(-center.x, -box.min.y, -center.z);

  const wrapper = new THREE.Group();
  wrapper.add(rawModel);

  // Ensure all meshes cast/receive shadows
  wrapper.traverse(child => {
    if ((child as THREE.Mesh).isMesh) {
      child.castShadow = true;
      child.receiveShadow = true;
    }
  });

  gltfCache.set(assetId, wrapper);
  autoScaleCache.set(assetId, baseScale);
  return { model: wrapper.clone(), baseScale };
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

    const { model, baseScale } = await loadModel(placement.assetId);
    const [x, y, z] = placement.position;
    model.position.set(x, y, z);
    model.rotation.y = THREE.MathUtils.degToRad(placement.rotation);
    model.scale.setScalar(baseScale * placement.scale);

    model.userData = {
      type: 'furniture',
      instanceId: placement.instanceId,
      assetId: placement.assetId,
      roomId: placement.roomId,
      baseScale,
    };

    // If this furniture emits light, attach a PointLight
    const meta = getFurnitureById(placement.assetId);
    if (meta?.emitsLight) {
      const light = new THREE.PointLight(0xfff0dd, 0.6, 8, 2);
      // Ceiling lights: emit downward from bottom; others: emit from top
      const lightY = meta.placement === 'ceiling'
        ? -meta.dimensions.h * 0.2
        : meta.dimensions.h * 0.8;
      light.position.set(0, lightY, 0);
      light.userData = { _furnitureLight: true };
      model.add(light);
    }

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
