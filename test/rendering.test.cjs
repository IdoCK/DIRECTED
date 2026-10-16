// No browser, npm install, or printer needed; uses the repository's real Three.js.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { loadRenderer, makeLayer, THREE } = require('./rendering-harness.cjs');

function drain(frames) {
    for (let i = 0; frames.length && i < 100; i++) {
        frames.splice(0).forEach(fn => fn(performance.now() + 1000));
    }
    assert.equal(frames.length, 0, 'work queue must settle');
}

test('heatmap mapping matches exhaustive search, including ties and repeated positions', async () => {
    const { api, heatmap } = await loadRenderer();
    let seed = 11;
    const random = () => ((seed = (1664525 * seed + 1013904223) >>> 0) / 2 ** 32);
    const shapes = [
        [{ x: -1, y: 0 }, { x: 1, y: 0 }, { x: -1, y: 0 }],
        Array.from({ length: 302 }, (_, i) => ({ x: 50 * Math.sin(i / 15), y: 50 * Math.sin(i / 30) })),
        Array.from({ length: 302 }, () => ({ x: random() * 100, y: random() * 100 })),
    ];
    for (const points of shapes) {
        const positions = [0, 0, 0, -1, 0, 1, 0, 0, 2];
        for (let i = 0; i < 1200; i++) positions.push(random() * 160 - 60, random() * 160 - 60, 0);
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        const sound = Float32Array.from({ length: 120 }, (_, i) => i / 119);
        api.testHooks.applyVertexSoundness(geometry, points, { _soundness: sound });
        const pos = geometry.attributes.position;
        const expectedT = new Float32Array(pos.count);
        const expectedColors = new Float32Array(pos.count * 3);
        for (let v = 0; v < pos.count; v++) {
            let best = 0, bestD = Infinity;
            for (let k = 0; k < points.length; k++) {
                const dx = pos.getX(v) - points[k].x, dy = pos.getY(v) - points[k].y;
                const d = dx * dx + dy * dy;
                if (d < bestD) { best = k; bestD = d; }
            }
            const t = best / (points.length - 1);
            expectedT[v] = t;
            const c = heatmap.soundnessToRGB(heatmap.soundnessAt(sound, t));
            expectedColors.set([c.r, c.g, c.b], v * 3);
        }
        assert.deepEqual(geometry.userData.vertexT, expectedT);
        assert.deepEqual(geometry.attributes.color.array, expectedColors);
    }
});

test('initialization starts exactly one render loop', async () => {
    const { api, context, frames } = await loadRenderer();
    let renders = 0;
    context.THREE.WebGLRenderer = class {
        constructor({ canvas }) { this.domElement = canvas; this.shadowMap = {}; }
        setPixelRatio() {} setSize() {}
        render() { renders++; }
    };
    context.THREE.PMREMGenerator = class {
        fromScene() { return { texture: new THREE.Texture() }; }
        dispose() {}
    };
    context.THREE.OrbitControls = class {
        constructor() { this.target = new THREE.Vector3(); }
        update() {} addEventListener() {}
    };
    context.paper = { Point: class { constructor(x, y) { this.x = x; this.y = y; } } };
    context.document.getElementById = id => id === 'SimulationPerspectiveCube'
        ? null : { addEventListener() {} };
    api.initializeSimulationView({ clientWidth: 800, clientHeight: 600 }, []);
    assert.equal(renders, 1);
    assert.equal(frames.length, 1);
    frames.shift()();
    assert.equal(renders, 2);
    assert.equal(frames.length, 1);
});

test('rapid edits build only the latest attached path, without requiring a skirt', async () => {
    const { api, frames, LayerItem, scene } = await loadRenderer();
    const { item, path, paperLayer } = makeLayer(0, LayerItem);
    const layers = [item];
    let staleSamples = 0;
    const oldGetPoint = path.getPointAt;
    path.getPointAt = function (offset) { staleSamples++; return oldGetPoint.call(this, offset); };
    api.create3DLayer(path, layers, 0);
    const latest = { ...path, getPointAt: oldGetPoint };
    paperLayer.firstChild = latest; paperLayer.children = [latest]; path.parent = null;
    for (let i = 0; i < 20; i++) api.create3DLayer(latest, layers, 0);
    drain(frames);
    assert.equal(staleSamples, 0);
    assert.equal(scene.children.length, 1);
    assert.ok(item.mesh.geometry.attributes.position.count > 0);
});

test('queued work cannot resurrect reset or removed layers', async () => {
    const { api, frames, LayerItem, scene } = await loadRenderer();
    const a = makeLayer(0, LayerItem), b = makeLayer(1, LayerItem);
    const layers = [a.item, b.item];
    api.create3DLayer(a.path, layers, 0);
    api.create3DLayer(b.path, layers, 1);
    a.item.layer = null;
    layers.pop();
    drain(frames);
    assert.equal(scene.children.length, 0);
});

test('clearing a pending heatmap refresh leaves the scheduler usable', async () => {
    const { api, frames, LayerItem } = await loadRenderer();
    const { item, path } = makeLayer(0, LayerItem);
    api.queueHeatmapRefresh([item]);
    api.queueHeatmapRefresh([]);
    drain(frames);
    api.create3DLayer(path, [item], 0);
    drain(frames);
    assert.ok(item.mesh);
});

test('replacement disposes old geometry once and does not replay entrance after a clear', async () => {
    const { api, frames, LayerItem, scene } = await loadRenderer();
    const { item, path } = makeLayer(0, LayerItem);
    const layers = [item];
    api.create3DLayer(path, layers, 0); drain(frames);
    let disposed = 0;
    item.mesh.geometry.addEventListener('dispose', () => disposed++);
    api.create3DLayer(path, layers, 0); drain(frames);
    assert.equal(disposed, 1);
    assert.equal(scene.children.length, 1);
    assert.equal(item.mesh.scale.x, 1);
    assert.equal(item.mesh.material.transparent, false);
    item.remove3DLayer();
    api.create3DLayer(path, layers, 0);
    frames.shift()(performance.now());
    assert.equal(item.mesh.scale.x, 1);
    assert.equal(item.mesh.material.transparent, false);
    assert.equal(frames.length, 0);
});

test('heatmap refresh uses final geometry and recolors layers outside the rebuilt range', async () => {
    const { api, frames, LayerItem, heatmap } = await loadRenderer();
    const entries = [makeLayer(0, LayerItem), makeLayer(1, LayerItem)];
    const layers = entries.map(e => e.item);
    entries.forEach((e, i) => api.create3DLayer(e.path, layers, i));
    drain(frames);
    layers.forEach(item => item._soundness.fill(0));
    // Refresh requested before the new build must still run after it.
    api.queueHeatmapRefresh(layers);
    api.queueHeatmapRefresh(layers);
    api.create3DLayer(entries[0].path, layers, 0);
    drain(frames);
    const c = heatmap.soundnessToRGB(0);
    const expected = new Float32Array([c.r, c.g, c.b]);
    for (const item of layers) assert.deepEqual(item.mesh.geometry.attributes.color.array.slice(0, 3), expected);
});

test('printed layers stay on the shared printed material and removed skirts are disposed', async () => {
    const { api, frames, LayerItem } = await loadRenderer();
    const main = makeLayer(0, LayerItem), skirt = makeLayer(-2, LayerItem);
    const layers = [main.item];
    main.item.setPrinted(true);
    api.create3DLayer(main.path, layers, 0, skirt.item); drain(frames);
    const printed = main.item.mesh.material;
    let disposed = 0;
    skirt.item.mesh.geometry.addEventListener('dispose', () => disposed++);
    api.create3DLayer(main.path, layers, 0, skirt.item); drain(frames);
    assert.equal(disposed, 1);
    assert.equal(main.item.mesh.material, printed);
    assert.equal(printed.color.getHex(), 0xA9B0B7);
});
