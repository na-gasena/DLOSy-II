/**
 * DLOSy20 - Shared curve-editor math & interaction helpers
 *
 * The app has four breakpoint curve editors (VCO LOOP curves, EASE, ARP
 * ENVELOPE, DRAWING SCAN SPEED). This module is their common core:
 *
 *  - Piecewise evaluation with per-segment CURVATURE (Bitwig/Vital-style
 *    "power curve"): each point may carry `c` ∈ [-1, 1] shaping the segment
 *    that LEAVES it (point i → i+1). c = 0 (or absent) is linear, so all
 *    previously saved presets/patterns load unchanged.
 *
 *  - A drag handle sits ON the curve at each segment's mid-x. Dragging it
 *    vertically bends the segment (the curve passes through the handle);
 *    right-clicking the handle resets the segment to linear.
 *
 * Editors keep their own rendering/backgrounds and event wiring — they call
 * these helpers for evaluation, handle hit-testing, curvature drags and
 * drawing the handles, so the *behaviour* is identical everywhere.
 */

export interface CPoint {
  x: number;
  y: number;
  /** Segment curvature (this point → next point). 0/undefined = linear. */
  c?: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Power-curve segment shaping: t ∈ [0,1] → [0,1].
 * c > 0 bows toward late change (ease-in), c < 0 toward early change
 * (ease-out). Exponent range 2^(-4)…2^(+4) = 1/16…16.
 */
export function curveShape(t: number, c?: number): number {
  if (!c || Math.abs(c) < 0.001) return t;
  return Math.pow(t, Math.pow(2, c * 4));
}

/** Where the curve passes at t=0.5 for a given curvature (0..1 of the segment). */
function midOf(c?: number): number {
  return curveShape(0.5, c);
}

/**
 * Inverse of midOf: given the desired normalized mid-crossing m ∈ (0,1),
 * return the curvature c that makes shape(0.5, c) = m.
 * 0.5^(2^(4c)) = m  →  c = log2( log(m)/log(0.5) ) / 4
 */
export function midToCurvature(m: number): number {
  m = clamp(m, 0.03, 0.97);
  return clamp(Math.log2(Math.log(m) / Math.log(0.5)) / 4, -1, 1);
}

/**
 * Piecewise evaluation of a breakpoint curve (normalized x → normalized y),
 * honoring per-segment curvature. Outside the point range, clamps to the
 * first/last point's y (same as every editor's previous linear behaviour).
 */
export function evalCurve(pts: CPoint[], x: number): number {
  if (!pts || pts.length === 0) return 0;
  if (pts.length === 1) return pts[0].y;
  if (x <= pts[0].x) return pts[0].y;
  if (x >= pts[pts.length - 1].x) return pts[pts.length - 1].y;
  for (let i = 0; i < pts.length - 1; i++) {
    if (x >= pts[i].x && x <= pts[i + 1].x) {
      const range = pts[i + 1].x - pts[i].x;
      const t = range > 0 ? (x - pts[i].x) / range : 0;
      return pts[i].y + (pts[i + 1].y - pts[i].y) * curveShape(t, pts[i].c);
    }
  }
  return pts[pts.length - 1].y;
}

/** A segment is "bendable" when it has enough x-width and y-height to matter. */
function bendable(a: CPoint, b: CPoint): boolean {
  return (b.x - a.x) > 0.02 && Math.abs(b.y - a.y) > 0.02;
}

export interface CurveHandle {
  seg: number; // index of the segment's left point
  x: number;   // handle position (normalized)
  y: number;
}

/** Handle positions: on the curve at each bendable segment's mid-x. */
export function segmentHandles(pts: CPoint[]): CurveHandle[] {
  const out: CurveHandle[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    if (!bendable(a, b)) continue;
    out.push({
      seg: i,
      x: (a.x + b.x) / 2,
      y: a.y + (b.y - a.y) * midOf(a.c),
    });
  }
  return out;
}

/** The bendable segment whose x-range contains `x` (for hover reveal), or -1. */
export function segmentAtX(pts: CPoint[], x: number): number {
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    if (x >= a.x && x <= b.x && bendable(a, b)) return i;
  }
  return -1;
}

/** True if the segment leaving point `seg` currently carries curvature. */
export function isBent(pts: CPoint[], seg: number): boolean {
  return Math.abs(pts[seg]?.c ?? 0) > 0.001;
}

/** Hit-test the curvature handles. Returns the segment index or -1. */
export function hitHandle(pts: CPoint[], coords: { x: number; y: number }, threshold = 0.035): number {
  for (const hnd of segmentHandles(pts)) {
    const dx = hnd.x - coords.x;
    const dy = hnd.y - coords.y;
    if (Math.sqrt(dx * dx + dy * dy) < threshold) return hnd.seg;
  }
  return -1;
}

/**
 * Pixel-space handle hit-test — use for wide canvases where a normalized
 * Euclidean radius would be badly distorted by the aspect ratio.
 * `w`/`h` are the drawing area dimensions the normalized coords map onto.
 */
export function hitHandlePx(
  pts: CPoint[], coords: { x: number; y: number },
  w: number, h: number, thresholdPx = 12,
): number {
  for (const hnd of segmentHandles(pts)) {
    const dx = (hnd.x - coords.x) * w;
    const dy = (hnd.y - coords.y) * h;
    if (Math.sqrt(dx * dx + dy * dy) < thresholdPx) return hnd.seg;
  }
  return -1;
}

/**
 * Apply a curvature drag: set segment `seg`'s curvature so the curve passes
 * through the cursor's y at the segment midpoint. Alt = fine (×0.1 pursuit).
 */
export function dragHandle(pts: CPoint[], seg: number, yNorm: number, fine = false): void {
  const a = pts[seg], b = pts[seg + 1];
  if (!a || !b || !bendable(a, b)) return;
  let target = yNorm;
  if (fine) {
    const cur = a.y + (b.y - a.y) * midOf(a.c);
    target = cur + (yNorm - cur) * 0.1;
  }
  const m = (target - a.y) / (b.y - a.y);
  a.c = midToCurvature(m);
}

/** Reset a segment to linear. Returns true if a handle was hit. */
export function resetHandleAt(pts: CPoint[], coords: { x: number; y: number }, threshold = 0.035): boolean {
  const seg = hitHandle(pts, coords, threshold);
  if (seg < 0) return false;
  delete pts[seg].c;
  return true;
}

/** Pixel-space variant of resetHandleAt (see hitHandlePx). */
export function resetHandleAtPx(
  pts: CPoint[], coords: { x: number; y: number },
  w: number, h: number, thresholdPx = 12,
): boolean {
  const seg = hitHandlePx(pts, coords, w, h, thresholdPx);
  if (seg < 0) return false;
  delete pts[seg].c;
  return true;
}

export interface DrawHandleOpts {
  /** Segment index to reveal fully (the hovered or dragged one). */
  activeSeg?: number | null;
  size?: number;
}

/**
 * Draw the curvature handles with a MINIMAL footprint (Tweeq principle 3):
 *
 *  - At rest, un-bent segments show nothing — the editor stays uncluttered.
 *  - The `activeSeg` (segment under the cursor / being dragged) shows the full
 *    hollow diamond so you can grab and bend it.
 *  - Segments that already carry curvature show a small dot at rest, so shaped
 *    segments are still discoverable at a glance without the full handle.
 *
 * X/Y map normalized coords → canvas px (each editor supplies its own).
 */
export function drawHandles(
  ctx: CanvasRenderingContext2D,
  pts: CPoint[],
  X: (x: number) => number,
  Y: (y: number) => number,
  opts: DrawHandleOpts = {},
): void {
  const size = opts.size ?? 4;
  const activeSeg = opts.activeSeg ?? null;
  for (const hnd of segmentHandles(pts)) {
    const bent = isBent(pts, hnd.seg);
    const active = hnd.seg === activeSeg;
    if (!active && !bent) continue; // hidden at rest

    const hx = X(hnd.x), hy = Y(hnd.y);
    ctx.save();
    ctx.translate(hx, hy);
    ctx.rotate(Math.PI / 4);
    if (active) {
      // Full hollow diamond — the grabbable handle
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = '#22d9f2';
      ctx.fillStyle = 'rgba(34, 217, 242, 0.35)';
      ctx.beginPath();
      ctx.rect(-size, -size, size * 2, size * 2);
      ctx.fill();
      ctx.stroke();
    } else {
      // Subtle at-rest hint for an already-bent segment
      const s = size * 0.5;
      ctx.fillStyle = 'rgba(34, 217, 242, 0.55)';
      ctx.beginPath();
      ctx.rect(-s, -s, s * 2, s * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}

/** Deep-copy points INCLUDING curvature (use in every serialize/clone path). */
export function copyPoints(pts: CPoint[]): CPoint[] {
  return pts.map(p => (p.c !== undefined ? { x: p.x, y: p.y, c: p.c } : { x: p.x, y: p.y }));
}
