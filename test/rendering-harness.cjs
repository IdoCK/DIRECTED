const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const THREE = require('../lib/three.min.js');
const root = path.resolve(__dirname, '..');

async function loadRenderer(sourceFile) {
    const frames = [];
    const events = new Map();
    const context = vm.createContext({
        THREE: { ...THREE }, console, performance, Float32Array,
        window: { innerWidth: 1200, scaleFactor: 0.5, layers: [] },
        document: { addEventListener: (name, fn) => events.set(name, fn) },
        requestAnimationFrame: fn => { frames.push(fn); return frames.length; },
        setTimeout: fn => { frames.push(fn); },
    });
    const modules = new Map();
    async function load(filename) {
        if (modules.has(filename)) return modules.get(filename);
        let source = fs.readFileSync(filename === path.join(root, 'threeD-model.js') && sourceFile ? sourceFile : filename, 'utf8');
        if (filename === path.join(root, 'threeD-model.js')) source += `
            export const testHooks = {
                applyVertexSoundness, createSingle3DLayer, _animate3DView,
                initializeScene() { scene = new THREE.Scene(); return scene; },
                setRenderObjects(r, c) { renderer = r; controls = c; },
            };`;
        const module = new vm.SourceTextModule(source, { context, identifier: filename });
        modules.set(filename, module);
        await module.link(specifier => load(path.resolve(path.dirname(filename), specifier)));
        return module;
    }
    const module = await load(path.join(root, 'threeD-model.js'));
    await module.evaluate();
    const layerModule = await load(path.join(root, 'layer-item.js'));
    await layerModule.evaluate();
    const scene = module.namespace.testHooks.initializeScene();
    return {
        api: module.namespace, context, frames, events, scene, THREE,
        heatmap: modules.get(path.join(root, 'heatmap.js')).namespace,
        LayerItem: layerModule.namespace.LayerItem,
    };
}

function makeLayer(index = 0, LayerItem) {
    const path = {
        length: 600,
        getPointAt(offset) {
            const t = offset / this.length * Math.PI * 2;
            const r = 70 + 8 * Math.cos(3 * t);
            return { x: 150 + r * Math.cos(t), y: 150 + r * Math.sin(t) };
        },
    };
    const paperLayer = { firstChild: path, children: [path] };
    path.parent = paperLayer;
    const item = new LayerItem(index);
    item.layer = paperLayer;
    item._soundness = Float32Array.from({ length: 120 }, (_, i) => i / 119);
    return { item, path, paperLayer };
}

module.exports = { loadRenderer, makeLayer, THREE };
