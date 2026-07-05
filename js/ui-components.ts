/**
 * DLOSy20 - UI Components
 * Knob interactions + transport keyboard shortcut.
 *
 * The on-screen musical keyboard, wave/octave selectors and step-input handling
 * were removed together with the Step Sequencer / synth-voice UI. What remains
 * are the header/settings knobs (TEMPO / SWING / MASTER) and Space = Play/Stop.
 */
import { audioEngine } from './audio-engine';

interface KnobState {
  el: HTMLElement;
  min: number;
  max: number;
  value: number;
}

class UIComponents {
  knobs: Record<string, KnobState>;
  activeKnob: string | null;
  knobStartY: number;
  knobStartValue: number;

  constructor() {
    this.knobs = {};
    this.activeKnob = null;
    this.knobStartY = 0;
    this.knobStartValue = 0;
  }

  init() {
    this.initKnobs();
    this.initKeyboardInput();
  }

  // ===== KNOBS =====
  initKnobs() {
    document.querySelectorAll<HTMLElement>('.knob').forEach(el => {
      const param = el.dataset.param ?? "";
      const min = parseFloat(el.dataset.min ?? "");
      const max = parseFloat(el.dataset.max ?? "");
      const value = parseFloat(el.dataset.value ?? "");

      this.knobs[param] = { el, min, max, value };
      this.updateKnobVisual(el, min, max, value);

      el.addEventListener('mousedown', (e) => this.onKnobMouseDown(e, param));
      el.addEventListener('touchstart', (e) => this.onKnobTouchStart(e, param), { passive: false });
    });

    document.addEventListener('mousemove', (e) => this.onKnobMouseMove(e));
    document.addEventListener('mouseup', () => this.onKnobMouseUp());
    document.addEventListener('touchmove', (e) => this.onKnobTouchMove(e), { passive: false });
    document.addEventListener('touchend', () => this.onKnobMouseUp());
  }

  onKnobMouseDown(e: MouseEvent, param: string) {
    this.activeKnob = param;
    this.knobStartY = e.clientY;
    this.knobStartValue = this.knobs[param].value;
    e.preventDefault();
  }

  onKnobTouchStart(e: TouchEvent, param: string) {
    this.activeKnob = param;
    this.knobStartY = e.touches[0].clientY;
    this.knobStartValue = this.knobs[param].value;
    e.preventDefault();
  }

  onKnobMouseMove(e: MouseEvent) {
    if (!this.activeKnob) return;
    const knob = this.knobs[this.activeKnob];
    const deltaY = this.knobStartY - e.clientY;
    const range = knob.max - knob.min;
    const sensitivity = range / 150;
    let newValue = this.knobStartValue + deltaY * sensitivity;
    newValue = Math.max(knob.min, Math.min(knob.max, newValue));

    knob.value = newValue;
    this.updateKnobVisual(knob.el, knob.min, knob.max, newValue);
    this.applyKnob(this.activeKnob, newValue);
  }

  onKnobTouchMove(e: TouchEvent) {
    if (!this.activeKnob) return;
    e.preventDefault();
    const touch = e.touches[0];
    const knob = this.knobs[this.activeKnob];
    const deltaY = this.knobStartY - touch.clientY;
    const range = knob.max - knob.min;
    const sensitivity = range / 150;
    let newValue = this.knobStartValue + deltaY * sensitivity;
    newValue = Math.max(knob.min, Math.min(knob.max, newValue));

    knob.value = newValue;
    this.updateKnobVisual(knob.el, knob.min, knob.max, newValue);
    this.applyKnob(this.activeKnob, newValue);
  }

  applyKnob(param: string, newValue: number) {
    if (param === 'tempo') {
      audioEngine.params.tempo = newValue;
      const disp = document.getElementById('tempo-value');
      if (disp) disp.textContent = String(Math.round(newValue));
    } else {
      audioEngine.setParam(param, newValue);
    }
  }

  onKnobMouseUp() {
    this.activeKnob = null;
  }

  updateKnobVisual(el: HTMLElement, min: number, max: number, value: number) {
    const normalized = (value - min) / (max - min);
    const angle = -135 + normalized * 270; // -135° to +135°
    el.style.setProperty('--rotation', `${angle}deg`);
  }

  // ===== TRANSPORT KEY =====
  initKeyboardInput() {
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
