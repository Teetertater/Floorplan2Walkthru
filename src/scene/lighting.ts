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

  // Exterior sun — outdoor shadows, window light spill
  const sun = new THREE.DirectionalLight(0xfff5e6, 1.0);
  sun.position.set(12, 15, 10);
  sun.target.position.set(4, 0, 6);
  scene.add(sun.target);
  sun.castShadow = true;
  sun.shadow.mapSize.width = 2048;
  sun.shadow.mapSize.height = 2048;
  sun.shadow.camera.near = 0.5;
  sun.shadow.camera.far = 40;
  sun.shadow.camera.left = -15;
  sun.shadow.camera.right = 15;
  sun.shadow.camera.top = 15;
  sun.shadow.camera.bottom = -15;
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.02;
  sun.shadow.radius = 3;
  scene.add(sun);

  // Interior ceiling light — casts furniture shadows onto floor and walls.
  // Positioned just below ceiling (y=2.1) pointing straight down.
  // Uses a separate shadow map so it's not blocked by the ceiling.
  const interiorLight = new THREE.DirectionalLight(0xffffff, 1.2);
  interiorLight.position.set(4, 2.1, 6);
  interiorLight.target.position.set(4, 0, 6);
  scene.add(interiorLight.target);
  interiorLight.castShadow = true;
  interiorLight.shadow.mapSize.width = 2048;
  interiorLight.shadow.mapSize.height = 2048;
  interiorLight.shadow.camera.near = 0.01;
  interiorLight.shadow.camera.far = 3;
  interiorLight.shadow.camera.left = -12;
  interiorLight.shadow.camera.right = 12;
  interiorLight.shadow.camera.top = 12;
  interiorLight.shadow.camera.bottom = -12;
  interiorLight.shadow.bias = -0.001;
  interiorLight.shadow.normalBias = 0.02;
  interiorLight.shadow.radius = 4;
  scene.add(interiorLight);

  // Hemisphere for soft sky/ground bounce
  scene.add(new THREE.HemisphereLight(0xddeeff, 0x665544, 0.25));

  // Low ambient fill to prevent pitch-black corners
  scene.add(new THREE.AmbientLight(0xffffff, 0.25));
}
