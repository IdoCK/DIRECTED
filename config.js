// Frontend files are now in the frontend directory
// This file serves as the main entry point for the integrated system

// Configuration for different environments
const CONFIG = {
    development: {
        useMockPrinter: true,
        serverPort: 5000,
        logLevel: 'debug',
        printerPort: '/dev/ttyUSB0',
        baudRate: 115200
    },
    production: {
        useMockPrinter: false,
        serverPort: process.env.PORT || 80,  // Port 80 for captive portal
        logLevel: 'info',
        printerPort: '/dev/ttyUSB0',         // Raspberry Pi USB connection to Ender 3
        baudRate: 115200,                   // Standard Ender 3 V2 Neo baud rate
        enableHotspot: true,                // Enable WiFi hotspot mode
        hotspotSSID: 'DIRECTED-3D-Printer',
        allowOrigins: ['*']                 // Allow all origins for captive portal
    }
};

// Default to development if NODE_ENV is not set (common on Windows)
const environment = process.env.NODE_ENV || 'development';
const config = CONFIG[environment];

console.log(`Starting DIRECTED 3D Printer Control System`);
console.log(`Environment: ${environment}`);
console.log(`Mock Printer: ${config.useMockPrinter ? 'Enabled' : 'Disabled'}`);
console.log(`Server Port: ${config.serverPort}`);

module.exports = config;
