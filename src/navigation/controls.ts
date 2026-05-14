import * as THREE from 'three';
import { PointerLockControls } from 'three/examples/jsm/controls/PointerLockControls.js';
import { Room } from '../cubicasa/types';

const MOVE_SPEED = 3.0; // m/s
const EYE_HEIGHT = 1.4;
const MOUSE_SENSITIVITY = 0.002;

function pointInPolygon(x: number, z: number, polygon: [number, number][]): boolean {
  let inside = false;
  const n = polygon.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = polygon[i][0], zi = polygon[i][1];
    const xj = polygon[j][0], zj = polygon[j][1];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

export type MouseMode = 'free' | 'locked';

export class NavigationController {
  camera: THREE.PerspectiveCamera;
  pointerLock: PointerLockControls;

  private moveForward = false;
  private moveBackward = false;
  private moveLeft = false;
  private moveRight = false;

  private velocity = new THREE.Vector3();
  private direction = new THREE.Vector3();
  private prevTime = performance.now();

  private rooms: Room[] = [];

  private mouseMode: MouseMode = 'free';
  private isDragging = false;
  private euler = new THREE.Euler(0, 0, 0, 'YXZ');

  private onModeChange: ((mode: MouseMode) => void) | null = null;
  constructor(camera: THREE.PerspectiveCamera, domElement: HTMLElement) {
    this.camera = camera;
    this.camera.position.y = EYE_HEIGHT;

    this.pointerLock = new PointerLockControls(camera, domElement);

    document.addEventListener('keydown', (e) => {
      if (document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement) return;
      switch (e.code) {
        case 'KeyW': case 'ArrowUp': this.moveForward = true; break;
        case 'KeyS': case 'ArrowDown': this.moveBackward = true; break;
        case 'KeyA': case 'ArrowLeft': this.moveLeft = true; break;
        case 'KeyD': case 'ArrowRight': this.moveRight = true; break;
        case 'Tab':
          e.preventDefault();
          this.toggleMode();
          break;
      }
    });
    document.addEventListener('keyup', (e) => {
      switch (e.code) {
        case 'KeyW': case 'ArrowUp': this.moveForward = false; break;
        case 'KeyS': case 'ArrowDown': this.moveBackward = false; break;
        case 'KeyA': case 'ArrowLeft': this.moveLeft = false; break;
        case 'KeyD': case 'ArrowRight': this.moveRight = false; break;
      }
    });

    // Free-cursor mouse look (click + drag)
    domElement.addEventListener('mousedown', (e) => {
      if (this.mouseMode === 'free' && e.button === 0) {
        this.isDragging = true;
      }
    });
    document.addEventListener('mouseup', () => {
      this.isDragging = false;
    });
    document.addEventListener('mousemove', (e) => {
      if (this.mouseMode === 'free' && this.isDragging) {
        this.euler.setFromQuaternion(this.camera.quaternion);
        this.euler.y -= e.movementX * MOUSE_SENSITIVITY;
        this.euler.x -= e.movementY * MOUSE_SENSITIVITY;
        this.euler.x = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, this.euler.x));
        this.camera.quaternion.setFromEuler(this.euler);
      }
    });

    this.pointerLock.addEventListener('unlock', () => {
      if (this.mouseMode === 'locked') {
        this.mouseMode = 'free';
        this.onModeChange?.('free');
      }
    });

    // Browser blocks rapid re-lock (e.g. shortly after Escape) — recover from that.
    document.addEventListener('pointerlockerror', () => {
      if (this.mouseMode === 'locked') {
        this.mouseMode = 'free';
        this.onModeChange?.('free');
      }
    });
  }

  setModeChangeHandler(handler: (mode: MouseMode) => void) {
    this.onModeChange = handler;
  }

  get mode(): MouseMode {
    return this.mouseMode;
  }

  toggleMode() {
    if (this.mouseMode === 'free') {
      this.mouseMode = 'locked';
      this.pointerLock.lock();
    } else {
      this.mouseMode = 'free';
      this.pointerLock.unlock();
    }
    this.onModeChange?.(this.mouseMode);
  }

  enterFPS() {
    if (this.mouseMode === 'locked') return;
    this.mouseMode = 'locked';
    this.pointerLock.lock();
    this.onModeChange?.(this.mouseMode);
  }

  exitFPS() {
    if (this.mouseMode === 'free') return;
    this.mouseMode = 'free';
    this.pointerLock.unlock();
    this.onModeChange?.(this.mouseMode);
  }

  setRooms(rooms: Room[]) {
    this.rooms = rooms;
  }

  getCurrentRoom(x: number, z: number): Room | null {
    for (let i = 0; i < this.rooms.length; i++) {
      if (pointInPolygon(x, z, this.rooms[i].polygon)) {
        return this.rooms[i];
      }
    }
    return null;
  }

  teleportTo(x: number, z: number) {
    this.camera.position.set(x, EYE_HEIGHT, z);
  }

  update() {
    const time = performance.now();
    const delta = Math.min((time - this.prevTime) / 1000, 0.1);
    this.prevTime = time;

    this.velocity.x -= this.velocity.x * 10.0 * delta;
    this.velocity.z -= this.velocity.z * 10.0 * delta;

    this.direction.z = Number(this.moveForward) - Number(this.moveBackward);
    this.direction.x = Number(this.moveRight) - Number(this.moveLeft);
    this.direction.normalize();

    if (this.moveForward || this.moveBackward) {
      this.velocity.z -= this.direction.z * MOVE_SPEED * 20.0 * delta;
    }
    if (this.moveLeft || this.moveRight) {
      this.velocity.x -= this.direction.x * MOVE_SPEED * 20.0 * delta;
    }

    if (this.mouseMode === 'locked') {
      this.pointerLock.moveRight(-this.velocity.x * delta);
      this.pointerLock.moveForward(-this.velocity.z * delta);
    } else {
      const forward = new THREE.Vector3();
      this.camera.getWorldDirection(forward);
      forward.y = 0;
      forward.normalize();

      const right = new THREE.Vector3();
      right.crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();

      this.camera.position.addScaledVector(forward, -this.velocity.z * delta);
      this.camera.position.addScaledVector(right, -this.velocity.x * delta);
    }

    // No collision — free movement
    this.camera.position.y = EYE_HEIGHT;
  }
}
