(() => {
    const defaults = { inverseBars: true, radius: 6, buttonRadius: 6, gridSize: 84, opacity: 88,
        bar: '#882d17', light: '#f8f1e8', canvas: '#faf8f6', stage: '#f4ece2', accent: '#cf4928', surface: '#f8f1e8', ink: '#7a2812', side: 'left' };
    let saved = {}, legacy = {};
    try { saved = JSON.parse(localStorage.getItem('directedAppearance') || '{}'); legacy = JSON.parse(localStorage.getItem('userPreferences') || '{}'); } catch (_) {}
    let state = { ...defaults, inverseBars: legacy.inverseBars ?? true, radius: legacy.notchRadius ?? 6, ...saved };
    // Apply the agreed 6px baseline once; retain subsequent appearance experiments.
    if (saved.radiusVersion !== 1) {
        state.radius = 6; state.buttonRadius = 6; state.radiusVersion = 1;
        try { localStorage.setItem('directedAppearance', JSON.stringify(state)); } catch (_) {}
    }
    const host = document.createElement('aside');
    host.id = 'appearanceTool';
    host.setAttribute('aria-label', 'Appearance testing tool');
    host.innerHTML = `<button id="appearanceLauncher" type="button" aria-expanded="false" aria-controls="appearancePanel">Appearance</button>
      <section id="appearancePanel" aria-label="Appearance" hidden>
        <header><strong>Appearance</strong><button type="button" id="appearanceClose" aria-label="Close appearance tool">×</button></header>
        <p>Live preview · saved on this device</p>
        <label class="appearance-row">Inverse Bars <input id="appearanceInverse" type="checkbox" role="switch"></label>
        <div id="appearanceRanges"></div><div id="appearanceColors"></div>
        <label class="appearance-row">Tool position <select id="appearanceSide"><option value="left">Left</option><option value="right">Right</option></select></label>
        <footer><button type="button" id="appearanceReset">Reset appearance</button><span id="appearanceStatus" role="status"></span></footer>
      </section>`;
    // Floating appearance controls for live layout and palette testing.
    // document.body.appendChild(host); // Appearance UI hidden; settings/code retained.
    const ranges = [['gridSize','Grid size',50,98,'%'],['radius','Notch radius',0,32,'px'],['buttonRadius','Button radius',0,16,'px'],['opacity','Tool opacity',60,100,'%']];
    host.querySelector('#appearanceRanges').innerHTML = ranges.map(([key,label,min,max,unit]) => `<label class="appearance-range" for="appearance-${key}"><span>${label}</span><output id="appearance-${key}-value"></output><input id="appearance-${key}" data-key="${key}" type="range" min="${min}" max="${max}" step="1" aria-label="${label}"></label>`).join('');
    host.querySelector('#appearanceColors').innerHTML = [['bar','Dark bars / ink'],['light','Light bars / icons'],['canvas','2D panel / log'],['stage','3D background'],['accent','Accent'],['surface','Menus / dialogs'],['ink','Interface text']].map(([key,label]) => `<label class="appearance-row">${label}<input type="color" data-key="${key}" id="appearance-${key}" aria-label="${label}"></label>`).join('');
    const root = document.documentElement;
    const panel = host.querySelector('#appearancePanel');
    const launcher = host.querySelector('#appearanceLauncher');
    function apply() {
        for (const [key,,min,max] of ranges) state[key] = Number.isFinite(Number(state[key])) ? Math.min(max,Math.max(min,Number(state[key]))) : defaults[key];
        for (const key of ['bar','light','canvas','stage','accent','surface','ink']) if (!/^#[0-9a-f]{6}$/i.test(state[key])) state[key] = defaults[key];
        document.body.classList.toggle('inverse-bars', state.inverseBars === true);
        const tokens = {'--notch-radius':state.radius+'px','--appearance-button-radius':state.buttonRadius+'px','--appearance-bar':state.bar,'--appearance-light':state.light,'--surface-canvas':state.canvas,'--paper-2':state.stage,'--terracotta':state.accent,'--accent':state.accent,'--appearance-opacity':state.opacity/100,'--paper':state.surface,'--fm-glass':state.surface+'c7','--fm-glass-strong':state.surface+'eb','--ink':state.ink,'--ink-72':state.ink+'b8','--ink-55':state.ink+'8c'};
        for (const [key,value] of Object.entries(tokens)) root.style.setProperty(key,value);
        const gridFill = String(state.gridSize / 100);
        if (root.style.getPropertyValue('--grid-fill') !== gridFill) {
            root.style.setProperty('--grid-fill', gridFill);
            document.dispatchEvent(new CustomEvent('gridSizeChanged'));
        }
        host.dataset.side = state.side === 'right' ? 'right' : 'left';
        host.querySelector('#appearanceInverse').checked = state.inverseBars === true;
        host.querySelector('#appearanceSide').value = host.dataset.side;
        for (const [key,,, ,unit] of ranges) { host.querySelector('#appearance-'+key).value = state[key]; host.querySelector('#appearance-'+key+'-value').textContent = state[key]+unit; }
        for (const key of ['bar','light','canvas','stage','accent','surface','ink']) host.querySelector('#appearance-'+key).value = state[key];
    }
    function save() { try { localStorage.setItem('directedAppearance',JSON.stringify(state)); host.querySelector('#appearanceStatus').textContent='Saved'; } catch (_) { host.querySelector('#appearanceStatus').textContent='Preview only'; } }
    function show(open) { panel.hidden=!open; launcher.setAttribute('aria-expanded',String(open)); if(open) host.querySelector('#appearanceClose').focus(); else launcher.focus(); }
    launcher.addEventListener('click',()=>show(panel.hidden));
    host.querySelector('#appearanceClose').addEventListener('click',()=>show(false));
    host.addEventListener('keydown', e=>{ e.stopPropagation(); if(e.key==='Escape') { e.preventDefault(); show(false); } });
    host.addEventListener('input', e=>{ const key=e.target.dataset.key; if(!key)return; state[key]=e.target.type==='range'?Number(e.target.value):e.target.value; apply(); });
    host.addEventListener('change', e=>{ if(e.target.id==='appearanceInverse')state.inverseBars=e.target.checked; if(e.target.id==='appearanceSide')state.side=e.target.value; apply(); save(); });
    host.querySelector('#appearanceReset').addEventListener('click',()=>{state={...defaults};apply();save();});
    apply();
})();
