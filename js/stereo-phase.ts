/**
 * DLOSy20 - Stereo Phase (Lissajous Pad)
 *
 * A live XY oscilloscope of the master output (X = L, Y = R) that IS the
 * control: on a Lissajous synth the L/R phase difference is the figure —
 *
 *    θ = 0°   → a 45° line        (L == R)
 *    θ = 45°  → a tilted ellipse
 *    θ = 90°  → a circle
 *    θ = 180° → the opposite 45° line (anti-phase)
 *
 * Two modes:
 *  - DEG (default): you set a phase ANGLE. The R-channel delay is continuously
 *    recomputed from the currently playing pitch (delay = θ/360 / f), so the
 *    figure keeps its shape as the pitch moves — "always 90°" is simply θ=90°.
 *  - Δms: a fixed R-channel time offset (frequency-dependent phase, the
 *    classic Haas / widener behaviour).
 *
 * GUI clarity: a dashed GHOST ellipse always shows the TARGET shape for the
 * current setting (what a sine would draw), so the pad reads even in silence;
 * quick chips set 0/45/90/135/180°; the readout shows θ / Δt / tracked Hz.
 * Drag up-down opens/closes the figure, Alt = fine, double-click resets.
 */
import { audioEngine } from './audio-engine';
import { registerSerializable } from './registry';
import { emit } from './events';

const MAX_DELAY_MS = 8;      // Δms mode ceiling
const MAX_DELAY_S = 0.05;    // hard clamp (phaseDelayR max)
const CHIP_DEGS = [0, 90, 180, 270];

const wrap360 = (v: number) => ((v % 360) + 360) % 360;

class StereoPhase {
  readonly stateKey = 'stereoPhase';

  mode: 'deg' | 'ms' = 'deg';
  deg = 0;   // DEG mode: phase angle 0..360 (cyclic — 360 ≡ 0)
  ms = 0;    // Δms mode: fixed delay 0..MAX_DELAY_MS
  private _lastDelay = -1; // for smooth-wrap detection

  private canvas: HTMLCanvasElement | null = null;
  private ctx2d: CanvasRenderingContext2D | null = null;
  private readout: HTMLElement | null = null;
  private _bufL: Float32Array | null = null;
  private _bufR: Float32Array | null = null;
  private _rafId = 0;
  private _trackTimer: ReturnType<typeof setInterval> | null = null;
  private _dragStartY = 0;
  private _dragStartVal = 0;
  private _dragging = false;
  private _resizeObserver: ResizeObserver | null = null;

  init() {
    const container = document.getElementById('center-tab-phase');
    if (!container) return;

    container.innerHTML = `
      <div class="panel-title">
        STEREO PHASE
        <span class="ease-note">図形＝L/R位相差 · 上下ドラッグで開閉（Alt=微調整） · W-clickで0°</span>
      </div>
      <div class="phase-controls">
        <div class="phase-mode">
          <button id="phase-mode-deg" class="small-btn phase-mode-btn active" title="位相角で指定 — 音程が動いても角度を維持（追従）">DEG 追従</button>
          <button id="phase-mode-ms" class="small-btn phase-mode-btn" title="固定時間差（Haas系 — 位相角は周波数で変わる）">Δms 固定</button>
        </div>
        <div class="phase-chips" id="phase-chips">
          ${CHIP_DEGS.map(d => `<button class="phase-chip" data-deg="${d}">${d}°</button>`).join('')}
        </div>
      </div>
      <div class="phase-pad-wrap">
        <canvas id="phase-scope" width="360" height="360"></canvas>
        <div class="phase-readout" id="phase-readout"></div>
        <div class="phase-hint">↕</div>
      </div>
    `;

    this.canvas = container.querySelector('#phase-scope') as HTMLCanvasElement;
    this.ctx2d = this.canvas.getContext('2d');
    this.readout = container.querySelector('#phase-readout');

    this.canvas.addEventListener('pointerdown', (e) => this._onDown(e));
    this.canvas.addEventListener('pointermove', (e) => this._onMove(e));
    this.canvas.addEventListener('pointerup', (e) => this._onUp(e));
    this.canvas.addEventListener('dblclick', () => this._reset());

    // Mode buttons
    container.querySelector('#phase-mode-deg')?.addEventListener('click', () => this._setMode('deg'));
    container.querySelector('#phase-mode-ms')?.addEventListener('click', () => this._setMode('ms'));

    // Quick chips (DEG mode)
    container.querySelectorAll<HTMLElement>('.phase-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        this._setMode('deg');
        this.deg = parseFloat(chip.dataset.deg ?? '0');
        this._syncUI();
        emit('state:changed');
      });
    });

    if (window.ResizeObserver) {
      this._resizeObserver = new ResizeObserver(() => this._syncSize());
      this._resizeObserver.observe(this.canvas.parentElement!);
    }
    this._syncSize();
    this._syncUI();
    this._startLoop();

    // Pitch-tracking loop: keep the R delay in sync with the playing pitch.
    // Runs regardless of tab visibility — the AUDIO must track even when the
    // pad is hidden. Cheap (one setTargetAtTime per tick).
    this._trackTimer = setInterval(() => this._applyDelay(), 33);
  }

  // ===== mode / value plumbing =====

  private _setMode(m: 'deg' | 'ms') {
    if (this.mode !== m) {
      this.mode = m;
      emit('state:changed');
    }
    this._syncUI();
  }

  /** Reference pitch for DEG mode / the θ readout (fallback 220 Hz). */
  private _refHz(): number {
    const f = audioEngine.currentPitchHz;
    return (f && f > 1) ? f : 220;
  }

  /** Current target delay in seconds for the audio stage.
   *  DEG mode wraps the ANGLE into [0,360) so the delay stays inside one period
   *  ([0, 1/f)); since a full-period delay is phase-identical to 0, the 360→0
   *  wrap is seamless (same figure, near-zero click). */
  private _delaySec(): number {
    if (this.mode === 'deg') {
      return Math.min(MAX_DELAY_S, (wrap360(this.deg) / 360) / this._refHz());
    }
    return Math.min(MAX_DELAY_S, this.ms / 1000);
  }

  /** Effective phase angle at the reference pitch (for ghost + readout). */
  private _effDeg(): number {
    if (this.mode === 'deg') return wrap360(this.deg);
    return (this.ms / 1000) * this._refHz() * 360; // may exceed 360 at high f
  }

  private _applyDelay() {
    const d = audioEngine.phaseDelayR;
    if (!d || !audioEngine.ctx) return;
    const target = this._delaySec();
    const now = audioEngine.ctx.currentTime;
    const period = 1 / this._refHz();
    // A large jump = a 360↔0 wrap (or a big pitch jump). Ramping it would sweep
    // the delay through every value between = an audible chirp. Set it instantly
    // instead: at a wrap the phase is equivalent, so the seam is inaudible.
    if (this._lastDelay < 0 || Math.abs(target - this._lastDelay) > period * 0.5) {
      d.delayTime.cancelScheduledValues(now);
      d.delayTime.setValueAtTime(target, now);
    } else {
      d.delayTime.setTargetAtTime(target, now, 0.02);
    }
    this._lastDelay = target;
  }

  // ===== interaction =====

  private _onDown(e: PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    this.canvas!.setPointerCapture(e.pointerId);
    this._dragging = true;
    this._dragStartY = e.clientY;
    this._dragStartVal = this.mode === 'deg' ? this.deg : this.ms;
    this.canvas!.classList.add('dragging');
  }

  private _onMove(e: PointerEvent) {
    if (!this._dragging) return;
    const h = this.canvas!.getBoundingClientRect().height || 360;
    const fine = e.altKey ? 0.15 : 1;
    const dy = (this._dragStartY - e.clientY) / h; // up = open
    if (this.mode === 'deg') {
      // Full pad height ≈ one 360° turn; wraps so you can spin endlessly.
      this.deg = wrap360(this._dragStartVal + dy * 360 * fine);
    } else {
      this.ms = Math.max(0, Math.min(MAX_DELAY_MS, this._dragStartVal + dy * MAX_DELAY_MS * fine));
    }
    this._applyDelay();
    this._syncUI();
  }

  private _onUp(e: PointerEvent) {
    if (!this._dragging) return;
    this.canvas!.releasePointerCapture(e.pointerId);
    this._dragging = false;
    this.canvas!.classList.remove('dragging');
    emit('state:changed');
  }

  private _reset() {
    if (this.mode === 'deg') this.deg = 0; else this.ms = 0;
    this._applyDelay();
    this._syncUI();
    emit('state:changed');
  }

  // ===== UI sync =====

  private _syncUI() {
    // Mode buttons
    document.getElementById('phase-mode-deg')?.classList.toggle('active', this.mode === 'deg');
    document.getElementById('phase-mode-ms')?.classList.toggle('active', this.mode === 'ms');
    // Chips: highlight the matching angle (DEG mode only)
    document.querySelectorAll<HTMLElement>('.phase-chip').forEach(chip => {
      const d = parseFloat(chip.dataset.deg ?? '-1');
      chip.classList.toggle('active', this.mode === 'deg' && Math.abs(d - this.deg) < 0.5);
    });
    this._updateReadout();
  }

  private _updateReadout() {
    if (!this.readout) return;
    const f = this._refHz();
    const dtMs = this._delaySec() * 1000;
    if (this.mode === 'deg') {
      this.readout.innerHTML =
        `<b>θ ${this.deg.toFixed(0)}°</b><span>Δ${dtMs.toFixed(2)}ms · ${Math.round(f)}Hz 追従</span>`;
    } else {
      const eff = this._effDeg();
      this.readout.innerHTML =
        `<b>Δ${this.ms.toFixed(2)}ms</b><span>≈${Math.round(eff)}° @${Math.round(f)}Hz</span>`;
    }
  }

  // ===== live XY scope =====

  private _syncSize() {
    if (!this.canvas) return;
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(rect.width * dpr);
    const h = Math.round(rect.height * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  private _startLoop() {
    const loop = () => {
      const tab = document.getElementById('center-tab-phase');
      if (tab && tab.classList.contains('active')) {
        this._draw();
        this._updateReadout(); // tracked Hz changes while playing
      }
      this._rafId = requestAnimationFrame(loop);
    };
    this._rafId = requestAnimationFrame(loop);
  }

  private _draw() {
    const ctx = this.ctx2d;
    if (!ctx || !this.canvas) return;
    this._syncSize();
    const dpr = window.devicePixelRatio || 1;
    const W = this.canvas.width, H = this.canvas.height;
    const cx = W / 2, cy = H / 2;
    const R = Math.min(W, H) * 0.44;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0b0c10';
    ctx.fillRect(0, 0, W, H);

    // Grid + axes
    ctx.strokeStyle = 'rgba(154,160,174,0.12)';
    ctx.lineWidth = 1 * dpr;
    ctx.beginPath();
    ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R);
    ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.stroke();

    // GHOST: the target Lissajous shape for the current setting — what a sine
    // pair would draw. Makes the control legible even in silence.
    const theta = (this._effDeg() * Math.PI) / 180;
    const gR = R * 0.72;
    ctx.strokeStyle = 'rgba(255,180,84,0.45)'; // amber
    ctx.lineWidth = 1.2 * dpr;
    ctx.setLineDash([5 * dpr, 4 * dpr]);
    ctx.beginPath();
    const STEPS = 96;
    for (let i = 0; i <= STEPS; i++) {
      const t = (i / STEPS) * Math.PI * 2;
      const x = cx + Math.sin(t) * gR;
      const y = cy - Math.sin(t - theta) * gR;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    // Live trace
    const aL = audioEngine.scopeAnalyserL;
    const aR = audioEngine.scopeAnalyserR;
    if (aL && aR) {
      const n = aL.fftSize;
      if (!this._bufL || this._bufL.length !== n) {
        this._bufL = new Float32Array(n);
        this._bufR = new Float32Array(n);
      }
      // cast: lib's getFloatTimeDomainData signature varies by TS lib version.
      aL.getFloatTimeDomainData(this._bufL as any);
      aR.getFloatTimeDomainData(this._bufR! as any);

      const L = this._bufL, Rr = this._bufR!;
      const pts = Math.min(n, 1200);

      // Auto-scale so the figure fills the pad regardless of level — the phase
      // SHAPE is what matters, not the amplitude. Clamped so silence/noise
      // doesn't blow up.
      let peak = 0;
      for (let i = 0; i < pts; i++) {
        const a = Math.abs(L[i]), b = Math.abs(Rr[i]);
        if (a > peak) peak = a;
        if (b > peak) peak = b;
      }
      if (peak > 0.02) {
        const gain = Math.min(18, 0.92 / Math.max(peak, 0.05)) * 0.78; // ≈ghost scale
        ctx.strokeStyle = '#22d9f2';
        ctx.lineWidth = 1.6 * dpr;
        ctx.shadowColor = 'rgba(34,217,242,0.5)';
        ctx.shadowBlur = 6 * dpr;
        ctx.beginPath();
        for (let i = 0; i < pts; i++) {
          const x = cx + L[i] * gain * R;
          const y = cy - Rr[i] * gain * R;
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.shadowBlur = 0;
      }
    }

    // Corner labels
    ctx.fillStyle = 'rgba(154,160,174,0.6)';
    ctx.font = `${11 * dpr}px "Share Tech Mono", monospace`;
    ctx.fillText('L →', cx + R - 26 * dpr, cy + 14 * dpr);
    ctx.fillText('R ↑', cx + 6 * dpr, cy - R + 14 * dpr);
  }

  // ===== preset state =====
  getState() { return { mode: this.mode, deg: this.deg, ms: this.ms }; }
  setState(state: any) {
    if (!state) return;
    if (state.mode === 'deg' || state.mode === 'ms') this.mode = state.mode;
    if (typeof state.deg === 'number') this.deg = wrap360(state.deg);
    if (typeof state.ms === 'number') this.ms = Math.max(0, Math.min(MAX_DELAY_MS, state.ms));
    // Back-compat with the first prototype ({ amount: 0..1 } = ms-based)
    if (typeof state.amount === 'number' && state.deg === undefined) {
      this.mode = 'ms';
      this.ms = Math.max(0, Math.min(MAX_DELAY_MS, state.amount * MAX_DELAY_MS));
    }
    this._applyDelay();
    this._syncUI();
  }
}

export const stereoPhase = new StereoPhase();
registerSerializable(stereoPhase);
