import * as THREE from 'three';
import { Plan, Wall } from '../cubicasa/types';

const WALL_HEIGHT = 2.2;
const DOOR_HEIGHT = 2.0;
const FLOOR_THICKNESS = 0.05;

type OpeningOnWall = {
  tStart: number;
  tEnd: number;
  type: 'door' | 'window';
  sillHeight?: number;
  height?: number;
};

// ── Helpers ──

function lerp2(a: [number, number], b: [number, number], t: number): [number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

function wallCenterlineLength(wall: Wall): number {
  return Math.hypot(wall.end[0] - wall.start[0], wall.end[1] - wall.start[1]);
}

// Build a rectangle from centerline + thickness, then extract a sub-quad
// at parameter range [tStart, tEnd]. Works for any wall angle.
// The perpendicular is derived from the centerline direction.
// At the wall endpoints (t=0 or t=1), extends slightly so the rectangle
// overlaps into neighboring polygon walls and avoids corner gaps.
function centerlineSubQuad(
  wall: Wall,
  tStart: number,
  tEnd: number,
): [number, number][] {
  const dx = wall.end[0] - wall.start[0];
  const dy = wall.end[1] - wall.start[1];
  const len = Math.hypot(dx, dy);
  if (len < 1e-8) return [];

  // Unit along wall and perpendicular
  const ux = dx / len;
  const uy = dy / len;
  const nx = -uy;
  const ny =  ux;
  const halfT = wall.thickness / 2;

  // Extend at wall endpoints to overlap into neighboring walls
  const ext = halfT;
  const s = lerp2(wall.start, wall.end, tStart);
  const e = lerp2(wall.start, wall.end, tEnd);
  if (tStart <= 0.001) { s[0] -= ux * ext; s[1] -= uy * ext; }
  if (tEnd   >= 0.999) { e[0] += ux * ext; e[1] += uy * ext; }

  return [
    [s[0] + nx * halfT, s[1] + ny * halfT],
    [e[0] + nx * halfT, e[1] + ny * halfT],
    [e[0] - nx * halfT, e[1] - ny * halfT],
    [s[0] - nx * halfT, s[1] - ny * halfT],
  ];
}

// Extrude a 2D polygon vertically from yBottom to yTop.
// Uses the same (x, -z) → rotate trick as floors/ceilings.
function extrudePolygon(
  points: [number, number][],
  yBottom: number,
  yTop: number,
  material: THREE.Material,
  userData: Record<string, unknown>,
): THREE.Mesh | null {
  const height = yTop - yBottom;
  if (height < 0.001 || points.length < 3) return null;

  const shape = new THREE.Shape();
  shape.moveTo(points[0][0], -points[0][1]);
  for (let i = 1; i < points.length; i++) {
    shape.lineTo(points[i][0], -points[i][1]);
  }
  shape.closePath();

  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: height,
    bevelEnabled: false,
  });

  const mesh = new THREE.Mesh(geo, material);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = yBottom;
  mesh.userData = userData;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

// ── Wall generation ──

export function generateWallMeshes(
  plan: Plan,
  wallMaterial: THREE.Material,
  lintelMaterial: THREE.Material,
): THREE.Group {
  const group = new THREE.Group();
  group.name = 'walls';

  for (const wall of plan.walls) {
    if (wall.polygon.length < 3) continue;
    const len = wallCenterlineLength(wall);

    // Collect openings on this wall
    const openings: OpeningOnWall[] = [];

    for (const door of plan.doors) {
      if (door.wallId !== wall.id) continue;
      const halfW = len > 0.01 ? (door.width / 2) / len : 0.5;
      openings.push({
        tStart: Math.max(0, door.position - halfW),
        tEnd: Math.min(1, door.position + halfW),
        type: 'door',
        height: door.height,
      });
    }

    for (const win of plan.windows) {
      if (win.wallId !== wall.id) continue;
      const halfW = len > 0.01 ? (win.width / 2) / len : 0.5;
      openings.push({
        tStart: Math.max(0, win.position - halfW),
        tEnd: Math.min(1, win.position + halfW),
        type: 'window',
        sillHeight: win.sillHeight,
        height: win.height,
      });
    }

    openings.sort((a, b) => a.tStart - b.tStart);

    // Merge overlapping
    const merged: OpeningOnWall[] = [];
    for (const o of openings) {
      if (merged.length > 0 && o.tStart < merged[merged.length - 1].tEnd + 0.001) {
        const last = merged[merged.length - 1];
        last.tEnd = Math.max(last.tEnd, o.tEnd);
        if (o.type === 'door') last.type = 'door';
      } else {
        merged.push({ ...o });
      }
    }

    if (merged.length === 0) {
      // No openings — use original SVG polygon (preserves corner geometry)
      const mesh = extrudePolygon(
        wall.polygon, 0, WALL_HEIGHT, wallMaterial,
        { type: 'wall', wallId: wall.id },
      );
      if (mesh) group.add(mesh);
    } else {
      // Has openings — build sub-quads from centerline + thickness
      let cursor = 0;

      for (const opening of merged) {
        // Solid segment before opening
        if (opening.tStart > cursor + 0.001) {
          const quad = centerlineSubQuad(wall, cursor, opening.tStart);
          const mesh = extrudePolygon(
            quad, 0, WALL_HEIGHT, wallMaterial,
            { type: 'wall', wallId: wall.id },
          );
          if (mesh) group.add(mesh);
        }

        // Opening segment
        const openQuad = centerlineSubQuad(wall, opening.tStart, opening.tEnd);

        if (opening.type === 'door') {
          const doorH = opening.height || DOOR_HEIGHT;
          if (doorH < WALL_HEIGHT - 0.01) {
            const mesh = extrudePolygon(
              openQuad, doorH, WALL_HEIGHT, lintelMaterial,
              { type: 'lintel', wallId: wall.id },
            );
            if (mesh) group.add(mesh);
          }
        } else {
          const sillH = opening.sillHeight || 0.8;
          const winH = opening.height || 1.0;
          const winTop = sillH + winH;

          if (sillH > 0.01) {
            const mesh = extrudePolygon(
              openQuad, 0, sillH, wallMaterial,
              { type: 'wall', wallId: wall.id },
            );
            if (mesh) group.add(mesh);
          }
          if (winTop < WALL_HEIGHT - 0.01) {
            const mesh = extrudePolygon(
              openQuad, winTop, WALL_HEIGHT, lintelMaterial,
              { type: 'lintel', wallId: wall.id },
            );
            if (mesh) group.add(mesh);
          }
        }

        cursor = opening.tEnd;
      }

      // Solid segment after last opening
      if (cursor < 1 - 0.001) {
        const quad = centerlineSubQuad(wall, cursor, 1);
        const mesh = extrudePolygon(
          quad, 0, WALL_HEIGHT, wallMaterial,
          { type: 'wall', wallId: wall.id },
        );
        if (mesh) group.add(mesh);
      }
    }
  }

  return group;
}

// ── Floor + Ceiling: single slab from hardcoded outer perimeter ──

function generateFloorSlab(
  plan: Plan,
  floorMaterial: THREE.Material,
): THREE.Group {
  const group = new THREE.Group();
  group.name = 'floors';

  if (plan.outerPerimeter.length < 3) return group;

  const mesh = extrudePolygon(
    plan.outerPerimeter, -FLOOR_THICKNESS, 0, floorMaterial,
    { type: 'floor' },
  );
  if (mesh) { mesh.receiveShadow = true; group.add(mesh); }

  return group;
}

function generateCeilingSlab(
  plan: Plan,
  ceilingMaterial: THREE.Material,
): THREE.Group {
  const group = new THREE.Group();
  group.name = 'ceilings';

  if (plan.outerPerimeter.length < 3) return group;

  const mesh = extrudePolygon(
    plan.outerPerimeter, WALL_HEIGHT, WALL_HEIGHT + FLOOR_THICKNESS, ceilingMaterial,
    { type: 'ceiling' },
  );
  if (mesh) { mesh.receiveShadow = true; group.add(mesh); }

  return group;
}

// Get the wall center position and angle at parameter t (0..1) along the centerline.
function wallPosAt(wall: Wall, t: number): { cx: number; cz: number; angle: number; thickness: number } {
  const dx = wall.end[0] - wall.start[0];
  const dz = wall.end[1] - wall.start[1];
  return {
    cx: wall.start[0] + dx * t,
    cz: wall.start[1] + dz * t,
    angle: Math.atan2(dz, dx),
    thickness: wall.thickness,
  };
}

// ── Door frame generation ──
// Inverted-U frame (two posts + top bar) as a single extruded shape.
// Uses wallPosAt() for correct positioning regardless of polygon winding.

function generateDoorMeshes(
  plan: Plan,
  doorMaterial: THREE.Material,
): THREE.Group {
  const group = new THREE.Group();
  group.name = 'doors';

  const ft = 0.04; // frame thickness

  for (const door of plan.doors) {
    const wall = plan.walls.find(w => w.id === door.wallId);
    if (!wall) continue;

    const { cx, cz, angle, thickness } = wallPosAt(wall, door.position);
    const w = door.width;
    const h = door.height;
    const depth = thickness + 0.02;

    // Inverted-U profile in local space: X = across door width, Y = height
    // Centered on X so (0,0) is the middle-bottom of the door
    const hw = w / 2;
    const shape = new THREE.Shape();
    shape.moveTo(-hw, 0);
    shape.lineTo(-hw, h);
    shape.lineTo(hw, h);
    shape.lineTo(hw, 0);
    shape.lineTo(hw - ft, 0);
    shape.lineTo(hw - ft, h - ft);
    shape.lineTo(-hw + ft, h - ft);
    shape.lineTo(-hw + ft, 0);
    shape.closePath();

    const frameGeo = new THREE.ExtrudeGeometry(shape, {
      depth,
      bevelEnabled: false,
    });
    // Shift geometry so extrusion is centered on Z (depth)
    frameGeo.translate(0, 0, -depth / 2);

    const frameMesh = new THREE.Mesh(frameGeo, doorMaterial);

    // Orient: local X = wall direction, local Y = up, local Z = wall normal
    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);
    const mat4 = new THREE.Matrix4();
    mat4.makeBasis(
      new THREE.Vector3(cosA, 0, sinA),   // local X → along wall
      new THREE.Vector3(0, 1, 0),          // local Y → up
      new THREE.Vector3(-sinA, 0, cosA),   // local Z → wall normal
    );
    frameMesh.setRotationFromMatrix(mat4);
    frameMesh.position.set(cx, 0, cz);

    frameMesh.userData = { type: 'door_frame', doorId: door.id };
    group.add(frameMesh);
  }

  return group;
}

// ── Window pane generation ──

function generateWindowMeshes(
  plan: Plan,
  windowMaterial: THREE.Material,
): THREE.Group {
  const group = new THREE.Group();
  group.name = 'windows';

  for (const win of plan.windows) {
    const wall = plan.walls.find(w => w.id === win.wallId);
    if (!wall) continue;

    const { cx, cz, angle } = wallPosAt(wall, win.position);

    const paneGeo = new THREE.PlaneGeometry(win.width, win.height);
    const paneMesh = new THREE.Mesh(paneGeo, windowMaterial);
    paneMesh.position.set(cx, win.sillHeight + win.height / 2, cz);
    paneMesh.rotation.y = -angle;
    paneMesh.userData = { type: 'window_pane', windowId: win.id };
    group.add(paneMesh);
  }

  return group;
}

// ── Main scene generator ──

// ── Per-room ceiling lights ──

function generateRoomLights(plan: Plan): THREE.Group {
  const group = new THREE.Group();
  group.name = 'room_lights';

  for (const room of plan.rooms) {
    if (room.polygon.length < 3) continue;

    // Centroid of room polygon
    const cx = room.polygon.reduce((s, p) => s + p[0], 0) / room.polygon.length;
    const cz = room.polygon.reduce((s, p) => s + p[1], 0) / room.polygon.length;

    // Approximate room area to scale light intensity
    let area = 0;
    for (let i = 0; i < room.polygon.length; i++) {
      const [x1, z1] = room.polygon[i];
      const [x2, z2] = room.polygon[(i + 1) % room.polygon.length];
      area += x1 * z2 - x2 * z1;
    }
    area = Math.abs(area) / 2;

    // Soft warm fill light, intensity scaled gently by room size
    const intensity = Math.max(0.3, Math.min(1.0, area * 0.12));
    const light = new THREE.PointLight(0xfff5e8, intensity, 12, 2);
    light.position.set(cx, WALL_HEIGHT - 0.05, cz); // just below ceiling
    light.castShadow = false; // keep it fast
    group.add(light);

    // Small visible bulb sphere
    const bulbGeo = new THREE.SphereGeometry(0.04, 8, 8);
    const bulbMat = new THREE.MeshBasicMaterial({ color: 0xfff8ee });
    const bulb = new THREE.Mesh(bulbGeo, bulbMat);
    bulb.position.copy(light.position);
    group.add(bulb);
  }

  return group;
}

// ── Ground disc ──

function generateGround(
  plan: Plan,
  groundMaterial: THREE.Material,
): THREE.Mesh {
  // Find bounding circle center and radius from all building geometry
  const allPts: [number, number][] = [];
  for (const room of plan.rooms) allPts.push(...room.polygon);
  for (const wall of plan.walls) allPts.push(...wall.polygon);

  let cx = 0, cz = 0;
  for (const [x, z] of allPts) { cx += x; cz += z; }
  cx /= allPts.length;
  cz /= allPts.length;

  let maxR = 0;
  for (const [x, z] of allPts) {
    maxR = Math.max(maxR, Math.hypot(x - cx, z - cz));
  }

  const radius = maxR + 20; // m beyond building edge
  const geo = new THREE.CircleGeometry(radius, 64);
  const mesh = new THREE.Mesh(geo, groundMaterial);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(cx, -0.01, cz); // just below floor
  mesh.receiveShadow = true;
  mesh.userData = { type: 'ground' };
  return mesh;
}

// ── Main scene generator ──

export function generateScene(
  plan: Plan,
  materials: {
    wall: THREE.Material;
    lintel: THREE.Material;
    floor: THREE.Material;
    ceiling: THREE.Material;
    doorFrame: THREE.Material;
    windowPane: THREE.Material;
    ground: THREE.Material;
  },
): THREE.Group {
  const root = new THREE.Group();
  root.name = 'plan_root';

  root.add(generateWallMeshes(plan, materials.wall, materials.lintel));
  root.add(generateFloorSlab(plan, materials.floor));
  root.add(generateCeilingSlab(plan, materials.ceiling));
  root.add(generateDoorMeshes(plan, materials.doorFrame));
  root.add(generateWindowMeshes(plan, materials.windowPane));
  root.add(generateRoomLights(plan));
  root.add(generateGround(plan, materials.ground));

  return root;
}
