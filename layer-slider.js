/*
 * layer-slider.js — custom vertical layer slider.
 *
 * Replaces the fragile rotated native <input type=range>. It is a DROP-IN: it
 * exposes `.value` (1-based string, like the native input), `.max`, and
 * `.lockedLayerIndex`, and fires a bubbling `input` event on user change — so all
 * existing wiring in init.js / utils.js keeps working unchanged.
 *
 * Everything (print-progress fill, authored-layer ticks, thumb) is rendered as a
 * PERCENTAGE inside the track, so it reflows on resize automatically — no more
 * position:fixed satellites recomputed against getBoundingClientRect().
 *
 * Anatomy: .ls (role=slider) > [.ls-track > [.ls-fill, .ls-hoverline, .ls-thumb>.ls-readout], svg.ls-ticks]
 * Bottom = layer 1, top = top layer (matches build direction).
 */
export function upgradeLayerSlider(el) {
    if (!el || el._lsUpgraded) return el;
    el._lsUpgraded = true;

    el.classList.add('ls');
    el.setAttribute('role', 'slider');
    el.setAttribute('tabindex', '0');
    el.setAttribute('aria-orientation', 'vertical');
    el.setAttribute('aria-label', 'Layer selector');
    el.innerHTML =
        '<div class="ls-track">' +
        '<div class="ls-fill"></div>' +
        '<div class="ls-hoverline"></div>' +
        '<div class="ls-thumb"><span class="ls-readout"><b class="ls-cur"></b><i class="ls-tot"></i></span></div>' +
        '<svg class="ls-ticks" aria-hidden="true" preserveAspectRatio="none" viewBox="0 0 10 1000"></svg>' + '</div>';

    const track   = el.querySelector('.ls-track');
    const fill    = el.querySelector('.ls-fill');
    const ticksEl = el.querySelector('.ls-ticks');
    const hover   = el.querySelector('.ls-hoverline');
    const thumb   = el.querySelector('.ls-thumb');
    const readout = el.querySelector('.ls-readout');
    const curEl   = el.querySelector('.ls-cur');
    const totEl   = el.querySelector('.ls-tot');

    const stepUp = document.getElementById('layerStepUp');
    const stepDown = document.getElementById('layerStepDown');

    let _value = 1, _max = 1, _locked = -1, _authored = [];

    const minValue = () => (_locked >= 0 ? _locked + 2 : 1);
    const clampVal = (v) => Math.max(minValue(), Math.min(_max, Math.round(v) || 1));

    function render() {
        const denom = Math.max(1, _max - 1);
        thumb.style.bottom = (((_value - 1) / denom) * 100) + '%';
        fill.style.height = ((_locked >= 0 ? (_locked + 1) / _max : 0) * 100) + '%';
        // current layer emphasized, total muted (textContent — numbers, XSS-safe)
        curEl.textContent = String(_value);
        totEl.textContent = ' / ' + _max;
        el.setAttribute('aria-valuemin', String(minValue()));
        el.setAttribute('aria-valuemax', String(_max));
        el.setAttribute('aria-valuenow', String(_value));
        if (stepUp) stepUp.disabled = _value >= _max;
        if (stepDown) stepDown.disabled = _value <= minValue();
    }

    function renderTicks() {
        const denom = Math.max(1, _max - 1);
        // Draw marks on the track, above the thumb so authored layers remain visible.
        // Non-scaling strokes stay legible on short tablet layouts and at either endpoint.
        ticksEl.innerHTML = _authored.map(i0 => {
            const y = 1000 - (i0 / denom) * 1000;   // bottom-up
            return '<line x1="1" x2="9" y1="' + y + '" y2="' + y + '" vector-effect="non-scaling-stroke"></line>';
        }).join('');
    }

    // ---- drop-in properties (mimic the native input the rest of the app expects) ----
    Object.defineProperty(el, 'value', {
        configurable: true,
        get() { return String(_value); },
        set(v) { _value = clampVal(parseFloat(v)); render(); },
    });
    Object.defineProperty(el, 'max', {
        configurable: true,
        get() { return String(_max); },
        set(v) { _max = Math.max(1, parseInt(v, 10) || 1); if (_value > _max) _value = _max; render(); renderTicks(); },
    });
    Object.defineProperty(el, 'lockedLayerIndex', {
        configurable: true,
        get() { return _locked; },
        set(v) { _locked = (typeof v === 'number') ? v : -1; if (_value < minValue()) _value = minValue(); render(); },
    });
    // authored-layer indices (0-based) → tick marks
    el.setAuthored = function (indices) { _authored = Array.isArray(indices) ? indices : []; renderTicks(); };

    function commit(v) {
        const nv = clampVal(v);
        _value = nv;
        render();
        // NOTE: use CustomEvent, not `new Event(...)` — Paper.js's global install clobbers
        // window.Event, so `new Event('input')` would not be a real DOM event here.
        el.dispatchEvent(new CustomEvent('input', { bubbles: true })); // → init.js sets selected layer
    }

    stepUp?.addEventListener('click', () => commit(_value + 1));
    stepDown?.addEventListener('click', () => commit(_value - 1));

    // ---- pointer → value (single mapping for drag + click); Alt disables snap ----
    const SNAP_PX = 7;
    function pointerToValue(clientY, snap) {
        const r = track.getBoundingClientRect();
        let frac = 1 - (clientY - r.top) / r.height;
        frac = Math.max(0, Math.min(1, frac));
        let v = Math.round(frac * Math.max(1, _max - 1)) + 1;
        if (snap && _authored.length) {
            const pxPer = r.height / Math.max(1, _max - 1);
            let best = null, bestD = SNAP_PX + 1;
            for (const i0 of _authored) {
                const av = i0 + 1;
                const d = Math.abs(av - v) * pxPer;
                if (d <= SNAP_PX && d < bestD) { bestD = d; best = av; }
            }
            if (best != null) v = best;
        }
        return clampVal(v);
    }

    let dragging = false;
    el.addEventListener('pointerdown', (e) => {
        dragging = true;
        el.classList.add('dragging');
        el.focus();
        try { track.setPointerCapture(e.pointerId); } catch (_) {}
        commit(pointerToValue(e.clientY, !e.altKey));
        e.preventDefault();
    });
    el.addEventListener('pointermove', (e) => {
        if (dragging) {
            commit(pointerToValue(e.clientY, !e.altKey));
        } else {
            const r = track.getBoundingClientRect();
            hover.style.bottom = (Math.max(0, Math.min(1, 1 - (e.clientY - r.top) / r.height)) * 100) + '%';
        }
    });
    const endDrag = () => { if (dragging) { dragging = false; el.classList.remove('dragging'); } };
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);

    // wheel = ±1 layer (slicer convention)
    el.addEventListener('wheel', (e) => { e.preventDefault(); commit(_value + (e.deltaY < 0 ? 1 : -1)); }, { passive: false });

    // arrow keys = ±1 (PageUp/PageDown/Home/End are handled in init.js)
    el.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { commit(_value + 1); e.preventDefault(); }
        else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { commit(_value - 1); e.preventDefault(); }
    });

    render();
    renderTicks();
    return el;
}

window.upgradeLayerSlider = upgradeLayerSlider;
