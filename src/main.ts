import * as THREE from 'three';
import {
  EffectComposer,
  EffectPass,
  RenderPass,
  SMAAEffect,
  SMAAPreset,
  BloomEffect,
  VignetteEffect,
  SSAOEffect,
  BlendFunction,
  NormalPass,
} from 'postprocessing';

import { parseCubiCasa } from './cubicasa/parser';
import { loadManifest, loadPlanBundle, PlanBundle } from './cubicasa/metadata';
import { createMaterials } from './scene/materials';
import { generateScene } from './scene/meshGen';
import { setupLighting } from './scene/lighting';
import { NavigationController } from './navigation/controls';
import { Minimap } from './ui/minimap';
import { initPlanPicker } from './ui/planPicker';
import { Plan } from './cubicasa/types';

// ── Renderer ──
const renderer = new THREE.WebGLRenderer({
  powerPreference: 'high-performance',
  antialias: false,
  stencil: false,
  depth: false,
});
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = false;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.3;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.prepend(renderer.domElement);

// ── Scene + camera ──
const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(
  95,
  window.innerWidth / window.innerHeight,
  0.05,
  200,
);

// ── Postprocessing ──
const composer = new EffectComposer(renderer, {
  frameBufferType: THREE.HalfFloatType,
});

composer.addPass(new RenderPass(scene, camera));

const normalPass = new NormalPass(scene, camera);
composer.addPass(normalPass);

const ssaoEffect = new SSAOEffect(camera, normalPass.texture, {
  blendFunction: BlendFunction.MULTIPLY,
  samples: 16,
  rings: 4,
  worldDistanceThreshold: 0.5,
  worldDistanceFalloff: 0.1,
  worldProximityThreshold: 0.3,
  worldProximityFalloff: 0.1,
  luminanceInfluence: 0.7,
  radius: 0.04,
  intensity: 2.0,
  bias: 0.025,
  fade: 0.01,
});

const bloomEffect = new BloomEffect({
  intensity: 0.15,
  luminanceThreshold: 0.8,
  luminanceSmoothing: 0.3,
  mipmapBlur: true,
});

const smaaEffect = new SMAAEffect({ preset: SMAAPreset.HIGH });
const vignetteEffect = new VignetteEffect({ darkness: 0.35, offset: 0.3 });

composer.addPass(new EffectPass(camera, ssaoEffect, bloomEffect, smaaEffect, vignetteEffect));

// ── Materials ──
const materials = createMaterials();

// ── Lighting ──
setupLighting(scene, renderer);

// ── Navigation ──
const nav = new NavigationController(camera, renderer.domElement);

const modeLabel = document.getElementById('mode-label')!;
nav.setModeChangeHandler((mode) => {
  modeLabel.textContent = mode === 'locked' ? 'FPS Mode (ESC to exit)' : 'Free Cursor Mode';
});

// ── Minimap ──
const minimapCanvas = document.getElementById('minimap') as HTMLCanvasElement;
const minimap = new Minimap(minimapCanvas);

// ── Room label ──
const roomLabel = document.getElementById('room-label')!;
let currentRoomName = '';

// ── Plan management ──
let planRoot: THREE.Group | null = null;
let currentPlan: Plan | null = null;
const planCache = new Map<string, PlanBundle>();

function applyPlan(bundle: PlanBundle) {
  if (planRoot) {
    scene.remove(planRoot);
    planRoot.traverse(obj => {
      if ((obj as THREE.Mesh).geometry) (obj as THREE.Mesh).geometry.dispose();
    });
    planRoot = null;
  }

  const plan = parseCubiCasa(bundle.svgText, bundle.meta);
  currentPlan = plan;

  planRoot = generateScene(plan, materials);
  scene.add(planRoot);

  nav.setRooms(plan.rooms);
  minimap.setPlan(plan, bundle.svgText);

  const startRoom = plan.rooms.find(r => r.type === bundle.meta.startRoom)
    || plan.rooms.find(r =>
      r.type !== 'Outdoor' && r.type !== 'Outdoor Balcony' && r.type !== 'Closet'
    )
    || plan.rooms[0];

  if (startRoom) {
    const cx = startRoom.polygon.reduce((s, p) => s + p[0], 0) / startRoom.polygon.length;
    const cz = startRoom.polygon.reduce((s, p) => s + p[1], 0) / startRoom.polygon.length;
    nav.teleportTo(cx, cz);
  }

  console.log(`Loaded: ${bundle.meta.name}`);
}

async function switchPlan(planId: string) {
  let bundle = planCache.get(planId);
  if (!bundle) {
    bundle = await loadPlanBundle(planId);
    planCache.set(planId, bundle);
  }
  applyPlan(bundle);
}

// ── Minimap toggle (M key) ──
let minimapVisible = true;
window.addEventListener('keydown', (e) => {
  if (e.key === 'm' || e.key === 'M') {
    minimapVisible = !minimapVisible;
    minimapCanvas.style.display = minimapVisible ? '' : 'none';
  }
});

// ── Minimap teleport ──
minimap.setTeleportHandler((x, z) => {
  if (!currentPlan) return;
  if (nav.mode === 'locked') return;
  nav.teleportTo(x, z);
});

// ── Bootstrap: load manifest, populate picker, load first plan ──
async function init() {
  const planIds = await loadManifest();

  // Load all configs in parallel for the picker labels
  const bundles = await Promise.all(planIds.map(id => loadPlanBundle(id)));
  for (const b of bundles) planCache.set(b.meta.id, b);

  const selectEl = document.getElementById('plan-picker') as HTMLSelectElement;
  initPlanPicker(
    selectEl,
    bundles.map(b => ({ id: b.meta.id, name: b.meta.name })),
    (planId) => switchPlan(planId),
  );

  // Load first plan
  applyPlan(bundles[0]);
}

init();

// ── Resize ──
window.addEventListener('resize', () => {
  const w = window.innerWidth;
  const h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  composer.setSize(w, h);
});

// ── Animate ──
function animate() {
  requestAnimationFrame(animate);

  nav.update();

  if (currentPlan) {
    const room = nav.getCurrentRoom(camera.position.x, camera.position.z);
    const newName = room ? room.name : '';
    if (newName !== currentRoomName) {
      currentRoomName = newName;
      roomLabel.textContent = newName;
      roomLabel.style.opacity = newName ? '1' : '0';
    }
  }

  if (minimapVisible) minimap.render(camera);
  composer.render();
}

animate();
