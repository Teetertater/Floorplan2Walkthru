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
  ChromaticAberrationEffect,
  NoiseEffect,
  LensDistortionEffect,
  DepthOfFieldEffect,
  LUT3DEffect,
} from 'postprocessing';

import { parseCubiCasa } from './cubicasa/parser';
import { loadManifest, loadPlanBundle, PlanBundle } from './cubicasa/metadata';
import { createMaterials } from './scene/materials';
import { generateScene } from './scene/meshGen';
import { setupLighting } from './scene/lighting';
import { NavigationController } from './navigation/controls';
import { Minimap } from './ui/minimap';
import { SessionPicker } from './ui/planPicker';
import { Plan } from './cubicasa/types';
import { FurnitureManager } from './scene/furniture';
import { EditModeController } from './ui/editMode';
import { SceneState } from './state/types';
import {
  saveSession, getSession, getActiveSessionName, setActiveSessionName,
} from './state/storage';
import { DEFAULT_SCENES } from './state/defaults';
import { BirdsEyeRenderer } from './scene/birdsEye';
import { GBufferRecorder } from './ui/gbufferRecorder';

// ── Warm arch-viz LUT ──
function createWarmArchVizLUT(size = 16): THREE.Data3DTexture {
  const data = new Uint8Array(size * size * size * 4);
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        const idx = (b * size * size + g * size + r) * 4;
        let rr = r / (size - 1);
        let gg = g / (size - 1);
        let bb = b / (size - 1);

        // Lift shadows slightly (reduces harsh black)
        rr = rr * 0.92 + 0.04;
        gg = gg * 0.92 + 0.03;
        bb = bb * 0.92 + 0.02;

        // Warm push: boost reds/yellows, cool blues slightly
        rr = Math.pow(rr, 0.95);
        gg = Math.pow(gg, 0.98);
        bb = Math.pow(bb, 1.06);

        // Gentle S-curve for contrast (per channel)
        rr = rr - 0.12 * Math.sin(2 * Math.PI * rr);
        gg = gg - 0.10 * Math.sin(2 * Math.PI * gg);
        bb = bb - 0.08 * Math.sin(2 * Math.PI * bb);

        data[idx]     = Math.round(Math.max(0, Math.min(1, rr)) * 255);
        data[idx + 1] = Math.round(Math.max(0, Math.min(1, gg)) * 255);
        data[idx + 2] = Math.round(Math.max(0, Math.min(1, bb)) * 255);
        data[idx + 3] = 255;
      }
    }
  }
  const tex = new THREE.Data3DTexture(data, size, size, size);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

// ── Renderer ──
const renderer = new THREE.WebGLRenderer({
  powerPreference: 'high-performance',
  antialias: false,
  stencil: false,
  depth: true,
});
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.2;
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
  samples: 32,
  rings: 5,
  worldDistanceThreshold: 1.5,
  worldDistanceFalloff: 0.3,
  worldProximityThreshold: 0.5,
  worldProximityFalloff: 0.2,
  luminanceInfluence: 0.6,
  radius: 0.06,
  intensity: 1.2,
  bias: 0.02,
  fade: 0.02,
});

const bloomEffect = new BloomEffect({
  intensity: 0,
  luminanceThreshold: 0.6,
  luminanceSmoothing: 0.4,
  mipmapBlur: true,
});

const smaaEffect = new SMAAEffect({ preset: SMAAPreset.HIGH });
const vignetteEffect = new VignetteEffect({ darkness: 0.4, offset: 0.25 });

const chromaticAberrationEffect = new ChromaticAberrationEffect({
  offset: new THREE.Vector2(0.0008, 0.0008),
  radialModulation: true,
  modulationOffset: 0.3,
});

const noiseEffect = new NoiseEffect({
  blendFunction: BlendFunction.OVERLAY,
});
noiseEffect.blendMode.opacity.value = 0.04;

const lensDistortionEffect = new LensDistortionEffect({
  distortion: new THREE.Vector2(0.03, 0.03),
  principalPoint: new THREE.Vector2(0, 0),
  focalLength: new THREE.Vector2(1, 1),
  skew: 0,
});

const depthOfFieldEffect = new DepthOfFieldEffect(camera, {
  focusDistance: 0.02,
  focalLength: 0.05,
  bokehScale: 2.5,
});

composer.addPass(new EffectPass(camera, ssaoEffect, bloomEffect, vignetteEffect, noiseEffect, smaaEffect));
composer.addPass(new EffectPass(camera, chromaticAberrationEffect));

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

// ── Furniture ──
const furnitureManager = new FurnitureManager();
scene.add(furnitureManager.getGroup());

// ── Session state ──
let currentPlan: Plan | null = null;
let currentSceneState: SceneState | null = null;
let currentSessionName: string = '';
let planRoot: THREE.Group | null = null;
const planCache = new Map<string, PlanBundle>();

// ── Edit mode ──
const editMode = new EditModeController(
  scene, camera, renderer.domElement, furnitureManager,
  () => {
    // Auto-save session on every edit (including camera)
    saveCameraState();
    saveBirdsEyeScreenshot();
  },
);

// ── Core: apply a plan with a given scene state ──

async function applyPlanWithState(bundle: PlanBundle, sessionName: string, state: SceneState) {
  if (planRoot) {
    scene.remove(planRoot);
    planRoot.traverse(obj => {
      if ((obj as THREE.Mesh).geometry) (obj as THREE.Mesh).geometry.dispose();
    });
    planRoot = null;
  }

  const plan = parseCubiCasa(bundle.svgText, bundle.meta);
  currentPlan = plan;
  currentSceneState = state;
  currentSessionName = sessionName;

  planRoot = generateScene(plan, materials);
  scene.add(planRoot);

  nav.setRooms(plan.rooms);
  minimap.setPlan(plan, bundle.svgText);

  await furnitureManager.loadAll(state.furniture);
  saveSession(sessionName, state);
  setActiveSessionName(sessionName);
  editMode.setPlan(plan, state);
  const surfaceCount = state.surfaces ? Object.keys(state.surfaces).length : 0;
  if (surfaceCount > 0) console.log(`Restoring ${surfaceCount} surface overrides`);
  editMode.applySavedSurfaces();
  picker.setActive(sessionName, state);

  // Restore camera from session, or default to start room
  if (state.camera) {
    const [px, py, pz] = state.camera.position;
    const [dx, dy, dz] = state.camera.lookDir;
    camera.position.set(px, py, pz);
    camera.lookAt(px + dx, py + dy, pz + dz);
  } else {
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
  }

  console.log(`Loaded session "${sessionName}" (${state.furniture.length} furniture pieces)`);
  saveBirdsEyeScreenshot();
}

async function loadPreset(planId: string) {
  let bundle = planCache.get(planId);
  if (!bundle) {
    bundle = await loadPlanBundle(planId);
    planCache.set(planId, bundle);
  }
  const state = DEFAULT_SCENES[planId]
    || { planId, surfaces: {}, furniture: [] };
  const sessionName = bundle.meta.name;
  await applyPlanWithState(bundle, sessionName, JSON.parse(JSON.stringify(state)));
  picker.rebuild();
  picker.setValue(`session:${sessionName}`);
}

async function loadSession(name: string, state: SceneState) {
  let bundle = planCache.get(state.planId);
  if (!bundle) {
    bundle = await loadPlanBundle(state.planId);
    planCache.set(state.planId, bundle);
  }
  await applyPlanWithState(bundle, name, state);
}

// ── Camera state persistence ──
function saveCameraState() {
  if (!currentSceneState || !currentSessionName) return;
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  currentSceneState.camera = {
    position: [camera.position.x, camera.position.y, camera.position.z],
    lookDir: [dir.x, dir.y, dir.z],
  };
  saveSession(currentSessionName, currentSceneState);
}

window.addEventListener('beforeunload', saveCameraState);

// ── Bird's-eye view ──
const birdsEye = new BirdsEyeRenderer();

function saveBirdsEyeScreenshot() {
  if (!currentPlan || !currentSceneState) return;
  const dataUrl = birdsEye.capture(currentPlan, currentSceneState.furniture);
  fetch('/api/screenshot', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: dataUrl, name: currentPlan.id }),
  }).catch(() => {});
}

// ── Session picker ──
const picker = new SessionPicker(
  document.getElementById('plan-picker') as HTMLSelectElement,
  document.getElementById('btn-download') as HTMLButtonElement,
  document.getElementById('btn-upload') as HTMLButtonElement,
  [], // populated in init()
  {
    onSelectPreset: (planId) => loadPreset(planId),
    onSelectSession: (name, state) => loadSession(name, state),
    onImportSession: (name, state) => loadSession(name, state),
  },
);

// ── G-buffer recorder ──
const gbufferRecorder = new GBufferRecorder(scene, camera, renderer);

// ── Keyboard shortcuts ──
let minimapVisible = true;
window.addEventListener('keydown', (e) => {
  // Suppress all shortcuts when typing in a search field
  if (editMode.isSearchFocused) return;

  if (e.key === 'e' || e.key === 'E') {
    editMode.toggle();
  }
  if (e.key === 'm' || e.key === 'M') {
    minimapVisible = !minimapVisible;
    (document.getElementById('minimap-container') as HTMLElement).style.display =
      minimapVisible ? '' : 'none';
  }
  // B and C are disabled in edit mode
  if (!editMode.isEnabled) {
    if (e.key === 'c' || e.key === 'C') {
      gbufferRecorder.toggle();
    }
    if (e.key === 'b' || e.key === 'B') {
      if (!currentPlan || !currentSceneState) return;
      if (birdsEye.isVisible) {
        birdsEye.hideOverlay();
      } else {
        birdsEye.showOverlay(currentPlan, currentSceneState.furniture);
      }
    }
  }
});

// ── Minimap teleport ──
minimap.setTeleportHandler((x, z) => {
  if (!currentPlan) return;
  if (nav.mode === 'locked') return;
  nav.teleportTo(x, z);
});

// ── Bootstrap ──
async function init() {
  const planIds = await loadManifest();
  const bundles = await Promise.all(planIds.map(id => loadPlanBundle(id)));
  for (const b of bundles) planCache.set(b.meta.id, b);

  // Set presets in picker
  (picker as any).presets = bundles.map(b => ({ id: b.meta.id, name: b.meta.name }));
  picker.rebuild();

  // Restore last session, or load first preset
  const lastSessionName = getActiveSessionName();
  const lastState = lastSessionName ? getSession(lastSessionName) : null;

  if (lastState) {
    picker.setValue(`session:${lastSessionName}`);
    await loadSession(lastSessionName!, lastState);
  } else {
    await loadPreset(bundles[0].meta.id);
  }
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

  gbufferRecorder.captureFrame();

  if (minimapVisible) minimap.render(camera);
  composer.render();
}

animate();
