import * as CONSTS from './consts.js';

/**
 * Structural-soundness heatmap — the single source of truth shared by the 2D canvas
 * (path-editor.js) and the 3D viewport (threeD-model.js).
 *
 * It replaces the old purple "possibility field" blob. Instead of a binary safe-zone,
 * every point of every layer gets a SOUNDNESS score s ∈ [0,1] (1 = structurally sound,
 * 0 = will collapse / fall), and both views render the SAME field — 2D as a colored
 * stroke along the curve, 3D as per-vertex colors on the layer bead.
 *
 * Model (a geometric RISK/CONFIDENCE map, deliberately NOT an FEA simulation).
 * This is a SINGLE-WALL print: the layer below is a bead ~NOZZLE_WIDTH wide laid along
 * a contour — NOT a solid slab. Support is therefore measured against the below layer's
 * CENTERLINE, symmetrically: a wall stepping INWARD hangs over interior air exactly like
 * one stepping outward. (The old point-in-polygon test wrongly treated the whole interior
 * as supported, so inward overhangs showed nothing.)
 *
 * Per point i of layer n, with d = lateral displacement (mm) from the below centerline:
 *   • BOND risk — single-step bead adhesion. The bead overlaps the one below by
 *     (NOZZLE_WIDTH − d): full contact at d=0, MIN_OVERLAP is the tested-good bond,
 *     zero contact at d=NOZZLE_WIDTH. risk = smoothstep(NOZZLE−MIN_OVERLAP, NOZZLE, d).
 *   • LEAN risk — cumulative cantilever, the dominant wet-clay failure. Only the EXCESS
 *     beyond a sound sustained lean accumulates: excess = max(0, d − LH·tan(ANGLE_SOUND)),
 *     reach[n][i] = REACH_RETENTION·reach[n−1][nearest(i)] + excess,
 *     risk = smoothstep(0, MAX_LEAN_NOZZLE_MULT·NOZZLE, reach).
 *     — a wall leaning at ≤ ANGLE_SOUND accumulates NOTHING (printable forever), while
 *       steeper flares redden progressively upward; RETENTION<1 makes inherited reach
 *       FADE once the wall straightens (the elastic collapse-plume).
 *     — reach is inherited from the SPATIALLY NEAREST point of the layer below, not the
 *       same array index: hand-drawn anchor layers have arbitrary start points/windings,
 *       so index correspondence broke across them (false hot spots on the wrong side).
 *   • soundness = 1 − max(bondRisk, leanRisk).
 */

// ── enabled state (default ON) + dirty-cache invalidation ─────────────────────
let _enabled = true;   // user requested: normally-on
let _dirty = true;     // recompute the stack field on next ensure()

export function isHeatmapEnabled() { return _enabled; }
export function setHeatmapEnabledFlag(on) { _enabled = !!on; }
export function invalidateSoundness() { _dirty = true; }

// ── small math helpers ────────────────────────────────────────────────────────
function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
function lerp(a, b, t) { return a + (b - a) * t; }
function smoothstep(e0, e1, x) {
    const t = clamp01((x - e0) / (e1 - e0));
    return t * t * (3 - 2 * t);
}

// ── color ramp ────────────────────────────────────────────────────────────────
// risk r = 1 - soundness. The heatmap is a TRANSPARENT OVERLAY: SOUND contributes NOTHING
// (no color at all) — 2D draws nothing, 3D shows the normal clay. Only at-risk clay is tinted,
// fading in amber → red as risk rises. The risk hues are FIXED (independent of clay scheme);
// amber/red are kept off the brand terracotta accent. 2D carries the signal in opacity (0 when
// sound), 3D blends the clay toward the risk hue (opaque geometry can't be see-through).
const AMBER = { r: 0xE0, g: 0xA0, b: 0x20 };
const RED = { r: 0xD1, g: 0x2F, b: 0x1F };

// Fixed risk hue, amber (low risk) → red (high risk).
function hotRGB(r) {
    r = clamp01(r);
    return { r: lerp(AMBER.r, RED.r, r), g: lerp(AMBER.g, RED.g, r), b: lerp(AMBER.b, RED.b, r) };
}

/** 2D overlay stroke color (css rgba). SOUND = fully transparent; risk fades in amber → red. */
export function soundnessToCss(s) {
    const r = clamp01(1 - s);
    if (r <= 0.001) return 'rgba(0,0,0,0)';   // sound: completely transparent (no overlay)
    const c = hotRGB(r);
    const a = lerp(0.0, 0.95, Math.pow(r, 0.7));
    return `rgba(${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)},${a.toFixed(3)})`;
}

/**
 * 3D per-vertex color (opaque). SOUND = the normal clay color (heatmap contributes nothing,
 * a transparent overlay), blending toward the fixed amber → red risk hue as risk rises.
 */
export function soundnessToRGB(s) {
    const r = clamp01(1 - s);
    const clay = CONSTS.CURRENT_COLOR_SCHEME.nonPrintedColor;
    const clayR = (clay >> 16) & 255, clayG = (clay >> 8) & 255, clayB = clay & 255;
    const c = hotRGB(r);
    return { r: lerp(clayR, c.r, r) / 255, g: lerp(clayG, c.g, r) / 255, b: lerp(clayB, c.b, r) / 255 };
}

/** Look up soundness at a normalized arc-length t∈[0,1] in a layer's field. */
export function soundnessAt(soundness, t) {
    if (!soundness || soundness.length === 0) return 1;
    const i = Math.round(clamp01(t) * (soundness.length - 1));
    return soundness[i];
}

// ── stack soundness field ───────────────────────────────────────────────────--
// Resample a layer's closed path to exactly n [x,y] points by arc length so point i
// of consecutive layers corresponds (they are morphs / near-morphs of each other).
function sampleLayerXY(layerItem, n) {
    const pts = (layerItem && layerItem.pointsAlongPath) ? layerItem.pointsAlongPath(n) : null;
    if (!pts || pts.length < 3) return null;
    const m = pts.length;
    if (m === n) return pts.map(p => [p.x, p.y]);
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
        const k = Math.min(m - 1, Math.floor((i / n) * m));
        out[i] = [pts[k].x, pts[k].y];
    }
    return out;
}

// Squared distance from point to segment (kept squared to defer the sqrt to one min).
function distSqPtSeg(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const l2 = dx * dx + dy * dy;
    let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const cx = ax + t * dx, cy = ay + t * dy;
    const ex = px - cx, ey = py - cy;
    return ex * ex + ey * ey;
}

// Min distance (px) from a point to a closed polygon's boundary.
function distToPoly(x, y, poly) {
    let best = Infinity;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const d = distSqPtSeg(x, y, poly[j][0], poly[j][1], poly[i][0], poly[i][1]);
        if (d < best) best = d;
    }
    return Math.sqrt(best);
}

// Index of the polygon VERTEX nearest to (x,y) — used to inherit accumulated reach
// correspondence-free (robust to differing start points / winding between layers).
function nearestPolyIndex(x, y, poly) {
    let best = 0, bestD = Infinity;
    for (let i = 0; i < poly.length; i++) {
        const dx = x - poly[i][0], dy = y - poly[i][1];
        const d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; best = i; }
    }
    return best;
}

/**
 * Walk the whole stack bottom-up, writing a Float32Array SOUNDNESS field (length
 * HEATMAP_SAMPLES, 1 = sound) onto each layerItem as `_soundness`. Layers with no path
 * get `_soundness = null` and break the support chain.
 */
export function computeStackSoundness(layers) {
    if (!layers || !layers.length) return;
    const N = CONSTS.HEATMAP_SAMPLES;
    const SCALE = CONSTS.SCALE_FACTOR;     // px per mm
    const LH = CONSTS.LAYER_HEIGHT;        // mm
    const nozzle = CONSTS.NOZZLE_WIDTH;    // mm
    const retention = CONSTS.REACH_RETENTION;
    const maxLean = CONSTS.MAX_LEAN_NOZZLE_MULT * nozzle; // mm budget before collapse (tracks nozzle)
    const bondSound = nozzle - CONSTS.MIN_OVERLAP;        // centerline shift with a tested-good bond
    const stepSound = LH * Math.tan(CONSTS.ANGLE_SOUND * Math.PI / 180); // per-step shift of a sound sustained lean

    let prevXY = null;     // sampled centerline polygon of the layer directly below
    let prevReach = null;  // accumulated cantilever reach (mm) of the layer below, by index

    for (let li = 0; li < layers.length; li++) {
        const item = layers[li];
        const hasPath = item && item.getLayer && item.getLayer() && item.getLayer().firstChild
            && item.getLayer().firstChild.length > 0;
        const xy = hasPath ? sampleLayerXY(item, N) : null;

        if (!xy) {
            if (item) item._soundness = null;
            prevXY = null; prevReach = null;
            continue;
        }

        const risk = new Float32Array(N);   // 0 = sound by default (bottom layer sits on the bed)
        const reach = new Float32Array(N);   // accumulated cantilever reach, mm
        if (prevXY) {
            for (let i = 0; i < N; i++) {
                const px = xy[i][0], py = xy[i][1];
                // Lateral displacement from the supporting bead's CENTERLINE (single-wall
                // print: support is the bead below, not the polygon's interior — inward and
                // outward steps hang over air symmetrically).
                const dMm = distToPoly(px, py, prevXY) / SCALE;

                // Single-step bead-bond risk: overlap = nozzle − d. Sound while the bond
                // keeps MIN_OVERLAP; certain droop when the beads no longer touch.
                const bondRisk = smoothstep(bondSound, nozzle, dMm);

                // Cumulative cantilever: only the excess beyond a sound sustained lean
                // accumulates, inherited from the spatially nearest support point.
                const j = prevReach ? nearestPolyIndex(px, py, prevXY) : 0;
                const excess = Math.max(0, dMm - stepSound);
                const r = retention * (prevReach ? prevReach[j] : 0) + excess;
                reach[i] = r;
                const leanRisk = smoothstep(0, maxLean, r);

                risk[i] = Math.max(bondRisk, leanRisk);
            }
        }

        const sound = new Float32Array(N);
        for (let i = 0; i < N; i++) sound[i] = 1 - risk[i];
        item._soundness = sound;

        prevXY = xy;
        prevReach = reach;
    }
}

/** Recompute the stack field only if something changed since the last compute. */
export function ensureStackSoundness(layers) {
    if (!_dirty) return;
    try { computeStackSoundness(layers); } catch (e) { console.warn('[heatmap] soundness compute failed', e); }
    _dirty = false;
}
