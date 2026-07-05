/**
 * DLOSy20 - UI Components
 * Header + settings parameter controls, built on the param-control engine
 * (ui-study interaction patterns: rotary knobs, scrubbable numbers).
 *
 *  - Knobs (.knob: BPM / TEMPO / SWING / MASTER) use rotary dragging with an
 *    arc-arrow HUD, Alt=fine, double-click reset, and a scrubbable numeric
 *    readout underneath (drag to change, click to type).
 *  - The header BPM value is itself a scrubbable number.
 *  - Space = Play/Stop.
 *
 * State: `audioEngine.params` is the single source of truth — controls read
 * from it directly (no UI-side value cache, so preset auto-load can never
 * desync the display). After a preset load, audio-engine emits
 * 'params:changed' and every registered control re-renders.
 */
import { audioEngine } from './audio-engine';
import { on } from './events';
import {
  attachNumberScrub,
  attachRotaryKnob,
  initRangeEnhancer,
  ParamControl,
} from './param-control';
import { registerContextMenu } from './context-menu';

class UIComponents {
  // param name → controls to refresh when the value changes externally
  private refreshers: Record<string, ParamControl[]> = {};

  init() {
    initRangeEnhancer();
    this.initKnobs();
    this.initBpmDisplay();
    this.initKeyboardInput();
    this.initSliderContextMenu();
    // Preset auto-load (or any engine-side restore) → re-render every control.
    on('params:changed', () => this.refreshAll());
  }

  // ===== PARAM PLUMBING =====

  private getParam(param: string): number {
    return (audioEngine.params as any)[param] ?? 0;
  }

  private applyParam(param: string, v: number) {
    if (param === 'tempo') {
      audioEngine.params.tempo = v;
      const disp = document.getElementById('tempo-value');
      if (disp && !disp.classList.contains('editing')) {
        disp.textContent = String(Math.round(v));
      }
    } else {
      audioEngine.setParam(param, v);
    }
    this.refreshers[param]?.forEach(c => c.refresh());
  }

  private register(param: string, c: ParamControl) {
    (this.refreshers[param] ??= []).push(c);
  }

  refreshAll() {
    Object.entries(this.refreshers).forEach(([param, list]) => {
      list.forEach(c => c.refresh());
      if (param === 'tempo') {
        const disp = document.getElementById('tempo-value');
        if (disp && !disp.classList.contains('editing')) {
          disp.textContent = String(Math.round(this.getParam('tempo')));
        }
      }
    });
  }

  /** External tempo update (MIDI clock sync etc.) — keeps all UI in sync. */
  setTempo(bpm: number) {
    this.applyParam('tempo', bpm);
  }

  // ===== KNOBS (rotary) =====

  private initKnobs() {
    document.querySelectorAll<HTMLElement>('.knob').forEach(el => {
      const param = el.dataset.param ?? '';
      const min = parseFloat(el.dataset.min ?? '0');
      const max = parseFloat(el.dataset.max ?? '1');
      const initial = parseFloat(el.dataset.value ?? '0');

      const isPercent = max <= 1;         // masterVol → show 0-100%
      const step = isPercent ? 0.01 : 1;
      const toDisplay = (v: number) => (isPercent ? v * 100 : v);
      const fromDisplay = (v: number) => (isPercent ? v / 100 : v);

      const knobCtl = attachRotaryKnob(el, {
        get: () => this.getParam(param),
        set: (v) => this.applyParam(param, v),
        min, max, step,
        defaultValue: initial,
        format: (v) => String(Math.round(toDisplay(v))) + (isPercent ? '%' : ''),
      });
      this.register(param, knobCtl);

      // Scrubbable numeric readout below the knob (ui-study ParamField style).
      // Opt out with data-no-readout (e.g., the compact header BPM knob whose
      // value is already shown by the scrubbable BPM display).
      let readCtl: ParamControl | null = null;
      if (el.dataset.noReadout === undefined) {
        const group = el.closest('.knob-group, .master-vol-group');
        if (group) {
          const readout = document.createElement('div');
          readout.className = 'pc-readout';
          readout.dataset.param = param;
          el.insertAdjacentElement('afterend', readout); // knob → readout → label
          readCtl = attachNumberScrub(readout, {
            get: () => toDisplay(this.getParam(param)),
            set: (v) => this.applyParam(param, fromDisplay(v)),
            min: toDisplay(min),
            max: toDisplay(max),
            step: 1,
            unit: isPercent ? '%' : '',
          });
          this.register(param, readCtl);
        }
      }

      // Right-click menu on the knob (and its readout): reset / type a value.
      const menuItems = () => [
        {
          label: `デフォルトに戻す (${Math.round(toDisplay(initial))}${isPercent ? '%' : ''})`,
          action: () => this.applyParam(param, initial),
        },
        ...(readCtl?.edit ? [{ label: '値を入力…', action: () => readCtl!.edit!() }] : []),
      ];
      el.dataset.ctxLabel = param;
      registerContextMenu(`.knob[data-param="${param}"]`, menuItems);
      if (readCtl) registerContextMenu(`.pc-readout[data-param="${param}"]`, menuItems);
    });
  }

  // Generic "Enter value…" on any range slider (defaults vary, so no reset).
  private initSliderContextMenu() {
    registerContextMenu('input[type="range"]', (el) => {
      const input = el as HTMLInputElement;
      return [{
        label: '値を入力…',
        action: () => {
          const cur = input.value;
          const v = window.prompt('値:', cur);
          if (v === null) return;
          const n = parseFloat(v);
          if (isNaN(n)) return;
          const min = parseFloat(input.min || '0');
          const max = parseFloat(input.max || '100');
          input.value = String(Math.max(min, Math.min(max, n)));
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        },
      }];
    });
  }

  // ===== HEADER BPM =====

  private initBpmDisplay() {
    const el = document.getElementById('tempo-value');
    if (!el) return;
    const ctl = attachNumberScrub(el, {
      get: () => this.getParam('tempo'),
      set: (v) => this.applyParam('tempo', v),
      min: 40,
      max: 240,
      step: 1,
      perPixel: 0.5,
    });
    this.register('tempo', ctl);
    registerContextMenu('#tempo-value', () => [
      { label: 'デフォルトに戻す (120)', action: () => this.applyParam('tempo', 120) },
      { label: '値を入力…', action: () => ctl.edit?.() },
    ]);
  }

  // ===== TRANSPORT KEY =====

  private initKeyboardInput() {
    document.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement).closest('input, textarea, select')) return;
      // Space = play/stop
      if (e.key === ' ') {
        e.preventDefault();
        document.getElementById('btn-play')?.click();
      }
    });
  }
}

export const uiComponents = new UIComponents();
