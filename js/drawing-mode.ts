/**
 * DLOSy20 - Drawing Mode
 * Draw shapes on canvas → convert to LR waveform (XYscope principle)
 * Supports multiple drawing slots and per-step waveform assignment
 */
import { audioEngine } from './audio-engine';
import { vcoLoop } from './vco-loop';
import { arpeggiator } from './arpeggiator';
import { registerSerializable } from './registry';
import { emit } from './events';
import {
  curveShape, hitHandlePx, dragHandle, resetHandleAtPx, drawHandles, copyPoints,
  segmentAtX,
} from './curve-editor';

interface DrawPoint {
  x: number;
  y: number;
  newStroke?: boolean;
  /** Segment curvature (scan-profile points only; see curve-editor.ts) */
  c?: number;
}

interface DrawSlot {
  name: string;
  points: DrawPoint[];
  waveX: number[];
  waveY: number[];
  // Scan-speed profile φ:[0,1]→[0,1]. Maps even output-sample fraction → position
  // along the drawn path (arc length). Default (absent) = linear (constant speed).
  // A non-linear curve re-times the traversal of the path → reshapes the L/R
  // waveform = timbre, while leaving the XY (Lissajous) shape unchanged.
  scanProfile?: DrawPoint[];
  // Intra-cycle sine ripple on the scan position (PM-like). rate = cycles per
  // waveform period (0 = off), depth = amount (0..~1). Strong values fold.
  scanRippleRate?: number;
  scanRippleDepth?: number;
}

interface DrawPatternSlot {
  visibleSlotCount: number;
  slots: DrawSlot[];
}

class DrawingMode {
  slots: DrawSlot[];
  activeSlot: number;
  visibleSlotCount: number;
  isDrawing: boolean;
  autoSlotCycle: boolean;
  activePattern: number;
  patternBank: (DrawPatternSlot | null)[];
  toolMode: string;
  eraserRadius: number;
  canvas: HTMLCanvasElement | null;
  ctx2d: CanvasRenderingContext2D | null;
  canvasSize: number;
  previewOsc: AudioBufferSourceNode | null;
  previewGain: GainNode | null;
  isPreviewPlaying: boolean;
  waveResolution: number;
  // Scan-speed profile editor (per active slot)
  _scanCanvas: HTMLCanvasElement | null = null;
  _scanCtx: CanvasRenderingContext2D | null = null;
  _scanDragIdx: number | null = null;
  // Curvature-handle drag: segment index whose bend is being edited
  _scanHandleDrag: number | null = null;
  // Segment whose handle is revealed on hover (null = none)
  _scanHoverSeg: number | null = null;
  _previewRO: ResizeObserver | null = null;

  constructor() {
    // Drawing slots (16 slots, display toggled between 8/16)
    this.slots = [];
    for (let i = 0; i < 16; i++) {
      this.slots.push({ name: `Draw ${i + 1}`, points: [], waveX: [], waveY: [] });
    }
    this.activeSlot = 0;
    this.visibleSlotCount = 8; // 8 or 16
    this.isDrawing = false;
    this.autoSlotCycle = false; // Auto-cycle through slots on each step

    // Pattern bank (8 preset slots of 16 drawings each)
    this.activePattern = 0;
    this.patternBank = [];
    for (let i = 0; i < 8; i++) {
      this.patternBank.push(null);
    }

    // Tool state
    this.toolMode = 'draw'; // 'draw' or 'erase'
    this.eraserRadius = 15;

    // Canvas
    this.canvas = null;
    this.ctx2d = null;
    this.canvasSize = 256;

    // Audio: real-time preview oscillator using PeriodicWave
    this.previewOsc = null;
    this.previewGain = null;
    this.isPreviewPlaying = false;

    // Waveform resolution
    this.waveResolution = 256;
  }

  init() {
    this.buildUI();
    this.bindControls();
    this.buildPatternBankUI();
    // Keep the preview/scan canvases crisp. They are CSS-stretched (width:100%),
    // so their backing store must track the real display size × DPR. A
    // ResizeObserver fires once the layout is actually computed (covering the
    // case where buildUI ran before the panel had a measurable size → the canvas
    // was stuck at its fallback 256px backing = blurry) and on every later resize.
    const wrap = document.querySelector('.draw-waveform-preview');
    if (wrap && window.ResizeObserver) {
      this._previewRO?.disconnect();
      this._previewRO = new ResizeObserver(() => {
        this.updateWaveformPreview();
        this.drawScanCurve();
      });
      this._previewRO.observe(wrap);
    }
  }

  // ===== UI =====

  buildUI() {
    const container = document.getElementById('drawing-panel');
    if (!container) return;

    container.innerHTML = `
      <div class="panel-title">
        DRAWING MODE
        <div class="draw-header-controls">
          <button id="draw-tool-draw" class="small-btn ${this.toolMode === 'draw' ? 'active' : ''}" title="Draw Tool">DRAW</button>
          <button id="draw-tool-erase" class="small-btn ${this.toolMode === 'erase' ? 'active' : ''}" title="Eraser Tool">ERASE</button>
          <span class="seq-separator">|</span>
          <button id="draw-slots-8" class="small-btn step-count-btn active" data-slots="8">8</button>
          <button id="draw-slots-16" class="small-btn step-count-btn" data-slots="16">16</button>
          <span class="seq-separator">|</span>
          <button id="draw-auto-cycle" class="small-btn">AUTO CYCLE</button>
          <button id="draw-preview-btn" class="small-btn">♪ PREVIEW</button>
          <button id="draw-clear-btn" class="small-btn">CLEAR</button>
        </div>
      </div>
      <div class="draw-slot-tabs" id="draw-slot-tabs">
        <!-- generated by JS -->
      </div>
      <div class="draw-main-area">
        <div class="draw-canvas-wrapper">
          <canvas id="draw-canvas" width="256" height="256"></canvas>
          <div class="draw-crosshair-h" id="draw-crosshair-h"></div>
          <div class="draw-crosshair-v" id="draw-crosshair-v"></div>
        </div>
        <div class="draw-waveform-preview">
          <div class="draw-wave-label">L (X)</div>
          <canvas id="draw-wave-l" width="256" height="48"></canvas>
          <div class="draw-wave-label">R (Y)</div>
          <canvas id="draw-wave-r" width="256" height="48"></canvas>
          <div class="draw-wave-label">SCAN SPEED <span class="draw-scan-hint">走査速度</span></div>
          <canvas id="draw-scan-canvas" width="256" height="56"></canvas>
          <div class="draw-scan-presets">
            <button class="draw-scan-preset" data-scan="linear" title="一定速度（既定）">━</button>
            <button class="draw-scan-preset" data-scan="easeIn" title="後半が速い">⌣</button>
            <button class="draw-scan-preset" data-scan="easeOut" title="前半が速い">⌢</button>
            <button class="draw-scan-preset" data-scan="sCurve" title="S字（中央が速い）">∿</button>
            <button class="draw-scan-preset" data-scan="step" title="折れ（前半遅→後半速）">⌐</button>
            <button id="draw-scan-reset" class="small-btn" title="プロファイル/PMをリセット">RESET</button>
          </div>
          <div class="draw-scan-ripple">
            <span class="draw-scan-pm-label" title="サイクル内の正弦波で走査位置を変調（位相変調）。強いと折り返す">PM</span>
            <span class="draw-scan-sub">rate</span>
            <input id="draw-scan-rate" type="range" min="0" max="16" step="1" value="0">
            <span id="draw-scan-rate-val" class="draw-scan-num">0</span>
            <span class="draw-scan-sub">depth</span>
            <input id="draw-scan-depth" type="range" min="0" max="100" value="0">
            <span id="draw-scan-depth-val" class="draw-scan-num">0%</span>
          </div>
        </div>
      </div>
      <div class="draw-info-bar">
        <span id="draw-point-count" class="draw-info">Points: 0</span>
        <span id="draw-coords" class="draw-info"></span>
      </div>
    `;

    this.buildSlotTabs();
    this.initCanvas();
    this.initScanCanvas();
    this.updateWaveformPreview(); // crisp initial L/R render (fits canvas to display)
  }

  buildSlotTabs() {
    const container = document.getElementById('draw-slot-tabs');
    if (!container) return;
    container.innerHTML = '';

    for (let i = 0; i < this.visibleSlotCount; i++) {
      const slot = this.slots[i];
      const tab = document.createElement('button');
      tab.className = 'draw-slot-tab' + (i === this.activeSlot ? ' active' : '');
      tab.textContent = slot.name;
      tab.dataset.slot = String(i);
      tab.addEventListener('click', () => {
        this.switchSlot(i);
      });
      container.appendChild(tab);
    }

    // Clamp activeSlot if needed
    if (this.activeSlot >= this.visibleSlotCount) {
      this.switchSlot(0);
    }
  }

  switchSlot(index: number) {
    if (index < 0 || index >= this.visibleSlotCount) return;
    this.activeSlot = index;
    
    document.querySelectorAll('.draw-slot-tab').forEach((t, i) => {
      t.classList.toggle('active', i === index);
    });
    
    this.redrawCanvas();
    this.updateWaveformPreview();
    this.drawScanCurve(); // show this slot's scan profile
    this._syncRippleUI();

    // Switch VCO Loop audio buffer if running in drawing mode
    if (vcoLoop && vcoLoop.isOscRunning && vcoLoop.isDrawingOsc) {
      vcoLoop.switchDrawBuffer(this.activeSlot);
    }
    // Switch Arpeggiator drawing buffer if running in drawing mode
    if (arpeggiator && arpeggiator.refreshDrawingOsc) {
      arpeggiator.refreshDrawingOsc();
    }
  }

  // ===== PATTERN BANK =====
  switchPattern(index: number) {
    if (index === this.activePattern) return;

    // Save current slots to the active bank
    const savedSlots = this.slots.map(s => JSON.parse(JSON.stringify(s)));
    this.patternBank[this.activePattern] = {
      visibleSlotCount: this.visibleSlotCount,
      slots: savedSlots
    };

    // Load target bank
    this.activePattern = index;
    const target = this.patternBank[index];
    
    if (target) {
      this.visibleSlotCount = target.visibleSlotCount || 8;
      this.slots = target.slots.map(slot => ({
        name: slot.name,
        points: slot.points.map(p => ({ x: p.x, y: p.y })),
        waveX: [...slot.waveX],
        waveY: [...slot.waveY],
        scanProfile: copyPoints((slot as any).scanProfile ?? this._defaultScanProfile()),
        scanRippleRate: (slot as any).scanRippleRate || 0,
        scanRippleDepth: (slot as any).scanRippleDepth || 0,
      }));
    } else {
      // Re-initialize to default blank slots
      this.slots = [];
      for (let i = 0; i < 16; i++) {
        this.slots.push({ name: `Draw ${i + 1}`, points: [], waveX: [], waveY: [] });
      }
      this.visibleSlotCount = 8;
    }

    this.activeSlot = 0;
    this.buildSlotTabs();
    this.redrawCanvas();
    this.updateWaveformPreview();
    this.drawScanCurve();
    this._syncRippleUI();
    this.buildPatternBankUI();

    // Update slot count buttons
    document.getElementById('draw-slots-8')?.classList.toggle('active', this.visibleSlotCount === 8);
    document.getElementById('draw-slots-16')?.classList.toggle('active', this.visibleSlotCount === 16);

    // Auto-save preset (PresetManager listens for 'state:changed')
    emit('state:changed');
  }

  buildPatternBankUI() {
    const panel = document.getElementById('drawing-panel');
    if (!panel) return;
    let bankDiv = panel.querySelector('.pattern-bank');
    if (!bankDiv) {
      // Insert after the header element
      const header = panel.querySelector('.panel-title');
      bankDiv = document.createElement('div');
      bankDiv.className = 'pattern-bank';
      if (header) {
        header.after(bankDiv);
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

  initCanvas() {
    this.canvas = document.getElementById('draw-canvas') as HTMLCanvasElement | null;
    if (!this.canvas) return;
    this.ctx2d = this.canvas!.getContext('2d');

    this.canvas!.addEventListener('mousedown', (e) => this.onMouseDown(e));
    this.canvas!.addEventListener('mousemove', (e) => this.onMouseMove(e));
    this.canvas!.addEventListener('mouseup', () => this.onMouseUp());
    this.canvas!.addEventListener('mouseleave', () => this.onMouseUp());

    // Touch
    this.canvas!.addEventListener('touchstart', (e) => { e.preventDefault(); this.onTouchStart(e); }, { passive: false });
    this.canvas!.addEventListener('touchmove', (e) => { e.preventDefault(); this.onTouchMove(e); }, { passive: false });
    this.canvas!.addEventListener('touchend', () => this.onMouseUp());

    this.redrawCanvas();
  }

  bindControls() {
    // Scan-speed profile preset + reset buttons
    document.querySelectorAll<HTMLElement>('.draw-scan-preset').forEach(btn => {
      btn.addEventListener('click', () => this.setScanPreset(btn.dataset.scan ?? 'linear'));
    });
    document.getElementById('draw-scan-reset')?.addEventListener('click', () => {
      const slot = this.slots[this.activeSlot];
      slot.scanRippleRate = 0;
      slot.scanRippleDepth = 0;
      this._syncRippleUI();
      this.setScanPreset('linear');
    });

    // PM (intra-cycle ripple) rate / depth
    document.getElementById('draw-scan-rate')?.addEventListener('input', (e) => {
      this.slots[this.activeSlot].scanRippleRate = parseInt((e.target as HTMLInputElement).value, 10);
      const lbl = document.getElementById('draw-scan-rate-val');
      if (lbl) lbl.textContent = String(this.slots[this.activeSlot].scanRippleRate);
      this._applyScanChange();
    });
    document.getElementById('draw-scan-depth')?.addEventListener('input', (e) => {
      this.slots[this.activeSlot].scanRippleDepth = parseInt((e.target as HTMLInputElement).value, 10) / 100;
      const lbl = document.getElementById('draw-scan-depth-val');
      if (lbl) lbl.textContent = Math.round((this.slots[this.activeSlot].scanRippleDepth || 0) * 100) + '%';
      this._applyScanChange();
    });

    // Tool selection
    document.getElementById('draw-tool-draw')?.addEventListener('click', (e) => {
      this.setToolMode('draw');
      document.getElementById('draw-tool-draw')?.classList.add('active');
      document.getElementById('draw-tool-erase')?.classList.remove('active');
    });
    
    document.getElementById('draw-tool-erase')?.addEventListener('click', (e) => {
      this.setToolMode('erase');
      document.getElementById('draw-tool-erase')?.classList.add('active');
      document.getElementById('draw-tool-draw')?.classList.remove('active');
    });

    document.getElementById('draw-clear-btn')?.addEventListener('click', () => {
      this.slots[this.activeSlot].points = [];
      this.slots[this.activeSlot].waveX = [];
      this.slots[this.activeSlot].waveY = [];
      this.redrawCanvas();
      this.updateWaveformPreview();
      this.updatePointCount();
    });

    document.getElementById('draw-preview-btn')?.addEventListener('click', () => {
      this.togglePreview();
    });

    // Auto-cycle ON/OFF toggle
    document.getElementById('draw-auto-cycle')?.addEventListener('click', () => {
      this.autoSlotCycle = !this.autoSlotCycle;
      const btn = document.getElementById('draw-auto-cycle');
      if (btn) {
        btn.classList.toggle('vco-on', this.autoSlotCycle);
      }
    });

    // Slot count toggle (8 / 16)
    document.getElementById('draw-slots-8')?.addEventListener('click', () => {
      this.visibleSlotCount = 8;
      document.getElementById('draw-slots-8')?.classList.add('active');
      document.getElementById('draw-slots-16')?.classList.remove('active');
      this.buildSlotTabs();
    });

    document.getElementById('draw-slots-16')?.addEventListener('click', () => {
      this.visibleSlotCount = 16;
      document.getElementById('draw-slots-16')?.classList.add('active');
      document.getElementById('draw-slots-8')?.classList.remove('active');
      this.buildSlotTabs();
    });
  }

  // Advance to next slot (called from step sequencer on each step tick)
  advanceSlot() {
    if (!this.autoSlotCycle) return;
    const nextSlot = (this.activeSlot + 1) % this.visibleSlotCount;
    this.switchSlot(nextSlot);
  }

  // Import SVG path data (e.g. from a glyph database) into active slot
  importSVGPath(svgPathData: string) {
    if (!this.canvas || !this.ctx2d) return;

    const size = this.canvasSize; // 256
    const svgSize = 1000; // viewBox
    const scale = size / svgSize;

    const offCanvas = document.createElement('canvas');
    offCanvas.width = size;
    offCanvas.height = size;
    const offCtx = offCanvas.getContext('2d', { willReadFrequently: true });
    if (!offCtx) return false;

    offCtx.save();
    offCtx.scale(scale, scale);
    const path = new Path2D(svgPathData);
    offCtx.lineWidth = 3 / scale;
    offCtx.strokeStyle = '#fff';
    offCtx.stroke(path);
    offCtx.restore();

    return this._applyTracedCanvas(offCtx, size);
  }

  // Render any character / symbol with the browser's own font and trace its
  // outline into the active slot. This is the fully-local replacement for the
  // glyph-database API: no Unicode table, no network — works for anything the
  // installed fonts can draw.
  importGlyphChar(char: string, fontFamily?: string) {
    if (!this.canvas || !this.ctx2d || !char) return false;

    const size = this.canvasSize;
    const font = fontFamily || 'sans-serif';

    const offCanvas = document.createElement('canvas');
    offCanvas.width = size;
    offCanvas.height = size;
    const offCtx = offCanvas.getContext('2d', { willReadFrequently: true });
    if (!offCtx) return false;

    offCtx.textAlign = 'center';
    offCtx.textBaseline = 'middle';

    // Fit the glyph to the canvas
    let fontPx = Math.floor(size * 0.8);
    offCtx.font = `${fontPx}px ${font}`;
    const m = offCtx.measureText(char);
    const w = m.width || fontPx;
    const ascent = m.actualBoundingBoxAscent || fontPx * 0.7;
    const descent = m.actualBoundingBoxDescent || fontPx * 0.2;
    const maxDim = Math.max(w, ascent + descent);
    if (maxDim > size * 0.85) {
      fontPx = Math.max(8, Math.floor(fontPx * (size * 0.85) / maxDim));
      offCtx.font = `${fontPx}px ${font}`;
    }

    // Stroke the glyph OUTLINE → a clean traceable contour (like the SVG case)
    offCtx.lineWidth = 2;
    offCtx.lineJoin = 'round';
    offCtx.strokeStyle = '#fff';
    offCtx.strokeText(char, size / 2, size / 2);

    return this._applyTracedCanvas(offCtx, size);
  }

  // Shared: trace the white shape on an offscreen canvas into an ordered point
  // path and load it into the active slot. Used by SVG import + glyph rendering.
  _applyTracedCanvas(offCtx: CanvasRenderingContext2D, size: number) {
    const data = offCtx.getImageData(0, 0, size, size).data;
    const points: DrawPoint[] = [];

    // Collect contour pixels (sampled every 2px for a clean, light outline)
    for (let y = 0; y < size; y += 2) {
      for (let x = 0; x < size; x += 2) {
        if (data[(y * size + x) * 4 + 3] > 128) points.push({ x, y });
      }
    }
    if (points.length === 0) return false;

    // Nearest-neighbor sort into a continuous path
    const sortedPoints = [points[0]];
    const used = new Set([0]);
    for (let i = 1; i < points.length; i++) {
      const last = sortedPoints[sortedPoints.length - 1];
      let nearest = -1, nearestDist = Infinity;
      for (let j = 0; j < points.length; j++) {
        if (used.has(j)) continue;
        const dx = points[j].x - last.x;
        const dy = points[j].y - last.y;
        const dist = dx * dx + dy * dy;
        if (dist < nearestDist) { nearestDist = dist; nearest = j; }
      }
      if (nearest === -1) break;
      used.add(nearest);
      sortedPoints.push(points[nearest]);
    }

    const slot = this.slots[this.activeSlot];
    slot.points = sortedPoints;

    this.redrawCanvas();
    this.convertToWaveform();
    this.updateWaveformPreview();
    this.updatePointCount();

    // Gate on waveType, NOT isDrawingOsc: when DRAW started on an empty slot the
    // VCO is on the sine fallback (isDrawingOsc=false), and we still need to
    // notify it so refreshDrawingOsc can upgrade it to a real drawing oscillator.
    if (vcoLoop && vcoLoop.isOscRunning && vcoLoop.waveType === 'drawing') {
      vcoLoop.refreshDrawingOsc();
    }
    if (arpeggiator && arpeggiator.refreshDrawingOsc) {
      arpeggiator.refreshDrawingOsc();
    }
    return true;
  }

  // ===== DRAWING / ERASING =====

  setToolMode(mode: string) {
    this.toolMode = mode;
    if (this.canvas) {
      if (mode === 'erase') {
        this.canvas!.style.cursor = 'crosshair';
      } else {
        this.canvas!.style.cursor = 'default';
      }
    }
  }

  getCanvasPos(e: MouseEvent) {
    const rect = this.canvas!.getBoundingClientRect();
    const scaleX = this.canvas!.width / rect.width;
    const scaleY = this.canvas!.height / rect.height;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
    };
  }

  erasePoints(pos: { x: number; y: number }) {
    const pts = this.slots[this.activeSlot].points;
    let erased = false;
    
    // Iterate forwards to properly split strokes
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const dx = p.x - pos.x;
      const dy = p.y - pos.y;
      
      // If the point is within the eraser radius
      if (dx * dx + dy * dy < this.eraserRadius * this.eraserRadius) {
        // If there's a next point and it's NOT a new stroke,
        // we must make it the start of a new stroke to break the path.
        if (i < pts.length - 1 && !pts[i+1].newStroke) {
          pts[i+1].newStroke = true;
        }
        
        // Remove the current point
        pts.splice(i, 1);
        erased = true;
        
        // Decrement i since we modified the array in place
        i--;
      }
    }
    
    if (erased) {
      this.redrawCanvas();
      this.convertToWaveform();
      this.updateWaveformPreview();
      this.updatePointCount();
      if (this.isPreviewPlaying) {
        this.applyWaveformToPreview();
      }
      if (vcoLoop) {
        vcoLoop.refreshDrawingOsc();
      }
      if (arpeggiator) {
        arpeggiator.refreshDrawingOsc();
      }
    }
    return erased;
  }

  onMouseDown(e: MouseEvent) {
    this.isDrawing = true;
    const pos = this.getCanvasPos(e);
    
    if (this.toolMode === 'erase') {
      this.erasePoints(pos);
    } else {
      // Start new stroke
      this.slots[this.activeSlot].points.push({ x: pos.x, y: pos.y, newStroke: true });
      this.drawPoint(pos);
    }
  }

  onMouseMove(e: MouseEvent) {
    const pos = this.getCanvasPos(e);
    this.updateCrosshair(e);
    this.updateCoords(pos);

    if (!this.isDrawing) return;

    if (this.toolMode === 'erase') {
      this.erasePoints(pos);
    } else {
      this.slots[this.activeSlot].points.push({ x: pos.x, y: pos.y, newStroke: false });
      this.drawSegment(pos);
      this.convertToWaveform();
      this.updateWaveformPreview();
      this.updatePointCount();

      // Real-time audio feedback
      if (this.isPreviewPlaying) {
        this.applyWaveformToPreview();
      }
      // Refresh VCO Loop if it's using this drawing
      if (vcoLoop) {
        vcoLoop.refreshDrawingOsc();
      }
      // Refresh Arpeggiator if it's using this drawing (real-time)
      if (arpeggiator) {
        arpeggiator.refreshDrawingOsc();
      }
    }
  }

  onMouseUp() {
    this.isDrawing = false;
  }

  onTouchStart(e: TouchEvent) {
    this.isDrawing = true;
    const touch = e.touches[0];
    const rect = this.canvas!.getBoundingClientRect();
    const scaleX = this.canvas!.width / rect.width;
    const scaleY = this.canvas!.height / rect.height;
    const pos = { x: (touch.clientX - rect.left) * scaleX, y: (touch.clientY - rect.top) * scaleY };
    
    if (this.toolMode === 'erase') {
      this.erasePoints(pos);
    } else {
      this.slots[this.activeSlot].points.push({ x: pos.x, y: pos.y, newStroke: true });
      this.drawPoint(pos);
    }
  }

  onTouchMove(e: TouchEvent) {
    if (!this.isDrawing) return;
    const touch = e.touches[0];
    const rect = this.canvas!.getBoundingClientRect();
    const scaleX = this.canvas!.width / rect.width;
    const scaleY = this.canvas!.height / rect.height;
    const pos = { x: (touch.clientX - rect.left) * scaleX, y: (touch.clientY - rect.top) * scaleY };
    
    if (this.toolMode === 'erase') {
      this.erasePoints(pos);
    } else {
      this.slots[this.activeSlot].points.push({ x: pos.x, y: pos.y, newStroke: false });
      this.drawSegment(pos);
      this.convertToWaveform();
      this.updateWaveformPreview();
      if (this.isPreviewPlaying) {
        this.applyWaveformToPreview();
      }
      if (vcoLoop) {
        vcoLoop.refreshDrawingOsc();
      }
      if (arpeggiator) {
        arpeggiator.refreshDrawingOsc();
      }
    }
  }

  // ===== CANVAS RENDERING =====

  drawPoint(pos: { x: number; y: number }) {
    const ctx = this.ctx2d!;
    ctx.fillStyle = '#22d9f2';
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, 2, 0, Math.PI * 2);
    ctx.fill();
  }

  drawSegment(pos: { x: number; y: number }) {
    const ctx = this.ctx2d!;
    const pts = this.slots[this.activeSlot].points;
    if (pts.length < 2) return;

    const prev = pts[pts.length - 2];
    ctx.strokeStyle = '#22d9f2';
    ctx.lineWidth = 2;
    ctx.shadowColor = 'rgba(0, 229, 255, 0.5)';
    ctx.shadowBlur = 4;
    ctx.beginPath();
    ctx.moveTo(prev.x, prev.y);
    ctx.lineTo(pos.x, pos.y);
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  redrawCanvas() {
    if (!this.ctx2d) return;
    const ctx = this.ctx2d!;
    const s = this.canvas!.width;

    // Background
    ctx.fillStyle = '#111116';
    ctx.fillRect(0, 0, s, s);

    // Grid
    ctx.strokeStyle = '#222228';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const p = (i / 4) * s;
      ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, s); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(s, p); ctx.stroke();
    }

    // Center crosshair
    ctx.strokeStyle = '#333340';
    ctx.beginPath(); ctx.moveTo(s / 2, 0); ctx.lineTo(s / 2, s); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, s / 2); ctx.lineTo(s, s / 2); ctx.stroke();

    // Draw all points/strokes
    const pts = this.slots[this.activeSlot].points;
    if (pts.length === 0) return;

    ctx.strokeStyle = '#22d9f2';
    ctx.lineWidth = 2;
    ctx.shadowColor = 'rgba(0, 229, 255, 0.5)';
    ctx.shadowBlur = 4;

    for (let i = 0; i < pts.length; i++) {
      if (pts[i].newStroke || i === 0) {
        ctx.beginPath();
        ctx.moveTo(pts[i].x, pts[i].y);
      } else {
        ctx.lineTo(pts[i].x, pts[i].y);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(pts[i].x, pts[i].y);
      }
    }
    ctx.shadowBlur = 0;
    this.updatePointCount();
  }

  // ===== WAVEFORM CONVERSION (XYscope principle) =====

  convertToWaveform() {
    const slot = this.slots[this.activeSlot];
    const pts = slot.points;
    if (pts.length < 2) {
      slot.waveX = [];
      slot.waveY = [];
      return;
    }

    const s = this.canvas!.width;
    const res = this.waveResolution;

    // Normalize points to -1..1 range
    const waveX = new Float32Array(res);
    const waveY = new Float32Array(res);

    // Resample the drawn path to fixed resolution
    // Calculate total path length
    let totalLen = 0;
    const segLengths = [];
    for (let i = 1; i < pts.length; i++) {
      if (pts[i].newStroke) {
        segLengths.push(0);
      } else {
        const dx = pts[i].x - pts[i-1].x;
        const dy = pts[i].y - pts[i-1].y;
        const len = Math.sqrt(dx * dx + dy * dy);
        segLengths.push(len);
        totalLen += len;
      }
    }

    if (totalLen === 0) {
      slot.waveX = Array.from(waveX);
      slot.waveY = Array.from(waveY);
      return;
    }

    // Cumulative arc length at each point (cum[k] = distance start→point k).
    // Enables an O(log N) lookup at an ARBITRARY distance, so the scan position
    // may move BACKWARD (folding) without breaking — vs the old forward-only walk.
    const cum = new Float64Array(pts.length);
    for (let k = 1; k < pts.length; k++) cum[k] = cum[k - 1] + segLengths[k - 1];

    // Scan position φ(i/res) ∈ [0,1] along arc length, including the per-slot
    // profile curve + an optional intra-cycle sine ripple (PM-like).
    const scan = slot.scanProfile;
    const rate = slot.scanRippleRate || 0;
    const depth = slot.scanRippleDepth || 0;

    for (let i = 0; i < res; i++) {
      const u = this._warpScan(i / res, scan, rate, depth); // 0..1 (may fold)
      const p = this._pathAtDist(pts, cum, u * totalLen);
      // Normalize to -1..1
      waveX[i] = (p.x / s) * 2 - 1;
      waveY[i] = -((p.y / s) * 2 - 1); // Invert Y (canvas Y is top-down)
    }

    slot.waveX = Array.from(waveX);
    slot.waveY = Array.from(waveY);
  }

  // ===== SCAN-SPEED PROFILE =====

  // Default profile = linear (constant scan speed = current/legacy behaviour).
  _defaultScanProfile(): DrawPoint[] {
    return [{ x: 0, y: 0 }, { x: 1, y: 1 }];
  }

  // The active slot's profile, lazily initialised to linear when first edited.
  _activeScanProfile(): DrawPoint[] {
    const slot = this.slots[this.activeSlot];
    if (!slot.scanProfile || slot.scanProfile.length < 2) {
      slot.scanProfile = this._defaultScanProfile();
    }
    return slot.scanProfile;
  }

  // Evaluate the scan position φ(t) ∈ [0,1]:
  //   base = piecewise-linear over the profile points (absent → linear identity)
  //   + sine ripple depth·sin(2π·rate·t)  (intra-cycle phase modulation)
  // The result may be non-monotonic (the sum can move backward) → folding scan.
  _warpScan(t: number, profile?: DrawPoint[], rate = 0, depth = 0): number {
    let base = t;
    if (profile && profile.length >= 2) {
      let left = profile[0];
      let right = profile[profile.length - 1];
      for (let i = 0; i < profile.length - 1; i++) {
        if (t >= profile[i].x && t <= profile[i + 1].x) {
          left = profile[i];
          right = profile[i + 1];
          break;
        }
      }
      const range = right.x - left.x;
      const lt = range > 0 ? (t - left.x) / range : 0;
      // Per-segment curvature (curve-editor.ts) — linear when c is absent
      base = left.y + (right.y - left.y) * curveShape(lt, left.c);
    }
    if (depth > 0 && rate > 0) {
      base += depth * Math.sin(2 * Math.PI * rate * t);
    }
    return Math.max(0, Math.min(1, base));
  }

  // Point on the path at an arbitrary arc-length distance (clamped). Binary
  // search over the cumulative-length array, so distance may move backward.
  _pathAtDist(pts: DrawPoint[], cum: Float64Array, dist: number): DrawPoint {
    const total = cum[cum.length - 1];
    const d = Math.max(0, Math.min(total, dist));
    // smallest k (>=1) with cum[k] >= d → segment pts[k-1]..pts[k]
    let lo = 1, hi = pts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] >= d) hi = mid; else lo = mid + 1;
    }
    const k = lo;
    const segLen = cum[k] - cum[k - 1];
    const localT = segLen > 1e-9 ? (d - cum[k - 1]) / segLen : 0;
    const p0 = pts[k - 1], p1 = pts[k];
    return { x: p0.x + (p1.x - p0.x) * localT, y: p0.y + (p1.y - p0.y) * localT };
  }

  // Reflect the active slot's PM rate/depth into the sliders + labels.
  _syncRippleUI() {
    const slot = this.slots[this.activeSlot];
    const rate = slot.scanRippleRate || 0;
    const depth = Math.round((slot.scanRippleDepth || 0) * 100);
    const rs = document.getElementById('draw-scan-rate') as HTMLInputElement | null;
    if (rs) rs.value = String(rate);
    const rv = document.getElementById('draw-scan-rate-val');
    if (rv) rv.textContent = String(rate);
    const ds = document.getElementById('draw-scan-depth') as HTMLInputElement | null;
    if (ds) ds.value = String(depth);
    const dv = document.getElementById('draw-scan-depth-val');
    if (dv) dv.textContent = depth + '%';
  }

  // Re-bake + propagate after the active slot's scan profile changes.
  _applyScanChange() {
    this.drawScanCurve();
    this.convertToWaveform();
    this.updateWaveformPreview();
    if (vcoLoop) vcoLoop.refreshDrawingOsc();
    if (arpeggiator) arpeggiator.refreshDrawingOsc();
    emit('state:changed');
  }

  setScanPreset(name: string) {
    const presets: Record<string, DrawPoint[]> = {
      linear:  [{ x: 0, y: 0 }, { x: 1, y: 1 }],
      easeIn:  [{ x: 0, y: 0 }, { x: 0.5, y: 0.18 }, { x: 1, y: 1 }],
      easeOut: [{ x: 0, y: 0 }, { x: 0.5, y: 0.82 }, { x: 1, y: 1 }],
      sCurve:  [{ x: 0, y: 0 }, { x: 0.25, y: 0.06 }, { x: 0.5, y: 0.5 }, { x: 0.75, y: 0.94 }, { x: 1, y: 1 }],
      step:    [{ x: 0, y: 0 }, { x: 0.5, y: 0.04 }, { x: 0.5, y: 0.96 }, { x: 1, y: 1 }],
    };
    const p = presets[name];
    if (!p) return;
    this.slots[this.activeSlot].scanProfile = p.map(pt => ({ x: pt.x, y: pt.y }));
    this._applyScanChange();
  }

  // ===== SCAN-SPEED PROFILE CANVAS EDITOR =====

  initScanCanvas() {
    const canvas = document.getElementById('draw-scan-canvas') as HTMLCanvasElement | null;
    if (!canvas) return;
    this._scanCanvas = canvas;
    this._scanCtx = canvas.getContext('2d');
    this._scanDragIdx = null;
    canvas.addEventListener('mousedown', (e) => this._scanMouseDown(e));
    canvas.addEventListener('mousemove', (e) => this._scanMouseMove(e));
    canvas.addEventListener('mouseup', () => { this._scanDragIdx = null; this._scanHandleDrag = null; });
    canvas.addEventListener('mouseleave', () => {
      this._scanDragIdx = null; this._scanHandleDrag = null;
      if (this._scanHoverSeg !== null) { this._scanHoverSeg = null; this.drawScanCurve(); }
    });
    canvas.addEventListener('dblclick', (e) => this._scanDblClick(e));
    // Right-click = delete point (unified across all curve editors)
    canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this._scanDblClick(e);
    });
    this.drawScanCurve();
    this._syncRippleUI();
  }

  _scanCoords(e: MouseEvent) {
    const rect = this._scanCanvas!.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const y = Math.max(0, Math.min(1, 1 - (e.clientY - rect.top) / rect.height));
    return { x, y };
  }

  drawScanCurve() {
    const canvas = this._scanCanvas;
    const ctx = this._scanCtx;
    if (!canvas || !ctx) return;
    const { w, h } = this._fitCanvas(canvas, ctx);
    const slot = this.slots[this.activeSlot];
    const prof = slot.scanProfile || this._defaultScanProfile();
    const rate = slot.scanRippleRate || 0;
    const depth = slot.scanRippleDepth || 0;

    ctx.fillStyle = '#1c1c20';
    ctx.fillRect(0, 0, w, h);
    // Grid
    ctx.strokeStyle = '#2a2a32';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const gx = (i / 4) * w, gy = (i / 4) * h;
      ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, h); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(w, gy); ctx.stroke();
    }
    // Reference linear (faint)
    ctx.strokeStyle = '#3a3a44';
    ctx.beginPath(); ctx.moveTo(0, h); ctx.lineTo(w, 0); ctx.stroke();

    // Effective scan curve (profile + ripple). This is the actual φ(t) used.
    ctx.strokeStyle = '#22d9f2';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let px = 0; px <= w; px++) {
      const v = this._warpScan(px / w, prof, rate, depth);
      const y = h - v * h;
      if (px === 0) ctx.moveTo(px, y); else ctx.lineTo(px, y);
    }
    ctx.stroke();

    // Curvature handles — revealed on hover / drag; subtle hint on bent ones
    drawHandles(ctx, prof, (x) => x * w, (y) => h - y * h,
      { activeSeg: this._scanHandleDrag ?? this._scanHoverSeg, size: 3.5 });

    // Points
    prof.forEach(pt => {
      ctx.fillStyle = '#ffb454';
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(pt.x * w, h - pt.y * h, 4, 0, Math.PI * 2);
      ctx.fill(); ctx.stroke();
    });
  }

  _scanFindPoint(coords: DrawPoint, prof: DrawPoint[]): number {
    for (let i = 0; i < prof.length; i++) {
      const dx = prof[i].x - coords.x;
      const dy = prof[i].y - coords.y;
      if (Math.sqrt(dx * dx + dy * dy) < 0.06) return i;
    }
    return -1;
  }

  _scanMouseDown(e: MouseEvent) {
    const prof = this._activeScanProfile();
    const c = this._scanCoords(e);
    // Curvature handle first (it sits on the curve between points)
    const rect = this._scanCanvas!.getBoundingClientRect();
    const seg = hitHandlePx(prof, c, rect.width, rect.height);
    if (seg >= 0) {
      this._scanHandleDrag = seg;
      return;
    }
    const idx = this._scanFindPoint(c, prof);
    if (idx >= 0) {
      this._scanDragIdx = idx;
    } else {
      prof.push({ x: c.x, y: c.y });
      prof.sort((a, b) => a.x - b.x);
      this._scanDragIdx = prof.findIndex(p => p.x === c.x && p.y === c.y);
      this._applyScanChange();
    }
  }

  _scanMouseMove(e: MouseEvent) {
    // Curvature-handle drag: bend the segment through the cursor
    if (this._scanHandleDrag !== null) {
      dragHandle(this._activeScanProfile(), this._scanHandleDrag, this._scanCoords(e).y, e.altKey);
      this._applyScanChange();
      return;
    }

    if (this._scanDragIdx === null) {
      // Hover reveal: show the handle only for the segment under the cursor
      const seg = segmentAtX(this._activeScanProfile(), this._scanCoords(e).x);
      if (seg !== this._scanHoverSeg) { this._scanHoverSeg = seg; this.drawScanCurve(); }
      return;
    }
    const prof = this._activeScanProfile();
    const c = this._scanCoords(e);
    const pt = prof[this._scanDragIdx];
    if (!pt) return;
    // Alt = fine mode (×0.1 pursuit toward the cursor)
    let tx = c.x, ty = c.y;
    if (e.altKey) {
      tx = pt.x + (c.x - pt.x) * 0.1;
      ty = pt.y + (c.y - pt.y) * 0.1;
    }
    // Lock the endpoints' x (they must span the full path 0..1).
    // Middle points are clamped between their neighbors so they can never
    // cross (crossing broke the x-sorted curve rendering).
    if (this._scanDragIdx === 0) { pt.x = 0; pt.y = ty; }
    else if (this._scanDragIdx === prof.length - 1) { pt.x = 1; pt.y = ty; }
    else {
      const eps = 0.004;
      pt.x = Math.max(prof[this._scanDragIdx - 1].x + eps,
             Math.min(prof[this._scanDragIdx + 1].x - eps, tx));
      pt.y = ty;
    }
    this._applyScanChange();
  }

  _scanDblClick(e: MouseEvent) {
    const prof = this._activeScanProfile();
    const c = this._scanCoords(e);
    // Reset a curvature handle to linear before considering point deletion
    const rect = this._scanCanvas!.getBoundingClientRect();
    if (resetHandleAtPx(prof, c, rect.width, rect.height)) {
      this._applyScanChange();
      return;
    }
    const idx = this._scanFindPoint(c, prof);
    if (idx > 0 && idx < prof.length - 1) {
      prof.splice(idx, 1);
      this._applyScanChange();
    }
  }

  // ===== WAVEFORM PREVIEW DISPLAY =====

  updateWaveformPreview() {
    const slot = this.slots[this.activeSlot];
    this.drawWaveCanvas('draw-wave-l', slot.waveX, '#4a9eff');
    this.drawWaveCanvas('draw-wave-r', slot.waveY, '#ff5964');
  }

  // Match a canvas's backing-store resolution to its CSS display size × DPR, and
  // scale the context so 1 unit = 1 CSS px. Without this these canvases keep their
  // fixed 256px backing store but are stretched to 100% width → blurry ("ガビガビ").
  // Returns the CSS-pixel size to draw with. Falls back to the attribute size when
  // the element isn't laid out yet (0×0).
  _fitCanvas(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D): { w: number; h: number } {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const cssW = Math.round(rect.width) || canvas.width;
    const cssH = Math.round(rect.height) || canvas.height;
    const needW = Math.max(1, Math.round(cssW * dpr));
    const needH = Math.max(1, Math.round(cssH * dpr));
    if (canvas.width !== needW || canvas.height !== needH) {
      canvas.width = needW;
      canvas.height = needH;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // draw in CSS-pixel coordinates
    return { w: cssW, h: cssH };
  }

  drawWaveCanvas(canvasId: string, waveData: number[], color: string) {
    const canvas = document.getElementById(canvasId) as HTMLCanvasElement | null;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const { w, h } = this._fitCanvas(canvas, ctx);

    ctx.fillStyle = '#1c1c20';
    ctx.fillRect(0, 0, w, h);

    // Zero line
    ctx.strokeStyle = '#333340';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();

    if (!waveData || waveData.length === 0) return;

    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < w; i++) {
      const idx = Math.floor((i / w) * waveData.length);
      const val = waveData[idx] || 0;
      const y = h / 2 - val * (h / 2 - 2);
      if (i === 0) ctx.moveTo(i, y);
      else ctx.lineTo(i, y);
    }
    ctx.stroke();
  }

  // ===== REAL-TIME AUDIO =====

  togglePreview() {
    if (this.isPreviewPlaying) {
      this.stopPreview();
    } else {
      this.startPreview();
    }
  }

  async startPreview() {
    if (!audioEngine.isInitialized) {
      await audioEngine.init();
    }
    audioEngine.resume();

    const slot = this.slots[this.activeSlot];
    if (slot.waveX.length === 0) {
      this.convertToWaveform();
    }
    if (slot.waveX.length === 0) return;

    this.createPreviewSource();
    this.isPreviewPlaying = true;

    const btn = document.getElementById('draw-preview-btn');
    if (btn) {
      btn.textContent = '■ STOP';
      btn.classList.add('preview-active');
    }
  }

  createPreviewSource() {
    // Stop previous source if any
    this.stopPreviewSource();

    const ctx = audioEngine.ctx!;
    const slot = this.slots[this.activeSlot];
    const bufferLength = slot.waveX.length;
    if (bufferLength === 0) return;

    // Create stereo buffer: L=waveX, R=waveY
    const buffer = ctx.createBuffer(2, bufferLength, ctx.sampleRate);
    const lData = buffer.getChannelData(0);
    const rData = buffer.getChannelData(1);
    for (let i = 0; i < bufferLength; i++) {
      lData[i] = slot.waveX[i] || 0;
      rData[i] = (slot.waveY[i] !== undefined) ? slot.waveY[i] : (slot.waveX[i] || 0);
    }

    this.previewGain = ctx.createGain();
    this.previewGain!.gain.value = 0.3;
    this.previewGain!.connect(audioEngine.masterGain!);

    this.previewOsc = ctx.createBufferSource();
    this.previewOsc.buffer = buffer;
    this.previewOsc.loop = true;

    // Set playback rate for 220Hz base
    const baseFreq = ctx.sampleRate / bufferLength;
    this.previewOsc.playbackRate.value = 220 / baseFreq;

    this.previewOsc.connect(this.previewGain);
    this.previewOsc.start();
  }

  stopPreviewSource() {
    if (this.previewOsc) {
      try { this.previewOsc.stop(); } catch(e) {}
      this.previewOsc.disconnect();
      this.previewOsc = null;
    }
    if (this.previewGain) {
      this.previewGain!.disconnect();
      this.previewGain = null;
    }
  }

  stopPreview() {
    this.stopPreviewSource();
    this.isPreviewPlaying = false;

    const btn = document.getElementById('draw-preview-btn');
    if (btn) {
      btn.textContent = '♪ PREVIEW';
      btn.classList.remove('preview-active');
    }
  }

  // Update preview audio in real-time while drawing
  applyWaveformToPreview() {
    if (!this.isPreviewPlaying) return;
    // Recreate the source with updated waveform data
    this.createPreviewSource();
  }

  // ===== UI HELPERS =====

  updateCrosshair(e: MouseEvent) {
    const rect = this.canvas!.getBoundingClientRect();
    const ch = document.getElementById('draw-crosshair-h');
    const cv = document.getElementById('draw-crosshair-v');
    if (ch) ch.style.top = (e.clientY - rect.top) + 'px';
    if (cv) cv.style.left = (e.clientX - rect.left) + 'px';
  }

  updateCoords(pos: { x: number; y: number }) {
    const el = document.getElementById('draw-coords');
    if (el) {
      const nx = ((pos.x / this.canvas!.width) * 2 - 1).toFixed(2);
      const ny = (-((pos.y / this.canvas!.height) * 2 - 1)).toFixed(2);
      el.textContent = `X: ${nx}  Y: ${ny}`;
    }
  }

  updatePointCount() {
    const el = document.getElementById('draw-point-count');
    if (el) {
      el.textContent = `Points: ${this.slots[this.activeSlot].points.length}`;
    }
  }

  // ===== PRESET STATE (Serializable) =====

  readonly stateKey = 'drawing';

  getState() {
    return {
      visibleSlotCount: this.visibleSlotCount,
      activeSlot: this.activeSlot,
      slots: this.slots.map(slot => ({
        name: slot.name,
        points: slot.points.map(p => ({ x: p.x, y: p.y })),
        waveX: [...slot.waveX],
        waveY: [...slot.waveY],
        scanProfile: copyPoints(slot.scanProfile ?? this._defaultScanProfile()),
        scanRippleRate: slot.scanRippleRate || 0,
        scanRippleDepth: slot.scanRippleDepth || 0,
      })),
      activePattern: this.activePattern,
      patternBank: this.patternBank.map(p => p ? {
        visibleSlotCount: p.visibleSlotCount,
        slots: p.slots.map((slot: any) => ({
          name: slot.name,
          points: slot.points.map((pt: any) => ({ x: pt.x, y: pt.y })),
          waveX: [...slot.waveX],
          waveY: [...slot.waveY],
          scanProfile: copyPoints(slot.scanProfile ?? this._defaultScanProfile()),
          scanRippleRate: slot.scanRippleRate || 0,
          scanRippleDepth: slot.scanRippleDepth || 0,
        }))
      } : null),
    };
  }

  setState(state: any) {
    if (!state) return;
    // 1. Load active slots
    this.visibleSlotCount = state.visibleSlotCount || 8;
    this.activeSlot = state.activeSlot || 0;
    state.slots.forEach((saved: any, i: number) => {
      if (i < this.slots.length) {
        if (saved.name) this.slots[i].name = saved.name;
        this.slots[i].points = saved.points.map((p: any) => ({ x: p.x, y: p.y }));
        this.slots[i].waveX = [...saved.waveX];
        this.slots[i].waveY = [...saved.waveY];
        this.slots[i].scanProfile = Array.isArray(saved.scanProfile) && saved.scanProfile.length >= 2
          ? copyPoints(saved.scanProfile)
          : this._defaultScanProfile();
        this.slots[i].scanRippleRate = saved.scanRippleRate || 0;
        this.slots[i].scanRippleDepth = saved.scanRippleDepth || 0;
      }
    });
    // 2. Load pattern bank
    if (state.patternBank) {
      this.activePattern = state.activePattern || 0;
      this.patternBank = state.patternBank.map((p: any) => {
        if (!p) return null;
        return {
          visibleSlotCount: p.visibleSlotCount || 8,
          slots: p.slots.map((slot: any) => ({
            name: slot.name,
            points: slot.points.map((pt: any) => ({ x: pt.x, y: pt.y })),
            waveX: [...slot.waveX],
            waveY: [...slot.waveY],
            scanProfile: Array.isArray(slot.scanProfile) && slot.scanProfile.length >= 2
              ? copyPoints(slot.scanProfile)
              : this._defaultScanProfile(),
            scanRippleRate: slot.scanRippleRate || 0,
            scanRippleDepth: slot.scanRippleDepth || 0,
          }))
        };
      });
    }

    // Update UI components
    document.getElementById('draw-slots-8')?.classList.toggle('active', this.visibleSlotCount === 8);
    document.getElementById('draw-slots-16')?.classList.toggle('active', this.visibleSlotCount === 16);
    this.buildSlotTabs();
    this.redrawCanvas();
    this.updateWaveformPreview();
    this.drawScanCurve();
    this._syncRippleUI();
    this.buildPatternBankUI();
  }
}

export const drawingMode = new DrawingMode();
registerSerializable(drawingMode);
