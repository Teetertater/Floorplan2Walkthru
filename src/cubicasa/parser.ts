/**
 * CubiCasa5K SVG Parser
 *
 * SVG Schema (observed from actual files):
 * ─────────────────────────────────────────
 * <svg>
 *   <g class="Model v1-1">
 *     <g class="Floor">
 *       <g class="Floorplan Floor-1">
 *
 *         <!-- ROOMS: <g class="Space [RoomType]"> -->
 *         <!-- Contains <polygon points="..."/> for room boundary -->
 *         <!-- RoomType classes: LivingRoom, Kitchen, Bedroom, Bath, Entry, Lobby,
 *              Storage, DraughtLobby, Outdoor, Undefined, Closet, "Kitchen Open" -->
 *
 *         <!-- WALLS: <g class="Wall [External]"> -->
 *         <!-- Contains <polygon points="x1,y1 x2,y2 x3,y3 x4,y4"/> -->
 *         <!-- 4 points form a quadrilateral representing wall thickness -->
 *         <!-- Doors and Windows are NESTED inside the Wall <g> element -->
 *
 *         <!-- RAILINGS: <g class="Railing"> -->
 *         <!-- Also 4-point polygons, parsed as walls (they act as barriers) -->
 *
 *         <!-- DOORS (inside Wall <g>): <g class="Door [SwingType] [Side]"> -->
 *         <!-- WINDOWS (inside Wall <g>): <g class="Window Regular"> -->
 *
 *         <!-- FIXED FURNITURE, STAIRS — IGNORED -->
 */

import { Plan, Wall, Door, Window, Room } from './types';
import { PlanMeta } from './metadata';

const ROOM_NAME_MAP: Record<string, string> = {
  'LivingRoom': 'Living Room',
  'Kitchen': 'Kitchen',
  'Kitchen Open': 'Kitchen / Living',
  'Bedroom': 'Bedroom',
  'Bath': 'Bathroom',
  'Entry': 'Entry',
  'Lobby': 'Lobby',
  'Storage': 'Storage',
  'DraughtLobby': 'Hallway',
  'Closet': 'Closet',
  'Closet WalkIn': 'Walk-in Closet',
  'Undefined': 'Room',
  'Outdoor': 'Outdoor',
  'Outdoor Balcony': 'Balcony',
};

function getRoomName(classStr: string): { name: string; type: string } {
  const tokens = classStr.split(/\s+/);
  const spaceIdx = tokens.indexOf('Space');
  const typeTokens = tokens.slice(spaceIdx + 1);
  const type = typeTokens.join(' ');
  return {
    name: ROOM_NAME_MAP[type] || type || 'Room',
    type,
  };
}

function parsePoints(pointsStr: string): [number, number][] {
  return pointsStr
    .trim()
    .split(/\s+/)
    .map(pair => {
      const [x, y] = pair.split(',').map(Number);
      return [x, y] as [number, number];
    })
    .filter(([x, y]) => !isNaN(x) && !isNaN(y));
}

function dedup(pts: [number, number][]): [number, number][] {
  if (pts.length > 3) {
    const l = pts[pts.length - 1];
    const f = pts[0];
    if (Math.abs(l[0] - f[0]) < 0.01 && Math.abs(l[1] - f[1]) < 0.01) {
      return pts.slice(0, -1);
    }
  }
  return pts;
}

// Extract centerline from a wall's 4-point polygon.
// Used for minimap drawing and door/window position snapping.
// The raw polygon is stored on the Wall for direct extrusion.
function wallCenterline(pts: [number, number][]): {
  start: [number, number];
  end: [number, number];
  thickness: number;
} {
  if (pts.length < 4) {
    return { start: pts[0], end: pts[1] || pts[0], thickness: 0.15 };
  }

  const edges: { len: number; a: [number, number]; b: [number, number] }[] = [];
  for (let i = 0; i < 4; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % 4];
    edges.push({ len: Math.hypot(b[0] - a[0], b[1] - a[1]), a, b });
  }

  const pair02 = edges[0].len + edges[2].len;
  const pair13 = edges[1].len + edges[3].len;

  let shortA: typeof edges[0], shortB: typeof edges[0];

  if (pair02 >= pair13) {
    shortA = edges[1]; shortB = edges[3];
  } else {
    shortA = edges[0]; shortB = edges[2];
  }

  const start: [number, number] = [
    (shortA.a[0] + shortA.b[0]) / 2,
    (shortA.a[1] + shortA.b[1]) / 2,
  ];
  const end: [number, number] = [
    (shortB.a[0] + shortB.b[0]) / 2,
    (shortB.a[1] + shortB.b[1]) / 2,
  ];

  const thickness = (shortA.len + shortB.len) / 2;

  return { start, end, thickness };
}

function projectOntoSegment(
  point: [number, number],
  segStart: [number, number],
  segEnd: [number, number],
): number {
  const dx = segEnd[0] - segStart[0];
  const dy = segEnd[1] - segStart[1];
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-8) return 0.5;
  const t = ((point[0] - segStart[0]) * dx + (point[1] - segStart[1]) * dy) / lenSq;
  return Math.max(0, Math.min(1, t));
}

function segmentLength(a: [number, number], b: [number, number]): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

function polyCenter(pts: [number, number][]): [number, number] {
  let cx = 0, cy = 0;
  for (const [x, y] of pts) { cx += x; cy += y; }
  return [cx / pts.length, cy / pts.length];
}

function parseWallElement(
  wallEl: Element,
  scale: number,
  wallIdx: { val: number },
  walls: Wall[],
  doors: Door[],
  windows: Window[],
) {
  const cls = wallEl.getAttribute('class') || '';
  const isExterior = cls.includes('External');

  const wallPoly = wallEl.querySelector(':scope > polygon');
  if (!wallPoly) return;

  const rawPts = parsePoints(wallPoly.getAttribute('points') || '');
  if (rawPts.length < 3) return;
  const pts = dedup(rawPts);

  const { start, end, thickness } = wallCenterline(pts);

  // Scale polygon points to meters
  const polygon: [number, number][] = pts.map(([x, y]) => [x * scale, y * scale]);

  const wallId = `wall_${wallIdx.val++}`;
  const wall: Wall = {
    id: wallId,
    polygon,
    start: [start[0] * scale, start[1] * scale],
    end: [end[0] * scale, end[1] * scale],
    thickness: Math.max(thickness * scale, 0.08),
    isExterior,
  };
  walls.push(wall);

  const wallLen = segmentLength(wall.start, wall.end);

  // Parse doors nested inside this wall
  const doorEls = wallEl.querySelectorAll(':scope > g[class*="Door"]');
  doorEls.forEach((doorEl, di) => {
    const threshold = doorEl.querySelector('.Threshold polygon, :scope > polygon');
    if (!threshold) return;

    const doorPts = parsePoints(threshold.getAttribute('points') || '');
    if (doorPts.length < 3) return;

    const center = polyCenter(doorPts);
    const position = projectOntoSegment(
      [center[0] * scale, center[1] * scale],
      wall.start,
      wall.end,
    );

    const tValues = doorPts.map(p =>
      projectOntoSegment([p[0] * scale, p[1] * scale], wall.start, wall.end),
    );
    const tMin = Math.min(...tValues);
    const tMax = Math.max(...tValues);
    const doorWidth = (tMax - tMin) * wallLen;

    doors.push({
      id: `door_${wallId}_${di}`,
      wallId,
      position,
      width: Math.max(doorWidth, 0.7),
      height: 1.85,
    });
  });

  // Parse windows nested inside this wall
  const winEls = wallEl.querySelectorAll(':scope > g[class*="Window"]');
  winEls.forEach((winEl, wi) => {
    const glass = winEl.querySelector('.Glass polygon, :scope > polygon');
    if (!glass) return;

    const winPts = parsePoints(glass.getAttribute('points') || '');
    if (winPts.length < 3) return;

    const center = polyCenter(winPts);
    const position = projectOntoSegment(
      [center[0] * scale, center[1] * scale],
      wall.start,
      wall.end,
    );

    const tValues = winPts.map(p =>
      projectOntoSegment([p[0] * scale, p[1] * scale], wall.start, wall.end),
    );
    const tMin = Math.min(...tValues);
    const tMax = Math.max(...tValues);
    const winWidth = (tMax - tMin) * wallLen;

    windows.push({
      id: `win_${wallId}_${wi}`,
      wallId,
      position,
      width: Math.max(winWidth, 0.4),
      height: 1.0,
      sillHeight: 0.8,
    });
  });
}

export function parseCubiCasa(svgText: string, meta: PlanMeta): Plan {
  const parser = new DOMParser();
  const doc = parser.parseFromString(svgText, 'image/svg+xml');

  const scale = meta.scaleMetersPerUnit;
  const walls: Wall[] = [];
  const doors: Door[] = [];
  const windows: Window[] = [];
  const rooms: Room[] = [];

  // ── Parse rooms ──
  const spaceEls = doc.querySelectorAll('g[class*="Space"]');
  let roomIdx = 0;
  spaceEls.forEach(el => {
    const cls = el.getAttribute('class') || '';
    if (el.closest('.FixedFurniture') || el.closest('.SelectionControls')) return;

    const { name, type } = getRoomName(cls);
    if (type === 'Outdoor' || type === 'Outdoor Balcony') return;

    const poly = el.querySelector(':scope > polygon');
    if (!poly) return;

    const rawPts = parsePoints(poly.getAttribute('points') || '');
    if (rawPts.length < 3) return;
    const pts = dedup(rawPts);

    const polygon: [number, number][] = pts.map(([x, y]) => [x * scale, y * scale]);

    rooms.push({
      id: `room_${roomIdx++}`,
      name,
      type,
      polygon,
    });
  });

  // ── Parse walls ──
  const wallIdx = { val: 0 };
  const wallEls = doc.querySelectorAll('g[class*="Wall"]');
  wallEls.forEach(wallEl => {
    const cls = wallEl.getAttribute('class') || '';
    if (!cls.match(/\bWall\b/)) return;
    // Skip nested wall children (doors/windows are inside wall groups)
    const parentWall = wallEl.parentElement?.closest('g[class*="Wall"]');
    if (parentWall && parentWall !== wallEl) return;

    parseWallElement(wallEl, scale, wallIdx, walls, doors, windows);
  });

  // ── Parse railings as walls (they often act as barriers between rooms) ──
  const railingEls = doc.querySelectorAll('g.Railing');
  railingEls.forEach(railEl => {
    const poly = railEl.querySelector(':scope > polygon');
    if (!poly) return;

    const rawPts = parsePoints(poly.getAttribute('points') || '');
    if (rawPts.length < 3) return;
    const pts = dedup(rawPts);

    const { start, end, thickness } = wallCenterline(pts);
    const polygon: [number, number][] = pts.map(([x, y]) => [x * scale, y * scale]);
    walls.push({
      id: `wall_${wallIdx.val++}`,
      polygon,
      start: [start[0] * scale, start[1] * scale],
      end: [end[0] * scale, end[1] * scale],
      thickness: Math.max(thickness * scale, 0.05),
      isExterior: false,
    });
  });

  console.log(`Parsed ${meta.id}: ${walls.length} walls, ${doors.length} doors, ${windows.length} windows, ${rooms.length} rooms`);

  return {
    id: meta.id,
    name: meta.name,
    scaleMetersPerUnit: scale,
    walls,
    doors,
    windows,
    rooms,
    outerPerimeter: meta.outerPerimeter,
  };
}
