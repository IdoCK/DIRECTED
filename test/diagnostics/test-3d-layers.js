// Simple test script to analyze 3D layer creation issues
// This script simulates the layer creation process to identify problems

console.log('🔍 Starting 3D Layer Creation Analysis...\n');

// Mock the required modules and global variables
global.THREE = {
    Vector3: function(x, y, z) {
        this.x = x || 0;
        this.y = y || 0;
        this.z = z || 0;
        this.clone = () => new THREE.Vector3(this.x, this.y, this.z);
        this.add = (v) => new THREE.Vector3(this.x + v.x, this.y + v.y, this.z + v.z);
        this.subtract = (v) => new THREE.Vector3(this.x - v.x, this.y - v.y, this.z - v.z);
        return this;
    },
    Curve: function() {},
    ExtrudeGeometry: function(shape, settings) { 
        console.log('ExtrudeGeometry created with settings:', settings);
        return { dispose: () => {} };
    },
    Shape: function() {
        this.absarc = () => this;
        this.closePath = () => this;
        return this;
    },
    Mesh: function(geometry, material) {
        this.geometry = geometry;
        this.material = material;
        this.position = { set: () => {} };
        this.applyMatrix4 = () => {};
        return this;
    },
    MeshStandardMaterial: function(options) {
        this.color = { setHex: () => {} };
        return this;
    },
    Matrix4: function() {
        this.makeScale = () => this;
        this.makeTranslation = () => this;
        this.makeRotationX = () => this;
        this.multiply = () => this;
        this.clone = () => new THREE.Matrix4();
        return this;
    }
};

// Mock constants
const CONSTS = {
    LAYER_HEIGHT: 1.0,
    SCALE_FACTOR_3D: 5,
    SCALE_FACTOR: 3.89, // Pixels per mm (typical 1024px / 263mm)
    NOZZLE_DIAMETER: 3,
    ANIMATION_DURATION: 5
};

// Mock window globals
global.window = {
    gridStartX: 0,
    gridStartY: 0,
    scaleFactor: 1,
    requestIdleCallback: (fn) => setTimeout(fn, 0)
};

// Mock scene and scene operations
let mockScene = {
    add: function(mesh) {
        console.log('✅ Mesh added to scene:', mesh.constructor.name);
    },
    remove: function(mesh) {
        console.log('❌ Mesh removed from scene');
    }
};

// Mock Paper.js path
function createMockPath(segmentCount = 10) {
    const segments = [];
    for (let i = 0; i < segmentCount; i++) {
        const angle = (i / segmentCount) * Math.PI * 2;
        segments.push({
            point: {
                x: 50 + Math.cos(angle) * 30,
                y: 50 + Math.sin(angle) * 30
            }
        });
    }
    
    return {
        length: 100 + Math.random() * 50,
        segments: segments,
        getPointAt: function(offset) {
            if (this.length === 0) return null;
            const t = Math.min(1, Math.max(0, offset / this.length));
            const index = Math.floor(t * (this.segments.length - 1));
            const segment = this.segments[index] || this.segments[0];
            return segment ? segment.point : null;
        }
    };
}

// Mock layer item
function createMockLayerItem(index) {
    return {
        mesh: null,
        isPrinted: () => false,
        name: `Layer ${index + 1}`
    };
}

// Simplified 3D layer creation function based on the actual code
function testCreate3DLayer(path, layers, layerIndex) {
    console.log(`\n🎯 Testing 3D layer creation for layer ${layerIndex}`);
    console.log(`📊 Path details:`, {
        pathExists: !!path,
        pathType: typeof path,
        pathLength: path ? path.length : 'undefined',
        segmentCount: path && path.segments ? path.segments.length : 'undefined'
    });
    
    if (!path) {
        console.log('❌ ISSUE: Path is null or undefined');
        return false;
    }
    
    if (!path.length || path.length === 0) {
        console.log('❌ ISSUE: Path has no length');
        return false;
    }
    
    if (!path.segments || path.segments.length === 0) {
        console.log('❌ ISSUE: Path has no segments');
        return false;
    }
    
    console.log('✅ Path validation passed');
    
    // Test point sampling
    const layerHeight = CONSTS.LAYER_HEIGHT * CONSTS.SCALE_FACTOR; // Use same scaling as coordinates (pixels per mm)
    const pointsToSample = 1000;
    const points = [];
    
    console.log(`🔍 Sampling ${pointsToSample} points along path of length ${path.length}`);
    
    if (path.length > 0 && pointsToSample > 0) {
        const step = path.length / pointsToSample;
        console.log(`📏 Step size: ${step}`);
        
        let sampledCount = 0;
        for (let offset = 0; offset <= path.length; offset += step) {
            const point = path.getPointAt(offset);
            if (point) {
                points.push(new THREE.Vector3(
                    point.x - (window.gridStartX || 0),
                    point.y - (window.gridStartY || 0),
                    -((layerIndex + 1) * layerHeight)
                ));
                sampledCount++;
            }
        }
        
        console.log(`📍 Successfully sampled ${sampledCount} points`);
        
        // Close the curve
        if (points.length > 2) {
            const firstPoint = points[0].clone();
            points.push(firstPoint);
            console.log('🔄 Curve closed by adding first point at end');
        }
    }
    
    console.log(`🏗️ Final point count: ${points.length}`);
    
    if (points.length > 1) {
        console.log('✅ Sufficient points for 3D mesh creation');
        
        // Test capsule creation
        try {
            const radius = layerHeight / 2;
            console.log(`🎨 Creating capsule with radius ${radius}`);
            
            // Mock the Three.js geometry creation
            const shape = new THREE.Shape();
            const curve = { getPoint: () => new THREE.Vector3() };
            
            const extrudeSettings = {
                steps: Math.max(Math.floor(points.length / 10), 5),
                bevelEnabled: false,
                extrudePath: curve
            };
            
            console.log('⚙️ Extrude settings:', extrudeSettings);
            
            const geometry = new THREE.ExtrudeGeometry(shape, extrudeSettings);
            const material = new THREE.MeshStandardMaterial({ color: 0x4b73c9 });
            const mesh = new THREE.Mesh(geometry, material);
            
            // Test scene addition
            mockScene.add(mesh);
            
            // Test layer item mesh assignment
            const layerItem = layers[layerIndex];
            if (layerItem) {
                layerItem.mesh = mesh;
                console.log(`✅ Mesh assigned to layer item: ${layerItem.name}`);
            } else {
                console.log('❌ ISSUE: Layer item not found');
                return false;
            }
            
            console.log('🎊 3D layer creation completed successfully!');
            return true;
            
        } catch (error) {
            console.log('❌ ERROR during mesh creation:', error.message);
            return false;
        }
    } else {
        console.log('❌ ISSUE: Insufficient points for 3D layer creation');
        return false;
    }
}

// Test multiple scenarios
console.log('==========================================');
console.log('Testing various path scenarios:');
console.log('==========================================');

// Create mock layers array
const mockLayers = Array.from({ length: 5 }, (_, i) => createMockLayerItem(i));

// Test 1: Valid path with good data
console.log('\n📋 TEST 1: Valid path with segments');
const validPath = createMockPath(20);
const result1 = testCreate3DLayer(validPath, mockLayers, 0);
console.log('Result:', result1 ? '✅ SUCCESS' : '❌ FAILED');

// Test 2: Path with no length
console.log('\n📋 TEST 2: Path with zero length');
const zeroLengthPath = { ...createMockPath(10), length: 0 };
const result2 = testCreate3DLayer(zeroLengthPath, mockLayers, 1);
console.log('Result:', result2 ? '✅ SUCCESS' : '❌ FAILED');

// Test 3: Path with no segments
console.log('\n📋 TEST 3: Path with no segments');
const noSegmentsPath = { ...createMockPath(10), segments: [] };
const result3 = testCreate3DLayer(noSegmentsPath, mockLayers, 2);
console.log('Result:', result3 ? '✅ SUCCESS' : '❌ FAILED');

// Test 4: Null path
console.log('\n📋 TEST 4: Null path');
const result4 = testCreate3DLayer(null, mockLayers, 3);
console.log('Result:', result4 ? '✅ SUCCESS' : '❌ FAILED');

// Test 5: Very small path (edge case)
console.log('\n📋 TEST 5: Very small path (2 segments)');
const smallPath = createMockPath(2);
const result5 = testCreate3DLayer(smallPath, mockLayers, 4);
console.log('Result:', result5 ? '✅ SUCCESS' : '❌ FAILED');

console.log('\n==========================================');
console.log('🏁 Analysis Complete!');
console.log('==========================================');

console.log('\n🔍 POTENTIAL ISSUES IDENTIFIED:');
console.log('1. Path validation - ensure paths have valid length and segments');
console.log('2. Point sampling - verify getPointAt() returns valid points');
console.log('3. Layer height calculations - check SCALE_FACTOR_3D usage');
console.log('4. Mesh creation - ensure Three.js geometry creation succeeds');
console.log('5. Scene management - verify meshes are properly added to scene');

console.log('\n💡 RECOMMENDATIONS:');
console.log('1. Add more robust path validation before 3D creation');
console.log('2. Add try-catch around Three.js geometry operations');
console.log('3. Add debugging logs for point sampling process');
console.log('4. Verify layer height and scaling calculations');
console.log('5. Check that Paper.js paths are properly created');