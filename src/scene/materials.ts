import * as THREE from 'three';

const loader = new THREE.TextureLoader();

function loadTex(path: string, repeat?: [number, number]): THREE.Texture {
  const tex = loader.load(path);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  if (repeat) tex.repeat.set(repeat[0], repeat[1]);
  return tex;
}

function loadData(path: string, repeat?: [number, number]): THREE.Texture {
  const tex = loader.load(path);
  tex.colorSpace = THREE.LinearSRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  if (repeat) tex.repeat.set(repeat[0], repeat[1]);
  return tex;
}

export function createMaterials() {
  // Walls: white wall (beige texture tinted white)
  const wr: [number, number] = [0.7, 0.7];
  const wall = new THREE.MeshStandardMaterial({
    map: loadTex('/textures/beige_wall/diff.jpg', wr),
    normalMap: loadData('/textures/beige_wall/nor_gl.jpg', wr),
    roughnessMap: loadData('/textures/beige_wall/rough.jpg', wr),
    color: 0xf0f0f0, // tint towards white
    roughness: 0.95,
    metalness: 0.0,
    envMapIntensity: 0.3,
    side: THREE.DoubleSide,
  });

  const lintel = new THREE.MeshStandardMaterial({
    map: loadTex('/textures/beige_wall/diff.jpg', wr),
    normalMap: loadData('/textures/beige_wall/nor_gl.jpg', wr),
    roughnessMap: loadData('/textures/beige_wall/rough.jpg', wr),
    color: 0xf0f0f0,
    roughness: 0.95,
    metalness: 0.0,
    envMapIntensity: 0.3,
    side: THREE.DoubleSide,
  });

  // Floor: laminate with visible reflections
  const fr: [number, number] = [0.5, 0.5];
  const floor = new THREE.MeshPhysicalMaterial({
    map: loadTex('/textures/laminate_floor/diff.jpg', fr),
    normalMap: loadData('/textures/laminate_floor/nor_gl.jpg', fr),
    roughnessMap: loadData('/textures/laminate_floor/rough.jpg', fr),
    roughness: 0.45,
    metalness: 0.0,
    envMapIntensity: 1.2,
    clearcoat: 0.15,
    clearcoatRoughness: 0.3,
    side: THREE.DoubleSide,
  });

  // Ceiling
  const cr: [number, number] = [0.5, 0.5];
  const ceiling = new THREE.MeshStandardMaterial({
    map: loadTex('/textures/plastered_ceiling/diff.jpg', cr),
    normalMap: loadData('/textures/plastered_ceiling/nor_gl.jpg', cr),
    normalScale: new THREE.Vector2(0.3, 0.3),
    roughnessMap: loadData('/textures/plastered_ceiling/rough.jpg', cr),
    roughness: 0.95,
    metalness: 0.0,
    envMapIntensity: 0.1,
    side: THREE.DoubleSide,
  });

  const doorFrame = new THREE.MeshStandardMaterial({
    color: 0x8b7355,
    roughness: 0.4,
    metalness: 0.05,
  });

  const windowPane = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    roughness: 0.0,
    metalness: 0.0,
    transmission: 0.95,
    thickness: 0.01,
    ior: 1.5,
    envMapIntensity: 1.0,
    side: THREE.DoubleSide,
  });

  // Ground: grass
  const gr: [number, number] = [5, 5];
  const ground = new THREE.MeshStandardMaterial({
    map: loadTex('/textures/grass/diff.jpg', gr),
    normalMap: loadData('/textures/grass/nor.png', gr),
    roughnessMap: loadData('/textures/grass/rough.jpg', gr),
    roughness: 1.0,
    metalness: 0.0,
    envMapIntensity: 0.0,
  });

  return { wall, lintel, floor, ceiling, doorFrame, windowPane, ground };
}
