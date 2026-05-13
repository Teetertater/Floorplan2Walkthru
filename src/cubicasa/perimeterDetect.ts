/**
 * Auto-detect the outer perimeter of a floor plan from its SVG.
 *
 * Strategy: parse all opaque filled polygons (rooms + walls), rasterize them
 * onto a binary grid, trace the outer contour, then simplify back to a polygon
 * in SVG coordinate space. Thin lines (doors) are ignored via fill detection.
 */

const GRID_RESOLUTION = 2; // pixels per SVG unit — enough for contour, fast enough

type Point = [number, number];

/**
 * Given raw SVG text, detect the outer perimeter polygon (in SVG units).
 * Returns the perimeter as [x,y][] pairs ready to be scaled by scaleMetersPerUnit.
 */
export function detectOuterPerimeter(svgText: string): Point[] {
  const parser = new DOMParser();
  const doc = parser.parseFromString(svgText, 'image/svg+xml');

  // Collect all filled polygons (rooms + walls + railings)
  const polygons: Point[][] = [];

  const polyEls = doc.querySelectorAll('polygon');
  for (const el of polyEls) {
    // Skip elements inside FixedFurniture, SelectionControls, etc.
    if (el.closest('.FixedFurniture') || el.closest('.SelectionControls')) continue;

    // Only include polygons that are part of Space, Wall, or Railing groups
    const parentGroup = el.closest('g[class*="Space"], g[class*="Wall"], g.Railing');
    if (!parentGroup) continue;

    // Skip door threshold polygons and window glass — these are openings
    if (el.closest('g[class*="Door"]') || el.closest('g[class*="Window"]')) continue;

    const pts = parsePolyPoints(el.getAttribute('points') || '');
    if (pts.length >= 3) polygons.push(pts);
  }

  if (polygons.length === 0) return [];

  // Compute bounding box
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const poly of polygons) {
    for (const [x, y] of poly) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }

  const pad = 2; // grid cells of padding
  const gw = Math.ceil((maxX - minX) * GRID_RESOLUTION) + pad * 2;
  const gh = Math.ceil((maxY - minY) * GRID_RESOLUTION) + pad * 2;

  // Rasterize: mark cells inside any polygon
  const grid = new Uint8Array(gw * gh);

  for (const poly of polygons) {
    rasterizePolygon(poly, grid, gw, gh, minX, minY, pad);
  }

  // Morphological dilation (1 cell) to close small gaps between rooms/walls
  const dilated = dilate(grid, gw, gh);

  // Trace outer contour
  const contour = traceOuterContour(dilated, gw, gh);
  if (contour.length < 3) return [];

  // Convert grid coords back to SVG coords
  const svgContour: Point[] = contour.map(([gx, gy]) => [
    (gx - pad) / GRID_RESOLUTION + minX,
    (gy - pad) / GRID_RESOLUTION + minY,
  ]);

  // Simplify the contour (Douglas-Peucker)
  return douglasPeucker(svgContour, 1.0 / GRID_RESOLUTION);
}

// ── Helpers ──

function parsePolyPoints(s: string): Point[] {
  return s.trim().split(/\s+/).map(pair => {
    const [x, y] = pair.split(',').map(Number);
    return [x, y] as Point;
  }).filter(([x, y]) => !isNaN(x) && !isNaN(y));
}

function rasterizePolygon(
  poly: Point[],
  grid: Uint8Array,
  gw: number,
  gh: number,
  originX: number,
  originY: number,
  pad: number,
) {
  // Convert polygon to grid coords
  const gPoly = poly.map(([x, y]): Point => [
    (x - originX) * GRID_RESOLUTION + pad,
    (y - originY) * GRID_RESOLUTION + pad,
  ]);

  // Scanline fill
  let yMin = gh, yMax = 0;
  for (const [, gy] of gPoly) {
    const iy = Math.floor(gy);
    if (iy < yMin) yMin = iy;
    if (iy > yMax) yMax = iy;
  }
  yMin = Math.max(0, yMin);
  yMax = Math.min(gh - 1, yMax);

  for (let y = yMin; y <= yMax; y++) {
    const intersections: number[] = [];
    const n = gPoly.length;
    for (let i = 0; i < n; i++) {
      const [x0, y0] = gPoly[i];
      const [x1, y1] = gPoly[(i + 1) % n];
      if ((y0 <= y && y1 > y) || (y1 <= y && y0 > y)) {
        const t = (y - y0) / (y1 - y0);
        intersections.push(x0 + t * (x1 - x0));
      }
    }
    intersections.sort((a, b) => a - b);
    for (let i = 0; i < intersections.length - 1; i += 2) {
      const xStart = Math.max(0, Math.ceil(intersections[i]));
      const xEnd = Math.min(gw - 1, Math.floor(intersections[i + 1]));
      for (let x = xStart; x <= xEnd; x++) {
        grid[y * gw + x] = 1;
      }
    }
  }
}

function dilate(grid: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (grid[y * w + x]) { out[y * w + x] = 1; continue; }
      // Check 4-neighbours
      if ((x > 0 && grid[y * w + x - 1]) ||
          (x < w - 1 && grid[y * w + x + 1]) ||
          (y > 0 && grid[(y - 1) * w + x]) ||
          (y < h - 1 && grid[(y + 1) * w + x])) {
        out[y * w + x] = 1;
      }
    }
  }
  return out;
}

function traceOuterContour(grid: Uint8Array, w: number, h: number): Point[] {
  // Find first filled cell (top-left scan)
  let startX = -1, startY = -1;
  outer: for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (grid[y * w + x]) {
        startX = x;
        startY = y;
        break outer;
      }
    }
  }
  if (startX < 0) return [];

  // Moore neighbourhood contour tracing
  // Directions: 0=right, 1=down-right, 2=down, 3=down-left, 4=left, 5=up-left, 6=up, 7=up-right
  const dx = [1, 1, 0, -1, -1, -1, 0, 1];
  const dy = [0, 1, 1, 1, 0, -1, -1, -1];

  const contour: Point[] = [];
  let cx = startX, cy = startY;
  let dir = 7; // start looking up-right (came from left)

  const maxIter = w * h * 4;
  for (let iter = 0; iter < maxIter; iter++) {
    contour.push([cx, cy]);

    // Search for next boundary cell
    let found = false;
    const searchStart = (dir + 5) % 8; // backtrack: turn around ~135 degrees
    for (let i = 0; i < 8; i++) {
      const d = (searchStart + i) % 8;
      const nx = cx + dx[d];
      const ny = cy + dy[d];
      if (nx >= 0 && nx < w && ny >= 0 && ny < h && grid[ny * w + nx]) {
        cx = nx;
        cy = ny;
        dir = d;
        found = true;
        break;
      }
    }

    if (!found) break;
    if (cx === startX && cy === startY && contour.length > 2) break;
  }

  return contour;
}

function douglasPeucker(points: Point[], epsilon: number): Point[] {
  if (points.length <= 2) return points;

  let maxDist = 0;
  let maxIdx = 0;
  const first = points[0];
  const last = points[points.length - 1];

  for (let i = 1; i < points.length - 1; i++) {
    const d = pointToSegmentDist(points[i], first, last);
    if (d > maxDist) {
      maxDist = d;
      maxIdx = i;
    }
  }

  if (maxDist > epsilon) {
    const left = douglasPeucker(points.slice(0, maxIdx + 1), epsilon);
    const right = douglasPeucker(points.slice(maxIdx), epsilon);
    return [...left.slice(0, -1), ...right];
  }

  return [first, last];
}

function pointToSegmentDist(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-10) return Math.hypot(p[0] - a[0], p[1] - a[1]);

  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}
