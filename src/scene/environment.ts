import * as THREE from 'three';

export function createEnvironment(scene: THREE.Scene) {
  // Ground plane
  const groundGeo = new THREE.PlaneGeometry(200, 200);
  const groundMat = new THREE.MeshStandardMaterial({
    color: 0x4a7c3f,
    roughness: 0.9,
    metalness: 0.0,
  });
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.01; // slightly below floor level
  ground.receiveShadow = true;
  ground.userData = { type: 'ground' };
  scene.add(ground);

  // Simple trees scattered around the building
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x6b4226, roughness: 0.8 });
  const leafMat = new THREE.MeshStandardMaterial({ color: 0x2d6b1e, roughness: 0.7 });
  const trunkGeo = new THREE.CylinderGeometry(0.15, 0.2, 3, 8);
  const canopyGeo = new THREE.SphereGeometry(1.2, 8, 6);

  // Place trees in a ring around origin, far enough to be outside any building
  const treePositions = [
    [-8, -8], [-4, -10], [2, -9], [8, -7], [12, -5],
    [15, 0], [15, 5], [14, 10], [12, 14],
    [8, 16], [3, 17], [-3, 16], [-7, 14],
    [-10, 10], [-12, 5], [-11, 0], [-10, -4],
    [-5, 15], [0, -12], [10, -9], [-8, 8],
    [16, 8], [-12, -2], [5, 18], [-6, 18],
  ];

  for (const [tx, tz] of treePositions) {
    const trunk = new THREE.Mesh(trunkGeo, trunkMat);
    trunk.position.set(tx, 1.5, tz);
    trunk.castShadow = true;
    scene.add(trunk);

    const canopy = new THREE.Mesh(canopyGeo, leafMat);
    // Slight random variation
    const scale = 0.8 + Math.random() * 0.6;
    canopy.scale.set(scale, scale * 0.9, scale);
    canopy.position.set(tx, 3.2 + scale * 0.3, tz);
    canopy.castShadow = true;
    scene.add(canopy);
  }

  // Sky gradient via a large dome
  const skyGeo = new THREE.SphereGeometry(80, 32, 16);
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    uniforms: {
      topColor: { value: new THREE.Color(0x5588cc) },
      bottomColor: { value: new THREE.Color(0xc8ddf0) },
    },
    vertexShader: `
      varying vec3 vWorldPosition;
      void main() {
        vec4 worldPosition = modelMatrix * vec4(position, 1.0);
        vWorldPosition = worldPosition.xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 topColor;
      uniform vec3 bottomColor;
      varying vec3 vWorldPosition;
      void main() {
        float h = normalize(vWorldPosition).y;
        gl_FragColor = vec4(mix(bottomColor, topColor, max(h, 0.0)), 1.0);
      }
    `,
  });
  const sky = new THREE.Mesh(skyGeo, skyMat);
  scene.add(sky);
}
