/**
 * DLOSy20 - VCO Loop Engine
 * Continuous parameter automation synced to step sequencer bar length
 */
import { audioEngine } from './audio-engine';
import { drawingMode } from './drawing-mode';
import { vcoEase } from './vco-ease';
import { transport } from './transport';
import { registerSerializable } from './registry';
import { emit } from './events';
import {
  evalCurve, hitHandlePx, dragHandle, resetHandleAtPx, drawHandles, copyPoints,
  segmentAtX, CPoint,
} from './curve-editor';

// Breakpoint with optional per-segment curvature (see curve-editor.ts)
type CurvePoint = CPoint;

// Vertical (value) grid divisions for the curve editor + Y quantize. Editor-only
// (doesn't affect playback), shared across voices, persisted. STEP is the
// horizontal grid (transport.numSteps); this is its vertical counterpart.
const VGRID_KEY = 'dlosy20_vgrid';
let vGridDivs = (() => {
  const s = parseInt(localStorage.getItem(VGRID_KEY) || '', 10);
  return (s >= 1 && s <= 16) ? s : 4;
})();

interface VCOCurve {
  points: CurvePoint[];
  min: number;
  max: number;
  label: string;
  log?: boolean;
  stepOnly?: boolean;
}

interface VCOPatternSlot {
  waveType: string;
  masterVolume: number;
  curves: Record<string, CurvePoint[]>;
}

class VCOLoop {
  enabled: boolean;
  waveType: string;
  masterVolume: number;
  fadeDuration: number;
  curves: Record<string, VCOCurve>;
  activeParam: string;
  // drawing モードでは BufferSource、通常は Oscillator と多態なので any 扱い
  osc: any;
  gain: GainNode | null;
  filter: BiquadFilterNode | null;
  playheadPosition: number;
  animationFrameId: number | null;
  _continuousTimerId: ReturnType<typeof setInterval> | null;
  // Per-voice live oscillator phase. These used to be backed by the shared
  // `transport` module (single VCO), but with multiple independent voices each
  // needs its own state — otherwise voices clobber each other's running/phase
  // flags. The VCOLoopManager mirrors the ACTIVE voice's phase into `transport`
  // so vco-ease (global easing editor) can still read it without importing here.
  isOscRunning: boolean = false;
  continuousMode: boolean = false;
  stepStartTime: number = 0;
  stepDuration: number = 0;
  lastStepIndex: number = 0;
  lastTotalSteps: number = 16;
  activePattern: number;
  patternBank: (VCOPatternSlot | null)[];
  chainMode: string;
  chainSet: Set<number>;
  chainPos: number;
  _lastTickStep: number;
  _chainGen: number;
  // Chain advance is keyed to completed modulation LOOPS, not sequencer bars, so
  // it stays correct at any seek RATE (×2 sweeps the loop twice per bar → advance
  // twice per bar; ½ sweeps once per two bars → advance every two bars). _barCount
  // counts elapsed bars; _lastLoopIndex is the last floor((bar+phase)*rate) seen.
  _barCount: number = 0;
  _lastLoopIndex: number = 0;
  _chainLoopRebase: boolean = true; // re-baseline (no advance) on start / rate change
  baseFreq: number = 220;
  isDrawingOsc: boolean = false;
  _drawSplitter: ChannelSplitterNode | null = null;
  _drawPanL: StereoPannerNode | null = null;
  _drawPanR: StereoPannerNode | null = null;
  canvas: HTMLCanvasElement | null = null;
  ctx2d: CanvasRenderingContext2D | null = null;
  draggingPoint: number | null = null;
  // Curvature-handle drag: segment index whose bend is being edited
  _handleDrag: number | null = null;
  // Segment whose handle is revealed on hover (null = none)
  _hoverSeg: number | null = null;
  _resizeObserver: ResizeObserver | null = null;
  // Which voice this instance is (0-based), set by VCOLoopManager. Voice 0 owns
  // the shared editor UI in the current phase; others are audio-only for now.
  voiceId: number = 0;
  // This voice's editor container. All of this voice's DOM lookups are scoped to
  // it (via _el/_all) so 4 voices can each render an independent editor without
  // their IDs/classes colliding. Falls back to `document` if unset.
  root: HTMLElement | null = null;
  // Per-voice "ずらし" controls. phaseOffset (0..1) shifts where this voice sits
  // in the loop; rate scales how fast it sweeps the curve relative to the bar
  // (×2 = twice per bar, ×0.5 = once per two bars). Together they let the voices
  // phase against each other. Applied in _warpPos().
  phaseOffset: number = 0;
  rate: number = 1;
  // Grid quantize: when on, dragged/added control points snap to the editor grid
  // (X → step columns = transport.numSteps; Y → the 4 horizontal divisions).
  quantize: boolean = false;
  // Throttle state for live-drawing buffer refreshes (see refreshDrawingOsc).
  _drawRefreshLast: number = 0;
  _drawRefreshTrailingId: ReturnType<typeof setTimeout> | null = null;
  // Last non-empty drawing waveform. When DRAW is selected but the active slot is
  // empty (cleared / never drawn), we keep playing this instead of dropping to a
  // sine, so "DRAW selected" always means the drawing waveform.
  _lastDrawWave: { waveX: number[]; waveY: number[] } | null = null;

  constructor() {
    // State
    this.enabled = true;
    this.waveType = 'sine';
    this.masterVolume = 1.0; // default VOL = MAX
    this.fadeDuration = 0.2; // seconds

    // Curve data: each parameter has an array of control points
    // Points: { x: 0-1 (time normalized), y: 0-1 (value normalized) }
    this.curves = {
      frequency:  { points: [{x:0, y:0.3}, {x:0.5, y:0.6}, {x:1, y:0.3}], min: 65, max: 2000, label: 'FREQ', log: true },
      // Filter defaults = "effect off": CUTOFF fully open (top = 5000 Hz, above
      // the whole FREQ range) and RES at the bottom (Q≈0, no resonant peak). So
      // the filter is transparent and the oscillator amplitude stays constant
      // across pitch (no confusing high-pitch loudness boost by default).
      cutoff:     { points: [{x:0, y:1}, {x:1, y:1}], min: 100, max: 5000, label: 'CUTOFF', log: true },
      resonance:  { points: [{x:0, y:0}, {x:1, y:0}], min: 0, max: 30, label: 'RES' },
      volume:     { points: [{x:0, y:0.5}, {x:1, y:0.5}], min: 0, max: 1, label: 'VOL' },
      adsr:       { points: [{x:0, y:0}, {x:0.05, y:1}, {x:0.2, y:0.6}, {x:0.8, y:0.6}, {x:1, y:0}], min: 0, max: 1, label: 'ADSR', stepOnly: true },
    };

    this.activeParam = 'frequency';

    // Audio nodes (separate chain from step sequencer)
    this.osc = null;
    this.gain = null;
    this.filter = null;
    this.isOscRunning = false;

    // Playback
    this.playheadPosition = 0; // 0-1
    this.animationFrameId = null;

    // Continuous mode
    this.continuousMode = false; // false=STEP, true=CONTINUOUS
    this._continuousTimerId = null;
    this.stepStartTime = 0;
    this.stepDuration = 0; // ms per bar
    this.lastStepIndex = 0;
    this.lastTotalSteps = 16;

    // Pattern bank (8 slots)
    this.activePattern = 0;
    this.patternBank = [];
    for (let i = 0; i < 8; i++) {
      this.patternBank.push(null);
    }

    // Pattern chaining: play a selected set of patterns in sequence, advancing
    // one pattern per loop cycle (bar). 'off' = normal single pattern.
    this.chainMode = 'off';      // 'off' | 'manual' | 'random'
    this.chainSet = new Set();   // selected pattern indices (0-7)
    this.chainPos = 0;           // index into the sorted chain list
    this._lastTickStep = -1;     // for detecting bar boundaries
    this._chainGen = 0;          // invalidates pending (deferred) advances
  }

  // ===== MIDI HELPERS =====
  switchParam(paramName: string) {
    if (!this.curves[paramName]) return;
    if (this.continuousMode && this.curves[paramName].stepOnly) return;

    this.activeParam = paramName;
    this._all('.vco-param-tab').forEach(t => {
      t.classList.toggle('active', t.dataset.param === paramName);
    });
    this.drawCurve();
  }

  setContinuousMode(isCont: boolean) {
    if (this.continuousMode === isCont) return;
    this.continuousMode = isCont;
    this._all('.vco-mode-btn').forEach(b => {
      b.classList.toggle('active', (b.dataset.mode === 'cont') === isCont);
    });
    
    if (this.continuousMode && this.curves[this.activeParam]?.stepOnly) {
      this.switchParam('frequency');
    } else {
      this.buildParamTabs? this.buildParamTabs() : null;
    }
    
    this.drawCurve();

    if (this.isOscRunning) {
      if (this.continuousMode) {
        this.startContinuousLoop();
      } else {
        this.stopContinuousLoop();
        this._fadeOutForStepSwitch();
      }
    }
  }

  // ===== PATTERN BANK =====
  switchPattern(index: number) {
    if (index === this.activePattern) return;
    // Save current curves (copyPoints preserves per-segment curvature)
    const saved: Record<string, CurvePoint[]> = {};
    Object.entries(this.curves).forEach(([key, curve]) => {
      saved[key] = copyPoints(curve.points);
    });
    this.patternBank[this.activePattern] = {
      waveType: this.waveType,
      masterVolume: this.masterVolume,
      curves: saved
    };
    // Load target. NOTE: STEP/CONT (continuousMode) is a GLOBAL playback
    // setting, not part of a pattern — loading it here would make chaining flip
    // between stepped and continuous articulation per pattern. So it is left
    // untouched on pattern switch.
    this.activePattern = index;
    const target = this.patternBank[index];
    if (target) {
      this.waveType = target.waveType;
      this.masterVolume = target.masterVolume;
      Object.entries(target.curves).forEach(([key, points]) => {
        if (this.curves[key]) {
          this.curves[key].points = copyPoints(points);
        }
      });
    } else {
      // Reset to defaults (filter effect OFF: CUTOFF top / RES bottom)
      this.curves.frequency.points = [{x:0, y:0.3}, {x:0.5, y:0.6}, {x:1, y:0.3}];
      this.curves.cutoff.points = [{x:0, y:1}, {x:1, y:1}];
      this.curves.resonance.points = [{x:0, y:0}, {x:1, y:0}];
      Object.keys(this.curves).forEach(k => {
        if (k !== 'frequency' && k !== 'cutoff' && k !== 'resonance') {
          this.curves[k].points = [{x:0, y:0.5}, {x:1, y:0.5}];
        }
      });
    }
    this.drawCurve();
    this.buildPatternBankUI();
    this.updateChainActive();
    // Update wave buttons
    this._all('.vco-wave-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.wave === this.waveType);
    });
    const volSlider = this._el('vco-vol-slider') as HTMLInputElement | null;
    if (volSlider) volSlider.value = String(Math.round(this.masterVolume * 100));
    emit('state:changed');
  }

  buildPatternBankUI() {
    const panel = this.root;
    if (!panel) return;
    let bankDiv = panel.querySelector('.pattern-bank');
    if (!bankDiv) {
      // Insert after the first header element
      const header = panel.querySelector('.panel-title') || panel.querySelector('.vco-header');
      bankDiv = document.createElement('div');
      bankDiv.className = 'pattern-bank';
      if (header) {
        header.appendChild(bankDiv);
      } else {
        panel.insertBefore(bankDiv, panel.firstChild);
      }
    }
    bankDiv.innerHTML = '';
    for (let i = 0; i < 8; i++) {
      const btn = document.createElement('button');
      btn.className = 'pattern-btn' + (i === this.activePattern ? ' active' : '');
      btn.textContent = String(i + 1);
      btn.addEventListener('click', () => this.switchPattern(i));
      bankDiv.appendChild(btn);
    }
  }

  // ===== PATTERN CHAINING =====

  // Sorted list of selected pattern indices.
  get chainList(): number[] {
    return Array.from(this.chainSet).sort((a, b) => a - b);
  }

  setChainMode(mode: string) {
    if (!['off', 'manual', 'random'].includes(mode)) return;
    const wasOff = this.chainMode === 'off';
    this.chainMode = mode;
    if (mode !== 'off') {
      // Default to the current pattern if nothing is selected yet.
      if (this.chainSet.size === 0) this.chainSet.add(this.activePattern);
      // When enabling the chain, jump to the first selected pattern so playback
      // starts the sequence from its beginning (1 → 2 → 3 → 1 …).
      if (wasOff) {
        this.chainPos = 0;
        const first = this.chainList[0];
        if (first !== undefined && first !== this.activePattern) this.switchPattern(first);
      }
    }
    this._lastTickStep = -1;
    this._chainGen++;
    this.buildChainUI();
    emit('state:changed');
  }

  toggleChainMember(index: number) {
    if (this.chainSet.has(index)) this.chainSet.delete(index);
    else this.chainSet.add(index);
    this._chainGen++; // cancel pending deferred advances tied to the old set
    this.buildChainUI();
    emit('state:changed');
  }

  resetChain() {
    this.chainMode = 'off';
    this.chainSet.clear();
    this.chainPos = 0;
    this._lastTickStep = -1;
    this._chainGen++;
    this.buildChainUI();
    emit('state:changed');
  }

  // Schedule a chain advance at the step's audio time (whenMs is a
  // performance.now()-based timestamp). Deferring spreads burst-scheduled bar
  // boundaries out to their real playback moments instead of all at once.
  _scheduleChainAdvance(whenMs?: number) {
    const delay = (typeof whenMs === 'number') ? whenMs - performance.now() : 0;
    if (delay <= 8) {
      this._advanceChain();
      return;
    }
    const gen = this._chainGen;
    setTimeout(() => {
      // Skip if the chain was changed/disabled or playback stopped meanwhile.
      if (gen !== this._chainGen) return;
      if (this.chainMode === 'off') return;
      if (!transport.isPlaying) return;
      this._advanceChain();
    }, delay);
  }

  // Advance to the next pattern in the chain (called once per loop cycle).
  _advanceChain() {
    const list = this.chainList;
    if (list.length === 0) return;

    let next;
    if (this.chainMode === 'random') {
      if (list.length === 1) {
        next = list[0];
      } else {
        // Pick a different pattern than the current one.
        do {
          next = list[Math.floor(Math.random() * list.length)];
        } while (next === this.activePattern);
      }
    } else {
      // manual: step through the list in order
      this.chainPos = (this.chainPos + 1) % list.length;
      next = list[this.chainPos];
    }

    if (next !== this.activePattern) this.switchPattern(next);
    this.updateChainActive();
  }

  buildChainUI() {
    const panel = this.root;
    if (!panel) return;
    let bar = panel.querySelector('#vco-chain-bar');
    if (!bar) return;

    const cells = Array.from({ length: 8 }, (_, i) => {
      const inSet = this.chainSet.has(i);
      const isActive = this.chainMode !== 'off' && i === this.activePattern && inSet;
      return `<button class="vco-chain-cell${inSet ? ' selected' : ''}${isActive ? ' playing' : ''}" data-chain="${i}">${i + 1}</button>`;
    }).join('');

    bar.innerHTML = `
      <span class="vco-chain-label">CHAIN</span>
      <div class="vco-chain-modes">
        <button class="vco-chain-mode${this.chainMode === 'off' ? ' active' : ''}" data-cmode="off">OFF</button>
        <button class="vco-chain-mode${this.chainMode === 'manual' ? ' active' : ''}" data-cmode="manual">SEQ</button>
        <button class="vco-chain-mode${this.chainMode === 'random' ? ' active' : ''}" data-cmode="random">RND</button>
      </div>
      <div class="vco-chain-cells${this.chainMode === 'off' ? ' disabled' : ''}">${cells}</div>
      <button class="vco-chain-reset small-btn" title="チェーンを解除">RESET</button>
    `;

    bar.querySelectorAll<HTMLElement>('.vco-chain-mode').forEach((b) => {
      b.addEventListener('click', () => this.setChainMode(b.dataset.cmode ?? "off"));
    });
    bar.querySelectorAll<HTMLElement>('.vco-chain-cell').forEach((b) => {
      b.addEventListener('click', () => this.toggleChainMember(parseInt(b.dataset.chain ?? "0", 10)));
    });
    bar.querySelector('.vco-chain-reset')?.addEventListener('click', () => this.resetChain());
  }

  // Lightweight refresh of just the "playing" highlight (avoids full rebuild).
  updateChainActive() {
    const panel = this.root;
    if (!panel) return;
    panel.querySelectorAll<HTMLElement>('.vco-chain-cell').forEach((b) => {
      const i = parseInt(b.dataset.chain ?? "0", 10);
      b.classList.toggle('playing', this.chainMode !== 'off' && i === this.activePattern && this.chainSet.has(i));
    });
  }

  // Scoped DOM helpers: look inside this voice's `root` container so the per-voice
  // editors don't collide on shared ids/classes. Fall back to document if unset.
  _el(id: string): HTMLElement | null {
    return this.root ? this.root.querySelector<HTMLElement>('#' + id) : document.getElementById(id);
  }
  _all(sel: string): NodeListOf<HTMLElement> {
    return (this.root ?? document).querySelectorAll<HTMLElement>(sel);
  }

  init() {
    this.buildUI();
    this.bindControls();
    this.buildPatternBankUI();
    this.buildChainUI();
  }

  // ===== AUDIO =====

  startOsc() {
    if (!audioEngine.isInitialized || this.isOscRunning) return;
    const ctx = audioEngine.ctx!;

    this.filter = ctx.createBiquadFilter();
    this.filter!.type = 'lowpass';
    this.filter!.frequency.value = 2000;
    this.filter!.Q.value = 5;

    this.gain = ctx.createGain();
    this.gain!.gain.value = 0.3;

    if (this.waveType === 'drawing' && drawingMode) {
      // Resolve the waveform: prefer the active slot; if it's empty (cleared, or
      // switched to a blank slot), hold the last non-empty drawing instead of
      // dropping to a sine. Only when nothing has EVER been drawn do we fall back
      // to sine, so DRAW is never silent on a fresh start.
      const slot = drawingMode.slots[drawingMode.activeSlot];
      let waveX: number[] | null = (slot && slot.waveX.length > 0) ? slot.waveX : null;
      let waveY: number[] | null = waveX ? slot.waveY : null;
      if (!waveX && this._lastDrawWave) {
        waveX = this._lastDrawWave.waveX;
        waveY = this._lastDrawWave.waveY;
      }
      if (waveX && waveX.length > 0) {
        // Drawing mode: use stereo AudioBuffer loop
        const wy = waveY;
        const bufferLength = waveX.length;
        const buffer = ctx.createBuffer(2, bufferLength, ctx.sampleRate);
        const lData = buffer.getChannelData(0);
        const rData = buffer.getChannelData(1);
        for (let i = 0; i < bufferLength; i++) {
          lData[i] = waveX[i] || 0;
          rData[i] = (wy && wy[i] !== undefined) ? wy[i] : (waveX[i] || 0);
        }
        this.osc = ctx.createBufferSource();
        this.osc.buffer = buffer;
        this.osc.loop = true;
        this.baseFreq = ctx.sampleRate / bufferLength;
        this.osc.playbackRate.value = 220 / this.baseFreq;
        this.isDrawingOsc = true;
        this._lastDrawWave = { waveX, waveY: wy || waveX }; // remember for blank-slot hold

        // 明示的なステレオルーティング: L(waveX)→左, R(waveY)→右
        this._drawSplitter = ctx.createChannelSplitter(2);
        this._drawPanL = ctx.createStereoPanner();
        this._drawPanR = ctx.createStereoPanner();
        this._drawPanL.pan.value = -1;
        this._drawPanR.pan.value = 1;
        this.osc.connect(this._drawSplitter);
        this._drawSplitter.connect(this._drawPanL, 0); // Ch0(X) → 左
        this._drawSplitter.connect(this._drawPanR, 1); // Ch1(Y) → 右
        this._drawPanL!.connect(this.filter!);
        this._drawPanR!.connect(this.filter!);
        this.filter!.connect(this.gain);
      } else {
        // Nothing has ever been drawn → audible sine fallback (never silent).
        // refreshDrawingOsc upgrades this to a real drawing osc on the first stroke.
        this.osc = ctx.createOscillator();
        this.osc.type = 'sine';
        this.osc.frequency.value = 220;
        this.isDrawingOsc = false;
        this.osc.connect(this.filter);
        this.filter!.connect(this.gain);
      }
    } else {
      // Standard oscillator
      this.osc = ctx.createOscillator();
      this.osc.type = this.waveType;
      this.osc.frequency.value = 220;
      this.isDrawingOsc = false;
      this.osc.connect(this.filter);
      this.filter!.connect(this.gain);
    }

    this.gain!.connect(audioEngine.masterGain!);

    // Fade in
    this.gain!.gain.setValueAtTime(0, audioEngine.ctx!.currentTime);
    this.gain!.gain.linearRampToValueAtTime(this.masterVolume, audioEngine.ctx!.currentTime + this.fadeDuration);

    this.osc.start();
    this.isOscRunning = true;
  }

  stopOsc() {
    if (!this.isOscRunning) return;
    const ctx = audioEngine.ctx!;
    const now = ctx.currentTime;

    // Fade out, then disconnect
    this.gain!.gain.cancelScheduledValues(now);
    this.gain!.gain.setValueAtTime(this.gain!.gain.value, now);
    this.gain!.gain.linearRampToValueAtTime(0, now + this.fadeDuration);

    const oscRef = this.osc;
    const filterRef = this.filter!;
    const gainRef = this.gain!;

    const splitterRef = this._drawSplitter;
    const panLRef = this._drawPanL;
    const panRRef = this._drawPanR;
    this._drawSplitter = null;
    this._drawPanL = null;
    this._drawPanR = null;

    setTimeout(() => {
      try {
        oscRef.stop();
        oscRef.disconnect();
        filterRef.disconnect();
        gainRef.disconnect();
      } catch(e) {}
      try { splitterRef?.disconnect(); } catch(e) {}
      try { panLRef?.disconnect(); } catch(e) {}
      try { panRRef?.disconnect(); } catch(e) {}
    }, this.fadeDuration * 1000 + 50);

    this.isOscRunning = false;
    this.osc = null;
  }

  // Refresh oscillator when drawing data changes during playback.
  refreshDrawingOsc() {
    // NOTE: intentionally NOT gated on isDrawingOsc. If DRAW was selected while
    // the active slot was empty, startOsc fell back to a sine oscillator
    // (isDrawingOsc=false). We must still react here so that, once the user
    // draws, we can upgrade that sine fallback to a real drawing oscillator —
    // otherwise the VCO stays stuck on sine and "DRAW doesn't change the sound".
    if (!this.isOscRunning) return;
    if (this.waveType !== 'drawing') return;
    // Blank slot (cleared / switched to empty) → keep the current sound playing
    // instead of dropping to the sine fallback. A new stroke refills it.
    const slot = drawingMode && drawingMode.slots[drawingMode.activeSlot];
    if (!slot || !slot.waveX || slot.waveX.length === 0) return;

    // Upgrade path: currently on the sine fallback but the slot now has data.
    // switchDrawBuffer can't be used (it needs an existing drawing osc), so do a
    // one-time full recreate, which builds a proper drawing oscillator now.
    if (!this.isDrawingOsc) {
      const savedPos = this.playheadPosition;
      this.stopOsc();
      this.startOsc();
      this.applyAtPosition(savedPos);
      return;
    }

    // Throttle to ~20Hz. Live drawing calls this on every mousemove; rebuilding
    // the buffer that often is wasteful and each swap is a tiny click. A trailing
    // call guarantees the final stroke is applied after the user stops moving.
    const now = performance.now();
    const MIN_INTERVAL = 50;
    if (this._drawRefreshTrailingId) {
      clearTimeout(this._drawRefreshTrailingId);
      this._drawRefreshTrailingId = null;
    }
    const wait = MIN_INTERVAL - (now - this._drawRefreshLast);
    if (wait > 0) {
      this._drawRefreshTrailingId = setTimeout(() => {
        this._drawRefreshTrailingId = null;
        this.refreshDrawingOsc();
      }, wait);
      return;
    }
    this._drawRefreshLast = now;

    // Swap the buffer in place — exactly one oscillator in, one out (immediately).
    // The old stopOsc()/startOsc() teardown faded out over 0.2s and kept the old
    // oscillator ringing ~0.25s, so live drawing stacked many overlapping
    // oscillators → a smeared, reverb-like sound. switchDrawBuffer keeps a single
    // gain-continuous oscillator and preserves pitch/filter/gain.
    this.switchDrawBuffer(drawingMode.activeSlot);
  }

  // Switch drawing buffer to a different slot without interrupting playback
  switchDrawBuffer(slotIndex: number) {
    if (!this.isOscRunning || !this.isDrawingOsc) return;
    if (!drawingMode) return;

    const slot = drawingMode.slots[slotIndex];
    if (!slot || slot.waveX.length === 0) return;
    // Remember this waveform so an empty slot later holds it instead of sine.
    this._lastDrawWave = { waveX: slot.waveX, waveY: slot.waveY };

    const ctx = audioEngine.ctx!;
    const bufferLength = slot.waveX.length;
    const buffer = ctx.createBuffer(2, bufferLength, ctx.sampleRate);
    const lData = buffer.getChannelData(0);
    const rData = buffer.getChannelData(1);
    for (let i = 0; i < bufferLength; i++) {
      lData[i] = slot.waveX[i] || 0;
      rData[i] = (slot.waveY[i] !== undefined) ? slot.waveY[i] : (slot.waveX[i] || 0);
    }

    // Create new buffer source and swap
    const oldOsc = this.osc;
    const newOsc = ctx.createBufferSource();
    newOsc.buffer = buffer;
    newOsc.loop = true;
    this.baseFreq = ctx.sampleRate / bufferLength;
    newOsc.playbackRate.value = oldOsc.playbackRate.value;

    // 明示的なステレオルーティング: L(waveX)→左, R(waveY)→右
    const oldSplitter = this._drawSplitter;
    const oldPanL = this._drawPanL;
    const oldPanR = this._drawPanR;
    this._drawSplitter = ctx.createChannelSplitter(2);
    this._drawPanL = ctx.createStereoPanner();
    this._drawPanR = ctx.createStereoPanner();
    this._drawPanL.pan.value = -1;
    this._drawPanR.pan.value = 1;
    newOsc.connect(this._drawSplitter);
    this._drawSplitter.connect(this._drawPanL, 0);
    this._drawSplitter.connect(this._drawPanR, 1);
    this._drawPanL!.connect(this.filter!);
    this._drawPanR!.connect(this.filter!);
    // filter is already connected to gain from startOsc()
    newOsc.start();

    // Stop old osc
    try {
      oldOsc.stop();
      oldOsc.disconnect();
    } catch(e) {}
    try { oldSplitter?.disconnect(); } catch(e) {}
    try { oldPanL?.disconnect(); } catch(e) {}
    try { oldPanR?.disconnect(); } catch(e) {}

    this.osc = newOsc;
  }

  // Apply curve values at current playhead position.
  // `atTime` (audio-clock seconds): when provided, parameter changes are
  // scheduled exactly on the audio grid rather than applied instantly. STEP
  // mode passes the step's real audio time so the pitch/cutoff switch lines up
  // with the gain envelope (a 50ms-early instant `.value` write glitches/clicks).
  applyAtPosition(pos: number, atTime?: number) {
    if (!this.isOscRunning) return;

    const freq = this.getValueAt('frequency', pos);
    const vol = this.getValueAt('volume', pos);
    // Report the live pitch so the stereo-phase DEG mode can hold a constant
    // phase angle across this voice's frequency sweep.
    if (this.enabled) audioEngine.currentPitchHz = freq;

    const cutoff = this.getValueAt('cutoff', pos);
    const res = this.getValueAt('resonance', pos);

    if (atTime !== undefined) {
      if (this.isDrawingOsc) {
        this.osc.playbackRate.setValueAtTime(freq / this.baseFreq, atTime);
      } else {
        this.osc.frequency.setValueAtTime(freq, atTime);
      }
      this.filter!.frequency.setValueAtTime(cutoff, atTime);
      this.filter!.Q.setValueAtTime(res, atTime);
      if (this.continuousMode) {
        this.gain!.gain.setValueAtTime(vol * this.masterVolume, atTime);
      }
    } else {
      const t = audioEngine.ctx!.currentTime;
      // Frequency is phase-continuous, so an instant write never clicks — keep it
      // exact (no glide) so pitch tracks the curve precisely.
      if (this.isDrawingOsc) {
        this.osc.playbackRate.value = freq / this.baseFreq;
      } else {
        this.osc.frequency.value = freq;
      }
      // Filter coefficient jumps DO click, and on a STEP→CONT switch the first
      // tick would snap the cutoff/Q from the last step's value to the live one.
      // Glide them (setTargetAtTime starts from the current value at `t`, so no
      // past-anchor artefact) to keep the handoff and the sweep smooth.
      this.filter!.frequency.setTargetAtTime(cutoff, t, 0.01);
      this.filter!.Q.setTargetAtTime(res, t, 0.01);
      // In STEP mode, gain is controlled by ADSR envelope (_fireStepADSR).
      // In CONT mode glide the gain with setTargetAtTime: it approaches the target
      // exponentially from whatever the param's CURRENT value is at `t`, so unlike
      // a linear ramp it needs neither a `.value` read (whose JS-vs-audio-clock
      // skew left occasional steps → intermittent zipper while dragging VOL) nor a
      // past-anchor. Modern browsers' cancelAndHoldAtTime resolves a setTargetAtTime
      // correctly, so the CONT→STEP fade (_fadeOutForStepSwitch) stays clean.
      if (this.continuousMode) {
        this.gain!.gain.setTargetAtTime(vol * this.masterVolume, t, 0.01);
      }
    }
  }

  // Map a step index to its normalized curve position 0..1, spread across the FULL
  // editor width: step 0 → 0 (left edge), last step → 1 (right edge). So the
  // playhead sweeps the whole editor and the last grid column is a real, audible
  // step. (The 1.0 endpoint is preserved in _warpPos, not folded back onto 0.)
  _stepPhase(stepIndex: number, totalSteps: number): number {
    return stepIndex / Math.max(1, totalSteps - 1);
  }

  // Map a base bar position (0..1) through this voice's rate + phase offset, wrap
  // into 0..1, then through the (global) easing curve. This is what makes voices
  // play the same loop shifted/at different speeds so they "ずれて" against each other.
  _warpPos(basePos: number): number {
    const raw = basePos * this.rate + this.phaseOffset;
    let p = raw % 1;
    if (p < 0) p += 1;
    // Keep the exact loop-END (raw == 1, i.e. the last step at rate 1) as 1 rather
    // than folding it onto 0 — otherwise the final step would double the first and
    // the playhead would never reach the right edge.
    if (p === 0 && Math.abs(raw - 1) < 1e-9) p = 1;
    return vcoEase ? vcoEase.apply(p) : p;
  }

  // Convert normalized value (0-1) to actual parameter value
  // Uses logarithmic scaling for frequency-like parameters
  normalizedToValue(y: number, curve: VCOCurve) {
    if (curve.log && curve.min > 0) {
      // Logarithmic: min * (max/min)^y
      return curve.min * Math.pow(curve.max / curve.min, y);
    }
    // Linear: min + y * (max - min)
    return curve.min + y * (curve.max - curve.min);
  }

  // Interpolate value from curve at position t (0-1)
  getValueAt(paramName: string, t: number) {
    const curve = this.curves[paramName];
    if (!curve) return 0;
    const pts = curve.points;
    if (pts.length === 0) return curve.min;
    // Piecewise interpolation with per-segment curvature (curve-editor.ts)
    return this.normalizedToValue(evalCurve(pts, t), curve);
  }

  // ===== SYNC WITH TRANSPORT CLOCK =====

  onStepTick(stepIndex: number, totalSteps: number, whenMs?: number) {
    if (!this.enabled) return;

    // Bar bookkeeping: bump the elapsed-bar counter each time the step wraps.
    const freshRun = this._lastTickStep === -1;
    if (stepIndex < this._lastTickStep) this._barCount++;
    this._lastTickStep = stepIndex;

    // Pattern chaining: advance ONCE PER COMPLETED MODULATION LOOP (not per bar).
    // The playhead sweeps the loop `rate` times per bar, so keying the advance to
    // loop completions keeps "one pattern = one full sweep" at every seek speed —
    // fixing ×2/×4, where per-bar advancing made each pattern repeat rate times.
    // The advance is deferred to the step's real audio time (the lookahead
    // scheduler can burst many steps at once) so switches stay aligned to sound.
    if (this.chainMode !== 'off') {
      const loopIndex = Math.floor((this._barCount + stepIndex / totalSteps) * this.rate);
      if (freshRun || this._chainLoopRebase) {
        this._chainLoopRebase = false; // establish a baseline without advancing
      } else if (loopIndex > this._lastLoopIndex) {
        for (let i = this._lastLoopIndex; i < loopIndex; i++) this._scheduleChainAdvance(whenMs);
      }
      this._lastLoopIndex = loopIndex;
    }

    this.lastStepIndex = stepIndex;
    this.lastTotalSteps = totalSteps;

    if (this.continuousMode) {
      // In continuous mode, just record timestamp for interpolation
      this.stepStartTime = performance.now();
      // Calculate step duration from BPM.
      // (テンポは audioEngine.params.tempo が真実の値)
      const bpm = (audioEngine && audioEngine.params.tempo) || 120;
      this.stepDuration = (60000 / bpm) / 4; // per-step duration in ms
    } else {
      // STEP mode: discrete update with ADSR envelope.
      // Apply rate/phase warp then easing to the per-step sampled position so the
      // modulation curve is traversed (per voice) shifted/scaled and non-uniformly.
      const easedPos = this._warpPos(this._stepPhase(stepIndex, totalSteps));
      this.playheadPosition = easedPos;
      // Reconstruct the step's real audio time from the perf-clock timestamp the
      // sequencer scheduled it for, so pitch + envelope land on the audio grid
      // (not 50ms early at JS wall-clock time, which truncates the prior step's
      // envelope mid-flight and clicks).
      const ctxNow = audioEngine.ctx!.currentTime;
      const audioTime = (whenMs !== undefined)
        ? ctxNow + Math.max(0, (whenMs - performance.now()) / 1000)
        : ctxNow;
      this.applyAtPosition(easedPos, audioTime);
      this._fireStepADSR(stepIndex, totalSteps, easedPos, audioTime);
    }
  }

  _fireStepADSR(stepIndex: number, totalSteps: number, samplePos?: number, atTime?: number) {
    if (!this.gain || !this.isOscRunning) return;
    const ctx = audioEngine.ctx!;
    // Schedule on the step's real audio time when known. Cancelling/anchoring at
    // the future grid time lets the previous step's envelope play out fully to
    // its endpoint instead of being chopped off → seamless, click-free retrigger.
    const now = (atTime !== undefined) ? atTime : ctx.currentTime;

    const pos = (samplePos !== undefined) ? samplePos : this._stepPhase(stepIndex, totalSteps);
    const vol = this.getValueAt('volume', pos) * this.masterVolume;

    // Calculate step duration（テンポは audioEngine.params.tempo が真実の値）
    const bpm = (audioEngine && audioEngine.params.tempo) || 120;
    const stepDur = (60 / bpm) / 4;

    // Stop the previous step's scheduled ramps WITHOUT chopping its tail.
    // cancelScheduledValues(now) would delete the prior step's final down-ramp
    // (whose endpoint sits exactly at `now`), freezing the gain at the
    // second-to-last sample (~0.19·vol) and then hard-stepping it to 0.001 here
    // → click. cancelAndHoldAtTime lets the in-progress ramp resolve to its value
    // at `now` and holds it, so the new envelope continues seamlessly.
    const gp = this.gain!.gain;
    if (typeof gp.cancelAndHoldAtTime === 'function') {
      gp.cancelAndHoldAtTime(now);
    } else {
      gp.cancelScheduledValues(now);
    }

    // Sample the ADSR curve at multiple points and schedule gain.
    // The first point is reached with a short ramp (not setValueAtTime) so that
    // when the envelope's start value differs from the held value — e.g. a custom
    // curve that doesn't return to 0 at its end — the transition glides instead
    // of stepping (which clicks). `smooth` stays well under one sample interval.
    const numSamples = 16;
    const smooth = Math.min(0.003, stepDur / 32);
    for (let i = 0; i <= numSamples; i++) {
      const t = i / numSamples; // 0-1 within step
      const envVal = this.getValueAt('adsr', t); // 0-1 envelope value
      const gainVal = Math.max(0.001, envVal * vol);
      if (i === 0) {
        // Glide from the held value to the envelope start over `smooth` seconds.
        this.gain!.gain.linearRampToValueAtTime(gainVal, now + smooth);
      } else {
        // Compress the rest of the envelope into [now+smooth, now+stepDur].
        const time = now + smooth + t * (stepDur - smooth);
        this.gain!.gain.linearRampToValueAtTime(gainVal, time);
      }
    }
  }

  onPlayStart() {
    if (!this.enabled) return;
    if (!audioEngine.isInitialized) return;
    this._lastTickStep = -1; // fresh bar detection for this run
    this._barCount = 0;
    this._chainLoopRebase = true; // baseline the chain-loop counter for this run
    this.startOsc();
    if (this.continuousMode) {
      this.startContinuousLoop();
    }
  }

  onPlayStop() {
    this.stopOsc();
    this.stopContinuousLoop();
    this.playheadPosition = 0;
    this.updatePlayhead();
    this._chainGen++;        // cancel any pending deferred chain advances
    this._lastTickStep = -1;
  }

  // ===== CONTINUOUS MODE =====

  // Uses setInterval instead of requestAnimationFrame: rAF is fully paused
  // when the tab/window is hidden or occluded (e.g. Ableton covering the
  // browser), which would freeze this modulation. Audio-producing tabs are
  // exempt from Chrome's aggressive background-timer throttling, so
  // setInterval keeps ticking. The position is recomputed from absolute
  // timestamps each tick, so irregular tick timing doesn't cause drift.
  startContinuousLoop() {
    this.stopContinuousLoop();
    const TICK_MS = 20;

    // Entering CONT from STEP: clear the last step's pending ramps and hold the
    // current values so the continuous control (setTargetAtTime) glides on from
    // exactly where STEP left off — instead of pending future setValueAtTime
    // events (gain ADSR, and filter cutoff/Q on non-flat curves) firing after the
    // switch and fighting it / blipping. Done for gain + filter together.
    if (audioEngine.ctx) {
      const now = audioEngine.ctx.currentTime;
      const hold = (p: AudioParam | undefined) => {
        if (!p) return;
        if (typeof p.cancelAndHoldAtTime === 'function') p.cancelAndHoldAtTime(now);
        else p.cancelScheduledValues(now);
      };
      hold(this.gain?.gain);
      hold(this.filter?.frequency);
      hold(this.filter?.Q);
    }

    this._continuousTimerId = setInterval(() => {
      if (!this.enabled || !this.isOscRunning) return;

      const now = performance.now();
      const elapsed = now - this.stepStartTime;
      const stepFraction = this.stepDuration > 0 ? Math.min(elapsed / this.stepDuration, 1) : 0;

      // Linear phase 0..1 across the loop, matching STEP's step→phase mapping so
      // the playhead sweeps the full editor width (last step lands on x=1).
      let linearPhase = (this.lastStepIndex + stepFraction) / Math.max(1, this.lastTotalSteps - 1);
      if (linearPhase > 1) linearPhase = 1;

      // Apply this voice's rate/phase warp (wraps into 0..1) then the easing
      // curve, so each voice sweeps the loop shifted / at its own speed.
      this.playheadPosition = this._warpPos(linearPhase);

      this.applyAtPosition(this.playheadPosition);
      this.updatePlayhead();
    }, TICK_MS);
  }

  stopContinuousLoop() {
    if (this._continuousTimerId) {
      clearInterval(this._continuousTimerId);
      this._continuousTimerId = null;
    }
  }

  // Leaving CONT for STEP while playing: the continuous gain is sitting at the
  // CONT level. If we just let the next step's envelope grab it (via a future
  // cancelAndHoldAtTime), the abrupt handoff from that held level clicks. Fade
  // the gain to near-silence here, at real time, so the next step's ADSR
  // re-gates cleanly from ~0. Called only on an actual CONT→STEP switch (NOT
  // from startContinuousLoop's internal stopContinuousLoop()).
  _fadeOutForStepSwitch() {
    if (!this.gain || !audioEngine.ctx || !this.isOscRunning) return;
    const g = this.gain.gain;
    const now = audioEngine.ctx.currentTime;
    // NOTE: do NOT use cancelAndHoldAtTime here. The CONT gain is driven by
    // setTargetAtTime, and cancelAndHoldAtTime after a setTargetAtTime is buggy in
    // Chrome — it snaps the "held" value to the setTarget's TARGET instead of the
    // current value, which reintroduces the very click we're removing. Instead
    // read the current value and re-anchor it explicitly, then ramp to silence.
    const current = g.value;
    g.cancelScheduledValues(now);
    g.setValueAtTime(current, now);
    g.linearRampToValueAtTime(0.0001, now + 0.015);
  }

  // ===== UI =====

  buildUI() {
    const container = this.root;
    if (!container) return;

    container.innerHTML = `
      <div class="panel-title">
        VCO LOOP V${this.voiceId + 1}
        <div class="vco-header-controls">
          <button id="vco-toggle" class="small-btn vco-toggle-btn${this.enabled ? ' vco-on' : ''}">${this.enabled ? 'ON' : 'OFF'}</button>
          <div class="vco-mode-select">
            <button class="vco-mode-btn active" data-mode="step">STEP</button>
            <button class="vco-mode-btn" data-mode="cont">CONT</button>
          </div>
          <div class="vco-wave-select">
            <button class="vco-wave-btn active" data-wave="sine">SIN</button>
            <button class="vco-wave-btn" data-wave="triangle">TRI</button>
            <button class="vco-wave-btn" data-wave="square">SQR</button>
            <button class="vco-wave-btn" data-wave="sawtooth">SAW</button>
            <button class="vco-wave-btn" data-wave="drawing">DRAW</button>
          </div>
          <div class="vco-vol-group">
            <span class="label">VOL</span>
            <input id="vco-vol-slider" type="range" min="0" max="100" value="${Math.round(this.masterVolume * 100)}" class="vco-vol-slider" data-midi-target="vcoMasterVol" />
          </div>
        </div>
      </div>
      <div class="vco-chain-bar" id="vco-chain-bar"></div>
      <div class="vco-param-tabs" id="vco-param-tabs">
        <!-- tabs generated by JS -->
      </div>
      <div class="vco-editor-area">
        <canvas id="vco-curve-canvas" width="600" height="160"></canvas>
        <div class="vco-playhead" id="vco-playhead"></div>
      </div>
      <div class="vco-timing-row">
        <span class="label">PHASE</span>
        <input id="vco-phase-slider" type="range" min="0" max="100" value="${Math.round(this.phaseOffset * 100)}" class="vco-vol-slider" />
        <span id="vco-phase-val" class="vco-info">${Math.round(this.phaseOffset * 100)}%</span>
        <span class="label">RATE</span>
        <div class="vco-rate-select">
          ${[0.25, 0.5, 1, 2, 4].map(r =>
            `<button class="vco-rate-btn${r === this.rate ? ' active' : ''}" data-rate="${r}">${r === 0.25 ? '¼' : r === 0.5 ? '½' : '×' + r}</button>`).join('')}
        </div>
        <span class="label">STEP</span>
        <input id="vco-steps" type="number" min="1" max="16" step="1" value="${transport.numSteps}" class="vco-steps-input" title="横グリッド：ループのステップ数（1〜16）" />
        <span class="label">V</span>
        <input id="vco-vgrid" type="number" min="1" max="16" step="1" value="${vGridDivs}" class="vco-vgrid-input" title="縦グリッド：値の分割数（1〜16）" />
      </div>
      <div class="vco-editor-controls">
        <button id="vco-reset-curve" class="small-btn">RESET</button>
        <button id="vco-quantize" class="small-btn${this.quantize ? ' vco-on' : ''}" title="制御点をグリッドにスナップ（ON/OFF）">GRID</button>
        <span id="vco-cursor-info" class="vco-info"></span>
      </div>
    `;

    this.buildParamTabs();
    this.initCanvas();
  }

  // ===== CURVE PRESETS =====
  static get CURVE_PRESETS(): Record<string, { label: string; points: CurvePoint[] | null }> {
    return {
      top:      { label: '▔▔', points: [{x:0, y:1}, {x:1, y:1}] },   // flat at max
      flat:     { label: '━━', points: [{x:0, y:0.5}, {x:1, y:0.5}] }, // flat at center
      bottom:   { label: '▁▁', points: [{x:0, y:0}, {x:1, y:0}] },   // flat at min
      rampUp:   { label: '╱',  points: [{x:0, y:0}, {x:1, y:1}] },
      rampDown: { label: '╲',  points: [{x:0, y:1}, {x:1, y:0}] },
      triangle: { label: '╱╲', points: [{x:0, y:0}, {x:0.5, y:1}, {x:1, y:0}] },
      sine:     { label: '∿',  points: [{x:0, y:0.5}, {x:0.15, y:0.93}, {x:0.35, y:1}, {x:0.5, y:0.5}, {x:0.65, y:0.07}, {x:0.85, y:0}, {x:1, y:0.5}] },
      square:   { label: '▁▇', points: [{x:0, y:0}, {x:0.001, y:1}, {x:0.5, y:1}, {x:0.501, y:0}, {x:1, y:0}] },
      expo:     { label: '⌒',  points: [{x:0, y:0}, {x:0.2, y:0.04}, {x:0.5, y:0.25}, {x:0.8, y:0.64}, {x:1, y:1}] },
      random:   { label: '🎲', points: null }, // generated at runtime
    };
  }

  applyPreset(presetName: string) {
    const preset = VCOLoop.CURVE_PRESETS[presetName];
    if (!preset) return;
    const curve = this.curves[this.activeParam];
    if (!curve) return;

    if (presetName === 'random') {
      // Generate random curve: 6-10 points
      const numPts = 6 + Math.floor(Math.random() * 5);
      const pts = [{x: 0, y: Math.random()}];
      for (let i = 1; i < numPts - 1; i++) {
        pts.push({ x: i / (numPts - 1), y: Math.random() });
      }
      pts.push({x: 1, y: Math.random()});
      curve.points = pts;
    } else {
      curve.points = preset.points!.map(p => ({x: p.x, y: p.y}));
    }
    (curve as any)._tail = []; // fresh curve — drop any hidden overflow
    this.drawCurve();
  }

  flipVertical() {
    const curve = this.curves[this.activeParam];
    if (!curve) return;
    curve.points = curve.points.map(p => ({x: p.x, y: 1 - p.y}));
    (curve as any)._tail = [];
    this.drawCurve();
  }

  flipHorizontal() {
    const curve = this.curves[this.activeParam];
    if (!curve) return;
    curve.points = curve.points.map(p => ({x: 1 - p.x, y: p.y})).reverse();
    (curve as any)._tail = [];
    this.drawCurve();
  }

  // Random curve with peaks placed ON (or OFF) the beat. Derives the beat from the
  // current STEP count (≈4 beats/loop): strong beats fall on `k % beat === 0`, the
  // off-beats halfway between. On-beat → peaks on the strong beats (valleys on the
  // off-beats); off-beat → the reverse. Values stay random, so it's "random, but
  // locked to the groove". One point per step (last at x=1 = the last step).
  _randomBeat(onbeat: boolean) {
    const curve = this.curves[this.activeParam];
    if (!curve) return;
    const N = Math.max(1, transport.numSteps);
    const denom = Math.max(1, N - 1);
    const beat = Math.max(1, Math.round(N / 4)); // steps per beat (~4 beats/loop)
    const half = Math.max(1, Math.round(beat / 2)); // off-beat offset within a beat
    const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo);
    // One point per step at its sample position k/(N-1) (last at x=1) so each step
    // gets its value exactly.
    const pts: CurvePoint[] = [];
    for (let k = 0; k < N; k++) {
      const inBeat = k % beat;
      const strong = inBeat === 0;   // on the beat
      const off = inBeat === half;   // the "&" between beats
      const peak = onbeat ? strong : off;
      const valley = onbeat ? off : strong;
      let y: number;
      if (peak) y = rand(0.6, 1.0);        // accent
      else if (valley) y = rand(0.0, 0.25); // rest
      else y = rand(0.2, 0.5);              // in-between subdivisions
      pts.push({ x: k / denom, y });
    }
    curve.points = pts;
    (curve as any)._tail = []; // fresh pattern — drop any hidden overflow
    this.drawCurve();
    emit('state:changed');
  }

  buildParamTabs() {
    const tabContainer = this._el('vco-param-tabs');
    if (!tabContainer) return;
    tabContainer.innerHTML = '';

    Object.entries(this.curves).forEach(([key, curve]) => {
      // Hide stepOnly tabs in CONT mode
      if (curve.stepOnly && this.continuousMode) return;

      const tab = document.createElement('button');
      tab.className = 'vco-param-tab' + (key === this.activeParam ? ' active' : '');
      tab.textContent = curve.label;
      tab.dataset.param = key;
      tab.addEventListener('click', () => {
        this.activeParam = key;
        this._all('.vco-param-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        this.drawCurve();
      });
      tabContainer.appendChild(tab);
    });

    // Preset buttons row
    let presetRow = tabContainer.parentElement!.querySelector('.vco-presets');
    if (!presetRow) {
      presetRow = document.createElement('div');
      presetRow.className = 'vco-presets';
      tabContainer.parentElement!.insertBefore(presetRow, tabContainer.nextSibling);
    }
    presetRow.innerHTML = '';
    Object.entries(VCOLoop.CURVE_PRESETS).forEach(([name, preset]) => {
      const btn = document.createElement('button');
      btn.className = 'vco-preset-btn';
      btn.textContent = preset.label;
      btn.title = name;
      btn.addEventListener('click', () => this.applyPreset(name));
      presetRow.appendChild(btn);
    });

    // Separator + Flip buttons
    const sep = document.createElement('span');
    sep.style.cssText = 'width:1px;height:18px;background:var(--border-panel);margin:0 4px;align-self:center;';
    presetRow.appendChild(sep);

    const flipV = document.createElement('button');
    flipV.className = 'vco-preset-btn';
    flipV.textContent = '↕';
    flipV.title = 'Flip Vertical';
    flipV.addEventListener('click', () => this.flipVertical());
    presetRow.appendChild(flipV);

    const flipH = document.createElement('button');
    flipH.className = 'vco-preset-btn';
    flipH.textContent = '↔';
    flipH.title = 'Flip Horizontal';
    flipH.addEventListener('click', () => this.flipHorizontal());
    presetRow.appendChild(flipH);

    // Separator + on-beat / off-beat random (peaks placed on / off the beat grid).
    const sep2 = document.createElement('span');
    sep2.style.cssText = 'width:1px;height:18px;background:var(--border-panel);margin:0 4px;align-self:center;';
    presetRow.appendChild(sep2);

    const onBeatBtn = document.createElement('button');
    onBeatBtn.className = 'vco-preset-btn';
    onBeatBtn.textContent = '🎲ON';
    onBeatBtn.title = 'オンビート・ランダム（拍に山）';
    onBeatBtn.addEventListener('click', () => this._randomBeat(true));
    presetRow.appendChild(onBeatBtn);

    const offBeatBtn = document.createElement('button');
    offBeatBtn.className = 'vco-preset-btn';
    offBeatBtn.textContent = '🎲OFF';
    offBeatBtn.title = 'オフビート・ランダム（裏に山）';
    offBeatBtn.addEventListener('click', () => this._randomBeat(false));
    presetRow.appendChild(offBeatBtn);
  }

  initCanvas() {
    this.canvas = this._el('vco-curve-canvas') as HTMLCanvasElement | null;
    if (!this.canvas) return;
    this.ctx2d = this.canvas!.getContext('2d');

    // Sync canvas internal resolution to its CSS display size
    this.syncCanvasSize();

    this.draggingPoint = null;

    this.canvas!.addEventListener('mousedown', (e) => this.onCanvasMouseDown(e));
    this.canvas!.addEventListener('mousemove', (e) => this.onCanvasMouseMove(e));
    this.canvas!.addEventListener('mouseup', () => this.onCanvasMouseUp());
    this.canvas!.addEventListener('mouseleave', () => {
      this.onCanvasMouseUp();
      if (this._hoverSeg !== null) { this._hoverSeg = null; this.drawCurve(); }
    });
    this.canvas!.addEventListener('dblclick', (e) => this.onCanvasDoubleClick(e));
    // Right-click = delete point (unified across all curve editors)
    this.canvas!.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this._deletePointAt(e);
    });

    // Auto-resize canvas when container changes size
    if (window.ResizeObserver) {
      this._resizeObserver = new ResizeObserver(() => {
        this.syncCanvasSize();
        this.drawCurve();
      });
      this._resizeObserver.observe(this.canvas!.parentElement!);
    }

    this.drawCurve();
  }

  syncCanvasSize() {
    if (!this.canvas) return;
    const rect = this.canvas!.getBoundingClientRect();
    const displayW = Math.max(Math.round(rect.width), 200);
    const displayH = Math.max(Math.round(rect.height), 80);
    // Only update if size actually changed (avoid infinite loop)
    if (this.canvas!.width !== displayW || this.canvas!.height !== displayH) {
      this.canvas!.width = displayW;
      this.canvas!.height = displayH;
    }
  }

  bindControls() {
    this._el('vco-toggle')?.addEventListener('click', () => {
      this.enabled = !this.enabled;
      const btn = this._el('vco-toggle');
      if (btn) {
        btn.textContent = this.enabled ? 'ON' : 'OFF';
        btn.classList.toggle('vco-on', this.enabled);
      }
      if (this.enabled) {
      // If sequencer is already playing, start oscillator immediately
      if (transport.isPlaying && audioEngine.isInitialized) {
        this.startOsc();
        // Sync playhead to current sequencer position
        const pos = transport.currentStep / transport.numSteps;
        this.playheadPosition = pos;
        this.applyAtPosition(pos);
        // Start continuous loop if in CONT mode
        if (this.continuousMode) {
          this.startContinuousLoop();
        }
      }
    } else {
      this.stopOsc();
      this.stopContinuousLoop();
    }
    });

    // STEP / CONT mode toggle
    (this.root ?? document).addEventListener('click', (e) => {
      const tgt = e.target as HTMLElement;
      if (tgt.classList.contains('vco-mode-btn')) {
        this._all('.vco-mode-btn').forEach(b => b.classList.remove('active'));
        tgt.classList.add('active');
        const mode = tgt.dataset.mode;
        this.continuousMode = (mode === 'cont');
        // Curvature handles are CONT-only — drop any hover/drag state on switch.
        this._hoverSeg = null;
        this._handleDrag = null;

        // Show/hide ADSR tab (STEP mode only)
        // If switching to CONT while ADSR tab is selected, fall back to frequency
        if (this.continuousMode && this.curves[this.activeParam]?.stepOnly) {
          this.activeParam = 'frequency';
        }
        this.buildParamTabs();
        this.drawCurve();

        if (this.isOscRunning) {
          if (this.continuousMode) {
            this.startContinuousLoop();
          } else {
            this.stopContinuousLoop();
            this._fadeOutForStepSwitch();
          }
        }
      }
    });


    // VCO Volume slider
    this._el('vco-vol-slider')?.addEventListener('input', (e) => {
      this.masterVolume = parseInt((e.target as HTMLInputElement).value) / 100;
      // Don't write the gain here. Both engines already re-read masterVolume
      // continuously — CONT every 20ms tick (applyAtPosition), STEP every step
      // (_fireStepADSR) — so updating the field is enough. A direct write while
      // dragging would fire many times per second and fight the CONT loop's
      // per-tick ramp on the same AudioParam, producing zipper ("ザザッ") noise.
    });

    // PHASE offset slider (0..1) — shifts this voice within the loop.
    this._el('vco-phase-slider')?.addEventListener('input', (e) => {
      this.phaseOffset = parseInt((e.target as HTMLInputElement).value) / 100;
      const lbl = this._el('vco-phase-val');
      if (lbl) lbl.textContent = Math.round(this.phaseOffset * 100) + '%';
    });

    // RATE multiplier buttons — how fast this voice sweeps the loop vs the bar.
    this._all('.vco-rate-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this.rate = parseFloat(btn.dataset.rate ?? '1');
        // Re-baseline the chain-loop counter so the rate change doesn't burst a
        // batch of advances from the jump in loopIndex.
        this._chainLoopRebase = true;
        this._all('.vco-rate-btn').forEach(b => b.classList.toggle('active', b === btn));
      });
    });

    this._el('vco-reset-curve')?.addEventListener('click', () => {
      const curve = this.curves[this.activeParam];
      if (this.activeParam === 'adsr') {
        // Restore default ADSR shape
        curve.points = [{x:0, y:0}, {x:0.05, y:1}, {x:0.2, y:0.6}, {x:0.8, y:0.6}, {x:1, y:0}];
      } else if (this.activeParam === 'cutoff') {
        curve.points = [{x: 0, y: 1}, {x: 1, y: 1}]; // effect off: fully open
      } else if (this.activeParam === 'resonance') {
        curve.points = [{x: 0, y: 0}, {x: 1, y: 0}]; // effect off: no resonance
      } else {
        curve.points = [{x: 0, y: 0.5}, {x: 1, y: 0.5}];
      }
      (curve as any)._tail = []; // fresh curve — drop any hidden overflow
      this.drawCurve();
    });

    // GRID quantize toggle
    this._el('vco-quantize')?.addEventListener('click', () => {
      this.quantize = !this.quantize;
      this._el('vco-quantize')?.classList.toggle('vco-on', this.quantize);
      emit('state:changed');
    });

    // STEP count — the loop length (global transport.numSteps, 1..16). All voice
    // editors share it, so mirror the value into every STEP input on change.
    this._el('vco-steps')?.addEventListener('change', () => {
      const input = this._el('vco-steps') as HTMLInputElement | null;
      if (!input) return;
      const oldN = Math.max(1, transport.numSteps); // before the change
      const n = Math.max(1, Math.min(16, Math.round(parseInt(input.value, 10) || 16)));
      transport.numSteps = n;
      try { localStorage.setItem('dlosy20_numSteps', String(n)); } catch (e) {}
      document.querySelectorAll<HTMLInputElement>('.vco-steps-input').forEach(el => { el.value = String(n); });
      // Re-fit every curve to the new step count by SLOT INDEX (see method).
      this._resnapToGrid(oldN);
      this.drawCurve();
    });

    // Vertical (value) grid divisions — editor + Y-quantize aid (1..16).
    this._el('vco-vgrid')?.addEventListener('change', () => {
      const input = this._el('vco-vgrid') as HTMLInputElement | null;
      if (!input) return;
      const v = Math.max(1, Math.min(16, Math.round(parseInt(input.value, 10) || 4)));
      vGridDivs = v;
      try { localStorage.setItem(VGRID_KEY, String(v)); } catch (e) {}
      document.querySelectorAll<HTMLInputElement>('.vco-vgrid-input').forEach(el => { el.value = String(v); });
      this.drawCurve();
    });

    // VCO wave buttons
    (this.root ?? document).addEventListener('click', (e) => {
      const tgt = e.target as HTMLElement;
      if (tgt.classList.contains('vco-wave-btn')) {
        this._all('.vco-wave-btn').forEach(b => b.classList.remove('active'));
        tgt.classList.add('active');
        const newWave = tgt.dataset.wave;
        const oldWave = this.waveType;
        this.waveType = newWave ?? this.waveType;

        if (this.isOscRunning) {
          // If switching to/from Drawing, need to recreate the oscillator
          const needsRecreate = (oldWave === 'drawing') !== (newWave === 'drawing');
          if (needsRecreate) {
            this.stopOsc();
            this.startOsc();
            this.applyAtPosition(this.playheadPosition);
          } else if (!this.isDrawingOsc) {
            // Standard → Standard: just change type
            this.osc.type = this.waveType;
          }
        }
      }
    });
  }

  // ===== CANVAS DRAWING =====

  drawCurve() {
    if (!this.ctx2d) return;
    const ctx = this.ctx2d!;
    const w = this.canvas!.width;
    const h = this.canvas!.height;
    const pad = 8;

    // Clear
    ctx.fillStyle = '#1c1c20';
    ctx.fillRect(0, 0, w, h);

    // Grid: one line per STEP, spread across the full width — step 0 at the left
    // edge, the last step at the right edge (x=1). No extra trailing line/cell.
    const numSteps = transport.numSteps;
    const gdenom = Math.max(1, numSteps - 1);
    ctx.strokeStyle = '#2a2a32';
    ctx.lineWidth = 1;
    for (let i = 0; i < numSteps; i++) {
      const x = pad + (i / gdenom) * (w - pad * 2);
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }

    // Horizontal grid (value divisions — adjustable via the V input).
    for (let i = 0; i <= vGridDivs; i++) {
      const y = pad + (i / vGridDivs) * (h - pad * 2);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    // Draw curve
    const curve = this.curves[this.activeParam];
    if (!curve || curve.points.length === 0) return;

    const pts = curve.points;

    ctx.strokeStyle = '#ff5964';
    ctx.lineWidth = 2;
    ctx.shadowColor = 'rgba(232, 69, 69, 0.4)';
    ctx.shadowBlur = 6;
    ctx.beginPath();

    for (let px = 0; px < w - pad * 2; px++) {
      const t = px / (w - pad * 2);
      const val = this.getNormalizedAt(pts, t);
      const x = pad + px;
      const y = pad + (1 - val) * (h - pad * 2);
      if (px === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Curvature handles — CONT mode only (STEP has no meaningful segment curve).
    // Revealed on hover / while dragging, plus a subtle hint on bent segments.
    if (this.continuousMode) {
      drawHandles(
        ctx, pts,
        (x) => pad + x * (w - pad * 2),
        (y) => pad + (1 - y) * (h - pad * 2),
        { activeSeg: this._handleDrag ?? this._hoverSeg },
      );
    }

    // Draw points (including the last step's point at the right edge).
    pts.forEach((pt) => {
      const x = pad + pt.x * (w - pad * 2);
      const y = pad + (1 - pt.y) * (h - pad * 2);

      ctx.fillStyle = '#ffb454';
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    });

    // Playhead
    this.updatePlayhead();
  }

  getNormalizedAt(pts: CurvePoint[], t: number) {
    if (pts.length === 0) return 0.5;
    return evalCurve(pts, t);
  }

  updatePlayhead() {
    const playhead = this._el('vco-playhead');
    if (!playhead || !this.canvas) return;
    const pad = 8;
    const w = this.canvas!.width;
    const x = pad + this.playheadPosition * (w - pad * 2);
    playhead.style.left = x + 'px';
  }

  // ===== CANVAS INTERACTION =====

  getCanvasCoords(e: MouseEvent) {
    const rect = this.canvas!.getBoundingClientRect();
    // Use CSS display dimensions (rect), not internal canvas resolution
    const scaleX = this.canvas!.width / rect.width;
    const scaleY = this.canvas!.height / rect.height;
    const pad = 8;
    const padCSSx = pad / scaleX;
    const padCSSy = pad / scaleY;
    const w = rect.width - padCSSx * 2;
    const h = rect.height - padCSSy * 2;
    const x = Math.max(0, Math.min(1, (e.clientX - rect.left - padCSSx) / w));
    const y = Math.max(0, Math.min(1, 1 - (e.clientY - rect.top - padCSSy) / h));
    return { x, y };
  }

  findPointAt(coords: CurvePoint, threshold = 0.03) {
    const curve = this.curves[this.activeParam];
    for (let i = 0; i < curve.points.length; i++) {
      const pt = curve.points[i];
      const dx = pt.x - coords.x;
      const dy = pt.y - coords.y;
      if (Math.sqrt(dx * dx + dy * dy) < threshold) {
        return i;
      }
    }
    return -1;
  }

  // Snap a normalized (0..1) coordinate to the editor grid (X → step columns,
  // Y → the 4 horizontal divisions) when quantize is enabled.
  _snapCoords(x: number, y: number) {
    if (!this.quantize) return { x, y };
    const denom = Math.max(1, transport.numSteps - 1); // step columns (k/(N-1), last at x=1)
    const vy = Math.max(1, vGridDivs);                 // value rows
    return { x: Math.round(x * denom) / denom, y: Math.round(y * vy) / vy };
  }

  // Re-fit every curve to the new STEP count by SLOT INDEX, non-destructively.
  // Each point lives on a grid slot (column). When the step count changes, a point
  // keeps its slot and just slides to that slot's new position slot/(newN-1). Slots
  // beyond the new range are parked in a per-curve tail (hidden, NOT deleted) and
  // restored when the count grows again — so reducing then raising STEP round-trips
  // exactly. For a step-dense curve, genuinely-new end columns get a fresh point;
  // sparse curves are left as-is (no pollution). `oldN` is the count before change.
  _resnapToGrid(oldN: number) {
    const newN = Math.max(1, transport.numSteps);
    const oldDenom = Math.max(1, oldN - 1);
    const newDenom = Math.max(1, newN - 1);
    Object.keys(this.curves).forEach(key => {
      // ADSR is a per-note amplitude envelope (time WITHIN one step), not a loop /
      // step pattern — resnapping it would wreck the envelope (and collapse it to
      // y=0 at low step counts → silence). Leave it untouched.
      if (key === 'adsr') return;
      const curve = this.curves[key] as any; // curve + optional _tail buffer
      const oldPoints: CurvePoint[] = curve.points;
      const tail: any[] = curve._tail || [];
      const dense = oldPoints.length >= oldN; // ~one point per slot = step pattern

      // Map every known point (active + hidden tail) to its slot (column) index.
      const bySlot = new Map<number, CurvePoint>();
      oldPoints.forEach(p => bySlot.set(Math.round(p.x * oldDenom), p));
      tail.forEach((p: any) => {
        const slot = (p._slot != null) ? p._slot : Math.round(p.x * oldDenom);
        if (!bySlot.has(slot)) bySlot.set(slot, p);
      });

      const active: CurvePoint[] = [];
      for (let slot = 0; slot < newN; slot++) {
        const p = bySlot.get(slot);
        if (p) {
          const np: any = { ...p, x: slot / newDenom };
          delete np._slot;
          active.push(np);
        } else if (dense && slot >= oldN) {
          // new end column on a dense pattern → add a point at the curve's value.
          active.push({ x: slot / newDenom, y: evalCurve(oldPoints, slot / newDenom) });
        }
        // else: pre-existing empty slot (sparse curve) → stays empty
      }
      // Park slots beyond the new range (retain their slot for a later restore).
      const newTail: any[] = [];
      bySlot.forEach((p, slot) => { if (slot >= newN) newTail.push({ ...p, _slot: slot }); });

      if (active.length >= 1) { curve.points = active; curve._tail = newTail; }
    });
    this.drawCurve();
  }

  onCanvasMouseDown(e: MouseEvent) {
    const coords = this.getCanvasCoords(e);
    const curve = this.curves[this.activeParam];
    // Curvature handle (bend a segment). Only in CONT mode — in STEP mode the
    // curve is sampled at discrete steps, so segment curvature is meaningless.
    if (this.continuousMode) {
      const seg = hitHandlePx(curve.points, coords,
        this.canvas!.width - 16, this.canvas!.height - 16);
      if (seg >= 0) {
        this._handleDrag = seg;
        return;
      }
    }
    const idx = this.findPointAt(coords);
    if (idx >= 0) {
      this.draggingPoint = idx;
    } else {
      // Add new point (snapped to the grid when quantize is on).
      const snapped = this._snapCoords(coords.x, coords.y);
      // Quantize guard: never stack two points on the same grid column (duplicate
      // x breaks the x-sorted interpolation). If the column is taken, grab that
      // point and move it to the clicked value instead of adding a duplicate.
      const dupe = curve.points.findIndex(p => Math.abs(p.x - snapped.x) < 1e-6);
      if (dupe >= 0) {
        curve.points[dupe].y = snapped.y;
        this.draggingPoint = dupe;
      } else {
        curve.points.push({ x: snapped.x, y: snapped.y });
        curve.points.sort((a, b) => a.x - b.x);
        this.draggingPoint = curve.points.findIndex(p => p.x === snapped.x && p.y === snapped.y);
      }
      this.drawCurve();
    }
  }

  onCanvasMouseMove(e: MouseEvent) {
    const coords = this.getCanvasCoords(e);

    // Show cursor info
    const infoEl = this._el('vco-cursor-info');
    if (infoEl) {
      const curve = this.curves[this.activeParam];
      const val = curve.min + coords.y * (curve.max - curve.min);
      infoEl.textContent = `${curve.label}: ${val.toFixed(1)} | t: ${(coords.x * 100).toFixed(0)}%`;
    }

    // Curvature-handle drag: bend the segment through the cursor
    if (this._handleDrag !== null) {
      dragHandle(this.curves[this.activeParam].points, this._handleDrag, coords.y, e.altKey);
      this.drawCurve();
      return;
    }

    if (this.draggingPoint === null) {
      // Hover reveal: show the curvature handle for the segment under the cursor —
      // CONT mode only (STEP has no meaningful segment curvature).
      const seg = this.continuousMode ? segmentAtX(this.curves[this.activeParam].points, coords.x) : null;
      if (seg !== this._hoverSeg) { this._hoverSeg = seg; this.drawCurve(); }
      return;
    }
    const curve = this.curves[this.activeParam];
    const pt = curve.points[this.draggingPoint];
    if (!pt) return;

    // Alt = fine mode: the point follows the cursor at 1/10 speed from where
    // it currently is (ui-study keySlower pattern).
    let tx = coords.x, ty = coords.y;
    if (e.altKey) {
      tx = pt.x + (coords.x - pt.x) * 0.1;
      ty = pt.y + (coords.y - pt.y) * 0.1;
    }
    // Grid quantize (skipped under Alt fine-drag so precise nudging still works).
    if (!e.altKey) {
      const snapped = this._snapCoords(tx, ty);
      tx = snapped.x; ty = snapped.y;
    }

    // First and last points: lock X position.
    // Middle points: clamp X between the neighbors so a point can never cross
    // them (crossing broke the x-sorted assumption and the curve stopped
    // rendering). Moving back re-enters the normal range automatically.
    if (this.draggingPoint === 0 || this.draggingPoint === curve.points.length - 1) {
      // First and last points are the first and last STEPS (distinct) — lock X,
      // move Y freely. The loop wraps last-step → first-step like a sequencer.
      pt.y = ty;
    } else if (this.quantize && !e.altKey) {
      // Quantized middle point: land on a grid column STRICTLY between the two
      // neighbours' columns, so two points can never share a column (which would
      // duplicate x and break interpolation). No free column → X stays, Y moves.
      const denom = Math.max(1, transport.numSteps - 1);
      const prevCol = Math.round(curve.points[this.draggingPoint - 1].x * denom);
      const nextCol = Math.round(curve.points[this.draggingPoint + 1].x * denom);
      if (nextCol - prevCol >= 2) {
        let col = Math.round(tx * denom);
        col = Math.max(prevCol + 1, Math.min(nextCol - 1, col));
        pt.x = col / denom;
      }
      pt.y = ty;
    } else {
      const eps = 0.004;
      const minX = curve.points[this.draggingPoint - 1].x + eps;
      const maxX = curve.points[this.draggingPoint + 1].x - eps;
      pt.x = Math.max(minX, Math.min(maxX, tx));
      pt.y = ty;
    }

    this.drawCurve();
  }

  onCanvasMouseUp() {
    if (this.draggingPoint !== null || this._handleDrag !== null) {
      this.draggingPoint = null;
      this._handleDrag = null;
      emit('state:changed'); // persist curve edits (points + curvature)
    }
  }

  // Right-click / double-click: reset a curvature handle to linear, or
  // delete a middle point.
  _deletePointAt(e: MouseEvent) {
    const coords = this.getCanvasCoords(e);
    const pts = this.curves[this.activeParam].points;
    if (resetHandleAtPx(pts, coords, this.canvas!.width - 16, this.canvas!.height - 16)) {
      this.drawCurve();
      emit('state:changed');
      return;
    }
    const idx = this.findPointAt(coords);
    if (idx > 0 && idx < pts.length - 1) {
      pts.splice(idx, 1);
      this.draggingPoint = null;
      this.drawCurve();
      emit('state:changed');
    }
  }

  onCanvasDoubleClick(e: MouseEvent) {
    this._deletePointAt(e);
  }

  // ===== MIDI CONTROL (8 slider points) =====

  /**
   * Set a control point from MIDI slider.
   * sliderIndex: 0-7, normalizedValue: 0.0-1.0
   */
  setControlPointFromMidi(sliderIndex: number, normalizedValue: number) {
    if (sliderIndex < 0 || sliderIndex > 7) return;
    const curve = this.curves[this.activeParam];
    if (!curve) return;

    const targetX = sliderIndex / 7;
    const threshold = 0.02;

    // Find existing point near targetX
    let found = -1;
    for (let i = 0; i < curve.points.length; i++) {
      if (Math.abs(curve.points[i].x - targetX) < threshold) {
        found = i;
        break;
      }
    }

    if (found >= 0) {
      curve.points[found].y = normalizedValue;
    } else {
      // Insert new point at correct sorted position
      const newPt = { x: targetX, y: normalizedValue };
      let insertIdx = curve.points.length;
      for (let i = 0; i < curve.points.length; i++) {
        if (curve.points[i].x > targetX) {
          insertIdx = i;
          break;
        }
      }
      curve.points.splice(insertIdx, 0, newPt);
    }

    this.drawCurve();
  }

  /**
   * Reset the active curve to an 8-point MIDI grid (evenly spaced).
   */
  resetToMidiGrid() {
    const curve = this.curves[this.activeParam];
    if (!curve) return;
    const currentY = curve.points.length > 0 ? curve.points[0].y : 0.5;
    curve.points = [];
    for (let i = 0; i < 8; i++) {
      curve.points.push({ x: i / 7, y: currentY });
    }
    this.drawCurve();
  }

  // ===== PRESET STATE (Serializable) =====

  readonly stateKey = 'vcoLoop';

  getState() {
    const curves: Record<string, { points: CurvePoint[] }> = {};
    Object.entries(this.curves).forEach(([key, curve]) => {
      curves[key] = { points: copyPoints(curve.points) };
    });
    return {
      waveType: this.waveType,
      masterVolume: this.masterVolume,
      continuousMode: this.continuousMode || false,
      enabled: this.enabled,
      phaseOffset: this.phaseOffset,
      rate: this.rate,
      quantize: this.quantize,
      curves,
      activePattern: this.activePattern,
      patternBank: this.patternBank.map(p => p ? JSON.parse(JSON.stringify(p)) : null),
      chainMode: this.chainMode,
      chainSet: Array.from(this.chainSet),
    };
  }

  setState(state: any) {
    if (!state) return;
    this.waveType = state.waveType;
    this.masterVolume = state.masterVolume;
    if (state.continuousMode !== undefined) this.continuousMode = state.continuousMode;
    if (state.enabled !== undefined) this.enabled = state.enabled;
    if (state.phaseOffset !== undefined) this.phaseOffset = state.phaseOffset;
    if (state.rate !== undefined) this.rate = state.rate;
    if (state.quantize !== undefined) this.quantize = state.quantize;
    Object.entries(state.curves).forEach(([key, saved]: [string, any]) => {
      if (this.curves[key]) {
        this.curves[key].points = copyPoints(saved.points);
      }
    });
    if (state.patternBank) {
      this.activePattern = state.activePattern || 0;
      this.patternBank = state.patternBank.map((p: any) => p ? JSON.parse(JSON.stringify(p)) : null);
    }
    // Pattern chaining
    if (state.chainMode) this.chainMode = state.chainMode;
    if (Array.isArray(state.chainSet)) this.chainSet = new Set(state.chainSet);
    // Sync the STEP/CONT mode buttons to the restored mode. buildUI() hardcodes
    // STEP as active, so without this an auto-loaded CONT session would show STEP
    // in the UI while actually playing continuously.
    this._all('.vco-mode-btn').forEach(b => {
      b.classList.toggle('active', (b.dataset.mode === 'cont') === this.continuousMode);
    });
    // CONT hides the stepOnly ADSR tab; if it was the active tab, fall back.
    if (this.continuousMode && this.curves[this.activeParam]?.stepOnly) {
      this.activeParam = 'frequency';
    }
    this.buildParamTabs();
    this.drawCurve();
    this.buildPatternBankUI();
    this.buildChainUI();
    // Update wave button UI
    this._all('.vco-wave-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.wave === this.waveType);
    });
    // Update volume slider
    const volSlider = this._el('vco-vol-slider') as HTMLInputElement | null;
    if (volSlider) volSlider.value = String(Math.round(this.masterVolume * 100));
    // ON/OFF toggle button
    const toggle = this._el('vco-toggle');
    if (toggle) {
      toggle.textContent = this.enabled ? 'ON' : 'OFF';
      toggle.classList.toggle('vco-on', this.enabled);
    }
    // PHASE slider + RATE buttons
    const phaseSlider = this._el('vco-phase-slider') as HTMLInputElement | null;
    if (phaseSlider) phaseSlider.value = String(Math.round(this.phaseOffset * 100));
    const phaseVal = this._el('vco-phase-val');
    if (phaseVal) phaseVal.textContent = Math.round(this.phaseOffset * 100) + '%';
    this._all('.vco-rate-btn').forEach(b => {
      b.classList.toggle('active', parseFloat(b.dataset.rate ?? '1') === this.rate);
    });
    this._el('vco-quantize')?.classList.toggle('vco-on', this.quantize);
    const stepsInput = this._el('vco-steps') as HTMLInputElement | null;
    if (stepsInput) stepsInput.value = String(transport.numSteps);
    const vgridInput = this._el('vco-vgrid') as HTMLInputElement | null;
    if (vgridInput) vgridInput.value = String(vGridDivs);
  }
}

/**
 * Holds the (fixed 4) independent VCO LOOP voices and fans the shared
 * transport-clock ticks out to each. Each voice has its own enable, curves,
 * wave, pattern bank and audio chain, so they can be brought in/out and shaped
 * independently. The rest of the app keeps calling `vcoLoop.*` exactly as before
 * — the manager routes those to the active (UI-focused) voice, or to all voices
 * for transport/audio events.
 *
 * Phase 1: voice 0 owns the existing editor UI and is enabled; voices 1–3 exist
 * and are wired into the audio/transport fan-out but start disabled (inert).
 * The per-voice tab UI that exposes voices 1–3 is added in the next phase.
 */
export class VCOLoopManager {
  voices: VCOLoop[] = [];
  activeIndex: number = 0;
  readonly stateKey = 'vcoLoop';
  _tabBar: HTMLElement | null = null;
  // Clipboard for COPY/PASTE between voices (one voice's full settings, minus its
  // live ON/OFF). Lets a customized voice be duplicated into another slot.
  _clipboard: any = null;
  _copyBtn: HTMLButtonElement | null = null;
  _pasteBtn: HTMLButtonElement | null = null;

  constructor(count: number) {
    for (let i = 0; i < count; i++) {
      const v = new VCOLoop();
      v.voiceId = i;
      if (i > 0) v.enabled = false; // only voice 0 sounds until the user enables others
      this.voices.push(v);
    }
  }

  get active(): VCOLoop { return this.voices[this.activeIndex]; }

  // ----- lifecycle / transport: fan out to every voice -----
  init() {
    const panel = document.getElementById('vco-loop-panel');
    if (!panel) { this.active.init(); return; }
    panel.innerHTML = '';

    // Voice tab bar (V1..VN). Each tab selects which voice the editor below edits;
    // the "on" class mirrors that voice's independent enable state.
    const tabs = document.createElement('div');
    tabs.className = 'vco-voice-tabs';
    this.voices.forEach((_v, i) => {
      const tab = document.createElement('button');
      tab.className = 'vco-voice-tab';
      tab.dataset.voice = String(i);
      tab.textContent = 'V' + (i + 1);
      tab.addEventListener('click', () => this.setActiveVoice(i));
      tabs.appendChild(tab);
    });

    // COPY / PASTE: copy the active voice's settings, paste into another tab to
    // duplicate it. PASTE is disabled until something has been copied.
    const copyBtn = document.createElement('button');
    copyBtn.className = 'vco-voice-copy';
    copyBtn.textContent = 'COPY';
    copyBtn.title = 'このVCO LOOPの設定をコピー';
    copyBtn.addEventListener('click', () => this.copyActiveVoice());
    tabs.appendChild(copyBtn);
    this._copyBtn = copyBtn;

    const pasteBtn = document.createElement('button');
    pasteBtn.className = 'vco-voice-copy';
    pasteBtn.textContent = 'PASTE';
    pasteBtn.title = 'コピーした設定をこの枠に貼り付け（複製）';
    pasteBtn.disabled = true;
    pasteBtn.addEventListener('click', () => this.pasteToActiveVoice());
    tabs.appendChild(pasteBtn);
    this._pasteBtn = pasteBtn;

    panel.appendChild(tabs);
    this._tabBar = tabs;

    // One editor container per voice; only the active one is shown.
    this.voices.forEach((v, i) => {
      const c = document.createElement('div');
      c.className = 'vco-voice-container';
      c.style.display = i === this.activeIndex ? '' : 'none';
      panel.appendChild(c);
      v.root = c;
      v.init();
    });

    // Keep the tab "on" indicators in sync when a voice's ON/OFF is toggled (the
    // toggle handler lives on the voice; its click bubbles up to the panel).
    panel.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.vco-toggle-btn')) this.updateTabBar();
    });

    this.updateTabBar();
  }

  setActiveVoice(index: number) {
    if (index < 0 || index >= this.voices.length || index === this.activeIndex) return;
    this.activeIndex = index;
    this.voices.forEach((v, i) => {
      if (v.root) v.root.style.display = i === index ? '' : 'none';
    });
    // The now-visible canvas had zero size while display:none — re-measure & redraw.
    this.active.syncCanvasSize();
    this.active.drawCurve();
    this.active.updatePlayhead();
    this.updateTabBar();
    this._syncTransport(); // easing editor follows the focused voice
  }

  updateTabBar() {
    if (!this._tabBar) return;
    this._tabBar.querySelectorAll<HTMLElement>('.vco-voice-tab').forEach((t, i) => {
      t.classList.toggle('active', i === this.activeIndex);
      t.classList.toggle('on', this.voices[i].enabled);
    });
  }

  // Copy the active voice's sound design to the clipboard.
  //
  // Only the live sound (curves, wave, volume, STEP/CONT mode, phase, rate) is
  // captured. Pattern-bank + chain NAVIGATION state (activePattern / patternBank
  // / chainMode / chainSet) is intentionally excluded: including it made PASTE
  // restore the copied slot's activePattern and rebuild the bank UI, jumping the
  // target's view back to that slot — so pasting onto pattern 2 snapped straight
  // back to pattern 1 and looked like "nothing happened" (and it also clobbered
  // the target's own saved patterns). Its live ON/OFF is excluded too, so pasting
  // never flips the target's enable state.
  copyActiveVoice() {
    const s = this.active.getState() as any;
    delete s.enabled;
    delete s.activePattern;
    delete s.patternBank;
    delete s.chainMode;
    delete s.chainSet;
    this._clipboard = s;
    if (this._pasteBtn) this._pasteBtn.disabled = false;
    if (this._copyBtn) {
      this._copyBtn.textContent = 'COPIED';
      setTimeout(() => { if (this._copyBtn) this._copyBtn.textContent = 'COPY'; }, 700);
    }
  }

  // Paste the clipboard's sound design into the active voice (current pattern).
  // Repeatable across tabs/patterns; leaves the target's pattern position intact.
  pasteToActiveVoice() {
    if (!this._clipboard) return;
    const v = this.active;
    const wasPlaying = v.isOscRunning;
    v.setState(this._clipboard); // applies curves/wave/mode; updates control UI
    // setState updates data + button states but never touches a running
    // oscillator. If this voice is currently sounding, rebuild it so the pasted
    // waveType / STEP-CONT mode take effect immediately, not only after replay.
    if (wasPlaying) {
      v.stopContinuousLoop();
      v.stopOsc();
      v.startOsc();
      v.applyAtPosition(v.playheadPosition);
      if (v.continuousMode) v.startContinuousLoop();
    }
    v.syncCanvasSize();
    v.drawCurve();
    this.updateTabBar();
    emit('state:changed');
  }

  onPlayStart() { this.voices.forEach(v => v.onPlayStart()); this._syncTransport(); }
  onPlayStop() { this.voices.forEach(v => v.onPlayStop()); this._syncTransport(); }
  onStepTick(stepIndex: number, totalSteps: number, whenMs?: number) {
    this.voices.forEach(v => v.onStepTick(stepIndex, totalSteps, whenMs));
    this._syncTransport();
  }

  // Mirror the ACTIVE voice's live phase into the shared `transport` so vco-ease
  // (the global easing editor) keeps reading a single source as before.
  _syncTransport() {
    const a = this.active;
    transport.vcoRunning = a.isOscRunning;
    transport.vcoContinuous = a.continuousMode;
    transport.vcoStepStartTime = a.stepStartTime;
    transport.vcoStepDuration = a.stepDuration;
    transport.vcoStepIndex = a.lastStepIndex;
    transport.vcoTotalSteps = a.lastTotalSteps;
  }
  // Drawing edits affect any voice currently using that drawing.
  refreshDrawingOsc() { this.voices.forEach(v => v.refreshDrawingOsc()); }
  switchDrawBuffer(slotIndex: number) { this.voices.forEach(v => v.switchDrawBuffer(slotIndex)); }

  // ----- editor / control: route to the active (focused) voice -----
  drawCurve() { this.active.drawCurve(); }
  switchParam(paramName: string) { this.active.switchParam(paramName); }
  setContinuousMode(isCont: boolean) { this.active.setContinuousMode(isCont); }
  setControlPointFromMidi(sliderIndex: number, normalizedValue: number) {
    this.active.setControlPointFromMidi(sliderIndex, normalizedValue);
  }
  get masterVolume(): number { return this.active.masterVolume; }
  set masterVolume(v: number) { this.active.masterVolume = v; }
  get continuousMode(): boolean { return this.active.continuousMode; }
  get activeParam(): string { return this.active.activeParam; }
  get waveType(): string { return this.active.waveType; }
  get isOscRunning(): boolean { return this.voices.some(v => v.isOscRunning); }
  get isDrawingOsc(): boolean { return this.active.isDrawingOsc; }

  // ----- preset state: serialize every voice (back-compat with the old single-voice format) -----
  getState() {
    return { voices: this.voices.map(v => v.getState()), active: this.activeIndex };
  }
  setState(state: any) {
    if (!state) return;
    if (Array.isArray(state.voices)) {
      state.voices.forEach((s: any, i: number) => this.voices[i]?.setState(s));
      this.activeIndex = Math.min(state.active || 0, this.voices.length - 1);
    } else {
      // Old single-voice preset → load into voice 0.
      this.voices[0].setState(state);
      this.activeIndex = 0;
    }
    // Reflect the restored active voice + per-voice enables in the UI.
    this.voices.forEach((v, i) => {
      if (v.root) v.root.style.display = i === this.activeIndex ? '' : 'none';
    });
    if (this._tabBar) {
      this.active.syncCanvasSize();
      this.active.drawCurve();
      this.updateTabBar();
    }
  }
}

export const vcoLoop = new VCOLoopManager(4);
registerSerializable(vcoLoop);
