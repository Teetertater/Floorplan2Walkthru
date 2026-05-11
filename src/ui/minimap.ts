import * as THREE from 'three';
import { Plan } from '../cubicasa/types';

const PADDING = 8;
const PLAYER_SIZE = 6;
const VIEW_CONE_LENGTH = 20;
const VIEW_CONE_ANGLE = Math.PI / 6;

export class Minimap {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private plan: Plan | null = null;

  // SVG rendered as an image
  private svgImage: HTMLImageElement | null = null;

  // SVG viewBox (pixels)
  private svgMinX = 0;
  private svgMinY = 0;
  private svgW = 1;
  private svgH = 1;

  // Plan scale (meters per SVG pixel)
  private metersPerPx = 0.01;

  // Transform: plan meters → canvas pixels
  private scaleX = 1;
  private scaleY = 1;
  private offsetX = 0;
  private offsetY = 0;

  private onTeleport: ((x: number, z: number) => void) | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;

    canvas.addEventListener('click', (e) => {
      if (!this.plan || !this.onTeleport) return;
      const rect = canvas.getBoundingClientRect();
      const cx = (e.clientX - rect.left) * (canvas.width / rect.width);
      const cy = (e.clientY - rect.top) * (canvas.height / rect.height);
      const planX = (cx - this.offsetX) / this.scaleX;
      const planZ = (cy - this.offsetY) / this.scaleY;
      this.onTeleport(planX, planZ);
    });
  }

  setTeleportHandler(handler: (x: number, z: number) => void) {
    this.onTeleport = handler;
  }

  setPlan(plan: Plan, svgText?: string) {
    this.plan = plan;
    this.metersPerPx = plan.scaleMetersPerUnit;

    if (svgText) {
      this.loadSvgImage(svgText);
    }

    this.computeTransform();
  }

  private loadSvgImage(svgText: string) {
    // Parse SVG viewBox to get coordinate bounds
    const match = svgText.match(/viewBox="([^"]+)"/);
    if (match) {
      const parts = match[1].split(/\s+/).map(Number);
      this.svgMinX = parts[0];
      this.svgMinY = parts[1];
      this.svgW = parts[2];
      this.svgH = parts[3];
    } else {
      // Fallback: parse width/height attributes
      const wMatch = svgText.match(/width="([^"]+)"/);
      const hMatch = svgText.match(/height="([^"]+)"/);
      this.svgMinX = 0;
      this.svgMinY = 0;
      this.svgW = wMatch ? parseFloat(wMatch[1]) : 800;
      this.svgH = hMatch ? parseFloat(hMatch[1]) : 800;
    }

    // Render SVG to an Image
    const blob = new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      this.svgImage = img;
      URL.revokeObjectURL(url);
    };
    img.src = url;
  }

  private computeTransform() {
    // Map: SVG pixels → plan meters → canvas pixels
    // SVG point (sx, sy) → meters: (sx * metersPerPx, sy * metersPerPx)
    // We need to fit the SVG into the canvas with padding.

    const w = this.canvas.width;
    const h = this.canvas.height;
    const s = this.metersPerPx;

    // Plan bounds in meters (from SVG viewBox)
    const planMinX = this.svgMinX * s;
    const planMinZ = this.svgMinY * s;
    const planW = this.svgW * s;
    const planH = this.svgH * s;

    const fitW = w - PADDING * 2;
    const fitH = h - PADDING * 2;
    const scale = Math.min(fitW / planW, fitH / planH);

    this.scaleX = scale;
    this.scaleY = scale;
    this.offsetX = PADDING + (fitW - planW * scale) / 2 - planMinX * scale;
    this.offsetY = PADDING + (fitH - planH * scale) / 2 - planMinZ * scale;
  }

  private toCanvas(x: number, z: number): [number, number] {
    return [
      x * this.scaleX + this.offsetX,
      z * this.scaleY + this.offsetY,
    ];
  }

  render(camera: THREE.Camera) {
    if (!this.plan) return;
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;

    ctx.clearRect(0, 0, w, h);

    // Draw SVG as background
    if (this.svgImage) {
      const s = this.metersPerPx;
      const [dx, dy] = this.toCanvas(this.svgMinX * s, this.svgMinY * s);
      const dw = this.svgW * s * this.scaleX;
      const dh = this.svgH * s * this.scaleY;
      ctx.drawImage(this.svgImage, dx, dy, dw, dh);
    }

    // Draw player position and view cone
    const pos = camera.position;
    const [px, py] = this.toCanvas(pos.x, pos.z);

    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    const viewAngle = Math.atan2(dir.z, dir.x);

    // View cone
    ctx.fillStyle = 'rgba(0, 200, 255, 0.2)';
    ctx.beginPath();
    ctx.moveTo(px, py);
    const coneAngle1 = viewAngle + VIEW_CONE_ANGLE;
    const coneAngle2 = viewAngle - VIEW_CONE_ANGLE;
    ctx.lineTo(
      px + Math.cos(coneAngle1) * VIEW_CONE_LENGTH,
      py + Math.sin(coneAngle1) * VIEW_CONE_LENGTH,
    );
    ctx.arc(px, py, VIEW_CONE_LENGTH, coneAngle1, coneAngle2, true);
    ctx.closePath();
    ctx.fill();

    // Player triangle
    ctx.fillStyle = '#00ccff';
    ctx.beginPath();
    const tipX = px + Math.cos(viewAngle) * PLAYER_SIZE;
    const tipY = py + Math.sin(viewAngle) * PLAYER_SIZE;
    const leftAngle = viewAngle + Math.PI * 0.75;
    const rightAngle = viewAngle - Math.PI * 0.75;
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(px + Math.cos(leftAngle) * PLAYER_SIZE * 0.6, py + Math.sin(leftAngle) * PLAYER_SIZE * 0.6);
    ctx.lineTo(px + Math.cos(rightAngle) * PLAYER_SIZE * 0.6, py + Math.sin(rightAngle) * PLAYER_SIZE * 0.6);
    ctx.closePath();
    ctx.fill();
  }
}
