export interface FurniturePlacement {
  assetId: string;           // references FurnitureMeta.id
  instanceId: string;        // unique per placement, e.g. "sofa_01_0"
  roomId: string;            // which room this belongs to
  position: [number, number, number]; // [x, y, z] in meters
  rotation: number;          // degrees around Y axis
  scale: number;             // uniform scale, default 1
}

export interface SurfaceStyle {
  type: 'texture' | 'colour';
  textureId?: string;        // references TextureMeta.id
  colour?: string;           // hex e.g. "#ff0000"
  opacity?: number;          // 0..1, default 1
}

export interface CameraState {
  position: [number, number, number];
  lookDir: [number, number, number]; // unit direction vector
}

export interface PanoramaCapture {
  roomId: string;
  roomName: string;
  position: [number, number, number]; // camera center in meters
}

export interface SceneState {
  planId: string;
  furniture: FurniturePlacement[];
  camera?: CameraState;
  // Surface overrides keyed by target:
  //   "wall:{wallId}" for individual walls
  //   "walls:{roomId}" for all walls in a room
  //   "floor" for the floor slab
  //   "ceiling" for the ceiling slab
  surfaces?: Record<string, SurfaceStyle>;
  // Per-door style applied to both the frame and panel (keyed by doorId)
  doorStyles?: Record<string, SurfaceStyle>;
  // Door IDs the user has explicitly deleted — the wall becomes solid in that spot.
  deletedDoors?: string[];
  // Panorama captures keyed by roomId (one per room)
  panoramas?: Record<string, PanoramaCapture>;
}

export function createEmptyState(planId: string): SceneState {
  return {
    planId,
    furniture: [],
    surfaces: {},
    doorStyles: {},
    deletedDoors: [],
    panoramas: {},
  };
}
