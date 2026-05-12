import * as THREE from 'three';
import { Muxer, ArrayBufferTarget } from 'mp4-muxer';

// ── Types ──

interface Keyframe {
  time: number;
  position: [number, number, number];
  quaternion: [number, number, number, number];
}

type PassName = 'rgb' | 'albedo' | 'depth' | 'normal' | 'metallic' | 'roughness';

const PASS_NAMES: PassName[] = ['rgb', 'albedo', 'depth', 'normal', 'metallic', 'roughness'];
const OUTPUT_WIDTH = 1280;
const OUTPUT_HEIGHT = 720;
const OUTPUT_FPS = 30;
const KEYFRAME_INTERVAL_MS = 50;
const BITRATE = 8_000_000;

// ── Recorder ──

export class GBufferRecorder {
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private renderer: THREE.WebGLRenderer;

  private recording = false;
  private keyframes: Keyframe[] = [];
  private startTime = 0;

  // UI
  private indicator!: HTMLElement;
  private menuOverlay!: HTMLElement;
  private progressOverlay!: HTMLElement;
  private progressBar!: HTMLElement;
  private progressText!: HTMLElement;

  constructor(
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    renderer: THREE.WebGLRenderer,
  ) {
    this.scene = scene;
    this.camera = camera;
    this.renderer = renderer;
    this.buildUI();
  }

  get isRecording() { return this.recording; }

  // ── Public API ──

  toggle() {
    if (this.recording) this.stopRecording();
    else this.startRecording();
  }

  /** Call every frame from the animation loop */
  captureFrame() {
    if (!this.recording) return;
    const elapsed = (performance.now() - this.startTime) / 1000;
    if (this.keyframes.length > 0) {
      const last = this.keyframes[this.keyframes.length - 1].time;
      if ((elapsed - last) * 1000 < KEYFRAME_INTERVAL_MS) return;
    }
    const p = this.camera.position;
    const q = this.camera.quaternion;
    this.keyframes.push({
      time: elapsed,
      position: [p.x, p.y, p.z],
      quaternion: [q.x, q.y, q.z, q.w],
    });
  }

  // ── Recording ──

  private startRecording() {
    this.keyframes = [];
    this.startTime = performance.now();
    this.recording = true;
    this.indicator.style.display = 'block';
  }

  private stopRecording() {
    this.recording = false;
    this.indicator.style.display = 'none';
    if (this.keyframes.length < 2) { this.keyframes = []; return; }

    const dur = this.keyframes[this.keyframes.length - 1].time;
    const frames = Math.ceil(dur * OUTPUT_FPS);
    const info = this.menuOverlay.querySelector('#gbuf-info')!;
    info.textContent =
      `${this.keyframes.length} keyframes · ${dur.toFixed(1)}s → ` +
      `${frames} frames @ ${OUTPUT_FPS}fps (${OUTPUT_WIDTH}×${OUTPUT_HEIGHT})`;
    this.menuOverlay.style.display = 'flex';
  }

  // ── Interpolation ──

  private interpolate(t: number) {
    const kf = this.keyframes;
    if (t <= kf[0].time) {
      return { position: new THREE.Vector3(...kf[0].position), quaternion: new THREE.Quaternion(...kf[0].quaternion) };
    }
    const last = kf[kf.length - 1];
    if (t >= last.time) {
      return { position: new THREE.Vector3(...last.position), quaternion: new THREE.Quaternion(...last.quaternion) };
    }
    let lo = 0, hi = kf.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (kf[mid].time <= t) lo = mid; else hi = mid;
    }
    const a = kf[lo], b = kf[hi];
    const alpha = (t - a.time) / (b.time - a.time);
    return {
      position: new THREE.Vector3(...a.position).lerp(new THREE.Vector3(...b.position), alpha),
      quaternion: new THREE.Quaternion(...a.quaternion).slerp(new THREE.Quaternion(...b.quaternion), alpha),
    };
  }

  // ── Generation ──

  private async generate() {
    this.menuOverlay.style.display = 'none';
    this.progressOverlay.style.display = 'flex';

    const duration = this.keyframes[this.keyframes.length - 1].time;
    const totalFrames = Math.ceil(duration * OUTPUT_FPS);
    const totalWork = totalFrames * PASS_NAMES.length;
    let workDone = 0;

    // Save state
    const savedPos = this.camera.position.clone();
    const savedQuat = this.camera.quaternion.clone();
    const savedAspect = this.camera.aspect;
    const savedToneMapping = this.renderer.toneMapping;
    const savedExposure = this.renderer.toneMappingExposure;
    const savedBg = this.scene.background;
    const savedEnv = this.scene.environment;
    const savedSize = this.renderer.getSize(new THREE.Vector2());
    const savedPR = this.renderer.getPixelRatio();

    this.camera.aspect = OUTPUT_WIDTH / OUTPUT_HEIGHT;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(1);

    const rt = new THREE.WebGLRenderTarget(OUTPUT_WIDTH, OUTPUT_HEIGHT, {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
    });

    // Temp canvas for pixel transfer → VideoFrame
    const tmpCanvas = document.createElement('canvas');
    tmpCanvas.width = OUTPUT_WIDTH;
    tmpCanvas.height = OUTPUT_HEIGHT;
    const tmpCtx = tmpCanvas.getContext('2d')!;

    const pixelBuf = new Uint8Array(OUTPUT_WIDTH * OUTPUT_HEIGHT * 4);

    // Collect mesh→material map for swapping
    const meshMats = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
    this.scene.traverse((obj) => {
      if ((obj as THREE.Mesh).isMesh) meshMats.set(obj as THREE.Mesh, (obj as THREE.Mesh).material);
    });

    // Prepare reusable override materials
    const normalMat = new THREE.MeshNormalMaterial({ side: THREE.DoubleSide });
    const depthMat = new THREE.ShaderMaterial({
      vertexShader: `
        varying float vDepth;
        void main() {
          vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
          vDepth = -mvPos.z;
          gl_Position = projectionMatrix * mvPos;
        }`,
      fragmentShader: `
        varying float vDepth;
        void main() {
          float d = clamp(vDepth / 20.0, 0.0, 1.0);
          gl_FragColor = vec4(vec3(d), 1.0);
        }`,
      side: THREE.DoubleSide,
    });

    // Build per-mesh swap materials once (albedo, metallic, roughness)
    const albedoMats = new Map<THREE.Mesh, THREE.MeshBasicMaterial>();
    const metallicMats = new Map<THREE.Mesh, THREE.MeshBasicMaterial>();
    const roughnessMats = new Map<THREE.Mesh, THREE.MeshBasicMaterial>();

    for (const [mesh, origMat] of meshMats) {
      const orig = (Array.isArray(origMat) ? origMat[0] : origMat) as THREE.MeshStandardMaterial;
      albedoMats.set(mesh, new THREE.MeshBasicMaterial({
        map: orig.map ?? null,
        color: orig.color?.clone() ?? new THREE.Color(0xffffff),
        transparent: orig.transparent,
        opacity: orig.opacity,
        side: orig.side ?? THREE.FrontSide,
      }));
      const m = orig.metalness ?? 0;
      metallicMats.set(mesh, new THREE.MeshBasicMaterial({
        map: orig.metalnessMap ?? null,
        color: new THREE.Color(m, m, m),
        side: orig.side ?? THREE.FrontSide,
      }));
      const r = orig.roughness ?? 0.5;
      roughnessMats.set(mesh, new THREE.MeshBasicMaterial({
        map: orig.roughnessMap ?? null,
        color: new THREE.Color(r, r, r),
        side: orig.side ?? THREE.FrontSide,
      }));
    }

    const blobs: Record<string, Blob> = {};

    for (const passName of PASS_NAMES) {
      // Setup pass
      const isLit = passName === 'rgb';
      if (!isLit) {
        this.renderer.toneMapping = THREE.NoToneMapping;
        this.renderer.toneMappingExposure = 1;
        this.scene.background = new THREE.Color(0x000000);
        this.scene.environment = null;
      } else {
        this.renderer.toneMapping = savedToneMapping;
        this.renderer.toneMappingExposure = savedExposure;
        this.scene.background = savedBg;
        this.scene.environment = savedEnv;
      }

      // Swap materials for the whole pass
      if (passName === 'albedo') {
        for (const [mesh, mat] of albedoMats) mesh.material = mat;
      } else if (passName === 'metallic') {
        for (const [mesh, mat] of metallicMats) mesh.material = mat;
      } else if (passName === 'roughness') {
        for (const [mesh, mat] of roughnessMats) mesh.material = mat;
      } else if (passName === 'depth') {
        this.scene.overrideMaterial = depthMat;
      } else if (passName === 'normal') {
        this.scene.overrideMaterial = normalMat;
      }

      // Encode pass
      const { encoder, muxer, target } = this.createEncoder();

      for (let f = 0; f < totalFrames; f++) {
        const t = f / OUTPUT_FPS;
        const { position, quaternion } = this.interpolate(t);
        this.camera.position.copy(position);
        this.camera.quaternion.copy(quaternion);

        this.renderer.setRenderTarget(rt);
        this.renderer.render(this.scene, this.camera);
        this.renderer.readRenderTargetPixels(rt, 0, 0, OUTPUT_WIDTH, OUTPUT_HEIGHT, pixelBuf);

        this.flipY(pixelBuf, OUTPUT_WIDTH, OUTPUT_HEIGHT);
        const imageData = new ImageData(new Uint8ClampedArray(pixelBuf.buffer.slice(0)), OUTPUT_WIDTH, OUTPUT_HEIGHT);
        tmpCtx.putImageData(imageData, 0, 0);

        const vf = new VideoFrame(tmpCanvas, {
          timestamp: f * (1_000_000 / OUTPUT_FPS),
          duration: 1_000_000 / OUTPUT_FPS,
        });
        encoder.encode(vf, { keyFrame: f % 30 === 0 });
        vf.close();

        workDone++;
        if (f % 5 === 0) {
          const pct = Math.round((workDone / totalWork) * 100);
          this.progressBar.style.width = `${pct}%`;
          this.progressText.textContent = `${passName} — ${pct}%`;
          await new Promise(r => setTimeout(r, 0));
        }
      }

      await encoder.flush();
      encoder.close();
      muxer.finalize();
      blobs[passName] = new Blob([target.buffer!], { type: 'video/mp4' });

      // Restore materials after this pass
      if (passName === 'albedo' || passName === 'metallic' || passName === 'roughness') {
        for (const [mesh, origMat] of meshMats) mesh.material = origMat;
      }
      this.scene.overrideMaterial = null;
    }

    // Cleanup
    rt.dispose();
    normalMat.dispose();
    depthMat.dispose();
    for (const m of albedoMats.values()) m.dispose();
    for (const m of metallicMats.values()) m.dispose();
    for (const m of roughnessMats.values()) m.dispose();

    // Restore renderer state
    this.camera.position.copy(savedPos);
    this.camera.quaternion.copy(savedQuat);
    this.camera.aspect = savedAspect;
    this.camera.updateProjectionMatrix();
    this.renderer.toneMapping = savedToneMapping;
    this.renderer.toneMappingExposure = savedExposure;
    this.renderer.setPixelRatio(savedPR);
    this.renderer.setSize(savedSize.x, savedSize.y);
    this.renderer.setRenderTarget(null);
    this.scene.background = savedBg;
    this.scene.environment = savedEnv;

    // Download each MP4
    this.progressText.textContent = 'Downloading...';
    for (const [name, blob] of Object.entries(blobs)) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${name}.mp4`;
      a.click();
      URL.revokeObjectURL(url);
      // Small delay between downloads so browser doesn't block them
      await new Promise(r => setTimeout(r, 300));
    }

    this.progressOverlay.style.display = 'none';
    this.keyframes = [];
  }

  // ── Encoder setup ──

  private createEncoder() {
    const target = new ArrayBufferTarget();
    const muxer = new Muxer({
      target,
      video: {
        codec: 'avc',
        width: OUTPUT_WIDTH,
        height: OUTPUT_HEIGHT,
      },
      fastStart: 'in-memory',
    });

    const encoder = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: (e) => console.error('VideoEncoder error:', e),
    });
    encoder.configure({
      codec: 'avc1.640028',
      width: OUTPUT_WIDTH,
      height: OUTPUT_HEIGHT,
      bitrate: BITRATE,
      framerate: OUTPUT_FPS,
    });

    return { encoder, muxer, target };
  }

  // ── Pixel helpers ──

  private flipY(buf: Uint8Array, w: number, h: number) {
    const rowSize = w * 4;
    const tmp = new Uint8Array(rowSize);
    for (let y = 0; y < h / 2; y++) {
      const topOff = y * rowSize;
      const botOff = (h - 1 - y) * rowSize;
      tmp.set(buf.subarray(topOff, topOff + rowSize));
      buf.copyWithin(topOff, botOff, botOff + rowSize);
      buf.set(tmp, botOff);
    }
  }

  // ── UI ──

  private buildUI() {
    // Recording indicator
    const style = document.createElement('style');
    style.textContent = `
      @keyframes gbuf-blink { 50% { opacity: 0.4; } }
      #gbuf-indicator {
        position: fixed; top: 20px; left: 50%; transform: translateX(-50%);
        color: #ff3333; font-family: monospace; font-size: 18px; font-weight: bold;
        background: rgba(0,0,0,0.75); padding: 8px 18px; border-radius: 6px;
        display: none; z-index: 1000; animation: gbuf-blink 1s infinite;
      }
      #gbuf-menu-overlay, #gbuf-progress-overlay {
        position: fixed; inset: 0;
        display: none; z-index: 2000;
        justify-content: center; align-items: center;
        font-family: system-ui, sans-serif; color: #ddd;
      }
      #gbuf-menu-overlay { background: rgba(0,0,0,0.55); }
      #gbuf-progress-overlay { background: rgba(0,0,0,0.8); }
      .gbuf-panel {
        background: #1a1a2e; padding: 28px 36px; border-radius: 12px;
        text-align: center; min-width: 320px;
        border: 1px solid rgba(255,255,255,0.1);
      }
      .gbuf-panel h3 { margin: 0 0 6px; font-size: 16px; }
      .gbuf-panel p  { margin: 0 0 20px; color: #888; font-size: 13px; }
      .gbuf-btn {
        border: none; padding: 10px 22px; border-radius: 6px;
        font-size: 14px; cursor: pointer; margin: 0 6px;
      }
      .gbuf-btn.primary { background: #4a9eff; color: #fff; }
      .gbuf-btn.primary:hover { background: #3b8de6; }
      .gbuf-btn.secondary { background: #444; color: #ccc; }
      .gbuf-btn.secondary:hover { background: #555; }
      .gbuf-bar-track {
        background: #333; border-radius: 4px; height: 8px;
        margin-bottom: 10px; overflow: hidden;
      }
      .gbuf-bar-fill {
        background: #4a9eff; height: 100%; width: 0%;
        transition: width 0.15s;
      }
    `;
    document.head.appendChild(style);

    this.indicator = document.createElement('div');
    this.indicator.id = 'gbuf-indicator';
    this.indicator.textContent = '● REC';
    document.body.appendChild(this.indicator);

    // Post-recording menu
    this.menuOverlay = document.createElement('div');
    this.menuOverlay.id = 'gbuf-menu-overlay';
    this.menuOverlay.innerHTML = `
      <div class="gbuf-panel">
        <h3>Path Recorded</h3>
        <p id="gbuf-info"></p>
        <button class="gbuf-btn primary" id="gbuf-go">Generate G-buffer</button>
        <button class="gbuf-btn secondary" id="gbuf-cancel">Cancel</button>
      </div>`;
    document.body.appendChild(this.menuOverlay);

    this.menuOverlay.querySelector('#gbuf-go')!.addEventListener('click', () => this.generate());
    this.menuOverlay.querySelector('#gbuf-cancel')!.addEventListener('click', () => {
      this.menuOverlay.style.display = 'none';
      this.keyframes = [];
    });

    // Progress
    this.progressOverlay = document.createElement('div');
    this.progressOverlay.id = 'gbuf-progress-overlay';
    this.progressOverlay.innerHTML = `
      <div class="gbuf-panel">
        <h3>Generating G-buffers</h3>
        <div class="gbuf-bar-track"><div class="gbuf-bar-fill" id="gbuf-bar"></div></div>
        <p id="gbuf-ptext">0%</p>
      </div>`;
    document.body.appendChild(this.progressOverlay);

    this.progressBar = this.progressOverlay.querySelector('#gbuf-bar')!;
    this.progressText = this.progressOverlay.querySelector('#gbuf-ptext')!;
  }
}
