// Ender 3 V2 Neo with Clay Modification Specifications
export const BED_SIZE = 220; // mm, square bed size of the printer

// Configurable printer parameters (initial values)
export let MAX_BUILD_HEIGHT = 180; // mm, modified height due to clay nozzle system
export let NOZZLE_DIAMETER = 3; // mm
export let LAYER_HEIGHT = 1.0; // mm, layer height for clay printing

// Derived values that depend on configurable parameters
export let MIN_OVERLAP = 0.7 * NOZZLE_DIAMETER; // in mm
export let NOZZLE_WIDTH = NOZZLE_DIAMETER; // mm, effective nozzle width for extrusion calculations
export let STROKE_W = NOZZLE_DIAMETER * (window.innerWidth / 263); // Stroke width in pixels
export let OBJ_HEIGHT_LAYERS = Math.floor(MAX_BUILD_HEIGHT / LAYER_HEIGHT); // number of layers in the object

// Non-configurable parameters
export const PRINT_SPEED = 1200; // mm/min, print speed for extrusion moves
export const TRAVEL_SPEED = 9000; // mm/min, travel speed for non-extrusion moves
export const EXTRUSION_RATE = 1.0; // extruder spin speed multiplier
export const SCREEN_DIM_W = 263; // in mm, of the iPad pro 12.9"
export const VIEWPORT_W = window.innerWidth;
export const SCALE_FACTOR = VIEWPORT_W / SCREEN_DIM_W; // Pixels per mm
export const SMOOTHING_FACTOR = 1;
export const ANCHOR_DIST = 1; // Minimum distance between points to add a new anchor


export const FADE_LAYER_COUNT = 25; // Number of layers to fade below the selected layer

export const ANIMATION_DURATION = 220; // milliseconds — layer-add entrance duration (D-01 layer-add exception, ~220ms ease-out)

// Function to update printer configuration and recalculate dependent values
export function updatePrinterConfig(newConfig) {
    // Update configurable parameters
    if (newConfig.maxBuildHeight !== undefined) {
        MAX_BUILD_HEIGHT = newConfig.maxBuildHeight;
    }
    if (newConfig.nozzleDiameter !== undefined) {
        NOZZLE_DIAMETER = newConfig.nozzleDiameter;
    }
    if (newConfig.layerHeight !== undefined) {
        LAYER_HEIGHT = newConfig.layerHeight;
    }
    
    // Recalculate derived values
    MIN_OVERLAP = 0.7 * NOZZLE_DIAMETER;
    NOZZLE_WIDTH = NOZZLE_DIAMETER;
    STROKE_W = NOZZLE_DIAMETER * SCALE_FACTOR;
    OBJ_HEIGHT_LAYERS = Math.floor(MAX_BUILD_HEIGHT / LAYER_HEIGHT);
    
    console.log('Updated printer configuration in consts.js:', {
        MAX_BUILD_HEIGHT,
        NOZZLE_DIAMETER,
        LAYER_HEIGHT,
        OBJ_HEIGHT_LAYERS
    });
    
    // Update the window.CONSTS object for compatibility
    window.CONSTS = {
        OBJ_HEIGHT_LAYERS,
        BED_SIZE,
        MAX_BUILD_HEIGHT,
        NOZZLE_DIAMETER,
        LAYER_HEIGHT,
        MIN_OVERLAP,
        NOZZLE_WIDTH,
        STROKE_W,
        SCALE_FACTOR
    };
    
    // Dispatch event to notify other modules
    document.dispatchEvent(new CustomEvent('printerConfigConstantsUpdated', {
        detail: {
            MAX_BUILD_HEIGHT,
            NOZZLE_DIAMETER,
            LAYER_HEIGHT,
            OBJ_HEIGHT_LAYERS,
            MIN_OVERLAP,
            NOZZLE_WIDTH,
            STROKE_W
        }
    }));
}

// 3D - Legacy materials (updated by color scheme system)
export const NON_PRINTED_LAYER_COLOR = 0x1d99b1; // Default to Technical blue
export const NON_PRINTED_MAT = new THREE.MeshStandardMaterial({
    color: NON_PRINTED_LAYER_COLOR,
    roughness: 0.87,
    metalness: 0.0
});
// Printed = already-on-the-bed = IMMUTABLE. It renders as a disabled/greyed-out state
// (like a disabled button), NOT as an alert color. The grey is a cool light slate chosen
// to sit far from every clay scheme hue (warm beige 0xd1d1c3, dark dim-grey 0x696969,
// saturated blue/terracotta/brown) AND from the heatmap risk ramp (amber 0xE0A020,
// red 0xD12F1F), while staying readable as a fill inside the slider track.
export const PRINTED_LAYER_COLOR = 0xA9B0B7; // disabled cool grey (all schemes share it)
export const PRINTED_MAT = new THREE.MeshStandardMaterial({
    color: PRINTED_LAYER_COLOR,
    roughness: 0.87,
    metalness: 0.0
});

// Color Schemes for 3D Visualization
export const COLOR_SCHEMES = {
    TECHNICAL: {
        name: 'Technical',
        nonPrintedColor: 0x1d99b1, // Porcelain blue
        printedColor: PRINTED_LAYER_COLOR, // disabled grey (see note above)
    },
    TERRACOTTA: {
        name: 'Terracotta',
        nonPrintedColor: 0x8f3d22, // Terracotta red, darkened one notch for legibility on the cream stage
        printedColor: PRINTED_LAYER_COLOR, // disabled grey
    },
    PORCELAIN: {
        name: 'Porcelain',
        nonPrintedColor: 0xd1d1c3, //#d1d1c3ff // Beige
        printedColor: PRINTED_LAYER_COLOR, // disabled grey
        nonPrintedColor2D: 0xf5f5e8, // Brighter beige for 2D layers
    },
    BROWN: {
        name: 'Brown',
        nonPrintedColor: 0x936034, // Saddle brown
        printedColor: PRINTED_LAYER_COLOR, // disabled grey
    },
    GREY: {
        name: 'Grey',
        nonPrintedColor: 0x696969, // Dim grey
        printedColor: PRINTED_LAYER_COLOR, // disabled grey (lighter + cooler than the dim-grey clay)
    },
};

// Current color scheme (default to Technical — cyan 3D body, per HUMAN-UAT G1)
export let CURRENT_COLOR_SCHEME = COLOR_SCHEMES.TECHNICAL;

// Function to update current color scheme
export function setColorScheme(schemeName) {
    if (COLOR_SCHEMES[schemeName]) {
        CURRENT_COLOR_SCHEME = COLOR_SCHEMES[schemeName];

        // Update existing materials
        NON_PRINTED_MAT.color.setHex(CURRENT_COLOR_SCHEME.nonPrintedColor);
        PRINTED_MAT.color.setHex(CURRENT_COLOR_SCHEME.printedColor);

        return true;
    }
    return false;
}

export const SCALE_FACTOR_3D = 5; // Scale factor for 3D geometry

// Views
export const PATH_EDITOR_VIEW = "PathEditorView";
export const SIMULATION_VIEW = "SimulationView";
export const SPLINE_EDITOR = "SplineEditor";

// Path Editor Objects
export const ANCHOR_BOX_PADDING2 = 25;
export const CONTROL_POINT_OPACITY = 0.85; // Opacity for control points
export const ANCHOR_POINT_RADIUS = 5; // Radius for anchor points
export const HORIZONTAL_ANCHOR_POINT_COLOR = '#5fae5dff'; // Dark grey for anchor points
export const VERTICAL_ANCHOR_POINT_COLOR = HORIZONTAL_ANCHOR_POINT_COLOR; // Light grey for anchor points
export const BOUNDS_GUIDE_GROW_FACTOR = 1;

// ── Structural-soundness heatmap ──────────────────────────────────────────────
// Geometric overhang-risk model for a SINGLE-WALL print (a RISK/CONFIDENCE map, NOT an
// FEA simulation): each point of a layer is scored 1 = structurally sound … 0 = will
// collapse, from its lateral displacement off the bead CENTERLINE of the layer directly
// below (its only support) — symmetric, so inward and outward overhangs both count.
// Two failure terms, max()'d (see heatmap.js):
//   BOND — single-step bead adhesion, driven by NOZZLE_WIDTH and MIN_OVERLAP (above).
//   LEAN — cumulative cantilever; per-step displacement beyond LH·tan(ANGLE_SOUND)
//          accumulates up the stack with elastic retention (the fade-upward plume).
export const HEATMAP_SAMPLES = 160;          // points sampled per layer (arc-length) for the soundness field
export const ANGLE_SOUND = 30;               // deg from vertical: a sustained lean at/under this never accumulates risk
export const REACH_RETENTION = 0.85;         // 0..1 per layer; closer to 1 = cantilever/plume carries higher
export const MAX_LEAN_NOZZLE_MULT = 2;       // unsupported-reach budget before collapse = this × nozzle width (mm)
// (ANGLE_FAIL / SELF_SUPPORT_FRAC were retired with the point-in-polygon model: the bond
// term now derives its thresholds from the physical NOZZLE_WIDTH / MIN_OVERLAP consts.)

// Curve start indicator colors (mirror of CSS --terracotta family; Paper.js can't read CSS vars).
// Keep in sync with :root in styles.css.
export const INDICATOR_FILL = '#cf4928';        // --terracotta (direction arrow fill)
export const INDICATOR_FILL_DARK = '#882d17';   // --terracotta-dark (start dot fill)
export const INDICATOR_STROKE = '#f4ece2';      // --off-white (halo / ring against warm canvas)

window.CONSTS = {
    OBJ_HEIGHT_LAYERS,
    BED_SIZE,
    MAX_BUILD_HEIGHT,
    NOZZLE_DIAMETER,
    LAYER_HEIGHT,
    MIN_OVERLAP,
    NOZZLE_WIDTH,
    STROKE_W,
    SCALE_FACTOR,
    setColorScheme,
    CURRENT_COLOR_SCHEME,
    COLOR_SCHEMES
};
