import * as THREE from 'three';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';

export async function setupLighting(
  scene: THREE.Scene,
  renderer: THREE.WebGLRenderer,
): Promise<void> {
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const loader = new HDRLoader();

  // Indoor HDRI for environment lighting (reflections/IBL)
  try {
    const indoorHdri = await loader.loadAsync('/hdri/mud_road_puresky_1k.hdr');
    const envMap = pmrem.fromEquirectangular(indoorHdri).texture;
    scene.environment = envMap;
    scene.environmentIntensity = 1;
    indoorHdri.dispose();
    console.log('Indoor environment HDRI loaded');
  } catch {
    console.warn('Indoor HDRI not found');
  }

  // Outdoor HDRI as background (visible through windows)
  try {
    const outdoorHdri = await loader.loadAsync('/hdri/horn-koppe_spring_2k.hdr');
    const bgMap = pmrem.fromEquirectangular(outdoorHdri).texture;
    scene.background = bgMap;
    scene.backgroundIntensity = 1.0;
    outdoorHdri.dispose();
    console.log('Background HDRI loaded');
  } catch {
    console.warn('Background HDRI not found, using sky color');
    scene.background = new THREE.Color(0x87ceeb);
  }

  pmrem.dispose();

  // Exterior sun — outdoor shadows, window light spill
  const sun = new THREE.DirectionalLight(0xfff5e6, 0.8);
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
  const interiorLight = new THREE.DirectionalLight(0xfff8ee, 0.8);
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
  scene.add(new THREE.HemisphereLight(0xddeeff, 0x665544, 0.3));

  // Warm ambient fill to prevent pitch-black corners
  scene.add(new THREE.AmbientLight(0xfff5e8, 0.3));
}
