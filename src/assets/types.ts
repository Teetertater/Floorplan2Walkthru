export interface FurnitureMeta {
  id: string;                // directory name, e.g. "Sofa_01_1k.gltf"
  name: string;              // human-readable, e.g. "Classic Sofa"
  category: 'seating' | 'table' | 'storage' | 'desk' | 'lighting' | 'decor';
  style: string[];           // e.g. ["mid-century", "modern"]
  dimensions: { w: number; h: number; d: number }; // meters (bounding box)
  description: string;       // rich text for agent context
  gltfPath: string;          // relative to /assets/furniture/, e.g. "Sofa_01_1k.gltf/Sofa_01_1k.gltf"
  placement: 'floor' | 'wall' | 'ceiling';
  scaleRange: { min: number; max: number }; // acceptable uniform scale range
  thumbnailPath?: string; // path to webp preview, relative to /assets/thumbnails/
}

export interface MaterialMeta {
  id: string;
  name: string;
  style: string[];
  description: string;
  // texture paths relative to /assets/materials/{id}/
  maps: {
    color?: string;
    normal?: string;
    roughness?: string;
    metalness?: string;
  };
  tiling?: { x: number; y: number }; // repeat per meter
}
