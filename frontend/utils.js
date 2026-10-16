import { LayerItem } from './layer-item.js';
import * as CONSTS from './consts.js';

export let layers;
export let skirtLayerItem = new LayerItem(-2); // Store reference to skirt as a separate layer item
let copiedLayer = null;
export let currentLayer = null;
export let drawing = false;
export let selectedLayerIndex = 0;
export let pathEditorScope, splineEditorScope;

// Track the most recently printed layer index (-1 means no layers printed)
let mostRecentlyPrintedLayerIndex = -1;

// Function to get the most recently printed layer index
export function getMostRecentlyPrintedLayerIndex() {
    return mostRecentlyPrintedLayerIndex;
}

// Function to update the most recently printed layer index
export function updateMostRecentlyPrintedLayer() {
    mostRecentlyPrintedLayerIndex = -1;
    
    // Find the highest index layer that is marked as printed
    for (let i = layers.length - 1; i >= 0; i--) {
        if (layers[i].isPrinted()) {
            mostRecentlyPrintedLayerIndex = i;
            break;
        }
    }
    
    return mostRecentlyPrintedLayerIndex;
}

// Function to check if a layer index is editable (above most recently printed layer)
export function isLayerEditable(layerIndex) {
    // Only apply constraints if there are printed layers
    if (mostRecentlyPrintedLayerIndex >= 0) {
        return layerIndex > mostRecentlyPrintedLayerIndex;
    }
    
    // If no layers are printed, all layers are editable
    return true;
}

export function setPathEditorScope(scope, elem) {
    pathEditorScope = scope;
    pathEditorScope.setup(elem);
    // Make pathEditorScope globally available
    window.pathEditorScope = pathEditorScope;
}

export function setSplineEditorScope(scope, elem) {
    splineEditorScope = scope;
    splineEditorScope.setup(elem);
}

export function initializeLayers(scope) {
    layers = Array.from({ length: CONSTS.OBJ_HEIGHT_LAYERS }, (_, k) => new LayerItem(k, scope));
}

export function setSelectedLayer(index) {
    if (index >= 0 && index < layers.length) {
        selectedLayerIndex = index;
        document.dispatchEvent(new CustomEvent("selectedLayerSet", { detail: { layer: index } }));
    }
}

export function copyLayer() {
    const layer = layers[selectedLayerIndex];
    if (!layer || !layer.getLayer()) return;
    copiedLayer = layer.getLayer().clone({ insert: false }); // Clone the layer to avoid reference issues
}

export function pasteLayer() {
    if (!copiedLayer) {
        console.warn("No layer copied.");
        return;
    }

    // Clear the current layer
    const selectedLayer = layers[selectedLayerIndex];
    selectedLayer.clear();

    // Clone the copied layer to get the path data
    const clonedLayer = copiedLayer.clone({ insert: false });
    const copiedPath = clonedLayer.firstChild;
    
    if (copiedPath && copiedPath.segments) {
        // Create a new user-made path with proper styling
        const newPath = new pathEditorScope.Path({
            strokeColor: 'black',
            strokeWidth: CONSTS.STROKE_W,
            strokeCap: 'round',
            opacity: 1,
        });
        newPath.shadowColor = new pathEditorScope.Color(0, 0, 0, 0.5);
        newPath.shadowBlur = 4;
        newPath.shadowOffset = new pathEditorScope.Point(2, 2);
        
        // Copy the path segments from the copied path
        copiedPath.segments.forEach(segment => {
            newPath.add(new pathEditorScope.Segment(
                segment.point.clone(),
                segment.handleIn.clone(),
                segment.handleOut.clone()
            ));
        });
        
        // Apply the same properties as the copied path
        newPath.closed = copiedPath.closed;
        if (copiedPath.closed) {
            newPath.smooth({ type: 'catmull-rom', factor: CONSTS.SMOOTHING_FACTOR });
        }
        
        // Add the new path to the layer and mark as user-made
        selectedLayer.addPath(newPath, true);
    }
    
    // Clean up the cloned layer
    clonedLayer.remove();

    const ev = new CustomEvent("layerModified", {
            detail: {
                layerIndex: selectedLayerIndex,
                currentLayer: selectedLayer.getLayer().firstChild,
                layerItem: layers[selectedLayerIndex],
                isReset: false,
            }
        });

    document.dispatchEvent(ev);
}

export function resetCurve() {
    const layer = layers[selectedLayerIndex];
    if (!layer || !layer.getLayer() || layer.isPrinted()) return;
    
    // Check if the layer is editable
    if (!isLayerEditable(selectedLayerIndex)) {
        console.warn(`! Layer ${selectedLayerIndex + 1} is not editable because it's at or below the most recently printed layer !`);
        return;
    }
    
    layer.clear();
    layer.setUserMade(false);
    const ev = new CustomEvent("layerModified", {
        detail: {
            layerIndex: selectedLayerIndex,
            currentLayer: layer.getLayer(),
            layerItem: layer,
            isReset: true,
        }
    });
    document.dispatchEvent(ev);
}

export function setDrawing(bool) {
    drawing = bool;
    // Focus mode (Layout 6): while a stroke is in progress on the 2D canvas, recede the
    // floating bars so they don't compete with the drawing (point 3). The body class
    // drives the dim; it's restored the moment the stroke ends.
    document.body.classList.toggle('drawing', !!bool);
}

export function setCurrentLayer(path) {
    currentLayer = path;
}

export function activateScope(event) {
    const targetId = event.target.id;
    if (targetId === CONSTS.PATH_EDITOR_VIEW) {
        pathEditorScope.activate();
        window.paper = pathEditorScope;
    } else if (targetId === CONSTS.SPLINE_EDITOR) {
        splineEditorScope.activate();
        window.paper = splineEditorScope;
    }
}

// Function to update layer slider indicators
export function updateLayerIndicators(layersArray) {
    // Clean up any legacy fixed-position ticks from older builds.
    document.querySelectorAll('.layer-indicator').forEach(el => el.remove());

    const slider = document.getElementById('LayerSlider');
    if (!slider || typeof slider.setAuthored !== 'function') return;

    // Hand the authored-layer indices (0-based) to the component, which renders them
    // as SVG ticks inside the track — they reflow on resize automatically.
    const authored = [];
    layersArray.forEach((layerItem, index) => {
        if (layerItem && layerItem.actually_user_created) authored.push(index);
    });
    slider.setAuthored(authored);
}

// Function to toggle 2D grid overlay visibility
function toggle2DGridOverlay(visible) {
    // Access the pathEditorScope to find the grid overlay layer
    if (window.pathEditorScope && window.pathEditorScope.project) {
        const gridOverlayLayer = window.pathEditorScope.project.layers.find(layer => layer.name === 'gridOverlayLayer');
        if (gridOverlayLayer) {
            gridOverlayLayer.opacity = visible ? 1 : 0;
        }
    }
}

// 3D plane opacity toggle functionality
let planeVisible = true;
const originalPlaneOpacity = 0.2; // Store the original opacity value

export async function toggle3DPlaneVisibility() {
    // Import the plane from threeD-model.js
    const { get3DPlane, getOverlayPlane } = await import('./threeD-model.js');
    const plane = get3DPlane();
    const overlayPlane = getOverlayPlane();
    
    if (plane && plane.material) {
        planeVisible = !planeVisible;
        plane.material.opacity = planeVisible ? originalPlaneOpacity : 0;
        
        // Also toggle the overlay plane (bounds plane)
        if (overlayPlane && overlayPlane.material) {
            overlayPlane.material.opacity = planeVisible ? 1 : 0;
        }
        
        // Update the toggle button appearance
        const toggleButton = document.getElementById('planeToggleButton');
        if (toggleButton) {
            if (planeVisible) {
                toggleButton.classList.add('active');
                toggleButton.title = 'Hide 3D Plane';
            } else {
                toggleButton.classList.remove('active');
                toggleButton.title = 'Show 3D Plane';
            }
        }
        
        // Update the layer slider thumb transparency
        const layerSlider = document.getElementById('LayerSlider');
        if (layerSlider) {
            if (planeVisible) {
                layerSlider.classList.remove('plane-hidden');
                console.log('Removed plane-hidden class from layer slider');
            } else {
                layerSlider.classList.add('plane-hidden');
                console.log('Added plane-hidden class to layer slider');
            }
            console.log('Layer slider classes:', layerSlider.className);
        } else {
            console.error('LayerSlider element not found');
        }
        
        // Toggle 2D grid overlay visibility
        toggle2DGridOverlay(planeVisible);
    }
}

// Send layer update to backend when layer operations occur
function sendLayerUpdateIfAvailable() {
    if (window.printIntegration && typeof window.printIntegration.sendLayerUpdate === 'function') {
        window.printIntegration.sendLayerUpdate();
    }
}

export function setLayers(newLayers) {
    layers.length = 0;
    layers.push(...newLayers);
    // Update global reference
    window.layers = layers;
}

export function addLayer(layer) {
    layers.push(layer);
    // Update global reference
    window.layers = layers;
}

// Expose layers globally for debugging and print integration
window.layers = layers;

// Expose skirt variables and functions globally for print integration
window.skirtLayerItem = skirtLayerItem;
window.getSkirtLayerItem = getSkirtLayerItem;

// Update global layers reference whenever layers change
export function updateGlobalLayers() {
    window.layers = layers;
}

// Export the helper function
export { sendLayerUpdateIfAvailable };

// Print Control Management - Stop and Pause buttons
let isPaused = false;
let isShowingStopConfirmation = false;

// Initialize stop and pause button event listeners
export function initializePrintControls() {
    const stopButton = document.getElementById('stopButton');
    const pauseButton = document.getElementById('pauseButton');
    const stopYesBtn = document.getElementById('stopYesBtn');
    const stopNoBtn = document.getElementById('stopNoBtn');
    const stopConfirmationOverlay = document.getElementById('stopConfirmationOverlay');

    // Stop button - show confirmation
    if (stopButton) {
        stopButton.addEventListener('click', (e) => {
            e.preventDefault();
            handleStopButtonClick();
        });
    }

    // Pause button - toggle pause/play
    if (pauseButton) {
        pauseButton.addEventListener('click', (e) => {
            e.preventDefault();
            
            handlePauseButtonClick();
        });
    }

    // Stop confirmation buttons
    if (stopYesBtn) {
        stopYesBtn.addEventListener('click', () => {
            confirmStop();
        });
    }

    if (stopNoBtn) {
        stopNoBtn.addEventListener('click', () => {
            cancelStop();
        });
    }

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
        if (isShowingStopConfirmation && e.key === 'Escape') {
            cancelStop();
        }
    });
}

function handleStopButtonClick() {
    if (isShowingStopConfirmation) return;
    
    // Show stop confirmation overlay immediately
    const stopConfirmationOverlay = document.getElementById('stopConfirmationOverlay');
    if (stopConfirmationOverlay) {
        isShowingStopConfirmation = true;
        stopConfirmationOverlay.classList.add('active');
    }
    
    // First, pause the printer
    sendPauseCommand();
    isPaused = true;
}

function handlePauseButtonClick() {
    if (isShowingStopConfirmation) return;

    const pauseButton = document.getElementById('pauseButton');
    if (!pauseButton) return;

    // Idle (not yet printing) → the FIRST action is to start the print.
    if (!window.printIntegration || !window.printIntegration.isPrinting) {
        if (typeof window.startPrintFromControls === 'function') {
            window.startPrintFromControls();
        }
        return;
    }

    if (isPaused) {
        // Resume printing
        sendResumeCommand();
        pauseButton.innerHTML = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" style="width: 100%; height: 100%;">\n            <rect x="6" y="4" width="4" height="16" rx="2" fill="#FFFFFF"/>\n            <rect x="14" y="4" width="4" height="16" rx="2" fill="#FFFFFF"/>\n        </svg>';
        pauseButton.title = 'Pause Print';
        isPaused = false;
        window.isPrintPaused = false;
    } else {
        // Pause printing
        sendPauseCommand();
        pauseButton.innerHTML = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" style="width: 100%; height: 100%;">\n            <polygon points="8,4 20,12 8,20" fill="#FFFFFF"/>\n        </svg>';
        pauseButton.title = 'Resume Print';
        isPaused = true;
        window.isPrintPaused = true;
    }
}

function pausePrint() {
    console.log('Pausing print...');
    sendPauseCommand();
    setPauseButtonState(true);
    isPaused = true;
}

function resumePrint() {
    console.log('Resuming print...');
    sendResumeCommand();
    setPauseButtonState(false);
    isPaused = false;
}

function setPauseButtonState(paused) {
    const pauseButton = document.getElementById('pauseButton');
    if (!pauseButton) return;

    if (paused) {
        // Change to play icon
        pauseButton.innerHTML = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" style="width: 100%; height: 100%;">\n            <polygon points="8,4 20,12 8,20" fill="#FFFFFF"/>\n        </svg>';
        pauseButton.title = 'Resume Print';
    } else {
        // Change to pause icon
        pauseButton.innerHTML = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" style="width: 100%; height: 100%;">\n            <rect x="6" y="4" width="4" height="16" rx="2" fill="#FFFFFF"/>\n            <rect x="14" y="4" width="4" height="16" rx="2" fill="#FFFFFF"/>\n        </svg>';
        pauseButton.title = 'Pause Print';
    }
}

function showStopConfirmation() {
    isShowingStopConfirmation = true;
    const stopConfirmationOverlay = document.getElementById('stopConfirmationOverlay');
    if (stopConfirmationOverlay) {
        stopConfirmationOverlay.classList.add('active');
    }
}

function hideStopConfirmation() {
    isShowingStopConfirmation = false;
    const stopConfirmationOverlay = document.getElementById('stopConfirmationOverlay');
    if (stopConfirmationOverlay) {
        stopConfirmationOverlay.classList.remove('active');
    }
}

function confirmStop() {
    console.log('Stop confirmed - stopping print session');
    
    // Send stop command to printer
    sendStopCommand();
    
    // Hide confirmation overlay
    hideStopConfirmation();
    
    // Reset control states
    resetPrintControlStates();
    
    // Trigger completion screen as if print completed normally
    if (window.onPrintComplete) {
        // Get the G-code data if available
        const gcodeData = window.printIntegration ? window.printIntegration.lastGeneratedGcode : null;
        window.onPrintComplete(gcodeData);
    }
}

function cancelStop() {
    console.log('Stop cancelled - resuming print');
    
    // Hide confirmation overlay
    hideStopConfirmation();
    
    // Resume printing if it was paused
    if (isPaused) {
        resumePrint();
    }
}

function resetPrintControlStates() {
    // Back to idle: the transport shows a play icon (next action is Start Print).
    const pauseButton = document.getElementById('pauseButton');
    if (pauseButton) {
        pauseButton.innerHTML = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" style="width: 100%; height: 100%;">\n            <polygon points="8,4 20,12 8,20" fill="#FFFFFF"/>\n        </svg>';
        pauseButton.title = 'Start Print';
    }
    isPaused = false;
    isShowingStopConfirmation = false;
}

function sendPauseCommand() {
    if (window.printIntegration) {
        // Use different command types for demo mode vs printer mode
        const commandType = window.isDemoMode ? 'pause' : 'pause_print';
        window.printIntegration.send({
            type: commandType,
            timestamp: Date.now()
        });
    }
}

function sendResumeCommand() {
    if (window.printIntegration) {
        // Use different command types for demo mode vs printer mode
        const commandType = window.isDemoMode ? 'resume' : 'resume_print';
        window.printIntegration.send({
            type: commandType,
            timestamp: Date.now()
        });
    }
}

function sendStopCommand() {
    if (window.printIntegration) {
        window.printIntegration.send({
            type: 'stop',
            timestamp: Date.now()
        });
    }
}

// ---------------------------------------------------------------------------
// Public session-control helpers (used by the printer-config destructive flow).
// Keep the transport pause/play state in sync with programmatic actions so the
// play/pause button reflects what the config flow does to the session.
// ---------------------------------------------------------------------------

// Is a print/session in progress (printing OR paused) and past the splash screen?
function isSessionActive() {
    const started = document.body.classList.contains('app-started');
    const pi = window.printIntegration;
    if (!started || !pi) return false;
    return !!(pi.isPrinting || pi.mockPrintPaused || isPaused);
}

// Pause the running print (no-op if already paused). Mirrors the pause button.
function pausePrintSession() {
    if (isPaused) return;
    sendPauseCommand();
    setPauseButtonState(true);
    isPaused = true;
    window.isPrintPaused = true;
}

// Resume a paused print (no-op if not paused). Mirrors the play button.
function resumePrintSession() {
    if (!isPaused) return;
    sendResumeCommand();
    setPauseButtonState(false);
    isPaused = false;
    window.isPrintPaused = false;
}

// Hard-stop the session and reset transport state (does NOT show completion).
function stopPrintSession() {
    sendStopCommand();
    resetPrintControlStates();
    window.isPrintPaused = false;
}

// Expose to non-module scripts (printer-config.js triggers these).
window.isSessionActive = isSessionActive;
window.pausePrintSession = pausePrintSession;
window.resumePrintSession = resumePrintSession;
window.stopPrintSession = stopPrintSession;
window.isPrintPaused = isPaused;

// Export functions that might be needed externally
export { resetPrintControlStates, setPauseButtonState, isSessionActive, pausePrintSession, resumePrintSession, stopPrintSession };

export function setSkirtLayer(item) {
    if (!item) {
        skirtLayerItem = new LayerItem(-2); 
    } else {
        skirtLayerItem.setLayer(item);
    }
}

export function getSkirtLayerItem() {
    return skirtLayerItem;
}


/**
 * Checks if a skirt exists for the first layer
 * @returns {boolean} True if first layer skirt exists
 */
function hasFirstLayerSkirt() {
    if (!skirtLayerItem) {
        return false;
    }
    
    const skirtLayer = skirtLayerItem.getLayer();
    if (!skirtLayer) {
        return false;
    }
    
    return skirtLayer.hasChildren() && 
           skirtLayer.firstChild && 
           skirtLayer.firstChild.segments && 
           skirtLayer.firstChild.segments.length > 0;
}

// Update layer slider print-progress + lock. The custom component (layer-slider.js)
// renders the terracotta fill from its `lockedLayerIndex` and enforces the minimum
// selectable layer internally, so this just hands it the value and nudges the
// selection off any layer that just became printed.
export function updateLayerSliderLock(lockedLayerIndex) {
    const slider = document.getElementById('LayerSlider');
    if (!slider) return;

    slider.lockedLayerIndex = lockedLayerIndex; // renders the print-progress fill + clamps min

    if (lockedLayerIndex >= 0) {
        const maxLayers = parseInt(slider.max, 10) || 1;
        const currentLayerIndex = parseInt(slider.value, 10) - 1; // 0-based
        // If the selected layer is now in the printed region, move it to the next selectable one.
        if (currentLayerIndex <= lockedLayerIndex && lockedLayerIndex < maxLayers - 1) {
            const newSliderValue = lockedLayerIndex + 2; // 1-based next selectable
            slider.value = newSliderValue;
            setSelectedLayer(newSliderValue - 1);
        }
    }
}

// Make functions available globally
window.updateLayerSliderLock = updateLayerSliderLock;
window.updateLayerIndicators = updateLayerIndicators;
// Reset the unified transport button to its idle "Start Print" (play) state.
window.setTransportIdle = function () {
    const pauseButton = document.getElementById('pauseButton');
    if (!pauseButton) return;
    pauseButton.innerHTML = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" style="width: 100%; height: 100%;">\n            <polygon points="8,4 20,12 8,20" fill="#FFFFFF"/>\n        </svg>';
    pauseButton.title = 'Start Print';
};
