// Setting Popup functionality
document.addEventListener('DOMContentLoaded', function() {
    
    // Function to dynamically adjust control button positioning
    const adjustControlButtonPosition = () => {
        // Focus mode (Layout 6): #topBar is a content-sized pill with a static
        // #topBarCenter, so the margin hack would shove the transport off-center.
        // The pill is content-sized and centered via transform; this margin hack would
        // shove it off-center, so clear any stale inline margin and no-op in focus mode.
        const topBarCenter = document.getElementById('topBarCenter');
        if (document.body.classList.contains('app-started')) {
            if (topBarCenter) topBarCenter.style.removeProperty('margin-left');
            return;
        }
        // At <=900px the responsive CSS (B7) flow-positions #topBarCenter; the JS
        // margin hack would push it incorrectly, so skip it at narrow widths.
        if (window.innerWidth <= 900) return;
        const topBarSettings = document.getElementById('topBarSettings');

        if (topBarSettings && topBarCenter) {
            // Get the actual width of the settings section
            const settingsWidth = topBarSettings.offsetWidth;

            // Simple approach: move controls left based on settings width
            let marginAdjustment = 0;

            // If settings are wider than 280px, start moving controls left (smaller threshold)
            if (settingsWidth > 280) {
                const extraWidth = settingsWidth - 280;
                marginAdjustment = -(extraWidth / 2); // Much more aggressive movement
            }

            // Use margin-left to move the controls - aggressive movement to match menu gap
            topBarCenter.style.setProperty('margin-left', marginAdjustment + 'px', 'important');
        }
    };
    
    // Initial adjustment
    adjustControlButtonPosition();
    
    // Expose function globally for use by other modules
    window.adjustControlButtonPosition = adjustControlButtonPosition;
    
    // Adjust on window resize
    window.addEventListener('resize', adjustControlButtonPosition);
    
    // Adjust when text size changes (observe the settings section for changes)
    const resizeObserver = new ResizeObserver(() => {
        adjustControlButtonPosition();
    });
    
    // Also watch for any DOM changes in the settings section
    const mutationObserver = new MutationObserver(() => {
        adjustControlButtonPosition();
    });
    
    const topBarSettings = document.getElementById('topBarSettings');
    if (topBarSettings) {
        resizeObserver.observe(topBarSettings);
        mutationObserver.observe(topBarSettings, { 
            childList: true, 
            subtree: true, 
            attributes: true, 
            attributeFilter: ['class', 'style']
        });
    }
    const settingButtons = {
        'flowRateBtn': 'flowRatePopup',
        'printSpeedBtn': 'printSpeedPopup',
        'interpBtn': 'interpPopup'
    };

    const sliders = {
        'flowSliderPopup': 'flowRateValue',
        'speedSliderPopup': 'printSpeedValue',
        'interpSliderPopup': 'interpValue'
    };

    let activePopup = null;

    // Helper function to close popup with animation
    const closePopup = (popup, button) => {
        popup.classList.add('closing');
        button.classList.remove('active');
        
        // Hide popup after animation completes
        setTimeout(() => {
            popup.style.display = 'none';
            popup.classList.remove('closing');
        }, 200); // Match animation duration
    };

    // Add click handlers for setting buttons
    Object.keys(settingButtons).forEach(buttonId => {
        const button = document.getElementById(buttonId);
        const popupId = settingButtons[buttonId];
        const popup = document.getElementById(popupId);

        if (button && popup) {
            button.addEventListener('click', function(e) {
                e.stopPropagation();
                
                // Don't allow popup in demo mode for printer-dependent settings
                if (window.isDemoMode && (buttonId === 'flowRateBtn' || buttonId === 'printSpeedBtn')) {
                    return;
                }
                
                // Close any other open popup
                if (activePopup && activePopup !== popup) {
                    // Find the button associated with the active popup
                    const activeButtonId = Object.keys(settingButtons).find(id => 
                        settingButtons[id] === activePopup.id
                    );
                    const activeButton = activeButtonId ? document.getElementById(activeButtonId) : null;
                    
                    if (activeButton) {
                        closePopup(activePopup, activeButton);
                    }
                }

                // Toggle current popup
                if (popup.style.display === 'block') {
                    closePopup(popup, button);
                    activePopup = null;
                } else {
                    // Position popup with right edge aligned to button's right edge
                    const buttonRect = button.getBoundingClientRect();
                    popup.style.left = buttonRect.right + 'px';
                    popup.style.top = buttonRect.bottom + 'px';
                    popup.style.transform = 'translateX(-100%)';
                    
                    popup.style.display = 'block';
                    button.classList.add('active');
                    activePopup = popup;
                }
            });
        }
    });

    // Add input handlers for sliders with proper formatting
    const formatValue = (sliderId, value) => {
        switch(sliderId) {
            case 'flowSliderPopup':
                return value + '%';
            case 'speedSliderPopup':
                return value + '\nmm/s';
            case 'interpSliderPopup':
                return parseFloat(value).toFixed(2);
            default:
                return value;
        }
    };

    Object.keys(sliders).forEach(sliderId => {
        const slider = document.getElementById(sliderId);
        const valueDisplayId = sliders[sliderId];
        const valueDisplay = document.getElementById(valueDisplayId);

        if (slider && valueDisplay) {
            // Initialize value display with proper formatting
            valueDisplay.textContent = formatValue(sliderId, slider.value);

            // Update value display on slider change with proper formatting
            slider.addEventListener('input', function() {
                valueDisplay.textContent = formatValue(sliderId, this.value);
                
                // Handle interpolation smoothness changes
                if (sliderId === 'interpSliderPopup') {
                    const value = parseFloat(this.value);
                    if (window.interpolate && window.interpolate.setSmoothFactor) {
                        window.interpolate.setSmoothFactor(value);
                    }
                    if (window.piInterpolation && window.piInterpolation.updateSmoothness) {
                        window.piInterpolation.updateSmoothness(value);
                    }
                }
                
                // Handle flow rate changes (extruder control)
                if (sliderId === 'flowSliderPopup') {
                    const flowRate = parseInt(this.value);
                    sendFlowRateCommand(flowRate);
                }
                
                // Handle print speed changes (all steppers)
                if (sliderId === 'speedSliderPopup') {
                    const printSpeed = parseInt(this.value);
                    sendPrintSpeedCommand(printSpeed);
                }
            });
        }
    });

    // Close popups when clicking outside
    document.addEventListener('click', function(e) {
        if (activePopup && !activePopup.contains(e.target)) {
            // Find the button associated with the active popup
            const activeButtonId = Object.keys(settingButtons).find(id => 
                settingButtons[id] === activePopup.id
            );
            const activeButton = activeButtonId ? document.getElementById(activeButtonId) : null;
            
            if (activeButton) {
                closePopup(activePopup, activeButton);
            }
            activePopup = null;
        }
    });

    // Prevent popup from closing when clicking inside it
    document.querySelectorAll('.setting-popup').forEach(popup => {
        popup.addEventListener('click', function(e) {
            e.stopPropagation();
        });
    });
    
    // Function to send flow rate command (M221 - Set Flow Rate)
    function sendFlowRateCommand(flowRate) {
        if (!window.printIntegration || window.isDemoMode) {
            console.log(`Demo: Flow rate set to ${flowRate}%`);
            return;
        }
        
        const gcode = `M221 S${flowRate}`; // M221 S<percent> - Set extruder flow rate percentage
        
        if (window.printIntegration.socket && window.printIntegration.isConnected) {
            window.printIntegration.socket.emit('manual_gcode', {
                gcode: gcode,
                description: `Set flow rate to ${flowRate}%`
            });
            console.log(`Sent flow rate command: ${gcode}`);
        } else {
            console.warn('Cannot send flow rate command: printer not connected');
        }
    }
    
    // Function to send print speed command (M220 - Set Speed Factor)
    function sendPrintSpeedCommand(printSpeed) {
        if (!window.printIntegration || window.isDemoMode) {
            console.log(`Demo: Print speed set to ${printSpeed} mm/s`);
            return;
        }
        
        // Convert mm/s to percentage of base speed (assuming base speed is 20 mm/s = 1200 mm/min)
        const baseSpeedMmS = 20; // 1200 mm/min = 20 mm/s
        const speedPercent = Math.round((printSpeed / baseSpeedMmS) * 100);
        const gcode = `M220 S${speedPercent}`; // M220 S<percent> - Set speed factor percentage
        
        if (window.printIntegration.socket && window.printIntegration.isConnected) {
            window.printIntegration.socket.emit('manual_gcode', {
                gcode: gcode,
                description: `Set print speed to ${printSpeed} mm/s (${speedPercent}%)`
            });
            console.log(`Sent print speed command: ${gcode} (${printSpeed} mm/s = ${speedPercent}%)`);
        } else {
            console.warn('Cannot send print speed command: printer not connected');
        }
    }
});