// Print Integration Module
console.log('Print Integration Module loaded');

// Helper function to add demo prefix to messages when in demo mode
function addPrinterMessage(message, status = 'info') {
    if (window.printerLog) {
        const finalMessage = (window.isDemoMode && window.printIntegration && window.printIntegration.useMockPrinter) 
            ? `Demo: ${message}` 
            : message;
        
        window.printerLog.addMessage({
            message: finalMessage,
            status: status
        });
    }
}

window.printIntegration = {
    socket: null,
    isConnected: false,
    isHoming: false,
    isPrinting: false,
    currentLayer: 0,
    lastGeneratedGcode: null, // Store the last generated G-code for export
    mockPrintPaused: false, // Track mock print pause state
    mockPrintTimeout: null, // Store timeout for mock print simulation
    demoLayerTimeout: null, // Store current layer printing timeout for demo mode
    connectionAttempts: 0,
    maxConnectionAttempts: 10,
    retryDelay: 1000,
    maxRetryDelay: 10000,
    connectionTimeout: null,
    networkFailsafeEnabled: true, // Enable network failsafe mechanisms

    // Initialize socket connection with robust retry logic
    init() {
        // Enable network monitoring for automatic failsafe
        if (this.networkFailsafeEnabled) {
            this.setupNetworkMonitoring();
        }
        
        if (typeof io !== 'undefined') {
            this.attemptConnection();
        } else {
            console.error('Socket.io not available - cannot connect to printer server');
            this.isConnected = false;
            this.updateConnectionStatus('failed');
        }
    },

    // Setup network monitoring for automatic failover
    setupNetworkMonitoring() {
        // Monitor online/offline status
        window.addEventListener('online', () => {
            console.log('Network connection restored');
            if (!this.isConnected) {
                console.log('Attempting to reconnect after network restoration...');
                this.connectionAttempts = 0;
                this.attemptConnection();
            }
        });

        window.addEventListener('offline', () => {
            console.log('Network connection lost');
            this.updateConnectionStatus('offline');
        });

        // Periodic connectivity check
        this.startConnectivityHeartbeat();
    },

    // Start periodic connectivity checks
    startConnectivityHeartbeat() {
        setInterval(() => {
            if (this.isConnected) {
                // Verify server is still reachable
                this.checkServerHealth()
                    .catch(() => {
                        console.log('Heartbeat failed - server may be unreachable');
                        if (this.socket && this.socket.connected) {
                            // Force disconnect to trigger reconnection logic
                            this.socket.disconnect();
                        }
                    });
            }
        }, 30000); // Check every 30 seconds
    },

    // Attempt connection with health check first
    attemptConnection() {
        this.connectionAttempts++;
        
        if (this.connectionAttempts > this.maxConnectionAttempts) {
            console.log('Max connection attempts reached, connection failed');
            this.isConnected = false;
            this.updateConnectionStatus('failed');
            return;
        }

        console.log(`Connection attempt ${this.connectionAttempts}/${this.maxConnectionAttempts}`);
        this.updateConnectionStatus('connecting', this.connectionAttempts);

        // First, try to reach the health endpoint to verify server is ready
        this.checkServerHealth()
            .then(() => {
                // Server is healthy, attempt Socket.IO connection
                this.connectToSocket();
            })
            .catch(() => {
                // Server not ready, retry after delay
                this.retryConnection();
            });
    },

    // Check if server is healthy before attempting Socket.IO connection
    checkServerHealth() {
        return new Promise((resolve, reject) => {
            const healthUrl = `${window.location.origin}/api/health`;
            
            fetch(healthUrl, {
                method: 'GET',
                timeout: 3000,
                headers: {
                    'Cache-Control': 'no-cache'
                }
            })
            .then(response => {
                if (response.ok) {
                    console.log('Server health check passed');
                    resolve();
                } else {
                    console.log('Server health check failed:', response.status);
                    reject();
                }
            })
            .catch(error => {
                console.log('Server health check error:', error);
                reject();
            });
        });
    },

    // Connect to Socket.IO after server health check passes
    connectToSocket() {
        this.socket = io(window.location.origin, {
            timeout: 5000,
            transports: ['websocket', 'polling'],
            forceNew: true,
            reconnection: false // We handle reconnection manually
        });
        
        this.setupSocketListeners();
        
        // Set timeout for this connection attempt
        this.connectionTimeout = setTimeout(() => {
            if (!this.isConnected) {
                console.log(`Socket.IO connection attempt ${this.connectionAttempts} failed, retrying...`);
                this.socket.disconnect();
                this.retryConnection();
            }
        }, 5000);
    },

    // Retry connection with exponential backoff
    retryConnection() {
        const delay = Math.min(this.retryDelay * Math.pow(1.5, this.connectionAttempts - 1), this.maxRetryDelay);
        const jitter = Math.random() * 1000; // Add up to 1 second jitter
        
        setTimeout(() => {
            this.attemptConnection();
        }, delay + jitter);
    },

    // Update connection status in UI
    updateConnectionStatus(status, attempt = null) {
        // Skip status updates for demo mode (they handle their own messages)
        if (window.isDemoMode || this.useMockPrinter) {
            return;
        }
        
        // Update both the printer log and any status indicators
        if (window.printerLog) {
            let message;
            let statusType = 'info';
            
            switch (status) {
                case 'connecting':
                    message = `Connecting to server... (attempt ${attempt}/${this.maxConnectionAttempts})`;
                    statusType = 'info';
                    break;
                case 'connected':
                    message = 'Connected to printer server successfully';
                    statusType = 'complete';
                    break;
                case 'failed':
                    message = 'Connection failed - no printer available';
                    statusType = 'error';
                    break;
                case 'disconnected':
                    message = 'Disconnected from server, attempting to reconnect...';
                    statusType = 'warning';
                    break;
                case 'offline':
                    message = 'Network offline - will reconnect when available';
                    statusType = 'warning';
                    break;
                default:
                    message = `Connection status: ${status}`;
                    statusType = 'info';
            }
            
            window.printerLog.addMessage({
                message: message,
                status: statusType
            });
        }

        // Update any status indicators in the UI
        this.updateUIStatusIndicators(status);
    },

    // Update visual status indicators in the UI
    updateUIStatusIndicators(status) {
        // Update connection indicator if it exists
        const indicator = document.querySelector('.connection-status');
        if (indicator) {
            indicator.className = `connection-status ${status}`;
            
            const statusText = indicator.querySelector('.status-text');
            if (statusText) {
                switch (status) {
                    case 'connecting':
                        statusText.textContent = 'Connecting...';
                        break;
                    case 'connected':
                        statusText.textContent = 'Connected';
                        break;
                    case 'disconnected':
                        statusText.textContent = 'Reconnecting...';
                        break;
                    default:
                        statusText.textContent = status;
                }
            }
        }

        // Update print button state based on connection
        const printButton = document.querySelector('#print-button');
        if (printButton) {
            if (status === 'connected') {
                printButton.disabled = false;
                printButton.title = 'Start print job';
            } else {
                printButton.disabled = true;
                printButton.title = 'Waiting for server connection...';
            }
        }
    },

    // Setup socket event listeners
    setupSocketListeners() {
        if (!this.socket) return;

        this.socket.on('connect', () => {
            this.isConnected = true;
            this.connectionAttempts = 0; // Reset attempts on successful connection
            console.log('Connected to printer backend');
            this.updateConnectionStatus('connected');
            
            // Clear connection timeout
            if (this.connectionTimeout) {
                clearTimeout(this.connectionTimeout);
                this.connectionTimeout = null;
            }
        });

        this.socket.on('disconnect', () => {
            this.isConnected = false;
            console.log('Disconnected from printer backend');
            this.updateConnectionStatus('disconnected');
            
            // Attempt to reconnect after disconnection
            setTimeout(() => {
                if (!this.isConnected) {
                    console.log('Attempting to reconnect...');
                    this.connectionAttempts = 0; // Reset for reconnection
                    this.attemptConnection();
                }
            }, 2000);
        });

        this.socket.on('connect_error', (error) => {
            console.log('Connection error:', error);
            this.isConnected = false;
        });

        this.socket.on('homing_complete', () => {
            this.isHoming = false;
            console.log('Homing completed');
            addPrinterMessage('Homing completed successfully', 'complete');
        });

        this.socket.on('homing_failed', (error) => {
            this.isHoming = false;
            console.error('Homing failed:', error);
            if (window.printerLog) {
                window.printerLog.addMessage({
                    message: `Homing failed: ${error}`,
                    status: 'error'
                });
            }
        });

        // Handle printer responses (real-time printer communication)
        this.socket.on('printer_response', (data) => {
            console.log('Printer response:', data.message);
            if (window.printerLog) {
                window.printerLog.addMessage({
                    message: data.message,
                    status: data.status || 'info'
                });
            }
        });

        // Handle printer status updates (homing progress, etc.)
        this.socket.on('printer_status', (data) => {
            console.log('Printer status:', data.message);
            if (window.printerLog) {
                window.printerLog.addMessage({
                    message: data.message,
                    status: data.status || 'info'
                });
            }
        });

        this.socket.on('layerStarted', ({ layerIndex }) => {
            console.log(`FRONTEND: Received layerStarted for layer ${layerIndex + 1}`);
            console.log(`FRONTEND: Calling lockLayer(${layerIndex})`);
            this.lockLayer(layerIndex);
        });
        
        this.socket.on('skirtStarted', () => {
            console.log('FRONTEND: Received skirtStarted');
            console.log('FRONTEND: Calling lockSkirtLayer()');
            this.lockSkirtLayer();
        });

        this.socket.on('layer_print_complete', (layerIndex) => {
            console.log(`Layer ${layerIndex + 1} printing completed`);
            if (window.printerLog) {
                window.printerLog.addMessage(`Layer ${layerIndex + 1} completed`);
            }
        });

        this.socket.on('print_complete', () => {
            this.isPrinting = false;
            console.log('All layers printing completed');
            if (window.printerLog) {
                window.printerLog.addMessage('Print job completed successfully');
            }
        });

        this.socket.on('printer_error', (error) => {
            console.error('Printer error:', error);
            if (window.printerLog) {
                window.printerLog.addMessage(`Error: ${error}`);
            }
        });

        this.socket.on('layer_info_request', () => {
            console.log('Backend requested layer information');
            const layerInfo = this.getLayerInfo();
            this.socket.emit('layer_info_response', layerInfo);
        });

        this.socket.on('layer_count_update', (data) => {
            console.log('Layer count update from backend:', data);
        });

        // Handle print completion
        this.socket.on('print_complete', (data) => {
            if (data.type === 'print_complete') {
                console.log('Print completed successfully');
                
                // Show completion screen with G-code data
                if (window.onPrintComplete) {
                    window.onPrintComplete(this.lastGeneratedGcode);
                }
                
                // Reset print state
                this.isPrinting = false;
                this.currentLayer = 0;
                
                return;
            }
        });

        // Handle print control responses
        this.socket.on('print_paused', () => {
            console.log('Print paused by server');
            this.isPrinting = false;
            if (window.printerLog) {
                window.printerLog.addMessage('Print paused');
            }
        });

        this.socket.on('print_resumed', () => {
            console.log('Print resumed by server');
            this.isPrinting = true;
            if (window.printerLog) {
                window.printerLog.addMessage('Print resumed');
            }
        });

        this.socket.on('print_stopped', () => {
            console.log('Print stopped by server');
            this.isPrinting = false;
            this.hideContourLoader();
            if (window.printerLog) {
                window.printerLog.addMessage('Print stopped');
            }
        });

        this.socket.on('printCompleted', (data) => {
            console.log('Print completed by server');
            this.isPrinting = false;
            this.currentLayer = 0;
            this.hideContourLoader();

            // Store the G-code data
            this.lastGeneratedGcode = data && data.gcode ? data.gcode : this.lastGeneratedGcode;

            // Show completion screen with G-code data
            if (window.onPrintComplete) {
                window.onPrintComplete(this.lastGeneratedGcode);
            }
        });
    },

    // Send homing command to printer
    sendHomingCommand(useMockPrinter = false) {
        return new Promise((resolve, reject) => {
            // Update mock printer setting based on parameter
            if (useMockPrinter) {
                this.useMockPrinter = true;
                console.log('Demo mode selected - switching to mock printer');
            }
            
            // Check if we should use mock printer
            if (this.useMockPrinter || !this.socket || !this.isConnected) {
                console.log('Using mock printer for homing...');
                this.simulateMockHoming()
                    .then(resolve)
                    .catch(reject);
                return;
            }

            if (this.isHoming) {
                reject(new Error('Homing already in progress'));
                return;
            }

            this.isHoming = true;
            console.log('Sending homing command...');
            
            addPrinterMessage('Starting homing sequence...', 'info');

            // Send homing command
            this.socket.emit('home_printer');

            // Set up timeout for homing
            const homingTimeout = setTimeout(() => {
                this.isHoming = false;
                reject(new Error('Homing timeout'));
            }, 30000); // 30 second timeout

            // Listen for homing completion
            const onHomingComplete = () => {
                clearTimeout(homingTimeout);
                this.socket.off('homing_complete', onHomingComplete);
                this.socket.off('homing_failed', onHomingFailed);
                resolve();
            };

            const onHomingFailed = (error) => {
                clearTimeout(homingTimeout);
                this.socket.off('homing_complete', onHomingComplete);
                this.socket.off('homing_failed', onHomingFailed);
                reject(new Error(error));
            };

            this.socket.on('homing_complete', onHomingComplete);
            this.socket.on('homing_failed', onHomingFailed);
        });
    },

    // Simulate mock homing process
    simulateMockHoming() {
        return new Promise((resolve) => {
            this.isHoming = true;
            const prefix = window.isDemoMode ? 'Demo:' : 'Mock:';
            console.log(`${prefix} Starting homing sequence...`);
            
            if (window.printerLog) {
                window.printerLog.addMessage({
                    message: `${prefix} Homing X axis...`,
                    status: 'info'
                });
            }
            
            setTimeout(() => {
                if (window.printerLog) {
                    window.printerLog.addMessage({
                        message: `${prefix} Homing Y axis...`,
                        status: 'info'
                    });
                }
                
                setTimeout(() => {
                    if (window.printerLog) {
                        window.printerLog.addMessage({
                            message: `${prefix} Homing Z axis...`,
                            status: 'info'
                        });
                    }
                    
                    setTimeout(() => {
                        this.isHoming = false;
                        console.log(`${prefix} Homing completed successfully`);
                        
                        if (window.printerLog) {
                            window.printerLog.addMessage({
                                message: `${prefix} Homing completed successfully`,
                                status: 'complete'
                            });
                        }
                        
                        resolve();
                    }, 1000);
                }, 1000);
            }, 1000);
        });
    },

    // Check for layers and start demo printing if enough layers exist
    checkAndStartDemoPrinting() {
        if (!window.isDemoMode) return;
        
        // Wait for layer system to initialize, then check for layers
        this.waitForLayersAndStartDemo();
    },
    
    // Wait for layers to be initialized and then start checking
    waitForLayersAndStartDemo(attempts = 0, hasShownWaitingMessage = false) {
        if (!window.isDemoMode) return;
        
        const maxAttempts = 10;
        
        // Try both window.layers and window.layersManager.layers
        let layersArray = null;
        if (window.layers && Array.isArray(window.layers)) {
            layersArray = window.layers;
        } else if (window.layersManager && window.layersManager.layers && Array.isArray(window.layersManager.layers)) {
            layersArray = window.layersManager.layers;
        }
        
        if (layersArray) {
            // Layers system is ready, now check for valid layers
            const validLayers = layersArray.filter(layer => layer && layer.layer !== null);
            
            if (validLayers.length >= 5) {
                // Auto-start printing with ALL available layers, not just first 5
                this.startLayerPrinting(validLayers);
            } else {
                // Only show the waiting message once
                if (!hasShownWaitingMessage) {
                    addPrinterMessage('Waiting for 5 layers...', 'complete');
                }
                // Keep checking periodically for new layers
                setTimeout(() => {
                    this.waitForLayersAndStartDemo(0, true);
                }, 2000);
            }
        } else {
            // Layers not ready yet
            if (attempts === 0) {
                addPrinterMessage('Waiting for layer system to initialize...', 'info');
            }
            
            if (attempts < maxAttempts) {
                setTimeout(() => {
                    this.waitForLayersAndStartDemo(attempts + 1, hasShownWaitingMessage);
                }, 500);
            } else {
                addPrinterMessage('Layer system initialization timeout. Please refresh.', 'error');
            }
        }
    },

    // Show the contour loader (set --path-len once; then add .visible)
    showContourLoader() {
        const loaderEl = document.querySelector('.contour-loader');
        if (!loaderEl) return;
        const pathEl = loaderEl.querySelector('path');
        if (pathEl && !loaderEl.dataset.pathLenSet) {
            loaderEl.style.setProperty('--path-len', pathEl.getTotalLength());
            loaderEl.dataset.pathLenSet = '1';
        }
        loaderEl.classList.add('visible');
    },

    // Hide the contour loader
    hideContourLoader() {
        const loaderEl = document.querySelector('.contour-loader');
        if (loaderEl) loaderEl.classList.remove('visible');
    },

    // Start printing layers
    startLayerPrinting(layers) {
        if (this.isPrinting) {
            console.error('Printing already in progress');
            addPrinterMessage('Printing already in progress', 'error');
            return;
        }

        this.isPrinting = true;
        this.showContourLoader();
        console.log(`Starting to print ${layers.length} layers...`);
        addPrinterMessage(`Starting to print ${layers.length} layers...`, 'info');
        

        if (this.useMockPrinter || !this.socket || !this.isConnected) {
            console.log('Using mock printer for layer printing...');
            addPrinterMessage('Using mock printer for layer printing...', 'info');
            // For demo mode, use the same layer processing as real printer mode
            this.simulateRealPrinterFlow();
            return;
        }

        // Process layers and convert to printer commands
        const layerData = this.processLayersForPrinting(layers);
        
        // Send layers to printer
        this.socket.emit('layersUpdate', { layers: layerData });
    },

    // Lock a layer when backend starts processing it
    lockLayer(layerIndex) {
        console.log(`PRINT-INTEGRATION: Locking layer ${layerIndex + 1}`);
        
        // Update layer material to PRINTED material in 3D view
        console.log(`PRINT-INTEGRATION: window.threeDModel exists:`, !!window.threeDModel);
        console.log(`PRINT-INTEGRATION: window.threeDModel.lockLayer exists:`, !!(window.threeDModel && window.threeDModel.lockLayer));
        if (window.threeDModel && window.threeDModel.lockLayer) {
            console.log(`PRINT-INTEGRATION: Calling window.threeDModel.lockLayer(${layerIndex})`);
            window.threeDModel.lockLayer(layerIndex);
        } else {
            console.warn(`PRINT-INTEGRATION: window.threeDModel.lockLayer not available`);
        }
        
        // Update layer slider visual feedback
        console.log(`PRINT-INTEGRATION: window.updateLayerSliderLock exists:`, !!window.updateLayerSliderLock);
        if (window.updateLayerSliderLock) {
            console.log(`PRINT-INTEGRATION: Calling window.updateLayerSliderLock(${layerIndex})`);
            window.updateLayerSliderLock(layerIndex);
        } else {
            console.warn(`PRINT-INTEGRATION: window.updateLayerSliderLock not available`);
        }
        
        // Mark layer as locked in layers array
        console.log(`PRINT-INTEGRATION: window.layers exists:`, !!window.layers);
        console.log(`PRINT-INTEGRATION: window.layers[${layerIndex}] exists:`, !!(window.layers && window.layers[layerIndex]));
        if (window.layers && window.layers[layerIndex]) {
            console.log(`PRINT-INTEGRATION: window.layers[${layerIndex}].setLocked exists:`, typeof window.layers[layerIndex].setLocked === 'function');
            if (typeof window.layers[layerIndex].setLocked === 'function') {
                console.log(`PRINT-INTEGRATION: Calling window.layers[${layerIndex}].setLocked(true)`);
                window.layers[layerIndex].setLocked(true);
            } else {
                console.warn(`PRINT-INTEGRATION: window.layers[${layerIndex}].setLocked not available`);
            }
        } else {
            console.warn(`PRINT-INTEGRATION: window.layers[${layerIndex}] not available`);
        }
        
        console.log(`PRINT-INTEGRATION: Layer ${layerIndex + 1} locking process completed`);
    },
    
    // Lock the skirt layer when it's printed
    lockSkirtLayer() {
        console.log('PRINT-INTEGRATION: Locking skirt layer');
        
        // Set the skirt LayerItem as printed
        if (window.skirtLayerItem && typeof window.skirtLayerItem.setLocked === 'function') {
            console.log('PRINT-INTEGRATION: Calling window.skirtLayerItem.setLocked(true)');
            window.skirtLayerItem.setLocked(true);
        } else {
            console.warn('PRINT-INTEGRATION: window.skirtLayerItem.setLocked not available');
        }
        
        // Update 3D mesh material to printed material
        if (window.threeDModel && window.threeDModel.lockSkirtLayer) {
            console.log('PRINT-INTEGRATION: Calling window.threeDModel.lockSkirtLayer()');
            window.threeDModel.lockSkirtLayer();
        } else {
            console.warn('PRINT-INTEGRATION: window.threeDModel.lockSkirtLayer not available');
        }
        
        console.log('PRINT-INTEGRATION: Skirt locking process completed');
    },

    // Simulate real printer flow - process ALL layers dynamically like real printer mode
    simulateRealPrinterFlow() {
        addPrinterMessage('Processing layers for printing...', 'info');
        
        // Process ALL available layers just like real printer mode does
        setTimeout(() => {
            this.simulateLayerProcessing();
        }, 1000);
    },
    
    // Simulate the layer-by-layer processing that real printer mode does
    simulateLayerProcessing(currentLayerIndex = -1) {
        if (!window.isDemoMode || !this.isPrinting) return;
        
        // Get current layers array (dynamically, like real printer mode)
        let layersArray = null;
        if (window.layers && Array.isArray(window.layers)) {
            layersArray = window.layers;
        } else if (window.layersManager && window.layersManager.layers && Array.isArray(window.layersManager.layers)) {
            layersArray = window.layersManager.layers;
        }
        
        if (!layersArray) {
            addPrinterMessage('Layer system no longer available', 'error');
            this.isPrinting = false;
            return;
        }
        
        // Handle skirt layer first (index -1)
        if (currentLayerIndex === -1) {
            // Update current layer for pause/resume tracking
            this.currentLayer = currentLayerIndex;
            
            // Skip if paused
            if (this.mockPrintPaused) {
                return;
            }
            
            // Check if skirt exists
            if (window.skirtLayerItem && layersArray.length > 0 && layersArray[0] && layersArray[0].layer !== null) {
                addPrinterMessage('Printing skirt...', 'printing');
                
                // Simulate skirt printing time
                this.demoLayerTimeout = setTimeout(() => {
                    if (!this.mockPrintPaused) {
                        // Lock the skirt layer - set its isPrinted to true and update 3D color
                        this.lockSkirtLayer();
                        
                        addPrinterMessage('Skirt completed', 'complete');
                        
                        // Continue to first layer (index 0)
                        setTimeout(() => {
                            this.simulateLayerProcessing(0);
                        }, 1000);
                    }
                }, 4000); // 4 seconds for skirt
            } else {
                // No skirt, go directly to first layer
                addPrinterMessage('No skirt found, starting with first layer...', 'info');
                setTimeout(() => {
                    this.simulateLayerProcessing(0);
                }, 500);
            }
            return;
        }
        
        // Handle regular layers (index 0+)
        if (currentLayerIndex < layersArray.length && layersArray[currentLayerIndex] && layersArray[currentLayerIndex].layer !== null) {
            // Update current layer for pause/resume tracking
            this.currentLayer = currentLayerIndex;
            
            // Skip if paused
            if (this.mockPrintPaused) {
                return;
            }
            
            // Lock the layer (like real printer mode does)
            this.lockLayer(currentLayerIndex);
            
            addPrinterMessage(`Printing layer ${currentLayerIndex + 1}...`, 'printing');
            
            // Simulate layer printing time
            this.demoLayerTimeout = setTimeout(() => {
                if (!this.mockPrintPaused) {
                    addPrinterMessage(`Layer ${currentLayerIndex + 1} completed`, 'complete');
                    
                    // Continue to next layer
                    setTimeout(() => {
                        this.simulateLayerProcessing(currentLayerIndex + 1);
                    }, 1000);
                }
            }, 4000); // 4 seconds per layer
            
        } else {
            // No more valid layers - check if we should wait or finish
            const totalValidLayers = layersArray.filter(layer => layer && layer.layer !== null).length;
            
            if (currentLayerIndex < totalValidLayers) {
                // There are more layers but current one is invalid, skip it
                setTimeout(() => {
                    this.simulateLayerProcessing(currentLayerIndex + 1);
                }, 100);
            } else {
                // We've processed all available layers
                if (currentLayerIndex < totalValidLayers) {
                    // Wait for more layers to be created
                    addPrinterMessage(`Waiting for layer ${currentLayerIndex + 1}...`, 'info');
                    setTimeout(() => {
                        this.simulateLayerProcessing(currentLayerIndex);
                    }, 2000); // Check again in 2 seconds
                } else {
                    // All layers are done - finish printing
                    this.isPrinting = false;
                    this.hideContourLoader();
                    addPrinterMessage('Print job completed successfully', 'complete');

                    // Show completion screen like real printer mode
                    if (window.onPrintComplete) {
                        setTimeout(() => {
                            window.onPrintComplete(this.lastGeneratedGcode);
                        }, 1000);
                    }
                }
            }
        }
    },

    // Toggle pause/resume for demo mode
    toggleDemoPause() {
        if (!window.isDemoMode || !this.isPrinting) return;
        
        this.mockPrintPaused = !this.mockPrintPaused;
        
        if (this.mockPrintPaused) {
            addPrinterMessage('Print paused', 'info');
            // Clear current layer timeout
            if (this.demoLayerTimeout) {
                clearTimeout(this.demoLayerTimeout);
                this.demoLayerTimeout = null;
            }
            // Update pause button UI to show play icon
            if (window.setPauseButtonState) {
                window.setPauseButtonState(true);
            }
        } else {
            addPrinterMessage('Print resumed', 'info');
            // Resume current layer processing (this.currentLayer can be -1 for skirt)
            setTimeout(() => {
                this.simulateLayerProcessing(this.currentLayer);
            }, 500);
            // Update pause button UI to show pause icon
            if (window.setPauseButtonState) {
                window.setPauseButtonState(false);
            }
        }
    },

    // Simulate mock printing process (kept for backward compatibility)
    simulateMockPrinting(layers) {
        const prefix = window.isDemoMode ? 'Demo:' : 'Mock:';
        console.log(`${prefix} Starting to print ${layers.length} layers...`);
        
        if (window.printerLog) {
            window.printerLog.addMessage({
                message: `${prefix} Print job started`,
                status: 'info'
            });
        }

        // Process layers
        const validLayers = layers.filter(layer => layer && layer.layer !== null);
        
        if (validLayers.length === 0) {
            if (window.printerLog) {
                window.printerLog.addMessage({
                    message: 'No valid layers to print',
                    status: 'info'
                });
            }
            return;
        }

        this.isPrinting = true;
        
        // Simulate printing each layer with delays
        validLayers.forEach((layer, index) => {
            setTimeout(() => {
                console.log(`${prefix} Printing layer ${index + 1}...`);
                
                if (window.printerLog) {
                    window.printerLog.addMessage({
                        message: `${prefix} Printing layer ${index + 1}`,
                        status: 'printing'
                    });
                }
                
                // Simulate layer completion
                setTimeout(() => {
                    if (window.printerLog) {
                        window.printerLog.addMessage({
                            message: `${prefix} Layer ${index + 1} completed`,
                            status: 'complete'
                        });
                    }
                    
                    // If this is the last layer, finish printing
                    if (index === validLayers.length - 1) {
                        setTimeout(() => {
                            this.isPrinting = false;
                            console.log(`${prefix} All layers printing completed`);
                            
                            if (window.printerLog) {
                                window.printerLog.addMessage({
                                    message: `${prefix} Print job completed successfully`,
                                    status: 'complete'
                                });
                            }
                        }, 500);
                    }
                }, 2000); // 2 seconds per layer
                
            }, index * 3000); // 3 second delay between layers
        });
    },

    // Process layer data for printing
    processLayersForPrinting(layers) {
        const processedLayers = [];
        
        console.log(`Processing ${layers.length} total layers for printing:`);

        // First, add the skirt layer - if Layer 1 exists, skirt exists
        if (layers.length > 0 && layers[0] && layers[0].layer !== null && window.skirtLayerItem) {
            const skirtPoints = window.skirtLayerItem.pointsAlongPath(100);
            if (skirtPoints.length > 0) {
                processedLayers.push({
                    index: -1,
                    name: 'Skirt',
                    points: skirtPoints,
                    userMade: false
                });
            }
        }

        for (let i = 0; i < layers.length; i++) {
            const layerItem = layers[i];
            console.log(`Layer ${i}: exists=${!!layerItem}, hasLayer=${layerItem && layerItem.layer !== null}, isUserMade=${layerItem ? layerItem.isUserMade() : 'N/A'}`);
            
            // Process ALL layers that have valid layer data, regardless of being user-made or program-made
            if (layerItem && layerItem.layer !== null) {
                try {
                    // Extract points along the path for printing
                    const points = layerItem.pointsAlongPath(100); // Get 100 points along the path
                    
                    if (points.length > 0) {
                        processedLayers.push({
                            index: i,
                            name: layerItem.name,
                            points: points,
                            userMade: layerItem.isUserMade()
                        });

                        console.log(`✓ Processed layer ${i + 1} (${layerItem.name}): ${points.length} points - ${layerItem.isUserMade() ? 'USER-MADE' : 'PROGRAM-MADE'}`);
                    } else {
                        console.warn(`! Layer ${i + 1} has no valid points !`);
                    }
                } catch (error) {
                    console.error(`Error processing layer ${i + 1}:`, error);
                }
            } else {
                console.log(`× Skipping layer ${i + 1}: ${!layerItem ? 'no layerItem' : 'no layer data'}`);
            }
        }

        console.log(`Final result: ${processedLayers.length} layers processed for printing (user-made + program-made)`);
        return processedLayers;
    },

    // Legacy function for compatibility
    startPrint() {
        console.log('Legacy startPrint called');
        // This can be used for other print operations if needed
    },

    // Send layer count updates to backend
    sendLayerUpdate() {
        console.log('sendLayerUpdate called');
        console.log('Mock mode:', this.useMockPrinter);
        console.log('Is connected:', this.isConnected);
        console.log('window.layers exists:', !!window.layers);
        console.log('window.layers type:', typeof window.layers);
        console.log('window.layers is array:', Array.isArray(window.layers));
        
        if (this.useMockPrinter) {
            console.log('Mock mode active - skipping server update but still processing layers');
        }
        
        if (!this.socket || !this.isConnected) {
            console.log('Not connected to server - skipping layer update');
            return;
        }

        if (window.layers && Array.isArray(window.layers)) {
            const layerArray = window.layers;
            console.log('Found layers array with length:', layerArray.length);
            
            // Count valid layers more accurately
            let validCount = 0;
            layerArray.forEach((layer, index) => {
                if (layer && typeof layer.getLayer === 'function') {
                    const layerData = layer.getLayer();
                    if (layerData) validCount++;
                }
            });
            
            const updateData = {
                layerCount: layerArray.length,
                validLayers: validCount,
                timestamp: Date.now()
            };

            // If we have enough layers to start printing, include the layer data
            if (validCount >= 5) {
                updateData.layers = this.processLayersForPrinting(layerArray.slice(0, validCount));
                console.log(`Sending layer update with ${validCount} layers for printing`);
            } else {
                console.log(`Sending layer update: ${validCount}/${layerArray.length} valid layers (not enough to start printing)`);
            }
            
            console.log('Update data:', updateData);
            
            this.socket.emit('layersUpdate', updateData);
        } else {
            console.warn('! Layers array not available or invalid for update !');
            console.log('window.layers value:', window.layers);
        }
    },

    // Get layer information from frontend
    getLayerInfo() {
        if (window.layers) {
            const layerArray = window.layers;
            const validLayers = layerArray.filter(layer => layer && layer.layer !== null);
            
            return {
                total: layerArray.length,
                valid: validLayers.length,
                firstFiveValid: layerArray.slice(0, 5).filter(layer => layer && layer.layer !== null).length,
                layers: layerArray.map((layer, index) => ({
                    index,
                    name: layer ? layer.name : null,
                    hasData: layer && layer.layer !== null,
                    userMade: layer ? layer.isUserMade() : false
                }))
            };
        }
        return { total: 0, valid: 0, firstFiveValid: 0, layers: [] };
    },

    // Test function to manually trigger layer update
    testLayerUpdate() {
        console.log('Testing layer update system...');
        console.log('Print integration available:', !!window.printIntegration);
        console.log('Layers array available:', !!window.layers);
        console.log('Socket connected:', this.isConnected);
        
        if (window.layers) {
            const layerInfo = this.getLayerInfo();
            console.log('Current layer info:', layerInfo);
        }
        
        this.sendLayerUpdate();
    },

    // Connect to printer (overridden for demo mode)
    connect() {
        // Check if we're in demo mode
        if (window.isDemoMode || this.useMockPrinter) {
            console.log('Demo mode: Using mock printer connection');
            this.connectToMockPrinter();
            return;
        }
        
        // Reset connection state
        this.isConnected = false;
        this.connectionAttempts = 0;
        
        // Start connection process
        this.attemptConnection();
    },
    
    connectToMockPrinter() {
        const prefix = window.isDemoMode ? 'Demo:' : 'Mock:';
        console.log(`${prefix} Connecting to mock printer...`);
        
        if (window.printerLog) {
            window.printerLog.addMessage({
                message: `${prefix} Connecting to mock printer...`,
                status: 'info'
            });
        }
        
        // Simulate connection delay
        setTimeout(() => {
            this.isConnected = true;
            console.log(`${prefix} Mock printer connected successfully`);
            
            if (window.printerLog) {
                window.printerLog.addMessage({
                    message: `${prefix} Mock printer connected successfully`,
                    status: 'complete'
                });
            }
            
            // After successful connection, start homing process
            setTimeout(() => {
                this.sendHomingCommand(true);
            }, 500);
            
        }, 1000);
    },
    
    sendToMockPrinter(data) {
        console.log('Mock printer received:', data);
        
        // Simulate printing process
        if (data.type === 'start_print') {
            this.simulateMockPrint();
        } else if (data.type === 'pause') {
            this.pauseMockPrint();
        } else if (data.type === 'resume') {
            this.resumeMockPrint();
        } else if (data.type === 'stop') {
            this.stopMockPrint();
        }
    },
    
    pauseMockPrint() {
        const prefix = window.isDemoMode ? 'Demo printer:' : 'Mock printer:';
        console.log(`${prefix} Print paused`);
        addPrinterMessage('Print paused', 'warning');
        this.mockPrintPaused = true;
        
        // Clear current layer timeout
        if (this.demoLayerTimeout) {
            clearTimeout(this.demoLayerTimeout);
            this.demoLayerTimeout = null;
        }
        
        // Update pause button UI to show play icon
        if (window.setPauseButtonState) {
            window.setPauseButtonState(true);
        }
    },
    
    resumeMockPrint() {
        const prefix = window.isDemoMode ? 'Demo printer:' : 'Mock printer:';
        console.log(`${prefix} Print resumed`);
        addPrinterMessage('Print resumed', 'info');
        this.mockPrintPaused = false;
        
        // Resume current layer processing (this.currentLayer can be -1 for skirt)
        setTimeout(() => {
            this.simulateLayerProcessing(this.currentLayer);
        }, 500);
        
        // Update pause button UI to show pause icon
        if (window.setPauseButtonState) {
            window.setPauseButtonState(false);
        }
    },
    
    stopMockPrint() {
        const prefix = window.isDemoMode ? 'Demo printer:' : 'Mock printer:';
        console.log(`${prefix} Print stopped`);
        this.mockPrintPaused = false;
        this.isPrinting = false;
        this.hideContourLoader();

        // Clear any ongoing print simulation
        if (this.mockPrintTimeout) {
            clearTimeout(this.mockPrintTimeout);
            this.mockPrintTimeout = null;
        }
        // Clear the active demo-path timer (demoLayerTimeout is the live timer in simulateLayerProcessing)
        if (this.demoLayerTimeout) {
            clearTimeout(this.demoLayerTimeout);
            this.demoLayerTimeout = null;
        }
    },

    send(data) {
        // Check if we're in demo mode
        if (window.isDemoMode) {
            this.sendToMockPrinter(data);
            return;
        }
        
        // Send to real printer via socket
        if (this.socket && this.isConnected) {
            this.socket.emit(data.type, data);
        }
    },

    // Export G-code by calling backend API
    async exportGcode() {
        try {
            // Get current layers
            if (!window.layers || !Array.isArray(window.layers)) {
                throw new Error('No layers available for G-code export');
            }

            // Process layers for export using existing logic - but reduce point density
            const processedLayers = [];
            
            // First, add the skirt layer - if layers exist, skirt exists
            if (window.layers.length > 0 && window.layers[0] && window.layers[0].layer !== null && window.skirtLayerItem) {
                const skirtPoints = window.skirtLayerItem.pointsAlongPath(300);
                if (skirtPoints.length > 0) {
                    processedLayers.push({
                        index: -1,
                        name: 'Skirt',
                        points: skirtPoints,
                        userMade: false
                    });
                }
            }
            
            for (let i = 0; i < window.layers.length; i++) {
                const layerItem = window.layers[i];
                if (layerItem && layerItem.layer !== null) {
                    try {
                        const points = layerItem.pointsAlongPath(300); // Reduced from 1000 to 100 for smoother movement

                        // Ensure path is tightly closed by making last point match first point exactly
                        if (points.length > 2) {
                            const firstPoint = points[0];
                            const lastPoint = points[points.length - 1];
                            
                            // Check if path needs to be closed (points are not already very close)
                            const dx = firstPoint.x - lastPoint.x;
                            const dy = firstPoint.y - lastPoint.y;
                            const distance = Math.sqrt(dx * dx + dy * dy);
                            
                            if (distance > 0.1) { // If gap is larger than 0.1 pixels
                                // Replace last point with exact copy of first point for tight closure
                                points[points.length - 1] = { x: firstPoint.x, y: firstPoint.y };
                            }
                        }
                        
                        if (points.length > 0) {
                            processedLayers.push({
                                index: i,
                                name: layerItem.name,
                                points: points,
                                userMade: layerItem.isUserMade()
                            });
                        }
                    } catch (error) {
                        console.error(`Error processing layer ${i + 1}:`, error);
                    }
                }
            }
            
            if (processedLayers.length === 0) {
                throw new Error('No valid layers found for G-code export. Please create some layers first.');
            }

            console.log(`Requesting G-code export for ${processedLayers.length} layers`);
            console.log('Processed layers:', processedLayers);

            // Check payload size and add scale factor
            // window.scaleFactor = BED_SIZE / gridSize, but we need gridSize / BED_SIZE
            // So we need to invert it to get pixels per mm
            const gridScaleFactor = window.scaleFactor ? (1 / window.scaleFactor) : (window.innerWidth / 263);
            console.log('Scale factor calculation:', { 
                windowScaleFactor: window.scaleFactor,
                invertedScaleFactor: gridScaleFactor,
                fallbackUsed: !window.scaleFactor,
                bedSizeMm: 220
            });
            
            const payloadData = {
                layers: processedLayers,
                scaleFactor: gridScaleFactor,
                windowWidth: window.innerWidth,
                bedSize: 220, // Actual bed size in mm
                gridBased: true, // Indicate this is grid-based scaling
                gridOffset: {
                    x: window.gridStartX || 0,
                    y: window.gridStartY || 0
                },
                gridSize: window.gridSize || 220
            };
            const payloadString = JSON.stringify(payloadData);
            const payloadSize = new Blob([payloadString]).size;
            console.log(`Payload size: ${payloadSize} bytes (${(payloadSize / 1024 / 1024).toFixed(2)} MB)`);

            // Call backend API for G-code generation
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 60000); // 60 second timeout
            
            const response = await fetch('/api/export-gcode', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': payloadString.length.toString()
                },
                body: payloadString,
                signal: controller.signal
            });
            
            clearTimeout(timeoutId);

            console.log('Response status:', response.status);
            console.log('Response ok:', response.ok);
            console.log('Response statusText:', response.statusText);

            if (!response.ok) {
                const errorText = await response.text();
                console.error('Backend error response:', errorText);
                console.error('Full response object:', response);
                throw new Error(`Backend G-code generation failed: ${response.status} ${response.statusText} - ${errorText}`);
            }

            const gcode = await response.text();
            
            // Store generated G-code for export
            this.lastGeneratedGcode = gcode;
            
            console.log('G-code export completed successfully');
            return this.lastGeneratedGcode;

        } catch (error) {
            console.error('Error exporting G-code:', error);
            throw error;
        }
    },

    // ...existing code...
};

// Initialize when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    window.printIntegration.init();
});