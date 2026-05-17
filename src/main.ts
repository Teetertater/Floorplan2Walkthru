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
import { loadManifest, loadPlanBundle } from './cubicasa/metadata';
import { createMaterials, cloneMaterials } from './scene/materials';
import { generateScene } from './scene/meshGen';
import { setupLighting } from './scene/lighting';
import { NavigationController } from './navigation/controls';
import { Minimap } from './ui/minimap';
import { SessionPicker } from './ui/planPicker';
import { Plan } from './cubicasa/types';
import { FurnitureManager } from './scene/furniture';
import { DoorPanelManager, DoorPanelDescriptor } from './scene/doorPanels';
import { EditModeController } from './ui/editMode';
import { SceneState, createEmptyState } from './state/types';
import {
  saveSession, getSession, createSession,
  getActiveSessionId, setActiveSessionId,
  clearGBufferBlobs, clearPanoramaBlobs, setPanoramaBlob, setPanoramaBlobs,
  ImportResult, SessionRecord,
} from './state/storage';
import { DEFAULT_SCENES } from './state/defaults';
import { detectOuterPerimeter } from './cubicasa/perimeterDetect';
import { PlanMeta } from './cubicasa/metadata';
import { BirdsEyeRenderer } from './scene/birdsEye';
import { GBufferRecorder } from './ui/gbufferRecorder';
import { PanoramaRenderer } from './ui/panoramaRenderer';

// Walk the freshly built plan_root and emit DoorPanelDescriptors for each
// live (non-deleted) door, capturing the shared frame material so panels
// stay visually in sync with the frame.
function collectDoorPanelDescs(
  root: THREE.Object3D,
  deletedDoors?: string[],
): DoorPanelDescriptor[] {
  const deleted = new Set(deletedDoors ?? []);
  const descs: DoorPanelDescriptor[] = [];
  root.traverse((obj) => {
    const ud = obj.userData;
    if (ud?.type !== 'door_frame') return;
    if (deleted.has(ud.doorId as string)) return;
    descs.push({
      doorId: ud.doorId as string,
      width: ud.width as number,
      height: ud.height as number,
      centerX: ud.centerX as number,
      centerZ: ud.centerZ as number,
      angle: ud.angle as number,
      material: (obj as THREE.Mesh).material as THREE.MeshStandardMaterial,
    });
  });
  return descs;
}

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

// ── Door panels ──
const doorPanels = new DoorPanelManager();
scene.add(doorPanels.getGroup());

// ── Session state ──
let currentPlan: Plan | null = null;
let currentSceneState: SceneState | null = null;
let currentSession: SessionRecord | null = null;
let planRoot: THREE.Group | null = null;

// ── Edit mode ──
const editMode = new EditModeController(
  scene, camera, renderer.domElement, furnitureManager, nav,
  () => {
    saveCameraState();
    saveBirdsEyeScreenshot();
  },
  // Rebuild plan geometry after a door is deleted: walls become solid in that spot.
  () => {
    if (!currentPlan || !currentSceneState || !planRoot) return;
    scene.remove(planRoot);
    planRoot.traverse(obj => {
      if ((obj as THREE.Mesh).geometry) (obj as THREE.Mesh).geometry.dispose();
    });
    const sceneMaterials = cloneMaterials(materials);
    planRoot = generateScene(currentPlan, sceneMaterials, { deletedDoors: currentSceneState.deletedDoors });
    scene.add(planRoot);

    doorPanels.placeAll(collectDoorPanelDescs(planRoot, currentSceneState.deletedDoors)).then(() => {
      editMode.applySavedSurfaces();
      editMode.applySavedDoorStyles();
    });
  },
);

// ── Core: apply a plan with a given scene state ──

async function applyPlanWithState(session: SessionRecord) {
  // Flush the outgoing session's live camera position to its localStorage
  // record before swapping. Without this, navigating around in session A
  // then picking session B silently loses A's camera state.
  saveCameraState();

  if (planRoot) {
    scene.remove(planRoot);
    planRoot.traverse(obj => {
      if ((obj as THREE.Mesh).geometry) (obj as THREE.Mesh).geometry.dispose();
    });
    planRoot = null;
  }

  const { state, svgText, meta } = session;
  const plan = parseCubiCasa(svgText, meta);
  currentPlan = plan;
  currentSceneState = state;
  currentSession = session;

  saveSession(session);
  setActiveSessionId(session.id);

  // Fresh material clones per scene — surface/colour mutations from previous
  // sessions can't leak through the shared module-level material library.
  const sceneMaterials = cloneMaterials(materials);
  planRoot = generateScene(plan, sceneMaterials, { deletedDoors: state.deletedDoors });
  scene.add(planRoot);

  nav.setRooms(plan.rooms);
  minimap.setPlan(plan, svgText);

  // Place a door panel for every live door, sharing each doorframe's material
  // instance so colour/texture edits affect both frame and panel at once.
  await doorPanels.placeAll(collectDoorPanelDescs(planRoot, state.deletedDoors));

  await furnitureManager.loadAll(state.furniture);
  editMode.setPlan(plan, state);
  const surfaceCount = state.surfaces ? Object.keys(state.surfaces).length : 0;
  if (surfaceCount > 0) console.log(`Restoring ${surfaceCount} surface overrides`);
  editMode.applySavedSurfaces();
  editMode.applySavedDoorStyles();
  picker.setActive(session);
  picker.rebuild();
  picker.setValue(`session:${session.id}`);

  // Restore camera from session, or default to start room
  if (state.camera) {
    const [px, py, pz] = state.camera.position;
    const [dx, dy, dz] = state.camera.lookDir;
    camera.position.set(px, py, pz);
    camera.lookAt(px + dx, py + dy, pz + dz);
  } else {
    const startRoom = plan.rooms.find(r => r.type === meta.startRoom)
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

  console.log(`Loaded session "${session.name}" #${session.id} (${state.furniture.length} furniture pieces)`);
  saveBirdsEyeScreenshot();
}

async function loadPreset(planId: string) {
  clearGBufferBlobs();
  clearPanoramaBlobs();
  const bundle = await loadPlanBundle(planId);
  const defaultState = DEFAULT_SCENES[planId]
    || { planId, surfaces: {}, furniture: [] };
  // Forking a preset creates a fresh session immediately. From this moment the
  // session is fully independent — its own id, its own svgText, its own state.
  const session = createSession({
    name: bundle.meta.name,
    state: JSON.parse(JSON.stringify(defaultState)),
    svgText: bundle.svgText,
    meta: bundle.meta,
  });
  await applyPlanWithState(session);
}

async function loadSession(session: SessionRecord) {
  clearGBufferBlobs();
  clearPanoramaBlobs();
  await applyPlanWithState(session);
}

// ── Camera state persistence ──
function saveCameraState() {
  if (!currentSession || !currentSceneState) return;
  // If the session has been deleted out from under us (e.g. via the Delete
  // button just before a session switch), don't resurrect it in localStorage.
  if (!getSession(currentSession.id)) return;
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  currentSceneState.camera = {
    position: [camera.position.x, camera.position.y, camera.position.z],
    lookDir: [dir.x, dir.y, dir.z],
  };
  saveSession(currentSession);
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

// ── SVG import: auto-detect perimeter, create session from raw SVG ──
async function importFromSvg(result: Extract<ImportResult, { type: 'svg' }>) {
  const { name, svgText } = result;

  // Auto-detect outer perimeter from SVG content
  const rawPerimeter = detectOuterPerimeter(svgText);

  // Estimate scale: default to 0.01 (1 SVG unit = 0.01m, typical for CubiCasa)
  const scale = 0.01;

  const perimeterMeters: [number, number][] = rawPerimeter.map(
    ([x, y]) => [x * scale, y * scale],
  );

  const meta: PlanMeta = {
    id: name.replace(/\s+/g, '_').toLowerCase(),
    name,
    scaleMetersPerUnit: scale,
    outerPerimeter: perimeterMeters,
  };

  clearGBufferBlobs();
  clearPanoramaBlobs();

  // Seed defaults so the upload doesn't render with the bare material library
  // (plaster-textured walls + flat-white door frames). Users expect the opposite:
  // walls read as painted white, doors carry the plaster texture.
  const state = createEmptyState(meta.id);
  const plan = parseCubiCasa(svgText, meta);
  for (const wall of plan.walls) {
    state.surfaces![`wall:${wall.id}`] = { type: 'colour', colour: '#ffffff', opacity: 1 };
  }
  for (const door of plan.doors) {
    state.doorStyles![door.id] = { type: 'texture', textureId: 'white_plaster', colour: '#ffffff', opacity: 1 };
  }

  const session = createSession({
    name,
    state,
    svgText,
    meta,
  });
  await applyPlanWithState(session);

  console.log(`Imported SVG "${name}" #${session.id} — auto-detected ${rawPerimeter.length}-point perimeter`);
}

// ── ZIP import: restore full session ──
async function importFromZip(result: Extract<ImportResult, { type: 'zip' }>) {
  const { name, state, svgText, meta, panoramaBlobs: panoBlobs } = result;
  if (Object.keys(panoBlobs).length > 0) {
    setPanoramaBlobs(panoBlobs);
  }
  const session = createSession({ name, state, svgText, meta });
  await applyPlanWithState(session);
}

// ── Session picker ──
const picker = new SessionPicker(
  document.getElementById('plan-picker') as HTMLSelectElement,
  document.getElementById('btn-download') as HTMLButtonElement,
  document.getElementById('btn-upload') as HTMLButtonElement,
  document.getElementById('btn-delete') as HTMLButtonElement,
  [], // populated in init()
  {
    onSelectPreset: (planId) => loadPreset(planId),
    onSelectSession: (session) => loadSession(session),
    onImportZip: (result) => importFromZip(result),
    onImportSvg: (result) => importFromSvg(result),
  },
);

// ── G-buffer recorder ──
const gbufferRecorder = new GBufferRecorder(scene, camera, renderer, composer);
gbufferRecorder.onGenerated = () => {
  // Auto-save camera state so the zip includes latest position
  saveCameraState();
};

// ── Panorama renderer ──
const panoramaRenderer = new PanoramaRenderer(renderer, scene);

async function capturePanorama() {
  if (!currentPlan || !currentSceneState) return;

  // Find which room the camera is in
  const room = nav.getCurrentRoom(camera.position.x, camera.position.z);
  if (!room) {
    console.warn('Panorama: camera is not inside any room');
    return;
  }

  console.log(`Capturing panorama for ${room.name} (${room.id}) at [${camera.position.x.toFixed(2)}, ${camera.position.y.toFixed(2)}, ${camera.position.z.toFixed(2)}]`);

  const panoPos = new THREE.Vector3(
    camera.position.x,
    1.5, // fixed eye height for panoramas
    camera.position.z,
  );

  const { bare, furnished } = await panoramaRenderer.capture(panoPos);

  // Save position metadata to scene state
  if (!currentSceneState.panoramas) currentSceneState.panoramas = {};
  currentSceneState.panoramas[room.id] = {
    roomId: room.id,
    roomName: room.name,
    position: [panoPos.x, panoPos.y, panoPos.z],
  };

  // Store both PNG blobs in memory for ZIP export
  setPanoramaBlob(`${room.id}_bare`, bare);
  setPanoramaBlob(`${room.id}_furnished`, furnished);

  // Persist state
  saveCameraState();

  console.log(`Panoramas saved for ${room.name} — bare: ${(bare.size / 1024 / 1024).toFixed(1)} MB, furnished: ${(furnished.size / 1024 / 1024).toFixed(1)} MB`);
}

// ── Controls help overlay ──
const controlsOverlay = document.getElementById('controls-overlay')!;
document.getElementById('controls-close')!.addEventListener('click', () => {
  controlsOverlay.classList.add('hidden');
});
controlsOverlay.addEventListener('click', (e) => {
  if (e.target === controlsOverlay) controlsOverlay.classList.add('hidden');
});

function toggleControlsOverlay() {
  controlsOverlay.classList.toggle('hidden');
}

// ── Keyboard shortcuts ──
let minimapVisible = true;
window.addEventListener('keydown', (e) => {
  // Suppress all shortcuts when typing in a search field
  if (editMode.isSearchFocused) return;

  // Controls overlay — always available
  if (e.key === 'q' || e.key === 'Q') {
    toggleControlsOverlay();
    return;
  }
  if (e.key === 'Escape' && !controlsOverlay.classList.contains('hidden')) {
    controlsOverlay.classList.add('hidden');
    return;
  }

  // Don't process other shortcuts while controls overlay is open
  if (!controlsOverlay.classList.contains('hidden')) return;

  if (e.key === 'e' || e.key === 'E') {
    editMode.toggle();
  }
  if (e.key === 'm' || e.key === 'M') {
    minimapVisible = !minimapVisible;
    (document.getElementById('minimap-container') as HTMLElement).style.display =
      minimapVisible ? '' : 'none';
  }
  if (e.key === 'f' || e.key === 'F') {
    doorPanels.toggle();
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
    if (e.key === 'p' || e.key === 'P') {
      capturePanorama();
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
  // The manifest is the only thing we fetch up front — just enough to label
  // the Presets group. Preset bundles are fetched on demand when picked;
  // saved sessions carry their own svgText + meta and need no fetch.
  const manifest = await loadManifest();
  picker.setPresets(manifest);
  picker.rebuild();

  const lastId = getActiveSessionId();
  const lastSession = lastId != null ? getSession(lastId) : null;

  if (lastSession) {
    await loadSession(lastSession);
  } else {
    await loadPreset(manifest[0].id);
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
