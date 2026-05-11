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
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
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

// ── Keyboard shortcuts ──
let minimapVisible = true;
window.addEventListener('keydown', (e) => {
  if (e.key === 'e' || e.key === 'E') {
    editMode.toggle();
  }
  if (e.key === 'm' || e.key === 'M') {
    minimapVisible = !minimapVisible;
    (document.getElementById('minimap-container') as HTMLElement).style.display =
      minimapVisible ? '' : 'none';
  }
  if (e.key === 'b' || e.key === 'B') {
    if (!currentPlan || !currentSceneState) return;
    if (birdsEye.isVisible) {
      birdsEye.hideOverlay();
    } else {
      birdsEye.showOverlay(currentPlan, currentSceneState.furniture);
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

  if (minimapVisible) minimap.render(camera);
  composer.render();
}

animate();
