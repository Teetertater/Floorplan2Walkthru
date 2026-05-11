export type Plan = {
  id: string;
  name: string;
  scaleMetersPerUnit: number;
  walls: Wall[];
  doors: Door[];
  windows: Window[];
  rooms: Room[];
  outerPerimeter: [number, number][]; // building outline for floor/ceiling
};

export type Wall = {
  id: string;
  polygon: [number, number][]; // raw 4-point footprint in meters (for extrusion)
  start: [number, number];     // centerline start, meters (for minimap / door snapping)
  end: [number, number];       // centerline end
  thickness: number;           // meters
  isExterior: boolean;
};

export type Door = {
  id: string;
  wallId: string;
  position: number; // 0..1 along wall
  width: number; // meters
  height: number; // meters, default 2.0
};

export type Window = {
  id: string;
  wallId: string;
  position: number; // 0..1 along wall
  width: number; // meters
  height: number; // default 1.2
  sillHeight: number; // default 1.0
};

export type Room = {
  id: string;
  name: string;
  type: string; // original class name
  polygon: [number, number][]; // meters, counterclockwise
};
