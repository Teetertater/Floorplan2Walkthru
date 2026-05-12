import * as THREE from 'three';
import { Plan, Room } from '../cubicasa/types';
import { FURNITURE_CATALOG, getFurnitureById } from '../assets/catalog';
import { TEXTURE_CATALOG, TextureMeta } from '../assets/textureCatalog';
import { FurniturePlacement, SceneState, SurfaceStyle } from '../state/types';
import { FurnitureManager } from '../scene/furniture';

type HitType = 'furniture' | 'wall' | 'floor' | 'ceiling' | 'none';

interface HitInfo {
  type: HitType;
  object: THREE.Object3D | null;
  point: THREE.Vector3;
  instanceId?: string;
  wallId?: string;
}

// ── Emissive highlight helpers ──
// We store the original emissive ONCE per material. Every highlight reads/restores from it.
// This prevents stacking where hover + select compound.

function saveEmissive(mat: THREE.MeshStandardMaterial) {
  if (mat.userData._baseEmissive === undefined && mat.emissive) {
    mat.userData._baseEmissive = mat.emissive.getHex();
  }
}

function setEmissive(obj: THREE.Object3D, color: number) {
  obj.traverse((child) => {
    if ((child as THREE.Mesh).isMesh) {
      const mat = (child as THREE.Mesh).material as THREE.MeshStandardMaterial;
      if (mat.emissive) {
        saveEmissive(mat);
        mat.emissive.setHex(color);
      }
    }
  });
}

function restoreEmissive(obj: THREE.Object3D) {
  obj.traverse((child) => {
    if ((child as THREE.Mesh).isMesh) {
      const mat = (child as THREE.Mesh).material as THREE.MeshStandardMaterial;
      if (mat.emissive && mat.userData._baseEmissive !== undefined) {
        mat.emissive.setHex(mat.userData._baseEmissive);
        delete mat.userData._baseEmissive;
      }
    }
  });
}

// ── Edit Mode Controller ──

export class EditModeController {
  private enabled = false;
  private scene: THREE.Scene;
  private camera: THREE.Camera;
  private domElement: HTMLElement;
  private raycaster = new THREE.Raycaster();
  private mouse = new THREE.Vector2();
  private plan: Plan | null = null;
  private sceneState: SceneState | null = null;
  private furnitureManager: FurnitureManager;
  private onStateChange: () => void;

  // Hover
  private hoveredObject: THREE.Object3D | null = null;

  // Selection
  private selectedInstanceId: string | null = null;
  private gizmoMode: 'move' | 'scale' = 'move';
  private isDragging = false;
  private didDrag = false;
  private dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private dragOffset = new THREE.Vector3();
  private dragStartScale = 1;
  private lastScreenY = 0;
  private pendingModeToggle = false;

  // Wall highlight
  private highlightedWallMeshes: THREE.Mesh[] = [];
  private wallSelectionRoom: string | null = null;
  private wallSelectionId: string | null = null;

  // UI elements
  private badge: HTMLElement;
  private gizmoLabel: HTMLElement;
  private surfaceMenu: HTMLElement;
  private objectPickerOverlay: HTMLElement;
  private objectPickerSearch: HTMLInputElement;
  private objectPickerGrid: HTMLElement;
  private texturePickerOverlay: HTMLElement;
  private texturePickerGrid: HTMLElement;
  private colourPickerOverlay: HTMLElement;
  private colourPickerInput: HTMLInputElement;
  private colourIntensityInput: HTMLInputElement;
  private colourIntensityVal: HTMLElement;
  private pickerCallback: ((id: string) => void) | null = null;
  private pickerPlacementFilter: 'floor' | 'wall' | 'ceiling' | null = null;
  private surfaceMenuTarget: HitInfo | null = null;
  private furnitureMenu: HTMLElement;
  private furnitureMenuTargetId: string | null = null;

  constructor(
    scene: THREE.Scene,
    camera: THREE.Camera,
    domElement: HTMLElement,
    furnitureManager: FurnitureManager,
    onStateChange: () => void,
  ) {
    this.scene = scene;
    this.camera = camera;
    this.domElement = domElement;
    this.furnitureManager = furnitureManager;
    this.onStateChange = onStateChange;

    this.badge = document.getElementById('edit-mode-badge')!;
    this.gizmoLabel = document.getElementById('gizmo-label')!;
    this.surfaceMenu = document.getElementById('surface-menu')!;
    this.objectPickerOverlay = document.getElementById('object-picker-overlay')!;
    this.objectPickerSearch = document.getElementById('object-picker-search') as HTMLInputElement;
    this.objectPickerGrid = document.getElementById('object-picker-grid')!;
    this.texturePickerOverlay = document.getElementById('texture-picker-overlay')!;
    this.texturePickerGrid = document.getElementById('texture-picker-grid')!;
    this.colourPickerOverlay = document.getElementById('colour-picker-overlay')!;
    this.colourPickerInput = document.getElementById('colour-picker-input') as HTMLInputElement;
    this.colourIntensityInput = document.getElementById('colour-intensity') as HTMLInputElement;
    this.colourIntensityVal = document.getElementById('colour-intensity-val')!;
    this.furnitureMenu = document.getElementById('furniture-menu')!;

    this.bindEvents();
  }

  get isEnabled() { return this.enabled; }

  setPlan(plan: Plan, state: SceneState) {
    this.plan = plan;
    this.sceneState = state;
    this.deselect();
    this.clearWallHighlights();
  }

  toggle() {
    this.enabled = !this.enabled;
    this.badge.style.display = this.enabled ? 'block' : 'none';
    if (!this.enabled) {
      this.deselect();
      this.clearHover();
      this.clearWallHighlights();
      this.closeSurfaceMenu();
      this.closeFurnitureMenu();
      this.closeObjectPicker();
      this.closeTexturePicker();
      this.closeColourPicker();
      this.domElement.style.cursor = '';
    }
  }

  // ── Helpers ──

  private exitPointerLock() {
    if (document.pointerLockElement) {
      document.exitPointerLock();
    }
  }

  private menuPosition(e: MouseEvent): [number, number] {
    if (document.pointerLockElement) {
      return [window.innerWidth / 2, window.innerHeight / 2];
    }
    return [e.clientX, e.clientY];
  }

  private isModalOpen(): boolean {
    return this.objectPickerOverlay.classList.contains('visible') ||
           this.texturePickerOverlay.classList.contains('visible') ||
           this.colourPickerOverlay.classList.contains('visible') ||
           this.surfaceMenu.classList.contains('visible') ||
           this.furnitureMenu.classList.contains('visible');
  }

  /** True when the search input is focused (used to suppress global keybinds) */
  get isSearchFocused(): boolean {
    return document.activeElement === this.objectPickerSearch;
  }

  // ── Events ──

  private bindEvents() {
    this.domElement.addEventListener('mousemove', (e) => this.onMouseMove(e));
    this.domElement.addEventListener('mousedown', (e) => this.onMouseDown(e));
    this.domElement.addEventListener('mouseup', () => this.onMouseUp());
    this.domElement.addEventListener('contextmenu', (e) => { if (this.enabled) e.preventDefault(); });
    this.domElement.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });

    // Surface menu
    this.surfaceMenu.addEventListener('click', (e) => {
      const action = (e.target as HTMLElement).dataset.action;
      if (!action) return;
      this.closeSurfaceMenu();
      if (action === 'retexture') this.openTexturePicker();
      if (action === 'colour') this.openColourPicker();
      if (action === 'add') {
        const targetType = this.surfaceMenuTarget?.type;
        const filter = targetType === 'wall' ? 'wall' as const
          : targetType === 'ceiling' ? 'ceiling' as const
          : 'floor' as const;
        this.openObjectPicker((id) => this.addFurnitureAtPoint(id), filter);
      }
    });

    // Furniture context menu
    this.furnitureMenu.addEventListener('click', (e) => {
      const action = (e.target as HTMLElement).dataset.action;
      if (!action) return;
      const targetId = this.furnitureMenuTargetId;
      this.closeFurnitureMenu();
      if (!targetId) return;
      if (action === 'swap') {
        const meta = getFurnitureById(this.findSceneObject(targetId)?.userData?.assetId);
        this.openObjectPicker((newId) => this.swapFurniture(targetId, newId), meta?.placement);
      }
      if (action === 'delete') this.deleteFurniture(targetId);
    });

    // Object picker
    this.objectPickerSearch.addEventListener('input', () => this.renderObjectPickerGrid());
    this.objectPickerOverlay.addEventListener('click', (e) => {
      if (e.target === this.objectPickerOverlay) this.closeObjectPicker();
    });

    // Texture picker
    this.texturePickerOverlay.addEventListener('click', (e) => {
      if (e.target === this.texturePickerOverlay) this.closeTexturePicker();
    });

    // Colour picker buttons + intensity slider
    this.colourIntensityInput.addEventListener('input', () => {
      this.colourIntensityVal.textContent = `${this.colourIntensityInput.value}%`;
    });
    document.getElementById('colour-apply')!.addEventListener('click', () => {
      const intensity = parseInt(this.colourIntensityInput.value) / 100;
      this.applyColour(this.colourPickerInput.value, intensity);
      this.closeColourPicker();
    });
    document.getElementById('colour-none')!.addEventListener('click', () => {
      this.clearSurfaceColour();
      this.closeColourPicker();
    });
    document.getElementById('colour-cancel')!.addEventListener('click', () => {
      this.closeColourPicker();
    });
    this.colourPickerOverlay.addEventListener('click', (e) => {
      if (e.target === this.colourPickerOverlay) this.closeColourPicker();
    });

    // Escape
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (this.objectPickerOverlay.classList.contains('visible')) {
          this.closeObjectPicker();
        } else if (this.texturePickerOverlay.classList.contains('visible')) {
          this.closeTexturePicker();
        } else if (this.colourPickerOverlay.classList.contains('visible')) {
          this.closeColourPicker();
        } else if (this.furnitureMenu.classList.contains('visible')) {
          this.closeFurnitureMenu();
        } else if (this.surfaceMenu.classList.contains('visible')) {
          this.closeSurfaceMenu();
        } else if (this.selectedInstanceId) {
          this.deselect();
        }
      }
    });
  }

  // ── Raycasting ──

  private updateMouse(e?: MouseEvent) {
    if (document.pointerLockElement) {
      // Pointer locked (FPS mode) — always raycast from screen center
      this.mouse.x = 0;
      this.mouse.y = 0;
    } else if (e) {
      this.mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
      this.mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
    }
  }

  private raycast(): HitInfo {
    this.raycaster.setFromCamera(this.mouse, this.camera);
    const intersects = this.raycaster.intersectObjects(this.scene.children, true);

    for (const hit of intersects) {
      const ud = this.findUserData(hit.object);
      if (!ud) continue;

      if (ud.type === 'furniture') {
        return { type: 'furniture', object: this.findFurnitureRoot(hit.object), point: hit.point, instanceId: ud.instanceId as string };
      }
      if (ud.type === 'wall' || ud.type === 'lintel') {
        return { type: 'wall', object: hit.object, point: hit.point, wallId: ud.wallId as string };
      }
      if (ud.type === 'floor') {
        return { type: 'floor', object: hit.object, point: hit.point };
      }
      if (ud.type === 'ceiling') {
        return { type: 'ceiling', object: hit.object, point: hit.point };
      }
    }

    return { type: 'none', object: null, point: new THREE.Vector3() };
  }

  private static KNOWN_TYPES = new Set(['furniture', 'wall', 'lintel', 'floor', 'ceiling', 'ground', 'door_frame', 'window_pane']);

  private findUserData(obj: THREE.Object3D): Record<string, unknown> | null {
    let cur: THREE.Object3D | null = obj;
    while (cur) {
      if (cur.userData?.type && EditModeController.KNOWN_TYPES.has(cur.userData.type as string)) {
        return cur.userData;
      }
      cur = cur.parent;
    }
    return null;
  }

  private findFurnitureRoot(obj: THREE.Object3D): THREE.Object3D {
    let cur: THREE.Object3D = obj;
    while (cur.parent) {
      if (cur.userData?.type === 'furniture') return cur;
      cur = cur.parent;
    }
    return obj;
  }

  // ── Hover ──

  private onMouseMove(e: MouseEvent) {
    if (!this.enabled) return;
    this.updateMouse(e);

    if (this.isDragging && this.selectedInstanceId) {
      this.dragSelected(e);
      return;
    }

    if (this.isModalOpen()) return;

    const hit = this.raycast();
    const hitObj = hit.type === 'furniture' && hit.object ? hit.object : null;

    // Only update hover if target changed
    if (hitObj !== this.hoveredObject) {
      this.clearHover();
      if (hitObj && hit.instanceId !== this.selectedInstanceId) {
        this.hoveredObject = hitObj;
        setEmissive(hitObj, 0x224466);
      }
    }

    this.domElement.style.cursor =
      (hit.type === 'furniture' || hit.type === 'wall' || hit.type === 'floor')
        ? 'pointer' : '';
  }

  private clearHover() {
    if (this.hoveredObject) {
      restoreEmissive(this.hoveredObject);
      this.hoveredObject = null;
    }
  }

  // ── Mouse down: left-click = furniture select/drag, right-click = context actions ──

  private onMouseDown(e: MouseEvent) {
    if (!this.enabled) return;
    if (this.isModalOpen()) return;

    if (e.button === 0) {
      // Left-click: dismiss any context menus first
      this.closeSurfaceMenu();
      this.closeFurnitureMenu();
      this.updateMouse(e);
      const hit = this.raycast();
      if (hit.type === 'furniture' && hit.instanceId) {
        if (this.selectedInstanceId === hit.instanceId) {
          // Start drag; if user releases without moving, toggle mode
          this.pendingModeToggle = true;
          this.didDrag = false;
          this.startDrag(hit);
        } else {
          this.deselect();
          this.clearHover();
          this.clearWallHighlights();
          this.selectFurniture(hit.instanceId);
        }
      } else {
        this.deselect();
        this.clearWallHighlights();
      }
    } else if (e.button === 2) {
      // Right-click: context actions
      e.preventDefault();
      this.closeSurfaceMenu();
      this.closeFurnitureMenu();
      this.updateMouse(e);
      const hit = this.raycast();

      if (hit.type === 'furniture' && hit.instanceId) {
        const [mx, my] = this.menuPosition(e);
        this.exitPointerLock();
        this.furnitureMenuTargetId = hit.instanceId;
        this.showFurnitureMenu(mx, my);
      } else if (hit.type === 'wall') {
        const [mx, my] = this.menuPosition(e);
        this.exitPointerLock();
        this.deselect();
        this.handleWallRightClick(hit, mx, my);
      } else if (hit.type === 'floor' || hit.type === 'ceiling') {
        const [mx, my] = this.menuPosition(e);
        this.exitPointerLock();
        this.deselect();
        this.clearWallHighlights();
        this.surfaceMenuTarget = hit;
        this.showSurfaceMenu(mx, my);
      }
    }
  }

  private onMouseUp() {
    if (this.isDragging) {
      this.isDragging = false;
      if (this.pendingModeToggle && !this.didDrag) {
        // Click without drag → toggle mode
        this.gizmoMode = this.gizmoMode === 'move' ? 'scale' : 'move';
        this.updateGizmoLabel();
      } else {
        this.syncPlacementFromScene();
      }
      this.pendingModeToggle = false;
      this.didDrag = false;
    }
  }


  // ── Selection ──

  private selectFurniture(instanceId: string) {
    this.selectedInstanceId = instanceId;
    this.gizmoMode = 'move';
    this.updateGizmoLabel();
    const obj = this.findSceneObject(instanceId);
    if (obj) setEmissive(obj, 0x336699);
  }

  private deselect() {
    if (this.selectedInstanceId) {
      const obj = this.findSceneObject(this.selectedInstanceId);
      if (obj) restoreEmissive(obj);
      this.selectedInstanceId = null;
    }
    this.gizmoMode = 'move';
    this.updateGizmoLabel();
  }

  private updateGizmoLabel() {
    if (this.selectedInstanceId) {
      this.gizmoLabel.textContent = this.gizmoMode === 'move' ? '↕ Move / Rotate' : '⤡ Scale / Height';
      this.gizmoLabel.classList.add('visible');
    } else {
      this.gizmoLabel.classList.remove('visible');
    }
  }

  private findSceneObject(instanceId: string): THREE.Object3D | null {
    let found: THREE.Object3D | null = null;
    this.furnitureManager.getGroup().traverse((child) => {
      if (child.userData?.instanceId === instanceId) found = child;
    });
    return found;
  }

  // ── Drag ──

  private startDrag(hit: HitInfo) {
    this.isDragging = true;
    const obj = this.findSceneObject(this.selectedInstanceId!);
    if (obj) {
      // Set drag plane at the object's Y height so ceiling/wall items drag correctly
      this.dragPlane.set(new THREE.Vector3(0, 1, 0), -obj.position.y);
      this.dragOffset.copy(obj.position).sub(hit.point);
      this.dragOffset.y = 0;
      const baseScale = (obj.userData?.baseScale as number) || 1;
      this.dragStartScale = obj.scale.x / baseScale;
    }
  }

  private dragSelected(e: MouseEvent) {
    const obj = this.findSceneObject(this.selectedInstanceId!);
    if (!obj) return;
    this.didDrag = true;

    if (this.gizmoMode === 'move') {
      this.raycaster.setFromCamera(this.mouse, this.camera);
      const target = new THREE.Vector3();
      if (this.raycaster.ray.intersectPlane(this.dragPlane, target)) {
        obj.position.x = target.x + this.dragOffset.x;
        obj.position.z = target.z + this.dragOffset.z;
      }
    } else {
      // Scale mode: accumulate raw movementY pixels
      // Drag up (negative movementY) = bigger, drag down = smaller
      // 45 degrees ≈ half screen height. Use multiplicative scaling so it feels natural.
      const pixelDelta = -e.movementY;
      const factor = Math.pow(2, pixelDelta / (window.innerHeight * 0.5));
      const baseScale = (obj.userData?.baseScale as number) || 1;
      const currentUserScale = obj.scale.x / baseScale;
      const newUserScale = Math.max(0.02, currentUserScale * factor);
      obj.scale.setScalar(baseScale * newUserScale);
    }
  }

  // ── Scroll to rotate / raise-lower ──

  private onWheel(e: WheelEvent) {
    if (!this.enabled || !this.selectedInstanceId) return;
    e.preventDefault();
    const obj = this.findSceneObject(this.selectedInstanceId);
    if (!obj) return;

    if (this.gizmoMode === 'move') {
      // Rotate
      obj.rotation.y += THREE.MathUtils.degToRad(e.deltaY > 0 ? -5 : 5);
    } else {
      // Raise / lower
      obj.position.y += e.deltaY > 0 ? -0.05 : 0.05;
    }
    this.syncPlacementFromScene();
  }

  // ── Sync state ──

  private syncPlacementFromScene() {
    if (!this.sceneState || !this.selectedInstanceId) return;
    const obj = this.findSceneObject(this.selectedInstanceId);
    if (!obj) return;

    const p = this.sceneState.furniture.find(f => f.instanceId === this.selectedInstanceId);
    if (p) {
      p.position = [obj.position.x, obj.position.y, obj.position.z];
      p.rotation = THREE.MathUtils.radToDeg(obj.rotation.y);
      const baseScale = (obj.userData?.baseScale as number) || 1;
      p.scale = obj.scale.x / baseScale;
      this.onStateChange();
    }
  }

  // ── Wall right-click: room → specific ──

  private handleWallRightClick(hit: HitInfo, clientX: number, clientY: number) {
    if (!this.plan || !hit.wallId) return;

    const roomId = this.findRoomForWall(hit.wallId);

    if (this.wallSelectionRoom === roomId && this.wallSelectionId === null) {
      // Second right-click in same room → narrow to specific wall
      this.clearWallHighlights();
      this.wallSelectionRoom = roomId;
      this.wallSelectionId = hit.wallId;
      this.highlightWall(hit.wallId);
    } else {
      // First right-click → highlight all room walls
      this.clearWallHighlights();
      this.wallSelectionRoom = roomId;
      this.wallSelectionId = null;
      if (roomId) this.highlightRoomWalls(roomId);
    }

    this.surfaceMenuTarget = hit;
    this.showSurfaceMenu(clientX, clientY);
  }

  private findRoomForWall(wallId: string): string | null {
    if (!this.plan) return null;
    const wall = this.plan.walls.find(w => w.id === wallId);
    if (!wall) return null;

    const midX = (wall.start[0] + wall.end[0]) / 2;
    const midZ = (wall.start[1] + wall.end[1]) / 2;

    let bestRoom: Room | null = null;
    let bestDist = Infinity;

    for (const room of this.plan.rooms) {
      for (let i = 0; i < room.polygon.length; i++) {
        const [ax, az] = room.polygon[i];
        const [bx, bz] = room.polygon[(i + 1) % room.polygon.length];
        const dx = bx - ax, dz = bz - az;
        const lenSq = dx * dx + dz * dz;
        let dist: number;
        if (lenSq < 1e-8) {
          dist = Math.hypot(midX - ax, midZ - az);
        } else {
          const t = Math.max(0, Math.min(1, ((midX - ax) * dx + (midZ - az) * dz) / lenSq));
          dist = Math.hypot(midX - (ax + t * dx), midZ - (az + t * dz));
        }
        if (dist < bestDist) {
          bestDist = dist;
          bestRoom = room;
        }
      }
    }

    return bestDist < 0.5 && bestRoom ? bestRoom.id : null;
  }

  // ── Wall highlighting ──

  private highlightRoomWalls(roomId: string) {
    if (!this.plan) return;
    for (const wall of this.plan.walls) {
      if (this.findRoomForWall(wall.id) === roomId) {
        this.highlightWall(wall.id);
      }
    }
  }

  private highlightWall(wallId: string) {
    this.scene.traverse((child) => {
      if (!(child as THREE.Mesh).isMesh) return;
      const ud = child.userData;
      if ((ud.type === 'wall' || ud.type === 'lintel') && ud.wallId === wallId) {
        const mesh = child as THREE.Mesh;
        // Add a wireframe overlay to indicate selection without colour tinge
        const wireGeo = mesh.geometry;
        const wireMat = new THREE.MeshBasicMaterial({
          color: 0xffffff,
          wireframe: true,
          transparent: true,
          opacity: 0.15,
          depthTest: false,
        });
        const wire = new THREE.Mesh(wireGeo, wireMat);
        wire.position.copy(mesh.position);
        wire.rotation.copy(mesh.rotation);
        wire.scale.copy(mesh.scale);
        wire.userData._wallOverlay = true;
        mesh.parent?.add(wire);
        this.highlightedWallMeshes.push(mesh);
      }
    });
  }

  private clearWallHighlights() {
    // Remove wireframe overlays
    const toRemove: THREE.Object3D[] = [];
    this.scene.traverse((child) => {
      if (child.userData._wallOverlay) toRemove.push(child);
    });
    for (const obj of toRemove) {
      obj.parent?.remove(obj);
      (obj as THREE.Mesh).geometry; // geometry is shared, don't dispose
      ((obj as THREE.Mesh).material as THREE.Material).dispose();
    }
    this.highlightedWallMeshes = [];
    this.wallSelectionRoom = null;
    this.wallSelectionId = null;
  }

  // ── Surface menu ──

  private showSurfaceMenu(x: number, y: number) {
    this.surfaceMenu.style.left = `${x}px`;
    this.surfaceMenu.style.top = `${y}px`;
    this.surfaceMenu.classList.add('visible');
  }

  private closeSurfaceMenu() {
    this.surfaceMenu.classList.remove('visible');
  }

  // ── Furniture context menu ──

  private showFurnitureMenu(x: number, y: number) {
    this.furnitureMenu.style.left = `${x}px`;
    this.furnitureMenu.style.top = `${y}px`;
    this.furnitureMenu.classList.add('visible');
  }

  private closeFurnitureMenu() {
    this.furnitureMenu.classList.remove('visible');
    this.furnitureMenuTargetId = null;
  }

  private deleteFurniture(instanceId: string) {
    if (!this.sceneState) return;
    this.deselect();
    this.furnitureManager.remove(instanceId);
    this.sceneState.furniture = this.sceneState.furniture.filter(f => f.instanceId !== instanceId);
    this.onStateChange();
  }

  // ── Object picker ──

  private openObjectPicker(callback: (assetId: string) => void, placementFilter?: 'floor' | 'wall' | 'ceiling') {
    this.exitPointerLock();
    this.pickerCallback = callback;
    this.pickerPlacementFilter = placementFilter ?? null;
    this.objectPickerSearch.value = '';
    this.renderObjectPickerGrid();
    this.objectPickerOverlay.classList.add('visible');
    this.objectPickerSearch.focus();
  }

  private closeObjectPicker() {
    this.objectPickerOverlay.classList.remove('visible');
    this.pickerCallback = null;
  }

  private renderObjectPickerGrid() {
    const query = this.objectPickerSearch.value.toLowerCase();
    const pf = this.pickerPlacementFilter;
    const filtered = FURNITURE_CATALOG.filter(f => {
      if (pf && f.placement !== pf) return false;
      if (!query) return true;
      return f.name.toLowerCase().includes(query) ||
        f.category.includes(query) ||
        f.style.some(s => s.includes(query)) ||
        f.description.toLowerCase().includes(query);
    });

    this.objectPickerGrid.innerHTML = '';
    for (const item of filtered) {
      const card = document.createElement('div');
      card.className = 'picker-card';

      const img = document.createElement('img');
      img.src = item.thumbnailPath
        ? `/assets/thumbnails/${item.thumbnailPath}`
        : 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect fill="%23333" width="100" height="100"/><text fill="%23666" x="50" y="55" text-anchor="middle" font-size="12">No preview</text></svg>';
      img.alt = item.name;

      const name = document.createElement('div');
      name.className = 'card-name';
      name.textContent = item.name;

      const dims = document.createElement('div');
      dims.className = 'card-dims';
      dims.textContent = `${item.dimensions.w.toFixed(1)} × ${item.dimensions.d.toFixed(1)}m`;

      card.append(img, name, dims);
      card.addEventListener('click', () => {
        if (this.pickerCallback) this.pickerCallback(item.id);
        this.closeObjectPicker();
      });
      this.objectPickerGrid.appendChild(card);
    }
  }

  // ── Texture picker ──

  private openTexturePicker() {
    this.exitPointerLock();
    this.renderTexturePickerGrid();
    this.texturePickerOverlay.classList.add('visible');
  }

  private closeTexturePicker() {
    this.texturePickerOverlay.classList.remove('visible');
  }

  private renderTexturePickerGrid() {
    const hitType = this.surfaceMenuTarget?.type;
    let suitableFor: string | undefined;
    if (hitType === 'wall') suitableFor = 'wall';
    else if (hitType === 'floor') suitableFor = 'floor';
    else if (hitType === 'ceiling') suitableFor = 'ceiling';

    const sorted = [...TEXTURE_CATALOG].sort((a, b) => {
      const aMatch = suitableFor && a.suitableFor.includes(suitableFor as 'wall' | 'floor' | 'ceiling') ? 0 : 1;
      const bMatch = suitableFor && b.suitableFor.includes(suitableFor as 'wall' | 'floor' | 'ceiling') ? 0 : 1;
      return aMatch - bMatch;
    });

    this.texturePickerGrid.innerHTML = '';
    for (const tex of sorted) {
      const card = document.createElement('div');
      card.className = 'tex-card';

      const img = document.createElement('img');
      img.src = tex.diffPath;
      img.alt = tex.name;

      const label = document.createElement('div');
      label.className = 'tex-name';
      label.textContent = tex.name;

      card.append(img, label);
      card.addEventListener('click', () => {
        this.applyTexture(tex);
        this.closeTexturePicker();
      });
      this.texturePickerGrid.appendChild(card);
    }
  }

  // ── Apply texture ──

  private applyTexture(tex: TextureMeta) {
    const loader = new THREE.TextureLoader();
    const loadTex = (path: string, linear = false) => {
      const t = loader.load(path);
      t.colorSpace = linear ? THREE.LinearSRGBColorSpace : THREE.SRGBColorSpace;
      t.wrapS = THREE.RepeatWrapping;
      t.wrapT = THREE.RepeatWrapping;
      t.repeat.set(tex.tiling[0], tex.tiling[1]);
      return t;
    };

    const diff = loadTex(tex.diffPath);
    const norm = tex.normalPath ? loadTex(tex.normalPath, true) : null;
    const rough = tex.roughPath ? loadTex(tex.roughPath, true) : null;

    const targets = this.getSurfaceTargets();

    // Preserve existing colour tint
    const currentColour = (targets[0]?.material as THREE.MeshStandardMaterial)?.color?.clone();

    for (const mesh of targets) {
      const mat = mesh.material as THREE.MeshStandardMaterial;
      mat.map = diff;
      if (norm) mat.normalMap = norm;
      if (rough) mat.roughnessMap = rough;
      if (currentColour) mat.color.copy(currentColour);
      mat.needsUpdate = true;
    }

    const existing = this.sceneState?.surfaces?.[this.getSurfaceKey()];
    this.saveSurfaceStyle({
      type: 'texture',
      textureId: tex.id,
      colour: currentColour ? '#' + currentColour.getHexString() : undefined,
      opacity: existing?.opacity,
    });
    this.clearWallHighlights();
  }

  // ── Colour picker ──

  private openColourPicker() {
    this.exitPointerLock();
    this.colourPickerOverlay.classList.add('visible');
  }

  private closeColourPicker() {
    this.colourPickerOverlay.classList.remove('visible');
  }

  private applyColour(hex: string, intensity: number) {
    const picked = new THREE.Color(hex);
    const targets = this.getSurfaceTargets();

    for (const mesh of targets) {
      const mat = mesh.material as THREE.MeshStandardMaterial;
      if (intensity >= 0.99) {
        // Solid colour — remove texture
        mat.map = null;
        mat.normalMap = null;
        mat.roughnessMap = null;
        mat.color.copy(picked);
      } else {
        // Tint: blend picked colour towards white. Texture stays.
        // intensity 0 → white (no tint), intensity 1 → full colour
        const white = new THREE.Color(0xffffff);
        mat.color.copy(white.lerp(picked, intensity));
      }
      mat.transparent = false;
      mat.opacity = 1;
      mat.roughness = 0.9;
      mat.needsUpdate = true;
    }

    this.saveSurfaceStyle({ type: 'colour', colour: hex, opacity: intensity });
    this.clearWallHighlights();
  }

  /** Reset surface to raw texture with no colour tint */
  private clearSurfaceColour() {
    const targets = this.getSurfaceTargets();
    for (const mesh of targets) {
      const mat = mesh.material as THREE.MeshStandardMaterial;
      mat.color.setHex(0xffffff);
      mat.transparent = false;
      mat.opacity = 1;
      mat.needsUpdate = true;
    }
    // Remove from saved state
    if (this.sceneState?.surfaces) {
      delete this.sceneState.surfaces[this.getSurfaceKey()];
      this.onStateChange();
    }
    this.clearWallHighlights();
  }

  /** Get the meshes to apply texture/colour to based on current selection */
  private getSurfaceTargets(): THREE.Mesh[] {
    // If walls are highlighted, apply to those
    if (this.highlightedWallMeshes.length > 0) return this.highlightedWallMeshes;

    // Otherwise apply to floor or ceiling based on what was right-clicked
    const targetType = this.surfaceMenuTarget?.type;
    const meshType = targetType === 'ceiling' ? 'ceiling' : 'floor';

    const meshes: THREE.Mesh[] = [];
    this.scene.traverse((child) => {
      if ((child as THREE.Mesh).isMesh && child.userData?.type === meshType) {
        meshes.push(child as THREE.Mesh);
      }
    });
    return meshes;
  }

  // ── Surface state persistence ──

  /** Compute the storage key for the current surface target */
  private getSurfaceKey(): string {
    if (this.highlightedWallMeshes.length > 0) {
      if (this.wallSelectionId) return `wall:${this.wallSelectionId}`;
      if (this.wallSelectionRoom) return `walls:${this.wallSelectionRoom}`;
      // Fallback: use first wall id
      const ud = this.highlightedWallMeshes[0]?.userData;
      if (ud?.wallId) return `wall:${ud.wallId}`;
    }
    const targetType = this.surfaceMenuTarget?.type;
    if (targetType === 'ceiling') return 'ceiling';
    return 'floor';
  }

  private saveSurfaceStyle(style: SurfaceStyle) {
    if (!this.sceneState) return;
    if (!this.sceneState.surfaces) this.sceneState.surfaces = {};
    this.sceneState.surfaces[this.getSurfaceKey()] = style;
    this.onStateChange();
  }

  /** Apply all saved surface styles to the current scene. Call after scene is built. */
  applySavedSurfaces() {
    if (!this.sceneState?.surfaces) return;
    const loader = new THREE.TextureLoader();

    for (const [key, style] of Object.entries(this.sceneState.surfaces)) {
      const meshes = this.findMeshesForKey(key);
      if (meshes.length === 0) continue;

      if (style.type === 'texture' && style.textureId) {
        const tex = TEXTURE_CATALOG.find(t => t.id === style.textureId);
        if (!tex) continue;
        const loadT = (path: string, linear = false) => {
          const t = loader.load(path);
          t.colorSpace = linear ? THREE.LinearSRGBColorSpace : THREE.SRGBColorSpace;
          t.wrapS = THREE.RepeatWrapping;
          t.wrapT = THREE.RepeatWrapping;
          t.repeat.set(tex.tiling[0], tex.tiling[1]);
          return t;
        };
        const diff = loadT(tex.diffPath);
        const norm = tex.normalPath ? loadT(tex.normalPath, true) : null;
        const rough = tex.roughPath ? loadT(tex.roughPath, true) : null;
        for (const mesh of meshes) {
          const mat = mesh.material as THREE.MeshStandardMaterial;
          mat.map = diff;
          if (norm) mat.normalMap = norm;
          if (rough) mat.roughnessMap = rough;
          // Restore colour tint if saved alongside texture
          if (style.colour) {
            const picked = new THREE.Color(style.colour);
            const intensity = style.opacity ?? 1;
            if (intensity >= 0.99) {
              mat.color.copy(picked);
            } else {
              mat.color.copy(new THREE.Color(0xffffff).lerp(picked, intensity));
            }
          } else {
            mat.color.setHex(0xffffff);
          }
          mat.transparent = false;
          mat.opacity = 1;
          mat.needsUpdate = true;
        }
      } else if (style.type === 'colour' && style.colour) {
        const picked = new THREE.Color(style.colour);
        const intensity = style.opacity ?? 1; // opacity field stores intensity
        for (const mesh of meshes) {
          const mat = mesh.material as THREE.MeshStandardMaterial;
          if (intensity >= 0.99) {
            mat.map = null;
            mat.normalMap = null;
            mat.roughnessMap = null;
            mat.color.copy(picked);
          } else {
            const white = new THREE.Color(0xffffff);
            mat.color.copy(white.lerp(picked, intensity));
          }
          mat.transparent = false;
          mat.opacity = 1;
          mat.roughness = 0.9;
          mat.needsUpdate = true;
        }
      }
    }
  }

  private findMeshesForKey(key: string): THREE.Mesh[] {
    const meshes: THREE.Mesh[] = [];
    if (key === 'floor' || key === 'ceiling') {
      this.scene.traverse((child) => {
        if ((child as THREE.Mesh).isMesh && child.userData?.type === key) {
          meshes.push(child as THREE.Mesh);
        }
      });
    } else if (key.startsWith('wall:')) {
      const wallId = key.slice(5);
      this.scene.traverse((child) => {
        if ((child as THREE.Mesh).isMesh) {
          const ud = child.userData;
          if ((ud.type === 'wall' || ud.type === 'lintel') && ud.wallId === wallId) {
            meshes.push(child as THREE.Mesh);
          }
        }
      });
    } else if (key.startsWith('walls:')) {
      const roomId = key.slice(6);
      if (this.plan) {
        for (const wall of this.plan.walls) {
          if (this.findRoomForWall(wall.id) === roomId) {
            this.scene.traverse((child) => {
              if ((child as THREE.Mesh).isMesh) {
                const ud = child.userData;
                if ((ud.type === 'wall' || ud.type === 'lintel') && ud.wallId === wall.id) {
                  meshes.push(child as THREE.Mesh);
                }
              }
            });
          }
        }
      }
    }
    return meshes;
  }

  // ── Furniture operations ──

  private async swapFurniture(instanceId: string, newAssetId: string) {
    if (!this.sceneState) return;
    const placement = this.sceneState.furniture.find(f => f.instanceId === instanceId);
    if (!placement) return;

    this.deselect(); // clear highlight before removing
    placement.assetId = newAssetId;
    this.furnitureManager.remove(instanceId);
    await this.furnitureManager.place(placement);
    this.onStateChange();
  }

  private async addFurnitureAtPoint(assetId: string) {
    if (!this.sceneState || !this.surfaceMenuTarget) return;

    const meta = getFurnitureById(assetId);
    if (!meta) return;

    const point = this.surfaceMenuTarget.point;
    // Generate a globally unique instanceId
    const instanceId = `${assetId}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

    let roomId = 'unknown';
    if (this.plan) {
      for (const room of this.plan.rooms) {
        if (this.pointInPolygon(point.x, point.z, room.polygon)) {
          roomId = room.id;
          break;
        }
      }
    }

    // Set y based on placement type
    let y = 0;
    if (meta.placement === 'ceiling') {
      y = 2.2 - meta.dimensions.h; // hang from ceiling
    } else if (meta.placement === 'wall') {
      y = 1.4; // center on wall at eye-ish height
    }

    const placement: FurniturePlacement = {
      assetId,
      instanceId,
      roomId,
      position: [point.x, y, point.z],
      rotation: 0,
      scale: 1,
    };

    this.sceneState.furniture.push(placement);
    await this.furnitureManager.place(placement);
    this.onStateChange();
  }

  private pointInPolygon(x: number, z: number, polygon: [number, number][]): boolean {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const [xi, zi] = polygon[i], [xj, zj] = polygon[j];
      if (((zi > z) !== (zj > z)) && (x < (xj - xi) * (z - zi) / (zj - zi) + xi)) {
        inside = !inside;
      }
    }
    return inside;
  }
}
