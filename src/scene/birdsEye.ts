import { Plan } from '../cubicasa/types';
import { getFurnitureById } from '../assets/catalog';
import { FurniturePlacement } from '../state/types';

const RENDER_SIZE = 1024;
const LABEL_FONT = 'bold 13px system-ui, sans-serif';
const FURNITURE_LABEL_FONT = '11px system-ui, sans-serif';

// Room fill colors (pale, by type)
const ROOM_COLORS: Record<string, string> = {
  LivingRoom: 'rgba(180, 210, 240, 0.35)',
  Kitchen: 'rgba(240, 220, 170, 0.35)',
  Bedroom: 'rgba(200, 180, 220, 0.35)',
  Bath: 'rgba(170, 230, 220, 0.35)',
  Entry: 'rgba(220, 220, 200, 0.3)',
  Lobby: 'rgba(220, 220, 200, 0.3)',
  Storage: 'rgba(200, 200, 200, 0.25)',
  DraughtLobby: 'rgba(210, 210, 210, 0.3)',
};

export class BirdsEyeRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;

  // Overlay elements
  private overlay: HTMLDivElement | null = null;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = RENDER_SIZE;
    this.canvas.height = RENDER_SIZE;
    this.ctx = this.canvas.getContext('2d')!;
  }

  capture(plan: Plan, furniture: FurniturePlacement[]): string {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, RENDER_SIZE, RENDER_SIZE);

    // Compute plan bounds
    const allPts: [number, number][] = [];
    for (const room of plan.rooms) allPts.push(...room.polygon);
    for (const wall of plan.walls) allPts.push(wall.start, wall.end, ...wall.polygon);

    if (allPts.length === 0) return '';

    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const [x, z] of allPts) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
    }

    const margin = 0.8;
    minX -= margin; maxX += margin;
    minZ -= margin; maxZ += margin;

    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;
    const spanX = maxX - minX;
    const spanZ = maxZ - minZ;
    const span = Math.max(spanX, spanZ);

    const toPixel = (px: number, pz: number): [number, number] => {
      const nx = (px - cx) / span + 0.5;
      const ny = (pz - cz) / span + 0.5;
      return [nx * RENDER_SIZE, ny * RENDER_SIZE];
    };

    // Background
    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(0, 0, RENDER_SIZE, RENDER_SIZE);

    // Draw room fills
    for (const room of plan.rooms) {
      if (room.polygon.length < 3) continue;
      const color = ROOM_COLORS[room.type] || 'rgba(200, 200, 200, 0.2)';
      ctx.fillStyle = color;
      ctx.beginPath();
      const [sx, sy] = toPixel(room.polygon[0][0], room.polygon[0][1]);
      ctx.moveTo(sx, sy);
      for (let i = 1; i < room.polygon.length; i++) {
        const [px, py] = toPixel(room.polygon[i][0], room.polygon[i][1]);
        ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fill();
    }

    // Draw walls as filled polygons
    ctx.fillStyle = 'rgba(220, 215, 200, 0.9)';
    for (const wall of plan.walls) {
      if (wall.polygon.length < 3) continue;
      ctx.beginPath();
      const [sx, sy] = toPixel(wall.polygon[0][0], wall.polygon[0][1]);
      ctx.moveTo(sx, sy);
      for (let i = 1; i < wall.polygon.length; i++) {
        const [px, py] = toPixel(wall.polygon[i][0], wall.polygon[i][1]);
        ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fill();
    }

    // Draw door gaps (cut out from walls)
    ctx.fillStyle = '#1a1a2e';
    for (const door of plan.doors) {
      const wall = plan.walls.find(w => w.id === door.wallId);
      if (!wall) continue;

      const dx = wall.end[0] - wall.start[0];
      const dz = wall.end[1] - wall.start[1];
      const len = Math.hypot(dx, dz);
      if (len < 0.01) continue;

      const ux = dx / len, uz = dz / len;
      const nx = -uz, nz = ux;
      const halfT = wall.thickness / 2 + 0.02; // slightly wider than wall
      const halfW = door.width / 2;

      const dcx = wall.start[0] + dx * door.position;
      const dcz = wall.start[1] + dz * door.position;

      const corners = [
        [dcx - ux * halfW + nx * halfT, dcz - uz * halfW + nz * halfT],
        [dcx + ux * halfW + nx * halfT, dcz + uz * halfW + nz * halfT],
        [dcx + ux * halfW - nx * halfT, dcz + uz * halfW - nz * halfT],
        [dcx - ux * halfW - nx * halfT, dcz - uz * halfW - nz * halfT],
      ];

      ctx.beginPath();
      const [s0, s1] = toPixel(corners[0][0], corners[0][1]);
      ctx.moveTo(s0, s1);
      for (let i = 1; i < corners.length; i++) {
        const [px, py] = toPixel(corners[i][0], corners[i][1]);
        ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fill();
    }

    // Draw room labels
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const room of plan.rooms) {
      const rcx = room.polygon.reduce((s, p) => s + p[0], 0) / room.polygon.length;
      const rcz = room.polygon.reduce((s, p) => s + p[1], 0) / room.polygon.length;
      const [px, py] = toPixel(rcx, rcz);

      ctx.font = LABEL_FONT;
      ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
      ctx.fillText(room.name, px, py);
    }

    // Draw furniture bounding boxes
    for (const placement of furniture) {
      const meta = getFurnitureById(placement.assetId);
      if (!meta) continue;

      const [fx, , fz] = placement.position;
      const rot = (placement.rotation * Math.PI) / 180;
      const s = placement.scale;
      const hw = (meta.dimensions.w * s) / 2;
      const hd = (meta.dimensions.d * s) / 2;

      const cos = Math.cos(rot);
      const sin = Math.sin(rot);
      const corners: [number, number][] = [
        [fx + (-hw * cos - (-hd) * sin), fz + (-hw * sin + (-hd) * cos)],
        [fx + (hw * cos - (-hd) * sin), fz + (hw * sin + (-hd) * cos)],
        [fx + (hw * cos - hd * sin), fz + (hw * sin + hd * cos)],
        [fx + (-hw * cos - hd * sin), fz + (-hw * sin + hd * cos)],
      ];

      const pixCorners = corners.map(([x, z]) => toPixel(x, z));

      // Filled box
      ctx.fillStyle = 'rgba(0, 200, 255, 0.15)';
      ctx.beginPath();
      ctx.moveTo(pixCorners[0][0], pixCorners[0][1]);
      for (let i = 1; i < pixCorners.length; i++) {
        ctx.lineTo(pixCorners[i][0], pixCorners[i][1]);
      }
      ctx.closePath();
      ctx.fill();

      // Outline
      ctx.strokeStyle = '#00ccff';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // Front edge indicator
      ctx.strokeStyle = '#ff6600';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(pixCorners[0][0], pixCorners[0][1]);
      ctx.lineTo(pixCorners[1][0], pixCorners[1][1]);
      ctx.stroke();

      // Label
      const [lpx, lpy] = toPixel(fx, fz);
      ctx.font = FURNITURE_LABEL_FONT;
      ctx.fillStyle = 'rgba(0, 220, 255, 0.9)';
      ctx.textAlign = 'center';
      ctx.fillText(meta.name, lpx, lpy - 10);
      ctx.fillStyle = 'rgba(0, 200, 255, 0.5)';
      ctx.fillText(placement.instanceId, lpx, lpy + 4);
    }

    // Scale bar
    const scaleBarMeters = 1;
    const scaleBarPx = (scaleBarMeters / span) * RENDER_SIZE;
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = 2;
    const sbx = 20, sby = RENDER_SIZE - 30;
    ctx.beginPath();
    ctx.moveTo(sbx, sby); ctx.lineTo(sbx + scaleBarPx, sby);
    ctx.moveTo(sbx, sby - 5); ctx.lineTo(sbx, sby + 5);
    ctx.moveTo(sbx + scaleBarPx, sby - 5); ctx.lineTo(sbx + scaleBarPx, sby + 5);
    ctx.stroke();
    ctx.font = '12px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.textAlign = 'center';
    ctx.fillText(`${scaleBarMeters}m`, sbx + scaleBarPx / 2, sby - 10);

    return this.canvas.toDataURL('image/png');
  }

  showOverlay(plan: Plan, furniture: FurniturePlacement[]): void {
    this.hideOverlay();
    const dataUrl = this.capture(plan, furniture);
    if (!dataUrl) return;

    const overlay = document.createElement('div');
    overlay.id = 'birds-eye-overlay';
    overlay.style.cssText = `
      position: fixed; inset: 0; z-index: 1000;
      background: rgba(0,0,0,0.8);
      display: flex; justify-content: center; align-items: center;
      cursor: pointer;
    `;

    const img = document.createElement('img');
    img.src = dataUrl;
    img.style.cssText = 'max-width: 90vw; max-height: 90vh; border-radius: 8px;';
    overlay.appendChild(img);

    const hint = document.createElement('div');
    hint.textContent = 'Press B or click to close';
    hint.style.cssText = `
      position: absolute; bottom: 20px; left: 50%; transform: translateX(-50%);
      color: rgba(255,255,255,0.5); font: 13px system-ui, sans-serif;
    `;
    overlay.appendChild(hint);

    overlay.addEventListener('click', () => this.hideOverlay());
    document.body.appendChild(overlay);
    this.overlay = overlay;
  }

  hideOverlay(): void {
    if (this.overlay) {
      this.overlay.remove();
      this.overlay = null;
    }
  }

  get isVisible(): boolean {
    return this.overlay !== null;
  }
}
