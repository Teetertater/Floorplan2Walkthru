import { listSessions, deleteSession, exportSession, getSession, importSessionFromFile, saveSession } from '../state/storage';
import { SceneState } from '../state/types';

export interface PlanInfo {
  id: string;
  name: string;
}

export interface SessionPickerCallbacks {
  onSelectPreset: (planId: string) => void;
  onSelectSession: (name: string, state: SceneState) => void;
  onImportSession: (name: string, state: SceneState) => void;
}

export class SessionPicker {
  private selectEl: HTMLSelectElement;
  private presets: PlanInfo[];
  private callbacks: SessionPickerCallbacks;
  private currentState: SceneState | null = null;
  private currentName: string = '';

  constructor(
    selectEl: HTMLSelectElement,
    downloadBtn: HTMLButtonElement,
    uploadBtn: HTMLButtonElement,
    presets: PlanInfo[],
    callbacks: SessionPickerCallbacks,
  ) {
    this.selectEl = selectEl;
    this.presets = presets;
    this.callbacks = callbacks;

    this.rebuild();

    selectEl.addEventListener('change', () => this.onSelectionChange());

    downloadBtn.addEventListener('click', () => {
      if (this.currentState && this.currentName) {
        exportSession(this.currentName, this.currentState);
      }
    });

    uploadBtn.addEventListener('click', async () => {
      try {
        const { name, state } = await importSessionFromFile();
        saveSession(name, state);
        this.callbacks.onImportSession(name, state);
        this.rebuild();
        this.selectEl.value = `session:${name}`;
      } catch (e) {
        console.warn('Import cancelled or failed:', e);
      }
    });
  }

  /** Rebuild the dropdown options */
  rebuild() {
    const el = this.selectEl;
    const currentValue = el.value;
    el.innerHTML = '';

    // Presets group
    const presetGroup = document.createElement('optgroup');
    presetGroup.label = 'Presets';
    for (const p of this.presets) {
      const opt = document.createElement('option');
      opt.value = `preset:${p.id}`;
      opt.textContent = p.name;
      presetGroup.appendChild(opt);
    }
    el.appendChild(presetGroup);

    // Saved sessions group
    const sessionNames = listSessions();
    if (sessionNames.length > 0) {
      const sessionGroup = document.createElement('optgroup');
      sessionGroup.label = 'Saved Sessions';
      for (const name of sessionNames) {
        const opt = document.createElement('option');
        opt.value = `session:${name}`;
        opt.textContent = name;
        sessionGroup.appendChild(opt);
      }
      el.appendChild(sessionGroup);
    }

    // Restore previous selection if still exists
    if (currentValue) {
      const exists = Array.from(el.options).some(o => o.value === currentValue);
      if (exists) el.value = currentValue;
    }
  }

  /** Set the active session (for display tracking + download) */
  setActive(name: string, state: SceneState) {
    this.currentName = name;
    this.currentState = state;
  }

  /** Programmatically select a value */
  setValue(value: string) {
    this.selectEl.value = value;
  }

  private onSelectionChange() {
    const val = this.selectEl.value;
    if (val.startsWith('preset:')) {
      const planId = val.slice('preset:'.length);
      this.callbacks.onSelectPreset(planId);
    } else if (val.startsWith('session:')) {
      const name = val.slice('session:'.length);
      const state = getSession(name);
      if (state) this.callbacks.onSelectSession(name, state);
    }
  }
}
