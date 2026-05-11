import * as THREE from 'three';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';

export async function setupLighting(
  scene: THREE.Scene,
  renderer: THREE.WebGLRenderer,
): Promise<void> {
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const loader = new RGBELoader();

  // Studio HDRI for indoor environment lighting (soft, even reflections)
  try {
    const studioHdri = await loader.loadAsync('/hdri/studio_small_08_1k.hdr');
    const envMap = pmrem.fromEquirectangular(studioHdri).texture;
    scene.environment = envMap;
    studioHdri.dispose();
    console.log('Studio environment loaded');
  } catch {
    console.warn('Studio HDRI not found');
  }

  // Outdoor HDRI as scene background (visible through windows)
  try {
    const bgHdri = await loader.loadAsync('/hdri/horn-koppe_spring_2k.hdr');
    const bgMap = pmrem.fromEquirectangular(bgHdri).texture;
    scene.background = bgMap;
    bgHdri.dispose();
    console.log('Background HDRI loaded');
  } catch {
    console.warn('Background HDRI not found, using sky color');
    scene.background = new THREE.Color(0x87ceeb);
  }

  pmrem.dispose();

  // Soft directional fill
  const sun = new THREE.DirectionalLight(0xffffff, 0.3);
  sun.position.set(5, 10, 3);
  sun.castShadow = false;
  scene.add(sun);

  // Hemisphere
  scene.add(new THREE.HemisphereLight(0xffffff, 0xcccccc, 0.3));

  // Ambient
  scene.add(new THREE.AmbientLight(0xffffff, 0.4));
}
