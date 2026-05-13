/**
 * Equirectangular panorama renderer.
 *
 * Renders a full 360x180 equirectangular panorama from a given position.
 * Uses CubeCamera internally, then projects to equirectangular via a
 * fullscreen shader pass. Output is an 8-bit sRGB PNG blob at 8192x4096.
 *
 * Requirements from the downstream pipeline (SPAG-4D):
 *  - Exactly 2:1 aspect ratio, equirectangular projection
 *  - 8-bit sRGB, LDR (tone-mapped), PNG or high-quality JPEG
 *  - No postprocessing (no DOF, vignette, chromatic aberration, noise)
 *  - Clean pinhole render, no lens distortion
 *  - Camera at eye level (~1.5m)
 */

import * as THREE from 'three';

const PANO_WIDTH = 8192;
const PANO_HEIGHT = 4096;
const CUBE_FACE_SIZE = 4096; // per-face resolution for the cubemap

// Fullscreen quad shader: cubemap → equirectangular
const EQUIRECT_VERT = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position, 1.0);
  }
`;

const EQUIRECT_FRAG = `
  uniform samplerCube tCube;
  varying vec2 vUv;

  void main() {
    // UV (0,0) = bottom-left, (1,1) = top-right
    float lon = vUv.x * 6.28318530718;         // 0 → 2PI

    // Clamp latitude slightly away from poles to avoid the cubemap
    // edge singularity where all 4 side faces meet the top/bottom face.
    // At exactly +/-PI/2, cos(lat)=0 and the direction degenerates —
    // the texture sampler hits the corner seam and blends with adjacent
    // faces (or background), producing white/blurred artifacts.
    float lat = clamp(
      (vUv.y - 0.5) * 3.14159265359,
      -1.5707788,  // -PI/2 + small epsilon (~0.001 deg)
       1.5707788
    );

    // Spherical -> cartesian (Three.js convention: Y-up, right-handed)
    vec3 dir = vec3(
      -sin(lon) * cos(lat),
       sin(lat),
      -cos(lon) * cos(lat)
    );

    gl_FragColor = textureCube(tCube, dir);
  }
`;

export class PanoramaRenderer {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;

  // Progress UI
  private overlay!: HTMLElement;
  private progressText!: HTMLElement;

  constructor(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
  ) {
    this.renderer = renderer;
    this.scene = scene;
    this.buildUI();
  }

  /**
   * Render two equirectangular panoramas from the given position:
   *  - "bare": plain matte surfaces, no textures, no furniture
   *  - "furnished": full textures + furniture, but white matte floor
   *
   * Returns { bare: Blob, furnished: Blob }.
   */
  async capture(position: THREE.Vector3): Promise<{ bare: Blob; furnished: Blob }> {
    this.overlay.style.display = 'flex';

    // Save renderer state
    const savedToneMapping = this.renderer.toneMapping;
    const savedExposure = this.renderer.toneMappingExposure;
    const savedOutputCS = this.renderer.outputColorSpace;
    const savedBg = this.scene.background;
    const savedSize = this.renderer.getSize(new THREE.Vector2());
    const savedPR = this.renderer.getPixelRatio();

    this.renderer.setPixelRatio(1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    // Shared equirect conversion resources
    const equirectRT = new THREE.WebGLRenderTarget(PANO_WIDTH, PANO_HEIGHT, {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
    });
    const equirectMat = new THREE.ShaderMaterial({
      vertexShader: EQUIRECT_VERT,
      fragmentShader: EQUIRECT_FRAG,
      uniforms: { tCube: { value: null } },
      depthTest: false,
      depthWrite: false,
    });
    const fullscreenQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), equirectMat);
    const orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const quadScene = new THREE.Scene();
    quadScene.add(fullscreenQuad);
    const pixelBuf = new Uint8Array(PANO_WIDTH * PANO_HEIGHT * 4);
    const tmpCanvas = document.createElement('canvas');
    tmpCanvas.width = PANO_WIDTH;
    tmpCanvas.height = PANO_HEIGHT;
    const tmpCtx = tmpCanvas.getContext('2d')!;

    // ── Pass 1: Bare (plain matte, no furniture) ──
    this.progressText.textContent = 'Rendering bare panorama...';
    await this.yieldFrame();

    const bareBlob = await this.renderPass(position, () => {
      const hidden: THREE.Object3D[] = [];
      const swapped: { mesh: THREE.Mesh; orig: THREE.Material | THREE.Material[] }[] = [];

      const matteWall = new THREE.MeshStandardMaterial({ color: 0xe8e4de, roughness: 0.95, metalness: 0 });
      const matteFloor = new THREE.MeshStandardMaterial({ color: 0xc8b8a0, roughness: 0.95, metalness: 0 });
      const matteCeiling = new THREE.MeshStandardMaterial({ color: 0xf0ece6, roughness: 0.95, metalness: 0 });
      const matteDoor = new THREE.MeshStandardMaterial({ color: 0x8b7355, roughness: 0.7, metalness: 0 });
      const matteDefault = new THREE.MeshStandardMaterial({ color: 0xd0d0d0, roughness: 0.9, metalness: 0 });

      this.scene.traverse((obj) => {
        const ud = obj.userData;
        if ((ud?.type === 'ground' || ud?.type === 'furniture') && obj.visible) {
          obj.visible = false;
          hidden.push(obj);
          return;
        }
        if ((obj as THREE.Mesh).isMesh) {
          const mesh = obj as THREE.Mesh;
          swapped.push({ mesh, orig: mesh.material });
          if (ud?.type === 'wall' || ud?.type === 'lintel') mesh.material = matteWall;
          else if (ud?.type === 'floor') mesh.material = matteFloor;
          else if (ud?.type === 'ceiling') mesh.material = matteCeiling;
          else if (ud?.type === 'door_frame' || ud?.type === 'door_panel') mesh.material = matteDoor;
          else if (ud?.type === 'window_pane') { /* keep for HDRI */ }
          else mesh.material = matteDefault;
        }
      });

      return () => {
        for (const obj of hidden) obj.visible = true;
        for (const { mesh, orig } of swapped) mesh.material = orig;
        matteWall.dispose(); matteFloor.dispose(); matteCeiling.dispose();
        matteDoor.dispose(); matteDefault.dispose();
      };
    }, equirectRT, equirectMat, quadScene, orthoCamera, pixelBuf, tmpCanvas, tmpCtx);

    // ── Pass 2: Furnished (full textures + furniture, white matte floor) ──
    this.progressText.textContent = 'Rendering furnished panorama...';
    await this.yieldFrame();

    const furnishedBlob = await this.renderPass(position, () => {
      const hidden: THREE.Object3D[] = [];
      const swapped: { mesh: THREE.Mesh; orig: THREE.Material | THREE.Material[] }[] = [];

      const whiteFloor = new THREE.MeshStandardMaterial({ color: 0xf5f5f0, roughness: 0.95, metalness: 0 });

      this.scene.traverse((obj) => {
        const ud = obj.userData;
        if (ud?.type === 'ground' && obj.visible) {
          obj.visible = false;
          hidden.push(obj);
          return;
        }
        if (ud?.type === 'floor' && (obj as THREE.Mesh).isMesh) {
          const mesh = obj as THREE.Mesh;
          swapped.push({ mesh, orig: mesh.material });
          mesh.material = whiteFloor;
        }
      });

      return () => {
        for (const obj of hidden) obj.visible = true;
        for (const { mesh, orig } of swapped) mesh.material = orig;
        whiteFloor.dispose();
      };
    }, equirectRT, equirectMat, quadScene, orthoCamera, pixelBuf, tmpCanvas, tmpCtx);

    // Cleanup shared resources
    equirectRT.dispose();
    equirectMat.dispose();
    fullscreenQuad.geometry.dispose();

    // Restore renderer state
    this.renderer.toneMapping = savedToneMapping;
    this.renderer.toneMappingExposure = savedExposure;
    this.renderer.outputColorSpace = savedOutputCS;
    this.renderer.setPixelRatio(savedPR);
    this.renderer.setSize(savedSize.x, savedSize.y);
    this.renderer.setRenderTarget(null);
    this.scene.background = savedBg;

    this.overlay.style.display = 'none';
    return { bare: bareBlob, furnished: furnishedBlob };
  }

  /**
   * Render a single cubemap → equirectangular pass.
   * `setupScene` prepares the scene and returns a teardown function.
   */
  private async renderPass(
    position: THREE.Vector3,
    setupScene: () => () => void,
    equirectRT: THREE.WebGLRenderTarget,
    equirectMat: THREE.ShaderMaterial,
    quadScene: THREE.Scene,
    orthoCamera: THREE.OrthographicCamera,
    pixelBuf: Uint8Array,
    tmpCanvas: HTMLCanvasElement,
    tmpCtx: CanvasRenderingContext2D,
  ): Promise<Blob> {
    const teardown = setupScene();

    // Render cubemap
    const cubeRT = new THREE.WebGLCubeRenderTarget(CUBE_FACE_SIZE, {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      generateMipmaps: false,
      minFilter: THREE.LinearFilter,
    });
    const cubeCamera = new THREE.CubeCamera(0.05, 200, cubeRT);
    cubeCamera.position.copy(position);
    cubeCamera.update(this.renderer, this.scene);

    // Restore scene immediately after cubemap capture
    teardown();

    // Convert cubemap → equirectangular
    equirectMat.uniforms.tCube.value = cubeRT.texture;
    equirectMat.needsUpdate = true;

    const savedTM = this.renderer.toneMapping;
    const savedExp = this.renderer.toneMappingExposure;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.toneMappingExposure = 1;
    this.renderer.setRenderTarget(equirectRT);
    this.renderer.render(quadScene, orthoCamera);
    this.renderer.toneMapping = savedTM;
    this.renderer.toneMappingExposure = savedExp;

    // Read pixels
    this.renderer.readRenderTargetPixels(equirectRT, 0, 0, PANO_WIDTH, PANO_HEIGHT, pixelBuf);
    this.flipY(pixelBuf, PANO_WIDTH, PANO_HEIGHT);
    cubeRT.dispose();

    // Encode PNG
    const imageData = new ImageData(
      new Uint8ClampedArray(pixelBuf.slice(0).buffer),
      PANO_WIDTH, PANO_HEIGHT,
    );
    tmpCtx.putImageData(imageData, 0, 0);

    return new Promise<Blob>((resolve, reject) => {
      tmpCanvas.toBlob(
        (b) => b ? resolve(b) : reject(new Error('PNG encoding failed')),
        'image/png',
      );
    });
  }

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

  private yieldFrame(): Promise<void> {
    return new Promise(r => setTimeout(r, 0));
  }

  private buildUI() {
    this.overlay = document.createElement('div');
    this.overlay.style.cssText = `
      position: fixed; inset: 0;
      display: none; z-index: 2000;
      justify-content: center; align-items: center;
      background: rgba(0,0,0,0.8);
      font-family: system-ui, sans-serif; color: #ddd;
    `;
    this.overlay.innerHTML = `
      <div style="background:#1a1a2e; padding:28px 36px; border-radius:12px;
                  text-align:center; border:1px solid rgba(255,255,255,0.1);">
        <h3 style="margin:0 0 12px; font-size:16px;">Generating Panorama</h3>
        <p id="pano-progress" style="margin:0; color:#888; font-size:13px;">Initializing...</p>
      </div>`;
    document.body.appendChild(this.overlay);
    this.progressText = this.overlay.querySelector('#pano-progress')!;
  }
}
