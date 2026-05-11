import { SceneState } from './types';

// Default furniture placements for plan_17 (Finnish Apartment)
// Room bounds (x min/max, z min/max) — usable area with ~0.3m wall inset:
//   room_2 LivingRoom  usable x:[2.2,5.0]  z:[2.6,6.1]   ~2.8 x 3.5m
//   room_3 Entry Lobby usable x:[4.6,5.6]  z:[5.9,8.5]   ~1.0 x 2.6m
//   room_5 Kitchen     usable x:[5.5,7.1]  z:[4.3,6.0]   ~1.6 x 1.7m
//   room_6 Bedroom     usable x:[1.1,4.0]  z:[6.8,9.3]   ~2.9 x 2.5m

export const DEFAULT_SCENES: Record<string, SceneState> = {
  plan_17: {
    planId: 'plan_17',
    surfaces: {},
    furniture: [
      // ── Living Room (room_2) ──
      // Sofa against west wall, facing east
      {
        assetId: 'sofa_02',
        instanceId: 'sofa_02_0',
        roomId: 'room_2',
        position: [2.4, 0, 4.6],
        rotation: 90,
        scale: 1,
      },
      // Armchair facing sofa
      {
        assetId: 'modern_arm_chair',
        instanceId: 'arm_chair_0',
        roomId: 'room_2',
        position: [4.4, 0, 4.6],
        rotation: -90,
        scale: 1,
      },
      // Coffee table between sofa and chair
      {
        assetId: 'chinese_tea_table',
        instanceId: 'tea_table_0',
        roomId: 'room_2',
        position: [3.4, 0, 4.6],
        rotation: 0,
        scale: 1,
      },
      // Cabinet along north wall, inset from wall
      {
        assetId: 'modern_wooden_cabinet',
        instanceId: 'cabinet_0',
        roomId: 'room_2',
        position: [3.6, 0, 3.2],
        rotation: 0,
        scale: 0.75,
      },

      // ── Bedroom (room_6) ──
      // Drawer against west wall
      {
        assetId: 'vintage_wooden_drawer',
        instanceId: 'drawer_0',
        roomId: 'room_6',
        position: [1.3, 0, 7.5],
        rotation: 90,
        scale: 1,
      },
      // Lounge chair, against south wall, facing north
      {
        assetId: 'mid_century_lounge_chair',
        instanceId: 'lounge_chair_0',
        roomId: 'room_6',
        position: [2.8, 0, 8.8],
        rotation: 0,
        scale: 0.9,
      },
      // Side table next to the chair
      {
        assetId: 'wooden_table_02',
        instanceId: 'side_table_0',
        roomId: 'room_6',
        position: [1.5, 0, 8.8],
        rotation: 0,
        scale: 0.65,
      },

      // ── Kitchen (room_5) ──
      // Small round table, centered in room
      {
        assetId: 'round_wooden_table',
        instanceId: 'kitchen_table_0',
        roomId: 'room_5',
        position: [6.3, 0, 5.2],
        rotation: 0,
        scale: 0.5,
      },
      // Stools on opposite sides of table
      {
        assetId: 'metal_stool',
        instanceId: 'stool_0',
        roomId: 'room_5',
        position: [5.8, 0, 5.2],
        rotation: 90,
        scale: 1,
      },
      {
        assetId: 'metal_stool',
        instanceId: 'stool_1',
        roomId: 'room_5',
        position: [6.7, 0, 5.6],
        rotation: 0,
        scale: 1,
      },

      // ── Entry Lobby (room_3) ──
      // Console against east wall, centered vertically
      {
        assetId: 'classic_console',
        instanceId: 'console_0',
        roomId: 'room_3',
        position: [5.2, 0, 7.5],
        rotation: 90,
        scale: 0.6,
      },
    ],
  },
};
