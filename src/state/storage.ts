import { SceneState } from './types';

const SESSIONS_KEY = 'archWalkthru_sessions';
const ACTIVE_KEY = 'archWalkthru_active';

// ── Session CRUD ──

function readAll(): Record<string, SceneState> {
  try {
    return JSON.parse(localStorage.getItem(SESSIONS_KEY) || '{}');
  } catch {
    return {};
  }
}

function writeAll(sessions: Record<string, SceneState>) {
  localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
}

export function listSessions(): string[] {
  return Object.keys(readAll());
}

export function getSession(name: string): SceneState | null {
  return readAll()[name] ?? null;
}

export function saveSession(name: string, state: SceneState): void {
  const all = readAll();
  all[name] = state;
  writeAll(all);
}

export function deleteSession(name: string): void {
  const all = readAll();
  delete all[name];
  writeAll(all);
}

export function renameSession(oldName: string, newName: string): void {
  const all = readAll();
  if (all[oldName]) {
    all[newName] = all[oldName];
    delete all[oldName];
    writeAll(all);
  }
}

// ── Active session tracking ──

export function getActiveSessionName(): string | null {
  return localStorage.getItem(ACTIVE_KEY);
}

export function setActiveSessionName(name: string): void {
  localStorage.setItem(ACTIVE_KEY, name);
}

// ── File export/import ──

export function exportSession(name: string, state: SceneState): void {
  const json = JSON.stringify({ name, state }, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name.replace(/\s+/g, '_')}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

export function importSessionFromFile(): Promise<{ name: string; state: SceneState }> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return reject(new Error('No file selected'));
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const data = JSON.parse(reader.result as string);
          // Support both wrapped format { name, state } and raw SceneState
          if (data.state && data.name) {
            resolve({ name: data.name, state: data.state });
          } else if (data.planId) {
            resolve({ name: file.name.replace('.json', ''), state: data });
          } else {
            reject(new Error('Unrecognized format'));
          }
        } catch {
          reject(new Error('Invalid JSON'));
        }
      };
      reader.readAsText(file);
    };
    input.click();
  });
}

// Clean up old single-key storage from previous version
localStorage.removeItem('archWalkthru_sceneState');
