/**
 * DLOSy20 - Parameter Control Engine
 *
 * A vanilla-TS port of the interaction patterns studied in
 * https://github.com/na-gasena/ui-study (After Effects / C4D-style parameter
 * control). Three primitives:
 *
 *  - attachNumberScrub(el):  horizontal-drag scrubbing on a numeric readout,
 *    click (≤3px) to type a value inline, ↑/↓ keys to step. Shift=×10, Alt=×0.1.
 *    While dragging, an SVG overlay shows a direction arrow (double arrow when
 *    fast, dashed when slow) and the accumulated delta ("+12").
 *
 *  - attachRotaryKnob(el):  rotary dragging — the value follows the angular
 *    displacement of the cursor around the knob center (not vertical drag).
 *    A dead zone near the center avoids jumpy angles; swinging wider gives
 *    finer control. Overlay: guide line to the cursor + an arc arrow from the
 *    start angle, plus the current value. Alt=×0.1, double-click resets.
 *
 *  - initRangeEnhancer():  takes over every <input type="range"> pointer drag:
 *    click on the track jumps to that position (then keeps dragging), holding
 *    Alt switches to relative ×0.1 fine mode, and a tooltip shows the live
 *    value. A --pct custom property is kept in sync for the accum-bar styling.
 *
 * All overlays render into one fixed, pointer-transparent SVG layer.
 */

// ===== math helpers =====
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const quantize = (v: number, step: number) => Math.round(v / step) * step;

/** Fixed representation with fractional trailing zeros trimmed
 *  ("1.50" → "1.5", "2.00" → "2" — integer zeros are kept: "120" stays "120"). */
function fmt(v: number, precision = 2): string {
  let s = v.toFixed(precision);
  if (precision > 0) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s;
}

// ===== SVG overlay layer =====
const SVG_NS = 'http://www.w3.org/2000/svg';
let _overlay: SVGSVGElement | null = null;

function overlay(): SVGSVGElement {
  if (_overlay && document.body.contains(_overlay)) return _overlay;
  _overlay = document.createElementNS(SVG_NS, 'svg');
  _overlay.id = 'pc-overlay';
  document.body.appendChild(_overlay);
  return _overlay;
}

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, cls: string): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  el.setAttribute('class', cls);
  return el;
}

function clearOverlay() {
  if (_overlay) _overlay.innerHTML = '';
}

// Modifier-key speed (ui-study: keyFaster=Shift ×10, keySlower=Alt ×0.1)
function speedMult(e: PointerEvent | KeyboardEvent): number {
  if (e.shiftKey) return 10;
  if (e.altKey) return 0.1;
  return 1;
}
function speedName(e: PointerEvent): 'fast' | 'slow' | 'normal' {
  if (e.shiftKey) return 'fast';
  if (e.altKey) return 'slow';
  return 'normal';
}

// ===== overlay drawings =====

/** Horizontal-drag HUD: arrow at cursor (flipped by direction) + delta text. */
function drawHDrag(x: number, y: number, toRight: boolean, speed: string, text: string) {
  const svg = overlay();
  svg.innerHTML = '';
  const sx = toRight ? 1 : -1;
  const mk = (dx: number, cls: string) => {
    const p = svgEl('polyline', cls);
    p.setAttribute('points', '-10,-7 0,0 -10,7');
    p.setAttribute('transform', `translate(${x + dx * sx} ${y}) scale(${sx} 1)`);
    svg.appendChild(p);
  };
  if (speed === 'fast') { mk(0, 'pc-stroke'); mk(-10, 'pc-stroke'); }
  else if (speed === 'slow') { mk(0, 'pc-dashed-stroke'); }
  else { mk(0, 'pc-stroke'); }

  const t = svgEl('text', 'pc-text');
  t.setAttribute('x', String(x + (toRight ? 16 : -16)));
  t.setAttribute('y', String(y));
  t.setAttribute('dominant-baseline', 'central');
  t.setAttribute('text-anchor', toRight ? 'start' : 'end');
  t.textContent = text;
  svg.appendChild(t);
}

/** Rotary HUD: guide line center→cursor + arc arrow (start→end angle) + value text. */
function drawRotary(
  cx: number, cy: number, px: number, py: number,
  radius: number, startDeg: number, endDeg: number, text: string,
) {
  const svg = overlay();
  svg.innerHTML = '';

  const guide = svgEl('line', 'pc-guide');
  guide.setAttribute('x1', String(cx)); guide.setAttribute('y1', String(cy));
  guide.setAttribute('x2', String(px)); guide.setAttribute('y2', String(py));
  svg.appendChild(guide);

  // Arc (SvgArcArrow port; angles in screen coords, 0°=+X, y-down)
  const sr = (startDeg / 180) * Math.PI;
  const er = (endDeg / 180) * Math.PI;
  const x1 = cx + Math.cos(sr) * radius, y1 = cy + Math.sin(sr) * radius;
  const x2 = cx + Math.cos(er) * radius, y2 = cy + Math.sin(er) * radius;
  const diff = endDeg - startDeg;
  const f1 = ((Math.abs(diff) % 360) + 360) % 360 > 180 ? 1 : 0;
  const f2 = diff >= 0 ? 1 : 0;
  const path = svgEl('path', 'pc-stroke');
  path.setAttribute('d', `M ${x1} ${y1} A ${radius} ${radius} 0 ${f1} ${f2} ${x2} ${y2}`);
  svg.appendChild(path);

  // Arrow tip once the arc is long enough to read direction
  if ((Math.abs(sr - er) * radius) >= 10) {
    const tip = svgEl('polygon', 'pc-fill');
    tip.setAttribute('points', '-10,-5 0,0 -10,5');
    tip.setAttribute('transform', `translate(${x2}, ${y2}) rotate(${endDeg + 90 + (diff < 0 ? 180 : 0)})`);
    svg.appendChild(tip);
  }

  const t = svgEl('text', 'pc-text');
  t.setAttribute('x', String(px + 14));
  t.setAttribute('y', String(py));
  t.setAttribute('dominant-baseline', 'central');
  t.textContent = text;
  svg.appendChild(t);
}

// ===== 1) Number scrub (InputNumber) =====

export interface NumberScrubOpts {
  get(): number;
  set(v: number): void;
  min?: number;
  max?: number;
  step?: number;        // quantize committed values
  perPixel?: number;    // value change per horizontal px at normal speed
  precision?: number;   // display decimals (default 0)
  unit?: string;        // appended to the display ("%", "Hz", …)
  onCommit?(): void;    // fired after a drag ends / an edit commits
}

export interface ParamControl {
  refresh(): void;      // re-render from get() after an external change
  edit?(): void;        // open the inline text editor (number scrub only)
}

export function attachNumberScrub(el: HTMLElement, opts: NumberScrubOpts): ParamControl {
  const precision = opts.precision ?? 0;
  const perPixel = opts.perPixel ?? (opts.step ?? 1) * 0.5;

  el.classList.add('pc-scrub');
  el.title = el.title || 'ドラッグで変更 / クリックで入力 (Shift=×10, Alt=×0.1)';

  const display = () => {
    // Never rewrite the content while the inline editor is open — setting
    // textContent would destroy the <input> mid-edit.
    if (el.classList.contains('editing')) return;
    el.textContent = fmt(opts.get(), precision) + (opts.unit ?? '');
  };

  const constrain = (v: number) => {
    if (opts.step !== undefined) v = quantize(v, opts.step);
    if (opts.min !== undefined) v = Math.max(opts.min, v);
    if (opts.max !== undefined) v = Math.min(opts.max, v);
    return v;
  };

  // Brief highlight whenever the value updates (ui-study "updating" state)
  let flashTimer: ReturnType<typeof setTimeout> | null = null;
  const flash = () => {
    el.classList.add('updating');
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => el.classList.remove('updating'), 150);
  };

  // --- drag to scrub ---
  const MIN_DRAG = 3;
  let downX = 0, downY = 0, dragging = false, startValue = 0, acc = 0;

  el.addEventListener('pointerdown', (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    downX = e.clientX; downY = e.clientY;
    dragging = false;
    startValue = opts.get();
    acc = 0;
  });

  el.addEventListener('pointermove', (e: PointerEvent) => {
    if (!el.hasPointerCapture(e.pointerId)) return;
    if (!dragging) {
      if (Math.hypot(e.clientX - downX, e.clientY - downY) < MIN_DRAG) return;
      dragging = true;
      downX = e.clientX; // rebase so the initial jump is not counted
      el.classList.add('dragging');
    }
    const dx = e.movementX !== 0 ? e.movementX : e.clientX - downX;
    downX = e.clientX;
    acc += dx * perPixel * speedMult(e);

    const newValue = constrain(startValue + acc);
    if (newValue !== opts.get()) { opts.set(newValue); flash(); }
    display();

    const actualInc = newValue - startValue;
    drawHDrag(
      e.clientX, e.clientY, acc >= 0, speedName(e),
      (actualInc > 0 ? '+' : '') + fmt(actualInc, precision),
    );
  });

  el.addEventListener('pointerup', (e: PointerEvent) => {
    if (!el.hasPointerCapture(e.pointerId)) return;
    el.releasePointerCapture(e.pointerId);
    el.classList.remove('dragging');
    clearOverlay();
    if (dragging) {
      dragging = false;
      opts.onCommit?.();
    } else {
      beginEdit(); // plain click → inline text edit
    }
  });

  // --- click to edit ---
  function beginEdit() {
    if (el.querySelector('input')) return;
    el.classList.add('editing');
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'pc-edit';
    input.value = fmt(opts.get(), precision);
    el.appendChild(input);
    input.focus();
    input.select();

    const commit = () => {
      const v = parseFloat(input.value);
      if (!isNaN(v)) { opts.set(constrain(v)); opts.onCommit?.(); }
      close();
    };
    const close = () => {
      el.classList.remove('editing');
      input.remove();
      display();
    };
    input.addEventListener('keydown', (ke: KeyboardEvent) => {
      if (ke.key === 'Enter') commit();
      else if (ke.key === 'Escape') close();
      else if (ke.key === 'ArrowUp' || ke.key === 'ArrowDown') {
        ke.preventDefault();
        const inc = (ke.key === 'ArrowUp' ? 1 : -1) * (opts.step ?? 1) * speedMult(ke);
        const v = constrain((parseFloat(input.value) || opts.get()) + inc);
        input.value = fmt(v, precision);
        opts.set(v);
        flash();
      }
      ke.stopPropagation(); // don't trigger app-level shortcuts while typing
    });
    input.addEventListener('blur', commit);
  }

  display();
  return { refresh: display, edit: beginEdit };
}

// ===== 2) Rotary knob (InputAngle) =====

export interface RotaryKnobOpts {
  get(): number;
  set(v: number): void;
  min: number;
  max: number;
  step?: number;
  defaultValue?: number;         // double-click resets to this
  format?(v: number): string;    // HUD text (default: 2-decimal trim)
  onCommit?(): void;
  /** value→CSS-rotation range in degrees (default -135…+135). */
  angleRange?: [number, number];
}

export function attachRotaryKnob(el: HTMLElement, opts: RotaryKnobOpts): ParamControl {
  const [angMin, angMax] = opts.angleRange ?? [-135, 135];
  const format = opts.format ?? ((v: number) => fmt(v, 2));

  const valueToDeg = (v: number) =>
    angMin + ((v - opts.min) / (opts.max - opts.min)) * (angMax - angMin);

  const render = () => {
    el.style.setProperty('--rotation', `${valueToDeg(opts.get())}deg`);
  };

  const constrain = (v: number) => {
    if (opts.step !== undefined) v = quantize(v, opts.step);
    return clamp(v, opts.min, opts.max);
  };

  el.classList.add('pc-knob');
  el.title = el.title || '回転ドラッグで変更 (Alt=×0.1) / ダブルクリックでリセット';

  let cx = 0, cy = 0;          // knob center (viewport coords)
  let deadR = 0;               // dead-zone radius around the center
  let prevAngle: number | null = null; // last valid cursor angle (deg, screen coords)
  let startValue = 0, accDeg = 0, startDeg = 0, dragging = false;

  const cursorAngle = (x: number, y: number) =>
    (Math.atan2(y - cy, x - cx) / Math.PI) * 180;

  el.addEventListener('pointerdown', (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    const r = el.getBoundingClientRect();
    cx = r.left + r.width / 2;
    cy = r.top + r.height / 2;
    // ui-study sets minDistance to the element width: you grab the knob and
    // swing around it from outside; near-center angles are too jumpy to use.
    deadR = Math.max(r.width * 0.75, 20);
    startValue = opts.get();
    accDeg = 0;
    prevAngle = null;
    startDeg = valueToDeg(startValue) - 90; // CSS 0°=up → screen 0°=+X
    dragging = true;
    el.classList.add('dragging');
  });

  el.addEventListener('pointermove', (e: PointerEvent) => {
    if (!dragging || !el.hasPointerCapture(e.pointerId)) return;
    const dist = Math.hypot(e.clientX - cx, e.clientY - cy);
    if (dist >= deadR) {
      const ang = cursorAngle(e.clientX, e.clientY);
      if (prevAngle !== null) {
        let d = ang - prevAngle;
        if (d > 180) d -= 360;
        if (d < -180) d += 360;
        accDeg += d * (e.altKey ? 0.1 : 1);
      }
      prevAngle = ang;

      const range = opts.max - opts.min;
      const newValue = constrain(startValue + (accDeg / (angMax - angMin)) * range);
      if (newValue !== opts.get()) opts.set(newValue);
      render();
    }
    drawRotary(
      cx, cy, e.clientX, e.clientY,
      Math.max(deadR * 0.66, 24),
      startDeg, valueToDeg(opts.get()) - 90,
      format(opts.get()),
    );
  });

  el.addEventListener('pointerup', (e: PointerEvent) => {
    if (!el.hasPointerCapture(e.pointerId)) return;
    el.releasePointerCapture(e.pointerId);
    dragging = false;
    el.classList.remove('dragging');
    clearOverlay();
    opts.onCommit?.();
  });

  if (opts.defaultValue !== undefined) {
    el.addEventListener('dblclick', () => {
      opts.set(constrain(opts.defaultValue!));
      render();
      opts.onCommit?.();
    });
  }

  render();
  return { refresh: render };
}

// ===== 3) Range-input enhancer (InputSlider) =====

let _rangeEnhanced = false;

/** (v-min)/(max-min) as 0..1 for the accum-bar gradient. */
function rangePct(input: HTMLInputElement): number {
  const min = parseFloat(input.min || '0');
  const max = parseFloat(input.max || '100');
  const v = parseFloat(input.value || '0');
  return max > min ? clamp((v - min) / (max - min), 0, 1) : 0;
}

function updateRangePct(input: HTMLInputElement) {
  input.style.setProperty('--pct', String(rangePct(input)));
}

export function initRangeEnhancer() {
  if (_rangeEnhanced) return;
  _rangeEnhanced = true;

  // Keep --pct in sync for every range in the app (initial + dynamically added)
  const syncAll = (root: ParentNode) =>
    root.querySelectorAll<HTMLInputElement>('input[type="range"]').forEach(updateRangePct);
  syncAll(document);
  new MutationObserver((muts) => {
    muts.forEach(m => m.addedNodes.forEach(n => {
      if (n instanceof HTMLElement) {
        if (n instanceof HTMLInputElement && n.type === 'range') updateRangePct(n);
        else syncAll(n);
      }
    }));
  }).observe(document.body, { childList: true, subtree: true });
  document.addEventListener('input', (e) => {
    const t = e.target;
    if (t instanceof HTMLInputElement && t.type === 'range') updateRangePct(t);
  });

  // Pointer takeover: absolute jump-to-position + drag; Alt = relative fine.
  let active: HTMLInputElement | null = null;
  let startValue = 0, startX = 0, fineMode = false;
  let tooltip: HTMLElement | null = null;

  const showTip = (input: HTMLInputElement, x: number) => {
    if (!tooltip) {
      tooltip = document.createElement('div');
      tooltip.className = 'pc-tooltip';
      document.body.appendChild(tooltip);
    }
    const r = input.getBoundingClientRect();
    const step = parseFloat(input.step || '1');
    const prec = step < 0.1 ? 2 : step < 1 ? 1 : 0;
    tooltip.textContent = fmt(parseFloat(input.value), prec) + (fineMode ? ' (fine)' : '');
    tooltip.style.left = `${clamp(x, r.left, r.right)}px`;
    tooltip.style.top = `${r.top - 8}px`;
  };

  const hideTip = () => { tooltip?.remove(); tooltip = null; };

  const applyAbsolute = (input: HTMLInputElement, clientX: number) => {
    const r = input.getBoundingClientRect();
    const min = parseFloat(input.min || '0');
    const max = parseFloat(input.max || '100');
    const t = clamp((clientX - r.left) / r.width, 0, 1);
    setRange(input, min + t * (max - min));
  };

  const setRange = (input: HTMLInputElement, v: number) => {
    const min = parseFloat(input.min || '0');
    const max = parseFloat(input.max || '100');
    const step = parseFloat(input.step || '1');
    v = clamp(quantize(v, step), min, max);
    if (String(v) !== input.value) {
      input.value = String(v);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  };

  document.addEventListener('pointerdown', (e: PointerEvent) => {
    const t = e.target;
    if (!(t instanceof HTMLInputElement) || t.type !== 'range' || t.disabled) return;
    if (e.button !== 0) return;
    e.preventDefault();
    t.focus();
    active = t;
    fineMode = e.altKey;
    startX = e.clientX;
    startValue = parseFloat(t.value);
    t.classList.add('pc-dragging');
    if (!fineMode) applyAbsolute(t, e.clientX); // track click = jump (then drag)
    showTip(t, e.clientX);
  }, true);

  document.addEventListener('pointermove', (e: PointerEvent) => {
    if (!active) return;
    // Allow toggling fine mode mid-drag: rebase so the value doesn't jump.
    if (e.altKey !== fineMode) {
      fineMode = e.altKey;
      startX = e.clientX;
      startValue = parseFloat(active.value);
    }
    if (fineMode) {
      const r = active.getBoundingClientRect();
      const min = parseFloat(active.min || '0');
      const max = parseFloat(active.max || '100');
      const dv = ((e.clientX - startX) / r.width) * (max - min) * 0.1;
      setRange(active, startValue + dv);
    } else {
      applyAbsolute(active, e.clientX);
    }
    showTip(active, e.clientX);
  });

  document.addEventListener('pointerup', () => {
    if (!active) return;
    active.classList.remove('pc-dragging');
    active.dispatchEvent(new Event('change', { bubbles: true }));
    active = null;
    hideTip();
  });
}
