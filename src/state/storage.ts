import JSZip from 'jszip';
import { SceneState } from './types';
import { PlanMeta } from '../cubicasa/metadata';

const SESSIONS_KEY = 'archWalkthru_sessions';
const ACTIVE_KEY = 'archWalkthru_active';

// ── G-buffer blob store (in-memory, per session) ──
// Keyed by pass name: 'rgb', 'albedo', 'depth', 'normal', 'metallic', 'roughness'
let gbufferBlobs: Record<string, Blob> = {};

export function getGBufferBlobs(): Record<string, Blob> {
  return gbufferBlobs;
}

export function setGBufferBlobs(blobs: Record<string, Blob>): void {
  gbufferBlobs = { ...blobs };
}

export function clearGBufferBlobs(): void {
  gbufferBlobs = {};
}

// ── Panorama blob store (in-memory, per session) ──
// Keyed by roomId → PNG blob
let panoramaBlobs: Record<string, Blob> = {};

export function getPanoramaBlobs(): Record<string, Blob> {
  return panoramaBlobs;
}

export function setPanoramaBlob(roomId: string, blob: Blob): void {
  panoramaBlobs[roomId] = blob;
}

export function setPanoramaBlobs(blobs: Record<string, Blob>): void {
  panoramaBlobs = { ...blobs };
}

export function clearPanoramaBlobs(): void {
  panoramaBlobs = {};
}

// ── Session CRUD ──
// Storage layout: `{ "<id>": { id, name, state, svgText, meta }, ... }`.
// Display names can collide; the numeric id is the real identity.
// Each record is fully self-contained — no shared cache, no cross-session refs.

export interface SessionRecord {
  id: number;
  name: string;
  state: SceneState;
  svgText: string;
  meta: PlanMeta;
}

function readAll(): Record<string, SessionRecord> {
  try {
    return JSON.parse(localStorage.getItem(SESSIONS_KEY) || '{}');
  } catch {
    return {};
  }
}

function writeAll(sessions: Record<string, SessionRecord>) {
  localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
}

function nextId(all: Record<string, SessionRecord>): number {
  const ids = Object.values(all).map(r => r.id);
  return ids.length > 0 ? Math.max(...ids) + 1 : 1;
}

export function listSessions(): SessionRecord[] {
  return Object.values(readAll()).sort((a, b) => a.id - b.id);
}

export function getSession(id: number): SessionRecord | null {
  return readAll()[String(id)] ?? null;
}

/** Upsert by id — caller must already have an id (use createSession to allocate). */
export function saveSession(record: SessionRecord): void {
  const all = readAll();
  all[String(record.id)] = record;
  writeAll(all);
}

/** Allocate a fresh id (max+1) and persist a new session. */
export function createSession(template: Omit<SessionRecord, 'id'>): SessionRecord {
  const all = readAll();
  const id = nextId(all);
  const record: SessionRecord = { id, ...template };
  all[String(id)] = record;
  writeAll(all);
  return record;
}

export function deleteSession(id: number): void {
  const all = readAll();
  delete all[String(id)];
  writeAll(all);
}

export function renameSession(id: number, newName: string): void {
  const all = readAll();
  const rec = all[String(id)];
  if (rec) {
    rec.name = newName;
    writeAll(all);
  }
}

// ── Active session tracking ──

export function getActiveSessionId(): number | null {
  const raw = localStorage.getItem(ACTIVE_KEY);
  if (!raw) return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

export function setActiveSessionId(id: number | null): void {
  if (id == null) localStorage.removeItem(ACTIVE_KEY);
  else localStorage.setItem(ACTIVE_KEY, String(id));
}

// ── ZIP export ──

export interface SessionBundle {
  name: string;
  state: SceneState;
  svgText: string;
  meta: PlanMeta;
}

export async function exportSessionZip(bundle: SessionBundle): Promise<void> {
  const zip = new JSZip();

  zip.file('session.json', JSON.stringify({
    name: bundle.name,
    state: bundle.state,
  }, null, 2));

  zip.file('config.json', JSON.stringify({
    name: bundle.meta.name,
    scaleMetersPerUnit: bundle.meta.scaleMetersPerUnit,
    startRoom: bundle.meta.startRoom,
    outerPerimeter: bundle.meta.outerPerimeter,
  }, null, 2));

  zip.file('model.svg', bundle.svgText);

  // Include any g-buffer videos
  for (const [passName, blob] of Object.entries(gbufferBlobs)) {
    zip.file(`gbuffer/${passName}.mp4`, blob);
  }

  // Include panorama PNGs
  for (const [roomId, blob] of Object.entries(panoramaBlobs)) {
    zip.file(`panoramas/${roomId}.png`, blob);
  }

  const content = await zip.generateAsync({ type: 'blob' });
  const url = URL.createObjectURL(content);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${bundle.name.replace(/\s+/g, '_')}.zip`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── ZIP / SVG import ──

export type ImportResult =
  | { type: 'zip'; name: string; state: SceneState; svgText: string; meta: PlanMeta; gbufferBlobs: Record<string, Blob>; panoramaBlobs: Record<string, Blob> }
  | { type: 'svg'; name: string; svgText: string };

export function importFile(): Promise<ImportResult> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.zip,.svg';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return reject(new Error('No file selected'));

      const ext = file.name.split('.').pop()?.toLowerCase();

      if (ext === 'svg') {
        const text = await file.text();
        resolve({
          type: 'svg',
          name: file.name.replace(/\.svg$/i, ''),
          svgText: text,
        });
        return;
      }

      if (ext === 'zip') {
        try {
          const zip = await JSZip.loadAsync(file);

          const sessionFile = zip.file('session.json');
          const configFile = zip.file('config.json');
          const svgFile = zip.file('model.svg');

          if (!sessionFile || !configFile || !svgFile) {
            return reject(new Error('Invalid session zip: missing required files'));
          }

          const sessionData = JSON.parse(await sessionFile.async('text'));
          const configData = JSON.parse(await configFile.async('text'));
          const svgText = await svgFile.async('text');

          const meta: PlanMeta = {
            id: sessionData.state?.planId || file.name.replace(/\.zip$/i, ''),
            name: configData.name,
            scaleMetersPerUnit: configData.scaleMetersPerUnit,
            startRoom: configData.startRoom,
            outerPerimeter: configData.outerPerimeter || [],
          };

          // Extract g-buffer videos
          const blobs: Record<string, Blob> = {};
          const gbufferFolder = zip.folder('gbuffer');
          if (gbufferFolder) {
            const files = Object.keys(zip.files).filter(f => f.startsWith('gbuffer/') && f.endsWith('.mp4'));
            for (const fpath of files) {
              const passName = fpath.replace('gbuffer/', '').replace('.mp4', '');
              const data = await zip.file(fpath)!.async('arraybuffer');
              blobs[passName] = new Blob([data], { type: 'video/mp4' });
            }
          }

          // Extract panorama PNGs
          const panoBlobs: Record<string, Blob> = {};
          const panoFiles = Object.keys(zip.files).filter(f => f.startsWith('panoramas/') && f.endsWith('.png'));
          for (const fpath of panoFiles) {
            const roomId = fpath.replace('panoramas/', '').replace('.png', '');
            const data = await zip.file(fpath)!.async('arraybuffer');
            panoBlobs[roomId] = new Blob([data], { type: 'image/png' });
          }

          resolve({
            type: 'zip',
            name: sessionData.name || file.name.replace(/\.zip$/i, ''),
            state: sessionData.state,
            svgText,
            meta,
            gbufferBlobs: blobs,
            panoramaBlobs: panoBlobs,
          });
        } catch (e) {
          reject(new Error(`Failed to read zip: ${e}`));
        }
        return;
      }

      reject(new Error(`Unsupported file type: .${ext}`));
    };
    input.click();
  });
}

