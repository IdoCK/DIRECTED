import * as CONSTS from './consts.js';

let smoothFactor = 0.8; // Default value (0.8 corresponds to 80% on slider)

// Function to update smooth factor from external controls
export function setSmoothFactor(value) {
  smoothFactor = value;
}

// Function to get current smooth factor
export function getSmoothFactor() {
  return smoothFactor;
}

export function getLayerBefore(index, layers) {
  for (let i = index - 1; i >= 0; i--) {
    const layerItem = layers[i];
    if (layers[i].isUserMade()) {
      return { index: i, layer: layerItem }
    }
  }
  return null;
}

export function getLayerAfter(index, layers) {
  for (let i = index + 1; i < layers.length; i++) {
    const layerItem = layers[i];
    if (layers[i].isUserMade()) {
      return { index: i, layer: layerItem }
    }
  }
  return null;
}

export function interpolate(firstLayer, secondLayer, layers) {
  if (firstLayer === null || secondLayer === null) return;

  const diff = secondLayer.index - firstLayer.index;
  if (diff < 2) return;

  // iPad performance optimization: reduce computational load
  const isIPad = /iPad|iPhone|iPod/.test(navigator.userAgent) || 
                 (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  
  // new1: point density is computed DYNAMICALLY from the contour length so long curves
  // stay smooth (no jagged edges) while short curves stay cheap. The ceiling is kept at
  // 1000 (the prior fixed value) and the floor is generous, so render quality never drops
  // below the old look. The per-layer cost of the higher count is offset by the one-shot
  // `addSegments` below (one bounds-invalidation instead of N `path.add` calls).
  const lenA = (firstLayer.layer.firstChild && firstLayer.layer.firstChild.length) || 0;
  const lenB = (secondLayer.layer.firstChild && secondLayer.layer.firstChild.length) || 0;
  const contourLen = Math.max(lenA, lenB);
  const POINT_SPACING = 0.5;                       // px between points on the longer contour
  const MAX_POINTS = isIPad ? 600 : 1000;
  const MIN_POINTS = isIPad ? 300 : 500;
  const numPoints = Math.min(
    Math.max(Math.round(contourLen / POINT_SPACING) || MIN_POINTS, MIN_POINTS),
    MAX_POINTS
  );
  const oversample = Math.min(Math.round(numPoints * 1.5), isIPad ? 900 : 1500);

  const startTime = performance.now();
  const rawA = firstLayer.layer.pointsAlongPath(oversample);
  const rawB = secondLayer.layer.pointsAlongPath(oversample);
  
  // Check if we have valid points before proceeding
  if (!rawA || rawA.length === 0 || !rawB || rawB.length === 0) {
    console.warn('! Interpolation skipped: insufficient points in source layers !');
    return;
  }
  
  const first = resampleByArcLength(rawA, numPoints);
  const second = resampleByArcLength(rawB, numPoints);
  const step = 1 / diff;

  for (let index = firstLayer.index + 1; index < secondLayer.index; index++) {
    const linearT = step * (index - firstLayer.index);
    const t = blendstep(linearT, smoothFactor); // smoothFactor = 0..1
    const layerToDraw = layers[index];
    layerToDraw.clear();
    const path = createInterpolatedPath();
    layerToDraw.addPath(path, false);

    const interpolatedPoints = interpolatePoints(first, second, t);
    // One-shot build: assign all segments at once (single bounds invalidation) instead
    // of N individual `path.add` calls — keeps the higher dynamic point count affordable.
    path.addSegments(interpolatedPoints);

    path.closed = true;

    const ev = new CustomEvent("layerModified", {
      detail: {
        layerIndex: index,
        currentLayer: path,
        layerItem: layerToDraw,
        isReset: false,
        isInterpolated: true,   // lets the handler skip the per-layer full redraw (done once at the end)
      }
    });
    
    document.dispatchEvent(ev);
  }
  
  // Performance monitoring for debugging
  const endTime = performance.now();
  const duration = endTime - startTime;
  if (isIPad && duration > 100) {
    console.log(`Interpolation took ${duration.toFixed(2)}ms (iPad mode: ${numPoints} points, ${oversample} oversample)`);
  }
}

// Send layer update to backend after interpolation
function sendLayerUpdateIfAvailable() {
  if (window.printIntegration && typeof window.printIntegration.sendLayerUpdate === 'function') {
    window.printIntegration.sendLayerUpdate();
  }
}

// Add to interpolate function
export function interpolateWithUpdate(beforeLayer, currentLayer, layers) {
    // Always use local interpolation - iPad Pro > Pi CPU
    console.log('[INTERPOLATION] Using local interpolation');
    const result = interpolate(beforeLayer, currentLayer, layers);
    
    // Send update after interpolation completes
    setTimeout(() => {
        sendLayerUpdateIfAvailable();
    }, 100);
    
    return result;
}

function createInterpolatedPath() {
  // Use 2D-specific color if available, otherwise fall back to 3D color
  const colorHex = CONSTS.CURRENT_COLOR_SCHEME.nonPrintedColor;
  const colorString = '#' + colorHex.toString(16).padStart(6, '0');
  
  return new paper.Path({
    strokeColor: colorString,
    strokeWidth: CONSTS.STROKE_W / 4,
    strokeCap: 'round',
    opacity: 1,
  });
}

export function interpolatePoints(pointsA, pointsB, t, arrays = true) {
  if (arrays)
    return pointsA.map((ptA, i) => {
      const ptB = pointsB[i];
      const x = (1 - t) * ptA[0] + t * ptB[0];
      const y = (1 - t) * ptA[1] + t * ptB[1];
      return [x, y]
    });
  return pointsA.map((ptA, i) => {
    const ptB = pointsB[i];
    if (ptB === undefined) {
      return undefined;
    }
    const x = (1 - t) * ptA.x + t * ptB.x;
    const y = (1 - t) * ptA.y + t * ptB.y;
    return new paper.Point(x, y)
  })
}

function resampleByArcLength(points, numSamples) {
  if (!points || points.length === 0) {
    return [];
  }

  // Performance optimization: use faster distance calculation
  const distances = [0];
  for (let i = 1; i < points.length; i++) {
    const dx = points[i].x - points[i - 1].x;
    const dy = points[i].y - points[i - 1].y;
    // Use faster approximation for distance on mobile devices
    const isIPad = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const distance = isIPad ? Math.abs(dx) + Math.abs(dy) * 0.7071 : Math.hypot(dx, dy);
    distances.push(distances[i - 1] + distance);
  }
  const totalLength = distances[distances.length - 1];

  if (totalLength === 0) {
    return points.map(p => [p.x, p.y]); // Return original points as arrays if no movement
  }
  const targetDistances = Array.from({ length: numSamples }, (_, i) =>
    (i / (numSamples - 1)) * totalLength
  );

  const resampled = [];
  let j = 0;
  for (const td of targetDistances) {
    while (j < distances.length - 1 && distances[j + 1] < td) j++;
    const ratio = (td - distances[j]) / (distances[j + 1] - distances[j]);

    const x = points[j].x + ratio * (points[j + 1].x - points[j].x);
    const y = points[j].y + ratio * (points[j + 1].y - points[j].y);
    resampled.push([x, y]);
  }

  return resampled;
}

function blendstep(t, factor = 1) {
  const smooth = t * t * (3 - 2 * t); // classic smoothstep
  return (1 - factor) * t + factor * smooth;
}

// Function to update colors of existing interpolated layers
export function updateInterpolatedLayersColor(layers) {
  if (!layers) return;
  // Repaint authored and interpolated paths together, preserving ghost styling.
  document.dispatchEvent(new CustomEvent('curvePaletteChanged'));
}
