import {
  listSessions, getSession,
  exportSessionZip, importFile,
  ImportResult, SessionRecord,
  setGBufferBlobs, clearGBufferBlobs,
  setPanoramaBlobs, clearPanoramaBlobs,
} from '../state/storage';

export interface PlanInfo {
  id: string;
  name: string;
}

export interface SessionPickerCallbacks {
  onSelectPreset: (planId: string) => void;
  onSelectSession: (session: SessionRecord) => void;
  onImportZip: (result: Extract<ImportResult, { type: 'zip' }>) => void;
  onImportSvg: (result: Extract<ImportResult, { type: 'svg' }>) => void;
}

export class SessionPicker {
  private selectEl: HTMLSelectElement;
  private presets: PlanInfo[];
  private callbacks: SessionPickerCallbacks;
  private currentSession: SessionRecord | null = null;

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

    downloadBtn.addEventListener('click', async () => {
      if (this.currentSession) {
        await exportSessionZip({
          name: this.currentSession.name,
          state: this.currentSession.state,
          svgText: this.currentSession.svgText,
          meta: this.currentSession.meta,
        });
      }
    });

    uploadBtn.addEventListener('click', async () => {
      try {
        const result = await importFile();
        if (result.type === 'zip') {
          // Restore g-buffer blobs from zip
          if (Object.keys(result.gbufferBlobs).length > 0) {
            setGBufferBlobs(result.gbufferBlobs);
          } else {
            clearGBufferBlobs();
          }
          // Restore panorama blobs from zip
          if (Object.keys(result.panoramaBlobs).length > 0) {
            setPanoramaBlobs(result.panoramaBlobs);
          } else {
            clearPanoramaBlobs();
          }
          this.callbacks.onImportZip(result);
        } else {
          // SVG upload — run parsing pipeline
          clearGBufferBlobs();
          clearPanoramaBlobs();
          this.callbacks.onImportSvg(result);
        }
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
    const sessions = listSessions();
    if (sessions.length > 0) {
      const sessionGroup = document.createElement('optgroup');
      sessionGroup.label = 'Saved Sessions';
      for (const s of sessions) {
        const opt = document.createElement('option');
        opt.value = `session:${s.id}`;
        opt.textContent = `${s.name} #${s.id}`;
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

  /** Update the picker's notion of which session is current (for download + display). */
  setActive(session: SessionRecord) {
    this.currentSession = session;
  }

  /** Programmatically select a value */
  setValue(value: string) {
    this.selectEl.value = value;
  }

  /** Update the preset list (called after manifest loads on boot). */
  setPresets(presets: PlanInfo[]) {
    this.presets = presets;
  }

  private onSelectionChange() {
    const val = this.selectEl.value;
    if (val.startsWith('preset:')) {
      const planId = val.slice('preset:'.length);
      this.callbacks.onSelectPreset(planId);
    } else if (val.startsWith('session:')) {
      const id = parseInt(val.slice('session:'.length), 10);
      const session = getSession(id);
      if (session) this.callbacks.onSelectSession(session);
    }
  }
}
