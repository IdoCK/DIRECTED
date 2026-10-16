// Printer Configuration Modal functionality
import * as CONSTS from './consts.js';
import { updatePrinterConfig } from './consts.js';

// Configuration values that can be updated
let printerConfig = {
    maxBuildHeight: CONSTS.MAX_BUILD_HEIGHT,
    layerHeight: CONSTS.LAYER_HEIGHT,
    nozzleDiameter: CONSTS.NOZZLE_DIAMETER
};

document.addEventListener('DOMContentLoaded', function() {
    const printerConfigBtn = document.getElementById('printerConfigBtn');
    const printerConfigModal = document.getElementById('printerConfigModal');
    const saveConfigBtn = document.getElementById('saveConfigBtn');
    const cancelConfigBtn = document.getElementById('cancelConfigBtn');
    const validationMessage = document.getElementById('validationMessage');
    
    // Input elements
    const maxBuildHeightInput = document.getElementById('maxBuildHeight');
    const layerHeightInput = document.getElementById('layerHeight');
    const nozzleDiameterInput = document.getElementById('nozzleDiameter');

    // Load current configuration from server
    async function loadConfiguration() {
        try {
            console.log('Loading printer configuration from server...');
            const response = await fetch('/api/printer-config');
            
            console.log('Load response status:', response.status);
            
            if (response.ok) {
                const config = await response.json();
                printerConfig = config;
                console.log('Loaded printer configuration:', printerConfig);
                
                // Don't update constants on load - only update when saving
            } else {
                const responseText = await response.text();
                console.log('Error loading configuration:', responseText);
            }
        } catch (error) {
            console.error('Error loading printer configuration:', error);
        }
    }

    // Initialize input values
    function initializeInputs() {
        maxBuildHeightInput.value = printerConfig.maxBuildHeight;
        layerHeightInput.value = printerConfig.layerHeight;
        nozzleDiameterInput.value = printerConfig.nozzleDiameter;
    }

    // Validate layer height vs nozzle diameter
    function validateInputs() {
        const layerHeight = parseFloat(layerHeightInput.value);
        const nozzleDiameter = parseFloat(nozzleDiameterInput.value);
        
        if (layerHeight > nozzleDiameter / 3) {
            validationMessage.textContent = `Layer height cannot be larger than ${(nozzleDiameter / 3).toFixed(2)}mm (nozzle diameter / 3)`;
            validationMessage.classList.add('show');
            return false;
        } else {
            validationMessage.classList.remove('show');
            return true;
        }
    }

    // Update configuration constants
    async function updateConstants() {
        // Update the configuration object
        printerConfig.maxBuildHeight = parseFloat(maxBuildHeightInput.value);
        printerConfig.layerHeight = parseFloat(layerHeightInput.value);
        printerConfig.nozzleDiameter = parseFloat(nozzleDiameterInput.value);
        
        try {
            console.log('Sending configuration to server:', printerConfig);
            
            // Send configuration to server
            const response = await fetch('/api/printer-config', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(printerConfig)
            });
            
            console.log('Response status:', response.status);
            console.log('Response headers:', response.headers);
            
            if (!response.ok) {
                const responseText = await response.text();
                console.log('Error response text:', responseText);
                
                // Try to parse as JSON, fallback to text
                let errorMessage;
                try {
                    const errorData = JSON.parse(responseText);
                    errorMessage = errorData.error || 'Failed to update configuration';
                } catch (e) {
                    errorMessage = `Server error: ${response.status} ${response.statusText}`;
                }
                
                throw new Error(errorMessage);
            }
            
            const result = await response.json();
            console.log('Printer configuration updated successfully:', result.config);
            
            // Update the constants in consts.js
            updatePrinterConfig(result.config);
            
            // Dispatch event to notify other modules of config change
            document.dispatchEvent(new CustomEvent('printerConfigUpdated', { 
                detail: result.config 
            }));
            
        } catch (error) {
            console.error('Error updating printer configuration:', error);
            validationMessage.textContent = error.message;
            validationMessage.classList.add('show');
            throw error; // Re-throw to prevent modal from closing
        }
    }

    // Remember which control opened the modal, to restore focus on close
    let lastFocusedTrigger = null;

    // Open modal
    async function openModal() {
        lastFocusedTrigger = document.activeElement;
        await loadConfiguration();
        initializeInputs();
        printerConfigModal.classList.remove('closing');
        printerConfigModal.classList.add('active');

        // Move focus into the dialog — prefer the first editable field
        // (printerType is disabled), falling back to a button if none.
        const firstField = printerConfigModal.querySelector('input:not([disabled])')
            || printerConfigModal.querySelector('button');
        if (firstField) firstField.focus();

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
            console.log('Closed dropdown menu when opening printer config');
        }
    }

    // Close modal — play the exit animation, then tear down and restore focus
    function closeModal() {
        validationMessage.classList.remove('show');

        const restoreFocus = () => { if (lastFocusedTrigger) lastFocusedTrigger.focus(); };
        const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        if (reduce) {
            printerConfigModal.classList.remove('active', 'closing');
            restoreFocus();
            return;
        }

        printerConfigModal.classList.add('closing');
        const panel = printerConfigModal.querySelector('.printer-config-content');
        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            panel.removeEventListener('transitionend', onEnd);
            printerConfigModal.classList.remove('active', 'closing');
            restoreFocus();
        };
        const onEnd = (e) => {
            if (e.target === panel && e.propertyName === 'transform') finish();
        };
        panel.addEventListener('transitionend', onEnd);
        // safety net in case transitionend doesn't fire (e.g. tab hidden)
        setTimeout(finish, 320);
    }

    // Focus trap — keep Tab cycling within the dialog while it's open
    printerConfigModal.addEventListener('keydown', function(e) {
        if (e.key !== 'Tab' || !printerConfigModal.classList.contains('active')) return;
        const focusables = printerConfigModal.querySelectorAll(
            'input:not([disabled]), button, [href], [tabindex]:not([tabindex="-1"])'
        );
        if (!focusables.length) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
            e.preventDefault(); last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault(); first.focus();
        }
    });

    // ---- Destructive printer-config-change flow --------------------------------
    // Clicking "Printer Config…" mid-session pauses the print and asks first;
    // saving stops+resets the session, cancelling/aborting resumes play.
    let midSessionFlow = false;
    const configChangeWarningOverlay = document.getElementById('configChangeWarningOverlay');
    const configChangeExportBtn = document.getElementById('configChangeExportBtn');
    const configChangeCancelBtn = document.getElementById('configChangeCancelBtn');
    const configChangeAcceptBtn = document.getElementById('configChangeAcceptBtn');
    const stopSessionOverlay = document.getElementById('stopSessionOverlay');
    const stopSessionExportBtn = document.getElementById('stopSessionExportBtn');
    const stopSessionNewBtn = document.getElementById('stopSessionNewBtn');

    function toast(message, status) {
        if (typeof window.showToast === 'function') window.showToast(message, { status: status || 'success' });
    }
    function closeDropdownMenu() {
        const dropdownMenu = document.getElementById('dropdownMenu');
        const menuButton = document.getElementById('menuButton');
        if (dropdownMenu && dropdownMenu.classList.contains('open')) {
            dropdownMenu.classList.remove('open');
            if (menuButton) menuButton.classList.remove('open');
            if (typeof window.enableMainInteractions === 'function') window.enableMainInteractions();
        }
    }
    // Reuse the proven G-code export pipeline.
    async function triggerGcodeExport() {
        try {
            if (window.completionScreen && typeof window.completionScreen.exportGcode === 'function') {
                await window.completionScreen.exportGcode();
            } else if (typeof window.exportGcodeFromDropdown === 'function') {
                await window.exportGcodeFromDropdown();
            } else if (window.printIntegration && typeof window.printIntegration.exportGcode === 'function') {
                await window.printIntegration.exportGcode();
            }
            toast('G-code exported', 'success');
        } catch (error) {
            console.error('G-code export failed:', error);
            toast('G-code export failed', 'error');
        }
    }
    function showConfigChangeWarning() {
        if (configChangeExportBtn) configChangeExportBtn.disabled = false;
        if (configChangeWarningOverlay) configChangeWarningOverlay.classList.add('active');
        if (configChangeAcceptBtn) setTimeout(() => configChangeAcceptBtn.focus(), 0);
    }
    function hideConfigChangeWarning() {
        if (configChangeWarningOverlay) configChangeWarningOverlay.classList.remove('active');
    }
    function showStopSessionModal() {
        if (stopSessionExportBtn) stopSessionExportBtn.disabled = false;
        if (stopSessionOverlay) stopSessionOverlay.classList.add('active');
        if (stopSessionNewBtn) setTimeout(() => stopSessionNewBtn.focus(), 0);
    }
    function hideStopSessionModal() {
        if (stopSessionOverlay) stopSessionOverlay.classList.remove('active');
    }
    // Entry point for the hamburger "Printer Config…" item.
    function handlePrinterConfigRequest() {
        closeDropdownMenu();
        const active = typeof window.isSessionActive === 'function' && window.isSessionActive();
        if (active) {
            if (typeof window.pausePrintSession === 'function') window.pausePrintSession();
            midSessionFlow = true;
            showConfigChangeWarning();
        } else {
            midSessionFlow = false;
            openModal();
        }
    }
    // Aborting (cancel / Esc / outside-click) resumes the still-paused print.
    function abortConfigModal() {
        closeModal();
        if (midSessionFlow) {
            midSessionFlow = false;
            if (typeof window.resumePrintSession === 'function') window.resumePrintSession();
        }
    }
    function abortConfigChangeWarning() {
        hideConfigChangeWarning();
        midSessionFlow = false;
        if (typeof window.resumePrintSession === 'function') window.resumePrintSession();
    }

    // Warning modal buttons.
    if (configChangeAcceptBtn) configChangeAcceptBtn.addEventListener('click', function() { hideConfigChangeWarning(); openModal(); /* midSessionFlow stays true */ });
    if (configChangeExportBtn) configChangeExportBtn.addEventListener('click', async function() { configChangeExportBtn.disabled = true; await triggerGcodeExport(); });
    if (configChangeCancelBtn) configChangeCancelBtn.addEventListener('click', abortConfigChangeWarning);
    if (configChangeWarningOverlay) configChangeWarningOverlay.addEventListener('click', function(e) { if (e.target === configChangeWarningOverlay) abortConfigChangeWarning(); });
    // Stop-session modal buttons (terminal — no Esc/outside dismiss).
    if (stopSessionExportBtn) stopSessionExportBtn.addEventListener('click', async function() { await triggerGcodeExport(); });
    if (stopSessionNewBtn) stopSessionNewBtn.addEventListener('click', function() {
        hideStopSessionModal();
        if (window.completionScreen && typeof window.completionScreen.startNewSession === 'function') window.completionScreen.startNewSession();
        else window.location.reload();
    });

    // Event listeners
    if (printerConfigBtn) {
        // Landing/splash config button keeps its original (idle) behavior.
        printerConfigBtn.addEventListener('click', function() { midSessionFlow = false; openModal(); });
    }

    const printerConfigDropdownBtn = document.getElementById('printerConfigDropdownBtn');
    if (printerConfigDropdownBtn) {
        printerConfigDropdownBtn.addEventListener('click', handlePrinterConfigRequest);
    }

    if (saveConfigBtn) {
        saveConfigBtn.addEventListener('click', async function() {
            if (validateInputs()) {
                try {
                    await updateConstants();
                    closeModal();

                    if (midSessionFlow) {
                        // Destructive path: stop the session, then offer export /
                        // start-new-session with the UPDATED config.
                        midSessionFlow = false;
                        if (typeof window.stopPrintSession === 'function') window.stopPrintSession();
                        showStopSessionModal();
                    }
                } catch (error) {
                    // Error is already handled and displayed in updateConstants
                }
            }
        });
    }

    if (cancelConfigBtn) {
        // Cancel in the config modal: if reached mid-session, abort the change and
        // resume the still-paused print; otherwise just close.
        cancelConfigBtn.addEventListener('click', abortConfigModal);
    }

    const closeConfigBtn = document.getElementById('closeConfigBtn');
    if (closeConfigBtn) {
        closeConfigBtn.addEventListener('click', abortConfigModal);
    }

    // Real-time validation on input change
    if (layerHeightInput && nozzleDiameterInput) {
        layerHeightInput.addEventListener('input', validateInputs);
        nozzleDiameterInput.addEventListener('input', validateInputs);
    }

    // Close modal when clicking outside (treated as abort → resume if mid-session)
    printerConfigModal.addEventListener('click', function(e) {
        if (e.target === printerConfigModal) {
            abortConfigModal();
        }
    });

    // Escape: abort the config modal, or the warning modal, with resume.
    // The stop-session modal is terminal and intentionally NOT Esc-dismissible.
    document.addEventListener('keydown', function(e) {
        if (e.key !== 'Escape') return;
        if (printerConfigModal.classList.contains('active')) {
            abortConfigModal();
        } else if (configChangeWarningOverlay && configChangeWarningOverlay.classList.contains('active')) {
            abortConfigChangeWarning();
        }
    });

    // Initialize
    loadConfiguration().then(() => {
        initializeInputs();
    });
});

// Export configuration for use by other modules
export function getPrinterConfig() {
    return printerConfig;
}

// Export function to update server constants
export function updateServerConstants() {
    // This would typically send the configuration to the server
    // For now, we'll just log it
    console.log('Sending printer configuration to server:', printerConfig);
    
    // In a real implementation, you'd make an API call here
    // fetch('/api/printer-config', {
    //     method: 'POST',
    //     headers: { 'Content-Type': 'application/json' },
    //     body: JSON.stringify(printerConfig)
    // });
}