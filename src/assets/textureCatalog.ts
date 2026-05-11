export interface TextureMeta {
  id: string;
  name: string;
  suitableFor: ('wall' | 'floor' | 'ceiling')[];
  diffPath: string;
  normalPath?: string;
  roughPath?: string;
  tiling: [number, number]; // repeat values
}

export const TEXTURE_CATALOG: TextureMeta[] = [
  {
    id: 'beige_wall',
    name: 'White Wall',
    suitableFor: ['wall', 'ceiling'],
    diffPath: '/textures/beige_wall/diff.jpg',
    normalPath: '/textures/beige_wall/nor_gl.jpg',
    roughPath: '/textures/beige_wall/rough.jpg',
    tiling: [0.7, 0.7],
  },
  {
    id: 'white_plaster',
    name: 'White Plaster',
    suitableFor: ['wall', 'ceiling'],
    diffPath: '/textures/white_plaster/diff.jpg',
    normalPath: '/textures/white_plaster/nor_gl.jpg',
    roughPath: '/textures/white_plaster/rough.jpg',
    tiling: [0.7, 0.7],
  },
  {
    id: 'laminate_floor',
    name: 'Laminate Floor',
    suitableFor: ['floor'],
    diffPath: '/textures/laminate_floor/diff.jpg',
    normalPath: '/textures/laminate_floor/nor_gl.jpg',
    roughPath: '/textures/laminate_floor/rough.jpg',
    tiling: [0.5, 0.5],
  },
  {
    id: 'wood_floor',
    name: 'Wood Floor',
    suitableFor: ['floor'],
    diffPath: '/textures/wood_floor/diff.jpg',
    normalPath: '/textures/wood_floor/nor_gl.jpg',
    roughPath: '/textures/wood_floor/rough.jpg',
    tiling: [0.5, 0.5],
  },
  {
    id: 'plastered_ceiling',
    name: 'Plastered Ceiling',
    suitableFor: ['ceiling', 'wall'],
    diffPath: '/textures/plastered_ceiling/diff.jpg',
    normalPath: '/textures/plastered_ceiling/nor_gl.jpg',
    roughPath: '/textures/plastered_ceiling/rough.jpg',
    tiling: [0.5, 0.5],
  },
];
