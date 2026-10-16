import * as CONSTS from './consts.js';
import { interpolatePoints } from './interpolate.js';
// Static import (no circular dep — threeD-model.js never imports path-editor.js) so the
// 3D-overlay texture clear/set are SYNCHRONOUS and strictly ordered. The old un-awaited
// dynamic `import().then(...)` let a stale clearPlaneTexture() resolve after a fresh
// updatePlaneTexture(), wiping the just-drawn purple field on rapid layer switches (D3).
import { updatePlaneTexture, clearPlaneTexture } from './threeD-model.js';
// Structural-soundness heatmap — replaces the old purple "possibility field" blob.
// Shared model so the 2D stroke and the 3D bead colors never drift (see heatmap.js).
import { isHeatmapEnabled, ensureStackSoundness, soundnessToRGB, soundnessAt } from './heatmap.js';

import {
    setCurrentLayer,
    setDrawing,
    layers,
    getSkirtLayerItem,
    setSkirtLayer, // Store reference to skirt as a separate layer item
    pathEditorScope,
    selectedLayerIndex,
    resetCurve,
    drawing
} from './utils.js';

// Global variable to track the current control mode
const USER_CURVE_COLOR = CONSTS.INDICATOR_FILL_DARK; // Dark brown from the app palette marks authored curves.
let currentControlMode = null; // 'move', 'rotate', 'scale', or null

let boundsGuide = null;
let innerBoundPath = null; // Store reference to inner bound for intersection checking
let activeCurveReference = null;
let heatmapGuide = null;   // Paper layer holding the 2D structural-soundness stroke overlay

// How many faded layers BELOW the selected one also get the 2D heatmap stroke (context).
// The 3D view colors the whole stack; in 2D we cap it so rapid slider-scroll stays smooth.
const HEATMAP_2D_CONTEXT = 8;



// Store the baseline zoom level for absolute scaling calculations
let baselineZoom = 1.0;
let baselineGridSize = null;

// Fraction of the smaller pane dimension the print-bed grid fills. Higher = the 2D
// drawing area uses more of the pane (kept below 1.0 so it never crowds the edges).
const GRID_FILL = 0.84;

export function initializePathEditor() {
    pathEditorScope.activate();
    drawGrid();
    
    // Store the initial baseline after grid is drawn
    baselineZoom = pathEditorScope.view.zoom;
    baselineGridSize = window.gridSize;
    
    // Initialize zoom state based on printer log preference
    // Small delay to ensure everything is fully initialized
    setTimeout(() => {
        if (window.initializePathEditorZoom && typeof window.initializePathEditorZoom === 'function') {
            window.initializePathEditorZoom();
        }
    }, 100);
}

// Convert nozzle millimetres using the frozen bed grid, not the browser width.
function curveColor(item) {
    if (item?.isUserMade() && !item.isPrinted()) return USER_CURVE_COLOR;
    const color = item && item.isPrinted && item.isPrinted()
        ? CONSTS.CURRENT_COLOR_SCHEME.printedColor
        : CONSTS.CURRENT_COLOR_SCHEME.nonPrintedColor;
    return '#' + color.toString(16).padStart(6, '0');
}

function heatmapStrokeColor(soundness) {
    const color = soundnessToRGB(soundness);
    return new pathEditorScope.Color(color.r, color.g, color.b);
}

function curveStrokeWidth() {
    return window.gridSize
        ? CONSTS.NOZZLE_DIAMETER * window.gridSize / CONSTS.BED_SIZE
        : CONSTS.STROKE_W;
}

function createUserMadePath() {
    const path = new pathEditorScope.Path({
        strokeColor: USER_CURVE_COLOR,
        strokeWidth: curveStrokeWidth(),
        strokeCap: 'round',
        opacity: 1,
    });
    // A flat bead-width stroke stays readable without an artificial raised edge.
    path.shadowColor = null;
    path.shadowBlur = 4;
    path.shadowOffset = new pathEditorScope.Point(2, 2);
    return path;
}

export function pathHandleMouseDown(ev) {
    if (drawing) return;

    // Only start a stroke inside the printable grid - the drag handler
    // rejects out-of-grid points anyway, so a stroke started outside it
    // could never grow and its first point would sit off the bed.
    const { x, y } = ev.point;
    if (
        x < window.gridStartX ||
        x > window.gridStartX + window.gridSize ||
        y < window.gridStartY ||
        y > window.gridStartY + window.gridSize
    ) return;

    const layerItem = layers[selectedLayerIndex];
    if (layerItem.isUserMade()) return;
    // The selected extrapolation has a separate halo/heatmap overlay. Clearing its
    // model path alone leaves that overlay on screen as a second full-strength curve.
    // Keep the extrapolation solid in its palette; live input uses its own color.
    if (activeCurveReference) {
        const reference = activeCurveReference.firstChild;
        activeCurveReference.children.slice(1).forEach(child => child.remove());
        if (reference) {
            reference.strokeColor = curveColor(layerItem);
            reference.strokeWidth = curveStrokeWidth();
            reference.dashArray = [];
            reference.opacity = 1;
            reference.shadowColor = null;
        }
    }
    if (heatmapGuide) {
        heatmapGuide.children.filter(child => child.data.selectedCurve).forEach(child => child.remove());
    }
    layerItem.clear();
    const newPath = createUserMadePath();
    newPath.strokeColor = USER_CURVE_COLOR;
    newPath.data.liveStroke = true;
    setCurrentLayer(newPath);
    layerItem.addPath(newPath, true);
    newPath.add(ev.point);
    layerItem.getLayer().bringToFront();
    drawStartingPointIndicators(selectedLayerIndex);
    setDrawing(true);
}

export function pathHandlePathMouseDrag(event, currentLayer) {
    if (!drawing) return;

    const { point } = event;
    const { x, y } = point;
    if (
        x < window.gridStartX ||
        x > window.gridStartX + window.gridSize ||
        y < window.gridStartY ||
        y > window.gridStartY + window.gridSize
    ) return;

    const last = currentLayer.lastSegment.point;
    if (last.getDistance(point) > CONSTS.ANCHOR_DIST) {
        currentLayer.add(point);
        currentLayer.smooth({ type: 'catmull-rom', factor: CONSTS.SMOOTHING_FACTOR });
    }
}

function createTransformHandle(center, mode) {
    const unit = 1 / pathEditorScope.view.zoom;
    const group = new pathEditorScope.Group();
    const hit = new pathEditorScope.Path.Circle(center, 22 * unit);
    hit.fillColor = new pathEditorScope.Color(0, 0, 0, 0.001);
    hit.name = 'hitArea';
    const ring = new pathEditorScope.Path.Circle(center, 14 * unit);
    ring.fillColor = CONSTS.INDICATOR_STROKE;
    ring.strokeColor = '#263238';
    ring.strokeWidth = 3 * unit;
    group.addChildren([hit, ring]);
    const point = (x, y) => center.add(new pathEditorScope.Point(x * unit, y * unit));
    const line = coordinates => {
        const stroke = new pathEditorScope.Path(coordinates.map(([x,y]) => point(x,y)));
        stroke.strokeColor = '#263238';
        stroke.strokeWidth = 2.2 * unit;
        stroke.strokeCap = 'round';
        stroke.strokeJoin = 'round';
        group.addChild(stroke);
    };
    if (mode === 'move') {
        line([[-7,0],[7,0]]); line([[0,-7],[0,7]]);
        line([[-4,-3],[-7,0],[-4,3]]); line([[4,-3],[7,0],[4,3]]);
        line([[-3,-4],[0,-7],[3,-4]]); line([[-3,4],[0,7],[3,4]]);
    } else if (mode === 'uniform') {
        line([[-6,6],[6,-6]]);
        line([[-6,2],[-6,6],[-2,6]]); line([[2,-6],[6,-6],[6,-2]]);
    } else if (mode === 'rotate') {
        const points = [];
        for (let angle = 45; angle <= 315; angle += 15) {
            const radians = angle * Math.PI / 180;
            points.push([6 * Math.cos(radians), 6 * Math.sin(radians)]);
        }
        line(points); line([[.3,-4.3],[4.3,-4.3],[4.3,-8.3]]);
    } else {
        line([[0,-6],[0,6]]);
        line([[-3,-3],[0,-6],[3,-3]]); line([[-3,3],[0,6],[3,3]]);
    }
    group.name = mode + 'Handle';
    return group;
}
function createArrowIcon(center) { return createTransformHandle(center, 'scale'); }

function addControlPointInteraction(controlPoint, originalOpacity = 0.5, scaleDirection, layerItem) {
    // Store the original opacity and scaling properties
    controlPoint._originalOpacity = originalOpacity;
    controlPoint._scaleDirection = scaleDirection;
    controlPoint._layerItem = layerItem;

    let isDragging = false;
    let dragStartPoint = null;
    let originalBounds = null;
    let originalControlPosition = null;
    let originalScaleOrigin = null; // Store the original scale origin point
    let originalPathPoints = null; // Store the original path points


    // Mouse down (click start)
    controlPoint.onMouseDown = function(event) {
        this.opacity = 1;
        isDragging = true;
        dragStartPoint = event.point.clone();
        originalBounds = this._layerItem.getLayer().firstChild.strokeBounds.clone();
        originalControlPosition = this.position.clone();

        // Hide start indicators when scaling starts
        hideStartingPointIndicators();

        // Find and store the original scale origin point
        const path = this._layerItem.getLayer().firstChild;
        const pathPoints = [];
        for (let i = 0; i < path.segments.length; i++) {
            pathPoints.push({
                point: path.segments[i].point.clone(),
                handleIn: path.segments[i].handleIn.clone(),
                handleOut: path.segments[i].handleOut.clone()
            });
        }
        originalPathPoints = pathPoints; // Store original path points with handles

        switch (this._scaleDirection) {
            case 'uniform':
                originalScaleOrigin = path.bounds.center.clone();
                break;
            case 'top':
                // Scale from the bottommost point on the curve
                const bottomPoint = originalPathPoints.reduce((bottom, segment) =>
                    segment.point.y > bottom.point.y ? segment : bottom);
                originalScaleOrigin = new pathEditorScope.Point(originalBounds.center.x, bottomPoint.point.y);
                break;
            case 'bottom':
                // Scale from the topmost point on the curve
                const topPoint = originalPathPoints.reduce((top, segment) =>
                    segment.point.y < top.point.y ? segment : top);
                originalScaleOrigin = new pathEditorScope.Point(originalBounds.center.x, topPoint.point.y);
                break;
            case 'left':
                // Scale from the rightmost point on the curve
                const rightPoint = originalPathPoints.reduce((right, segment) =>
                    segment.point.x > right.point.x ? segment : right);
                originalScaleOrigin = new pathEditorScope.Point(rightPoint.point.x, originalBounds.center.y);
                break;
            case 'right':
                // Scale from the leftmost point on the curve
                const leftPoint = originalPathPoints.reduce((left, segment) =>
                    segment.point.x < left.point.x ? segment : left);
                originalScaleOrigin = new pathEditorScope.Point(leftPoint.point.x, originalBounds.center.y);
                break;
        }

        event.stopPropagation();
    };

    // Mouse drag (scaling)
    controlPoint.onMouseDrag = function(event) {
        if (!isDragging) return;

        const currentPoint = event.point;
        const layer = this._layerItem.getLayer();
        const path = layer.firstChild;

        if (!path || !path.segments) return;

        if (this._scaleDirection === 'uniform') {
            const factor = calculateUniformScaleFactor(dragStartPoint, currentPoint, originalBounds);
            scalePathFromOriginal(path, factor, 'uniform', originalPathPoints, originalScaleOrigin);
            event.stopPropagation();
            return;
        }

        // Constrain control point movement to the scaling direction only
        let constrainedPoint;
        switch (this._scaleDirection) {
            case 'top':
            case 'bottom':
                // Vertical scaling - only allow Y movement, keep original X
                // Also constrain Y to grid boundaries
                const constrainedY = Math.max(
                    window.gridStartY,
                    Math.min(window.gridStartY + window.gridSize, currentPoint.y)
                );
                constrainedPoint = new pathEditorScope.Point(originalControlPosition.x, constrainedY);
                break;
            case 'left':
            case 'right':
                // Horizontal scaling - only allow X movement, keep original Y
                // Also constrain X to grid boundaries
                const constrainedX = Math.max(
                    window.gridStartX,
                    Math.min(window.gridStartX + window.gridSize, currentPoint.x)
                );
                constrainedPoint = new pathEditorScope.Point(constrainedX, originalControlPosition.y);
                break;
        }

        // Move the control point to follow the cursor in the constrained direction
        this.position = constrainedPoint;

        // Calculate scale factor based on movement from ORIGINAL control position
        const scaleFactor = calculateScaleFactor(originalControlPosition, constrainedPoint, this._scaleDirection, originalBounds);

        // Only apply scaling if there's significant movement (avoid tiny movements causing unwanted scaling)
        if (Math.abs(scaleFactor - 1.0) > 0.01) {
            // Apply scaling to the path from the ORIGINAL path points
            scalePathFromOriginal(path, scaleFactor, this._scaleDirection, originalPathPoints, originalScaleOrigin);
        }

        event.stopPropagation();
    };

    // Mouse up (click end)
    controlPoint.onMouseUp = function(event) {
        if (isDragging) {
            this.opacity = this._originalOpacity;
            isDragging = false;
            dragStartPoint = null;
            originalBounds = null;
            originalControlPosition = null;
            originalScaleOrigin = null;

            // Get the current scaled path
            const currentPath = this._layerItem.getLayer().firstChild;
            if (currentPath && currentPath.segments) {
                // Extract the segment points from the scaled path
                const pathPoints = currentPath.segments.map(segment => this._scaleDirection === 'uniform'
                    ? new pathEditorScope.Segment(segment.point.clone(), segment.handleIn.clone(), segment.handleOut.clone())
                    : segment.point.clone());

                // Clear the layer completely (removes all paths and 3D meshes)
                this._layerItem.clear();
                this._layerItem.setUserMade(false);

                // Create a completely new path from scratch
                const newPath = createUserMadePath();

                // Add all the points to recreate the path
                pathPoints.forEach(point => {
                    newPath.add(point);
                });

                // Close and smooth the path (same as when drawing normally)
                newPath.closed = true;
                if (this._scaleDirection !== 'uniform') newPath.smooth({ type: 'catmull-rom', factor: CONSTS.SMOOTHING_FACTOR });

                // Add the new path to the layer and mark as user-made
                this._layerItem.addPath(newPath, true);
            }

            // Trigger layer update to refresh 3D model and other systems
            const layerIndex = layers.indexOf(this._layerItem);
            const ev = new CustomEvent("layerModified", {
                detail: {
                    layerIndex: layerIndex,
                    currentLayer: this._layerItem.getLayer().firstChild,
                    layerItem: this._layerItem,
                    isReset: false,
                }
            });
            document.dispatchEvent(ev);

            // Regenerate skirt if this is the first layer
            if (layerIndex === 0) {
                createFirstLayerSkirt();
            }

            // Send layer update to backend
            if (window.printIntegration && typeof window.printIntegration.sendLayerUpdate === 'function') {
                window.printIntegration.sendLayerUpdate();
            }

            // Redraw anchor points to update their positions
            redrawLayers(layerIndex);

            // Show start indicators again after scaling is complete
            showStartingPointIndicators();
        }
        event.stopPropagation();
    };
}

// Helper function to rotate a point around a center
function rotatePointAroundCenter(point, center, angle) {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);

    // Translate point to origin
    const translatedX = point.x - center.x;
    const translatedY = point.y - center.y;

    // Rotate
    const rotatedX = translatedX * cos - translatedY * sin;
    const rotatedY = translatedX * sin + translatedY * cos;

    // Translate back
    return new pathEditorScope.Point(rotatedX + center.x, rotatedY + center.y);
}

// Helper function to rotate a vector (for handles)
function rotateVector(vector, angle) {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);

    const rotatedX = vector.x * cos - vector.y * sin;
    const rotatedY = vector.x * sin + vector.y * cos;

    return new pathEditorScope.Point(rotatedX, rotatedY);
}

// Toggle control mode and update UI
export function toggleControlMode(mode) {
    // Get current layer to restore shadow if deactivating move mode
    const currentLayerItem = layers[selectedLayerIndex];

    // If clicking the same mode, deactivate it
    if (currentControlMode === mode) {
        // If deactivating move mode, restore normal shadow and remove move interaction
        if (mode === 'move' && currentLayerItem && currentLayerItem.isUserMade()) {
            const path = currentLayerItem.getLayer().firstChild;
            if (path) {
                path.shadowBlur = 4; // Default shadow blur
                path.shadowOffset = new pathEditorScope.Point(2, 2); // Default shadow offset
                // Note: No stroke color restoration needed since we don't change it in move mode

                // Remove move interaction handlers
                path.onMouseDown = null;
                path.onMouseDrag = null;
                path.onMouseUp = null;
            }
        }

        // If deactivating rotate mode, restore normal shadow and remove rotate interaction
        if (mode === 'rotate' && currentLayerItem && currentLayerItem.isUserMade()) {
            const path = currentLayerItem.getLayer().firstChild;
            if (path) {
                path.shadowBlur = 4; // Default shadow blur
                path.shadowOffset = new pathEditorScope.Point(2, 2); // Default shadow offset
                // Note: No stroke color restoration needed since we don't change it in rotate mode

                // Remove rotate interaction handlers
                path.onMouseDown = null;
                path.onMouseDrag = null;
                path.onMouseUp = null;
            }
        }

        currentControlMode = null;
    } else {
        // If switching from move mode to another mode, remove move interaction
        if (currentControlMode === 'move' && currentLayerItem && currentLayerItem.isUserMade()) {
            const path = currentLayerItem.getLayer().firstChild;
            if (path) {
                path.shadowBlur = 4; // Default shadow blur
                path.shadowOffset = new pathEditorScope.Point(2, 2); // Default shadow offset
                // Note: No stroke color restoration needed since we don't change it in move mode
                // Remove move interaction handlers
                path.onMouseDown = null;
                path.onMouseDrag = null;
                path.onMouseUp = null;
            }
        }

        // If switching from rotate mode to another mode, remove rotate interaction
        if (currentControlMode === 'rotate' && currentLayerItem && currentLayerItem.isUserMade()) {
            const path = currentLayerItem.getLayer().firstChild;
            if (path) {
                path.shadowBlur = 4; // Default shadow blur
                path.shadowOffset = new pathEditorScope.Point(2, 2); // Default shadow offset
                // Note: No stroke color restoration needed since we don't change it in rotate mode
                // Remove rotate interaction handlers
                path.onMouseDown = null;
                path.onMouseDrag = null;
                path.onMouseUp = null;
            }
        }

        currentControlMode = mode;
    }

    // Selecting a tool promotes the displayed generated curve to an editable anchor.
    // Keep the exact geometry; the normal edit pipeline updates neighbors and slider ticks.
    const selectedPath = currentLayerItem?.getLayer()?.firstChild;
    if (currentControlMode !== null && selectedPath?.segments?.length > 1 &&
        !currentLayerItem.isUserMade() && !currentLayerItem.isPrinted() && !currentLayerItem.isLocked()) {
        currentLayerItem.setUserMade(true);
        selectedPath.strokeColor = USER_CURVE_COLOR;
        selectedPath.opacity = 1;
        document.dispatchEvent(new CustomEvent('layerModified', { detail: {
            layerIndex: selectedLayerIndex, currentLayer: selectedPath,
            layerItem: currentLayerItem, isReset: false
        }}));
    }
    // Update button states
    updateControlModeButtons();

    // Redraw anchor points for current layer to show appropriate controls
    if (currentLayerItem && currentLayerItem.isUserMade()) {
        // Always remove existing control points first
        currentLayerItem.removeAnchorPoints();

        // Then draw new ones if a mode is selected
        if (currentControlMode !== null) {
            drawAnchorPoints(currentLayerItem);
        }
        
        // Redraw starting point indicators to reflect the new control mode
        drawStartingPointIndicators(selectedLayerIndex);
    }
}

// Update button visual states
function updateControlModeButtons() {
    const moveButton = document.getElementById('MoveCurve');
    const rotateButton = document.getElementById('RotateCurve');
    const scaleButton = document.getElementById('ScaleCurve');

    // Clear active state on all transform tools (class + aria-pressed for a11y)
    [moveButton, rotateButton, scaleButton].forEach(btn => {
        if (btn) { btn.classList.remove('active'); btn.setAttribute('aria-pressed', 'false'); }
    });

    // Mark the current mode's tool as the single active/pressed tool
    const activeBtn =
        currentControlMode === 'move' ? moveButton :
        currentControlMode === 'rotate' ? rotateButton :
        currentControlMode === 'scale' ? scaleButton : null;
    if (activeBtn) { activeBtn.classList.add('active'); activeBtn.setAttribute('aria-pressed', 'true'); }
}

function drawAnchorPoints(item) {
    const layer = item.getLayer();
    if (!layer) return;
    const bounds = layer.firstChild.strokeBounds;
    if (bounds.width === 0) {
        return;
    }

    const anchorPoints = item.anchorPoints;

    // Only show controls based on the current mode
    if (currentControlMode === 'scale') {
        // Show scaling control points
        const top = createArrowIcon(
            new pathEditorScope.Point(bounds.x + bounds.width / 2, bounds.y - CONSTS.ANCHOR_BOX_PADDING2),
            CONSTS.HORIZONTAL_ANCHOR_POINT_COLOR
        );
        top.opacity = 1;
        addControlPointInteraction(top, 1, 'top', item);
        anchorPoints.addChild(top);

        const bottom = createArrowIcon(
            new pathEditorScope.Point(bounds.x + bounds.width / 2, bounds.y + bounds.height + CONSTS.ANCHOR_BOX_PADDING2),
            CONSTS.HORIZONTAL_ANCHOR_POINT_COLOR
        );
        bottom.opacity = 1;
        addControlPointInteraction(bottom, 1, 'bottom', item);
        anchorPoints.addChild(bottom);

        const left = createArrowIcon(
            new pathEditorScope.Point(bounds.x - CONSTS.ANCHOR_BOX_PADDING2, bounds.y + bounds.height / 2),
            CONSTS.VERTICAL_ANCHOR_POINT_COLOR
        );
        left.rotation = 90;
        left.opacity = 1;
        addControlPointInteraction(left, 1, 'left', item);
        anchorPoints.addChild(left);

        const right = createArrowIcon(
            new pathEditorScope.Point(bounds.x + bounds.width + CONSTS.ANCHOR_BOX_PADDING2, bounds.y + bounds.height / 2),
            CONSTS.VERTICAL_ANCHOR_POINT_COLOR
        );
        right.rotation = -90;
        right.opacity = 1;
        addControlPointInteraction(right, 1, 'right', item);
        anchorPoints.addChild(right);
        const center = createTransformHandle(bounds.center, 'uniform');
        addControlPointInteraction(center, 1, 'uniform', item);
        anchorPoints.addChild(center);
        const unit = 1 / pathEditorScope.view.zoom;
        // Size cues are decorative and cannot intercept the central drag target.
        for (const [offset, radius] of [[-34, 6], [42, 18]]) {
            const dot = new pathEditorScope.Path.Circle(
                bounds.center.add(new pathEditorScope.Point(offset * unit, 0)), radius * unit);
            dot.fillColor = CONSTS.INDICATOR_STROKE;
            dot.strokeColor = '#263238';
            dot.strokeWidth = 2 * unit;
            dot.locked = true;
            anchorPoints.addChild(dot);
        }



    } else if (currentControlMode === 'move') {
        // Enhance drop shadow for move mode and make path draggable
        const path = item.getLayer().firstChild;
        if (path) {
            // Store original shadow properties
            path._originalShadowBlur = path.shadowBlur;
            path._originalShadowOffset = path.shadowOffset.clone();

            // Enhance shadow for move mode
            path.shadowBlur = 8;
            path.shadowOffset = new pathEditorScope.Point(-10, 10);
            // Note: No stroke color change - we use the Start Point indicator instead

            // Make the entire path draggable
            addDirectPathMoveInteraction(path, item);
        }
    } else if (currentControlMode === 'rotate') {
        // Enhance drop shadow for rotate mode
        const path = item.getLayer().firstChild;
        if (path) {
            // Store original shadow properties
            path._originalShadowBlur = path.shadowBlur;
            path._originalShadowOffset = path.shadowOffset.clone();

            // Create expanded shadow effect with larger blur and centered offset
            path.shadowBlur = 8; // Larger blur for more spread
            path.shadowOffset = new pathEditorScope.Point(-10, 10); // Center the main shadow
            // Note: No stroke color change - we use the Start Point indicator instead

            // Make the entire path draggable for rotation
            addDirectPathRotateInteraction(path, item);
        }
    }
    // If no mode is selected, show no control points (clean interface)
}

export function pathHandleMouseUp(currentLayer, index) {
    if (!drawing) return;

    if (currentLayer.segments.length < 3) {
        // Discard the stub - and un-mark the layer, which mousedown flagged
        // user-made the moment the stroke started. Leaving it marked wedges
        // the layer: isUserMade() blocks every future stroke on it.
        currentLayer.remove();
        const layerItem = layers[index];
        if (layerItem && !layerItem.isPrinted()) {
            layerItem.setUserMade(false);
        }
        setDrawing(false);
        setCurrentLayer(null);
        redrawLayers(index);
        return;
    }

    currentLayer.data.liveStroke = false;
    currentLayer.strokeColor = curveColor(layers[index]);

    // Ensure the path is properly closed for interpolation
    currentLayer.closed = true;
    currentLayer.smooth({ type: 'catmull-rom', factor: CONSTS.SMOOTHING_FACTOR });

    const layerItem = layers[index];

    // Only draw control points if there's an active control mode
    if (currentControlMode !== null) {
        drawAnchorPoints(layerItem);
    }

    if (index === 0) {
        createFirstLayerSkirt();
    }

    // Dispatch the layer modified event for interpolation
    const ev = new CustomEvent("layerModified", {
        detail: {
            layerIndex: index,
            currentLayer: currentLayer,
            layerItem: layers[index],
            isReset: false,
        }
    });
    document.dispatchEvent(ev);

    // Ensure global layers reference is up to date
    window.layers = layers;

    // Send layer update to backend when new path is created
    if (window.printIntegration && typeof window.printIntegration.sendLayerUpdate === 'function') {
        console.log('Sending layer update to backend after new path creation');
        window.printIntegration.sendLayerUpdate();
    } else {
        console.warn('Print integration not available for layer update');
    }

    setDrawing(false);
    setCurrentLayer(null);
}


function drawGridOverlay(x, y, gridSize) {
    const overlayLayer = new pathEditorScope.Layer({ name: 'gridOverlayLayer' });
    overlayLayer.addChild(new pathEditorScope.Path.Rectangle({
        from: [x, y],
        to: [x + gridSize, y + gridSize],
        fillColor: new pathEditorScope.Color(184 / 255, 184 / 255, 184 / 255, 0.3) // Match 3D plane color and opacity
    }));
    overlayLayer.sendToBack();
}

function clear2DGrid() {
    // Remove existing grid layer if it exists
    const existingGridLayer = pathEditorScope.project.layers.find(layer => layer.name === 'gridLayer');
    if (existingGridLayer) {
        existingGridLayer.remove();
    }
    
    // Remove existing grid overlay layer if it exists
    const existingOverlayLayer = pathEditorScope.project.layers.find(layer => layer.name === 'gridOverlayLayer');
    if (existingOverlayLayer) {
        existingOverlayLayer.remove();
    }
}

function getCanvasDimensions() {
    const pathEditorBox = document.getElementById('PathEditorBox');
    if (!pathEditorBox) return { width: 400, height: 400 };
    
    const rect = pathEditorBox.getBoundingClientRect();
    return {
        width: rect.width,
        height: rect.height
    };
}

function updateCanvasSize() {
    if (!pathEditorScope || !pathEditorScope.view) return;
    const dimensions = getCanvasDimensions();
    // Paper.js owns the HiDPI backing store; only set view.viewSize. Do NOT write canvas.width/height (RESEARCH Pitfall 1).
    pathEditorScope.view.viewSize = new pathEditorScope.Size(dimensions.width, dimensions.height);
}

function update2DGrid() {
    if (!pathEditorScope || !pathEditorScope.view) return;
    const dimensions = getCanvasDimensions();

    // The grid geometry is frozen (see drawGrid). On resize we adapt ONLY the view:
    //   1. size the view to the pane,
    //   2. apply a single uniform fit-zoom so the frozen grid keeps filling ~80% of the
    //      smaller dimension (no dampening, no cumulative drift),
    //   3. center the view on the frozen grid center.
    // Because zoom + center are view transforms over the whole project, the grid and
    // every drawn curve transform identically — they stay locked together (fixes 5b).
    if (!baselineGridSize) {
        // Grid not drawn yet — just size the view; drawGrid will freeze geometry.
        pathEditorScope.view.viewSize = new pathEditorScope.Size(dimensions.width, dimensions.height);
        return;
    }

    pathEditorScope.activate();
    const preferredFill = Number(getComputedStyle(document.documentElement).getPropertyValue('--grid-fill')) || GRID_FILL;
    const fitZoom = baselineZoom * (Math.min(dimensions.width, dimensions.height) * Math.min(.98, Math.max(.5, preferredFill))) / baselineGridSize;
    pathEditorScope.view.viewSize = new pathEditorScope.Size(dimensions.width, dimensions.height);
    pathEditorScope.view.zoom = fitZoom;
    pathEditorScope.view.center = new pathEditorScope.Point(
        window.gridStartX + baselineGridSize / 2,
        window.gridStartY + baselineGridSize / 2
    );

    // Redraw the grid at its frozen coordinates; curves are untouched (they ride the view).
    clear2DGrid();
    drawGrid();
    if (typeof redrawLayers === 'function' && selectedLayerIndex !== undefined) {
        redrawLayers(selectedLayerIndex);
    }
    pathEditorScope.view.update();
}

function drawGrid() {
    const view = pathEditorScope.view;

    // Grid geometry is a FROZEN project constant: computed once from the initial view
    // size, then reused on every redraw. Drawn curves live in this same project space,
    // so freezing the grid origin/size keeps the grid and the curves locked together
    // across resizes — only the view zoom/center adapt to the new pane size (see
    // update2DGrid). Recomputing gridStartX/gridSize from the live view size on every
    // resize (the old behavior) re-anchored the grid while curves kept the old origin,
    // which is what made them drift apart.
    if (baselineGridSize === null) {
        const canvasWidth = view.viewSize.width;
        const canvasHeight = view.viewSize.height;
        const gridSize0 = Math.min(canvasWidth, canvasHeight) * GRID_FILL;
        window.gridSize = gridSize0;
        window.squareSize = gridSize0 / 22;
        window.scaleFactor = CONSTS.BED_SIZE / gridSize0;
        window.gridStartX = (canvasWidth - gridSize0) / 2;
        window.gridStartY = (canvasHeight - gridSize0) / 2;
        baselineGridSize = gridSize0;
        baselineZoom = view.zoom;
        console.log('Baseline grid geometry frozen:', { baselineGridSize, baselineZoom, gridStartX: window.gridStartX, gridStartY: window.gridStartY });
    }
    const gridSize = window.gridSize;
    const squareSize = window.squareSize;

    const gridLayer = new pathEditorScope.Layer({ name: 'gridLayer' });

    // Draw grid lines (vertical and horizontal separately to avoid overlaps)
    const gridColor = new pathEditorScope.Color('#c8bdb8');

    // Draw vertical lines (including left and right borders)
    for (let i = 0; i <= 22; i++) {
        const x = window.gridStartX + (i * squareSize);
        const line = new pathEditorScope.Path.Line(
            new pathEditorScope.Point(x, window.gridStartY),
            new pathEditorScope.Point(x, window.gridStartY + gridSize)
        );
        line.strokeColor = gridColor;
        line.strokeWidth = 1;
        gridLayer.addChild(line);
    }

    // Draw horizontal lines (including top and bottom borders)
    for (let i = 0; i <= 22; i++) {
        const y = window.gridStartY + (i * squareSize);
        const line = new pathEditorScope.Path.Line(
            new pathEditorScope.Point(window.gridStartX, y),
            new pathEditorScope.Point(window.gridStartX + gridSize, y)
        );
        line.strokeColor = gridColor;
        line.strokeWidth = 1;
        gridLayer.addChild(line);
    }

    // Add tick marks
    drawTickMarks(gridLayer, window.gridStartX, window.gridStartY, gridSize, squareSize);

    // Add a red 'L' shape to signify the middle of the 2D grid and orientation
    const middleX = window.gridStartX + gridSize / 2;
    const middleY = window.gridStartY + gridSize / 2;

    // Vertical part of the 'L' (pointing upward)
    const verticalLine = new pathEditorScope.Path.Line({
        from: [middleX - gridSize / 2, middleY + gridSize / 2],
        to: [middleX - gridSize / 2 + squareSize, middleY + gridSize / 2],
        strokeColor: 'red',
        strokeWidth: 2,
        opacity: 0.7,
    });
    gridLayer.addChild(verticalLine);

    // Horizontal part of the 'L' (pointing rightward)
    const horizontalLine = new pathEditorScope.Path.Line({
        from: [middleX - gridSize / 2, middleY + gridSize / 2],
        to: [middleX - gridSize / 2, middleY + gridSize / 2 - squareSize],
        strokeColor: 'red',
        strokeWidth: 2,
        opacity: 0.7,
    });
    gridLayer.addChild(horizontalLine);

    gridLayer.sendToBack();

    drawGridOverlay(window.gridStartX, window.gridStartY, window.gridSize); // Add the overlay after the grid
}

function drawTickMarks(gridLayer, startX, startY, gridSize, squareSize) {
    const unit = 1 / pathEditorScope.view.zoom;
    const sizes = { small: 10, medium: 12, large: 14 };
    const preference = document.body.classList.contains('text-size-small') ? 'small'
        : document.body.classList.contains('text-size-large') ? 'large' : 'medium';
    const labelSize = sizes[preference] * unit;
    const tickLength = 5 * unit; // Screen-sized labels and ticks remain steady on resize
    const tickWidth = unit; // Width of tick marks
    const tickColor = new pathEditorScope.Color('#c8bdb8'); // Warm-grey ticks consistent with grid

    // Draw tick marks every 5 grid squares (major ticks) and every square (minor ticks)
    const majorTickInterval = 5;
    const minorTickLength = tickLength * 0.6;

    // Top edge tick marks only
    // Update tick mark logic to range from 0 to 220
    for (let i = 0; i <= 22; i++) {
        const x = startX + (i * squareSize); // Direct mapping for 0 to 220 range
        const isMajor = i % majorTickInterval === 0;
        const currentTickLength = isMajor ? tickLength : minorTickLength;

        const tick = new pathEditorScope.Path.Line(
            new pathEditorScope.Point(x, startY - currentTickLength),
            new pathEditorScope.Point(x, startY)
        );
        tick.strokeColor = tickColor;
        tick.strokeWidth = tickWidth;
        gridLayer.addChild(tick);

        // Add numbers for major ticks
        if (isMajor) {
            const text = new pathEditorScope.PointText(new pathEditorScope.Point(x, startY - currentTickLength - 5 * unit));
            text.content = (i * 10).toString(); // Convert to mm (each square = 10mm in real world)
            text.style = {
                // fontFamily: 'Arial',
                // fontWeight: 'bold',
                fontSize: labelSize,
                fontFamily: getComputedStyle(document.body).fontFamily,
                fillColor: tickColor,
                justification: 'center'
            };
            gridLayer.addChild(text);
        }
    }

    // Left edge tick marks only
    for (let i = 0; i <= 22; i++) {
        const y = startY + i * squareSize;
        const isMajor = i % majorTickInterval === 0;
        const currentTickLength = isMajor ? tickLength : minorTickLength;

        const tick = new pathEditorScope.Path.Line(
            new pathEditorScope.Point(startX - currentTickLength, y),
            new pathEditorScope.Point(startX, y)
        );
        tick.strokeColor = tickColor;
        tick.strokeWidth = tickWidth;
        gridLayer.addChild(tick);

        // Add numbers for major ticks (flip Y coordinate since Y increases downward in Paper.js)
        if (isMajor) {
            const text = new pathEditorScope.PointText(new pathEditorScope.Point(startX - currentTickLength - 5 * unit, y + labelSize * 0.35));
            text.content = ((22 - i) * 10).toString(); // Flip Y coordinate: 220 at top, 0 at bottom
            text.style = {
                // fontFamily: 'Arial',
                // fontWeight: 'bold',
                fontSize: labelSize,
                fontFamily: getComputedStyle(document.body).fontFamily,
                fillColor: tickColor,
                justification: 'right'
            };
            gridLayer.addChild(text);
        }
    }
}

// The immediately preceding layer is 50%; depth fades quickly enough to avoid
// many overlapping contours accumulating into an apparently selected stroke.
function previousLayerOpacity(distance) {
    return 0.5 * Math.pow(0.78, Math.max(0, distance - 1));
}

export function redrawLayers(selLayerInd) {
    if (activeCurveReference) {
        activeCurveReference.remove();
        activeCurveReference = null;
    }
    const maxDistance = CONSTS.FADE_LAYER_COUNT; // Maximum distance for fading

    // Clean up any previous bounds guide when redrawing layers
    cleanupBoundsGuide();
    

    // First pass: set opacity and collect layer info
    layers.forEach((item, ind) => {
        const layer = item.getLayer();
        if (layer !== null) {
            const distance = Math.abs(ind - selLayerInd); // Calculate distance from the selected layer
            item.removeAnchorPoints();
            const curve = layer.firstChild;
            if (curve) {
                curve.strokeColor = curve.data.liveStroke ? USER_CURVE_COLOR : curveColor(item);
                curve.strokeWidth = ind === selLayerInd
                    ? curveStrokeWidth()
                    : 1.5 / pathEditorScope.view.zoom;
                curve.strokeCap = 'round';
                curve.strokeJoin = 'round';
                curve.shadowColor = null;
                curve.opacity = 1;
            }

            if (ind === selLayerInd) {
                // Keep the selected layer fully visible
                layer.opacity = 1;
            } else if (ind < selLayerInd && distance <= maxDistance) {
                // Calculate opacity based on distance
                layer.opacity = previousLayerOpacity(distance);
            } else {
                // Hide layers beyond the fade range
                layer.opacity = 0;
            }
        } else {
            return;
        }
    });

    // Second pass: ensure proper layer ordering
    const currentLayer = layers[selLayerInd];
    const selectedLayer = currentLayer.getLayer();
    if (selectedLayer && selectedLayer.firstChild) {
        // Retain a hidden copy for the replacement-drawing reference, without outlining the curve.
        activeCurveReference = new pathEditorScope.Layer({ name: 'activeCurveReference' });
        const halo = selectedLayer.firstChild.clone({ insert: false });
        halo.strokeColor = curveColor(currentLayer);
        halo.strokeWidth = curveStrokeWidth();
        halo.opacity = 0;
        halo.fillColor = null;
        halo.shadowColor = null;
        halo.locked = true;
        activeCurveReference.addChild(halo);
        activeCurveReference.bringToFront();
        selectedLayer.bringToFront(); // Bring the selected layer to the front
    }

    // Only draw control points if there's an active control mode and the layer is user-made
    if (currentControlMode !== null && currentLayer.isUserMade()) {
        drawAnchorPoints(currentLayer);
    }

    // Draw starting point indicators for all user-made layers
    drawStartingPointIndicators(selLayerInd);
    
    // Create skirt for first layer when user has drawn content
    if (selLayerInd === 0) {
        createFirstLayerSkirt();
    }
    
    if (isHeatmapEnabled()) {
        drawHeatmap2D(selLayerInd);
    }
}

// Helper function to properly clean up bounds guide
function cleanupBoundsGuide() {
    if (boundsGuide !== null) {
        boundsGuide.removeChildren();
        if (boundsGuide.parent) {
            boundsGuide.remove();
        }
        boundsGuide = null;
    }
    innerBoundPath = null;

    cleanupHeatmapGuide();

    // Clean up any legacy 3D overlay-plane texture (the heatmap colors the beads directly
    // now, so no overlay plane is created — this is a harmless no-op if none exists).
    clearPlaneTexture();

    const skirtLayerItem = getSkirtLayerItem(); 
    // Also clean up skirt when changing layers
    if (skirtLayerItem) {
        const skirtLayer = skirtLayerItem.getLayer();
        if (skirtLayer) {
            skirtLayer.remove();
        }

        setSkirtLayer(null);
    }
}

/**
 * Creates a skirt for the first layer - a simple bounding box with 5mm offset
 * that fits within the grid and is printed on the same Z plane as the first layer.
 */
function createFirstLayerSkirt() {
    const skirtLayerItem = getSkirtLayerItem();  
    // Clean up any existing skirt (both 2D and 3D)
    skirtLayerItem.clear();

    // Get the first layer content
    const firstLayerItem = layers[0];
    if (!firstLayerItem || !firstLayerItem.isUserMade()) {
        return;
    }
    
    const firstLayer = firstLayerItem.getLayer();
    if (!firstLayer || !firstLayer.firstChild) {
        return;
    }
    
    // Get the bounding box of the first layer shape
    const shape = firstLayer.firstChild;
    if (!shape) {
        return;
    }
    
    const bounds = shape.bounds;
    if (!bounds) {
        return;
    }
    
    // Create skirt offset (3mm standard distance)
    const skirtDistance = 3 * CONSTS.SCALE_FACTOR;
    
    // Create rectangular bounding box with offset
    const skirtBounds = new pathEditorScope.Rectangle(
        bounds.left - skirtDistance,
        bounds.top - skirtDistance,
        bounds.width + (skirtDistance * 2),
        bounds.height + (skirtDistance * 2)
    );
    
    // Create the rectangular skirt path
    const skirtPath = new pathEditorScope.Path.Rectangle(skirtBounds);
    
    if (skirtPath) {
        // Clip to grid boundaries
        const gridBounds = new pathEditorScope.Rectangle(
            window.gridStartX,
            window.gridStartY,
            window.gridSize,
            window.gridSize
        );
        const gridRect = new pathEditorScope.Path.Rectangle(gridBounds);
        
        try {
            // Clip the skirt to grid boundaries using intersection, but if it fails
            // or produces no result, create a minimal skirt within bounds
            let finalSkirtPath = null;
            
            try {
                const clippedSkirtPath = skirtPath.intersect(gridRect);
                if (clippedSkirtPath && clippedSkirtPath.area > 0) {
                    finalSkirtPath = clippedSkirtPath;
                }
            } catch (intersectionError) {
                console.warn('Skirt intersection failed:', intersectionError);
            }
            
            // If intersection failed or produced no result, create a minimal skirt
            // This ensures skirt always exists even when path is outside grid
            if (!finalSkirtPath) {
                // Create a small rectangular skirt at the center of the grid as fallback
                const centerX = window.gridStartX + (window.gridSize / 2);
                const centerY = window.gridStartY + (window.gridSize / 2);
                const fallbackSize = Math.min(window.gridSize * 0.1, 10 * CONSTS.SCALE_FACTOR);
                
                const fallbackBounds = new pathEditorScope.Rectangle(
                    centerX - fallbackSize/2,
                    centerY - fallbackSize/2,
                    fallbackSize,
                    fallbackSize
                );
                finalSkirtPath = new pathEditorScope.Path.Rectangle(fallbackBounds);
            }
            
            gridRect.remove();
            
            if (finalSkirtPath) {
                // Create a new Paper.js layer for the skirt
                const skirtLayer = new pathEditorScope.Layer();
                skirtLayer.name = 'SkirtLayer';
                
                // Style the skirt path
                finalSkirtPath.strokeColor = new pathEditorScope.Color(0, 0, 0); // Black
                finalSkirtPath.strokeWidth = 1; // Thin line
                finalSkirtPath.fillColor = null;
                finalSkirtPath.name = 'skirtPath';
                
                // Add the path to the skirt layer
                skirtLayerItem.addPath(finalSkirtPath, true);
                
                // Trigger 3D rendering of the skirt directly
                // Import and call create3DLayer for layer 0 which will also handle skirt
                import('./threeD-model.js').then(threeDModule => {
                    const firstLayerItem = layers[0];
                    if (firstLayerItem && firstLayerItem.getLayer() && firstLayerItem.getLayer().firstChild) {
                        threeDModule.create3DLayer(
                            firstLayerItem.getLayer().firstChild, 
                            layers, 
                            0, 
                            skirtLayerItem
                        );
                    }
                }).catch(error => {
                    console.warn('Failed to update 3D skirt:', error);
                });
            }
        } catch (error) {
            console.warn('Error creating skirt:', error);
            gridRect.remove();
        }
        
        skirtPath.remove();
    }
}

// Remove the 2D heatmap overlay layer.
function cleanupHeatmapGuide() {
    if (heatmapGuide !== null) {
        heatmapGuide.removeChildren();
        if (heatmapGuide.parent) {
            heatmapGuide.remove();
        }
        heatmapGuide = null;
    }
}

/**
 * Structural-soundness heatmap (2D). Draws a colored stroke ALONG each visible layer's
 * curve — calm/near-invisible where the clay is well supported, ramping through amber to
 * red where it overhangs its support enough to slump or fall (with the elastic upward
 * plume from layers below). Same per-point field as the 3D beads (see heatmap.js), so the
 * two views always agree. Replaces the old purple offset blob.
 *
 * @param {number} selLayerInd - index of the currently selected layer
 */
function drawHeatmap2D(selLayerInd) {
    cleanupHeatmapGuide();
    ensureStackSoundness(layers);

    heatmapGuide = new pathEditorScope.Layer();
    heatmapGuide.name = 'heatmapGuideLayer';

    const maxDistance = CONSTS.FADE_LAYER_COUNT;

    layers.forEach((item, ind) => {
        const paperLayer = item.getLayer();
        if (!paperLayer) return;

        // Printed layers are a settled fact (rendered as disabled grey in 3D) — no risk
        // overlay on them; the field still flows THROUGH them as support for layers above.
        if (item.isPrinted && item.isPrinted()) return;

        // Visibility mirrors redrawLayers' opacity rule; only the selected layer and a
        // capped band of faded layers below it get the stroke (context without clutter/cost).
        const below = selLayerInd - ind;
        let op;
        if (ind === selLayerInd) {
            op = 1;
        } else if (below > 0 && below <= Math.min(maxDistance, HEATMAP_2D_CONTEXT)) {
            op = previousLayerOpacity(below);
        } else {
            return;
        }
        if (op <= 0) return;

        // Authored 2D curves keep their identity color; the 3D heatmap still shows risk.
        if (item.isUserMade()) return;
        const sound = item._soundness;
        if (!sound) return;

        const path = paperLayer.firstChild;
        if (!path || !path.length || path.data.liveStroke) return;

        // The heatmap replaces the base stroke instead of painting another translucent
        // stroke on it: 50% must remain 50%, rather than compositing into 75%.
        path.opacity = 0;
        const isSel = ind === selLayerInd;
        const samples = isSel ? 140 : 44;
        const pts = item.pointsAlongPath(samples);
        if (!pts || pts.length < 2) return;

        const baseW = path.strokeWidth || curveStrokeWidth();
        const w = baseW;

        const group = new pathEditorScope.Group();
        const last = pts.length - 1;
        for (let i = 0; i < last; i++) {
            const seg = new pathEditorScope.Path([pts[i], pts[i + 1]]);
            seg.strokeColor = heatmapStrokeColor(soundnessAt(sound, i / last));
            seg.strokeWidth = w;
            seg.strokeCap = 'round';
            group.addChild(seg);
        }
        // Close the loop back to the start (paths are closed contours).
        const closing = new pathEditorScope.Path([pts[last], pts[0]]);
        closing.strokeColor = heatmapStrokeColor(soundnessAt(sound, 1));
        closing.strokeWidth = w;
        closing.strokeCap = 'round';
        group.addChild(closing);

        group.data.selectedCurve = isSel;
        group.opacity = op;
        heatmapGuide.addChild(group);
    });

    heatmapGuide.bringToFront();
    if (activeCurveReference) {
        activeCurveReference.bringToFront();
        const selectedOverlay = heatmapGuide.children.find(child => child.data.selectedCurve);
        if (selectedOverlay) activeCurveReference.addChild(selectedOverlay);
        else layers[selLayerInd].getLayer()?.bringToFront();
    }
    // Keep the seam handle and travel direction above the diagnostic overlay.
    const indicatorsLayer = pathEditorScope.project.layers.find(layer => layer.name === 'indicatorsLayer');
    if (indicatorsLayer) indicatorsLayer.bringToFront();

    // Return to the main layer for other operations
    if (pathEditorScope.project.layers[0]) {
        pathEditorScope.project.layers[0].activate();
    }
}

/**
 * Geometric bounds-based guide system that treats layers as filled shapes.
 * Creates bounds by expanding/contracting from the actual geometric area of the shape.
 * 1. Outer bound (white/gray) - shows the expanded boundary around the shape
 * 2. Inner bound (red/dashed) - shows the contracted area to prevent intersections
 * 
 * @param {number} selLayerIndex - Index of the currently selected layer
 */
function drawBoundsGuide(selLayerIndex) {
    // Clean up previous bounds guide completely
    cleanupBoundsGuide();

    // Create fresh bounds guide layer
    boundsGuide = new pathEditorScope.Layer();
    boundsGuide.name = 'boundsGuideLayer';
    boundsGuide.opacity = 0.5;

    const { closest, reference } = findClosestUserMadeLayer(selLayerIndex);
    if (closest < 0) {
        console.log("returning early, ", closest, reference);
        return;
    }

    boundsGuide.activate();
    const dist = _dist(selLayerIndex, closest);
    
    // Calculate offset distance based on layer distance, growth factor, and MIN_OVERLAP
    // Convert MIN_OVERLAP from mm to pixels using SCALE_FACTOR
    const minOverlapPixels = CONSTS.MIN_OVERLAP * CONSTS.SCALE_FACTOR;
    const baseOffset = 5 + (dist * CONSTS.BOUNDS_GUIDE_GROW_FACTOR);
    const offsetDistance = Math.max(baseOffset, minOverlapPixels);

    // Get the reference shape to create geometric bounds from
    let referenceShape;
    if (reference === -1) {
        // Use the closest layer's shape directly
        const closestLayerItem = layers[closest];
        const closestLayer = closestLayerItem.getLayer();
        if (closestLayer && closestLayer.firstChild) {
            referenceShape = closestLayer.firstChild.clone();
        }
    } else {
        // Create interpolated shape between closest and reference layers
        const t = (selLayerIndex - closest) / (reference - closest);
        const closestPoints = layers[closest].pointsAlongPath(100);
        const referencePoints = layers[reference].pointsAlongPath(100);
        const interpolatedPoints = interpolatePoints(closestPoints, referencePoints, t, false);
        
        // Create a shape from interpolated points
        referenceShape = new pathEditorScope.Path();
        interpolatedPoints.forEach((point, index) => {
            if (index === 0) {
                referenceShape.moveTo(point);
            } else {
                referenceShape.lineTo(point);
            }
        });
        referenceShape.closed = true;
        referenceShape.smooth({ type: 'catmull-rom', factor: CONSTS.SMOOTHING_FACTOR });
    }

    if (!referenceShape) {
        return;
    }

    // Create outer bound guide by expanding the geometric bounds of the shape
    const outerBounds = createGeometricBounds(referenceShape, offsetDistance, true);
    if (outerBounds) {
        // Clip to grid boundaries
        const gridBounds = new pathEditorScope.Rectangle(
            window.gridStartX,
            window.gridStartY,
            window.gridSize,
            window.gridSize
        );
        const gridRect = new pathEditorScope.Path.Rectangle(gridBounds);
        
        try {
            const clippedBounds = outerBounds.intersect(gridRect);
            gridRect.remove();
            
            if (clippedBounds) {
                clippedBounds.fillColor = new pathEditorScope.Color(0.6, 0.4, 0.8, 0.3); // Semi-transparent purple
                clippedBounds.strokeColor = new pathEditorScope.Color(0.5, 0.2, 0.7, 0.8); // Purple stroke
                clippedBounds.strokeWidth = 1;
                boundsGuide.addChild(clippedBounds);
                
                // Create 3D representation of bounds
                createBounds3D(clippedBounds, selLayerIndex);
            }
        } catch (error) {
            console.warn('Error clipping bounds to grid:', error);
            // Fallback to unclipped bounds
            outerBounds.fillColor = new pathEditorScope.Color(0.6, 0.4, 0.8, 0.3);
            outerBounds.strokeColor = new pathEditorScope.Color(0.5, 0.2, 0.7, 0.8);
            outerBounds.strokeWidth = 1;
            boundsGuide.addChild(outerBounds);
            gridRect.remove();
        }
        
        outerBounds.remove();
    }

    // No inner bound needed
    innerBoundPath = null;

    // Clean up the reference shape
    if (referenceShape) {
        referenceShape.remove();
    }

    boundsGuide.bringToFront();

    // Return to the main layer for other operations
    if (pathEditorScope.project.layers[0]) {
        pathEditorScope.project.layers[0].activate();
    }
}

/**
 * Creates a skirt curve for the first layer only - an outer offset curve that mimics 
 * 3D slicer skirt functionality for proper paste extrusion before printing the actual object.
 * This creates the skirt as a visible layer that shows up in both 2D and 3D views.
 * 
 * @param {number} selLayerIndex - Should be 0 for first layer
 */

// /**
//  * Clips a path to the grid boundaries to ensure it doesn't extend beyond the printable area.
//  * 
//  * @param {Path} path - The path to clip
//  * @returns {Path|null} The clipped path, or null if no valid intersection
//  */
// function clipPathToGrid(path) {
//     if (!path || !path.segments || path.segments.length === 0) {
//         return null;
//     }

//     // Create a rectangle representing the grid boundaries
//     const gridBounds = new pathEditorScope.Rectangle(
//         window.gridStartX,
//         window.gridStartY,
//         window.gridSize,
//         window.gridSize
//     );
//     const gridRect = new pathEditorScope.Path.Rectangle(gridBounds);
    
//     try {
//         // Use Paper.js intersection to clip the path to the grid
//         const clippedPath = path.intersect(gridRect);
        
//         // Clean up the grid rectangle
//         gridRect.remove();
        
//         if (clippedPath && clippedPath.segments && clippedPath.segments.length > 0) {
//             // Apply the same smoothing as other paths
//             clippedPath.smooth({ type: 'catmull-rom', factor: CONSTS.SMOOTHING_FACTOR });
//             return clippedPath;
//         }
        
//         // If intersection failed, try manual clipping
//         return clipPathManually(path, gridBounds);
        
//     } catch (error) {
//         console.warn('Error clipping path to grid:', error);
//         gridRect.remove();
//         return clipPathManually(path, gridBounds);
//     }
// }

// /**
//  * Manual path clipping when Paper.js intersection fails
//  */
// function clipPathManually(path, gridBounds) {
//     const clippedPath = new pathEditorScope.Path();
//     let hasValidPoints = false;
    
//     // Go through each segment and only include points within the grid
//     for (let i = 0; i < path.segments.length; i++) {
//         const point = path.segments[i].point;
        
//         // Check if point is within grid bounds
//         if (point.x >= gridBounds.left && 
//             point.x <= gridBounds.right && 
//             point.y >= gridBounds.top && 
//             point.y <= gridBounds.bottom) {
            
//             if (!hasValidPoints) {
//                 clippedPath.moveTo(point);
//                 hasValidPoints = true;
//             } else {
//                 clippedPath.lineTo(point);
//             }
//         }
//     }
    
//     if (hasValidPoints) {
//         clippedPath.closePath();
//         clippedPath.smooth({ type: 'catmull-rom', factor: CONSTS.SMOOTHING_FACTOR });
//         return clippedPath;
//     }
    
//     // No valid points found
//     clippedPath.remove();
//     return null;
// }



/**
 * Creates geometric bounds by treating the shape as a filled area and expanding/contracting
 * from the outer/inner boundaries of that area.
 * 
 * @param {Path} shape - The original shape to create bounds from
 * @param {number} distance - Distance to expand (positive) or contract (negative)
 * @param {boolean} isOuter - true for outer bounds (expand), false for inner bounds (contract)
 * @returns {Path} The geometric bounds path
 */
function createGeometricBounds(shape, distance, isOuter) {
    if (!shape || !shape.segments || shape.segments.length < 3) {
        return null;
    }

    try {
        // Step 1: Create the outer silhouette/contour of the shape
        const outerContour = getSilhouetteFromPath(shape);
        if (!outerContour || !outerContour.segments || outerContour.segments.length < 3) {
            // D4: was a silent no-field; log so a degenerate interpolated shape is diagnosable.
            console.debug('[possibility-field] silhouette degenerate/empty — no field drawn');
            return null;
        }
        
        // Step 2: Offset from that outer contour.
        // offsetFromContour convention: positive = GROW outward, negative = shrink inward
        // (winding is normalised inside, so the sign is now reliable). Outer field = grow.
        const offsetDistance = isOuter ? distance : -distance;
        const result = offsetFromContour(outerContour, offsetDistance);
        
        if (result) {
            result.smooth({ type: 'catmull-rom', factor: CONSTS.SMOOTHING_FACTOR });
        }
        
        return result;
    } catch (error) {
        console.warn('Error creating geometric bounds:', error);
        return null;
    }
}

// /**
//  * Creates the outer silhouette/contour of a shape, treating it as a filled 2D area.
//  * This extracts only the outer boundary, ignoring internal path structure.
//  * 
//  * @param {paper.Path} shape - The shape to get the outer contour of
//  * @returns {paper.Path|null} The outer contour path
//  */
// function createOuterSilhouette(shape) {
//     if (!shape || !shape.segments) {
//         return null;
//     }

//     try {
//         // For Paper.js paths, we need to ensure we get the actual outer boundary
//         // The key insight is that user-drawn paths are already the outer contour
//         const contour = shape.clone();
        
//         // Ensure the path is closed for proper boundary calculation
//         if (!contour.closed) {
//             contour.closed = true;
//         }
        
//         // Ensure counter-clockwise winding for outer contour
//         if (contour.clockwise) {
//             contour.reverse();
//         }
        
//         // For complex shapes with multiple segments, we might need to sample
//         // and recreate the boundary to get a clean outer silhouette
//         if (contour.segments.length > 20) {
//             // Sample points evenly along the path
//             const points = [];
//             const numSamples = Math.min(50, contour.segments.length);
            
//             for (let i = 0; i < numSamples; i++) {
//                 const t = i / numSamples;
//                 const point = contour.getPointAt(contour.length * t);
//                 if (point) {
//                     points.push(point);
//                 }
//             }
            
//             // Create a new path from the sampled points
//             const simplifiedContour = new pathEditorScope.Path();
//             points.forEach(point => simplifiedContour.add(point));
//             simplifiedContour.closed = true;
//             simplifiedContour.smooth({ type: 'catmull-rom', factor: CONSTS.SMOOTHING_FACTOR });
            
//             contour.remove();
//             return simplifiedContour;
//         }
        
//         return contour;
        
//     } catch (error) {
//         console.warn('Error creating outer silhouette:', error);
//         return shape.clone();
//     }
// }

/**
 * Offsets a contour path by a given distance.
 * 
 * @param {paper.Path} contour - The contour to offset
 * @param {number} distance - Distance to offset (positive = outward, negative = inward)
 * @returns {paper.Path|null} The offset contour
 */
function offsetFromContour(contour, distance) {
    if (!contour || !contour.segments || contour.segments.length < 3) {
        return null;
    }

    const ClipperLib = window.ClipperLib;
    // Paper.js has NO Path.offset() in this build, so the old `contour.offset()` threw
    // every time and fell back to a broken per-vertex normal push (spiky/self-intersecting).
    // Use ClipperLib.ClipperOffset (already loaded, industrial-grade, self-intersection-safe).
    if (!ClipperLib || !ClipperLib.ClipperOffset) {
        return manualOffsetContour(contour, distance); // guarded last resort only
    }

    try {
        const scale = 10000; // integer space (matches getSilhouetteFromPath)
        const numSamples = Math.max(64, contour.segments.length * 2);
        let poly = [];
        for (let i = 0; i < numSamples; i++) {
            const pt = contour.getPointAt(contour.length * (i / numSamples));
            if (pt) poly.push({ X: Math.round(pt.x * scale), Y: Math.round(pt.y * scale) });
        }
        if (poly.length < 3) return null;

        // D1 fix: normalise winding so the offset SIGN is DETERMINISTIC. getSilhouetteFromPath
        // can return either orientation, and ClipperOffset grows a positively-oriented subject
        // with a positive delta but SHRINKS a negatively-oriented one — that ambiguity is why
        // the purple field shrank/vanished. Force positive orientation (Area >= 0) first.
        if (!ClipperLib.Clipper.Orientation(poly)) poly.reverse();
        const inputArea = Math.abs(ClipperLib.Clipper.Area(poly));

        // Run one offset pass and return the largest result polygon (the outer envelope).
        const runOffset = (delta) => {
            const co = new ClipperLib.ClipperOffset(2, 0.25 * scale); // miterLimit, arcTolerance
            co.AddPath(poly, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
            const solution = new ClipperLib.Paths();
            co.Execute(solution, delta); // integer space; sign sets grow/shrink
            if (!solution || solution.length === 0) return null;
            let largest = solution[0], largestArea = 0;
            for (const p of solution) {
                const a = Math.abs(ClipperLib.Clipper.Area(p));
                if (a > largestArea) { largestArea = a; largest = p; }
            }
            return (largest && largest.length >= 3) ? { poly: largest, area: largestArea } : null;
        };

        // Convention: distance > 0 => grow outward, distance < 0 => shrink inward.
        let res = runOffset(distance * scale);
        // Safety net: if a grow request didn't actually enlarge (or a shrink didn't shrink),
        // this build's winding convention was inverted for our subject — retry opposite sign.
        const wantGrow = distance > 0;
        if (res && ((wantGrow && res.area <= inputArea) || (!wantGrow && res.area >= inputArea))) {
            const retry = runOffset(-distance * scale);
            if (retry) res = retry;
        }
        if (!res) return null;

        const offsetPath = new pathEditorScope.Path();
        res.poly.forEach(pt => offsetPath.add(new pathEditorScope.Point(pt.X / scale, pt.Y / scale)));
        offsetPath.closed = true;
        return offsetPath;
    } catch (error) {
        console.warn('Error offsetting contour (Clipper):', error);
        return null; // do NOT fall back to the broken manual offset
    }
}

/**
 * Manual contour offset implementation using normal vectors.
 */
function manualOffsetContour(contour, distance) {
    const offsetPoints = [];
    const segments = contour.segments;
    
    for (let i = 0; i < segments.length; i++) {
        const currentPoint = segments[i].point;
        const prevPoint = segments[(i - 1 + segments.length) % segments.length].point;
        const nextPoint = segments[(i + 1) % segments.length].point;
        
        // Calculate outward normal
        const normal = calculateOutwardNormal(prevPoint, currentPoint, nextPoint, null);
        
        // Offset point by distance along normal
        const offsetPoint = currentPoint.add(normal.multiply(distance));
        offsetPoints.push(offsetPoint);
    }
    
    // Create new path from offset points
    const offsetPath = new pathEditorScope.Path();
    offsetPoints.forEach(point => offsetPath.add(point));
    offsetPath.closed = true;
    
    return offsetPath;
}

// /**
//  * Calculates the centroid (center of mass) of a closed shape
//  */
// function calculateShapeCentroid(shape) {
//     const segments = shape.segments;
//     let area = 0;
//     let centroidX = 0;
//     let centroidY = 0;
    
//     // Use the shoelace formula to calculate area and centroid
//     for (let i = 0; i < segments.length; i++) {
//         const current = segments[i].point;
//         const next = segments[(i + 1) % segments.length].point;
        
//         const crossProduct = current.x * next.y - next.x * current.y;
//         area += crossProduct;
//         centroidX += (current.x + next.x) * crossProduct;
//         centroidY += (current.y + next.y) * crossProduct;
//     }
    
//     area *= 0.5;
    
//     // Handle edge case where area is very small or zero
//     if (Math.abs(area) < 0.001) {
//         // Fallback to simple average of points
//         let sumX = 0, sumY = 0;
//         for (let segment of segments) {
//             sumX += segment.point.x;
//             sumY += segment.point.y;
//         }
//         return new pathEditorScope.Point(sumX / segments.length, sumY / segments.length);
//     }
    
//     centroidX /= (6 * area);
//     centroidY /= (6 * area);
    
//     return new pathEditorScope.Point(centroidX, centroidY);
// }

/**
 * Calculates the outward normal vector from the geometric area at a given boundary point
 */
function calculateOutwardNormal(prevPoint, currentPoint, nextPoint, centroid) {
    // Calculate edge vectors
    const edge1 = currentPoint.subtract(prevPoint);
    const edge2 = nextPoint.subtract(currentPoint);
    
    // Normalize edge vectors, handle zero-length edges
    const edge1Norm = edge1.length > 0.001 ? edge1.normalize() : new pathEditorScope.Point(1, 0);
    const edge2Norm = edge2.length > 0.001 ? edge2.normalize() : new pathEditorScope.Point(1, 0);
    
    // Calculate average edge direction
    let avgDirection = edge1Norm.add(edge2Norm);
    
    // Handle case where edges are opposite (avgDirection becomes zero)
    if (avgDirection.length < 0.001) {
        // Use perpendicular to edge1
        avgDirection = new pathEditorScope.Point(-edge1Norm.y, edge1Norm.x);
    } else {
        avgDirection = avgDirection.normalize();
    }
    
    // Calculate perpendicular vector (potential normal)
    const perpendicular = new pathEditorScope.Point(-avgDirection.y, avgDirection.x);
    
    // Determine which direction is outward by checking against centroid
    if (!centroid) {
        // If no centroid provided, just return the perpendicular (assume outward)
        return perpendicular;
    }
    
    const toCenter = centroid.subtract(currentPoint);
    const dotProduct = perpendicular.dot(toCenter);
    
    // If dot product is positive, perpendicular points toward center (inward)
    // If negative, it points away from center (outward)
    return dotProduct > 0 ? perpendicular.multiply(-1) : perpendicular;
}

const _dist = (a, b) => Math.abs(a - b);

function findClosestUserMadeLayer(selLayer) {
    const upperBound = layers.length - 1;
    let upper = -1, lower = -1;
    let i;
    for (i = selLayer + 1; i <= upperBound; i++) {
        if (layers[i].isUserMade()) {
            upper = i;
            break;
        }
    }

    for (i = selLayer - 1; i >= 0; i--) {
        if (layers[i].isUserMade()) {
            lower = i;
            break;
        }
    }

    let [closest, reference] = _dist(upper, selLayer) < _dist(lower, selLayer) ? [upper, lower] : [lower, upper];
    if (closest < 0) {
        [closest, reference] = [reference, closest];
    }

    const res = { closest, reference };
    return res;
}


// Global variable to store all starting point indicators
let startingPointIndicators = [];

function drawStartingPointIndicators(currentLayerIndex) {
    // Remove all existing indicators
    startingPointIndicators.forEach(indicator => {
        if (indicator) indicator.remove();
    });
    startingPointIndicators = [];

    // Only show indicator for the currently selected layer (like anchor points)
    const currentLayerItem = layers[currentLayerIndex];
    if (!currentLayerItem || !currentLayerItem.user_made || !currentLayerItem.getLayer()) {
        return; // No indicator if layer is not user-made or doesn't exist
    }

    const layer = currentLayerItem.getLayer();
    if (!layer.children || layer.children.length === 0) {
        return; // No indicator if layer has no paths
    }

    const path = layer.children[0];
    if (!path || !path.segments || path.segments.length === 0) {
        return; // No indicator if path has no segments
    }

    // Create or get the indicators layer (always on top)
    let indicatorsLayer = pathEditorScope.project.layers.find(layer => layer.name === 'indicatorsLayer');
    if (!indicatorsLayer) {
        indicatorsLayer = new pathEditorScope.Layer({ name: 'indicatorsLayer' });
    }
    indicatorsLayer.activate();
    indicatorsLayer.bringToFront(); // Ensure indicators layer is always on top

    // Create indicator only for the current selected layer
    const indicator = createInteractiveStartingPointIndicator(path, currentLayerIndex, currentLayerItem);
    if (indicator) {
        startingPointIndicators.push(indicator);
        indicatorsLayer.addChild(indicator);
    }

    // Switch back to the main layer for other operations
    pathEditorScope.project.layers[0].activate();
}

function createInteractiveStartingPointIndicator(path, layerIndex, layerItem) {
    const segments = path.segments;
    if (segments.length < 2) return null;

    const group = new pathEditorScope.Group();
    group.name = `startingPointIndicator_${layerIndex}`;

    // Get starting point and direction
    const startPoint = segments[0].point;


    let circle;
    if (currentControlMode === 'move' || currentControlMode === 'rotate') {
        circle = createTransformHandle(startPoint, currentControlMode);
    } else {
        // Solid contrast badge with a pale rim and an invisible 44px touch target.
        const unit = 1 / pathEditorScope.view.zoom;
        circle = new pathEditorScope.Group();
        const hit = new pathEditorScope.Path.Circle(startPoint, 22 * unit);
        hit.fillColor = new pathEditorScope.Color(0, 0, 0, 0.001);
        const ring = new pathEditorScope.Path.Circle(startPoint, 11 * unit);
        ring.fillColor = CONSTS.INDICATOR_STROKE;
        ring.strokeColor = '#263238';
        ring.strokeWidth = 3 * unit;
        const center = new pathEditorScope.Path.Circle(startPoint, 3.5 * unit);
        center.fillColor = '#263238';
        circle.addChildren([hit, ring, center]);
    }
    circle.name = 'draggableStartPoint';

    // Direction chevrons keep the print travel direction legible, but
    // dimmed while the user is manipulating the point in move/rotate mode.
    const arrowGroup = createDirectionChevrons(path, 0);
    if (currentControlMode === 'move' || currentControlMode === 'rotate') {
        arrowGroup.opacity = 0.45;
    }

    // Add components to group
    group.addChild(circle);
    if (circle.rotateIcon) {
        group.addChild(circle.rotateIcon);
    }
    if (arrowGroup) {
        group.addChild(arrowGroup);
    }

    // Ensure maximum visibility by bringing to front and setting higher z-index
    group.bringToFront();
    circle.bringToFront();
    if (circle.rotateIcon) {
        circle.rotateIcon.bringToFront();
    }
    if (arrowGroup) {
        arrowGroup.bringToFront();
    }

    // Store references for interaction
    group._path = path;
    group._layerItem = layerItem;
    group._layerIndex = layerIndex;
    group._circle = circle;
    group._arrowGroup = arrowGroup;

    // Add interaction handlers
    addStartPointInteraction(group);

    return group;
}

// Sample the actual contour so direction markers also follow tight bends.
function createDirectionChevrons(path, startOffset) {
    const group = new pathEditorScope.Group();
    group.name = 'directionChevrons';
    const unit = 1 / pathEditorScope.view.zoom;
    if (!path.length) return group;
    for (const distance of [24, 36]) {
        const ahead = distance * unit;
        // Short contours should not wrap around and pile markers onto the seam.
        if (ahead >= path.length * 0.7) continue;
        const offset = path.closed
            ? (startOffset + ahead) % path.length
            : startOffset + ahead;
        if (offset >= path.length) continue;
        const point = path.getPointAt(offset);
        const tangent = path.getTangentAt(offset);
        if (!point || !tangent || !tangent.length) continue;
        const forward = tangent.normalize();
        const back = point.subtract(forward.multiply(4 * unit));
        const side = forward.rotate(90).multiply(4 * unit);
        const chevron = new pathEditorScope.Path([
            back.add(side), point.add(forward.multiply(2 * unit)), back.subtract(side)
        ]);
        chevron.strokeCap = 'round';
        chevron.strokeJoin = 'round';
        chevron.strokeColor = CONSTS.INDICATOR_STROKE;
        chevron.strokeWidth = 5 * unit;
        const ink = chevron.clone();
        ink.strokeColor = CONSTS.INDICATOR_FILL_DARK;
        ink.strokeWidth = 2 * unit;
        group.addChildren([chevron, ink]);
    }
    return group;
}

function addStartPointInteraction(indicatorGroup) {
    const circle = indicatorGroup._circle;
    const path = indicatorGroup._path;
    const layerItem = indicatorGroup._layerItem;

    let isDragging = false;
    let hasBeenDragged = false;
    let ghostPath = null;
    let dragStartPoint = null;
    let originalPathPoints = null;

    // Per-mode cursor affordance on the start indicator (it IS the print start point).
    const canvasEl = pathEditorScope.view && pathEditorScope.view.element;
    circle.onMouseEnter = function() {
        if (!canvasEl) return;
        canvasEl.style.cursor = currentControlMode === 'rotate' ? 'alias' : 'grab';
    };
    circle.onMouseLeave = function() {
        if (canvasEl && !isDragging) canvasEl.style.cursor = '';
    };

    circle.onMouseDown = function(event) {
        if (canvasEl) canvasEl.style.cursor = currentControlMode === 'rotate' ? 'alias' : 'grabbing';
        isDragging = true;
        hasBeenDragged = false;
        
        if (currentControlMode === 'move') {
            // In move mode: set up ghost path functionality
            dragStartPoint = event.point.clone();
            
            // Store original path points
            if (path && path.segments) {
                originalPathPoints = path.segments.map(segment => ({
                    point: segment.point.clone(),
                    handleIn: segment.handleIn.clone(),
                    handleOut: segment.handleOut.clone()
                }));
            }
            
            // Create ghost path for visual feedback
            ghostPath = path.clone();
            ghostPath.opacity = 0.4;
            ghostPath.strokeColor = '#00000078';
            ghostPath.fillColor = null;
            ghostPath.shadowBlur = 0;
            ghostPath.shadowOffset = new pathEditorScope.Point(0, 0);
            
            // Add ghost path to the same layer
            path.layer.addChild(ghostPath);
            ghostPath.bringToFront();
            
            // In move mode, keep the start indicator visible but hide others
            // Don't hide start indicators in move mode - user needs to see what they're dragging
            
            // Remove all control points during move operation
            removeAllControlPoints(layerItem);
        } else if (currentControlMode === 'rotate') {
            // In rotate mode: set up rotation functionality
            dragStartPoint = event.point.clone();
            
            // Use the existing rotation logic from addDirectPathRotateInteraction
            // Get path bounds for rotation center
            const bounds = path.bounds;
            const rotationCenter = bounds.center;
            this._rotationCenter = rotationCenter;
            this._startAngle = Math.atan2(dragStartPoint.y - rotationCenter.y, dragStartPoint.x - rotationCenter.x);
            
            // Store original path points
            if (path && path.segments) {
                originalPathPoints = path.segments.map(segment => ({
                    point: segment.point.clone(),
                    handleIn: segment.handleIn.clone(),
                    handleOut: segment.handleOut.clone()
                }));
            }
            
            // Create rotation indicators like in the original implementation
            const indicatorsLayer = pathEditorScope.project.layers.find(layer => layer.name === 'indicatorsLayer') ||
                                  new pathEditorScope.Layer({ name: 'indicatorsLayer' });
            indicatorsLayer.activate();
            indicatorsLayer.bringToFront();
            
            const lineLength = 40;
            const arcRadius = 30;
            
            // Create indicator group
            this._indicatorGroup = new pathEditorScope.Group();
            
            // Static line from center to start drag point
            const direction = dragStartPoint.subtract(rotationCenter).normalize();
            const staticLineEnd = rotationCenter.add(direction.multiply(lineLength));
            this._staticIndicatorLine = new pathEditorScope.Path.Line(rotationCenter, staticLineEnd);
            this._staticIndicatorLine.strokeColor = '#9d8779';
            this._staticIndicatorLine.strokeWidth = 2;
            
            // Moving line (starts same as static line)
            this._movingIndicatorLine = new pathEditorScope.Path.Line(rotationCenter, staticLineEnd);
            this._movingIndicatorLine.strokeColor = CONSTS.INDICATOR_FILL_DARK;
            this._movingIndicatorLine.strokeWidth = 2;
            
            // Rotation arc
            this._rotationArc = new pathEditorScope.Path();
            this._rotationArc.strokeColor = CONSTS.INDICATOR_FILL_DARK;
            this._rotationArc.strokeWidth = 2;
            this._rotationArc.fillColor = null;
            
            // Degree text
            this._degreeText = new pathEditorScope.PointText(staticLineEnd.add(new pathEditorScope.Point(15, 0)));
            this._degreeText.content = '0°';
            this._degreeText.style = {
                fontSize: 14,
                fillColor: CONSTS.INDICATOR_FILL_DARK,
                justification: 'center'
            };
            
            // Add to indicator group
            this._indicatorGroup.addChild(this._staticIndicatorLine);
            this._indicatorGroup.addChild(this._movingIndicatorLine);
            this._indicatorGroup.addChild(this._rotationArc);
            this._indicatorGroup.addChild(this._degreeText);
            
            indicatorsLayer.addChild(this._indicatorGroup);
            
            // Switch back to main layer
            pathEditorScope.project.layers[0].activate();
            
            // Remove all control points during rotate operation
            removeAllControlPoints(layerItem);
        }
        
        event.stopPropagation();
    };

    circle.onMouseDrag = function(event) {
        if (!isDragging) return;
        hasBeenDragged = true;

        if (currentControlMode === 'move') {
            // In move mode: update ghost path with bounds checking
            if (!originalPathPoints || !ghostPath) return;
            
            const currentPoint = event.point;
            const delta = currentPoint.subtract(dragStartPoint);
            
            // Update ghost path position
            ghostPath.removeSegments();
            originalPathPoints.forEach((segData) => {
                const newPoint = segData.point.add(delta);
                ghostPath.add(new pathEditorScope.Segment(
                    newPoint,
                    segData.handleIn.clone(),
                    segData.handleOut.clone()
                ));
            });
            
            // Move the indicator to follow the cursor
            this.position = currentPoint;
            
            // Check if ghost path is within grid bounds
            const isWithinBounds = isPathWithinGrid(ghostPath);
            
            // Update ghost path appearance based on validity
            if (isWithinBounds) {
                ghostPath.strokeColor = '#00000078'; // Dark for valid position
                ghostPath.opacity = 0.6;
            } else {
                ghostPath.strokeColor = '#F44336'; // Red for invalid position
                ghostPath.opacity = 0.4;
            }
        } else if (currentControlMode === 'rotate') {
            // In rotate mode: apply rotation transformation
            if (!originalPathPoints || !this._rotationCenter) return;
            
            const currentPoint = event.point;
            const currentAngle = Math.atan2(currentPoint.y - this._rotationCenter.y, currentPoint.x - this._rotationCenter.x);
            const rotation = currentAngle - this._startAngle;
            
            // Move the indicator to follow the cursor
            this.position = currentPoint;
            
            // Move rotation icon with indicator
            if (this.rotateIcon) {
                this.rotateIcon.position = currentPoint;
            }
            
            // Update rotation indicators
            if (this._indicatorGroup && this._staticIndicatorLine && this._movingIndicatorLine && this._rotationArc && this._degreeText) {
                const lineLength = 40;
                const arcRadius = 30;
                
                // Update moving line
                const currentDirection = dragStartPoint.subtract(this._rotationCenter).normalize();
                const rotatedDirection = new pathEditorScope.Point(
                    currentDirection.x * Math.cos(rotation) - currentDirection.y * Math.sin(rotation),
                    currentDirection.x * Math.sin(rotation) + currentDirection.y * Math.cos(rotation)
                );
                const movingLineEnd = this._rotationCenter.add(rotatedDirection.multiply(lineLength));
                
                this._movingIndicatorLine.removeSegments();
                this._movingIndicatorLine.add(this._rotationCenter);
                this._movingIndicatorLine.add(movingLineEnd);
                
                // Update degree text position and content
                const degrees = Math.round(rotation * (180 / Math.PI));
                this._degreeText.content = `${degrees}°`;
                const textOffset = rotatedDirection.multiply(15);
                this._degreeText.position = movingLineEnd.add(textOffset);
                
                // Update rotation arc
                this._rotationArc.removeSegments();
                
                if (Math.abs(rotation) > 0.1) {
                    const startAngleForArc = Math.atan2(currentDirection.y, currentDirection.x);
                    const endAngleForArc = startAngleForArc + rotation;
                    
                    const numSegments = Math.max(8, Math.floor(Math.abs(rotation) * 20));
                    for (let i = 0; i <= numSegments; i++) {
                        const angle = startAngleForArc + (rotation * i / numSegments);
                        const x = this._rotationCenter.x + Math.cos(angle) * arcRadius;
                        const y = this._rotationCenter.y + Math.sin(angle) * arcRadius;
                        this._rotationArc.add(new pathEditorScope.Point(x, y));
                    }
                }
            }
            
            // Apply rotation to the path
            path.removeSegments();
            originalPathPoints.forEach((segData) => {
                // Rotate point around center
                const relativePoint = segData.point.subtract(this._rotationCenter);
                const rotatedPoint = new pathEditorScope.Point(
                    relativePoint.x * Math.cos(rotation) - relativePoint.y * Math.sin(rotation),
                    relativePoint.x * Math.sin(rotation) + relativePoint.y * Math.cos(rotation)
                );
                const finalPoint = rotatedPoint.add(this._rotationCenter);
                
                // Rotate handles as well
                const rotatedHandleIn = new pathEditorScope.Point(
                    segData.handleIn.x * Math.cos(rotation) - segData.handleIn.y * Math.sin(rotation),
                    segData.handleIn.x * Math.sin(rotation) + segData.handleIn.y * Math.cos(rotation)
                );
                const rotatedHandleOut = new pathEditorScope.Point(
                    segData.handleOut.x * Math.cos(rotation) - segData.handleOut.y * Math.sin(rotation),
                    segData.handleOut.x * Math.sin(rotation) + segData.handleOut.y * Math.cos(rotation)
                );
                
                path.add(new pathEditorScope.Segment(finalPoint, rotatedHandleIn, rotatedHandleOut));
            });
        } else {
            // Normal mode: reorder start point along the path
            // Find closest point on the curve
            const closestPoint = path.getNearestPoint(event.point);
            const offset = path.getOffsetOf(closestPoint);

            // Move the circle/move arrow to the closest point on curve
            this.position = closestPoint;

            // Update arrow position and direction (only if arrow exists)
            updateArrowForNewStartPoint(indicatorGroup, closestPoint, offset);
        }

        event.stopPropagation();
    };

    circle.onMouseUp = function(event) {
        if (canvasEl) canvasEl.style.cursor = '';
        if (isDragging) {
            if (currentControlMode === 'move') {
                // In move mode: finalize the path move with validation
                cleanupBoundsGuide();
                
                if (hasBeenDragged && ghostPath) {
                    // Check if final position is valid
                    const isValidPosition = isPathWithinGrid(ghostPath);
                    
                    if (isValidPosition) {
                        // Apply the transformation to the original path
                        const currentPoint = event.point;
                        const delta = currentPoint.subtract(dragStartPoint);
                        
                        // Update the original path
                        path.removeSegments();
                        originalPathPoints.forEach((segData) => {
                            const newPoint = segData.point.add(delta);
                            path.add(new pathEditorScope.Segment(
                                newPoint,
                                segData.handleIn.clone(),
                                segData.handleOut.clone()
                            ));
                        });
                        
                        // Mark layer as modified
                        layerItem.modified = true;
                        
                        // Dispatch layer modified event
                        const layerIndex = layers.indexOf(layerItem);
                        document.dispatchEvent(new CustomEvent('layerModified', {
                            detail: {
                                layerItem: layerItem,
                                layerIndex: layerIndex,
                                currentLayer: path,
                                isReset: false
                            }
                        }));
                        
                        // Regenerate skirt if this is the first layer
                        if (layerIndex === 0) {
                            createFirstLayerSkirt();
                        }
                    } else {
                        // Invalid position: snap indicator back to original position
                        this.position = dragStartPoint;
                        
                        // Restore the original path (no changes applied)
                        path.removeSegments();
                        originalPathPoints.forEach((segData) => {
                            path.add(new pathEditorScope.Segment(
                                segData.point.clone(),
                                segData.handleIn.clone(),
                                segData.handleOut.clone()
                            ));
                        });
                    }
                }
                
                // Clean up ghost path
                if (ghostPath) {
                    ghostPath.remove();
                    ghostPath = null;
                }
                
                // Restore control points (indicators stayed visible during move)
                if (currentControlMode !== null) {
                    drawAnchorPoints(layerItem);
                }
                
                // Reset variables
                originalPathPoints = null;
                dragStartPoint = null;
            } else if (currentControlMode === 'rotate') {
                // In rotate mode: finalize the rotation
                // Clean up rotation indicators
                if (this._indicatorGroup) {
                    this._indicatorGroup.remove();
                    this._indicatorGroup = null;
                    this._staticIndicatorLine = null;
                    this._movingIndicatorLine = null;
                    this._rotationArc = null;
                    this._degreeText = null;
                }
                
                if (hasBeenDragged) {
                    // Finalize the transformation by recreating the layer
                    const currentPath = path;
                    if (currentPath && currentPath.segments) {
                        // Extract the final path points
                        const pathPoints = currentPath.segments.map(segment => segment.point.clone());

                        // Clear the layer and recreate path with proper styling
                        layerItem.clear();
                        layerItem.setUserMade(false);

                        const newPath = createUserMadePath();
                        pathPoints.forEach(point => newPath.add(point));
                        newPath.closed = true;
                        newPath.smooth({ type: 'catmull-rom', factor: CONSTS.SMOOTHING_FACTOR });

                        layerItem.addPath(newPath, true);

                        // Mark layer as modified
                        layerItem.modified = true;
                        
                        // Dispatch layer modified event
                        const layerIndex = layers.indexOf(layerItem);
                        document.dispatchEvent(new CustomEvent('layerModified', {
                            detail: {
                                layerItem: layerItem,
                                layerIndex: layerIndex,
                                currentLayer: newPath,
                                isReset: false
                            }
                        }));
                        
                        // Regenerate skirt if this is the first layer
                        if (layerIndex === 0) {
                            createFirstLayerSkirt();
                        }
                    }
                }
                
                // Restore control points (indicators stayed visible during rotate)
                if (currentControlMode !== null) {
                    drawAnchorPoints(layerItem);
                }
                
                // Reset variables
                originalPathPoints = null;
                dragStartPoint = null;
                this._rotationCenter = null;
                this._startAngle = null;
            } else {
                // Normal mode: handle start point reordering
                if (hasBeenDragged) {
                    // Handle drag end - reorder the path points and regenerate layer
                    const closestPoint = path.getNearestPoint(this.position);
                    const offset = path.getOffsetOf(closestPoint);
                    reorderPathFromOffset(path, offset, layerItem);
                } else {
                    // Handle click without drag - flip the path and regenerate layer
                    flipPath(path, layerItem);
                    updateIndicatorAfterFlip(indicatorGroup);
                }

                // Regenerate the layer completely as if it's a new layer
                regenerateLayerFromScratch(layerItem);

                // Refresh the indicators for the current layer after regeneration
                const layerIndex = layers.indexOf(layerItem);
                drawStartingPointIndicators(layerIndex);
            }
        }
        isDragging = false;
        hasBeenDragged = false;
        event.stopPropagation();
    };

    // Keep the 44px target stable; cursor feedback is registered above.

}

function updateArrowForNewStartPoint(indicatorGroup, newStartPoint, offset) {
    const path = indicatorGroup._path;
    const arrowGroup = indicatorGroup._arrowGroup;

    // Only update arrow if we're not in move mode (arrowGroup exists)
    if (arrowGroup) {
        // Calculate new direction at the offset


        // Remove old arrow and create new one
        arrowGroup.remove();
        const newArrowGroup = createDirectionChevrons(path, offset);
        indicatorGroup.addChild(newArrowGroup);
        indicatorGroup._arrowGroup = newArrowGroup;
    }
}

function reorderPathFromOffset(path, offset, layerItem) {
    const segments = path.segments;
    const totalLength = path.length;

    // Find the segment index closest to the offset
    let targetSegmentIndex = 0;
    let currentOffset = 0;

    for (let i = 0; i < segments.length - 1; i++) {
        const segmentLength = segments[i].point.getDistance(segments[i + 1].point);
        if (currentOffset + segmentLength >= offset) {
            targetSegmentIndex = i;
            break;
        }
        currentOffset += segmentLength;
    }

    if (targetSegmentIndex === 0) return; // Already at start

    // Reorder segments: move targetSegmentIndex to the beginning
    const reorderedSegments = [];

    // Add segments from targetSegmentIndex to end
    for (let i = targetSegmentIndex; i < segments.length; i++) {
        reorderedSegments.push({
            point: segments[i].point.clone(),
            handleIn: segments[i].handleIn.clone(),
            handleOut: segments[i].handleOut.clone()
        });
    }

    // Add segments from start to targetSegmentIndex
    for (let i = 0; i < targetSegmentIndex; i++) {
        reorderedSegments.push({
            point: segments[i].point.clone(),
            handleIn: segments[i].handleIn.clone(),
            handleOut: segments[i].handleOut.clone()
        });
    }

    // Rebuild the path with reordered segments
    path.removeSegments();
    reorderedSegments.forEach(seg => {
        path.add(new pathEditorScope.Segment(seg.point, seg.handleIn, seg.handleOut));
    });

    // Smooth the path
    path.smooth({ type: 'catmull-rom', factor: CONSTS.SMOOTHING_FACTOR });
}

function flipPath(path, layerItem) {
    const segments = path.segments;
    const reversedSegments = [];

    // Reverse the order of segments
    for (let i = segments.length - 1; i >= 0; i--) {
        reversedSegments.push({
            point: segments[i].point.clone(),
            handleIn: segments[i].handleOut.clone(), // Swap handles
            handleOut: segments[i].handleIn.clone()  // Swap handles
        });
    }

    // Rebuild the path with reversed segments
    path.removeSegments();
    reversedSegments.forEach(seg => {
        path.add(new pathEditorScope.Segment(seg.point, seg.handleIn, seg.handleOut));
    });

    // Smooth the path
    path.smooth({ type: 'catmull-rom', factor: CONSTS.SMOOTHING_FACTOR });
}

function updateIndicatorAfterFlip(indicatorGroup) {
    const path = indicatorGroup._path;
    const circle = indicatorGroup._circle;
    const segments = path.segments;

    if (segments.length < 2) return;

    // Update circle position to new start
    const newStartPoint = segments[0].point;
    circle.position = newStartPoint;

    // Update arrow
    const secondPoint = segments[1].point;
    const direction = secondPoint.subtract(newStartPoint).normalize();
    updateArrowForNewStartPoint(indicatorGroup, newStartPoint, 0);
}

function regenerateLayerFromScratch(layerItem) {
    // Get the current path with reordered/flipped segments
    const currentPath = layerItem.getLayer().firstChild;
    if (!currentPath || !currentPath.segments) return;

    // Extract the segment points from the modified path
    const pathPoints = currentPath.segments.map(segment => segment.point.clone());

    // Clear the layer completely (removes all paths and 3D meshes)
    resetCurve(layerItem);
    cleanupBoundsGuide();

    // Create a completely new path from scratch
    const newPath = createUserMadePath();

    // Add all the points to recreate the path
    pathPoints.forEach(point => {
        newPath.add(point);
    });

    // Close and smooth the path (same as when drawing normally)
    newPath.closed = true;
    newPath.smooth({ type: 'catmull-rom', factor: CONSTS.SMOOTHING_FACTOR });

    // Add the new path to the layer and mark as user-made
    layerItem.addPath(newPath, true);

    // Get the layer index for the event
    const layerIndex = layers.indexOf(layerItem);

    // Dispatch layerModified event as if a new layer was just drawn
    const ev = new CustomEvent("layerModified", {
        detail: {
            layerIndex: layerIndex,
            currentLayer: newPath,
            layerItem: layerItem,
            isReset: false, // This simulates a new layer being drawn, not a reset
        }
    });

    document.dispatchEvent(ev);

    // Send layer update to backend after regeneration
    if (window.printIntegration && typeof window.printIntegration.sendLayerUpdate === 'function') {
        window.printIntegration.sendLayerUpdate();
    }
}

// Calculate scale factor based on drag distance
function calculateScaleFactor(startPoint, currentPoint, scaleDirection, originalBounds) {
    let scaleFactor = 1;

    switch (scaleDirection) {
        case 'top':
            // Scale based on vertical movement, scaling from bottom
            const topDelta = startPoint.y - currentPoint.y;
            scaleFactor = 1 + (topDelta / originalBounds.height);
            break;
        case 'bottom':
            // Scale based on vertical movement, scaling from top
            const bottomDelta = currentPoint.y - startPoint.y;
            scaleFactor = 1 + (bottomDelta / originalBounds.height);
            break;
        case 'left':
            // Scale based on horizontal movement, scaling from right
            const leftDelta = startPoint.x - currentPoint.x;
            scaleFactor = 1 + (leftDelta / originalBounds.width);
            break;
        case 'right':
            // Scale based on horizontal movement, scaling from left
            const rightDelta = currentPoint.x - startPoint.x;
            scaleFactor = 1 + (rightDelta / originalBounds.width);
            break;
    }

    // Prevent negative scaling (flipping) and set minimum scale
    return Math.max(0.1, scaleFactor);
}

// A horizontal gesture supports growing and shrinking from a centered handle.
function calculateUniformScaleFactor(start, current, bounds) {
    const requested = Math.exp((current.x - start.x) * pathEditorScope.view.zoom / 120);
    const center = bounds.center;
    const halfWidth = Math.max(bounds.width / 2, 0.001);
    const halfHeight = Math.max(bounds.height / 2, 0.001);
    const limit = Math.min(
        (center.x - window.gridStartX) / halfWidth,
        (window.gridStartX + window.gridSize - center.x) / halfWidth,
        (center.y - window.gridStartY) / halfHeight,
        (window.gridStartY + window.gridSize - center.y) / halfHeight
    );
    return Math.min(Math.max(0.1, requested), Math.max(0.1, limit));
}

// Apply scaling to the path from original points (prevents accumulation of scaling errors)
function scalePathFromOriginal(path, scaleFactor, scaleDirection, originalPathPoints, fixedOrigin) {
    // Don't scale if factor is too close to 1 (no meaningful change)
    if (scaleDirection !== 'uniform' && Math.abs(scaleFactor - 1.0) < 0.001) return;

    let scaleX = 1, scaleY = 1;

    switch (scaleDirection) {
        case 'uniform':
            scaleX = scaleY = scaleFactor;
            break;
        case 'top':
        case 'bottom':
            scaleY = scaleFactor;
            break;
        case 'left':
        case 'right':
            scaleX = scaleFactor;
            break;
    }

    // Transform original points AND handles (not current points) to avoid accumulation
    const newSegments = [];

    for (let i = 0; i < originalPathPoints.length; i++) {
        const originalSegment = originalPathPoints[i];

        // Scale the main point
        const point = originalSegment.point.clone();
        point.x -= fixedOrigin.x;
        point.y -= fixedOrigin.y;
        point.x *= scaleX;
        point.y *= scaleY;
        point.x += fixedOrigin.x;
        point.y += fixedOrigin.y;

        // Scale the handle in (relative to the point, so just scale the vector)
        const handleIn = originalSegment.handleIn.clone();
        handleIn.x *= scaleX;
        handleIn.y *= scaleY;

        // Scale the handle out (relative to the point, so just scale the vector)
        const handleOut = originalSegment.handleOut.clone();
        handleOut.x *= scaleX;
        handleOut.y *= scaleY;

        newSegments.push({
            point: point,
            handleIn: handleIn,
            handleOut: handleOut
        });
    }

    // Rebuild the path with transformed points and handles
    path.removeSegments();
    newSegments.forEach(seg => {
        path.add(new pathEditorScope.Segment(seg.point, seg.handleIn, seg.handleOut));
    });
}

// Hide all starting point indicators
function hideStartingPointIndicators() {
    startingPointIndicators.forEach(indicator => {
        if (indicator) {
            indicator.visible = false;
        }
    });
}

// Show starting point indicators
function showStartingPointIndicators() {
    startingPointIndicators.forEach(indicator => {
        if (indicator) {
            indicator.visible = true;
        }
    });
}

// Helper function to completely remove all control points during move/rotate operations
function removeAllControlPoints(layerItem) {
    layerItem.removeAnchorPoints();
}

function addDirectPathMoveInteraction(path, layerItem) {
    let isDragging = false;
    let ghostPath = null;
    let dragStartPoint = null;
    let originalPathPoints = null;

    path.onMouseDown = function(event) {
        isDragging = true;
        dragStartPoint = event.point.clone();

        // Store original path points
        if (path && path.segments) {
            originalPathPoints = path.segments.map(segment => ({
                point: segment.point.clone(),
                handleIn: segment.handleIn.clone(),
                handleOut: segment.handleOut.clone()
            }));
        }

        // Create ghost path for visual feedback
        ghostPath = path.clone();
        ghostPath.opacity = 0.4;
        ghostPath.strokeColor = '#00000078';
        ghostPath.fillColor = null;
        ghostPath.shadowBlur = 0;
        ghostPath.shadowOffset = new pathEditorScope.Point(0, 0);

        // Add ghost path to the same layer
        path.layer.addChild(ghostPath);
        ghostPath.bringToFront();

        // Hide start indicators during move
        hideStartingPointIndicators();

        // Remove all control points during move operation
        removeAllControlPoints(layerItem);

        event.stopPropagation();
    };

    path.onMouseDrag = function(event) {
        if (!isDragging || !originalPathPoints || !ghostPath) return;

        const currentPoint = event.point;
        const delta = currentPoint.subtract(dragStartPoint);

        // Update ghost path position
        ghostPath.removeSegments();
        originalPathPoints.forEach((segData) => {
            const newPoint = segData.point.add(delta);
            ghostPath.add(new pathEditorScope.Segment(
                newPoint,
                segData.handleIn.clone(),
                segData.handleOut.clone()
            ));
        });

        // Check if ghost path is within grid bounds
        const isWithinBounds = isPathWithinGrid(ghostPath);

        // Update ghost path appearance based on validity
        if (isWithinBounds) {
            ghostPath.strokeColor = '#00000078'; // Green for valid position
            ghostPath.opacity = 0.6;
        } else {
            ghostPath.strokeColor = '#F44336'; // Red for invalid position
            ghostPath.opacity = 0.4;
        }

        event.stopPropagation();
    };

    path.onMouseUp = function(event) {
        cleanupBoundsGuide();
        if (isDragging && ghostPath) {
            // Check if final position is valid
            const isValidPosition = isPathWithinGrid(ghostPath);

            if (isValidPosition) {
                // Apply the transformation to the original path
                const currentPoint = event.point;
                const delta = currentPoint.subtract(dragStartPoint);

                // Clear and rebuild the original path with new positions
                path.removeSegments();
                originalPathPoints.forEach((segData) => {
                    const newPoint = segData.point.add(delta);
                    path.add(new pathEditorScope.Segment(
                        newPoint,
                        segData.handleIn.clone(),
                        segData.handleOut.clone()
                    ));
                });

                // Finalize the transformation by recreating the layer
                const pathPoints = path.segments.map(segment => segment.point.clone());
                layerItem.clear();
                layerItem.setUserMade(false);

                const newPath = createUserMadePath();
                pathPoints.forEach(point => newPath.add(point));
                newPath.closed = true;
                newPath.smooth({ type: 'catmull-rom', factor: CONSTS.SMOOTHING_FACTOR });

                // Restore original shadow properties to the new path (normal shadow, not enhanced)
                newPath.shadowBlur = 4; // Default shadow blur from createUserMadePath
                newPath.shadowOffset = new pathEditorScope.Point(2, 2); // Default shadow offset from createUserMadePath
                layerItem.addPath(newPath, true);

                // Trigger layer update
                const layerIndex = layers.indexOf(layerItem);
                const ev = new CustomEvent("layerModified", {
                    detail: {
                        layerIndex: layerIndex,
                        currentLayer: layerItem.getLayer().firstChild,
                        layerItem: layerItem,
                        isReset: false,
                    }
                });
                document.dispatchEvent(ev);

                // Regenerate skirt if this is the first layer
                if (layerIndex === 0) {
                    createFirstLayerSkirt();
                }

                // Send layer update to backend
                if (window.printIntegration && typeof window.printIntegration.sendLayerUpdate === 'function') {
                    window.printIntegration.sendLayerUpdate();
                }
            }

            // Always restore normal shadow after move operation (hardcoded values)
            if (path._originalShadowBlur !== undefined) {
                path.shadowBlur = 4; // Default shadow blur
                path.shadowOffset = new pathEditorScope.Point(2, 2); // Default shadow offset
            }

            // Clean up ghost path
            if (ghostPath) {
                ghostPath.remove();
                ghostPath = null;
            }

            // Redraw layers and show indicators
            const layerIndex = layers.indexOf(layerItem);
            redrawLayers(layerIndex);
            showStartingPointIndicators();
        }

        isDragging = false;
        dragStartPoint = null;
        originalPathPoints = null;
        event.stopPropagation();
    };
}

// Helper function to check if a path is within grid bounds and doesn't violate bound guides
function isPathWithinGrid(path) {
    if (!path || !path.segments) return false;

    // Check grid bounds
    for (let i = 0; i < path.segments.length; i++) {
        const point = path.segments[i].point;
        if (point.x < window.gridStartX ||
            point.x > window.gridStartX + window.gridSize ||
            point.y < window.gridStartY ||
            point.y > window.gridStartY + window.gridSize) {
            return false;
        }
    }

    // Check bound guide intersections
    if (!isPathWithinBoundGuides(path)) {
        return false;
    }

    return true;
}

// Function to check if a path violates bound guide constraints
function isPathWithinBoundGuides(path) {
    if (!innerBoundPath) {
        return true; // No inner bound guide, so no constraints
    }

    // Check if any point of the current path intersects with the inner bound
    // or if the path is too close (violating MIN_OVERLAP)
    return !pathsIntersect(path, innerBoundPath) && hasMinimumOverlap(path, innerBoundPath);
}

// Function to check if path maintains minimum overlap distance
function hasMinimumOverlap(path1, path2) {
    if (!path1 || !path2 || !path1.segments || !path2.segments) {
        return true;
    }

    const minOverlapPixels = CONSTS.MIN_OVERLAP * CONSTS.SCALE_FACTOR;
    
    // Check if any point on path1 is too close to path2
    for (let segment of path1.segments) {
        const point = segment.point;
        const nearestPoint = path2.getNearestPoint ? path2.getNearestPoint(point) : null;
        
        if (nearestPoint) {
            const distance = point.getDistance(nearestPoint);
            if (distance < minOverlapPixels) {
                return false; // Too close, violates minimum overlap
            }
        }
    }
    
    return true;
}

// Function to check if two paths intersect
function pathsIntersect(path1, path2) {
    try {
        // Use Paper.js built-in intersection detection if available
        if (path1.getIntersections && typeof path1.getIntersections === 'function') {
            const intersections = path1.getIntersections(path2);
            return intersections && intersections.length > 0;
        }

        // Fallback: Check if any points of path1 are inside path2
        for (let segment of path1.segments) {
            if (path2.contains && path2.contains(segment.point)) {
                return true;
            }
        }

        return false;
    } catch (error) {
        console.warn('Error checking path intersection:', error);
        return false; // Default to allowing the path if intersection check fails
    }
}

function addDirectPathRotateInteraction(path, layerItem) {
    let isDragging = false;
    let dragStartPoint = null;
    let originalPathPoints = null;
    let rotationCenter = null;
    let startAngle = 0;
    let staticIndicatorLine = null;
    let movingIndicatorLine = null;
    let rotationArc = null;
    let indicatorGroup = null;
    let degreeText = null;

    path.onMouseDown = function(event) {
        isDragging = true;
        dragStartPoint = event.point.clone();

        // Store original path points
        if (path && path.segments) {
            originalPathPoints = path.segments.map(segment => ({
                point: segment.point.clone(),
                handleIn: segment.handleIn.clone(),
                handleOut: segment.handleOut.clone()
            }));
        }

        // Calculate rotation center (centroid of the curve)
        rotationCenter = path.bounds.center.clone();

        // Calculate initial angle from rotation center to mouse position
        const mouseVector = dragStartPoint.subtract(rotationCenter);
        startAngle = Math.atan2(mouseVector.y, mouseVector.x);

        // Create rotation indicators
        createRotationIndicators();

        // Hide start indicators during rotation
        hideStartingPointIndicators();

        // Remove all control points during rotation operation
        removeAllControlPoints(layerItem);

        event.stopPropagation();
    };

    path.onMouseDrag = function(event) {
        if (!isDragging || !originalPathPoints) return;

        const currentPoint = event.point;

        // Calculate current angle and rotation
        const mouseVector = currentPoint.subtract(rotationCenter);
        const currentAngle = Math.atan2(mouseVector.y, mouseVector.x);
        const rotation = currentAngle - startAngle;

        // Apply rotation to the path
        if (path && path.segments) {
            path.removeSegments();

            originalPathPoints.forEach(segData => {
                const rotatedPoint = rotatePointAroundCenter(segData.point, rotationCenter, rotation);
                const rotatedHandleIn = rotateVector(segData.handleIn, rotation);
                const rotatedHandleOut = rotateVector(segData.handleOut, rotation);

                path.add(new pathEditorScope.Segment(rotatedPoint, rotatedHandleIn, rotatedHandleOut));
            });
        }

        // Update rotation indicators
        updateRotationIndicators(rotation);

        event.stopPropagation();
    };

    path.onMouseUp = function(event) {
        if (isDragging) {
            // Clean up rotation indicators
            if (indicatorGroup) {
                indicatorGroup.remove();
                indicatorGroup = null;
                staticIndicatorLine = null;
                movingIndicatorLine = null;
                rotationArc = null;
            }

            // Finalize the transformation by recreating the layer
            const currentPath = path;
            if (currentPath && currentPath.segments) {
                // Extract the final path points
                const pathPoints = currentPath.segments.map(segment => segment.point.clone());

                // Clear the layer and recreate path with proper styling
                layerItem.clear();
                layerItem.setUserMade(false);

                const newPath = createUserMadePath();
                pathPoints.forEach(point => newPath.add(point));
                newPath.closed = true;
                newPath.smooth({ type: 'catmull-rom', factor: CONSTS.SMOOTHING_FACTOR });

                layerItem.addPath(newPath, true);

                // Update layer and redraw
                const layerIndex = layers.indexOf(layerItem);
                const ev = new CustomEvent("layerModified", {
                    detail: {
                        layerIndex: layerIndex,
                        currentLayer: layerItem.getLayer().firstChild,
                        layerItem: layerItem,
                        isReset: false,
                    }
                });
                document.dispatchEvent(ev);

                // Regenerate skirt if this is the first layer
                if (layerIndex === 0) {
                    createFirstLayerSkirt();
                }

                // Send layer update to backend
                if (window.printIntegration && typeof window.printIntegration.sendLayerUpdate === 'function') {
                    window.printIntegration.sendLayerUpdate();
                }

                redrawLayers(layerIndex);
                showStartingPointIndicators();
            }
        }

        isDragging = false;
        dragStartPoint = null;
        originalPathPoints = null;
        rotationCenter = null;
        event.stopPropagation();
    };

    function createRotationIndicators() {
        // Create or get the indicators layer (always on top)
        let indicatorsLayer = pathEditorScope.project.layers.find(layer => layer.name === 'indicatorsLayer');
        if (!indicatorsLayer) {
            indicatorsLayer = new pathEditorScope.Layer({ name: 'indicatorsLayer' });
        }
        indicatorsLayer.activate();
        indicatorsLayer.bringToFront();

        // Create group for all rotation indicators
        indicatorGroup = new pathEditorScope.Group();

        const lineLength = 40;
        const initialDirection = dragStartPoint.subtract(rotationCenter).normalize();
        const staticLineEnd = rotationCenter.add(initialDirection.multiply(lineLength));

        // Create static reference line
        staticIndicatorLine = new pathEditorScope.Path.Line(rotationCenter, staticLineEnd);
        staticIndicatorLine.strokeColor = '#9d8779'; // Black color for static line
        staticIndicatorLine.strokeWidth = 2;
        staticIndicatorLine.opacity = 0.7;
        indicatorGroup.addChild(staticIndicatorLine);

        // Create moving line (initially same as static)
        movingIndicatorLine = new pathEditorScope.Path.Line(rotationCenter, staticLineEnd);
        movingIndicatorLine.strokeColor = CONSTS.INDICATOR_FILL_DARK; // Red color for moving line
        movingIndicatorLine.strokeWidth = 2;
        movingIndicatorLine.opacity = 0.7;
        indicatorGroup.addChild(movingIndicatorLine);

        // Create rotation arc (initially zero)
        rotationArc = new pathEditorScope.Path();
        rotationArc.strokeColor = CONSTS.INDICATOR_FILL_DARK; // Red color for arc
        rotationArc.strokeWidth = 2;
        rotationArc.opacity = 0.7;
        indicatorGroup.addChild(rotationArc);

        // Create degree text label (initially at static line end)
        degreeText = new pathEditorScope.PointText(rotationCenter.add(new pathEditorScope.Point(0, 0)));
        degreeText.content = '0°';
        degreeText.style = {
            fontSize: 14,
            fillColor: CONSTS.INDICATOR_FILL_DARK,
            justification: 'center'
        };
        indicatorGroup.addChild(degreeText);

        indicatorsLayer.addChild(indicatorGroup);

        // Switch back to the main layer
        pathEditorScope.project.layers[0].activate();
    }

    function updateRotationIndicators(rotation) {
        if (!indicatorGroup || !staticIndicatorLine || !movingIndicatorLine || !rotationArc || !degreeText) return;

        const lineLength = 40;
        const arcRadius = 30;

        // Update moving line
        const currentDirection = dragStartPoint.subtract(rotationCenter).normalize();
        const rotatedDirection = rotateVector(currentDirection, rotation);
        const movingLineEnd = rotationCenter.add(rotatedDirection.multiply(lineLength));

        movingIndicatorLine.removeSegments();
        movingIndicatorLine.add(rotationCenter);
        movingIndicatorLine.add(movingLineEnd);

        // Update degree text position and content (follows red line tip)
        const degrees = Math.round(rotation * (180 / Math.PI)); // Convert radians to degrees
        degreeText.content = `${degrees}°`;
        // Position text on continuation of the red line using direction vector
        const textOffset = rotatedDirection.multiply(15); // 15 pixels beyond the line tip
        degreeText.position = movingLineEnd.add(textOffset);

        // Update rotation arc
        rotationArc.removeSegments();

        if (Math.abs(rotation) > 0.1) { // Only show arc if there's meaningful rotation
            const startAngleForArc = Math.atan2(currentDirection.y, currentDirection.x);
            const endAngleForArc = startAngleForArc + rotation;

            // Create arc path
            const numSegments = Math.max(8, Math.floor(Math.abs(rotation) * 20)); // More segments for smoother arc
            for (let i = 0; i <= numSegments; i++) {
                const angle = startAngleForArc + (rotation * i / numSegments);
                const x = rotationCenter.x + Math.cos(angle) * arcRadius;
                const y = rotationCenter.y + Math.sin(angle) * arcRadius;
                rotationArc.add(new pathEditorScope.Point(x, y));
            }
        }
    }
}

/**
 * Creates a 2D texture with the bounds area and applies it to the moving plane
 */
function createBounds3D(boundsPath, layerIndex) {
    try {
        // Create a canvas texture with the bounds
        const canvas = document.createElement('canvas');
        const canvasSize = 512; // Texture resolution
        canvas.width = canvasSize;
        canvas.height = canvasSize;
        const ctx = canvas.getContext('2d');
        
        // Clear canvas with transparent background
        ctx.clearRect(0, 0, canvasSize, canvasSize);
        
        // Calculate scale factor to fit grid to canvas
        const gridSize = window.gridSize || 400;
        const scale = canvasSize / gridSize;
        
        // Set up canvas transform to match Paper.js coordinate system
        ctx.save();
        ctx.scale(scale, scale);
        ctx.translate(-(window.gridStartX || 0), -(window.gridStartY || 0));
        
        // Draw the bounds path
        ctx.strokeStyle = 'rgba(128, 51, 179, 0.8)'; // Purple color
        ctx.fillStyle = 'rgba(153, 102, 204, 0.3)'; // Semi-transparent purple fill
        ctx.lineWidth = 1 / scale; // Adjust line width for scale
        
        // Convert Paper.js path to canvas path
        ctx.beginPath();
        const segments = boundsPath.segments;
        if (segments && segments.length > 0) {
            ctx.moveTo(segments[0].point.x, segments[0].point.y);
            for (let i = 1; i < segments.length; i++) {
                ctx.lineTo(segments[i].point.x, segments[i].point.y);
            }
            if (boundsPath.closed) {
                ctx.closePath();
            }
        }
        
        // Fill and stroke the path
        ctx.fill();
        ctx.stroke();
        ctx.restore();
        
        // Apply texture immediately — canvas ops are synchronous, and the import is now
        // static so this lands in order right after any cleanup clear (D3).
        updatePlaneTexture(canvas);

    } catch (error) {
        console.warn('Error creating 3D bounds:', error);
    }
}

// Additional function to get silhouette from path using Clipper.js
function getSilhouetteFromPath(path) {
    const ClipperLib = window.ClipperLib;
    
    // Increase sampling for complex shapes to capture self-intersections
    const numSamples = Math.max(100, path.segments.length * 3);
    const points = [];
    
    // Sample points more densely to capture curve details and intersections
    for (let i = 0; i < numSamples; i++) {
        const t = i / numSamples;
        const pt = path.getPointAt(path.length * t);
        if (pt) {
            points.push({ X: pt.x, Y: pt.y });
        }
    }
    
    // Remove duplicate consecutive points to avoid Clipper issues
    const filteredPoints = [];
    for (let i = 0; i < points.length; i++) {
        if (i === 0 || 
            Math.abs(points[i].X - points[i-1].X) > 0.1 || 
            Math.abs(points[i].Y - points[i-1].Y) > 0.1) {
            filteredPoints.push(points[i]);
        }
    }
    
    if (filteredPoints.length < 3) return null;
    
    // Use higher precision for better accuracy with self-intersections
    const scale = 10000;
    const clipperPoints = filteredPoints.map(pt => ({ 
        X: Math.round(pt.X * scale), 
        Y: Math.round(pt.Y * scale) 
    }));
    
    const clipper = new ClipperLib.Clipper();
    const subject = [clipperPoints];
    
    clipper.AddPaths(subject, ClipperLib.PolyType.ptSubject, true);
    const solution = new ClipperLib.Paths();
    
    // Use EvenOdd fill type which handles self-intersections better
    const success = clipper.Execute(
        ClipperLib.ClipType.ctUnion,
        solution,
        ClipperLib.PolyFillType.pftEvenOdd,
        ClipperLib.PolyFillType.pftEvenOdd
    );

    if (!success || solution.length === 0) return null;
    
    // Find the largest polygon (outer contour) if multiple exist
    let largestPolygon = solution[0];
    let largestArea = 0;
    
    for (let poly of solution) {
        const area = Math.abs(ClipperLib.Clipper.Area(poly));
        if (area > largestArea) {
            largestArea = area;
            largestPolygon = poly;
        }
    }
    
    // Convert back to Paper.js points with smoothing
    const silhouette = new pathEditorScope.Path();
    largestPolygon.forEach(pt => {
        silhouette.add(new pathEditorScope.Point(pt.X / scale, pt.Y / scale));
    });
    
    silhouette.closed = true;
    
    // Apply smoothing to reduce jaggedness from sampling
    silhouette.smooth({ type: 'catmull-rom', factor: 0.3 });
    
    return silhouette;
}

// Listen for printer configuration changes and update path rendering
document.addEventListener('printerConfigConstantsUpdated', function(event) {
    const newConfig = event.detail;
    console.log('Updating path editor rendering for new configuration:', newConfig);
    
    // Check if the number of layers has changed
    const currentLayerCount = layers ? layers.length : 0;
    const newLayerCount = newConfig.OBJ_HEIGHT_LAYERS;
    
    if (currentLayerCount !== newLayerCount) {
        console.log('Layer count changed - clearing all path editor layers');
        
        // Clear all existing layers from the path editor
        if (layers && layers.length > 0) {
            layers.forEach((layerItem, index) => {
                if (layerItem) {
                    const layer = layerItem.getLayer();
                    if (layer) {
                        layer.removeChildren();
                        layer.remove();
                    }
                    layerItem.clear();
                }
            });
        }
        
        // The layers array will be re-initialized by the init.js event handler
        // No need to redraw here as it will be handled by the layer slider update
        
    } else {
        // Same number of layers - just update existing paths with new stroke width
        if (layers && layers.length > 0) {
            layers.forEach((layerItem, index) => {
                if (layerItem && layerItem.isUserMade()) {
                    const layer = layerItem.getLayer();
                    if (layer && layer.firstChild) {
                        // Update stroke width with new STROKE_W value
                        layer.firstChild.strokeWidth = curveStrokeWidth();
                    }
                }
            });
            
            // Redraw the current layer to apply changes
            if (selectedLayerIndex >= 0 && selectedLayerIndex < layers.length) {
                redrawLayers(selectedLayerIndex);
            }
        }
    }
    
    console.log('Path editor updated for new configuration');
});

// Export functions for use by other modules
window.update2DGrid = update2DGrid;
window.updateCanvasSize = updateCanvasSize;

// Canvas typography and clay colors follow the same preferences as the app shell.
document.addEventListener('textSizeChanged', () => {
    if (pathEditorScope && pathEditorScope.view && baselineGridSize) update2DGrid();
});
document.addEventListener('curvePaletteChanged', () => {
    if (pathEditorScope && pathEditorScope.view && layers[selectedLayerIndex]) redrawLayers(selectedLayerIndex);
});

// Coalesce live size adjustments without changing curve coordinates or print dimensions.
let gridSizeFrame = null;
document.addEventListener('gridSizeChanged', () => {
    if (gridSizeFrame !== null) return;
    gridSizeFrame = requestAnimationFrame(() => {
        gridSizeFrame = null;
        if (pathEditorScope && pathEditorScope.view && baselineGridSize) update2DGrid();
    });
});