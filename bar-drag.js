// bar-drag.js — focus-mode floating bars (#topBar, #ActionBar) get a drag grip.
//   • DRAG the grip  → reposition the bar freely (clamped into the viewport, persisted)
//   • CLICK the grip → toggle the bar between horizontal and vertical (smooth FLIP)
// Click vs drag is disambiguated by a 6px movement threshold. Mirrors seam-drag.js's
// pointer-capture pattern. ActionBar defaults to a vertical rail on the left.
(function () {
  var DRAG_SLOP = 6;
  function isNum(v) { return typeof v === 'number' && isFinite(v); }

  // persist=false: the bar is draggable within the session but always boots
  // at its CSS default (no localStorage save/restore).
  function setupBar(bar, key, applyDefault, persist) {
    if (!bar || bar._barDragInit) return;
    bar._barDragInit = true;

    // Inject the grip as the bar's first child.
    var grip = document.createElement('button');
    grip.type = 'button';
    grip.className = 'bar-grip';
    grip.setAttribute('aria-label', 'Drag to move bar, or click to rotate it');
    grip.title = 'Drag to move · click to rotate';
    bar.insertBefore(grip, bar.firstChild);

    function pinToExplicit() {
      // Kill the transition FIRST: clearing the centering transform (translateX(-50%))
      // while a transform-transition is live would animate the bar sliding away from the
      // grip ("pops to the middle"). With transition off, the box stays exactly put.
      bar.style.transition = 'none';
      var r = bar.getBoundingClientRect();
      bar.style.left = r.left + 'px';
      bar.style.top = r.top + 'px';
      bar.style.right = 'auto';
      bar.style.bottom = 'auto';
      bar.style.transform = 'none';
    }
    function clampInto() {
      var r = bar.getBoundingClientRect();
      var x = Math.max(8, Math.min(window.innerWidth - r.width - 8, r.left));
      var y = Math.max(8, Math.min(window.innerHeight - r.height - 8, r.top));
      bar.style.left = x + 'px';
      bar.style.top = y + 'px';
    }
    function save() {
      if (!persist) return;
      try {
        var r = bar.getBoundingClientRect();
        localStorage.setItem(key, JSON.stringify({
          left: r.left, top: r.top, vertical: bar.classList.contains('vertical')
        }));
      } catch (_) {}
    }
    function toggleOrientation() {
      var first = bar.getBoundingClientRect();
      pinToExplicit();
      bar.classList.toggle('vertical');
      // FLIP: slide from the old box to the new one (flex reflow itself isn't animatable).
      var last = bar.getBoundingClientRect();
      var dx = first.left - last.left, dy = first.top - last.top;
      bar.style.transition = 'none';
      bar.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
      bar.getBoundingClientRect(); // force reflow
      bar.style.transition = 'transform var(--duration-base) var(--ease-out)';
      bar.style.transform = 'none';
      var done = function () {
        bar.style.transition = '';
        bar.removeEventListener('transitionend', done);
        clampInto();
        save();
      };
      bar.addEventListener('transitionend', done);
      setTimeout(done, 400); // fallback if transitionend doesn't fire
    }

    var armed = false, moved = false, sx = 0, sy = 0, ox = 0, oy = 0;

    grip.addEventListener('pointerdown', function (e) {
      armed = true; moved = false; sx = e.clientX; sy = e.clientY;
      pinToExplicit();
      var r = bar.getBoundingClientRect();
      ox = e.clientX - r.left; oy = e.clientY - r.top;
      try { grip.setPointerCapture(e.pointerId); } catch (_) {}
      e.preventDefault(); e.stopPropagation();
    });
    grip.addEventListener('pointermove', function (e) {
      if (!armed) return;
      if (!moved && Math.hypot(e.clientX - sx, e.clientY - sy) > DRAG_SLOP) {
        moved = true;
        bar.classList.add('bar-dragging');
        document.body.classList.add('bar-dragging');
        bar.style.transition = 'none';
      }
      if (moved) {
        var r = bar.getBoundingClientRect();
        var x = Math.max(8, Math.min(window.innerWidth - r.width - 8, e.clientX - ox));
        var y = Math.max(8, Math.min(window.innerHeight - r.height - 8, e.clientY - oy));
        bar.style.left = x + 'px';
        bar.style.top = y + 'px';
      }
    });
    function end() {
      if (!armed) return;
      armed = false;
      if (moved) {
        bar.classList.remove('bar-dragging');
        document.body.classList.remove('bar-dragging');
        bar.style.transition = '';
        save();
      } else {
        toggleOrientation(); // a click (no drag) rotates the bar
      }
    }
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);
    grip.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleOrientation(); }
    });

    // Restore a saved layout, else apply the default.
    var saved = null;
    if (persist) {
      try { saved = JSON.parse(localStorage.getItem(key)); } catch (_) {}
    } else {
      try { localStorage.removeItem(key); } catch (_) {} // drop stale layouts
    }
    if (saved && isNum(saved.left) && isNum(saved.top)) {
      if (saved.vertical) bar.classList.add('vertical');
      bar.style.left = saved.left + 'px';
      bar.style.top = saved.top + 'px';
      bar.style.right = 'auto';
      bar.style.bottom = 'auto';
      bar.style.transform = 'none';
      requestAnimationFrame(clampInto);
    } else if (applyDefault) {
      applyDefault(bar);
    }
    window.addEventListener('resize', clampInto, { passive: true });
  }

  function mount() {
    // Top bar: stays a centered horizontal pill by default (no forced position).
    setupBar(document.getElementById('topBar'), 'fm.bar.v2.topBar', null, true);
    // Tool bar: boots as a HORIZONTAL island centered under the 2D canvas grid
    // (CSS #ActionBar default — bottom-center of the 2D pane). Draggable within a
    // session but never persisted, and never the old left vertical rail.
    setupBar(document.getElementById('ActionBar'), 'fm.bar.v2.actionBar', function (bar) {
      bar.classList.remove('vertical');
    }, false);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
