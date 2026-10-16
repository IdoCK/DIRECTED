// Completion Screen Management
class CompletionScreen {
    constructor() {
        this.overlay = null;
        this.newSessionBtn = null;
        this.gcodeData = null; // Store the gcode data for export
        
        this.initializeElements();
        this.setupEventListeners();
    }
    
    initializeElements() {
        this.overlay = document.getElementById('completionOverlay');
        this.newSessionBtn = document.getElementById('newSessionBtn');
        this.exportGcodeBtn = document.getElementById('exportGcodeCompletionBtn');
        this.startDemoBtn = document.getElementById('startDemoBtn');
    }
    
    setupEventListeners() {
        // Export G-Code button
        if (this.exportGcodeBtn) {
            this.exportGcodeBtn.addEventListener('click', async () => {
                await this.exportGcode();
            });
        }
        
        // Start Demo Mode button
        if (this.startDemoBtn) {
            this.startDemoBtn.addEventListener('click', () => {
                this.startDemoMode();
            });
        }
        
        // New Session button
        if (this.newSessionBtn) {
            this.newSessionBtn.addEventListener('click', () => {
                this.startNewSession();
            });
        }
    }

    show(gcodeData = null) {
        this.gcodeData = gcodeData;

        if (this.overlay) {
            this.overlay.classList.add('active');

            // Enable the New Session button immediately
            if (this.newSessionBtn) {
                this.newSessionBtn.disabled = false;
            }
        }
    }

    hide() {
        if (this.overlay) {
            this.overlay.classList.remove('active');
        }
    }
    
    async exportGcode() {
        let gcodeToExport = this.gcodeData;
        
        // If no G-code data available, try to generate it from current layers
        if (!gcodeToExport) {
            console.log('No existing G-code data, generating from current layers...');
            try {
                if (window.printIntegration && typeof window.printIntegration.exportGcode === 'function') {
                    gcodeToExport = await window.printIntegration.exportGcode();
                } else {
                    throw new Error('Print integration module not available');
                }
            } catch (error) {
                console.error('Failed to generate G-code:', error);
                alert('Error generating G-code: ' + error.message + '\nPlease ensure you have created at least one layer.');
                return;
            }
        }
        
        if (!gcodeToExport) {
            console.warn('No G-code data available for export');
            alert('No G-code data available for export. Please create some layers first.');
            return;
        }
        
        try {
            // Create a blob with the G-code data
            const blob = new Blob([gcodeToExport], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            
            // Create filename with DIRECT3D prefix and timestamp
            const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
            const filename = `DIRECT3D_${timestamp}.gcode`;
            
            // Create a temporary download link
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            
            // Clean up the URL object
            URL.revokeObjectURL(url);
            
            console.log('G-code exported successfully as:', filename);
        } catch (error) {
            console.error('! Error exporting G-code: !', error);
            alert('Error exporting G-code. Please try again.');
        }
    }
    
    startDemoMode() {
        console.log('Starting demo mode...');
        // Set demo mode flag
        window.isDemoMode = true;
        
        // Hide completion screen and restart the application
        this.hide();
        this.restartApplication();
    }
    
    startNewSession() {
        console.log('Starting new session...');
        // Clear demo mode flag
        window.isDemoMode = false;
        
        // Hide completion screen and restart the application
        this.hide();
        this.restartApplication();
    }
    
    restartApplication() {
        // Reset application state
        if (window.layers) {
            // Clear all layers
            window.layers.forEach((layer, index) => {
                if (layer && layer.clear) {
                    layer.clear();
                }
            });
        }
        
        // Reset to splash screen or initial state
        // This would depend on your application's architecture
        if (window.showSplashScreen) {
            setTimeout(() => {
                window.showSplashScreen();
            }, 100);
        } else {
            // Fallback: reload the page
            setTimeout(() => {
                window.location.reload();
            }, 100);
        }
    }
}

// Initialize completion screen
const completionScreen = new CompletionScreen();

// Export for global access
window.completionScreen = completionScreen;

// Function to be called when print is complete
function onPrintComplete(gcodeData = null) {
    console.log('Print completed, showing completion screen');
    completionScreen.show(gcodeData);
    // Return the transport button to idle (Start Print) once the job ends.
    if (typeof window.setTransportIdle === 'function') window.setTransportIdle();
}

// Export the function for external use
window.onPrintComplete = onPrintComplete;