// User Preferences Modal functionality
import { setColorScheme } from './consts.js';

// Default preferences
let userPreferences = {
    textSize: 'medium',
    darkMode: false,
    printerLogVisible: true,
    defaultColorScheme: 'TECHNICAL'
};

document.addEventListener('DOMContentLoaded', function() {
    const userPreferencesBtn = document.getElementById('userPreferencesBtn');
    const userPreferencesModal = document.getElementById('userPreferencesModal');
    const darkModeModal = document.getElementById('darkModeModal');
    const savePreferencesBtn = document.getElementById('savePreferencesBtn');
    const cancelPreferencesBtn = document.getElementById('cancelPreferencesBtn');
    const darkModeToggle = document.getElementById('darkModeToggle');
    const printerLogToggle = document.getElementById('printerLogToggle');
    const darkModeOkBtn = document.getElementById('darkModeOkBtn');
    const defaultColorScheme = document.getElementById('defaultColorScheme');
    
    let preferencesOnOpen;

    // Text size buttons
    const textSizeButtons = document.querySelectorAll('.text-size-btn');
    
    // Load saved preferences
    loadPreferences();
    
    // Initialize UI with current preferences
    updateUI();
    
    // Open preferences modal
    function openPreferencesModal() {
        preferencesOnOpen = { ...userPreferences };
        console.log('Opening user preferences modal');
        
        if (userPreferencesModal) {
            userPreferencesModal.classList.add('active');
            console.log('Modal activated');
        } else {
            console.error('User preferences modal not found');
        }
        
        // Close dropdown menu if open
        const dropdownMenu = document.getElementById('dropdownMenu');
        const menuButton = document.getElementById('menuButton');
        if (dropdownMenu && dropdownMenu.classList.contains('open')) {
            dropdownMenu.classList.remove('open');
            if (menuButton) {
                menuButton.classList.remove('open');
            }
            // Re-enable main program interactions if the function is available
            if (typeof window.enableMainInteractions === 'function') {
                window.enableMainInteractions();
            }
            console.log('Closed dropdown menu when opening user preferences');
        }
    }
    
    // Close preferences modal
    function closePreferencesModal() {
        userPreferencesModal.classList.remove('active');
    }
    
    // Open dark mode modal
    function openDarkModeModal() {
        darkModeModal.classList.add('active');
    }
    
    // Close dark mode modal
    function closeDarkModeModal() {
        darkModeModal.classList.remove('active');
    }
    
    // Update UI based on current preferences
    function updateUI() {
        // Update text size buttons
        textSizeButtons.forEach(btn => {
            btn.classList.remove('selected');
            if (btn.dataset.size === userPreferences.textSize) {
                btn.classList.add('selected');
            }
        });
        
        const darkMode = userPreferences.darkMode === true;
        document.documentElement.classList.toggle('dark-mode', darkMode);
        darkModeToggle.classList.toggle('active', darkMode);
        darkModeToggle.setAttribute('aria-checked', String(darkMode));
        darkModeToggle.textContent = darkMode ? 'On' : 'Off';

        // Update printer log toggle
        printerLogToggle.textContent = userPreferences.printerLogVisible ? 'Hide Printer Log' : 'Show Printer Log';
        printerLogToggle.classList.toggle('active', userPreferences.printerLogVisible);
        
        // Update color scheme dropdown
        if (defaultColorScheme) {
            defaultColorScheme.value = userPreferences.defaultColorScheme;
        }
        
        // Apply text size to document
        applyTextSize();
        
        // Apply printer log visibility
        applyPrinterLogVisibility();
    }
    
    // Apply text size to the entire document (except splash screen)
    function applyTextSize() {
        // Remove existing text size classes from body
        document.body.className = document.body.className.replace(/text-size-\w+/g, '');
        
        // Apply text size to the entire document body
        document.body.classList.add(`text-size-${userPreferences.textSize}`);
        document.dispatchEvent(new CustomEvent('textSizeChanged'));
        
        // Trigger control button position adjustment after text size change
        setTimeout(() => {
            if (window.adjustControlButtonPosition) {
                window.adjustControlButtonPosition();
            }
        }, 100); // Small delay to allow CSS changes to take effect
    }
    
    // Apply color scheme change immediately
    function applyColorScheme(schemeName) {
        console.log('Applying color scheme:', schemeName);
        
        // Try using the imported setColorScheme function directly
        function tryApplyColorScheme(retryCount = 0) {
            try {
                console.log('Trying to set color scheme with imported function...');
                if (setColorScheme(schemeName)) {
                    console.log('Color scheme set successfully with imported function');
                    
                    // Update 3D layer materials if available
                    if (window.updateAllLayerMaterials && window.layers) {
                        console.log('Updating 3D layer materials...');
                        window.updateAllLayerMaterials(window.layers);
                    }
                    
                    // Update 2D interpolated layer colors if available
                    if (window.interpolate && window.interpolate.updateInterpolatedLayersColor && window.layers) {
                        console.log('Updating 2D interpolated layer colors...');
                        window.interpolate.updateInterpolatedLayersColor(window.layers);
                    }
                    
                    // Update the color scheme buttons in the dropdown menu
                    const colorSchemeButtons = document.querySelectorAll('.color-scheme-btn');
                    console.log('Found color scheme buttons:', colorSchemeButtons.length);
                    colorSchemeButtons.forEach(btn => {
                        btn.classList.remove('selected');
                        if (btn.dataset.scheme === schemeName) {
                            btn.classList.add('selected');
                            console.log('Selected button for scheme:', schemeName);
                        }
                    });
                    return; // Success, exit function
                } else {
                    console.error('Failed to set color scheme with imported function:', schemeName);
                }
            } catch (error) {
                console.error('Error using imported setColorScheme:', error);
            }
            
            // Fallback to window.CONSTS approach
            if (window.CONSTS && window.CONSTS.setColorScheme) {
                console.log('Fallback: using window.CONSTS...');
                if (window.CONSTS.setColorScheme(schemeName)) {
                    console.log('Color scheme set successfully with window.CONSTS');
                    
                    // Update materials and buttons (same as above)
                    if (window.updateAllLayerMaterials && window.layers) {
                        window.updateAllLayerMaterials(window.layers);
                    }
                    if (window.interpolate && window.interpolate.updateInterpolatedLayersColor && window.layers) {
                        window.interpolate.updateInterpolatedLayersColor(window.layers);
                    }
                    const colorSchemeButtons = document.querySelectorAll('.color-scheme-btn');
                    colorSchemeButtons.forEach(btn => {
                        btn.classList.remove('selected');
                        if (btn.dataset.scheme === schemeName) {
                            btn.classList.add('selected');
                        }
                    });
                }
            } else if (retryCount < 5) {
                console.log(`Both methods failed, retrying in 200ms (attempt ${retryCount + 1})`);
                setTimeout(() => tryApplyColorScheme(retryCount + 1), 200);
            } else {
                console.error('All color scheme application methods failed');
            }
        }
        
        tryApplyColorScheme();
    }
    
    // Apply printer log visibility
    function applyPrinterLogVisibility() {
        const leftContainer = document.getElementById('leftContainer');
        if (leftContainer) {
            // The log footer is a child of #mainContent (not #leftContainer), so the
            // collapse preference is scoped to <body> in focus mode.
            document.body.classList.toggle('printer-log-hidden', !userPreferences.printerLogVisible);
            
            // Simple zoom adjustment based on printer log visibility
            const applyZoomAdjustment = () => {
                // Focus mode (Layout 6): the printer log is a floating toast that no longer
                // steals canvas width, so this zoom/center override is obsolete and would
                // fight update2DGrid (the single resize authority). Skip it.
                if (document.body.classList.contains('app-started')) return;
                if (window.pathEditorScope && window.pathEditorScope.view) {
                    const view = window.pathEditorScope.view;
                    const newZoom = userPreferences.printerLogVisible ? 1.0 : 1.145;
                    
                    // Get canvas dimensions to calculate proper center
                    const canvas = document.getElementById('PathEditorView');
                    if (canvas) {
                        const canvasRect = canvas.getBoundingClientRect();
                        const canvasCenter = new window.pathEditorScope.Point(
                            canvasRect.width / 2, 
                            canvasRect.height / 2
                        );
                        
                        // Apply zoom and center
                        view.zoom = newZoom;
                        view.center = canvasCenter;
                        
                        // Immediate redraw
                        view.draw();
                    }
                }
            };
            
            // Apply zoom immediately - no delay
            applyZoomAdjustment();
        }
    }
    
    // Save preferences to localStorage
    function savePreferences() {
        localStorage.setItem('userPreferences', JSON.stringify(userPreferences));
        console.log('User preferences saved:', userPreferences);
    }
    
    // Load preferences from localStorage
    function loadPreferences() {
        const saved = localStorage.getItem('userPreferences');
        if (saved) {
            try {
                userPreferences = { ...userPreferences, ...JSON.parse(saved) };
                console.log('User preferences loaded:', userPreferences);
            } catch (error) {
                console.error('Error loading preferences:', error);
            }
        }
    }
    
    // Event listeners
    if (userPreferencesBtn) {
        console.log('User preferences button found, adding event listener');
        userPreferencesBtn.addEventListener('click', function(e) {
            console.log('User preferences button clicked!', e);
            e.preventDefault();
            e.stopPropagation();
            openPreferencesModal();
        });
    } else {
        console.error('User preferences button not found in DOM');
    }
    
    if (savePreferencesBtn) {
        savePreferencesBtn.addEventListener('click', function() {
            savePreferences();
            updateUI();
            closePreferencesModal();
        });
    }
    
    if (cancelPreferencesBtn) {
        cancelPreferencesBtn.addEventListener('click', function() {
            userPreferences = { ...preferencesOnOpen }; // Restore the values from when the modal opened
            updateUI();
            closePreferencesModal();
        });
    }
    
    if (darkModeToggle) {
        darkModeToggle.addEventListener('click', function() {
            userPreferences.darkMode = !userPreferences.darkMode;
            updateUI();
        });
    }
    
    if (darkModeOkBtn) {
        darkModeOkBtn.addEventListener('click', closeDarkModeModal);
    }
    
    if (printerLogToggle) {
        printerLogToggle.addEventListener('click', function() {
            userPreferences.printerLogVisible = !userPreferences.printerLogVisible;
            updateUI();
        });
    }
    
    // Text size button event listeners
    textSizeButtons.forEach(btn => {
        btn.addEventListener('click', function() {
            userPreferences.textSize = btn.dataset.size;
            updateUI();
        });
    });
    
    // Color scheme dropdown event listener
    if (defaultColorScheme) {
        console.log('Setting up color scheme dropdown event listener');
        defaultColorScheme.addEventListener('change', function() {
            console.log('Color scheme dropdown changed to:', this.value);
            userPreferences.defaultColorScheme = this.value;
            
            // Immediately apply the color scheme change
            applyColorScheme(this.value);
            
            updateUI();
        });
        
        // Also listen for input event as a fallback
        defaultColorScheme.addEventListener('input', function() {
            console.log('Color scheme dropdown input changed to:', this.value);
            userPreferences.defaultColorScheme = this.value;
            applyColorScheme(this.value);
            updateUI();
        });
    } else {
        console.error('defaultColorScheme dropdown element not found');
    }
    
    // Close modals when clicking outside
    userPreferencesModal.addEventListener('click', function(e) {
        if (e.target === userPreferencesModal) {
            closePreferencesModal();
        }
    });
    
    darkModeModal.addEventListener('click', function(e) {
        if (e.target === darkModeModal) {
            closeDarkModeModal();
        }
    });
    
    // Close modals with Escape key
    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') {
            if (userPreferencesModal.classList.contains('active')) {
                closePreferencesModal();
            }
            if (darkModeModal.classList.contains('active')) {
                closeDarkModeModal();
            }
        }
    });
    
    // Function to initialize zoom state on startup
    function initializeZoomState() {
        // Try multiple times with increasing delays to ensure pathEditorScope is ready
        const attempts = [100, 300, 500, 1000, 2000];
        
        function tryApplyZoom(attemptIndex = 0) {
            if (attemptIndex >= attempts.length) {
                console.warn('Could not initialize zoom state - pathEditorScope not available');
                return;
            }
            
            setTimeout(() => {
                if (window.pathEditorScope && window.pathEditorScope.view) {
                    console.log('Initializing zoom state on startup');
                    applyPrinterLogVisibility();
                } else {
                    console.log(`Zoom initialization attempt ${attemptIndex + 1} failed, retrying...`);
                    tryApplyZoom(attemptIndex + 1);
                }
            }, attempts[attemptIndex]);
        }
        
        tryApplyZoom();
    }
    
    // Initialize on page load
    updateUI();
    
    // Apply initial zoom state based on printer log preference
    // This ensures the path editor starts in the correct zoom state
    initializeZoomState();
    
    // Make initializePathEditorZoom available globally
    window.initializePathEditorZoom = initializePathEditorZoom;
});

// Export preferences for use by other modules
export function getUserPreferences() {
    return userPreferences;
}

// Export function to get default color scheme
export function getDefaultColorScheme() {
    return userPreferences.defaultColorScheme;
}

// Export function to programmatically update preferences
export function updatePreference(key, value) {
    userPreferences[key] = value;
    const event = new CustomEvent('userPreferencesUpdated', { detail: userPreferences });
    document.dispatchEvent(event);
}

// Export function to initialize zoom state - can be called when pathEditorScope is ready
export function initializePathEditorZoom() {
    // Focus mode (Layout 6): resize/zoom is owned solely by update2DGrid; the
    // printer-log-visibility zoom is obsolete (the log is a floating toast).
    if (document.body.classList.contains('app-started')) return;
    if (window.pathEditorScope && window.pathEditorScope.view) {
        // Get the current applyPrinterLogVisibility function
        const leftContainer = document.getElementById('leftContainer');
        if (leftContainer) {
            // Apply zoom based on current printer log visibility state
            const isLogHidden = document.body.classList.contains('printer-log-hidden');
            const view = window.pathEditorScope.view;
            const newZoom = isLogHidden ? 1.145 : 1.0;
            
            // Get canvas dimensions to calculate proper center
            const canvas = document.getElementById('PathEditorView');
            if (canvas) {
                const canvasRect = canvas.getBoundingClientRect();
                const canvasCenter = new window.pathEditorScope.Point(
                    canvasRect.width / 2, 
                    canvasRect.height / 2
                );
                
                // Apply zoom and center
                view.zoom = newZoom;
                view.center = canvasCenter;
                view.draw();
            }
        }
    }
}