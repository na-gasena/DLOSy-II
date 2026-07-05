/**
 * DLOSy20 - Arpeggiator
 * L/R independent oscillators with arpeggiator patterns.
 * Based on Image-Oscillation-IV reference project.
 */
import { audioEngine } from './audio-engine';
import { drawingMode } from './drawing-mode';
import {
  evalCurve, hitHandlePx, dragHandle, resetHandleAtPx, drawHandles,
  segmentAtX, CPoint,
} from './curve-editor';

// Breakpoint with optional per-segment curvature (see curve-editor.ts)
type AdsrPoint = CPoint;

interface ProgressionDef {
  id: string;
  name: string;
  chords: [number, string][];
}

class Arpeggiator {
  enabled: boolean;
  baseFreq: number;
  ratio: number;
  octave: number;
  volume: number;
  // drawing モードでは BufferSource、通常は Oscillator と多態なので any 扱い
  oscL: any;
  oscR: any;
  gainL: GainNode | null;
  gainR: GainNode | null;
  panL: StereoPannerNode | null;
  panR: StereoPannerNode | null;
  isOscRunning: boolean;
  adsrCurve: AdsrPoint[];
  adsrCanvas: HTMLCanvasElement | null;
  adsrCtx2d: CanvasRenderingContext2D | null;
  adsrDragging: number | null;
  // Curvature-handle drag: segment index whose bend is being edited
  _adsrHandleDrag: number | null = null;
  // Segment whose handle is revealed on hover (null = none)
  _adsrHoverSeg: number | null = null;
  waveType: string;
  glitchSteps: number;
  tableSize: number;
  customTable: Float32Array;
  crushedTable: Float32Array;
  _lastDrawWave: { waveX: number[]; waveY: number[] | null } | null;
  _drawBaseF: number = 0;
  notesHeld: number[];
  arpIndex: number;
  pattern: string;
  div: number;
  arpDirection: number;
  latch: boolean;
  _currentMidi: number | null;
  _lastNote: number | null;
  _walkIdx: number;
  chordRoot: number;
  progression: [number, string][] | null;
  progId: string | null;
  progIndex: number;
  barsPerChord: number;
  _progTimerId: ReturnType<typeof setTimeout> | null;
  chordTypes: Record<string, number[]>;
  progressions: ProgressionDef[];
  _nextStepTime: number;
  _lookaheadId: ReturnType<typeof setInterval> | null;
  keyMap: Record<string, number>;
  keyStates: Record<string, boolean>;

  constructor() {
    this.enabled = true;

    // Frequency control
    this.baseFreq = 440;
    this.ratio = 1.0;
    this.octave = 0;
    this.volume = 0.3;

    // Persistent oscillator nodes (like the reference prototype)
    this.oscL = null;
    this.oscR = null;
    this.gainL = null;
    this.gainR = null;
    this.panL = null;
    this.panR = null;
    this.isOscRunning = false;

    // ADSR envelope curve (breakpoint editor)
    this.adsrCurve = [
      {x:0, y:0}, {x:0.05, y:1}, {x:0.2, y:0.6}, {x:0.8, y:0.6}, {x:1, y:0}
    ];
    this.adsrCanvas = null;
    this.adsrCtx2d = null;
    this.adsrDragging = null;

    // Wave type & Glitch
    this.waveType = 'sine'; // sine, triangle, square, sawtooth, drawing
    this.glitchSteps = 64;
    this.tableSize = 64;
    this.customTable = new Float32Array(64);
    this.crushedTable = new Float32Array(64);

    // Last non-empty drawing waveform, kept so a cleared/blank DRAW slot
    // keeps playing the previous sound instead of going silent.
    this._lastDrawWave = null;

    // Arpeggiator state
    this.notesHeld = [];   // MIDI note numbers currently held (in insertion order)
    this.arpIndex = 0;
    this.pattern = 'up';   // up, down, updown, updownInc, downup, converge, diverge, played, random, random2, walk
    this.div = 16;          // steps-per-bar relative: 1/4=4, 1/8=8, 1/16=16, 1/32=32 (any int allowed)
    this.arpDirection = 1;  // for updown pattern
    this.latch = false;     // when true, clicking/pressing a note toggles it (stays held)
    this._currentMidi = null; // currently sounding note (for playing highlight)
    this._lastNote = null;    // for random-no-repeat
    this._walkIdx = 0;        // for random-walk pattern

    // ===== Chords & chord-progression presets =====
    this.chordRoot = 60;      // root MIDI for chord presets (C4)
    this.progression = null;  // active progression: array of [semitoneOffset, type]
    this.progId = null;
    this.progIndex = 0;
    this.barsPerChord = 1;
    this._progTimerId = null;

    // Chord type → semitone offsets from root
    this.chordTypes = {
      maj:  [0, 4, 7],
      min:  [0, 3, 7],
      dim:  [0, 3, 6],
      aug:  [0, 4, 8],
      sus2: [0, 2, 7],
      sus4: [0, 5, 7],
      '6':  [0, 4, 7, 9],
      maj7: [0, 4, 7, 11],
      min7: [0, 3, 7, 10],
      dom7: [0, 4, 7, 10],
      m7b5: [0, 3, 6, 10],
      add9: [0, 4, 7, 14],
    };

    // Chord progression presets. Each chord = [semitoneOffset-from-key-root, type].
    // Key root = this.chordRoot, so progressions transpose with the root selector.
    this.progressions = [
      { id: 'I-V-vi-IV', name: 'I–V–vi–IV',   chords: [[0,'maj'],[7,'maj'],[9,'min'],[5,'maj']] },
      { id: '50s',       name: 'I–vi–IV–V',   chords: [[0,'maj'],[9,'min'],[5,'maj'],[7,'maj']] },
      { id: 'pop',       name: 'vi–IV–I–V',   chords: [[9,'min'],[5,'maj'],[0,'maj'],[7,'maj']] },
      { id: 'ii-V-I',    name: 'ii–V–I',      chords: [[2,'min7'],[7,'dom7'],[0,'maj7']] },
      { id: 'I-IV-V',    name: 'I–IV–V',      chords: [[0,'maj'],[5,'maj'],[7,'maj']] },
      { id: 'canon',     name: 'Canon',       chords: [[0,'maj'],[7,'maj'],[9,'min'],[4,'min'],[5,'maj'],[0,'maj'],[5,'maj'],[7,'maj']] },
      { id: 'andalusian',name: 'Andalusian',  chords: [[9,'min'],[7,'maj'],[5,'maj'],[4,'maj']] },
      { id: 'blues',     name: '12-bar Blues',chords: [[0,'dom7'],[0,'dom7'],[0,'dom7'],[0,'dom7'],[5,'dom7'],[5,'dom7'],[0,'dom7'],[0,'dom7'],[7,'dom7'],[5,'dom7'],[0,'dom7'],[7,'dom7']] },
    ];

    // Timing (lookahead scheduler)
    this._nextStepTime = 0;
    this._lookaheadId = null;

    // MIDI note mapping for keyboard (C4-B4)
    this.keyMap = {
      'a': 60, 'w': 61, 's': 62, 'e': 63, 'd': 64,
      'f': 65, 't': 66, 'g': 67, 'y': 68, 'h': 69,
      'u': 70, 'j': 71,
    };
    this.keyStates = {};

    // Generate default wave table
    this.setDefaultWave('sine');
  }

  init() {
    this.buildUI();
    this.bindKeyboard();
  }

  // ===== WAVE TABLE =====

  setDefaultWave(type: string) {
    const wasDrawing = this.waveType === 'drawing';
    this.waveType = type;
    if (type === 'drawing') {
      if (this.isOscRunning) this._refreshOscType();
      return;
    }
    for (let i = 0; i < this.tableSize; i++) {
      const t = i / (this.tableSize - 1);
      if (type === 'sine')          this.customTable[i] = Math.sin(2 * Math.PI * t);
      else if (type === 'triangle') this.customTable[i] = 1 - 4 * Math.abs(t - 0.5);
      else if (type === 'square')   this.customTable[i] = t < 0.5 ? 1 : -1;
      else if (type === 'sawtooth') this.customTable[i] = 2 * t - 1;
    }
    this.applyGlitch();
    if (wasDrawing && this.isOscRunning) this._refreshOscType();
  }

  applyGlitch() {
    const q = 2.0 / this.glitchSteps;
    for (let i = 0; i < this.tableSize; i++) {
      this.crushedTable[i] = Math.round(this.customTable[i] / q) * q;
    }
    // 実行中のオシレーターに即時反映（drawing 波形以外）
    if (this.isOscRunning && this.waveType !== 'drawing') {
      if (this.glitchSteps < 64) {
        const pw = this._createPeriodicWave();
        if (this.oscL?.setPeriodicWave) this.oscL.setPeriodicWave(pw);
        if (this.oscR?.setPeriodicWave) this.oscR.setPeriodicWave(pw);
      } else {
        if (this.oscL?.type !== undefined) this.oscL.type = this.waveType;
        if (this.oscR?.type !== undefined) this.oscR.type = this.waveType;
      }
    }
  }

  // ===== OSCILLATOR MANAGEMENT =====

  // Start persistent L/R oscillators (called when first key is pressed)
  startOsc() {
    if (this.isOscRunning) return;
    if (!audioEngine || !audioEngine.isInitialized) return;
    const ctx = audioEngine.ctx!;

    // Gain + Pan for L. Start silent — the per-step ADSR envelope drives the
    // gain from its first sample, so a non-zero initial value would jump down to
    // ~0 on the first step and click.
    this.gainL = ctx.createGain();
    this.gainL.gain.value = 0;
    this.panL = ctx.createStereoPanner();
    this.panL.pan.value = -1;
    this.gainL.connect(this.panL);
    this.panL!.connect(audioEngine.masterGain!);

    // Gain + Pan for R
    this.gainR = ctx.createGain();
    this.gainR.gain.value = 0;
    this.panR = ctx.createStereoPanner();
    this.panR.pan.value = 1;
    this.gainR.connect(this.panR);
    this.panR!.connect(audioEngine.masterGain!);

    this._createOscNodes();
    this.isOscRunning = true;
  }

  _createOscNodes() {
    const ctx = audioEngine.ctx!;

    if (this.waveType === 'drawing' && drawingMode) {
      const slot = drawingMode.slots[drawingMode.activeSlot];
      // Prefer the current slot; if it's blank, fall back to the last non-empty
      // waveform so a cleared / empty slot never produces silence.
      let waveX = (slot && slot.waveX && slot.waveX.length > 0) ? slot.waveX : null;
      let waveY = waveX ? slot.waveY : null;
      if (!waveX && this._lastDrawWave) {
        waveX = this._lastDrawWave.waveX;
        waveY = this._lastDrawWave.waveY;
      }
      if (waveX && waveX.length > 0) {
        const len = waveX.length;
        const bufferL = ctx.createBuffer(1, len, ctx.sampleRate);
        const bufferR = ctx.createBuffer(1, len, ctx.sampleRate);
        const lData = bufferL.getChannelData(0);
        const rData = bufferR.getChannelData(0);
        for (let i = 0; i < len; i++) {
          lData[i] = waveX[i] || 0;
          rData[i] = (waveY && waveY[i] !== undefined) ? waveY[i] : (waveX[i] || 0);
        }
        this.oscL = ctx.createBufferSource();
        this.oscR = ctx.createBufferSource();
        this.oscL.buffer = bufferL;
        this.oscR.buffer = bufferR;
        this.oscL.loop = true;
        this.oscR.loop = true;
        const baseF = ctx.sampleRate / len;
        this.oscL.playbackRate.value = this.baseFreq / baseF;
        this.oscR.playbackRate.value = (this.baseFreq * this.ratio) / baseF;
        this._drawBaseF = baseF;
        this._lastDrawWave = { waveX, waveY }; // remember for blank-slot fallback
      } else {
        // Nothing drawn anywhere yet → audible sine fallback (never null/silent)
        this.oscL = ctx.createOscillator();
        this.oscR = ctx.createOscillator();
        this.oscL.type = 'sine';
        this.oscR.type = 'sine';
        this.oscL.frequency.value = this.baseFreq;
        this.oscR.frequency.value = this.baseFreq * this.ratio;
      }
    } else {
      this.oscL = ctx.createOscillator();
      this.oscR = ctx.createOscillator();
      if (this.glitchSteps < 64) {
        const pw = this._createPeriodicWave();
        this.oscL.setPeriodicWave(pw);
        this.oscR.setPeriodicWave(pw);
      } else {
        this.oscL.type = this.waveType;
        this.oscR.type = this.waveType;
      }
      this.oscL.frequency.value = this.baseFreq;
      this.oscR.frequency.value = this.baseFreq * this.ratio;
    }

    this.oscL.connect(this.gainL);
    this.oscR.connect(this.gainR);
    this.oscL.start();
    this.oscR.start();
  }

  // Live-refresh the drawing-based oscillator buffer while the user edits the
  // DRAW canvas (called by drawing-mode on waveform change). Rebuilds the
  // BufferSource from the active slot so edits are heard in real time.
  refreshDrawingOsc() {
    if (!this.isOscRunning || this.waveType !== 'drawing') return;
    // If the active slot is blank (cleared, or switched to an empty slot),
    // keep the previous sound playing instead of rebuilding into silence.
    // A new stroke fills the slot again, at which point we rebuild.
    const slot = drawingMode && drawingMode.slots[drawingMode.activeSlot];
    if (!slot || !slot.waveX || slot.waveX.length === 0) return;
    this._refreshOscType();
  }

  // 実行中のオシレーターノードだけを再作成（gainL/gainR は保持）
  _refreshOscType() {
    if (!this.isOscRunning) return;
    try { this.oscL?.stop(); } catch(e) {}
    try { this.oscR?.stop(); } catch(e) {}
    try { this.oscL?.disconnect(); } catch(e) {}
    try { this.oscR?.disconnect(); } catch(e) {}
    this._createOscNodes();
  }

  stopOsc() {
    if (!this.isOscRunning) return;
    // Mark stopped immediately so the arp scheduler stops touching these nodes.
    this.isOscRunning = false;

    const ctx = audioEngine.ctx;
    const FADE = 0.012; // ~12ms release fade to avoid a note-off click

    const oscL = this.oscL, oscR = this.oscR;
    const gainL = this.gainL, gainR = this.gainR;
    const panL = this.panL, panR = this.panR;
    this.oscL = null; this.oscR = null;
    this.gainL = null; this.gainR = null;
    this.panL = null; this.panR = null;

    if (ctx && gainL && gainR) {
      const now = ctx.currentTime;
      // Cancel the pending per-step envelope and glide both channels to silence
      // before stopping, so the oscillators aren't cut mid-waveform.
      // Re-anchor at the current value explicitly rather than cancelAndHoldAtTime:
      // the VOL slider drives these gains with setTargetAtTime, and
      // cancelAndHoldAtTime after a setTargetAtTime is buggy in Chrome (it snaps to
      // the target, not the current value) → a note-off click.
      [gainL.gain, gainR.gain].forEach(g => {
        const current = g.value;
        g.cancelScheduledValues(now);
        g.setValueAtTime(current, now);
        g.linearRampToValueAtTime(0.0001, now + FADE);
      });
      try { oscL?.stop(now + FADE + 0.005); } catch(e) {}
      try { oscR?.stop(now + FADE + 0.005); } catch(e) {}
      setTimeout(() => {
        try { oscL?.disconnect(); } catch(e) {}
        try { oscR?.disconnect(); } catch(e) {}
        try { gainL.disconnect(); } catch(e) {}
        try { gainR.disconnect(); } catch(e) {}
        try { panL?.disconnect(); } catch(e) {}
        try { panR?.disconnect(); } catch(e) {}
      }, (FADE + 0.02) * 1000);
    } else {
      // No context/gain — fall back to immediate teardown.
      try { oscL?.stop(); } catch(e) {}
      try { oscR?.stop(); } catch(e) {}
      try { oscL?.disconnect(); } catch(e) {}
      try { oscR?.disconnect(); } catch(e) {}
      try { gainL?.disconnect(); } catch(e) {}
      try { gainR?.disconnect(); } catch(e) {}
      try { panL?.disconnect(); } catch(e) {}
      try { panR?.disconnect(); } catch(e) {}
    }
  }

  // Set base frequency and update running oscillators.
  // `atTime` (audio-clock seconds): when given, the pitch change is scheduled on
  // the audio grid instead of applied instantly — used by the arp step scheduler
  // so the new note's pitch lands exactly when its gain envelope opens (an
  // instant write fires the pitch up to 50ms early, mid-previous-note → click).
  setBaseFreq(f: number, atTime?: number) {
    this.baseFreq = f;
    if (!this.isOscRunning) return;
    if (this.waveType === 'drawing') {
      const baseF = this._drawBaseF || 261.63;
      if (this.oscL?.playbackRate) {
        if (atTime !== undefined) this.oscL.playbackRate.setValueAtTime(f / baseF, atTime);
        else this.oscL.playbackRate.value = f / baseF;
      }
      if (this.oscR?.playbackRate) {
        if (atTime !== undefined) this.oscR.playbackRate.setValueAtTime((f * this.ratio) / baseF, atTime);
        else this.oscR.playbackRate.value = (f * this.ratio) / baseF;
      }
    } else {
      if (this.oscL?.frequency) {
        if (atTime !== undefined) this.oscL.frequency.setValueAtTime(f, atTime);
        else this.oscL.frequency.value = f;
      }
      if (this.oscR?.frequency) {
        if (atTime !== undefined) this.oscR.frequency.setValueAtTime(f * this.ratio, atTime);
        else this.oscR.frequency.value = f * this.ratio;
      }
    }
  }

  // Called by arpeggiator on each step: change oscillator frequency to the note
  noteOn(midi: number, atTime?: number) {
    this._currentMidi = midi;
    const adjusted = midi + this.octave * 12;
    const f = 440 * Math.pow(2, (adjusted - 69) / 12);
    this.setBaseFreq(f, atTime);
  }

  _createPeriodicWave() {
    const ctx = audioEngine.ctx!;
    const N = this.tableSize;
    const H = N / 2;
    const real = new Float32Array(H);
    const imag = new Float32Array(H);
    for (let k = 1; k < H; k++) {
      let sr = 0, si = 0;
      for (let n = 0; n < N; n++) {
        const ph = 2 * Math.PI * k * n / N;
        sr += this.crushedTable[n] * Math.cos(ph);
        si += -this.crushedTable[n] * Math.sin(ph);
      }
      real[k] = sr / N;
      imag[k] = si / N;
    }
    return ctx.createPeriodicWave(real, imag, { disableNormalization: true });
  }

  // Apply ADSR curve to a gain AudioParam
  _applyAdsrCurve(gainParam: AudioParam, startTime: number, duration: number, maxVol: number) {
    const pts = this.adsrCurve;
    const numSamples = 16;
    for (let i = 0; i <= numSamples; i++) {
      const t = i / numSamples;
      const envVal = this._interpolateCurve(t);
      const val = Math.max(0.001, envVal * maxVol);
      const time = startTime + t * duration;
      if (i === 0) {
        gainParam.setValueAtTime(val, time);
      } else {
        gainParam.linearRampToValueAtTime(val, time);
      }
    }
  }

  _interpolateCurve(t: number) {
    // Piecewise interpolation with per-segment curvature (curve-editor.ts)
    return evalCurve(this.adsrCurve, t);
  }

  // ===== ARPEGGIATOR =====

  getNextNote(): number | null {
    if (this.notesHeld.length === 0) return null;
    const sorted = [...this.notesHeld].sort((a, b) => a - b);
    const n = sorted.length;

    // Stochastic families: handled directly (no fixed sequence)
    if (this.pattern === 'random') {
      return sorted[Math.floor(Math.random() * n)];
    }
    if (this.pattern === 'random2') {
      if (n === 1) return sorted[0];
      let note;
      do { note = sorted[Math.floor(Math.random() * n)]; } while (note === this._lastNote);
      this._lastNote = note;
      return note;
    }
    if (this.pattern === 'walk') {
      const step = Math.random() < 0.5 ? -1 : 1;
      this._walkIdx = Math.max(0, Math.min(n - 1, this._walkIdx + step));
      return sorted[this._walkIdx];
    }

    // Deterministic sequence-based families
    const seq = this._buildSequence(sorted);
    if (seq.length === 0) return null;
    const note = seq[this.arpIndex % seq.length];
    this.arpIndex = (this.arpIndex + 1) % seq.length;
    return note;
  }

  // Build the ordered note sequence for deterministic patterns
  _buildSequence(sorted: number[]): number[] {
    const n = sorted.length;
    if (n <= 1) return sorted;
    const rev = [...sorted].reverse();

    switch (this.pattern) {
      case 'up':         return sorted;
      case 'down':       return rev;
      case 'updown':     return sorted.concat(rev.slice(1, -1)); // exclusive endpoints: 0..n-1,n-2..1
      case 'updownInc':  return sorted.concat(rev);              // inclusive endpoints: 0..n-1,n-1..0
      case 'downup':     return rev.concat(sorted.slice(1, -1)); // n-1..0,1..n-2
      case 'converge': { // outside-in: lo, hi, lo+1, hi-1, ...
        const out = []; let lo = 0, hi = n - 1;
        while (lo <= hi) { out.push(sorted[lo]); if (lo !== hi) out.push(sorted[hi]); lo++; hi--; }
        return out;
      }
      case 'diverge': {  // inside-out: reverse of converge
        const out = []; let lo = 0, hi = n - 1;
        while (lo <= hi) { out.push(sorted[lo]); if (lo !== hi) out.push(sorted[hi]); lo++; hi--; }
        return out.reverse();
      }
      case 'played':     return [...this.notesHeld]; // as-played (insertion order)
      default:           return sorted;
    }
  }

  startArp() {
    this.stopArp();
    if (!audioEngine || !audioEngine.ctx) return;
    // Schedule the first step a bit AHEAD of the clock (> the 25ms lookahead
    // interval). The first interval callback fires ~25ms later, so if we started
    // at currentTime the first step would already be in the past — its envelope
    // attack would be skipped and the gain would jump from 0 to mid-envelope,
    // clicking on the very first note. The headroom lets the full attack (from 0)
    // be scheduled in the future for a clean note onset.
    this._nextStepTime = audioEngine.ctx.currentTime + 0.05;
    this._lookaheadId = setInterval(() => this._arpLookahead(), 25);
  }

  stopArp() {
    if (this._lookaheadId) {
      clearInterval(this._lookaheadId);
      this._lookaheadId = null;
    }
  }

  _arpLookahead() {
    if (!this.enabled || this.notesHeld.length === 0) return;
    if (!audioEngine || !audioEngine.ctx) return;

    const bpm = audioEngine.params.tempo || 120;
    const stepDur = 60 / bpm / (this.div / 4); // seconds per arp step

    const SCHEDULE_AHEAD = document.hidden ? 2.0 : 0.05;
    const now = audioEngine.ctx.currentTime;
    if (this._nextStepTime < now - 0.5) this._nextStepTime = now;
    while (this._nextStepTime < now + SCHEDULE_AHEAD) {
      const note = this.getNextNote();
      if (note !== null) {
        // Schedule the pitch change at the step's audio time so it coincides
        // with the gain envelope opening (avoids an early, audible pitch glitch).
        this.noteOn(note, this._nextStepTime);
        // ADSR エンベロープをゲインに適用
        if (this.gainL && this.gainR) {
          this._applyAdsrCurve(this.gainL.gain, this._nextStepTime, stepDur, this.volume);
          this._applyAdsrCurve(this.gainR.gain, this._nextStepTime, stepDur, this.volume);
        }
      }
      this._nextStepTime += stepDur;
      this.updateKeyHighlights();
    }
  }

  // ===== KEYBOARD INPUT =====

  bindKeyboard() {
    document.addEventListener('keydown', (e) => {
      if (!this.enabled) return;
      // Only process when ARP tab is active
      const arpTab = document.getElementById('center-tab-arp');
      if (!arpTab || !arpTab.classList.contains('active')) return;
      // Allow keys even when ARP sliders have focus (but block for text inputs)
      const tgt = e.target as HTMLElement;
      if (tgt.closest('textarea, select') || (tgt.tagName === 'INPUT' && (tgt as HTMLInputElement).type === 'text')) return;
      const midi = this.keyMap[e.key.toLowerCase()];
      if (midi !== undefined && !this.keyStates[e.key.toLowerCase()]) {
        e.preventDefault();
        this.keyStates[e.key.toLowerCase()] = true;
        if (this.latch) this.toggleNote(midi);
        else this.addNote(midi);
      }
    });

    document.addEventListener('keyup', (e) => {
      if (!this.enabled) return;
      const midi = this.keyMap[e.key.toLowerCase()];
      if (midi !== undefined) {
        this.keyStates[e.key.toLowerCase()] = false;
        // In latch mode the note stays held until toggled off again
        if (!this.latch) this.removeNote(midi);
      }
    });
  }

  addNote(midi: number) {
    if (!this.notesHeld.includes(midi)) {
      this.notesHeld.push(midi);
      this.arpIndex = 0;
      this._walkIdx = 0;
      if (this.notesHeld.length === 1) {
        this.startOsc();
        this.startArp();
      }
      this.updateKeyHighlights();
    }
  }

  removeNote(midi: number) {
    this.notesHeld = this.notesHeld.filter(n => n !== midi);
    this.arpIndex = 0;
    this._walkIdx = 0;
    if (this.notesHeld.length === 0) {
      this.stopArp();
      this.stopOsc();
      this._currentMidi = null;
    }
    this.updateKeyHighlights();
  }

  // Latch mode: clicking/pressing a note toggles it on/off
  toggleNote(midi: number) {
    if (this.notesHeld.includes(midi)) {
      this.removeNote(midi);
    } else {
      this.addNote(midi);
    }
  }

  // Release every held note (used by CLEAR / leaving latch)
  clearNotes() {
    this.stopProgression();
    this.notesHeld = [];
    this.arpIndex = 0;
    this._walkIdx = 0;
    this.stopArp();
    this.stopOsc();
    this._currentMidi = null;
    this._setChordLabel('');
    this._highlightProgStep();
    this.updateKeyHighlights();
  }

  setLatch(on: boolean) {
    this.latch = on;
    // Leaving latch releases any sustained notes so they don't stick forever
    if (!on) this.clearNotes();
    const btn = document.getElementById('arp-latch-btn');
    if (btn) btn.classList.toggle('active', on);
  }

  // Set division and keep preset buttons + custom number input in sync
  setDiv(div: number) {
    this.div = div;
    document.querySelectorAll<HTMLElement>('.arp-div-btn').forEach(b => {
      b.classList.toggle('active', parseInt(b.dataset.div ?? "0", 10) === div);
    });
    const input = document.getElementById('arp-div-input') as HTMLInputElement | null;
    if (input && parseInt(input.value, 10) !== div) input.value = String(div);
  }

  // ===== CHORDS & PROGRESSIONS =====

  // Replace the held set with a chord and HOLD it (latch on)
  applyChordNotes(notes: number[]) {
    this.notesHeld = [...new Set(notes)].sort((a, b) => a - b);
    this.arpIndex = 0;
    this._walkIdx = 0;
    this._lastNote = null;
    this.latch = true;
    const lb = document.getElementById('arp-latch-btn');
    if (lb) lb.classList.add('active');
    if (this.notesHeld.length > 0) {
      this.startOsc();
      this.startArp();
    }
    this.updateKeyHighlights();
  }

  // Latch a single chord preset using the current root (stops any progression)
  latchChord(type: string) {
    const offsets = this.chordTypes[type];
    if (!offsets) return;
    this.stopProgression();
    this.applyChordNotes(offsets.map(o => this.chordRoot + o));
    this._setChordLabel(this._noteName(this.chordRoot) + ' ' + type);
  }

  setChordRoot(midi: number) {
    this.chordRoot = midi;
    // If a progression is running, restart it on the new root
    if (this.progression) this.startProgression(this.progId);
  }

  startProgression(id: string | null) {
    const prog = this.progressions.find(p => p.id === id);
    this._clearProgTimer();
    if (!prog) { this.progression = null; this.progId = null; return; }
    this.progression = prog.chords;
    this.progId = id;
    this.progIndex = 0;
    this._applyProgChord();
    this._scheduleProgAdvance();
  }

  stopProgression() {
    this._clearProgTimer();
    this.progression = null;
    this.progId = null;
    const sel = document.getElementById('arp-prog-select') as HTMLSelectElement | null;
    if (sel) sel.value = '';
  }

  _applyProgChord() {
    if (!this.progression || this.progression.length === 0) return;
    const [offset, type] = this.progression[this.progIndex % this.progression.length];
    const offsets = this.chordTypes[type] || [0, 4, 7];
    const root = this.chordRoot + offset;
    this.applyChordNotes(offsets.map(o => root + o));
    this._setChordLabel(this._noteName(root) + ' ' + type + '  (' +
      ((this.progIndex % this.progression.length) + 1) + '/' + this.progression.length + ')');
    this._highlightProgStep();
  }

  // Bar-synced auto-advance via a self-rescheduling timer (recomputes duration
  // each step so tempo / bars-per-chord changes are picked up; decoupled from
  // the arp lookahead so it never bursts when the tab is backgrounded).
  _scheduleProgAdvance() {
    this._clearProgTimer();
    const bpm = (audioEngine && audioEngine.params.tempo) ? audioEngine.params.tempo : 120;
    const barDur = (60 / bpm) * 4 * this.barsPerChord; // seconds for one chord
    this._progTimerId = setTimeout(() => {
      if (!this.progression) return;
      this.progIndex = (this.progIndex + 1) % this.progression.length;
      this._applyProgChord();
      this._scheduleProgAdvance();
    }, barDur * 1000);
  }

  _clearProgTimer() {
    if (this._progTimerId) { clearTimeout(this._progTimerId); this._progTimerId = null; }
  }

  _noteName(midi: number) {
    const names = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
    return names[midi % 12] + (Math.floor(midi / 12) - 1);
  }

  _setChordLabel(text: string) {
    const el = document.getElementById('arp-chord-label');
    if (el) el.textContent = text;
  }

  _highlightProgStep() {
    document.querySelectorAll('.arp-prog-step').forEach((el, i) => {
      el.classList.toggle("active", !!(this.progression && i === (this.progIndex % this.progression.length)));
    });
  }

  // Render a small dot per chord in the chosen progression
  _buildProgSteps(id: string) {
    const wrap = document.getElementById('arp-prog-steps');
    if (!wrap) return;
    const prog = this.progressions.find(p => p.id === id);
    if (!prog) { wrap.innerHTML = ''; return; }
    wrap.innerHTML = prog.chords.map((c, i) =>
      `<span class="arp-prog-step" title="${this._noteName(this.chordRoot + c[0])} ${c[1]}">${i + 1}</span>`).join('');
  }

  // ===== UI =====

  buildUI() {
    const container = document.getElementById('center-tab-arp');
    if (!container) return;

    container.innerHTML = `
      <div class="panel-title">ARPEGGIATOR</div>
      <div class="arp-controls">
        <div class="arp-row arp-mode-row">
          <span class="arp-group-label">MODE</span>
          <button class="small-btn arp-pattern-btn active" data-pattern="up" title="Up">UP</button>
          <button class="small-btn arp-pattern-btn" data-pattern="down" title="Down">DN</button>
          <button class="small-btn arp-pattern-btn" data-pattern="updown" title="Up-Down (exclusive ends)">UD</button>
          <button class="small-btn arp-pattern-btn" data-pattern="updownInc" title="Up-Down (inclusive ends)">UD+</button>
          <button class="small-btn arp-pattern-btn" data-pattern="downup" title="Down-Up">DU</button>
          <button class="small-btn arp-pattern-btn" data-pattern="converge" title="Converge (outside-in)">CNV</button>
          <button class="small-btn arp-pattern-btn" data-pattern="diverge" title="Diverge (inside-out)">DVG</button>
          <button class="small-btn arp-pattern-btn" data-pattern="played" title="As played">PLY</button>
          <button class="small-btn arp-pattern-btn" data-pattern="random" title="Random">RND</button>
          <button class="small-btn arp-pattern-btn" data-pattern="random2" title="Random (no repeat)">R≠</button>
          <button class="small-btn arp-pattern-btn" data-pattern="walk" title="Random walk">RWK</button>
        </div>
        <div class="arp-row arp-div-row">
          <span class="arp-group-label">DIV</span>
          <button class="small-btn arp-div-btn" data-div="2">1/2</button>
          <button class="small-btn arp-div-btn" data-div="4">1/4</button>
          <button class="small-btn arp-div-btn" data-div="8">1/8</button>
          <button class="small-btn arp-div-btn" data-div="12">1/8T</button>
          <button class="small-btn arp-div-btn active" data-div="16">1/16</button>
          <button class="small-btn arp-div-btn" data-div="24">1/16T</button>
          <button class="small-btn arp-div-btn" data-div="32">1/32</button>
          <input type="number" id="arp-div-input" class="arp-div-input" min="1" max="64" step="1" value="16" title="Custom division (steps per bar relative)">
        </div>
        <div class="arp-row arp-latch-row">
          <span class="arp-group-label">HOLD</span>
          <button id="arp-latch-btn" class="small-btn arp-latch-btn" title="Latch: click notes to fix them">LATCH</button>
          <button id="arp-clear-btn" class="small-btn" title="Release all held notes">CLEAR</button>
        </div>

        <div class="arp-row arp-chord-row">
          <span class="arp-group-label">CHORD</span>
          <select id="arp-chord-root" class="arp-sel" title="Chord root">
            ${['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'].map((nm,i) =>
              `<option value="${60+i}"${i===0?' selected':''}>${nm}</option>`).join('')}
          </select>
          ${Object.keys(this.chordTypes).map(t =>
            `<button class="small-btn arp-chord-btn" data-chord="${t}">${t}</button>`).join('')}
        </div>

        <div class="arp-row arp-prog-row">
          <span class="arp-group-label">PROG</span>
          <select id="arp-prog-select" class="arp-sel" title="Chord progression preset">
            <option value="">— none —</option>
            ${this.progressions.map(p => `<option value="${p.id}">${p.name}</option>`).join('')}
          </select>
          <span class="arp-group-label arp-bars-label">BARS</span>
          <select id="arp-prog-bars" class="arp-sel arp-sel-sm" title="Bars per chord">
            <option value="1" selected>1</option>
            <option value="2">2</option>
            <option value="4">4</option>
          </select>
          <button id="arp-prog-stop" class="small-btn" title="Stop progression (keep current chord)">■</button>
        </div>
        <div class="arp-row arp-chord-status-row">
          <div class="arp-prog-steps" id="arp-prog-steps"></div>
          <span id="arp-chord-label" class="arp-chord-label"></span>
        </div>
        <div class="arp-row">
          <span class="arp-group-label">WAVE</span>
          <button class="small-btn arp-wave-btn active" data-wave="sine">SIN</button>
          <button class="small-btn arp-wave-btn" data-wave="triangle">TRI</button>
          <button class="small-btn arp-wave-btn" data-wave="square">SQR</button>
          <button class="small-btn arp-wave-btn" data-wave="sawtooth">SAW</button>
          <button class="small-btn arp-wave-btn" data-wave="drawing">DRAW</button>
        </div>

        <div class="arp-adsr-editor">
          <span class="cv-label">ENVELOPE</span>
          <canvas id="arp-adsr-canvas" width="300" height="80"></canvas>
          <button id="arp-adsr-reset" class="small-btn">RESET</button>
        </div>

        <div class="arp-keys" id="arp-keys">
          <!-- Generated by JS -->
        </div>

        <div class="arp-knobs-row">
          <div class="arp-knob-group">
            <span class="cv-label">FREQ</span>
            <input type="range" id="arp-freq-slider" min="0" max="1000" value="690" class="fx-slider" data-midi-target="arpFreq">
            <span id="arp-freq-val" class="cv-val">440Hz</span>
          </div>
          <div class="arp-knob-group">
            <span class="cv-label">RATIO</span>
            <input type="range" id="arp-ratio-slider" min="10" max="400" value="100" class="fx-slider" data-midi-target="arpRatio">
            <span id="arp-ratio-val" class="cv-val">1.00</span>
          </div>
          <div class="arp-knob-group">
            <span class="cv-label">GLITCH</span>
            <input type="range" id="arp-glitch-slider" min="4" max="64" value="64" class="fx-slider" data-midi-target="arpGlitch">
            <span id="arp-glitch-val" class="cv-val">64</span>
          </div>
          <div class="arp-knob-group">
            <span class="cv-label">VOL</span>
            <input type="range" id="arp-vol-slider" min="0" max="100" value="30" class="fx-slider" data-midi-target="arpVol">
            <span id="arp-vol-val" class="cv-val">30%</span>
          </div>
        </div>

        <div class="arp-row">
          <span class="arp-group-label">OCT</span>
          <button id="arp-oct-down" class="small-btn">−</button>
          <span id="arp-oct-val" class="cv-val">0</span>
          <button id="arp-oct-up" class="small-btn">+</button>
        </div>
      </div>
    `;

    this.buildKeys();
    this.bindUIEvents();
  }

  buildKeys() {
    const container = document.getElementById('arp-keys');
    if (!container) return;

    const noteNames = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
    const isBlack = [0,1,0,1,0,0,1,0,1,0,1,0];
    const keyChars = ['A','W','S','E','D','F','T','G','Y','H','U','J'];

    container.innerHTML = '';
    for (let i = 0; i < 12; i++) {
      const midi = 60 + i;
      const key = document.createElement('div');
      key.className = 'arp-key' + (isBlack[i] ? ' black' : ' white');
      key.dataset.midi = String(midi);
      key.innerHTML = `<span class="arp-key-note">${noteNames[i]}</span><span class="arp-key-label">${keyChars[i]}</span>`;

      // Latch: click toggles (note stays fixed). Momentary: hold while pressed.
      key.addEventListener('mousedown', (e) => {
        if (!this.enabled) return;
        e.preventDefault();
        if (this.latch) this.toggleNote(midi);
        else this.addNote(midi);
      });
      key.addEventListener('mouseup', () => {
        if (this.enabled && !this.latch) this.removeNote(midi);
      });
      key.addEventListener('mouseleave', () => {
        if (this.enabled && !this.latch) this.removeNote(midi);
      });
      container.appendChild(key);
    }
  }

  updateKeyHighlights() {
    document.querySelectorAll<HTMLElement>('.arp-key').forEach(key => {
      const midi = parseInt(key.dataset.midi ?? "0");
      key.classList.toggle('held', this.notesHeld.includes(midi));
      key.classList.toggle('playing', this.notesHeld.length > 0 && midi === this._currentMidi);
    });
  }

  bindUIEvents() {
    // Pattern buttons
    document.querySelectorAll<HTMLElement>('.arp-pattern-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.arp-pattern-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.pattern = btn.dataset.pattern ?? this.pattern;
        this.arpIndex = 0;
        this._walkIdx = 0;
        this._lastNote = null;
      });
    });

    // DIV preset buttons (also reflect into the custom number input)
    document.querySelectorAll<HTMLElement>('.arp-div-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this.setDiv(parseInt(btn.dataset.div ?? "0", 10));
      });
    });

    // DIV custom number input (any division)
    document.getElementById('arp-div-input')?.addEventListener('input', (e) => {
      let v = parseInt((e.target as HTMLInputElement).value, 10);
      if (isNaN(v)) return;
      v = Math.max(1, Math.min(64, v));
      this.setDiv(v);
    });

    // LATCH toggle + CLEAR
    document.getElementById('arp-latch-btn')?.addEventListener('click', () => {
      this.setLatch(!this.latch);
    });
    document.getElementById('arp-clear-btn')?.addEventListener('click', () => {
      this.clearNotes();
    });

    // Chord root + chord-type presets
    document.getElementById('arp-chord-root')?.addEventListener('change', (e) => {
      this.setChordRoot(parseInt((e.target as HTMLSelectElement).value, 10));
    });
    document.querySelectorAll<HTMLElement>('.arp-chord-btn').forEach(btn => {
      btn.addEventListener('click', () => this.latchChord(btn.dataset.chord ?? ""));
    });

    // Progression preset select + bars + stop
    document.getElementById('arp-prog-select')?.addEventListener('change', (e) => {
      const id = (e.target as HTMLSelectElement).value;
      this._buildProgSteps(id);
      if (id) this.startProgression(id);
      else this.stopProgression();
    });
    document.getElementById('arp-prog-bars')?.addEventListener('change', (e) => {
      this.barsPerChord = parseInt((e.target as HTMLSelectElement).value, 10) || 1;
      // Re-arm timer with the new bar length if running
      if (this.progression) this._scheduleProgAdvance();
    });
    document.getElementById('arp-prog-stop')?.addEventListener('click', () => {
      // Stop advancing but keep the current chord held
      this.stopProgression();
      this._highlightProgStep();
    });

    // Wave buttons
    document.querySelectorAll<HTMLElement>('.arp-wave-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.arp-wave-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.setDefaultWave(btn.dataset.wave ?? "sine");
      });
    });

    // Freq slider (logarithmic: 20Hz - 8000Hz)
    document.getElementById('arp-freq-slider')?.addEventListener('input', (e) => {
      const val = parseFloat((e.target as HTMLInputElement).value) / 1000;
      const f = 20 * Math.pow(400, val);
      this.setBaseFreq(f);
      const el = document.getElementById('arp-freq-val');
      if (el) el.textContent = Math.round(f) + 'Hz';
    });

    // Ratio slider
    document.getElementById('arp-ratio-slider')?.addEventListener('input', (e) => {
      let r = parseFloat((e.target as HTMLInputElement).value) / 100;
      const nearest = Math.round(r);
      if (Math.abs(r - nearest) < 0.05) r = nearest;
      this.ratio = Math.round(r * 100) / 100;
      const el = document.getElementById('arp-ratio-val');
      if (el) el.textContent = this.ratio.toFixed(2);
    });

    // Glitch slider
    document.getElementById('arp-glitch-slider')?.addEventListener('input', (e) => {
      this.glitchSteps = parseInt((e.target as HTMLInputElement).value);
      const gv = document.getElementById('arp-glitch-val');
      if (gv) gv.textContent = String(this.glitchSteps);
      this.applyGlitch();
    });

    // Volume slider
    document.getElementById('arp-vol-slider')?.addEventListener('input', (e) => {
      const val = parseInt((e.target as HTMLInputElement).value);
      this.volume = val / 100;
      const vv = document.getElementById('arp-vol-val');
      if (vv) vv.textContent = val + '%';
      // 演奏中のゲインをリアルタイム更新（瞬間書き換えはクリックになるので平滑化。
      // 次ステップの ADSR が this.volume を取り込んで上書きするため一時的なグライド）
      const t = audioEngine.ctx ? audioEngine.ctx.currentTime : 0;
      if (this.gainL) this.gainL.gain.setTargetAtTime(this.volume, t, 0.02);
      if (this.gainR) this.gainR.gain.setTargetAtTime(this.volume, t, 0.02);
    });

    // ADSR envelope editor (canvas)
    this.adsrCanvas = document.getElementById('arp-adsr-canvas') as HTMLCanvasElement | null;
    if (this.adsrCanvas) {
      this.adsrCtx2d = this.adsrCanvas!.getContext('2d');
      this.adsrCanvas!.addEventListener('mousedown', (e) => this._adsrMouseDown(e));
      this.adsrCanvas!.addEventListener('mousemove', (e) => this._adsrMouseMove(e));
      this.adsrCanvas!.addEventListener('mouseup', () => { this.adsrDragging = null; this._adsrHandleDrag = null; });
      this.adsrCanvas!.addEventListener('mouseleave', () => {
        this.adsrDragging = null; this._adsrHandleDrag = null;
        if (this._adsrHoverSeg !== null) { this._adsrHoverSeg = null; this.drawAdsrCurve(); }
      });
      this.adsrCanvas!.addEventListener('dblclick', (e) => this._adsrDblClick(e));
      // Right-click = delete point (unified across all curve editors)
      this.adsrCanvas!.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this._adsrDblClick(e);
      });
      // Redraw whenever the canvas is (re)laid out — this also covers the tab /
      // panel becoming visible after starting hidden (display:none gives the
      // canvas a 0×0 rect, so the initial draw can't size the bitmap; without
      // this the 300×80 attribute bitmap got stretched to the flex width).
      if (window.ResizeObserver) {
        new ResizeObserver(() => this.drawAdsrCurve())
          .observe(this.adsrCanvas!);
      }
      this.drawAdsrCurve();
    }

    // ADSR reset
    document.getElementById('arp-adsr-reset')?.addEventListener('click', () => {
      this.adsrCurve = [
        {x:0, y:0}, {x:0.05, y:1}, {x:0.2, y:0.6}, {x:0.8, y:0.6}, {x:1, y:0}
      ];
      this.drawAdsrCurve();
    });

    // Octave buttons
    document.getElementById('arp-oct-down')?.addEventListener('click', () => {
      this.octave = Math.max(-3, this.octave - 1);
      const ov = document.getElementById('arp-oct-val');
      if (ov) ov.textContent = String(this.octave);
    });
    document.getElementById('arp-oct-up')?.addEventListener('click', () => {
      this.octave = Math.min(3, this.octave + 1);
      const ov = document.getElementById('arp-oct-val');
      if (ov) ov.textContent = String(this.octave);
    });
  }

  // ===== ADSR Envelope Canvas =====

  drawAdsrCurve() {
    if (!this.adsrCanvas || !this.adsrCtx2d) return;
    const ctx = this.adsrCtx2d!;

    // Sync internal resolution to CSS display size × devicePixelRatio.
    // Hidden (display:none) → rect is 0×0: skip entirely; the ResizeObserver
    // re-invokes this once the canvas is actually laid out.
    const dpr = window.devicePixelRatio || 1;
    const rect = this.adsrCanvas!.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const cw = Math.round(rect.width * dpr);
    const ch = Math.round(rect.height * dpr);
    if (this.adsrCanvas!.width !== cw || this.adsrCanvas!.height !== ch) {
      this.adsrCanvas!.width = cw;
      this.adsrCanvas!.height = ch;
    }
    // Absolute transform each frame (never rely on stateful ctx.scale): all
    // drawing below is in CSS-pixel coordinates.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w = rect.width;
    const h = rect.height;

    ctx.clearRect(0, 0, w, h);

    // Background
    ctx.fillStyle = '#101116';
    ctx.fillRect(0, 0, w, h);

    // Grid lines
    ctx.strokeStyle = '#22242c';
    ctx.lineWidth = 0.5;
    for (let i = 0; i <= 4; i++) {
      const y = (i / 4) * h;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }

    // Curve — sampled per pixel so per-segment curvature renders correctly
    const pts = this.adsrCurve;
    if (pts.length < 2) return;

    const steps = Math.max(Math.round(w), 64);
    ctx.strokeStyle = '#3ddc84';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const px = t * w;
      const py = (1 - evalCurve(pts, t)) * h;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();

    // Fill under curve
    ctx.globalAlpha = 0.1;
    ctx.fillStyle = '#3ddc84';
    ctx.lineTo(w, h);
    ctx.lineTo(0, h);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1.0;

    // Curvature handles — revealed on hover / drag; subtle hint on bent ones
    drawHandles(ctx, pts, (x) => x * w, (y) => (1 - y) * h,
      { activeSeg: this._adsrHandleDrag ?? this._adsrHoverSeg, size: 3.5 });

    // Points
    pts.forEach(p => {
      const px = p.x * w;
      const py = (1 - p.y) * h;
      ctx.fillStyle = '#3ddc84';
      ctx.beginPath();
      ctx.arc(px, py, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1;
      ctx.stroke();
    });
  }

  _adsrMousePos(e: MouseEvent) {
    const rect = this.adsrCanvas!.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, 1 - (e.clientY - rect.top) / rect.height))
    };
  }

  _adsrMouseDown(e: MouseEvent) {
    const pos = this._adsrMousePos(e);
    // Hit-test in CSS pixels (rect), NOT the DPR-scaled bitmap size
    const rect = this.adsrCanvas!.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;

    // Curvature handle first (it sits on the curve between points).
    const seg = hitHandlePx(this.adsrCurve, pos, w, h);
    if (seg >= 0) {
      this._adsrHandleDrag = seg;
      return;
    }

    // Find nearest point
    let nearIdx = -1;
    let nearDist = Infinity;
    this.adsrCurve.forEach((p, i) => {
      const dx = (p.x - pos.x) * w;
      const dy = (p.y - pos.y) * h;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 12 && dist < nearDist) {
        nearDist = dist;
        nearIdx = i;
      }
    });

    if (nearIdx >= 0) {
      this.adsrDragging = nearIdx;
    } else {
      // Add new point
      let insertIdx = 0;
      for (let i = 0; i < this.adsrCurve.length; i++) {
        if (this.adsrCurve[i].x < pos.x) insertIdx = i + 1;
      }
      this.adsrCurve.splice(insertIdx, 0, {x: pos.x, y: pos.y});
      this.adsrDragging = insertIdx;
      this.drawAdsrCurve();
    }
  }

  _adsrMouseMove(e: MouseEvent) {
    // Curvature-handle drag: bend the segment through the cursor
    if (this._adsrHandleDrag !== null) {
      dragHandle(this.adsrCurve, this._adsrHandleDrag, this._adsrMousePos(e).y, e.altKey);
      this.drawAdsrCurve();
      return;
    }

    if (this.adsrDragging === null) {
      // Hover reveal: show the handle only for the segment under the cursor
      const seg = segmentAtX(this.adsrCurve, this._adsrMousePos(e).x);
      if (seg !== this._adsrHoverSeg) { this._adsrHoverSeg = seg; this.drawAdsrCurve(); }
      return;
    }
    const pos = this._adsrMousePos(e);
    const pts = this.adsrCurve;
    const idx = this.adsrDragging;

    // Alt = fine mode (×0.1 pursuit toward the cursor)
    let tx = pos.x, ty = pos.y;
    if (e.altKey) {
      tx = pts[idx].x + (pos.x - pts[idx].x) * 0.1;
      ty = pts[idx].y + (pos.y - pts[idx].y) * 0.1;
    }

    // First and last points: lock X
    if (idx === 0) {
      pts[idx].x = 0;
    } else if (idx === pts.length - 1) {
      pts[idx].x = 1;
    } else {
      // Clamp between neighbors
      pts[idx].x = Math.max(pts[idx - 1].x + 0.01, Math.min(pts[idx + 1].x - 0.01, tx));
    }
    pts[idx].y = ty;
    this.drawAdsrCurve();
  }

  _adsrDblClick(e: MouseEvent) {
    const pos = this._adsrMousePos(e);
    // Hit-test in CSS pixels (rect), NOT the DPR-scaled bitmap size
    const rect = this.adsrCanvas!.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;

    // Reset a curvature handle to linear before considering point deletion
    if (resetHandleAtPx(this.adsrCurve, pos, w, h)) {
      this.drawAdsrCurve();
      return;
    }

    // Find and remove point (not first/last)
    for (let i = 1; i < this.adsrCurve.length - 1; i++) {
      const p = this.adsrCurve[i];
      const dx = (p.x - pos.x) * w;
      const dy = (p.y - pos.y) * h;
      if (Math.sqrt(dx * dx + dy * dy) < 12) {
        this.adsrCurve.splice(i, 1);
        this.drawAdsrCurve();
        return;
      }
    }
  }
}

export const arpeggiator = new Arpeggiator();
