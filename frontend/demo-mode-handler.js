// Demo mode handler - disables buttons that require printer connection
document.addEventListener('DOMContentLoaded', function() {
    // Function to check and apply demo mode restrictions
    function updateButtonStatesForDemoMode() {
        const isDemoMode = window.isDemoMode;
        
        // Buttons that should be disabled in demo mode
        const buttonsToDisable = [
            // 'pauseButton' - Allow pause button in demo mode so users can pause mock printing
            'flowRateBtn',    // Flow Rate button
            'printSpeedBtn'   // Print Speed button
        ];
        
        buttonsToDisable.forEach(buttonId => {
            const button = document.getElementById(buttonId);
            if (button) {
                if (isDemoMode) {
                    button.classList.add('disabled');
                    button.disabled = true;
                } else {
                    button.classList.remove('disabled');
                    button.disabled = false;
                }
            }
        });
        
        // Close any open setting popups if we're in demo mode
        if (isDemoMode) {
            const settingPopups = document.querySelectorAll('.setting-popup');
            settingPopups.forEach(popup => {
                if (popup.style.display === 'block') {
                    popup.style.display = 'none';
                }
            });
            
            // Remove active class from setting buttons
            const settingButtons = document.querySelectorAll('.setting-button');
            settingButtons.forEach(btn => {
                btn.classList.remove('active');
            });
        }
    }
    
    // Initial check after DOM is loaded
    updateButtonStatesForDemoMode();
    
    // Listen for demo mode changes
    const originalSetMode = window.setDemoMode;
    window.setDemoMode = function(isDemoMode) {
        window.isDemoMode = isDemoMode;
        updateButtonStatesForDemoMode();
        if (originalSetMode) {
            originalSetMode(isDemoMode);
        }
    };
    
    // Check for changes periodically (in case isDemoMode changes)
    let lastDemoModeState = window.isDemoMode;
    setInterval(() => {
        if (window.isDemoMode !== lastDemoModeState) {
            lastDemoModeState = window.isDemoMode;
            updateButtonStatesForDemoMode();
        }
    }, 1000);
    
    // Override setting button click handlers to prevent action in demo mode
    const originalSettingPopupCode = document.querySelector('script[src="setting-popups.js"]');
    if (originalSettingPopupCode) {
        // Add event listener to prevent setting button clicks in demo mode (except blend smoothness)
        document.addEventListener('click', function(e) {
            const settingButton = e.target.closest('.setting-button');
            if (window.isDemoMode && settingButton) {
                // Allow blend smoothness button to work in demo mode
                if (settingButton.id === 'interpBtn') {
                    return;
                }
                e.preventDefault();
                e.stopPropagation();
                return false;
            }
        }, true); // Use capture phase to intercept early
    }
});