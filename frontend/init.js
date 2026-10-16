import {
    initializePathEditor,
    pathHandleMouseDown,
    pathHandlePathMouseDrag,
    pathHandleMouseUp,
    redrawLayers,
    toggleControlMode,
} from './path-editor.js';

import {
    initializeSimulationView,
    create3DLayer,
    updateSlicingPlaneToLayer,
    updateAllLayerMaterials,
    applyHeatmapMaterials,
    queueHeatmapRefresh
} from './threeD-model.js';

import {
    isHeatmapEnabled,
    setHeatmapEnabledFlag,
    invalidateSoundness
} from './heatmap.js';

import {
    copyLayer,
    pasteLayer,
    resetCurve,
    initializeLayers,
    pathEditorScope,
    setPathEditorScope,
    activateScope,
    layers,
    getSkirtLayerItem,
    setSelectedLayer,
    selectedLayerIndex,
    currentLayer,
    updateLayerIndicators,
    toggle3DPlaneVisibility,
    getMostRecentlyPrintedLayerIndex,
    initializePrintControls,
} from './utils.js';

import * as CONSTS from './consts.js';

import * as interpolate from './interpolate.js'
import { getDefaultColorScheme } from './user-preferences.js';
import { upgradeLayerSlider } from './layer-slider.js';

// Make interpolate available globally for settings
window.interpolate = interpolate;

// Make necessary functions available globally for user preferences
window.updateAllLayerMaterials = updateAllLayerMaterials;
window.layers = layers;
window.CONSTS = CONSTS;

paper.install(window);

// Module-scope RAF handle for the counter tween (allows cancellation on rapid adds)
let _counterTweenId = null;

const consoleOutput = document.getElementById('consoleOutput');
// Capture console.log for on-screen display
const originalConsoleLog = console.log;
console.log = function(...args) {
    originalConsoleLog.apply(console, args);
    if (consoleOutput) {
        const message = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' ');
        const div = document.createElement('div')
        div.innerText = `${new Date().toLocaleTimeString()}: ${message}`;
        consoleOutput.appendChild(div);
        consoleOutput.scrollTop = consoleOutput.scrollHeight;
    }
};

window.onload = function() {
    const pathEditor = document.getElementById(CONSTS.PATH_EDITOR_VIEW);
    const simulationView = document.getElementById(CONSTS.SIMULATION_VIEW);

    if (!pathEditor /*|| !splineEditor*/ || !simulationView) {
        console.error("One or more canvases are missing in the DOM.");
        return;
    }

    // PrinterLog is already initialized in printer-log.js, no need to create another instance here

    // Create Paper.js projects for PathEditor
    setPathEditorScope(new paper.PaperScope(), pathEditor);
    pathEditorScope.activate();
    initializeLayers();

    // Initialize the PathEditor and simulation view
    initializePathEditor();
    initializeSimulationView(simulationView);

    document.addEventListener("mousedown", activateScope);
    document.addEventListener("mousemove", activateScope);

    // Attach drawing handlers
    pathEditorScope.view.onMouseDown = function(event) {
        pathEditorScope.activate();
        pathHandleMouseDown(event);
    };

    pathEditorScope.view.onMouseDrag = event => {
        pathEditorScope.activate();
        pathHandlePathMouseDrag(event, currentLayer);
    };

    pathEditorScope.view.onMouseUp = _ => {
        pathEditorScope.activate();
        pathHandleMouseUp(currentLayer, selectedLayerIndex);
    };

    document.getElementById('Copy').addEventListener('click', copyLayer);
    document.getElementById('Paste').addEventListener('click', pasteLayer);
    document.getElementById('ResetCurve').addEventListener('click', resetCurve);
    document.getElementById('planeToggleButton').addEventListener('click', toggle3DPlaneVisibility);

    // Structural-soundness heatmap toggle (controls BOTH 2D and 3D at once).
    const heatmapToggleButton = document.getElementById('heatmapToggleButton');
    if (heatmapToggleButton) {
        heatmapToggleButton.addEventListener('click', () => {
            const on = !isHeatmapEnabled();
            setHeatmapEnabledFlag(on);
            heatmapToggleButton.classList.toggle('active', on);
            heatmapToggleButton.setAttribute('aria-pressed', String(on));
            heatmapToggleButton.title = on ? 'Hide structural heatmap' : 'Show structural heatmap';
            applyHeatmapMaterials(window.layers);     // 3D beads
            redrawLayers(selectedLayerIndex);          // 2D strokes
            if (on) queueHeatmapRefresh(window.layers); // vertex colors may be stale from edits made while off
        });
    }

    // Start Print is the FIRST action of the unified transport button (#pauseButton).
    // The pause/continue toggle (in utils.js handlePauseButtonClick) calls this when idle.
    window.startPrintFromControls = function () {
        if (!window.printIntegration || window.printIntegration.isPrinting) return;
        const validLayers = (window.layers || []).filter(l => l && l.layer !== null);
        if (validLayers.length < 5) {
            if (window.printerLog) {
                window.printerLog.addMessage({ message: 'Draw at least 5 layers, then press Print.', status: 'info' });
            }
            return;
        }
        window.printIntegration.startLayerPrinting(validLayers);
        // Now printing → button shows the pause icon (next action is pause).
        if (typeof window.setPauseButtonState === 'function') window.setPauseButtonState(false);
    };

    // Setup control mode buttons
    setupControlModeButtons();

    // Initialize print controls (stop and pause buttons)
    initializePrintControls();

    // Set initial state of plane toggle button (plane starts visible)
    const planeToggleButton = document.getElementById('planeToggleButton');
    if (planeToggleButton) {
        planeToggleButton.classList.add('active');
        planeToggleButton.title = 'Hide 3D Plane';
    }

    // Heatmap defaults ON (matches the heatmap.js default-enabled state).
    if (heatmapToggleButton) {
        heatmapToggleButton.classList.toggle('active', isHeatmapEnabled());
        heatmapToggleButton.setAttribute('aria-pressed', String(isHeatmapEnabled()));
        heatmapToggleButton.title = isHeatmapEnabled() ? 'Hide structural heatmap' : 'Show structural heatmap';
    }

    const layerSlider = document.getElementById("LayerSlider");
    upgradeLayerSlider(layerSlider); // turn the div into the custom component before we use .value/.max
    const paramsDiv = document.getElementById('parameters');
    paramsDiv.textContent = `${layerSlider.value} / ${CONSTS.OBJ_HEIGHT_LAYERS}`;

    // Tween the n/100 counter up from fromVal to toVal over ~220ms using ease-out cubic.
    // Guards rapid layer adds: cancels any in-flight tween before starting a new one.
    function tweenCounter(fromVal, toVal, duration) {
        if (duration === undefined) { duration = 220; }
        if (_counterTweenId) {
            cancelAnimationFrame(_counterTweenId);
            _counterTweenId = null;
        }
        const startTime = performance.now();
        function tick(now) {
            const elapsed = now - startTime;
            const rawT = Math.min(elapsed / duration, 1);
            const ease = 1 - Math.pow(1 - rawT, 3);
            const current = Math.round(fromVal + (toVal - fromVal) * ease);
            paramsDiv.textContent = `${current} / ${CONSTS.OBJ_HEIGHT_LAYERS}`;
            if (rawT < 1) {
                _counterTweenId = requestAnimationFrame(tick);
            } else {
                _counterTweenId = null;
            }
        }
        _counterTweenId = requestAnimationFrame(tick);
    }

    layerSlider.max = layers.length;
    setSelectedLayer(selectedLayerIndex);

    layerSlider.addEventListener("input", function() {
        const requestedIndex = parseInt(layerSlider.value, 10) - 1;
        setSelectedLayer(requestedIndex);
        updateLayerSliderAria(requestedIndex);

        // Automatically activate plane toggle when slider is moved
        const planeToggleButton = document.getElementById('planeToggleButton');
        if (planeToggleButton && !planeToggleButton.classList.contains('active')) {
            // Trigger the toggle function to show the plane
            toggle3DPlaneVisibility();
        }
    });

    // --- Layer-slider navigation aids (authored-layer ticks) ----------------
    // 1-based slider values of layers the user actually authored (the meaningful
    // "control points"; the rest are interpolated between them).
    function authoredSliderValues() {
        const vals = [];
        layers.forEach((l, i) => { if (l && l.actually_user_created) vals.push(i + 1); });
        return vals;
    }

    // Lowest value the slider may take (printed layers are locked out — see utils.js).
    function minAllowedValue() {
        return (typeof layerSlider.lockedLayerIndex === 'number' && layerSlider.lockedLayerIndex >= 0)
            ? layerSlider.lockedLayerIndex + 2
            : 1;
    }

    // Describe the current layer for screen readers: authored vs interpolated, and printed.
    function updateLayerSliderAria(index) {
        const max = parseInt(layerSlider.max, 10) || layers.length;
        const kind = (layers[index] && layers[index].actually_user_created) ? 'authored' : 'interpolated';
        const printed = (typeof layerSlider.lockedLayerIndex === 'number' && index <= layerSlider.lockedLayerIndex)
            ? ', printed' : '';
        layerSlider.setAttribute('aria-valuetext', `Layer ${index + 1} of ${max}, ${kind}${printed}`);
    }

    layerSlider.setAttribute('aria-label', 'Layer selector');
    layerSlider.setAttribute('aria-orientation', 'vertical');
    updateLayerSliderAria(parseInt(layerSlider.value, 10) - 1);

    // (Removed snap-to-tick: it pulled the selection off non-authored layers — including
    //  layer 0 — making them hard to land on/edit. Authored layers are still reachable
    //  precisely via the thumb and via PageUp/PageDown jumps below.)

    // PageUp/PageDown jump to the next/previous authored layer; Home/End go to ends.
    layerSlider.addEventListener("keydown", function(e) {
        if (!['PageUp', 'PageDown', 'Home', 'End'].includes(e.key)) return;
        const max = parseInt(layerSlider.max, 10) || layers.length;
        const current = parseInt(layerSlider.value, 10);
        const minV = minAllowedValue();
        const authored = authoredSliderValues().filter(v => v >= minV);
        let target = current;

        if (e.key === 'PageUp') {
            const next = authored.filter(v => v > current);
            target = next.length ? Math.min(...next) : max;
        } else if (e.key === 'PageDown') {
            const prev = authored.filter(v => v < current);
            target = prev.length ? Math.max(...prev) : minV;
        } else if (e.key === 'Home') {
            target = minV;
        } else if (e.key === 'End') {
            target = max;
        }

        e.preventDefault();
        if (target !== current) {
            layerSlider.value = target;
            setSelectedLayer(target - 1);
            updateLayerSliderAria(target - 1);
            const planeToggleButton = document.getElementById('planeToggleButton');
            if (planeToggleButton && !planeToggleButton.classList.contains('active')) {
                toggle3DPlaneVisibility();
            }
        }
    });

    // updateLayerSliderLock is now implemented in utils.js

    document.addEventListener("selectedLayerSet", ({ detail }) => {
        const { layer: selLayerInd } = detail;
        // Capture previous displayed counter value before updating the slider
        const prevVal = parseInt(layerSlider.value, 10) || 1;
        if (selLayerInd !== layerSlider.value) {
            layerSlider.value = selLayerInd + 1;
        }
        const newVal = selLayerInd + 1;
        updateLayerSliderAria(selLayerInd);

        updateSlicingPlaneToLayer(selLayerInd);

        // Tween the counter up (instead of snapping via innerHTML)
        tweenCounter(prevVal, newVal);

        // NOTE: the slider's terracotta "infill" is reserved for PRINT PROGRESS only
        // (printed/locked layers, drawn by updateLayerSliderLock in utils.js) — it must
        // NOT track scroll/selection. Selection only moves the thumb + counter.

        redrawLayers(selLayerInd);
    });

    // Listen for printer configuration changes and update layer slider
    document.addEventListener('printerConfigConstantsUpdated', function(event) {
        const newConfig = event.detail;
        console.log('Updating layer slider for new configuration:', newConfig);
        
        // Update the parameter display
        paramsDiv.innerHTML = `${layerSlider.value} / ${newConfig.OBJ_HEIGHT_LAYERS}`;
        
        // Re-initialize layers if the number of layers changed
        const currentLayerCount = layers.length;
        const newLayerCount = newConfig.OBJ_HEIGHT_LAYERS;
        
        if (currentLayerCount !== newLayerCount) {
            console.log(`Layer count changed from ${currentLayerCount} to ${newLayerCount}`);
            
            // Re-initialize layers with new count
            initializeLayers(pathEditorScope);
            
            // Update slider max value
            layerSlider.max = newLayerCount;
            
            // Reset to first layer
            layerSlider.value = 1;
            setSelectedLayer(0);
            
            // Update display
            paramsDiv.innerHTML = `1 / ${newLayerCount}`;
            
            // Redraw with new layer structure
            redrawLayers(0);
            updateLayerIndicators(layers);
        }
    });

    document.addEventListener('layerModified', (event) => {
        // Geometry changed → the soundness field is stale; recompute on next ensure().
        invalidateSoundness();
        const { layerItem: layer, layerIndex: index, currentLayer: curLayer, isReset: isReset } = event.detail;
        if (!isReset) {
            // Look for the master path if it exists (when path is split for visual feedback)
            const layerElement = layer.getLayer();
            const masterPath = layerElement ? layerElement.children.find(child => child.name === 'masterPath') : null;
            const pathFor3D = masterPath || curLayer;

            if (pathFor3D) {
                create3DLayer(pathFor3D, layers, index, getSkirtLayerItem());
            }
        } else {
            updateLayerIndicators(layers);
        }

        if (!layer.isUserMade()) {
            // Interpolation dispatches one layerModified per in-between layer. The 3D mesh
            // build above still runs, but the expensive Paper.js redrawLayers + indicator
            // pass must NOT run hundreds of times per interpolation — the orchestrating edit
            // already redraws + updates indicators ONCE after the loop (below). Skipping the
            // per-layer redraw here is the main interpolation-freeze reducer.
            if (event.detail.isInterpolated) {
                return;
            }
            // Non-interpolated empty/reset layer: redraw to clear all indicators.
            redrawLayers(index);
            updateLayerIndicators(layers);
            return;
        }

        const current = { layer, index };
        const before = interpolate.getLayerBefore(index, layers);
        const after = interpolate.getLayerAfter(index, layers);

        interpolate.interpolate(before, current, layers);
        interpolate.interpolate(current, after, layers);

        redrawLayers(index);
        updateLayerIndicators(layers);

        // The edit changed the soundness of layers far ABOVE the rebuilt range (support +
        // inherited cantilever reach cross authored anchors) — recolor every existing mesh
        // once, queued behind the rebuilds this edit just scheduled.
        queueHeatmapRefresh(layers);

        // Send layer update to backend after interpolation
        if (window.printIntegration && typeof window.printIntegration.sendLayerUpdate === 'function') {
            setTimeout(() => {
                window.printIntegration.sendLayerUpdate();
            }, 100);
        }
    });

    // Dropdown menu functionality
    const menuButton = document.getElementById('menuButton');
    const dropdownMenu = document.getElementById('dropdownMenu');

    // Initialize slider controls
    const interpSlider = document.getElementById('interpSlider');
    if (interpSlider) {
        interpSlider.addEventListener('input', function() {
            // Convert slider value (0-100) to smooth factor (0-1)
            const smoothFactor = parseInt(this.value) / 100;
            interpolate.setSmoothFactor(smoothFactor);
        });
    }

    // Color scheme dropdown functionality
    const colorSchemeButtons = document.querySelectorAll('.color-scheme-btn');
    if (colorSchemeButtons.length > 0) {
        colorSchemeButtons.forEach(button => {
            button.addEventListener('click', function() {
                const selectedScheme = this.dataset.scheme;

                // Remove selected class from all buttons
                colorSchemeButtons.forEach(btn => btn.classList.remove('selected'));

                // Add selected class to clicked button
                this.classList.add('selected');

                // Update the color scheme in consts
                if (CONSTS.setColorScheme(selectedScheme)) {
                    // Update all existing layer materials
                    updateAllLayerMaterials(layers);
                    // Update interpolated layer colors in 2D view
                    interpolate.updateInterpolatedLayersColor(layers);
                } else {
                    console.error(`Invalid color scheme: ${selectedScheme}`);
                }
            });
        });

        // Set default selection based on user preferences
        const defaultScheme = getDefaultColorScheme();
        const defaultButton = document.querySelector(`.color-scheme-btn[data-scheme="${defaultScheme}"]`);
        if (defaultButton && !defaultButton.classList.contains('selected')) {
            defaultButton.classList.add('selected');
            // Apply the default color scheme
            if (CONSTS.setColorScheme(defaultScheme)) {
                updateAllLayerMaterials(layers);
                interpolate.updateInterpolatedLayersColor(layers);
            }
        }
    }

    // Setup dropdown Export G-Code button (same functionality as completion modal)
    const exportGcodeDropdownBtn = document.getElementById('exportGcodeDropdownBtn');
    if (exportGcodeDropdownBtn) {
        exportGcodeDropdownBtn.addEventListener('click', function() {
            // Use the same exportGcode function from app.js
            if (window.completionScreen && typeof window.completionScreen.exportGcode === 'function') {
                window.completionScreen.exportGcode();
            } else {
                // Fallback if app.js isn't loaded yet
                exportGcodeFromDropdown();
            }
        });
    }

    // Setup Studio Mode button
    const studioModeBtn = document.getElementById('studioModeBtn');
    if (studioModeBtn) {
        studioModeBtn.addEventListener('click', function() {
            showStudioModeModal();
        });
    }

    // Flag to track dropdown state
    let dropdownIsOpen = false;

    if (menuButton && dropdownMenu) {
        console.log('Menu button and dropdown found, adding event listener');

        // ARIA wiring — the panel holds heterogeneous controls, so model it as a modal dialog.
        menuButton.setAttribute('aria-haspopup', 'true');
        menuButton.setAttribute('aria-expanded', 'false');
        menuButton.setAttribute('aria-controls', 'dropdownMenu');
        dropdownMenu.setAttribute('role', 'dialog');
        dropdownMenu.setAttribute('aria-modal', 'true');
        dropdownMenu.setAttribute('aria-label', 'Main menu');

        const getFocusable = () => Array.from(dropdownMenu.querySelectorAll(
            'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        )).filter(el => !el.disabled && el.offsetParent !== null);

        function trapTab(event) {
            if (event.key !== 'Tab') return;
            const f = getFocusable();
            if (!f.length) return;
            const first = f[0], last = f[f.length - 1];
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault(); last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault(); first.focus();
            }
        }

        // Keep the menu aligned with the anchored toolbar, including panel resizing.
        function positionMenuUnderPill() {
            if (!document.body.classList.contains('app-started')) return;
            const toolbar = document.getElementById('topBar');
            if (!toolbar) return;
            const r = toolbar.getBoundingClientRect();
            const width = Math.min(680, r.width, window.innerWidth - 16);
            const top = r.bottom + 8;
            dropdownMenu.style.width = width + 'px';
            dropdownMenu.style.top = top + 'px';
            dropdownMenu.style.right = 'auto';
            dropdownMenu.style.left = Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8)) + 'px';
            dropdownMenu.style.maxHeight = Math.max(0, window.innerHeight - top - 12) + 'px';
        }
        const toolbarObserver = new ResizeObserver(() => {
            if (dropdownIsOpen) positionMenuUnderPill();
        });
        toolbarObserver.observe(document.getElementById('topBar'));

        function openMenu() {
            positionMenuUnderPill();
            dropdownMenu.classList.add('open');
            menuButton.classList.add('open');
            menuButton.setAttribute('aria-expanded', 'true');
            dropdownIsOpen = true;
            disableMainInteractions();
            dropdownMenu.addEventListener('keydown', trapTab);
            window.addEventListener('resize', positionMenuUnderPill);
            // Move focus into the panel (after the slide starts).
            const f = getFocusable();
            if (f.length) requestAnimationFrame(() => f[0].focus());
        }

        function closeMenu() {
            dropdownMenu.classList.remove('open');
            menuButton.classList.remove('open');
            menuButton.setAttribute('aria-expanded', 'false');
            dropdownIsOpen = false;
            enableMainInteractions();
            dropdownMenu.removeEventListener('keydown', trapTab);
            window.removeEventListener('resize', positionMenuUnderPill);
            menuButton.focus(); // return focus to the trigger (WCAG 2.4.3)
        }

        menuButton.addEventListener('click', function() {
            if (dropdownMenu.classList.contains('open')) closeMenu();
            else openMenu();
        });

        // Close menu when clicking outside
        document.addEventListener('click', function(event) {
            if (dropdownIsOpen && !menuButton.contains(event.target) && !dropdownMenu.contains(event.target)) {
                closeMenu();
                event.stopPropagation();
            }
        });

        // Close menu when pressing Escape key
        document.addEventListener('keydown', function(event) {
            if (event.key === 'Escape' && dropdownIsOpen) {
                closeMenu();
            }
        });
    }

    // Functions to enable/disable main program interactions
    function disableMainInteractions() {
        // Disable Paper.js view interactions
        if (pathEditorScope.view) {
            pathEditorScope.view.onMouseDown = null;
            pathEditorScope.view.onMouseDrag = null;
            pathEditorScope.view.onMouseUp = null;
        }

        // Disable action bar buttons
        document.getElementById('Copy').style.pointerEvents = 'none';
        document.getElementById('Paste').style.pointerEvents = 'none';
        document.getElementById('ResetCurve').style.pointerEvents = 'none';
        document.getElementById('MoveCurve').style.pointerEvents = 'none';
        document.getElementById('RotateCurve').style.pointerEvents = 'none';
        document.getElementById('ScaleCurve').style.pointerEvents = 'none';

        // Disable layer slider
        document.getElementById('LayerSlider').style.pointerEvents = 'none';

        // Disable control buttons
        document.getElementById('stopButton').style.pointerEvents = 'none';
        // Keep pause button enabled in demo mode to allow pausing mock printing
        if (!window.isDemoMode) {
            document.getElementById('pauseButton').style.pointerEvents = 'none';
        }
    }

    function enableMainInteractions() {
        // Re-enable Paper.js view interactions
        if (pathEditorScope.view) {
            pathEditorScope.view.onMouseDown = function(event) {
                pathEditorScope.activate();
                pathHandleMouseDown(event);
            };

            pathEditorScope.view.onMouseDrag = event => {
                pathEditorScope.activate();
                pathHandlePathMouseDrag(event, currentLayer);
            };

            pathEditorScope.view.onMouseUp = _ => {
                pathEditorScope.activate();
                pathHandleMouseUp(currentLayer, selectedLayerIndex);
            };
        }

        // Re-enable action bar buttons
        document.getElementById('Copy').style.pointerEvents = 'auto';
        document.getElementById('Paste').style.pointerEvents = 'auto';
        document.getElementById('ResetCurve').style.pointerEvents = 'auto';
        document.getElementById('MoveCurve').style.pointerEvents = 'auto';
        document.getElementById('RotateCurve').style.pointerEvents = 'auto';
        document.getElementById('ScaleCurve').style.pointerEvents = 'auto';

        // Re-enable layer slider
        document.getElementById('LayerSlider').style.pointerEvents = 'auto';

        // Re-enable control buttons
        document.getElementById('stopButton').style.pointerEvents = 'auto';
        document.getElementById('pauseButton').style.pointerEvents = 'auto';
    }
    
    // Make enableMainInteractions available globally for other modules
    window.enableMainInteractions = enableMainInteractions;
    
    // Make setPauseButtonState available globally for demo mode
    if (typeof window.setPauseButtonState === 'undefined') {
        window.setPauseButtonState = function(paused) {
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
        };
    }
};

// Setup event listeners for the control mode buttons
function setupControlModeButtons() {
    const moveButton = document.getElementById('MoveCurve');
    const rotateButton = document.getElementById('RotateCurve');
    const scaleButton = document.getElementById('ScaleCurve');

    if (moveButton) {
        moveButton.addEventListener('click', () => toggleControlMode('move'));
    }
    if (rotateButton) {
        rotateButton.addEventListener('click', () => toggleControlMode('rotate'));
    }
    if (scaleButton) {
        scaleButton.addEventListener('click', () => toggleControlMode('scale'));
    }
}

// Setup print integration
function setupPrintIntegration() {
    // PrinterLog is already initialized globally in printer-log.js
    // No need to create another instance here

    // Setup layer update triggers
    setupLayerUpdateTriggers();
}

function setupLayerUpdateTriggers() {
    // Send layer updates when layers are modified
    const originalAddNewCurve = window.addNewCurve;

    // Send updates when layers change
    const observer = new MutationObserver(() => {
        if (window.layers && window.layers.length > 0 && window.printIntegration) {
            setTimeout(() => {
                window.printIntegration.sendLayerUpdate();
            }, 100);
        }
    });

    // Watch for changes in the simulation view
    const simulationView = document.getElementById('SimulationView');
    if (simulationView) {
        observer.observe(simulationView, {
            childList: true,
            subtree: true
        });
    }

    // Trigger layer update when new layers are added
    if (window.addNewCurve) {
        window.addEventListener('layerAdded', () => {
            setTimeout(() => {
                if (window.printIntegration) {
                    window.printIntegration.sendLayerUpdate();
                }
            }, 200);
        });
    }
}

// Make layers globally accessible for print integration
window.layersManager = {
    layers: layers,
    getValidLayers() {
        return this.layers.filter(layer => layer && layer.layer !== null);
    },
    getFirstFiveLayers() {
        return this.layers.slice(0, 5);
    }
};


// Call setup when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupPrintIntegration);
} else {
    setupPrintIntegration();
}

// SVG Animation — stroke-dashoffset line-draw on the inlined wordmark
document.addEventListener('DOMContentLoaded', () => {
    const pathElement = document.querySelector('.logo-animation-inline path');
    if (!pathElement) return;

    const pathLength = pathElement.getTotalLength();

    // Initial state: stroke only, fill transparent (Safari requires explicit stroke/strokeWidth)
    pathElement.style.fill = 'transparent';
    pathElement.style.stroke = '#cf4928';
    pathElement.style.strokeWidth = '2';
    pathElement.style.strokeDasharray = pathLength;
    pathElement.style.strokeDashoffset = pathLength;
    pathElement.style.transition = 'stroke-dashoffset 1.2s var(--ease-out)';

    // Trigger draw on next frame
    requestAnimationFrame(() => {
        pathElement.style.strokeDashoffset = '0';
    });

    // After draw: transition fill in, remove stroke
    setTimeout(() => {
        pathElement.style.transition = 'fill 0.3s var(--ease-out)';
        pathElement.style.fill = '#d6c3a9';
        pathElement.style.stroke = 'none';
    }, 1200);
});

document.addEventListener('DOMContentLoaded', () => {
    const debugOutput = document.getElementById('debugOutput');

    function logDebug(message) {
        const time = new Date().toLocaleTimeString();
        debugOutput.innerHTML = `[${time}] ${message}<br>` + debugOutput.innerHTML;
    }

    document.getElementById('testLayerUpdate').addEventListener('click', () => {
        if (window.printIntegration && typeof window.printIntegration.testLayerUpdate === 'function') {
            window.printIntegration.testLayerUpdate();
            logDebug('Layer update test triggered');
        } else {
            logDebug('Print integration not available');
        }
    });

    document.getElementById('checkConnection').addEventListener('click', () => {
        if (window.printIntegration) {
            logDebug(`Connection: ${window.printIntegration.isConnected ? 'Connected' : 'Disconnected'}`);
            logDebug(`Mock mode: ${window.printIntegration.useMockPrinter ? 'Yes' : 'No'}`);
        } else {
            logDebug('Print integration not loaded');
        }
    });

    document.getElementById('showLayerInfo').addEventListener('click', () => {
        if (window.layers && Array.isArray(window.layers)) {
            const layerArray = window.layers;

            let validCount = 0;
            layerArray.forEach((layer, index) => {
                if (layer && typeof layer.getLayer === 'function') {
                    const layerData = layer.getLayer();
                    if (layerData) validCount++;
                }
            });

            logDebug(`Layers: ${validCount}/${layerArray.length} valid`);
        } else {
            console.error('! window.layers is not available or not an array !');
            logDebug('! Layers array not available or invalid !');
        }
    });

    document.getElementById('initLayers').addEventListener('click', () => {
        logDebug('Initializing layers manually...');

        import('./utils.js').then(module => {
            const layers = module.layers;

            window.layers = layers;
            logDebug(`Layers initialized: ${layers.length} total`);

            if (window.layers && Array.isArray(window.layers)) {
                let validCount = 0;
                window.layers.forEach(layer => {
                    if (layer && typeof layer.getLayer === 'function' && layer.getLayer()) {
                        validCount++;
                    }
                });
                logDebug(`After init: ${validCount}/${window.layers.length} valid`);
            }
        }).catch(err => {
            logDebug('! Failed to load utils module: ' + err.message + ' !');
        });
    });

    // Test Completion button
    document.getElementById('showConsole').addEventListener('click', () => {
        const consoleDiv = document.getElementById('onScreenConsole');
        consoleDiv.style.display = consoleDiv.style.display === 'none' ? 'block' : 'none';
    });

    document.getElementById('testCompletion').addEventListener('click', () => {
        logDebug('Testing completion screen...');

        // Generate some mock G-code for testing
        const mockGcode = `; Mock G-code for testing
G28 ; Home all axes
G1 X10 Y10 Z0.2 F1500
G1 X20 Y20 E10 F800
G1 X30 Y30 E20 F800
; End of mock G-code`;

        // Trigger the completion screen
        if (window.onPrintComplete) {
            window.onPrintComplete(mockGcode);
            logDebug('Completion screen activated');
        } else {
            logDebug('onPrintComplete function not available');
            console.error('onPrintComplete function not found');
        }
    });

    // Initialize slider constraints
    function initializeSliderConstraints() {
        // This function can be used to set up any slider-related constraints
        // Currently no specific constraints needed beyond what's already implemented
        console.log('Slider constraints initialized');
    }

    initializeSliderConstraints();

    // Initialize Pi interpolation service
    setTimeout(() => {
        if (window.piInterpolation) {
            const connected = window.piInterpolation.initialize();
            console.log(`[INIT] Pi interpolation ${connected ? 'enabled' : 'disabled'}`);
        }
    }, 1000); // Wait for socket connection to establish

    // Add keyboard shortcut to toggle debug controls (Ctrl+Shift+D)
    document.addEventListener('keydown', function(e) {
        if (e.ctrlKey && e.shiftKey && e.key === 'D') {
            const debugControls = document.getElementById('debugControls');
            if (debugControls) {
                debugControls.style.display = debugControls.style.display === 'none' ? 'block' : 'none';
            }
        }
    });
});

// Helper function for Export G-Code from dropdown (uses backend API)
// Exposed globally so the printer-config destructive flow can reuse it.
window.exportGcodeFromDropdown = exportGcodeFromDropdown;
async function exportGcodeFromDropdown() {
    try {
        // Use backend API for G-code generation
        if (window.printIntegration && typeof window.printIntegration.exportGcode === 'function') {
            console.log('Requesting G-code export from backend...');
            
            try {
                const gcodeData = await window.printIntegration.exportGcode();
                
                if (gcodeData) {
                    // Create a blob with the G-code data
                    const blob = new Blob([gcodeData], { type: 'text/plain' });
                    const url = URL.createObjectURL(blob);
                    
                    // Create filename with DIRECT3D prefix and timestamp
                    const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
                    const filename = `DIRECT3D_${timestamp}.gcode`;
                    
                    // Create a temporary download link
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = filename;
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                    
                    // Clean up the URL object
                    URL.revokeObjectURL(url);
                    
                    console.log('G-code exported successfully from backend as:', filename);
                    return;
                }
            } catch (error) {
                console.error('Backend G-code export failed:', error);
                alert('Failed to export G-code from backend. Please try again.');
                return;
            }
        }
        
        // Fallback: check for previously generated G-code
        let gcodeData = null;
        if (window.printIntegration && window.printIntegration.lastGeneratedGcode) {
            gcodeData = window.printIntegration.lastGeneratedGcode;
        }
        
        if (!gcodeData) {
            alert('No G-code data available for export. Please create some layers first.');
            return;
        }
        
        // Export the existing G-code
        const blob = new Blob([gcodeData], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        
        const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
        const filename = `DIRECT3D_${timestamp}.gcode`;
        
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        
        URL.revokeObjectURL(url);
        console.log('G-code exported successfully from dropdown as:', filename);
        
    } catch (error) {
        console.error('Error exporting G-code from dropdown:', error);
        alert('Error generating G-code: ' + error.message + '\nPlease ensure you have created at least one layer.');
    }
}

// Helper function to show Studio Mode modal
function showStudioModeModal() {
    // Create modal elements
    const modalOverlay = document.createElement('div');
    modalOverlay.className = 'studio-mode-overlay';
    
    const modalContent = document.createElement('div');
    modalContent.className = 'studio-mode-content';
    
    modalContent.innerHTML = `
        <h3>Split Screen Mode</h3>
        <p>This feature is not yet implemented.</p>
        <button id="studioModalOkBtn" class="studio-mode-ok-btn">OK</button>
    `;
    
    modalOverlay.appendChild(modalContent);
    document.body.appendChild(modalOverlay);
    
    // Add event listeners
    document.getElementById('studioModalOkBtn').addEventListener('click', function() {
        document.body.removeChild(modalOverlay);
    });
    
    modalOverlay.addEventListener('click', function(e) {
        if (e.target === modalOverlay) {
            document.body.removeChild(modalOverlay);
        }
    });
    
    // Close on Escape key
    const escapeHandler = function(e) {
        if (e.key === 'Escape') {
            document.body.removeChild(modalOverlay);
            document.removeEventListener('keydown', escapeHandler);
        }
    };
    document.addEventListener('keydown', escapeHandler);
}

// Thanks Modal functionality
document.addEventListener('DOMContentLoaded', () => {
    const logoButton = document.getElementById('logoButton');
    const thanksModal = document.getElementById('thanksModal');
    const thanksOkBtn = document.getElementById('thanksOkBtn');
    const thanksTitle = document.getElementById('thanksTitle');
    const thanksText = document.getElementById('thanksText');

    // Function to load thanks content from file
    async function loadThanksContent() {
        try {
            console.log('Loading thanks content from thanks.txt...');
            const response = await fetch('./thanks.txt');
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            const content = await response.text();
            
            // Parse the content
            const lines = content.split('\n').filter(line => line.trim() !== '');
            
            if (lines.length > 0) {
                // First line is the title
                const title = lines[0];
                thanksTitle.textContent = title;
                
                // Rest of the content goes in paragraphs
                const contentLines = lines.slice(1);
                
                // Convert text to HTML paragraphs with markdown-style formatting
                const htmlContent = contentLines.map(line => {
                    // Process markdown-style formatting
                    let formattedLine = line
                        // Convert **bold** to <strong>bold</strong>
                        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
                        // Convert *italic* to <em>italic</em>
                        .replace(/\*(.*?)\*/g, '<em>$1</em>')
                        // Convert email addresses to links (do this BEFORE Instagram processing)
                        .replace(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g, '<a href="mailto:$1" target="_blank">$1</a>')
                        // Convert Instagram handles to links (only standalone @handles, not in emails)
                        .replace(/Instagram: \*\*@([a-zA-Z0-9_.]+)\*\*/g, 'Instagram: **<a href="https://instagram.com/$1" target="_blank">@$1</a>**')
                        .replace(/Instagram: @([a-zA-Z0-9_.]+)/g, 'Instagram: <a href="https://instagram.com/$1" target="_blank">@$1</a>')
                        // Convert LinkedIn: Name to a search link
                        .replace(/LinkedIn: ([^<\n]+)/g, 'LinkedIn: <a href="https://www.linkedin.com/search/results/all/?keywords=$1" target="_blank">$1</a>');
                    
                    return `<p>${formattedLine}</p>`;
                }).join('');
                
                thanksText.innerHTML = htmlContent;
                console.log('Thanks content loaded successfully');
            }
        } catch (error) {
            console.error('Error loading thanks content:', error);
            thanksTitle.textContent = 'Thank you for using DIRECTƎD!';
            thanksText.innerHTML = '<p>Thank you for using this application!</p><p><em>(Error loading detailed thanks message)</em></p>';
        }
    }

    // Open thanks modal when logo is clicked
    if (logoButton) {
        logoButton.addEventListener('click', async function() {
            console.log('Logo button clicked, opening thanks modal');
            if (thanksModal) {
                // Load fresh content each time
                await loadThanksContent();
                thanksModal.classList.add('active');
            }
        });
    }

    // Close thanks modal when OK button is clicked
    if (thanksOkBtn) {
        thanksOkBtn.addEventListener('click', function() {
            console.log('Thanks modal OK button clicked');
            if (thanksModal) {
                thanksModal.classList.remove('active');
            }
        });
    }

    // Close thanks modal when clicking outside
    if (thanksModal) {
        thanksModal.addEventListener('click', function(e) {
            if (e.target === thanksModal) {
                thanksModal.classList.remove('active');
            }
        });
    }

    // Close thanks modal with Escape key
    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape' && thanksModal && thanksModal.classList.contains('active')) {
            thanksModal.classList.remove('active');
        }
    });
});

