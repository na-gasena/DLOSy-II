/**
 * DLOSy20 - VCO LOOP Easing
 * Remaps the VCO LOOP playback phase through an easing curve so the loop's
 * speed varies (accelerate / decelerate) within each bar / across steps,
 * instead of being constant.
 *
 * - CONT mode: eases the continuous phase (slope of position = speed).
 * - STEP mode: eases the per-step sampled position (non-uniform distribution).
 *
 * Modes (selected via buttons): 8 preset shapes + CUSTOM.
 * EVERY mode is freely editable: drag/add/remove control points directly on
 * the curve. A preset stays as its exact analytic shape until you edit it;
 * the first edit materializes it into points (preserved per-mode). RESET
 * restores a preset to its original shape (CUSTOM resets to a neutral curve).
 * CUSTOM is your own slot — it is never overwritten by selecting a preset.
 */
import { transport } from './transport';
import { registerSerializable } from './registry';
import { emit } from './events';
import {
  evalCurve, hitHandlePx, dragHandle, resetHandleAtPx, drawHandles, copyPoints,
  segmentAtX, CPoint,
} from './curve-editor';

// Breakpoint with optional per-segment curvature (see curve-editor.ts)
type EasePoint = CPoint;

interface EasePresetDef {
  id: string;
  label: string;
  jp: string;
}

class VCOEase {
  preset: string;
  amount: number;
  editSegments: number;
  functions: Record<string, (t: number) => number>;
  edited: Record<string, EasePoint[]>;
  presets: EasePresetDef[];
  draggingPoint: number | null;
  // Curvature-handle drag: segment index whose bend is being edited
  _handleDrag: number | null = null;
  // Segment whose handle is revealed on hover (null = none)
  _hoverSeg: number | null = null;
  _initialized: boolean = false;
  canvas: HTMLCanvasElement | null = null;
  ctx2d: CanvasRenderingContext2D | null = null;
  _resizeObserver: ResizeObserver | null = null;
  _rafId: number = 0;

  constructor() {
    this.preset = 'linear';    // current mode id (a preset id, or 'custom')
    this.amount = 1.0;         // 0..1 blend between linear and the eased curve
    this.editSegments = 8;     // sample resolution when materializing a preset

    // Easing functions: input t in [0,1] -> output in [0,1]
    this.functions = {
      linear:        (t) => t,
      easeInQuad:    (t) => t * t,
      easeOutQuad:   (t) => 1 - (1 - t) * (1 - t),
      easeInOutSine: (t) => -(Math.cos(Math.PI * t) - 1) / 2,
      easeInOutCubic:(t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
      easeInExpo:    (t) => (t === 0 ? 0 : Math.pow(2, 10 * t - 10)),
      easeOutExpo:   (t) => (t === 1 ? 1 : 1 - Math.pow(2, -10 * t)),
      easeInOutExpo: (t) =>
        t === 0 ? 0 : t === 1 ? 1 :
        t < 0.5 ? Math.pow(2, 20 * t - 10) / 2 : (2 - Math.pow(2, -20 * t + 10)) / 2,
    };

    // Per-mode edited control points. A key present here means that mode has
    // been customized and is now point-based; absent means use the analytic
    // function. CUSTOM is always point-based (it's the user's own slot).
    this.edited = {
      custom: [{ x: 0, y: 0 }, { x: 0.5, y: 0.5 }, { x: 1, y: 1 }],
    };

    // Curated presets shown as buttons (CUSTOM is added separately)
    this.presets = [
      { id: 'linear',         label: 'LINEAR',  jp: '一定' },
      { id: 'easeInQuad',     label: 'ACCEL',   jp: '加速' },
      { id: 'easeOutQuad',    label: 'DECEL',   jp: '減速' },
      { id: 'easeInOutSine',  label: 'SINE',    jp: 'S字' },
      { id: 'easeInOutCubic', label: 'SMOOTH',  jp: 'なめらか' },
      { id: 'easeInExpo',     label: 'EXP IN',  jp: '指数加速' },
      { id: 'easeOutExpo',    label: 'EXP OUT', jp: '指数減速' },
      { id: 'easeInOutExpo',  label: 'PUNCH',   jp: '急変' },
    ];

    this.draggingPoint = null;
  }

  // ===== EVALUATION =====

  // Raw eased shape (no amount blend): edited points if present, else analytic.
  rawEase(t: number) {
    const c = Math.max(0, Math.min(1, t));
    const pts = this.edited[this.preset];
    if (pts) return this.evalPoints(pts, c);
    const fn = this.functions[this.preset] || this.functions.linear;
    return fn(c);
  }

  // Effective mapping used by playback: blends the raw shape toward linear.
  apply(t: number) {
    const c = Math.max(0, Math.min(1, t));
    const eased = this.rawEase(c);
    return c + (eased - c) * this.amount;
  }

  // Piecewise interpolation over a control-point array (honors per-segment
  // curvature — see curve-editor.ts).
  evalPoints(pts: EasePoint[], t: number) {
    if (!pts || pts.length === 0) return t;
    return evalCurve(pts, t);
  }

  // Points to draw/edit for the current mode (edited points, or analytic samples).
  displayPoints() {
    return this.edited[this.preset] || this.samplePoints(this.preset);
  }

  // Sample an analytic preset into editable control points (endpoints locked).
  samplePoints(id: string): EasePoint[] {
    const fn = this.functions[id] || this.functions.linear;
    const n = this.editSegments;
    const pts: EasePoint[] = [];
    for (let i = 0; i <= n; i++) {
      const x = i / n;
      pts.push({ x, y: Math.max(0, Math.min(1, fn(x))) });
    }
    pts[0] = { x: 0, y: 0 };
    pts[n] = { x: 1, y: 1 };
    return pts;
  }

  // Convert the current mode to point-based (so it can be edited), if needed.
  materialize() {
    if (!this.edited[this.preset]) {
      this.edited[this.preset] = this.samplePoints(this.preset);
    }
    return this.edited[this.preset];
  }

  init() {
    if (this._initialized) return; // idempotent: safe if called twice
    this._initialized = true;
    this.buildUI();
    this.startAnimation();
  }

  // ===== UI =====

  buildUI() {
    const container = document.getElementById('center-tab-ease');
    if (!container) return;

    container.innerHTML = `
      <div class="panel-title">
        VCO LOOP SPEED / EASING
        <span class="ease-note">STEP / CONT 両モードに適用 · 全モード編集可</span>
      </div>
      <div class="ease-presets" id="ease-presets"></div>
      <div class="ease-canvas-wrap">
        <canvas id="ease-canvas" width="600" height="220"></canvas>
      </div>
      <div class="ease-hint-row">
        <span class="ease-hint" id="ease-hint"></span>
        <button class="small-btn" id="ease-reset" title="このモードを初期形状に戻す">RESET</button>
      </div>
      <div class="ease-amount-row">
        <span class="cv-label">AMOUNT</span>
        <input type="range" id="ease-amount" class="fx-slider" min="0" max="100" step="1" value="${Math.round(this.amount * 100)}">
        <span id="ease-amount-val" class="cv-val">${Math.round(this.amount * 100)}%</span>
      </div>
    `;

    // Preset buttons
    const presetRow = container.querySelector('#ease-presets');
    this.presets.forEach((p) => {
      const btn = document.createElement('button');
      btn.className = 'ease-preset-btn';
      btn.dataset.preset = p.id;
      btn.innerHTML = `<span class="ease-preset-label">${p.label}</span><span class="ease-preset-jp">${p.jp}</span>`;
      btn.addEventListener('click', () => this.setMode(p.id));
      presetRow?.appendChild(btn);
    });
    // CUSTOM (own slot) button
    const customBtn = document.createElement('button');
    customBtn.className = 'ease-preset-btn ease-preset-custom';
    customBtn.dataset.preset = 'custom';
    customBtn.innerHTML = `<span class="ease-preset-label">✎ CUSTOM</span><span class="ease-preset-jp">自作</span>`;
    customBtn.addEventListener('click', () => this.setMode('custom'));
    presetRow?.appendChild(customBtn);

    // Amount slider
    container.querySelector('#ease-amount')?.addEventListener('input', (e) => {
      const target = e.target as HTMLInputElement;
      this.amount = parseInt(target.value, 10) / 100;
      const valEl = document.getElementById('ease-amount-val');
      if (valEl) valEl.textContent = target.value + '%';
      this.draw();
      emit('state:changed');
    });

    // Reset current mode
    container.querySelector('#ease-reset')?.addEventListener('click', () => this.resetCurrent());

    // Canvas + editing
    this.canvas = container.querySelector('#ease-canvas') as HTMLCanvasElement | null;
    this.ctx2d = this.canvas ? this.canvas!.getContext('2d') : null;
    if (this.canvas) {
      this.canvas!.classList.add('editable');
      this.canvas!.addEventListener('mousedown', (e) => this.onCanvasDown(e));
      this.canvas!.addEventListener('mousemove', (e) => this.onCanvasMove(e));
      window.addEventListener('mouseup', () => this.onCanvasUp());
      this.canvas!.addEventListener('mouseleave', () => {
        if (this._hoverSeg !== null) { this._hoverSeg = null; this.draw(); }
      });
      this.canvas!.addEventListener('dblclick', (e) => this.onCanvasDblClick(e));
      // Right-click = delete point (unified across all curve editors)
      this.canvas!.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this.onCanvasDblClick(e);
      });
      if (window.ResizeObserver) {
        this._resizeObserver = new ResizeObserver(() => {
          this.syncCanvasSize();
          this.draw();
        });
        this._resizeObserver.observe(this.canvas!.parentElement!);
      }
      // Also re-measure on window resize: when this tab is popped into a float
      // window the panel layout fires resize() after the move settles, so the
      // graph re-fits even if the ResizeObserver's delivery is missed.
      window.addEventListener('resize', () => {
        this.syncCanvasSize();
        this.draw();
      });
    }

    this.updateButtons();
    this.updateHint();
    this.syncCanvasSize();
    this.draw();
  }

  setMode(id: string) {
    if (id !== 'custom' && !this.functions[id]) return;
    this.preset = id;
    this.updateButtons();
    this.updateHint();
    this.draw();
    emit('state:changed');
  }

  // Restore the current mode: presets revert to their analytic shape; CUSTOM
  // resets to a neutral curve. Never affects other modes.
  resetCurrent() {
    if (this.preset === 'custom') {
      this.edited.custom = [{ x: 0, y: 0 }, { x: 0.5, y: 0.5 }, { x: 1, y: 1 }];
    } else {
      delete this.edited[this.preset];
    }
    this.draggingPoint = null;
    this.updateButtons();
    this.updateHint();
    this.draw();
    emit('state:changed');
  }

  updateButtons() {
    document.querySelectorAll<HTMLElement>('.ease-preset-btn').forEach((b) => {
      const id = b.dataset.preset ?? "";
      b.classList.toggle('active', id === this.preset);
      // Mark presets that have been edited from their default (not custom).
      b.classList.toggle('modified', id !== 'custom' && !!this.edited[id]);
    });
  }

  updateHint() {
    const hint = document.getElementById('ease-hint');
    if (!hint) return;
    const editedNow = this.preset === 'custom' || !!this.edited[this.preset];
    const tag = editedNow ? '編集済み — ' : '';
    hint.textContent = tag + 'ドラッグで移動 / クリックで追加 / ダブルクリックで削除（両端は固定）';
  }

  syncCanvasSize() {
    if (!this.canvas) return;
    const rect = this.canvas!.getBoundingClientRect();
    const w = Math.max(Math.round(rect.width), 200);
    const h = Math.max(Math.round(rect.height), 120);
    if (this.canvas!.width !== w || this.canvas!.height !== h) {
      this.canvas!.width = w;
      this.canvas!.height = h;
    }
  }

  // ===== CANVAS EDITING (all modes) =====

  getCoords(e: MouseEvent) {
    const rect = this.canvas!.getBoundingClientRect();
    const scaleX = this.canvas!.width / rect.width;
    const scaleY = this.canvas!.height / rect.height;
    const pad = 16;
    const padCSSx = pad / scaleX;
    const padCSSy = pad / scaleY;
    const w = rect.width - padCSSx * 2;
    const h = rect.height - padCSSy * 2;
    const x = Math.max(0, Math.min(1, (e.clientX - rect.left - padCSSx) / w));
    const y = Math.max(0, Math.min(1, 1 - (e.clientY - rect.top - padCSSy) / h));
    return { x, y };
  }

  findPoint(pts: EasePoint[], coords: EasePoint, threshold = 0.045) {
    for (let i = 0; i < pts.length; i++) {
      const dx = pts[i].x - coords.x;
      const dy = pts[i].y - coords.y;
      if (Math.sqrt(dx * dx + dy * dy) < threshold) return i;
    }
    return -1;
  }

  findPointByX(pts: EasePoint[], x: number, threshold: number) {
    for (let i = 0; i < pts.length; i++) {
      if (Math.abs(pts[i].x - x) < threshold) return i;
    }
    return -1;
  }

  onCanvasDown(e: MouseEvent) {
    const coords = this.getCoords(e);
    const pts = this.materialize(); // any mode becomes editable on first touch
    const wasEdited = this.edited[this.preset] === pts; // always true after materialize

    // 0. Curvature handle (sits on the curve between points).
    const seg = hitHandlePx(pts, coords,
      this.canvas!.width - 32, this.canvas!.height - 32);
    if (seg >= 0) {
      this._handleDrag = seg;
      this.afterStructureChange();
      return;
    }

    // 1. Grab an existing point by radius (pure drag-start).
    let idx = this.findPoint(pts, coords);
    if (idx >= 0) {
      if (idx === 0 || idx === pts.length - 1) { this.draggingPoint = null; return; }
      this.draggingPoint = idx;
      this.afterStructureChange();
      return;
    }

    // 2. Same column as an existing point: adopt it (avoid duplicate-x).
    idx = this.findPointByX(pts, coords.x, 0.02);
    if (idx >= 0) {
      if (idx === 0 || idx === pts.length - 1) { this.draggingPoint = null; return; }
      pts[idx].y = coords.y;
      this.draggingPoint = idx;
      this.afterStructureChange();
      return;
    }

    // 3. Add a new point.
    const pt = { x: coords.x, y: coords.y };
    pts.push(pt);
    pts.sort((a, b) => a.x - b.x);
    this.draggingPoint = pts.indexOf(pt);
    this.afterStructureChange();
  }

  onCanvasMove(e: MouseEvent) {
    // Curvature-handle drag: bend the segment through the cursor
    if (this._handleDrag !== null) {
      const hp = this.edited[this.preset];
      if (hp) {
        dragHandle(hp, this._handleDrag, this.getCoords(e).y, e.altKey);
        this.draw();
      }
      return;
    }

    if (this.draggingPoint === null) {
      // Hover reveal: show the handle only for the segment under the cursor
      const pts = this.displayPoints();
      const seg = segmentAtX(pts, this.getCoords(e).x);
      if (seg !== this._hoverSeg) { this._hoverSeg = seg; this.draw(); }
      return;
    }
    const pts = this.edited[this.preset];
    const i = this.draggingPoint;
    if (!pts || i <= 0 || i >= pts.length - 1) return; // never move endpoints
    const coords = this.getCoords(e);
    // Alt = fine mode (×0.1 pursuit toward the cursor)
    let tx = coords.x, ty = coords.y;
    if (e.altKey) {
      tx = pts[i].x + (coords.x - pts[i].x) * 0.1;
      ty = pts[i].y + (coords.y - pts[i].y) * 0.1;
    }
    const minX = pts[i - 1].x + 0.001;
    const maxX = pts[i + 1].x - 0.001;
    pts[i].x = Math.max(minX, Math.min(maxX, tx));
    pts[i].y = ty;
    this.draw();
  }

  onCanvasUp() {
    if (this.draggingPoint !== null || this._handleDrag !== null) {
      this.draggingPoint = null;
      this._handleDrag = null;
      emit('state:changed');
    }
  }

  onCanvasDblClick(e: MouseEvent) {
    const pts = this.edited[this.preset];
    if (!pts) return;
    const coords = this.getCoords(e);
    // Reset a curvature handle to linear before considering point deletion
    if (resetHandleAtPx(pts, coords, this.canvas!.width - 32, this.canvas!.height - 32)) {
      this.afterStructureChange();
      return;
    }
    const idx = this.findPoint(pts, coords);
    if (idx > 0 && idx < pts.length - 1) {
      pts.splice(idx, 1);
      this.afterStructureChange();
    }
  }

  // Redraw + refresh "modified" markers/hint after a structural edit.
  afterStructureChange() {
    this.updateButtons();
    this.updateHint();
    this.draw();
    emit('state:changed');
  }

  // ===== VISUALIZATION =====

  // Only redraws while the tab is visible AND playback is running (to animate
  // the live dot). Static state changes redraw directly via draw(); idle frames
  // do no work, so this loop is cheap when nothing is moving.
  startAnimation() {
    const loop = () => {
      const tab = document.getElementById('center-tab-ease');
      const active = tab && tab.classList.contains('active');
      const playing = transport.vcoRunning;
      if (active && playing) {
        this.syncCanvasSize();
        this.draw();
      }
      this._rafId = requestAnimationFrame(loop);
    };
    this._rafId = requestAnimationFrame(loop);
  }

  draw() {
    if (!this.ctx2d || !this.canvas) return;
    const ctx = this.ctx2d!;
    const w = this.canvas!.width;
    const h = this.canvas!.height;
    const pad = 16;
    const iw = w - pad * 2;
    const ih = h - pad * 2;
    const X = (t: number) => pad + t * iw;
    const Y = (v: number) => pad + (1 - v) * ih;

    ctx.fillStyle = '#1c1c20';
    ctx.fillRect(0, 0, w, h);

    // Grid
    ctx.strokeStyle = '#2a2a32';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      ctx.beginPath(); ctx.moveTo(X(i / 4), pad); ctx.lineTo(X(i / 4), pad + ih); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(pad, Y(i / 4)); ctx.lineTo(pad + iw, Y(i / 4)); ctx.stroke();
    }

    // Linear reference (faint diagonal)
    ctx.strokeStyle = 'rgba(138, 138, 150, 0.35)';
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(X(0), Y(0)); ctx.lineTo(X(1), Y(1)); ctx.stroke();
    ctx.setLineDash([]);

    const steps = Math.max(iw, 64);

    // Effective (blended by amount) curve — faint when amount < 100%
    if (this.amount < 0.999) {
      ctx.strokeStyle = 'rgba(0, 229, 255, 0.35)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        if (i === 0) ctx.moveTo(X(t), Y(this.apply(t)));
        else ctx.lineTo(X(t), Y(this.apply(t)));
      }
      ctx.stroke();
    }

    // Raw eased shape — bright cyan
    ctx.strokeStyle = '#22d9f2';
    ctx.lineWidth = 2.5;
    ctx.shadowColor = 'rgba(0, 229, 255, 0.4)';
    ctx.shadowBlur = 6;
    ctx.beginPath();
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      if (i === 0) ctx.moveTo(X(t), Y(this.rawEase(t)));
      else ctx.lineTo(X(t), Y(this.rawEase(t)));
    }
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Editable control points (shown for every mode)
    const pts = this.displayPoints();

    // Curvature handles — revealed on hover / drag; subtle hint on bent ones
    drawHandles(ctx, pts, X, Y, { activeSeg: this._handleDrag ?? this._hoverSeg });

    pts.forEach((pt, i) => {
      const locked = i === 0 || i === pts.length - 1;
      ctx.fillStyle = locked ? '#6c7280' : '#ffb454';
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(X(pt.x), Y(pt.y), locked ? 4 : 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    });

    // Live playhead dot (CONT: interpolated; STEP: discrete)
    if (transport.vcoRunning) {
      const linearPhase = this._currentLinearPhase();
      const easedPhase = this.apply(linearPhase);
      const dotX = X(linearPhase);
      const dotY = Y(easedPhase);

      ctx.strokeStyle = 'rgba(68, 214, 44, 0.4)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(dotX, pad + ih); ctx.lineTo(dotX, dotY); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(pad, dotY); ctx.lineTo(dotX, dotY); ctx.stroke();

      ctx.fillStyle = '#3ddc84';
      ctx.shadowColor = 'rgba(68, 214, 44, 0.8)';
      ctx.shadowBlur = 8;
      ctx.beginPath();
      ctx.arc(dotX, dotY, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
    }

    // Axis labels
    ctx.fillStyle = '#6c7280';
    ctx.font = '9px "Share Tech Mono", monospace';
    ctx.fillText('TIME →', pad + iw - 46, pad + ih + 12);
    ctx.save();
    ctx.translate(pad - 6, pad + 6);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText('← POS', -34, 0);
    ctx.restore();
  }

  _currentLinearPhase() {
    const total = transport.vcoTotalSteps || 16;
    if (transport.vcoContinuous) {
      const elapsed = performance.now() - transport.vcoStepStartTime;
      const frac = transport.vcoStepDuration > 0 ? Math.min(elapsed / transport.vcoStepDuration, 1) : 0;
      return Math.max(0, Math.min(1, (transport.vcoStepIndex + frac) / total));
    }
    return Math.max(0, Math.min(1, (transport.vcoStepIndex || 0) / total));
  }

  // ===== PRESET PERSISTENCE HOOKS (Serializable) =====

  readonly stateKey = 'vcoEase';

  getState() {
    const edited: Record<string, EasePoint[]> = {};
    Object.entries(this.edited).forEach(([k, pts]) => {
      edited[k] = copyPoints(pts); // preserves per-segment curvature
    });
    return { preset: this.preset, amount: this.amount, edited };
  }

  setState(state: any) {
    if (!state) return;
    if (state.edited && typeof state.edited === 'object') {
      const restored: Record<string, EasePoint[]> = {};
      Object.entries(state.edited).forEach(([k, pts]) => {
        if (Array.isArray(pts)) restored[k] = copyPoints(pts);
      });
      // CUSTOM must always exist
      if (!restored.custom) restored.custom = [{ x: 0, y: 0 }, { x: 0.5, y: 0.5 }, { x: 1, y: 1 }];
      this.edited = restored;
    } else if (state.customPoints) {
      // Backward-compat with the earlier single-custom format
      this.edited.custom = state.customPoints.map((p: any) => ({ x: p.x, y: p.y }));
    }
    if (state.preset && (state.preset === 'custom' || this.functions[state.preset])) this.preset = state.preset;
    if (typeof state.amount === 'number') this.amount = state.amount;

    const slider = document.getElementById('ease-amount') as HTMLInputElement | null;
    const valEl = document.getElementById('ease-amount-val');
    if (slider) slider.value = String(Math.round(this.amount * 100));
    if (valEl) valEl.textContent = Math.round(this.amount * 100) + '%';
    this.updateButtons();
    this.updateHint();
    this.draw();
  }
}

export const vcoEase = new VCOEase();
registerSerializable(vcoEase);

// 初期化は app.js が DOMContentLoaded で vcoEase.init() を呼ぶ。
// （旧コードはモジュール評価時に init() を eager 実行していたが、それが
//  循環 import 中に未初期化の vcoLoop へ触れて TDZ エラーを起こすため削除。）
