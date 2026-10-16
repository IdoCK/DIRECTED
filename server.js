// Increase Node.js limits
require('events').EventEmitter.defaultMaxListeners = 100;

const express = require('express');
const compression = require('compression');
const { Server } = require('socket.io');
const path = require('path');

// ── serialport in the packaged .exe ───────────────────────────────────────────
// serialport is a NATIVE module (a .node binary) needed only for a REAL printer
// over USB. Native code cannot be dlopen'd from the pkg snapshot, but serialport's
// loader (node-gyp-build) has an explicit pkg escape hatch: it also looks for
// `prebuilds/<platform-arch>/` NEXT TO the executable. So on first run the exe
// self-extracts its bundled prebuilt binding beside itself, and `require('serialport')`
// then loads it natively — real printers work from the standalone exe.
// If anything in this chain fails (read-only folder, unsupported platform), the app
// still runs fully — connect() returns false and printing is simulated.
if (process.pkg) {
    try {
        const fsx = require('fs');
        const prebuildsRoot = path.join(__dirname, 'node_modules', '@serialport', 'bindings-cpp', 'prebuilds');
        // Match the prebuild folder for this platform+arch, including UNION naming:
        // macOS ships one universal folder named `darwin-x64+arm64`. node-gyp-build
        // parses these `archA+archB` names, so we keep the folder name as-is.
        const want = `${process.platform}-${process.arch}`;
        const entries = fsx.readdirSync(prebuildsRoot);
        const dirName = entries.includes(want) ? want :
            entries.find(n => n.startsWith(process.platform + '-') &&
                n.slice(process.platform.length + 1).split('+').includes(process.arch));
        if (dirName) {
            const srcDir = path.join(prebuildsRoot, dirName);
            const dstDir = path.join(path.dirname(process.execPath), 'prebuilds', dirName);
            let extracted = 0;
            for (const f of fsx.readdirSync(srcDir)) {
                const dst = path.join(dstDir, f);
                if (!fsx.existsSync(dst)) {
                    fsx.mkdirSync(dstDir, { recursive: true });
                    fsx.copyFileSync(path.join(srcDir, f), dst);   // snapshot → real disk
                    extracted++;
                }
            }
            if (extracted) console.log(`Extracted serial driver to ${dstDir}`);
        } else {
            console.warn(`No bundled serial driver for ${want} — real-printer mode disabled.`);
        }
    } catch (e) {
        console.warn(`Could not extract the serial driver (${e.message}) — real-printer mode disabled.`);
    }
}

let SerialPort = null, ReadlineParser = null;
try {
    ({ SerialPort } = require('serialport'));
    ({ ReadlineParser } = require('@serialport/parser-readline'));
} catch (e) {
    console.warn(`serialport unavailable (${e.message}) — real-printer mode disabled, simulation only.`);
}

// Import constants for printing parameters
const fs = require('fs');
const constantsPath = path.join(__dirname, 'consts.js');
const constantsContent = fs.readFileSync(constantsPath, 'utf8');

// Extract constants from the file (simple parsing for server use)
let LAYER_HEIGHT = parseFloat(constantsContent.match(/export const LAYER_HEIGHT = ([0-9.]+)/)?.[1] || '1.0');
const PRINT_SPEED = parseInt(constantsContent.match(/export const PRINT_SPEED = ([0-9]+)/)?.[1] || '1200');
const TRAVEL_SPEED = parseInt(constantsContent.match(/export const TRAVEL_SPEED = ([0-9]+)/)?.[1] || '9000');
const EXTRUSION_RATE = parseFloat(constantsContent.match(/export const EXTRUSION_RATE = ([0-9.]+)/)?.[1] || '1.0');
let NOZZLE_WIDTH = parseFloat(constantsContent.match(/export const NOZZLE_WIDTH = ([0-9.]+)/)?.[1] || '3.0');
let MAX_BUILD_HEIGHT = parseFloat(constantsContent.match(/export const MAX_BUILD_HEIGHT = ([0-9]+)/)?.[1] || '180');
let NOZZLE_DIAMETER = parseFloat(constantsContent.match(/export const NOZZLE_DIAMETER = ([0-9.]+)/)?.[1] || '3.0');
let OBJ_HEIGHT_LAYERS = Math.floor(MAX_BUILD_HEIGHT / LAYER_HEIGHT);
const InterpolationService = require('./backend/interpolation-service');
const config = require('./config');

// Initialize interpolation service
const interpolationService = new InterpolationService();

console.log(`Using printing parameters: Layer=${LAYER_HEIGHT}mm, Print=${PRINT_SPEED}mm/min, Travel=${TRAVEL_SPEED}mm/min, Extrusion=${EXTRUSION_RATE}x, Max Height=${MAX_BUILD_HEIGHT}mm`);

const app = express();
app.use(compression());
const server = require('http').createServer(app);

// Increase HTTP server limits
server.maxHeadersCount = 0;
server.headersTimeout = 60000;
server.requestTimeout = 60000;

const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    },
    maxHttpBufferSize: 10 * 1024 * 1024 // 10MB for Socket.IO
});

// Add request logging middleware BEFORE body parsing
app.use((req, res, next) => {
    console.log(`${req.method} ${req.path} - ${new Date().toISOString()}`);
    next();
});

// Middleware for parsing JSON bodies with increased size limit
app.use(express.json({ 
    limit: '10mb',
    parameterLimit: 100000,
    type: ['application/json', 'text/plain']
}));
app.use(express.urlencoded({ 
    limit: '10mb', 
    extended: true,
    parameterLimit: 100000
}));
app.use(express.raw({ limit: '10mb' }));
app.use(express.text({ limit: '10mb' }));

// API ROUTES - Must come before static file middleware
// API endpoint to get system status
app.get('/api/status', async (req, res) => {
    // Serial diagnostics: is the native driver loaded, and which ports are visible?
    // (Lets a user of the standalone exe check whether their printer is detected.)
    let serial = { available: !!SerialPort, ports: [] };
    if (SerialPort && typeof SerialPort.list === 'function') {
        try {
            serial.ports = (await SerialPort.list()).map(p => ({
                path: p.path, vendorId: p.vendorId, manufacturer: p.manufacturer
            }));
        } catch (e) { serial.error = e.message; }
    }
    res.json({
        status: 'running',
        environment: process.env.NODE_ENV || 'development',
        serial,
        printerStatus: printer.getStatus(),
        printJob: {
            state: printJob.state,
            currentLayer: printJob.currentLayerIndex,
            totalLayers: printJob.totalLayers,
            queueLength: printJob.layerQueue.length
        }
    });
});

// Health check endpoint for frontend to verify server availability
app.get('/api/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        server: 'directed-3d-printer'
    });
});

// Endpoint to check if Socket.IO is ready
app.get('/api/socket-status', (req, res) => {
    res.json({
        socketReady: true,
        connectedClients: io.engine.clientsCount,
        timestamp: new Date().toISOString()
    });
});

// Printer configuration endpoints
app.get('/api/printer-config', (req, res) => {
    res.json({
        maxBuildHeight: MAX_BUILD_HEIGHT,
        layerHeight: LAYER_HEIGHT,
        nozzleDiameter: NOZZLE_DIAMETER
    });
});

app.post('/api/printer-config', (req, res) => {
    const { maxBuildHeight, layerHeight, nozzleDiameter } = req.body;
    
    // Validate inputs
    if (!maxBuildHeight || !layerHeight || !nozzleDiameter) {
        return res.status(400).json({ error: 'Missing required configuration values' });
    }
    
    // Validate layer height vs nozzle diameter
    if (layerHeight > nozzleDiameter / 3) {
        return res.status(400).json({ 
            error: `Layer height cannot be larger than ${(nozzleDiameter / 3).toFixed(2)}mm (nozzle diameter / 3)` 
        });
    }
    
    // Update server constants
    MAX_BUILD_HEIGHT = parseFloat(maxBuildHeight);
    LAYER_HEIGHT = parseFloat(layerHeight);
    NOZZLE_DIAMETER = parseFloat(nozzleDiameter);
    
    // Update derived values
    NOZZLE_WIDTH = NOZZLE_DIAMETER;
    OBJ_HEIGHT_LAYERS = Math.floor(MAX_BUILD_HEIGHT / LAYER_HEIGHT);
    
    console.log('Printer configuration updated:', {
        maxBuildHeight: MAX_BUILD_HEIGHT,
        layerHeight: LAYER_HEIGHT,
        nozzleDiameter: NOZZLE_DIAMETER,
        nozzleWidth: NOZZLE_WIDTH
    });
    
    res.json({ 
        success: true,
        config: {
            maxBuildHeight: MAX_BUILD_HEIGHT,
            layerHeight: LAYER_HEIGHT,
            nozzleDiameter: NOZZLE_DIAMETER
        }
    });
});

// G-code export endpoint
app.post('/api/export-gcode', (req, res) => {
    console.log('POST /api/export-gcode called');
    console.log('Request method:', req.method);
    console.log('Request body:', req.body);
    
    try {
        const { layers, scaleFactor, windowWidth, gridOffset, gridSize } = req.body;
        
        if (!layers || !Array.isArray(layers)) {
            console.error('Invalid layers data:', layers);
            return res.status(400).json({ error: 'Invalid layers data' });
        }

        if (layers.length === 0) {
            console.error('No layers provided');
            return res.status(400).json({ error: 'No layers provided' });
        }

        console.log(`Generating G-code for ${layers.length} layers`);

        // Generate complete G-code using existing backend logic
        const gcode = GcodeGenerator.generateCompleteGcode(layers, scaleFactor, gridOffset, gridSize);
        
        // Set appropriate headers for G-code file
        res.setHeader('Content-Type', 'text/plain');
        res.setHeader('Content-Disposition', 'attachment; filename="directed-print.gcode"');
        
        // G-code generation successful, sending response
        res.send(gcode);
        
    } catch (error) {
        console.error('Error generating G-code for export:', error);
        res.status(500).json({ error: 'Failed to generate G-code' });
    }
});

// Serve static files from multiple locations for compatibility
app.use(express.static(path.join(__dirname, 'frontend')));
app.use(express.static(__dirname));

// Print job state management
class PrintJob {
    constructor() {
        this.state = 'idle'; // idle, homing, waiting_for_layers, printing, paused, stopped, completed
        this.layerQueue = [];
        this.availableLayers = []; // All layers available from frontend
        this.skirtLayer = null; // Skirt layer (processed before first layer)
        this.currentLayerIndex = 0;
        this.totalLayers = 0;
        this.totalAvailableLayers = 0;
        this.isHomed = false;
        this.minLayersToStart = 5;
        this.generatedGcode = []; // Store complete G-code for export
        this.pausedState = null; // Store pause state for proper resume
        this.currentLayerProgress = 0; // Track progress within current layer
    }

    reset() {
        this.state = 'idle';
        this.layerQueue = [];
        this.availableLayers = [];
        this.skirtLayer = null;
        this.currentLayerIndex = 0;
        this.totalLayers = 0;
        this.pausedState = null;
        this.currentLayerProgress = 0;
        this.totalAvailableLayers = 0;
        this.isHomed = false;
        this.generatedGcode = [];
    }

    canStartPrinting() {
        return this.isHomed && this.totalAvailableLayers >= this.minLayersToStart;
    }

    getNextLayer() {
        // First try to get from queue
        if (this.layerQueue.length > 0) {
            return this.layerQueue.shift();
        }
        
        // If queue is empty, check if we have more available layers
        if (this.currentLayerIndex < this.availableLayers.length) {
            const layer = this.availableLayers[this.currentLayerIndex];
            this.currentLayerIndex++;
            return layer;
        }
        
        return null;
    }
    
    getCurrentLayer() {
        // Get current layer without incrementing index (for resume scenarios)
        if (this.currentLayerIndex > 0 && this.currentLayerIndex <= this.availableLayers.length) {
            return this.availableLayers[this.currentLayerIndex - 1];
        }
        return null;
    }

    hasMoreLayers() {
        return this.currentLayerIndex < this.totalAvailableLayers;
    }

    addLayers(layers) {
        this.layerQueue = [...layers];
        this.totalLayers = layers.length;
    }
}

// Ender 3 V2 Neo G-code generator with proper coordinate system
class GcodeGenerator {
    static fromLayer(layerData, layerIndex, scaleFactor = null, gridOffset = null, gridSize = null, config = {}) {
        // Use constants from CONSTS file
        const layerHeight = LAYER_HEIGHT;
        const printSpeed = PRINT_SPEED; // 1200mm/min = 20mm/s
        const travelSpeed = TRAVEL_SPEED; // 9000mm/min = 150mm/s
        // const zHopSpeed = Z_HOP_SPEED; // 5mm/s = 300mm/min
        const extrusionMultiplier = EXTRUSION_RATE;
        const nozzleWidth = NOZZLE_WIDTH;

        const gcode = [];
        let cumulativeE = 0; // Track cumulative extrusion
        
        // Layer start commands
        let layerLabel, extruderResetLabel, targetZ;
        
        if (layerIndex === -1) {
            // This is the skirt
            layerLabel = '; Skirt';
            extruderResetLabel = 'G92 E0 ; Reset extruder position for skirt';
            targetZ = layerHeight; // Same Z height as Layer 1
        } else {
            // Regular layer
            layerLabel = `; Layer ${layerIndex + 1}`;
            extruderResetLabel = `G92 E0 ; Reset extruder position for layer ${layerIndex + 1}`;
            targetZ = (layerIndex + 1) * layerHeight;
        }
        
        gcode.push(layerLabel);
        gcode.push(extruderResetLabel);
        
        // Check if layer height exceeds modified build height
        if (targetZ > MAX_BUILD_HEIGHT) {
            gcode.push(`; WARNING: Layer height ${targetZ}mm exceeds max build height ${MAX_BUILD_HEIGHT}mm`);
            return gcode; // Skip this layer
        }
        
        gcode.push(`G1 Z${targetZ.toFixed(3)} F300 ; Move to layer height`);
        
        // Process layer segments
        if (layerData && layerData.length > 0) {
            // Convert frontend coordinates to Ender 3 bed coordinates
            const convertedPoints = layerData.map((point, index) => {
                // Handle different point formats
                let x, y;
                
                if (point && Array.isArray(point)) {
                    // Format: ['Point', x, y]
                    if (point.length >= 3 && point[0] === 'Point') {
                        x = point[1];
                        y = point[2];
                    } else {
                        // Format: [x, y]
                        x = point[0];
                        y = point[1];
                    }
                } else if (point && typeof point === 'object') {
                    // Format: {x: value, y: value}
                    x = point.x;
                    y = point.y;
                } else {
                    console.error('Invalid point format at index', index, ':', point);
                    return this.convertCoordinates(110, 110, scaleFactor); // Default to center
                }
                
                if (x === undefined || y === undefined || isNaN(x) || isNaN(y)) {
                    console.error('Invalid coordinates at index', index, ':', { x, y, point });
                    return this.convertCoordinates(110, 110, scaleFactor); // Default to center
                }
                
                return this.convertCoordinates(x, y, scaleFactor, gridOffset, gridSize);
            });
            
            // Move to start position (no extrusion)
            const firstPoint = convertedPoints[0];
            gcode.push(`G1 X${firstPoint.x.toFixed(3)} Y${firstPoint.y.toFixed(3)} F${travelSpeed} ; Move to start position`);
            
            // Start extruding immediately (no retraction system)
            gcode.push(`; Starting extrusion for layer ${layerIndex + 1}`);
            
            // Extrude along path (including final closure for proper layer adhesion)
            for (let i = 1; i < convertedPoints.length; i++) {
                const point = convertedPoints[i];
                const prevPoint = convertedPoints[i - 1];
                
                // Calculate distance for extrusion
                const dx = point.x - prevPoint.x;
                const dy = point.y - prevPoint.y;
                const distance = Math.sqrt(dx * dx + dy * dy);
                
                // Calculate extrusion amount based on distance, layer height, and nozzle width
                const extrusionAmount = distance * layerHeight * nozzleWidth * extrusionMultiplier;
                cumulativeE += extrusionAmount;
                
                gcode.push(`G1 X${point.x.toFixed(3)} Y${point.y.toFixed(3)} E${cumulativeE.toFixed(4)} F${printSpeed} ; Extrude`);
            }
            
            // No retraction - just stop extrusion
            gcode.push(`; Layer ${layerIndex + 1} extrusion complete`);
            
            // No Z-hop between layers for clay printing
        }
        
        // Layer end commands
        gcode.push('');
        
        return gcode;
    }

    // Convert frontend coordinates to Ender 3 V2 Neo bed coordinates
    static convertCoordinates(frontendX, frontendY, scaleFactor = null, gridOffset = null, gridSize = null) {
        // Validate inputs
        if (frontendX === undefined || frontendY === undefined || 
            isNaN(frontendX) || isNaN(frontendY) || 
            typeof frontendX !== 'number' || typeof frontendY !== 'number') {
            console.error('Invalid coordinates passed to convertCoordinates:', { frontendX, frontendY });
            return { x: 110, y: 110 }; // Default to center of bed
        }
        
        // Coordinate system mapping:
        // Frontend: (0,0) at top-left, Y increases downward
        // Printer: (0,0) at front-left, Y increases toward back
        // Need to map frontend bottom-left to printer front-left
        
        const actualScaleFactor = scaleFactor || (800 / 263); // Use provided or default scale factor
        const bedSizeX = 220; // Ender 3 V2 Neo bed width
        const bedSizeY = 220; // Ender 3 V2 Neo bed depth
        
        // Apply grid offset to make grid's bottom-left corner the (0,0) reference
        const offsetX = gridOffset ? frontendX - gridOffset.x : frontendX;
        const offsetY = gridOffset ? frontendY - gridOffset.y : frontendY;
        
        // Convert from pixels to millimeters
        const mmX = offsetX / actualScaleFactor;
        const mmY = offsetY / actualScaleFactor;
        
        // Map frontend coordinates to printer bed coordinates
        // After offset, the grid's bottom-left should be (0,0)
        // Paper.js: Y increases downward (top=0, bottom=high)
        // Printer: Y should increase upward (bottom=0, top=high)
        // Need to flip Y coordinate system to match printer expectation
        
        const printerX = mmX;
        // Convert gridSize from pixels to mm for the flip calculation
        const gridSizeMm = gridSize ? (gridSize / actualScaleFactor) : 220;
        const printerY = gridSizeMm - mmY; // Flip Y using grid height in mm
        
        // Ensure coordinates are within build volume
        const clampedX = Math.max(0, Math.min(bedSizeX, printerX));
        const clampedY = Math.max(0, Math.min(bedSizeY, printerY));
        
        return {
            x: clampedX,
            y: clampedY
        };
    }

    static getStartGcode() {
        const timestamp = new Date().toISOString();
        return [
            '; DIRECTED 3D Printer Control System',
            `; Generated: ${timestamp}`,
            '; Ender 3 V2 Neo Clay 3D Printing G-code',
            '; Material: Clay',
            '; Ido Cohen-Kerems Final Industrial and Product Design Project',
            '',
            '; Start G-code for Ender 3 V2 Neo',
            'G21 ; Set units to millimeters',
            'G90 ; Use absolute coordinates',
            '; M106 S255 ; Turn on cooling fan (disabled - may not be supported)',
            'M302 S0 ; Allow cold extrusion',
            'M412 S0 ; Disable filament runout detection for clay printing',
            'G92 E0 ; Reset Extruder',
            'M82 ; Use absolute distances for extrusion',
            'G28 ; Home',
            'G1 Z5.0 F3000 ; Move Z Axis up',
            'G92 E0 ; Reset Extruder',
            '',
            '; Clay system ready (no priming needed)',
            '; Extruder will start when first layer begins',
            '',
            '; Begin print job',
            ''
        ];
    }

    static getEndGcode() {
        const timestamp = new Date().toISOString();
        return [
            '',
            '; End G-code for Ender 3 V2 Neo',
            `; Completed: ${timestamp}`,
            '',
            '; Stop sequence',
            'M84 ;Disable all steppers',
            'G92 E0 ;Reset extruder position',
            '',
            '; Safe repositioning sequence',
            'G91 ;Relative positioning',
            'G1 Z10.0 F1200 ;Raise Z axis slowly',
            'G90 ;Absolute positioning',
            'G28 X ;Home X axis only',
            'G1 Y235 ;Present Y axis (move bed forward)',
            'M107 ;Turn off all fans',
            '; M106 S0 ;Turn-off fan (disabled - may not be supported)',
            '; Ensure all heaters are off (clay printing)',
            '; M104 S0 ; Turn off extruder heater (disabled - clay printing)',
            '; M140 S0 ; Turn off bed heater (disabled - clay printing)',
            '',
            'M84 X Y E ;Disable all steppers but Z',
            'M82 ;absolute extrusion mode',
            'M107 ; disable fans',
            '',
            '; DIRECTED 3D Clay Print Complete',
            ''
        ];
    }

    static generateCompleteGcode(layers, scaleFactor = null, gridOffset = null, gridSize = null) {
        try {
            // G-code generation started
            
            if (!layers || !Array.isArray(layers)) {
                console.error('Invalid layers data - not an array:', layers);
                throw new Error('Invalid layers data');
            }

            if (layers.length === 0) {
                console.error('No layers provided');
                throw new Error('No layers provided');
            }

            // Processing layers for G-code generation

            // Generate complete G-code
            const startGcode = this.getStartGcode();
            const endGcode = this.getEndGcode();
            
            const allGcode = [...startGcode];
            
            // Skirt generation removed - skirt is now handled as a regular layer
            
            // Sort layers to ensure skirt (index -1) is processed first
            const sortedLayers = [...layers].sort((a, b) => {
                const aIndex = (a.index !== undefined) ? a.index : 0;
                const bIndex = (b.index !== undefined) ? b.index : 0;
                return aIndex - bIndex;
            });
            
            // Add each layer's G-code
            for (let i = 0; i < sortedLayers.length; i++) {
                const layer = sortedLayers[i];
                const layerPoints = layer.points || layer;
                // Processing layer points
                
                // Use the layer's index property if available, otherwise use loop index
                const layerIndex = (layer.index !== undefined) ? layer.index : i;
                const layerGcode = this.fromLayer(layerPoints, layerIndex, scaleFactor, gridOffset, gridSize);
                allGcode.push(...layerGcode);
            }
            
            allGcode.push(...endGcode);
            
            const result = allGcode.join('\n');
            // G-code generation completed
            return result;

        } catch (error) {
            console.error('Error generating complete G-code:', error);
            throw error;
        }
    }

}

// Printer communication
class PrinterCommunication {
    constructor() {
        this.port = null;
        this.parser = null;
        this.isConnected = false;
        this.commandQueue = [];
        this.currentCommand = null;
        this.responseTimeout = null;
        this.acknowledgmentHandlers = new Map();
        this.commandId = 0;
        this.stopRequested = false; // Emergency stop flag
    }

    async connect(portPath = '/dev/ttyUSB0', baudRate = 115200) {
        // Native serialport not available (packaged exe / missing binding) — the caller
        // treats a false return exactly like a failed physical connection and falls back.
        if (!SerialPort) {
            console.log('SerialPort module unavailable — cannot open a real printer connection.');
            this.isConnected = false;
            return false;
        }

        // Disconnect first if already connected
        if (this.port && this.port.isOpen) {
            console.log('Closing existing connection...');
            this.port.close();
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        
        // Connect to real serial port
        try {
            console.log(`Creating new SerialPort connection to ${portPath} at ${baudRate} baud`);
            
            this.port = new SerialPort({
                path: portPath,
                baudRate: baudRate,
                autoOpen: true
            });

            this.parser = this.port.pipe(new ReadlineParser({ delimiter: '\n' }));
            
            return new Promise((resolve, reject) => {
                this.port.on('open', () => {
                    console.log('Serial port opened successfully');
                    this.isConnected = true;
                    this.setupResponseHandler();
                    this.setupErrorHandlers();
                    
                    // Test immediately with a simple command
                    setTimeout(() => {
                        console.log('Testing connection with M115...');
                        this.port.write('M115\n');
                    }, 1000);
                    
                    resolve(true);
                });
                
                this.port.on('error', (err) => {
                    console.log('Serial port error:', err.message);
                    this.isConnected = false;
                    resolve(false);
                });
            });
        } catch (error) {
            console.log('Serial port creation failed:', error.message);
            this.isConnected = false;
            return false;
        }
    }

    setupErrorHandlers() {
        if (!this.port) return;
        
        this.port.on('error', (err) => {
            console.error('SERIAL PORT ERROR:', err.message);
            this.isConnected = false;
        });
        
        this.port.on('close', () => {
            console.log('SERIAL PORT CLOSED');
            this.isConnected = false;
        });
        
        this.port.on('disconnect', () => {
            console.log('SERIAL PORT DISCONNECTED');
            this.isConnected = false;
        });
    }

    setupResponseHandler() {
        if (!this.parser) return;
        
        this.parser.on('data', (data) => {
            const response = data.toString().trim();
            
            // Handle busy responses - reset timeout but don't show in log
            if (response.toLowerCase().includes('busy')) {
                this.handleBusyResponse();
                return;
            }
            
            // Parse and forward meaningful printer responses to log
            this.parseAndForwardResponse(response);
            
            // Parse specific printer messages for enhanced status reporting
            this.parseSpecialResponses(response);
            
            // Check for various acknowledgment patterns
            const lowerResponse = response.toLowerCase();
            if (response === 'ok' || 
                response === 'OK' ||
                response.includes('Done') || 
                lowerResponse.includes('homing complete') ||
                lowerResponse.includes('home complete') ||
                lowerResponse === 'ok' ||
                /^ok\s*$/i.test(response)) {
                this.handleAcknowledgment();
            }
        });
    }

    parseAndForwardResponse(response) {
        // Always process responses, even if no socket is available
        // We'll emit to all connected sockets via io.emit instead of this.socket.emit
        
        const lowerResponse = response.toLowerCase();
        
        // Filter out technical responses that aren't useful to users
        if (response === 'ok' || response === 'Done' || lowerResponse.includes('wait') ||
            response.match(/^[A-Z]:\d+/) || // Skip coordinate responses like "X:100 Y:200"
            response.match(/[XYZ]:\s*-?\d+\.?\d*/) || // Skip coordinate values like "X:10.5 Y:20"
            response.match(/[XYZ]-?\d+\.?\d*/) || // Skip coordinates like "X10.5Y20"
            lowerResponse.includes('t:') || lowerResponse.includes('temp') || // Skip temperature reports for clay printing
            lowerResponse.includes('echo:invalid mesh') || 
            lowerResponse.includes('echo:failed bed leveling') ||
            lowerResponse.includes('echo:bed leveling off') ||
            lowerResponse.includes('echo:fade height') ||
            lowerResponse.includes('failed to enable bed leveling') || // Skip bed leveling echo messages
            lowerResponse.includes('cap:meatpack') || // Skip MEATPACK capability messages
            (lowerResponse.includes('cap:') && lowerResponse.includes('meatpack')) || // Skip all Cap: MEATPACK messages
            lowerResponse.includes('busy') || // Skip busy messages
            lowerResponse.includes('echo:') || // Skip all echo messages
            lowerResponse.includes('cap:') || // Skip all capability messages
            lowerResponse.includes('recv:') || // Skip recv messages
            lowerResponse.includes('send:') || // Skip send messages
            lowerResponse.includes('marlin') || // Skip Marlin firmware messages
            response.match(/^[a-z]+:\s*\d+/) || // Skip technical status messages like "free:1234"
            lowerResponse.includes('firmware') || // Skip firmware info
            lowerResponse.includes('compiled') || // Skip compilation info
            lowerResponse.includes('advanced') || // Skip advanced settings
            lowerResponse.includes('leveling') || // Skip leveling messages
            lowerResponse.includes('probe') || // Skip probe messages
            lowerResponse.includes('mesh') || // Skip mesh messages
            lowerResponse.includes('endstop') || // Skip endstop messages
            lowerResponse.includes('stepper') || // Skip stepper messages
            lowerResponse.includes('m115') || // Skip M115 responses
            lowerResponse.includes('machine type') || // Skip machine type info
            lowerResponse.includes('extruder count') || // Skip extruder count info
            response.match(/^[GMET]\d+/) || // Skip G-code, M-code, E, T commands
            response.match(/^\d+/) || // Skip numeric responses
            lowerResponse.includes('position') || // Skip position reports
            lowerResponse.includes('count') || // Skip count messages
            response.includes('//') || // Skip comment lines
            response.length < 3) { // Skip very short responses
            return;
        }
        
        // Translate common printer responses to user-friendly messages
        let userMessage = response;
        let status = 'info';
        
        // Homing progress
        if (lowerResponse.includes('homing') && lowerResponse.includes('x')) {
            userMessage = 'Homing X axis...';
        }
        else if (lowerResponse.includes('homing') && lowerResponse.includes('y')) {
            userMessage = 'Homing Y axis...';
        }
        else if (lowerResponse.includes('homing') && lowerResponse.includes('z')) {
            userMessage = 'Homing Z axis...';
        }
        
        // Endstop triggers
        else if (lowerResponse.includes('endstop') || lowerResponse.includes('triggered')) {
            if (lowerResponse.includes('x')) {
                userMessage = 'X axis reached home position';
                status = 'complete';
            } else if (lowerResponse.includes('y')) {
                userMessage = 'Y axis reached home position';
                status = 'complete';
            } else if (lowerResponse.includes('z')) {
                userMessage = 'Z axis reached home position';
                status = 'complete';
            }
        }
        
        // Error messages
        else if (lowerResponse.includes('error') || lowerResponse.includes('fail')) {
            status = 'error';
        }
        
        // Warning messages
        else if (lowerResponse.includes('warning') || lowerResponse.includes('warn')) {
            status = 'warning';
        }
        
        // Emit to the connected socket
        if (this.socket) {
            this.socket.emit('printer_response', {
                message: `Printer: ${userMessage}`,
                status: 'printer_friendly'
            });
        }
    }

    parseSpecialResponses(response) {
        const lowerResponse = response.toLowerCase();
        
        // Detect homing-related messages for status updates
        if (lowerResponse.includes('homing') || lowerResponse.includes('home')) {
            if (lowerResponse.includes('x')) {
                if (typeof io !== 'undefined') {
                    io.emit('printer_status', {
                        message: 'X axis homing...',
                        status: 'info'
                    });
                }
            } else if (lowerResponse.includes('y')) {
                if (typeof io !== 'undefined') {
                    io.emit('printer_status', {
                        message: 'Y axis homing...',
                        status: 'info'
                    });
                }
            } else if (lowerResponse.includes('z')) {
                if (typeof io !== 'undefined') {
                    io.emit('printer_status', {
                        message: 'Z axis homing...',
                        status: 'info'
                    });
                }
            } else if (lowerResponse.includes('complete') || lowerResponse.includes('done')) {
                if (typeof io !== 'undefined') {
                    io.emit('printer_status', {
                        message: 'Homing sequence completed',
                        status: 'complete'
                    });
                }
            }
        }
        
        // Detect axis movement completion
        if (lowerResponse.includes('x endstop') || lowerResponse.includes('x axis triggered')) {
            if (typeof io !== 'undefined') {
                io.emit('printer_status', {
                    message: 'X axis homed',
                    status: 'info'
                });
            }
        }
        if (lowerResponse.includes('y endstop') || lowerResponse.includes('y axis triggered')) {
            if (typeof io !== 'undefined') {
                io.emit('printer_status', {
                    message: 'Y axis homed',
                    status: 'info'
                });
            }
        }
        if (lowerResponse.includes('z endstop') || lowerResponse.includes('z axis triggered')) {
            if (typeof io !== 'undefined') {
                io.emit('printer_status', {
                    message: 'Z axis homed',
                    status: 'info'
                });
            }
        }
    }

    handleBusyResponse() {
        
        // Reset the timeout for the current command
        if (this.responseTimeout) {
            clearTimeout(this.responseTimeout);
        }
        
        if (this.currentCommand && this.acknowledgmentHandlers.has(this.currentCommand.id)) {
            const handler = this.acknowledgmentHandlers.get(this.currentCommand.id);
            const commandId = this.currentCommand.id;
            const command = this.currentCommand.command;
            
            // Set a new timeout
            this.responseTimeout = setTimeout(() => {
                if (this.acknowledgmentHandlers.has(commandId)) {
                    this.acknowledgmentHandlers.delete(commandId);
                    if (this.isConnected) {
                        handler.reject(new Error(`Command timeout after busy responses: ${command}`));
                    } else {
                        setTimeout(() => handler.resolve(), 100);
                    }
                }
            }, 30000); // Reset to 30 second timeout
        }
    }

    handleAcknowledgment() {
        if (this.responseTimeout) {
            clearTimeout(this.responseTimeout);
            this.responseTimeout = null;
        }

        if (this.currentCommand) {
            const handler = this.acknowledgmentHandlers.get(this.currentCommand.id);
            if (handler) {
                handler.resolve();
                this.acknowledgmentHandlers.delete(this.currentCommand.id);
            }
            this.currentCommand = null;
        }

        this.processNextCommand();
    }

    async sendCommand(command, timeout = 10000) {
        return new Promise((resolve, reject) => {
            // Check if emergency stop was requested
            if (this.stopRequested) {
                reject(new Error('Operation cancelled - stop requested'));
                return;
            }
            
            if (!this.isConnected || !this.port) {
                // Simulation mode
                setTimeout(() => resolve(), 100);
                return;
            }

            let timeoutId;
            
            // Send command directly and wait for response
            const responseHandler = (data) => {
                const response = data.toString().trim().toLowerCase();
                
                if (response === 'ok' || /^ok\s*$/i.test(response)) {
                    this.parser.off('data', responseHandler);
                    clearTimeout(timeoutId);
                    resolve();
                } else if (response.includes('busy')) {
                    // Printer is busy, reset timeout
                    clearTimeout(timeoutId);
                    timeoutId = setTimeout(() => {
                        this.parser.off('data', responseHandler);
                        reject(new Error(`Command timeout: ${command}`));
                    }, timeout);
                }
            };

            timeoutId = setTimeout(() => {
                this.parser.off('data', responseHandler);
                reject(new Error(`Command timeout: ${command}`));
            }, timeout);

            this.parser.on('data', responseHandler);
            this.port.write(command + '\n');
        });
    }

    processNextCommand() {
        if (this.currentCommand || this.commandQueue.length === 0) {
            return;
        }

        this.currentCommand = this.commandQueue.shift();
        
        if (this.isConnected && this.port) {
            // Send to real printer
            this.port.write(this.currentCommand.command + '\n');
        } else {
            // Pure simulation mode - auto acknowledge after short delay
            setTimeout(() => {
                this.handleAcknowledgment();
            }, 50);
        }
    }

    async home() {
        console.log('Sending complete initialization sequence...');
        
        // Send complete start G-code sequence (same as export G-code)
        await this.sendCommand('G21'); // Set units to millimeters
        await this.sendCommand('G90'); // Use absolute coordinates
        await this.sendCommand('M302 S0'); // Allow cold extrusion
        await this.sendCommand('G92 E0'); // Reset Extruder
        await this.sendCommand('M82'); // Use absolute distances for extrusion
        await this.sendCommand('M106 S200'); // Turn on cooling fan
        await this.sendCommand('G28'); // Home
        await this.sendCommand('G1 Z5.0 F3000'); // Move Z Axis up
        await this.sendCommand('G92 E0'); // Reset Extruder again
        
        console.log('Initialization sequence completed');
    }

    setSocket(socket) {
        this.socket = socket;
    }

    async sendGcode(gcodeLines) {
        for (let i = 0; i < gcodeLines.length; i++) {
            // Check if emergency stop was requested before each command
            if (this.stopRequested) {
                console.log(`G-code sending stopped at line ${i+1}/${gcodeLines.length} due to emergency stop`);
                throw new Error('G-code sending cancelled - stop requested');
            }
            
            const line = gcodeLines[i];
            if (line.trim() && !line.startsWith(';')) {
                try {
                    await this.sendCommand(line.trim());
                } catch (error) {
                    console.error(`[${i+1}/${gcodeLines.length}] Failed: ${line.trim()} - ${error.message}`);
                    throw error;
                }
            }
        }
    }

    // Emergency stop - clears all queues and stops all operations
    emergencyStop() {
        console.log('Emergency stop requested - clearing all operations');
        this.stopRequested = true;
        this.commandQueue = [];
        this.currentCommand = null;
        this.acknowledgmentHandlers.clear();
        
        // Clear any pending timeouts
        if (this.responseTimeout) {
            clearTimeout(this.responseTimeout);
            this.responseTimeout = null;
        }
    }
    
    // Reset stop flag (call this when starting new operations)
    resetStopFlag() {
        this.stopRequested = false;
    }

    disconnect() {
        if (this.port && this.isConnected) {
            this.port.close();
        }
        this.isConnected = false;
        this.stopRequested = false;
    }

    getStatus() {
        return {
            isConnected: this.isConnected,
            queueLength: this.commandQueue.length,
            currentCommand: this.currentCommand?.command || null
        };
    }
}

// Resolve which serial port to open. config.printerPort is the Raspberry-Pi default
// (/dev/ttyUSB0); on a Windows machine the printer enumerates as COMx instead, so
// auto-detect: prefer an explicit PRINTER_PORT env override, then the configured path
// if it actually exists, then the first port with a known USB-serial vendor
// (CH340 = Creality/Ender boards, FTDI, CP210x, Prusa, Arduino), then any port.
const USB_SERIAL_VENDORS = ['1a86', '0403', '10c4', '2c99', '2341'];
async function resolvePrinterPort(configured) {
    if (process.env.PRINTER_PORT) return process.env.PRINTER_PORT;
    if (!SerialPort || typeof SerialPort.list !== 'function') return configured;
    try {
        const ports = await SerialPort.list();
        if (!ports.length) {
            console.log('No serial ports detected — using configured port', configured);
            return configured;
        }
        console.log('Serial ports detected:', ports.map(p =>
            `${p.path}${p.vendorId ? ` (VID ${p.vendorId}${p.manufacturer ? ', ' + p.manufacturer : ''})` : ''}`).join('; '));
        if (ports.some(p => p.path === configured)) return configured;
        const usb = ports.find(p => p.vendorId && USB_SERIAL_VENDORS.includes(String(p.vendorId).toLowerCase()));
        if (usb) {
            console.log(`Auto-selected USB serial port ${usb.path}`);
            return usb.path;
        }
        // Deliberately NOT falling back to an arbitrary port: machines often expose
        // virtual COM ports (Bluetooth etc.) that would open but never acknowledge,
        // stalling the print flow. No recognised printer adapter → let the configured
        // port fail fast and drop into simulation. Power users: set PRINTER_PORT=COMx.
        console.log(`No known printer adapter among detected ports — using configured ${configured}. ` +
            `(Set the PRINTER_PORT environment variable to force a specific port.)`);
        return configured;
    } catch (e) {
        console.warn('Serial port scan failed:', e.message);
        return configured;
    }
}

// Initialize printer communication and print job
const printer = new PrinterCommunication();
const printJob = new PrintJob();

// Socket.IO connection handling
io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);
    
    // Set socket reference for printer communication
    printer.setSocket(socket);

    // Handle program start
    socket.on('programStarted', async () => {
        console.log('Program started - beginning homing sequence');

        // Clear any emergency-stop flag from a previous session so homing
        // commands are not rejected.
        printer.resetStopFlag();

        printJob.reset();
        printJob.state = 'homing';
        
        socket.emit('printer_status', {
            message: 'Print program started → homing printer…',
            status: 'homing'
        });

        try {
            // Connect to printer if not already connected
            if (!printer.isConnected) {
                const portPath = await resolvePrinterPort(config.printerPort);
                const connected = await printer.connect(portPath, config.baudRate);
                const status = printer.getStatus();
                
                if (connected) {
                    const printerType = 'real printer';
                    console.log(`Connected to ${printerType}`);
                } else {
                    socket.emit('printer_status', {
                        message: '! No printer connected - running in simulation mode !',
                        status: 'info'
                    });
                    console.log('! Running in pure simulation mode !');
                }
            }

            // Start homing
            await printer.home();
            printJob.isHomed = true;
            printJob.state = 'waiting_for_layers';
            
            socket.emit('homing_complete');
            socket.emit('printer_status', {
                message: 'Waiting for 5 layers...',
                status: 'complete'
            });

            // Check if we can start printing
            if (printJob.canStartPrinting()) {
                startPrinting(socket);
            }
        } catch (error) {
            console.error('Homing failed:', error);
            socket.emit('homing_failed', error.message);
            socket.emit('printer_status', {
                message: `Homing failed: ${error.message}`,
                status: 'error'
            });
            printJob.state = 'idle';
        }
    });

    // Handle direct homing command from frontend
    socket.on('home_printer', async () => {
        console.log('Received direct homing command from frontend');
        
        try {
            printJob.state = 'homing';
            
            socket.emit('printer_status', {
                message: 'Starting homing sequence...',
                status: 'homing'
            });

            // Start homing
            await printer.home();
            printJob.isHomed = true;
            printJob.state = 'idle';
            
            socket.emit('homing_complete');
            socket.emit('printer_status', {
                message: 'Ready.',
                status: 'complete'
            });
            
        } catch (error) {
            console.error('Direct homing failed:', error);
            socket.emit('homing_failed', error.message);
            socket.emit('printer_status', {
                message: `Homing failed: ${error.message}`,
                status: 'error'
            });
            printJob.state = 'idle';
        }
    });

    // Handle layer updates from frontend
    socket.on('layersUpdate', (data) => {
        
        // Handle different data formats from frontend
        const layers = data.layers || data;
        
        if (!layers || !Array.isArray(layers)) {
            return;
        }
        
        
        // Process and validate ALL layers (both user-made and interpolated)
        const processedLayers = layers
            .map((layer, index) => {
                // Check if layer is already processed (has points array) or needs extraction
                let points;
                if (layer.points && Array.isArray(layer.points)) {
                    // Layer is already processed by frontend
                    points = layer.points;
                } else {
                    // Layer needs point extraction
                    points = extractLayerPoints(layer);
                    if (points && points.length > 0) {
                        console.log(`Layer ${index}: ${layer.user_made ? 'User-made' : 'Interpolated'} with ${points.length} points`);
                    }
                }
                
                return points && points.length > 0 ? points : null;
            })
            .filter(points => points !== null); // Only layers with valid points
        
        // Separate skirt from regular layers
        const skirtLayer = processedLayers.find(layer => 
            layer.index === -1 || (layer.name && layer.name.toLowerCase().includes('skirt'))
        );
        const regularLayers = processedLayers.filter(layer => 
            layer.index !== -1 && (!layer.name || !layer.name.toLowerCase().includes('skirt'))
        );
        
        // Store layers
        printJob.availableLayers = regularLayers;
        printJob.skirtLayer = skirtLayer;
        printJob.totalAvailableLayers = regularLayers.length;
        

        // Start printing if conditions are met
        if (printJob.state === 'waiting_for_layers' && processedLayers.length >= printJob.minLayersToStart) {
            startPrinting(socket);
        }
    });

    // Extract printable points from frontend layer format (handles both user-made and interpolated)
    function extractLayerPoints(layerItem) {
        try {
            // Check if layer has any drawable content
            if (!layerItem) {
                return null;
            }

            // LayerItem has a getLayer() method that returns Paper.js layer
            const paperLayer = layerItem.getLayer ? layerItem.getLayer() : layerItem.layer;
            if (!paperLayer || !paperLayer.firstChild) {
                // For empty layers, return null (they will be skipped)
                return null;
            }

            const path = paperLayer.firstChild;
            if (!path || !path.segments || path.segments.length === 0) {
                return null;
            }

            // Extract points from Paper.js path segments
            const points = path.segments.map(segment => ({
                x: segment.point.x,
                y: segment.point.y
            }));

            // Ensure we have enough points for a valid path
            if (points.length < 2) {
                return null;
            }

            // Ensure path is closed by adding first point at end if needed
            if (points.length > 2) {
                const firstPoint = points[0];
                const lastPoint = points[points.length - 1];
                const distance = Math.sqrt(
                    Math.pow(firstPoint.x - lastPoint.x, 2) + 
                    Math.pow(firstPoint.y - lastPoint.y, 2)
                );
                
                // If not already closed, close it
                if (distance > 1.0) {
                    points.push({...firstPoint});
                }
            }

            return points;

        } catch (error) {
            console.error('Error extracting layer points:', error);
            return null;
        }
    }

    // Handle pause/resume/stop commands
    socket.on('pause_print', () => {
        console.log('Print pause requested');
        
        // Save current state for proper resume
        printJob.pausedState = {
            layerIndex: printJob.currentLayerIndex,
            layerProgress: printJob.currentLayerProgress,
            timestamp: Date.now()
        };
        
        printJob.state = 'paused';
        
        // Send immediate pause command to printer
        if (printer.isConnected) {
            printer.sendCommand('M600'); // Pause command
        }
        
        socket.emit('printer_status', {
            message: 'Print paused',
            status: 'paused'
        });
        socket.emit('print_paused');
    });

    socket.on('resume_print', async () => {
        console.log('Print resume requested');
        if (printJob.state === 'paused' && printJob.pausedState) {
            console.log('Resuming from saved state:', printJob.pausedState);
            
            // Send resume commands to printer
            if (printer.isConnected) {
                try {
                    // Resume from pause
                    await printer.sendCommand('M601'); // Resume command
                    
                    // Small delay to ensure printer processes resume
                    await new Promise(resolve => setTimeout(resolve, 500));
                    
                } catch (error) {
                    console.error('Error sending resume commands:', error);
                }
            }
            
            // Restore the saved state
            printJob.currentLayerIndex = printJob.pausedState.layerIndex;
            printJob.currentLayerProgress = printJob.pausedState.layerProgress;
            printJob.state = 'printing';
            printJob.pausedState = null; // Clear saved state
            
            socket.emit('printer_status', {
                message: 'Print resumed',
                status: 'printing'
            });
            socket.emit('print_resumed');
            
            // Resume layer processing from the correct point
            processNextLayer(socket);
        }
    });

    socket.on('stop_print', async () => {
        console.log('Print stop requested');
        printJob.state = 'stopping';

        try {
            // Halt the in-flight layer loop and clear all queued work first.
            // stopRequested stays set until the next print resets it, so a
            // pending sendGcode loop can never resume after the stop.
            printer.emergencyStop();

            // Clear print job queue
            printJob.layerQueue = [];
            printJob.currentLayerIndex = 0;
            printJob.totalLayers = 0;

            if (printer.isConnected && printer.port) {
                console.log('Emergency stop: halting moves and parking printer...');

                // sendCommand is blocked while stopRequested is set, so the
                // stop sequence is written raw - it must not wait in line
                // behind layer G-code acknowledgments.
                printer.port.write('M410\n');   // Stop all print moves immediately
                printer.port.write('M400\n');   // Wait for current moves to finish
                printer.port.write('G92 E0\n'); // Reset extruder position

                setTimeout(() => {
                    if (printer.isConnected && printer.port) {
                        printer.port.write('G91\n');              // Relative positioning
                        printer.port.write('G1 Z10.0 F1200\n');   // Move Z up 10mm
                        printer.port.write('G90\n');              // Absolute positioning
                        printer.port.write('G28 X\n');            // Home X axis
                        printer.port.write('G1 Y235 F3000\n');    // Present Y axis (move bed forward)
                        printer.port.write('M106 S0\n');          // Turn off print cooling fan
                        printer.port.write('M84\n');              // Disable steppers
                        console.log('Stop park sequence sent');
                    }
                }, 500); // Give M410/M400 time to halt motion before parking
            }

            // Reset print job state to idle to allow future operations
            printJob.state = 'idle';
            
            socket.emit('printer_status', {
                message: 'Print stopped - printer ready for next operation',
                status: 'stopped'
            });
        } catch (error) {
            console.error('Failed to send stop commands:', error);
            
            // Reset printer communication state on error
            if (printer.isConnected) {
                printer.commandQueue = [];
                printer.currentCommand = null;
                if (printer.acknowledgmentHandlers) {
                    printer.acknowledgmentHandlers.clear();
                    printer.acknowledgmentHandlers = new Map();
                }
            }
            
            printJob.state = 'idle'; // Reset to idle even on error
            
            socket.emit('printer_status', {
                message: 'Print stopped - manual intervention may be needed',
                status: 'error'
            });
        }
        
        socket.emit('print_stopped');
        
        // Send completion event to trigger completion screen with current G-code
        const completeGcode = printJob.generatedGcode.join('\n');
        socket.emit('printCompleted', { gcode: completeGcode });
    });

    // Handle manual G-code commands (flow rate, print speed, etc.)
    socket.on('manual_gcode', async (data) => {
        const { gcode, description } = data;
        console.log(`Manual G-code command: ${gcode} - ${description || 'No description'}`);
        
        try {
            if (printer.isConnected) {
                await printer.sendCommand(gcode);
                socket.emit('printer_status', {
                    message: description || `G-code sent: ${gcode}`,
                    status: 'info'
                });
                console.log(`Successfully sent manual G-code: ${gcode}`);
            } else {
                console.warn('Cannot send manual G-code: printer not connected');
                socket.emit('printer_status', {
                    message: 'Cannot send command: printer not connected',
                    status: 'error'
                });
            }
        } catch (error) {
            console.error('Error sending manual G-code:', error);
            socket.emit('printer_status', {
                message: `Error sending G-code: ${error.message}`,
                status: 'error'
            });
        }
    });

    // Pi-side interpolation handlers
    socket.on('interpolate_layers', (data) => {
        console.log('[PI INTERPOLATION] Received interpolation request');
        try {
            const { firstLayer, secondLayer, layerIndices, smoothFactor } = data;
            
            // Set smooth factor if provided
            if (smoothFactor !== undefined) {
                interpolationService.setSmoothFactor(smoothFactor);
            }
            
            // Perform interpolation calculation on Pi
            const interpolatedLayers = interpolationService.interpolateLayersBatch(
                firstLayer, 
                secondLayer, 
                layerIndices
            );
            
            // Send results back to iPad
            socket.emit('interpolation_complete', {
                success: true,
                layers: interpolatedLayers,
                processingTime: interpolatedLayers.length
            });
            
        } catch (error) {
            console.error('[PI INTERPOLATION] Error:', error);
            socket.emit('interpolation_complete', {
                success: false,
                error: error.message
            });
        }
    });

    socket.on('set_interpolation_smoothness', (smoothFactor) => {
        console.log(`[PI INTERPOLATION] Setting smooth factor to ${smoothFactor}`);
        interpolationService.setSmoothFactor(smoothFactor);
    });

    // Start printing function
    async function startPrinting(socket) {
        if (printJob.state === 'printing') return;
        
        // Reset emergency stop flag for new print job
        printer.resetStopFlag();
        
        printJob.state = 'printing';
        console.log(`Printer connected: ${printer.isConnected}`);
        
        socket.emit('printer_status', {
            message: 'Starting print job...',
            status: 'printing'
        });

        // Start layer processing directly (start G-code was already sent during homing)
        try {
            console.log('Beginning layer processing...');
            
            processNextLayer(socket);
        } catch (error) {
            console.error('Failed to start printing:', error);
            socket.emit('printer_status', {
                message: `Print start failed: ${error.message}`,
                status: 'error'
            });
            printJob.state = 'idle';
        }
    }

    // Process next layer
    async function processNextLayer(socket) {
        // Check if print is paused or stopped
        if (printJob.state === 'paused') {
            setTimeout(() => processNextLayer(socket), 1000);
            return;
        }

        // Any state other than an active print (stopping, stopped, idle,
        // completed) means a pending callback must die here, not keep polling.
        if (printJob.state !== 'printing') {
            return;
        }

        // Get next layer without automatically incrementing if we just resumed
        const layer = printJob.getNextLayer();
        
        if (!layer) {
            const maxLayers = OBJ_HEIGHT_LAYERS || 180;
            const currentLayerNumber = printJob.currentLayerIndex + 1;
            
            if (currentLayerNumber >= maxLayers) {
                console.log(`Reached max layers (${maxLayers}), completing print`);
                await completePrint(socket);
                return;
            } else {
                console.log(`No more layer data available, pausing at layer ${currentLayerNumber}/${maxLayers}`);
                printJob.state = 'paused';
                
                socket.emit('printer_status', {
                    message: `Paused: Waiting for more layers (currently at ${currentLayerNumber}/${maxLayers})`,
                    status: 'paused'
                });
                
                setTimeout(() => processNextLayer(socket), 2000);
                return;
            }
        }

        await processLayerData(layer, socket);
    }

    // Separate function to process layer data
    async function processLayerData(layer, socket) {
        // Layer index is already incremented by getNextLayer()
        const layerIndex = printJob.currentLayerIndex - 1;
        console.log(`Processing layer ${layerIndex + 1}/${printJob.totalAvailableLayers}`);
        
        // Tell frontend to lock this layer
        console.log(`BACKEND: Emitting layerStarted for layer ${layerIndex + 1}`);
        socket.emit('layerStarted', { layerIndex });
        socket.emit('printer_status', {
            message: `Layer ${layerIndex + 1} started - locking it.`,
            status: 'printing'
        });

        try {
            // Special handling for first layer - also process skirt if it exists
            if (layerIndex === 0 && printJob.skirtLayer) {
                console.log('Processing skirt before first layer...');
                
                // Notify frontend that skirt is starting
                console.log('BACKEND: Emitting skirtStarted');
                socket.emit('skirtStarted', {});
                socket.emit('printer_status', {
                    message: 'Skirt started - locking it.',
                    status: 'info'
                });
                
                const skirtPoints = printJob.skirtLayer.points || printJob.skirtLayer;
                const skirtGcode = GcodeGenerator.fromLayer(skirtPoints, -1);
                printJob.generatedGcode.push(...skirtGcode);
                await printer.sendGcode(skirtGcode);
                console.log('Skirt processed successfully');
            }
            
            // Convert layer to G-code and send to printer
            console.log(`Generating G-code for layer ${layerIndex + 1} with ${layer.length} points...`);
            const gcode = GcodeGenerator.fromLayer(layer, layerIndex);
            console.log(`Generated ${gcode.length} G-code lines for layer ${layerIndex + 1}`);
            printJob.generatedGcode.push(...gcode);
            
            console.log(`Sending layer ${layerIndex + 1} G-code to printer...`);
            await printer.sendGcode(gcode);
            console.log(`Layer ${layerIndex + 1} sent successfully`);
            
            socket.emit('layerCompleted', { layerIndex });
            socket.emit('printer_status', {
                message: `Layer ${layerIndex + 1} done.`,
                status: 'printing'
            });

            // Check if this was the final layer
            if (layerIndex + 1 === printJob.totalAvailableLayers) {
                console.log('Final layer completed - showing completion modal');
                const completeGcode = printJob.generatedGcode.join('\n');
                socket.emit('printCompleted', { gcode: completeGcode });
                
                // Continue with end sequence after a brief delay
                setTimeout(() => completePrint(socket), 1000);
            } else {
                // Process next layer
                setTimeout(() => processNextLayer(socket), 100);
            }
            
        } catch (error) {
            if (printer.stopRequested) {
                // Layer was cancelled by an emergency stop; stop_print owns
                // the printer state and client notifications from here.
                console.log(`Layer ${layerIndex + 1} halted by stop request`);
                return;
            }
            console.error(`Layer ${layerIndex + 1} failed:`, error);
            socket.emit('printer_status', {
                message: `Layer ${layerIndex + 1} failed: ${error.message}`,
                status: 'error'
            });
            printJob.state = 'idle';
        }
    }

    // Complete print with end sequence
    async function completePrint(socket) {
        console.log('Executing end sequence after print completion');
        
        try {
            const endGcode = GcodeGenerator.getEndGcode();
            printJob.generatedGcode.push(...endGcode);
            await printer.sendGcode(endGcode);
            
            socket.emit('printer_status', {
                message: 'End sequence completed.',
                status: 'complete'
            });
            
            printJob.state = 'completed';
        } catch (error) {
            console.error('Failed to send end G-code:', error);
            socket.emit('printer_status', {
                message: `End sequence failed: ${error.message}`,
                status: 'error'
            });
        }
    }

    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
    });
});

// Start server — fall back to the next free port if the preferred one is taken
// (e.g. macOS AirPlay Receiver permanently holds port 5000).
const PREFERRED_PORT = parseInt(process.env.PORT, 10) || config.serverPort;
const MAX_PORT_ATTEMPTS = 20;
let portAttempt = 0;

// Single persistent handler — reports the actual bound port so retries can't
// leave stale per-attempt callbacks that log the wrong port.
server.on('listening', () => {
    const actualPort = server.address().port;
    if (actualPort !== PREFERRED_PORT) {
        console.log(`Port ${PREFERRED_PORT} was in use — using next free port ${actualPort} instead.`);
    }
    console.log(`Server running on port ${actualPort}`);
    console.log(`Frontend available at http://localhost:${actualPort}`);
    console.log(`API status at http://localhost:${actualPort}/api/status`);

    console.log(`Real printer mode enabled`);

    // Standalone .exe (pkg snapshot): double-click UX — open the app in the default
    // browser automatically and tell the user how to stop. Dev runs are unaffected.
    if (process.pkg) {
        const url = `http://localhost:${actualPort}`;
        console.log('');
        console.log('  DIRECTED is running. Opening your browser…');
        console.log(`  If it does not open, browse to ${url}`);
        console.log('  Keep this window open while using the app; close it to quit.');
        const { exec } = require('child_process');
        const opener = process.platform === 'win32' ? `start "" "${url}"`
                     : process.platform === 'darwin' ? `open "${url}"`
                     : `xdg-open "${url}"`;
        exec(opener, (err) => { if (err) console.warn('Could not auto-open browser:', err.message); });
    }
});

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        portAttempt++;
        if (portAttempt <= MAX_PORT_ATTEMPTS) {
            const nextPort = PREFERRED_PORT + portAttempt;
            console.warn(`Port ${nextPort - 1} in use, trying ${nextPort}...`);
            setTimeout(() => server.listen(nextPort), 50);
        } else {
            console.error(`No free port found in range ${PREFERRED_PORT}-${PREFERRED_PORT + MAX_PORT_ATTEMPTS}. Exiting.`);
            process.exit(1);
        }
    } else {
        console.error('Server error:', err);
        process.exit(1);
    }
});

server.listen(PREFERRED_PORT);

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('Shutting down server...');
    printer.disconnect();
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});