/*
 * canvas-resize.js — single source of truth for keeping the canvas-heavy panels
 * and the layer-slider overlays in sync with the window/container size.
 *
 * Why this exists: the 2D (Paper.js) and 3D (Three.js) canvases need explicit
 * pixel sizes, and the layer-slider's print-progress fill + per-layer ticks are
 * absolutely positioned from getBoundingClientRect(). None of that was ever
 * recomputed on resize — so the editor was effectively fixed-size and the ticks
 * drifted. A ResizeObserver on the two canvas containers catches every size
 * change (window resize, log hide/show, split-screen toggle) and re-fits
 * everything on the next animation frame (coalesced, drift-free).
 */
(function () {
  let rafPending = false;

  function applyResize() {
    rafPending = false;

    // 2D editor (Paper.js): only set view.viewSize — never canvas.width/height.
    if (typeof window.updateCanvasSize === 'function') window.updateCanvasSize();
    if (typeof window.update2DGrid === 'function') window.update2DGrid();

    // 3D simulation (Three.js): resize renderer + camera; the RAF render loop redraws.
    if (typeof window.resize3DView === 'function') window.resize3DView();

    // Re-sync the layer-slider overlays that are positioned from getBoundingClientRect().
    const slider = document.getElementById('LayerSlider');
    if (slider && typeof slider.lockedLayerIndex === 'number' &&
        typeof window.updateLayerSliderLock === 'function') {
      window.updateLayerSliderLock(slider.lockedLayerIndex);
    }
    if (typeof window.updateLayerSliderTicks === 'function') {
      window.updateLayerSliderTicks();
    } else if (typeof window.updateLayerIndicators === 'function' && window.layers) {
      window.updateLayerIndicators(window.layers);
    }
  }

  function scheduleResize() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(applyResize);
  }

  function mount() {
    const targets = ['PathEditorBox', 'SimulationBox']
      .map(function (id) { return document.getElementById(id); })
      .filter(Boolean);

    if (typeof ResizeObserver !== 'undefined' && targets.length) {
      const ro = new ResizeObserver(scheduleResize);
      targets.forEach(function (el) { ro.observe(el); });
    }
    // Fallback / belt-and-suspenders: also react to window resize + orientation.
    window.addEventListener('resize', scheduleResize, { passive: true });
    window.addEventListener('orientationchange', scheduleResize, { passive: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();
