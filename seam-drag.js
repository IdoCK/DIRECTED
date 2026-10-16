// seam-drag.js — draggable seam between the 2D editor and 3D stage in focus mode.
// Adjusts the flex-basis of #leftContainer / #rightContainer; the ResizeObserver in
// canvas-resize.js (watching #PathEditorBox / #SimulationBox) re-fits both canvases on its own.
(function () {
  function mount() {
    var seam = document.getElementById('seam');
    var main = document.getElementById('mainContent');
    var left = document.getElementById('leftContainer');
    var right = document.getElementById('rightContainer');
    if (!seam || !main || !left || !right) return;

    var pct = 50; // boundary as a % of the main content width

    function apply() {
      left.style.flex = '0 0 ' + pct + '%';
      right.style.flex = '0 0 ' + (100 - pct) + '%';
      seam.style.left = pct + '%';
      // Published for overlays that must track the 2D/3D boundary (e.g. the tool
      // island centers over the 2D pane at calc(var(--split) * 0.5%)).
      main.style.setProperty('--split', String(pct));
      seam.setAttribute('aria-valuenow', String(Math.round(pct)));
    }

    function toPct(clientX) {
      var r = main.getBoundingClientRect();
      if (r.width === 0) return pct;
      var p = ((clientX - r.left) / r.width) * 100;
      return Math.max(20, Math.min(80, p)); // clamp so neither pane collapses
    }

    var dragging = false;

    seam.addEventListener('pointerdown', function (e) {
      dragging = true;
      seam.classList.add('dragging');
      try { seam.setPointerCapture(e.pointerId); } catch (_) {}
      e.preventDefault();
    });
    seam.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      pct = toPct(e.clientX);
      apply();
    });
    function end() {
      if (!dragging) return;
      dragging = false;
      seam.classList.remove('dragging');
    }
    seam.addEventListener('pointerup', end);
    seam.addEventListener('pointercancel', end);

    // Keyboard a11y on the role="separator".
    seam.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowLeft') { pct = Math.max(20, pct - 2); apply(); e.preventDefault(); }
      else if (e.key === 'ArrowRight') { pct = Math.min(80, pct + 2); apply(); e.preventDefault(); }
      else if (e.key === 'Home') { pct = 20; apply(); e.preventDefault(); }
      else if (e.key === 'End') { pct = 80; apply(); e.preventDefault(); }
    });

    seam.setAttribute('aria-valuemin', '20');
    seam.setAttribute('aria-valuemax', '80');
    apply();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();
