// CPU benchmark with the vendored Three.js and a deterministic curved layer.
// Run: node --experimental-vm-modules test/benchmark-rendering.cjs [old-threeD-model.js]
const { loadRenderer, makeLayer } = require('./rendering-harness.cjs');

(async () => {
    const { api, frames, LayerItem } = await loadRenderer(process.argv[2]);
    const { item, path } = makeLayer(0, LayerItem);
    const times = [];
    for (let i = 0; i < 13; i++) {
        const start = performance.now();
        api.testHooks.createSingle3DLayer(path, [item], 0);
        const elapsed = performance.now() - start;
        if (i >= 3) times.push(elapsed);
        frames.splice(0).forEach(fn => fn(performance.now() + 1000));
    }
    times.sort((a, b) => a - b);
    console.log(JSON.stringify({
        medianBuildMs: +times[Math.floor(times.length / 2)].toFixed(2),
        maxBuildMs: +Math.max(...times).toFixed(2),
        vertices: item.mesh.geometry.attributes.position.count,
        geometryBytes: Object.values(item.mesh.geometry.attributes).reduce((sum, a) => sum + a.array.byteLength, 0),
        samples: times.length,
    }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
