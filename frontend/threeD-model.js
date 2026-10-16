import * as CONSTS from './consts.js';
import { createNearestCurvePoint } from './nearest-curve-point.js';
import { isHeatmapEnabled, soundnessToRGB, soundnessAt, ensureStackSoundness } from './heatmap.js';

// Declare Three.js variables globally
let scene, camera, renderer, controls, plane;

// Shared materials for performance optimization
let sharedMaterials = {
    nonPrinted: null,
    printed: null,
    heatmap: null   // structural-soundness heatmap (vertex colors); shared across all beads
};

// Pick the base material a layer mesh should currently wear. PRINTED wins over the
// heatmap: a printed layer is a fact on the bed (rendered as a disabled grey), while
// the heatmap is a prediction for clay that has yet to be printed. Otherwise the
// heatmap material (vertex colors carry the per-point soundness) or the normal clay.
function baseMaterialFor(layerItem) {
    const pending = paletteQueue.get(layerItem);
    if (pending && !isHeatmapEnabled() && !(layerItem.isPrinted && layerItem.isPrinted())) return pending.material;
    if (layerItem && layerItem.isPrinted && layerItem.isPrinted() && sharedMaterials.printed) {
        return sharedMaterials.printed;
    }
    if (isHeatmapEnabled() && sharedMaterials.heatmap) return sharedMaterials.heatmap;
    return (layerItem && layerItem.isPrinted && layerItem.isPrinted())
        ? sharedMaterials.printed : sharedMaterials.nonPrinted;
}

// Printed = disabled. One shared flat, matte grey material (color comes from the scheme's
// printedColor, which is the scheme-independent disabled grey in consts.js). Centralised so
// the mesh-build path and the lock-on-print path can't drift apart.
function ensurePrintedMaterial() {
    if (!sharedMaterials.printed) {
        sharedMaterials.printed = new THREE.MeshStandardMaterial({
            color: CONSTS.CURRENT_COLOR_SCHEME.printedColor,
            roughness: 0.92,        // flatter than live clay — reads as inert/disabled
            metalness: 0.0,
            envMapIntensity: 0.35   // dampened sheen: no lively IBL highlights on dead layers
        });
    } else {
        sharedMaterials.printed.color.setHex(CONSTS.CURRENT_COLOR_SCHEME.printedColor);
    }
    return sharedMaterials.printed;
}

// Write a per-vertex color buffer onto the layer geometry from its cached soundness field.
// Each vertex is mapped to its nearest sample on the source curve → normalized arc-length
// t → soundness → ramp color. (Sound ⇒ the normal clay color, so an untouched bead looks
// unchanged; risk diverges to amber/red.) Must run while geometry is still in extrude space
// (before applyMatrix4), so vertex (x,y) matches the smoothed curve points.
function applyVertexSoundness(geometry, smoothedPoints, layerItem) {
    const pos = geometry.attributes.position;
    if (!pos) return;
    const count = pos.count;
    const sp = smoothedPoints;
    const spLen = sp.length;
    const sound = layerItem && layerItem._soundness;
    const colors = new Float32Array(count * 3);
    // Cache each vertex's normalized arc-length t: the geometry never changes shape after
    // build, but its SOUNDNESS does whenever ANY layer below is edited — the cached t lets
    // refreshHeatmapColors() recolor this mesh later without redoing the nearest-point scan.
    const vertexT = new Float32Array(count);

    const nearest = createNearestCurvePoint(sp);
    const sampleColors = sp.map((_, k) => soundnessToRGB(
        sound ? soundnessAt(sound, spLen > 1 ? k / (spLen - 1) : 0) : 1
    ));
    // ExtrudeGeometry is non-indexed: triangles repeat the same positions.
    // Reuse exact XY queries (Z is intentionally irrelevant to this mapping).
    const nearestByXY = new Map();

    for (let v = 0; v < count; v++) {
        const vx = pos.getX(v), vy = pos.getY(v);
        let column = nearestByXY.get(vx);
        if (!column) { column = new Map(); nearestByXY.set(vx, column); }
        let best = column.get(vy);
        if (best === undefined) {
            best = nearest(vx, vy);
            column.set(vy, best);
        }
        const t = spLen > 1 ? best / (spLen - 1) : 0;
        vertexT[v] = t;
        const c = sampleColors[best];
        colors[v * 3] = c.r; colors[v * 3 + 1] = c.g; colors[v * 3 + 2] = c.b;
    }
    geometry.userData.vertexT = vertexT;
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

// Rewrite the vertex-color buffer of EVERY existing layer mesh from the current soundness
// field. Editing one layer changes the risk of layers far ABOVE it (support + inherited
// cantilever reach), but only the layers between the surrounding authored anchors get their
// meshes rebuilt — without this pass, everything above the next anchor keeps stale colors
// (the "visible overhang with no indication" bug). Cheap: O(vertices) per mesh via the
// cached per-vertex t, no geometry rebuild.
function refreshHeatmapColorsNow(layers) {
    if (!layers) return;
    layers.forEach(item => {
        if (!item) return;
        const mesh = item._mesh;
        if (!mesh || !mesh.geometry) return;
        if (item.isPrinted && item.isPrinted()) return;   // printed = disabled grey, no field colors
        const vertexT = mesh.geometry.userData && mesh.geometry.userData.vertexT;
        const colorAttr = mesh.geometry.attributes && mesh.geometry.attributes.color;
        if (!vertexT || !colorAttr) return;
        const sound = item._soundness;
        const ramp = sound && sound.length
            ? Array.from(sound, soundnessToRGB) : [soundnessToRGB(1)];
        const arr = colorAttr.array;
        for (let v = 0; v < vertexT.length; v++) {
            const c = ramp[Math.round(vertexT[v] * (ramp.length - 1))];
            arr[v * 3] = c.r; arr[v * 3 + 1] = c.g; arr[v * 3 + 2] = c.b;
        }
        colorAttr.needsUpdate = true;
    });
}

// Queue the refresh BEHIND any pending mesh rebuilds, so it always
// runs against the final geometry set of the edit that scheduled it.
export function queueHeatmapRefresh(layers = window.layers) {
    if (!layers) return;
    // Refresh one mesh at a time, after builds, and replace obsolete refreshes.
    heatmapQueue.clear();
    layers.forEach(item => {
        if (!item) return;
        heatmapQueue.set(item, () => {
            if (!layers.includes(item) || paletteQueue.has(item)) return;
            ensureStackSoundness(layers);
            refreshHeatmapColorsNow([item]);
        });
    });
    processRenderQueue();
}

// Re-assign every layer mesh's material to match the current heatmap on/off state.
// (Vertex colors live on the geometry, so this is a cheap material swap, no recompute.)
export function applyHeatmapMaterials(layers) {
    if (!layers) return;
    layers.forEach(item => {
        const mesh = item && item.mesh;
        if (mesh) mesh.material = baseMaterialFor(item);
    });
}

// Keep only the latest requested build per layer. Work is bounded BETWEEN tasks;
// a single synchronous geometry build can still exceed the budget.
const renderQueue = new Map();
const heatmapQueue = new Map();
const paletteQueue = new Map();
const paletteMaterials = new Set();
let paletteStart = null;
const RENDER_WORK_BUDGET_MS = 6;
const renderedLayers = new WeakSet();
const meshOwners = new WeakMap();
let isProcessingQueue = false;

function processRenderQueue() {
    if (isProcessingQueue || (!renderQueue.size && !heatmapQueue.size && !paletteQueue.size)) return;
    isProcessingQueue = true;
    requestAnimationFrame((timestamp = performance.now()) => {
        const start = performance.now();
        if (paletteStart === null) paletteStart = timestamp;
        while (renderQueue.size || heatmapQueue.size || paletteQueue.size) {
            const nextPalette = paletteQueue.values().next().value;
            const paletteDue = nextPalette && timestamp - paletteStart >= nextPalette.delay;
            const queue = renderQueue.size ? renderQueue : paletteDue ? paletteQueue : heatmapQueue;
            if (!queue.size) break;
            const [key, task] = queue.entries().next().value;
            queue.delete(key);
            try {
                if (queue === paletteQueue) task.run();
                else task();
            } catch (error) {
                console.error('[3D QUEUE] Error processing render task:', error);
            }
            if (performance.now() - start >= RENDER_WORK_BUDGET_MS) break;
        }
        if (!paletteQueue.size) {
            paletteMaterials.forEach(material => material.dispose());
            paletteMaterials.clear();
        }
        isProcessingQueue = false;
        processRenderQueue();
    });
}

// Simplified direct 3D layer creation

// New: view-cube widget
let viewCubeScene, viewCubeCamera, viewCubeRenderer, viewCubeCube, viewCubeGroup, viewCubeFaces;

// The translation and rotation can be calculated from const expressions.
// The scale factor is determined dynamically from window size, and is calculated in drawGrid function
// therefore, we compute the translation and rotation matrix and apply the scale only on render
const trn = new THREE.Matrix4().makeTranslation(-CONSTS.BED_SIZE / 2, 0, -CONSTS.BED_SIZE / 2);
const rot = new THREE.Matrix4().makeRotationX(Math.PI / 2);
const base = trn.multiply(rot);
const scl = new THREE.Matrix4();


class CustomCurve extends THREE.Curve {
    constructor(points) {
        super();
        this.points = points;
    }

    getPoint(t) {
        const totalPoints = this.points.length - 1;
        const index = t * totalPoints;
        const lowerIndex = Math.floor(index);
        const upperIndex = Math.ceil(index);

        if (lowerIndex === upperIndex) {
            return this.points[lowerIndex];
        }

        // Interpolate between the two points
        const alpha = index - lowerIndex;
        const lowerPoint = this.points[lowerIndex];
        const upperPoint = this.points[upperIndex];

        return new THREE.Vector3(
            lowerPoint.x + (upperPoint.x - lowerPoint.x) * alpha,
            lowerPoint.y + (upperPoint.y - lowerPoint.y) * alpha,
            lowerPoint.z + (upperPoint.z - lowerPoint.z) * alpha
        );
    }
}

export function initializeSimulationView(canvas, layers) {
    if (!canvas) {
        console.error(`Canvas with ID ${canvas} not found.`);
        return;
    }

    // Create the Three.js scene
    scene = new THREE.Scene();

    // Set the scene background to a visible color
    // scene.background = CONSTS.BACKGROUND_COLOR;

    // Define the PerspectiveCamera parameters
    const fov = 20; // Field of view in degrees
    const aspect = canvas.clientWidth / canvas.clientHeight; // Aspect ratio
    const near = 0.1; // Near clipping plane
    const far = 10000; // Far clipping plane

    // Create the PerspectiveCamera
    camera = new THREE.PerspectiveCamera(fov, aspect, near, far);

    // Position the camera for an isometric-like view
    const isometricAngle = Math.atan(Math.sqrt(2)); // ~35.26 degrees
    const distance = 1000; // Distance from the center
    camera.position.set(
        distance * Math.cos(isometricAngle), // X
        distance * Math.sin(isometricAngle), // Y
        distance// Z
    );

    // Ensure the camera looks at the center of the scene
    camera.lookAt(new THREE.Vector3(0, 0, 0));

    // Create the renderer and associate it with the LeftBottomView canvas
    renderer = new THREE.WebGLRenderer({ canvas: canvas, alpha: true, antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)); // cap DPR: 2 is plenty with MSAA, protects 3x devices + frees perf headroom
    renderer.setSize(canvas.clientWidth, canvas.clientHeight, false); // false: keep the canvas CSS-driven (width/height:100%) so it fills its pane; resize3DView only updates the backing store
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0; // cream stage (focus mode): 1.4 over-brightened on light
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    // Image-based lighting (IBL): without scene.environment the PBR clay has zero
    // specular response and reads as flat matte plastic. The global three build has
    // PMREMGenerator (core) but not RoomEnvironment (jsm), so bake a soft warm-studio
    // gradient probe procedurally — gives the clay a believable surroundings-driven
    // sheen. Wrapped so a failure can never break the viewport.
    try {
        const pmrem = new THREE.PMREMGenerator(renderer);
        const envScene = new THREE.Scene();
        const skyGeo = new THREE.SphereGeometry(500, 32, 16);
        const skyMat = new THREE.ShaderMaterial({
            side: THREE.BackSide,
            uniforms: {
                topColor:    { value: new THREE.Color(0xfff3e6) }, // warm bright sky
                midColor:    { value: new THREE.Color(0xefe5d6) },
                bottomColor: { value: new THREE.Color(0xcabfae) }, // dim warm floor bounce
            },
            vertexShader: 'varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
            fragmentShader: 'varying vec3 vP; uniform vec3 topColor; uniform vec3 midColor; uniform vec3 bottomColor;' +
                'void main(){ float h = normalize(vP).y; vec3 c = h > 0.0 ? mix(midColor, topColor, h) : mix(midColor, bottomColor, -h); gl_FragColor = vec4(c, 1.0); }',
        });
        envScene.add(new THREE.Mesh(skyGeo, skyMat));
        scene.environment = pmrem.fromScene(envScene, 0.04).texture;
        skyGeo.dispose(); skyMat.dispose(); pmrem.dispose();
    } catch (e) {
        console.warn('[3D] IBL environment setup skipped:', e);
    }

    // Set the renderer background color
    // renderer.setClearColor(CONSTS.BACKGROUND_COLOR, 1); // Cornflower Blue background

    // Add lighting — three-point warm rig (P3)
    // Low ambient — warm white. Lowered for the cream stage so the key carves form
    // instead of flattening the model against a bright background.
    const ambientLight = new THREE.AmbientLight(0xfff5e8, 0.35);
    ambientLight.name = "Ambient Light";
    scene.add(ambientLight);

    // Warm key — upper-right, casts shadow
    const keyLight = new THREE.DirectionalLight(0xfff0d0, 2.2);
    keyLight.position.set(60, 80, 40);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.width = 2048;
    keyLight.shadow.mapSize.height = 2048;
    keyLight.shadow.camera.near = 0.5;
    keyLight.shadow.camera.far = 600;
    keyLight.shadow.camera.left = -CONSTS.BED_SIZE;
    keyLight.shadow.camera.right = CONSTS.BED_SIZE;
    keyLight.shadow.camera.top = CONSTS.BED_SIZE;
    keyLight.shadow.camera.bottom = -CONSTS.BED_SIZE;
    keyLight.shadow.bias = -0.0004;
    keyLight.shadow.normalBias = 0.5;   // prevents shadow acne / peter-panning on the rounded, self-shadowing beads
    keyLight.name = "Key Light";
    scene.add(keyLight);

    // Fill — opposite side. Warm/neutral (not cool blue) so the shadow side stays
    // warm against the cream paper instead of reading as a cold cast.
    const fillLight = new THREE.DirectionalLight(0xfff0e0, 0.6);
    fillLight.position.set(-40, 30, -20);
    fillLight.name = "Fill Light";
    scene.add(fillLight);

    // Back rim — the key legibility lever on cream: a bright edge highlight lifts the
    // silhouette off the light background.
    const rimLight = new THREE.DirectionalLight(0xfff8e8, 0.75);
    rimLight.position.set(0, 40, -80);
    rimLight.name = "Rim Light";
    scene.add(rimLight);

    const gridSize = CONSTS.BED_SIZE; // Match the Paper.js grid size
    const gridDivisions = 22; // Match the number of squares in Paper.js
    const gridHelper = new THREE.GridHelper(gridSize, gridDivisions, 0xbbae9c, 0xbbae9c); // warm grey grid, a hair darker so it reads on cream

    // Align the Three.js grid's center with the Paper.js grid's center
    const gridCenter = new paper.Point(CONSTS.BED_SIZE / 2, CONSTS.BED_SIZE / 2);
    gridHelper.position.set(gridCenter.x - CONSTS.BED_SIZE / 2, -(gridCenter.y - CONSTS.BED_SIZE / 2), 0);

    scene.add(gridHelper);

    // Contact shadow ground plane — grounds the model visually (P3)
    const groundGeo = new THREE.PlaneGeometry(CONSTS.BED_SIZE * 2, CONSTS.BED_SIZE * 2);
    const groundMat = new THREE.ShadowMaterial({ opacity: 0.35 }); // softer contact shadow — 0.55 read as a hole on cream
    const shadowPlane = new THREE.Mesh(groundGeo, groundMat);
    shadowPlane.rotation.x = -Math.PI / 2;
    shadowPlane.position.y = -0.1;  // just below grid to avoid Z-fight
    shadowPlane.receiveShadow = true;
    shadowPlane.name = "shadow-plane";
    scene.add(shadowPlane);

    // Add tick marks to the 3D grid
    addGridTickMarks(scene, gridSize, gridDivisions, gridCenter);

    // Add a red 'L' shape to signify the middle of the 3D grid and orientation
    // Update the red 'L' shape to have a more prominent stroke
    // Replace lines with cylinders for thicker 3D 'L' shape
    const redLGroup = new THREE.Group();
    const squareSize = gridSize / gridDivisions;
    const cylinderRadius = 0.5; // Radius for the cylinders

    // Vertical part of the 'L' (pointing upward)
    const verticalCylinderGeometry = new THREE.CylinderGeometry(cylinderRadius, cylinderRadius, squareSize, 16);
    const verticalCylinderMaterial = new THREE.MeshBasicMaterial({ color: 0xcf4928 }); // terracotta — was pure red 0xff0000, off-brand on the Slipware palette
    const verticalCylinder = new THREE.Mesh(verticalCylinderGeometry, verticalCylinderMaterial);
    verticalCylinder.rotation.x = Math.PI / 2; // Rotate to align vertically
    verticalCylinder.position.set(0, 0, -squareSize / 2);
    redLGroup.add(verticalCylinder);

    // Horizontal part of the 'L' (pointing rightward)
    const horizontalCylinderGeometry = new THREE.CylinderGeometry(cylinderRadius, cylinderRadius, squareSize, 16);
    const horizontalCylinderMaterial = new THREE.MeshBasicMaterial({ color: 0xcf4928 }); // terracotta — was pure red 0xff0000, off-brand on the Slipware palette
    const horizontalCylinder = new THREE.Mesh(horizontalCylinderGeometry, horizontalCylinderMaterial);
    horizontalCylinder.rotation.z = Math.PI / 2; // Rotate to align horizontally
    horizontalCylinder.position.set(squareSize / 2, 0, 0);
    redLGroup.add(horizontalCylinder);

    // Upward part of the 3D 'L' (pointing upward)
    const upwardCylinderGeometry = new THREE.CylinderGeometry(cylinderRadius, cylinderRadius, squareSize, 16);
    const upwardCylinderMaterial = new THREE.MeshBasicMaterial({ color: 0xcf4928 }); // terracotta — was pure red 0xff0000, off-brand on the Slipware palette
    const upwardCylinder = new THREE.Mesh(upwardCylinderGeometry, upwardCylinderMaterial);
    upwardCylinder.position.set(0, squareSize / 2, 0);
    redLGroup.add(upwardCylinder);

    // Position the L shape at the upper left edge of the grid
    redLGroup.position.set(-CONSTS.BED_SIZE / 2, 0, CONSTS.BED_SIZE / 2);
    scene.add(redLGroup);

    // Create the plane
    const planeGeometry = new THREE.PlaneGeometry(gridSize, gridSize);
    const planeMaterial = new THREE.MeshBasicMaterial({
        color: 0xECE0D1,   // warm paper tint (was dead grey 0xb8b8b8) so the slice belongs to the Slipware palette
        transparent: true,
        opacity: 0.18,     // reads as a glass slice rather than a grey card
        side: THREE.DoubleSide // Make the plane visible from both sides
    });
    plane = new THREE.Mesh(planeGeometry, planeMaterial);
    plane.rotation.x = -Math.PI / 2; // Rotate the plane to align with the grid
    plane.position.set(gridCenter.x - CONSTS.BED_SIZE / 2, -(gridCenter.y - CONSTS.BED_SIZE / 2), 0); // Start at the base layer
    scene.add(plane);

    // Initialize OrbitControls
    controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.minPolarAngle = 0; // Allow full rotation
    controls.maxPolarAngle = Math.PI; // Allow full rotation
    controls.enablePan = true; // Enable panning
    controls.enableZoom = true; // Enable zooming
    controls.enableRotate = true; // Allow rotation
    controls.enableDamping = true; // Smooth camera movement
    controls.dampingFactor = 0.05;
    controls.screenSpacePanning = true; // Enable screen space panning
    controls.target.set(0, 150, 0); // Constrol 
    controls.update(); // must call this after changing target



    // Initialize our corner “view cube”
    _initViewCube();

    // Start the render loop
    _animate3DView();

    // Add Homing button functionality with a house logo
    const homingButton = document.getElementById('homingButton');
    homingButton.addEventListener('click', () => {
        // Animate to home position instead of jumping
        _animateCameraToHome(distance, isometricAngle);
    });
    // Button lives in #viewControlsDock (inside #SimulationBox) - no reparenting.

    // Add Lock button functionality with a lock logo
    const lockButton = document.getElementById('lockButton');
    let isLocked = false; // Track lock state
    lockButton.addEventListener('click', () => {
        const fixedPolar = controls.getPolarAngle();
        isLocked = !isLocked; // Toggle lock state
        if (isLocked) {
            controls.enableZoom = false; // Disable zooming
            controls.minPolarAngle = fixedPolar;
            controls.maxPolarAngle = fixedPolar;
            lockButton.classList.add('locked');
            lockButton.classList.remove('unlocked');
        } else {
            controls.enableZoom = true; // Enable zooming
            controls.minPolarAngle = 0; // Allow full rotation
            controls.maxPolarAngle = Math.PI; // Allow full rotation
            lockButton.classList.add('unlocked');
            lockButton.classList.remove('locked');
        }
        controls.update(); // Update controls after changes
    });
    // Button lives in #viewControlsDock (inside #SimulationBox) - no reparenting.

    controls.addEventListener('change', () => {
        // Restrict panning to vertical motion only
        const targetPosition = controls.target;
        controls.target.set(0, targetPosition.y, 0);
    });
}

// Add tick marks to the 3D grid
function addGridTickMarks(scene, gridSize, gridDivisions, gridCenter) {
    const tickLength = 3; // Length of tick marks extending from grid edges
    const tickWidth = 1; // Width of tick lines
    const majorTickLength = tickLength * 1.5; // Longer ticks for major divisions
    const majorTickInterval = 5; // Every 5th division gets a major tick

    const tickMaterial = new THREE.LineBasicMaterial({
        color: 0x6b6460, // neutral grey — less harsh than dark on cream
        linewidth: tickWidth,
        opacity: 0.4 // Set opacity for better visibility
    });

    const squareSize = gridSize / gridDivisions;
    const halfGrid = gridSize / 2;

    // Create tick marks only on top and left edges of the grid (on the same plane, Y=0)
    for (let i = 0; i <= gridDivisions; i++) {
        const isMajor = i % majorTickInterval === 0;
        const currentTickLength = isMajor ? majorTickLength : tickLength;
        const offset = (i * squareSize) - halfGrid;

        // Top edge ticks (extending outward from grid in -Z direction)
        const topTickGeometry = new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(offset, 0, -halfGrid),
            new THREE.Vector3(offset, 0, -halfGrid - currentTickLength)
        ]);
        const topTick = new THREE.Line(topTickGeometry, tickMaterial);
        topTick.position.set(gridCenter.x - CONSTS.BED_SIZE / 2, -(gridCenter.y - CONSTS.BED_SIZE / 2), 0);
        scene.add(topTick);

        // Left edge ticks (extending outward from grid in -X direction)
        const leftTickGeometry = new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(-halfGrid, 0, offset),
            new THREE.Vector3(-halfGrid - currentTickLength, 0, offset)
        ]);
        const leftTick = new THREE.Line(leftTickGeometry, tickMaterial);
        leftTick.position.set(gridCenter.x - CONSTS.BED_SIZE / 2, -(gridCenter.y - CONSTS.BED_SIZE / 2), 0);
        scene.add(leftTick);

        // Add small markers for major ticks (also on the grid plane)
        if (isMajor) {
            // Add small spheres at major tick positions as visual markers
            const labelGeometry = new THREE.SphereGeometry(0.8, 8, 8);
            const labelMaterial = new THREE.MeshBasicMaterial({ color: 0x7a2812 }); // Slipware ink — pure black read as harsh dots on cream

            // Top labels (outside the grid)
            const topLabel = new THREE.Mesh(labelGeometry, labelMaterial);
            topLabel.position.set(
                offset + (gridCenter.x - CONSTS.BED_SIZE / 2),
                -(gridCenter.y - CONSTS.BED_SIZE / 2),
                -halfGrid - majorTickLength - 1
            );
            scene.add(topLabel);

            // Left labels (outside the grid)
            const leftLabel = new THREE.Mesh(labelGeometry, labelMaterial);
            leftLabel.position.set(
                -halfGrid - majorTickLength - 1 + (gridCenter.x - CONSTS.BED_SIZE / 2),
                -(gridCenter.y - CONSTS.BED_SIZE / 2),
                offset
            );
            scene.add(leftLabel);
        }
    }
}


export function create3DLayer(path, layers, layerIndex, skirtLayerItem) {
    const item = layers && layers[layerIndex];
    if (!item || !path) return;
    renderQueue.set(item, () => {
        // An edit/reset may have detached the path or replaced this layer while
        // its build was pending. Never resurrect that obsolete geometry.
        if (layers[layerIndex] !== item || !item.getLayer()
            || path.parent !== item.getLayer()) return;
        createSingle3DLayer(path, layers, layerIndex);
        // If this is layer 0, also check for and create skirt
        if (layerIndex === 0 && skirtLayerItem) {
            // Remove any existing skirt mesh by name
            const existingSkirtMesh = scene.getObjectByName('skirt-mesh');
            if (existingSkirtMesh) {
                remove3DLayer(existingSkirtMesh);
            }
            // Create skirt if it has layer data
            if (skirtLayerItem.getLayer() && skirtLayerItem.getLayer().firstChild) {
                createSingle3DLayer(skirtLayerItem.getLayer().firstChild, [skirtLayerItem], 0);
            }
        }
    });
    
    // Start processing queue if not already running
    processRenderQueue();
}

function createSingle3DLayer(path, layers, layerIndex) {
    // Use same scaling as the grid: convert mm to pixels using grid scale factor
    const layerHeight = CONSTS.LAYER_HEIGHT * (1 / window.scaleFactor); // 1mm * (gridPixels / bedMM)

    // Level of Detail: reduce quality for distant layers
    const cameraDistance = camera ? camera.position.distanceTo(new THREE.Vector3(0, 0, -layerIndex * layerHeight)) : 1000;
    const lodLevel = cameraDistance > 500 ? 0.5 : cameraDistance > 200 ? 0.75 : 1.0;

    // Optimized sampling for responsive rendering
    const pathLength = path ? path.length : 0;
    const pointsToSample = 300; // Increased for better quality

    // Sample points along the actual curve
    const points = [];
    if (pathLength > 0 && pointsToSample > 0 && path && typeof path.getPointAt === 'function') {
        const step = path.length / pointsToSample;
        for (let offset = 0; offset <= path.length; offset += step) {
            const point = path.getPointAt(offset);
            if (point) {
                // Convert to THREE.Vector3 and align with the 3D grid
                const vec = new THREE.Vector3(
                    point.x - (window.gridStartX || 0),
                    point.y - (window.gridStartY || 0),
                    -((layerIndex + 1) * layerHeight));
                points.push(vec)
            }
        }
    }

        // Close the curve by adding the first point at the end if path is closed or we want to force closure
        if (points.length > 2) {
            const firstPoint = points[0].clone();
            points.push(firstPoint);
        }
    


    // Only create 3D layer if we have valid points
    if (points.length > 1) {
        // Create the swept capsule along the curve with smoothing (non-animated for now)
        _createCapsuleAlongCurve(points, layerHeight / 2, layers[layerIndex], lodLevel, false);
    } else {
        console.warn(`! [3D CREATE] Insufficient points for layer ${layerIndex} - skipping 3D creation !`);
    }
}

function _animate3DView() {
    requestAnimationFrame(_animate3DView);

    // Update OrbitControls
    controls.update();

    // Render the scene
    renderer.render(scene, camera);

    // Render the little view-cube overlay
    _updateViewCube();
}

// Sequential layer appearance system
function startSequentialLayerAppearance() {
    if (isAnimating || animationQueue.length === 0) {
        console.log(`[3D SEQUENTIAL] Cannot start: isAnimating=${isAnimating}, queueLength=${animationQueue.length}`);
        return;
    }

    console.log(`[3D SEQUENTIAL] Starting sequential appearance with ${animationQueue.length} layers`);
    isAnimating = true;
    processNextSequentialLayer();
}

function processNextSequentialLayer() {
    if (animationQueue.length === 0) {
        console.log(`[3D SEQUENTIAL] Queue empty, stopping`);
        isAnimating = false;
        return;
    }

    const { path, layers, layerIndex } = animationQueue.shift();
    console.log(`[3D SEQUENTIAL] Creating layer ${layerIndex}, ${animationQueue.length} remaining`);

    // Create the complete layer immediately (no progressive building)
    createSingle3DLayer(path, layers, layerIndex);

    // Schedule next layer appearance
    setTimeout(() => {
        processNextSequentialLayer();
    }, CONSTS.ANIMATION_DURATION);
}

// Enhanced curve smoothing function with spline interpolation
function _smoothCurvePoints(points) {
    if (points.length < 3) return points;

    const smoothed = [];
    const smoothingFactor = 0.7; // Increased smoothing for better curves

    // First point stays the same
    smoothed.push(points[0].clone());

    // Smooth middle points
    for (let i = 1; i < points.length - 1; i++) {
        const prev = points[i - 1];
        const curr = points[i];
        const next = points[i + 1];

        // Apply smoothing using weighted average
        const smoothedPoint = new THREE.Vector3(
            curr.x + smoothingFactor * ((prev.x + next.x) / 2 - curr.x),
            curr.y + smoothingFactor * ((prev.y + next.y) / 2 - curr.y),
            curr.z + smoothingFactor * ((prev.z + next.z) / 2 - curr.z)
        );

        smoothed.push(smoothedPoint);
    }

    // Last point stays the same
    smoothed.push(points[points.length - 1].clone());

    return smoothed;
}

function _updateViewCube() {
    if (!viewCubeRenderer || !viewCubeGroup) return;

    // Copy the main camera's rotation to the entire view cube group
    const rotation = camera.quaternion.clone().invert();
    viewCubeGroup.quaternion.copy(rotation);

    viewCubeRenderer.render(viewCubeScene, viewCubeCamera);
}

function _createCapsuleContour(radius, lodLevel = 1.0) {
    const shape = new THREE.Shape();

    const halfLength = CONSTS.NOZZLE_DIAMETER; // Half the capsule's horizontal length (straight section)

    // Reduce arc segments based on LOD level
    const baseSegments = 28;   // was 16 — smoother bead so the rounded tube doesn't facet
    const segments = Math.max(Math.floor(baseSegments * lodLevel), 10); // floor 10 (was 4 → octagonal beads at distance)

    // Left dome: upper half-circle (from left to top)
    shape.absarc(0, halfLength, radius, Math.PI, 0, true);

    // Right dome: lower half-circle (from bottom to top)
    shape.absarc(0, -halfLength, radius, 0, -Math.PI, true);

    shape.closePath();
    return shape;
}

function _createCapsuleAlongCurve(points, radius, layerItem, lodLevel = 1.0, animated = false) {
    // Apply smoothing to points similar to 2D curves
    const smoothedPoints = _smoothCurvePoints(points);

    // Create the curve from the smoothed points
    const curve = new CustomCurve(smoothedPoints);

    // Create the capsule contour with LOD
    const capsuleContour = _createCapsuleContour(radius, lodLevel);

    // new1: keep a high extrude-step count (ceiling 600) so the swept bead follows the
    // curve smoothly without faceting. Scales with the sampled point count (=> with curve
    // length) and is still LOD-scaled below for distant layers.
    const baseSteps = Math.min(Math.max(smoothedPoints.length * 2, 150), 600);
    const adaptiveSteps = Math.floor(baseSteps * lodLevel);

    // Extrude the capsule contour along the curve
    const extrudeSettings = {
        steps: adaptiveSteps,
        bevelEnabled: false,
        extrudePath: curve
    };
    const geometry = new THREE.ExtrudeGeometry(capsuleContour, extrudeSettings);

    // Interpolation clears old meshes before queuing their replacements, so
    // track layer identity rather than relying on a mesh still being present.
    const isReplacement = renderedLayers.has(layerItem);

    // Use shared materials for better performance
    if (!sharedMaterials.nonPrinted) {
        sharedMaterials.nonPrinted = new THREE.MeshStandardMaterial({
            color: CONSTS.CURRENT_COLOR_SCHEME.nonPrintedColor,
            roughness: 0.6,        // was 0.87 (near-Lambertian) — let the IBL sheen read as semi-glossy clay
            metalness: 0.0,
            envMapIntensity: 0.9
        });
    }

    ensurePrintedMaterial();

    if (!sharedMaterials.heatmap) {
        // White base so per-vertex colors render as authored; vertexColors carries the field.
        sharedMaterials.heatmap = new THREE.MeshStandardMaterial({
            color: 0xffffff,
            vertexColors: true,
            roughness: 0.6,
            metalness: 0.0,
            envMapIntensity: 0.9
        });
    }

    // Structural-soundness vertex colors (computed from the cached stack field; the field is
    // refreshed once per edit by redrawLayers, but ensure it here in case a mesh rebuilds first).
    ensureStackSoundness(window.layers);
    applyVertexSoundness(geometry, smoothedPoints, layerItem);

    const material = baseMaterialFor(layerItem);

    // Create the mesh with the geometry and material
    const mesh = new THREE.Mesh(geometry, material);
    meshOwners.set(mesh, layerItem);

    // Transform to fit to grid
    scl.makeScale(window.scaleFactor, window.scaleFactor, window.scaleFactor);
    const mat = base.clone().multiply(scl)
    mesh.geometry.applyMatrix4(mat);

    // Add the capsule to the scene
    scene.add(mesh);
    // Trigger entrance animation (scale 0.92→1 + opacity 0→1, ~220ms ease-out)
    // Editing an existing layer should not shrink/fade it again.
    if (!isReplacement) animateLayerEntrance(mesh, CONSTS.ANIMATION_DURATION || 220, layerItem);
    mesh.castShadow = true;
    mesh.receiveShadow = true; // allow layers to catch shadows from layers above (WR-01)

    // Name the mesh if it's a skirt or bounds
    if (layerItem.name === 'Layer -1') {
        mesh.name = 'skirt-mesh';
    } else if (layerItem.name === 'Bounds') {
        mesh.name = 'bounds-mesh';
    } else {
        // Regular layer mesh
        mesh.name = `layer-${layerItem.name}`;
    }
    
    // Save the mesh reference in the LayerItem
    layerItem.mesh = mesh;
    renderedLayers.add(layerItem);
}

// Animate a new mesh rising into place: scale 0.92→1 + opacity 0→1, ~220ms ease-out.
// LANDMINE #1: the base materials are SHARED across all layer meshes and have no
// transparent:true. We clone a per-instance material for the entrance only, then swap
// back to the correct shared base (clay OR heatmap) when done so existing layers are
// never affected. Cloning the mesh's CURRENT material preserves vertexColors for heatmap.
function animateLayerEntrance(mesh, duration, layerItem) {
    if (duration === undefined) { duration = 220; }

    // Clone per-instance material for the entrance tween only (from whatever base it wears)
    const entryMat = (mesh.material || sharedMaterials.nonPrinted).clone();
    entryMat.transparent = true;
    entryMat.opacity = 0;
    mesh.material = entryMat;

    // Start at 92% scale
    mesh.scale.set(0.92, 0.92, 0.92);

    const startTime = performance.now();

    function frame(now) {
        // Pitfall 5: guard against deletion mid-tween
        if (!mesh.parent) {
            entryMat.dispose();
            return;
        }

        const elapsed = now - startTime;
        const rawT = Math.min(elapsed / duration, 1);
        // Ease-out cubic: 1 - Math.pow(1 - t, 3)
        const ease = 1 - Math.pow(1 - rawT, 3);

        entryMat.opacity = ease;
        const s = 0.92 + 0.08 * ease;
        mesh.scale.set(s, s, s);

        if (rawT < 1) {
            requestAnimationFrame(frame);
        } else {
            // Swap back to the correct shared base (clay or heatmap); dispose the clone
            mesh.material = baseMaterialFor(layerItem);
            entryMat.dispose();
        }
    }

    requestAnimationFrame(frame);
}

let overlayPlane = null;

export function updatePlaneTexture(canvas) {
    if (plane) {
        // Create texture from canvas
        const texture = new THREE.CanvasTexture(canvas);
        texture.needsUpdate = true;
        
        if (overlayPlane) {
            // Update existing overlay plane texture instead of recreating
            if (overlayPlane.material.map) {
                overlayPlane.material.map.dispose();
            }
            overlayPlane.material.map = texture;
            overlayPlane.material.needsUpdate = true;
        } else {
            // Create new overlay plane
            const overlayGeometry = new THREE.PlaneGeometry(CONSTS.BED_SIZE, CONSTS.BED_SIZE);
            const overlayMaterial = new THREE.MeshBasicMaterial({
                map: texture,
                transparent: true,
                depthWrite: false,
                side: THREE.DoubleSide
            });
            
            overlayPlane = new THREE.Mesh(overlayGeometry, overlayMaterial);
            
            // Position overlay plane slightly above the main plane
            overlayPlane.position.copy(plane.position);
            overlayPlane.position.y += 1; // 1 unit higher
            overlayPlane.rotation.copy(plane.rotation);
            
            scene.add(overlayPlane);
        }
    }
}

export function getOverlayPlane() {
    return overlayPlane;
}

export function clearPlaneTexture() {
    if (overlayPlane) {
        scene.remove(overlayPlane);
        if (overlayPlane.material.map) {
            overlayPlane.material.map.dispose();
        }
        overlayPlane.material.dispose();
        overlayPlane = null;
    }
}

export function remove3DLayer(mesh) {
    if (mesh && scene) {
        scene.remove(mesh);

        // Enhanced cleanup for shared materials
        if (mesh.geometry) {
            mesh.geometry.dispose();
        }

        // Only dispose material if it's not shared
        if (mesh.material && mesh.material !== sharedMaterials.nonPrinted
            && mesh.material !== sharedMaterials.printed && mesh.material !== sharedMaterials.heatmap
            && !paletteMaterials.has(mesh.material)) {
            mesh.material.dispose();
        }

        // Clear mesh references
        mesh.geometry = null;
        mesh.material = null;
    } else {
        console.warn("! [3D REMOVE] Mesh or scene is not defined - cannot remove 3D layer !");
    }
}

export function updateSlicingPlaneToLayer(layerIndex) {
    // Use same scaling as the grid: convert mm to pixels using grid scale factor
    const layerHeight = CONSTS.LAYER_HEIGHT * (1 / window.scaleFactor); // 1mm * (gridPixels / bedMM)
    if (plane) {
        const scaledHeight = (layerIndex + 1) * layerHeight * window.scaleFactor; // Apply scaling
        const transformedPosition = new THREE.Vector3(0, 0, -scaledHeight).applyMatrix4(base); // Apply transformations
        plane.position.set(
            transformedPosition.x + CONSTS.BED_SIZE / 2,
            transformedPosition.y,
            transformedPosition.z + CONSTS.BED_SIZE / 2
        ); // Update plane position
        
        // Update overlay plane position to match
        if (overlayPlane) {
            overlayPlane.position.copy(plane.position);
            overlayPlane.position.y += 1; // Keep it 1 unit above
        }
    }
}

// Reveal a new palette from the bed upwards, sharing one old clay material per
// palette rather than allocating one material per layer. Geometry stays untouched.
export function updateAllLayerMaterials(layers) {
    if (!layers || !scene) return;
    const previous = new Map(paletteQueue);
    paletteQueue.clear();
    paletteStart = null;
    const oldClay = sharedMaterials.nonPrinted && sharedMaterials.nonPrinted.clone();
    if (oldClay) paletteMaterials.add(oldClay);
    if (sharedMaterials.nonPrinted) sharedMaterials.nonPrinted.color.setHex(CONSTS.CURRENT_COLOR_SCHEME.nonPrintedColor);
    if (sharedMaterials.printed) sharedMaterials.printed.color.setHex(CONSTS.CURRENT_COLOR_SCHEME.printedColor);
    const skirtMesh = scene.getObjectByName('skirt-mesh');
    // Bounds cleanup can replace the global skirt item while its mesh stays visible.
    // Follow the live mesh's original owner so heatmap fields and printed state survive.
    const skirt = (skirtMesh && meshOwners.get(skirtMesh)) || window.getSkirtLayerItem?.();
    const ordered = [...new Set([skirt, ...layers])].filter(item => item && item.mesh && item.mesh.geometry);
    // Array order is bed-to-top; the skirt leads the transition.
    const duration = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 0 : 480;
    ordered.forEach((item, index) => {
        const material = previous.get(item)?.material || oldClay;
        const run = () => {
            if ((!layers.includes(item) && !(item === skirt && item.mesh === scene.getObjectByName('skirt-mesh'))) || !item.mesh || !item.mesh.geometry) return;
            ensureStackSoundness(layers);
            refreshHeatmapColorsNow([item]);
            item.mesh.material = baseMaterialFor(item);
        };
        paletteQueue.set(item, { material, delay: ordered.length > 1 ? index / (ordered.length - 1) * duration : 0, run });
        item.mesh.material = baseMaterialFor(item);
    });
    if (!ordered.length) {
        paletteMaterials.forEach(material => material.dispose());
        paletteMaterials.clear();
    }
    processRenderQueue();
}

/**
 * Sets up a tiny separate Three.js scene + camera + renderer
 * inside the <div id="SimulationPerspectiveCube">, with a
 * color-coded cube whose orientation we’ll drive.
 */
function _initViewCube() {
    const container = document.getElementById('SimulationPerspectiveCube');
    if (!container) {
        console.warn("Couldn’t find #SimulationPerspectiveCube");
        return;
    }

    const epsilon = 1;      // tiny offset to avoid z-fighting

    // 1) scene & camera (orthographic or very tight
    //    frustum works too, but perspective is fine)
    viewCubeScene = new THREE.Scene();

    const fov = 45; // Field of view in degrees
    const aspect = container.clientWidth / container.clientHeight; // Aspect ratio
    const near = 0.1; // Near clipping plane
    const far = 10000; // Far clipping plane

    // Create the PerspectiveCamera
    viewCubeCamera = new THREE.PerspectiveCamera(fov, aspect, near, far);

    // viewCubeCamera = new THREE.PerspectiveCamera(15, 1, 1, 100);
    viewCubeCamera.position.set(0, 0, 70);
    viewCubeCamera.lookAt(viewCubeScene.position);

    // 2) renderer
    viewCubeRenderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    // make it square
    const size = Math.min(container.clientWidth, container.clientHeight);
    viewCubeRenderer.setSize(size, size);
    viewCubeRenderer.setPixelRatio(window.devicePixelRatio);
    // ensure it fills the DIV
    container.appendChild(viewCubeRenderer.domElement);

    // 3) build the cube with individual face materials
    const cubeSize = 25;                  // your BoxGeometry size
    const halfCube = cubeSize / 2;        // 5
    const halfGrid = CONSTS.BED_SIZE / 2;  // 220/2 = 110
    const faceOffset = 1.5; // Distance to offset floating faces

    // Create a group to hold both the cube and floating faces
    viewCubeGroup = new THREE.Group();
    viewCubeScene.add(viewCubeGroup);

    // Create transparent base cube
    const geo = new THREE.BoxGeometry(cubeSize, cubeSize, cubeSize);
    const transparentMaterial = new THREE.MeshBasicMaterial({
        color: 0x666666,
        transparent: true,
        opacity: 0,
        wireframe: false
    });

    viewCubeCube = new THREE.Mesh(geo, transparentMaterial);

    // Position the base cube at the center of the group
    viewCubeCube.position.set(0, 0, 0);
    viewCubeGroup.add(viewCubeCube);

    // Create floating face labels
    const faceNames = ['Right', 'Left', 'Top', 'Front', 'Back', 'Bottom'];
    const faceLetters = ['R', 'L', 'T', 'F', 'Ba', 'Bo'];
    // Slipware ink chips (was dark grey) so the cube reads as part of the warm theme
    const faceColors = ['rgba(122,40,18,0.90)', 'rgba(122,40,18,0.90)', 'rgba(122,40,18,0.90)', 'rgba(122,40,18,0.90)', 'rgba(122,40,18,0.90)', 'rgba(94,31,13,0.55)'];
    const faceSize = cubeSize * 0.95; // Make face labels slightly smaller than cube faces

    // Store face meshes for click detection
    viewCubeFaces = [];

    faceNames.forEach((name, i) => {
        // Create canvas texture for each face
        const canvas = document.createElement('canvas');
        const dpr = window.devicePixelRatio || 1;
        canvas.width = canvas.height = 128 * dpr;
        const ctx = canvas.getContext('2d');
        ctx.scale(dpr, dpr);
        const logicalSize = 128; // CSS-pixel coordinate space the scaled context draws into

        // Create rounded rectangle path
        const cornerRadius = 28;
        const x = 0;
        const y = 0;
        const width = logicalSize;
        const height = logicalSize;

        ctx.beginPath();
        ctx.moveTo(x + cornerRadius, y);
        ctx.lineTo(x + width - cornerRadius, y);
        ctx.quadraticCurveTo(x + width, y, x + width, y + cornerRadius);
        ctx.lineTo(x + width, y + height - cornerRadius);
        ctx.quadraticCurveTo(x + width, y + height, x + width - cornerRadius, y + height);
        ctx.lineTo(x + cornerRadius, y + height);
        ctx.quadraticCurveTo(x, y + height, x, y + height - cornerRadius);
        ctx.lineTo(x, y + cornerRadius);
        ctx.quadraticCurveTo(x, y, x + cornerRadius, y);
        ctx.closePath();

        // Fill with face color
        ctx.fillStyle = faceColors[i];
        ctx.fill();

        // For Right and Left faces, flip the text horizontally to compensate for rotation
        if (i === 0 || i === 1) { // Right or Left face
            ctx.save();
            ctx.scale(-1, 1); // Flip horizontally
            ctx.translate(-logicalSize, 0); // Adjust position after flip
        }

        // Add letter - special handling for Top face to create transparent hole
        if (i === 2) { // Top face - create transparent hole for "T"
            ctx.globalCompositeOperation = 'destination-out';
            ctx.fillStyle = 'rgba(0,0,0,1)'; // Color doesn't matter for destination-out
            ctx.font = 'bold 64px Arial';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(faceLetters[i], logicalSize / 2, logicalSize / 2);
            ctx.globalCompositeOperation = 'source-over'; // Reset to normal
        } else {
            // Normal text for other faces — warm cream on the ink chip
            ctx.fillStyle = '#FBF5EE';
            ctx.font = 'bold 64px Arial';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(faceLetters[i], logicalSize / 2, logicalSize / 2);
        }

        // Restore context if we flipped it
        if (i === 0 || i === 1) {
            ctx.restore();
        }

        const texture = new THREE.CanvasTexture(canvas);
        texture.needsUpdate = true;

        // Create floating face plane
        const faceGeometry = new THREE.PlaneGeometry(faceSize, faceSize);
        const faceMaterial = new THREE.MeshBasicMaterial({
            map: texture,
            transparent: true,
            side: THREE.DoubleSide, // Make faces visible from both sides
        });
        const faceMesh = new THREE.Mesh(faceGeometry, faceMaterial);

        // Position and orient each face offset from cube faces
        switch (i) {
            case 0: // Right (+X) - should face left to be readable from outside
                faceMesh.rotation.y = -Math.PI / 2;
                faceMesh.position.set(halfCube + faceOffset, 0, 0);
                break;
            case 1: // Left (-X) - should face right to be readable from outside
                faceMesh.rotation.y = Math.PI / 2;
                faceMesh.position.set(-halfCube - faceOffset, 0, 0);
                break;
            case 2: // Top (+Y) - should face down to be readable from outside
                faceMesh.rotation.x = -Math.PI / 2;
                faceMesh.position.set(0, halfCube + faceOffset, 0);
                faceMesh.material.opacity = 0.6;
                faceMesh.material.color.set('#808080'); // Set color to match the cube
                break;
            case 3: // Front (+Z) - faces forward (no rotation needed)
                faceMesh.position.set(0, 0, halfCube + faceOffset);
                break;
            case 4: // Back (-Z) - should face forward to be readable from outside
                faceMesh.rotation.y = Math.PI;
                faceMesh.position.set(0, 0, -halfCube - faceOffset);
                break;
            case 5: // Bottom (-Y) - should face up to be readable from outside
                faceMesh.rotation.x = Math.PI / 2;
                faceMesh.material.opacity = 0.6;
                faceMesh.position.set(0, -halfCube - faceOffset, 0);
        }

        // Store face info for click detection (skip Top face)
        if (i !== 2) { // Not the Top face
            faceMesh.userData = { faceName: name, faceIndex: i };
            viewCubeFaces.push(faceMesh);
        }

        // Add each face to the group instead of directly to the scene
        viewCubeGroup.add(faceMesh);
    });

    // Add click event listener to view cube
    viewCubeRenderer.domElement.addEventListener('click', _onViewCubeClick);

    // 4) a little ambient so you actually see the colors
    viewCubeScene.add(new THREE.AmbientLight(0xfff5b6, 0.8));
}

// Handle view cube face clicks
function _onViewCubeClick(event) {
    if (!viewCubeCamera || !viewCubeFaces) return;

    // Calculate mouse position in normalized device coordinates
    const rect = viewCubeRenderer.domElement.getBoundingClientRect();
    const mouse = new THREE.Vector2();
    mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    // Create raycaster
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(mouse, viewCubeCamera);

    // Check for intersections with clickable faces
    const intersects = raycaster.intersectObjects(viewCubeFaces);

    if (intersects.length > 0) {
        const clickedFace = intersects[0].object;
        const faceName = clickedFace.userData.faceName;
        _animateCameraToFace(faceName);
    }
}

// Animate main camera to look at selected face
function _animateCameraToFace(faceName) {
    const distance = 1000;
    const isometricAngle = Math.atan(Math.sqrt(2));
    let targetPosition;

    switch (faceName) {
        case 'Front':
            targetPosition = new THREE.Vector3(0, distance * Math.sin(isometricAngle), distance);
            break;
        case 'Back':
            targetPosition = new THREE.Vector3(0, distance * Math.sin(isometricAngle), -distance);
            break;
        case 'Right':
            targetPosition = new THREE.Vector3(distance, distance * Math.sin(isometricAngle), 0);
            break;
        case 'Left':
            targetPosition = new THREE.Vector3(-distance, distance * Math.sin(isometricAngle), 0);
            break;
        default:
            return; // Don't animate for Top or unknown faces
    }

    // Animate camera position
    const startPosition = camera.position.clone();
    const duration = 500; // 1 second
    const startTime = Date.now();

    function animateCamera() {
        const elapsed = Date.now() - startTime;
        const progress = Math.min(elapsed / duration, 1);

        // Use easeInOutCubic for smooth animation
        const easeProgress = progress < 0.5
            ? 4 * progress * progress * progress
            : 1 - Math.pow(-2 * progress + 2, 3) / 2;

        camera.position.lerpVectors(startPosition, targetPosition, easeProgress);
        camera.lookAt(new THREE.Vector3(0, 0, 0));
        controls.update();

        if (progress < 1) {
            requestAnimationFrame(animateCamera);
        }
    }

    animateCamera();
}

// Animate camera to home position (isometric view)
function _animateCameraToHome(distance, isometricAngle) {
    const targetPosition = new THREE.Vector3(
        distance * Math.cos(isometricAngle),
        distance * Math.sin(isometricAngle),
        distance
    );

    // Animate camera position
    const startPosition = camera.position.clone();
    const duration = 800; // Slightly longer duration for home animation
    const startTime = Date.now();

    function animateCamera() {
        const elapsed = Date.now() - startTime;
        const progress = Math.min(elapsed / duration, 1);

        // Use easeInOutCubic for smooth animation
        const easeProgress = progress < 0.5
            ? 4 * progress * progress * progress
            : 1 - Math.pow(-2 * progress + 2, 3) / 2;

        camera.position.lerpVectors(startPosition, targetPosition, easeProgress);
        camera.lookAt(new THREE.Vector3(0, 0, 0));
        controls.update();

        if (progress < 1) {
            requestAnimationFrame(animateCamera);
        }
    }

    animateCamera();
}

// Export function to get the plane for external access
export function get3DPlane() {
    return plane;
}

// Lock a layer by changing its material to printed material
export function lockLayer(layerIndex) {
    console.log(`3D Model: Attempting to lock layer ${layerIndex + 1}`);
    console.log(`3D Model: Scene exists:`, !!scene);
    console.log(`3D Model: Scene children count:`, scene ? scene.children.length : 0);
    
    if (scene) {
        console.log(`3D Model: Scene children names:`, scene.children.map(child => child.name));
    }
    
    // Find the layer mesh in the scene
    // The mesh names are in format "layer-Layer X" where X is layerIndex + 1
    const layerMeshName = `layer-Layer ${layerIndex + 1}`;
    const layerMesh = scene.children.find(child => child.name === layerMeshName);
    
    console.log(`3D Model: Looking for mesh named: ${layerMeshName}`);
    console.log(`3D Model: Found mesh:`, !!layerMesh);
    
    if (layerMesh && layerMesh.material) {
        // Change material to the shared disabled-grey printed material
        layerMesh.material = ensurePrintedMaterial();
        console.log(`3D Model: Layer ${layerIndex + 1} material changed to printed with color:`, CONSTS.CURRENT_COLOR_SCHEME.printedColor);
    } else {
        console.warn(`3D Model: Layer mesh ${layerMeshName} not found in scene`);
        console.warn(`3D Model: Available mesh names:`, scene.children.filter(child => child.name && child.name.startsWith('layer')).map(child => child.name));
    }
}

// Lock the skirt layer by changing its material to printed material
export function lockSkirtLayer() {
    console.log('3D Model: Attempting to lock skirt layer');
    console.log('3D Model: Scene exists:', !!scene);
    console.log('3D Model: Scene children count:', scene ? scene.children.length : 0);
    
    if (scene) {
        console.log('3D Model: Scene children names:', scene.children.map(child => child.name));
    }
    
    // Find the skirt mesh in the scene
    const skirtMesh = scene.children.find(child => child.name === 'skirt-mesh');
    
    console.log('3D Model: Looking for skirt mesh');
    console.log('3D Model: Found skirt mesh:', !!skirtMesh);
    
    if (skirtMesh && skirtMesh.material) {
        // Change material to the shared disabled-grey printed material
        skirtMesh.material = ensurePrintedMaterial();
        const owner = meshOwners.get(skirtMesh);
        if (owner) owner.printed = true;
        console.log('3D Model: Skirt material changed to printed with color:', CONSTS.CURRENT_COLOR_SCHEME.printedColor);
    } else {
        console.warn('3D Model: Skirt mesh not found in scene');
        console.warn('3D Model: Available mesh names:', scene.children.filter(child => child.name && (child.name.startsWith('layer') || child.name.includes('skirt'))).map(child => child.name));
    }
}

// Make functions available globally
window.threeDModel = {
    lockLayer: lockLayer,
    lockSkirtLayer: lockSkirtLayer,
    get3DPlane: get3DPlane
};

// Re-fit the 3D renderer + camera when the simulation canvas changes size.
// The continuous _animate3DView() RAF loop handles the actual redraw, so this
// only needs to resize the backing store and update the projection.
export function resize3DView() {
    if (!renderer || !camera) return;
    const canvas = renderer.domElement;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w === 0 || h === 0) return; // guard splash→app transition (avoids NaN aspect)
    // setPixelRatio is set once at init — calling it per resize forces a full backing-store
    // reallocation on every drag-resize frame, which is wasteful.
    renderer.setSize(w, h, false); // false: don't override CSS-driven element size
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
}
window.resize3DView = resize3DView;

// Listen for printer configuration changes and update 3D rendering
document.addEventListener('printerConfigConstantsUpdated', function(event) {
    const newConfig = event.detail;
    console.log('Updating 3D model rendering for new configuration:', newConfig);
    
    // Clear existing 3D layers and re-render with new parameters
    if (scene) {
        // Remove all existing layer meshes
        const layerMeshes = scene.children.filter(child => 
            child.name && (child.name.startsWith('layer-') || child.name === 'skirt-mesh')
        );
        
        layerMeshes.forEach(mesh => {
            scene.remove(mesh);
            if (mesh.geometry) mesh.geometry.dispose();
            if (mesh.material) mesh.material.dispose();
        });
        
        // Update slicing plane position if it exists
        if (plane) {
            // The slicing plane will be updated by the layer slider event listener
            // No need to update it here since it's handled by updateSlicingPlaneToLayer
        }
        
        console.log('3D model cleared and ready for re-rendering with new configuration');
        
        // Re-render existing layers if they exist
        if (window.layers && window.layers.length > 0) {
            console.log('Re-rendering existing layers with new configuration...');
            window.layers.forEach((layer, index) => {
                if (layer && layer.pathItem) {
                    create3DLayer(layer.pathItem, window.layers, index);
                }
            });
            
            // Update the layer slider after re-rendering
            setTimeout(() => {
                if (window.currentLayerIndex !== undefined) {
                    updateSlicingPlaneToLayer(window.currentLayerIndex);
                }
            }, 100);
        }
    }
});
