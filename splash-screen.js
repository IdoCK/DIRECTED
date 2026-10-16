// ===== concept-02 brush-reveal boot sequence =====
// Self-contained: only touches #loader, #brushRail and the body class.
// The mode toggle / slide-to-start / homing wiring below is untouched.
document.addEventListener('DOMContentLoaded', function () {
  const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const loader = document.getElementById('loader');
  const rail = document.getElementById('brushRail');
  let railLen = 0;

  function seedSpine() {                 // hide the swoosh (rail mask offset = full length)
    if (!rail || !rail.getTotalLength) return;
    railLen = rail.getTotalLength();
    rail.style.strokeDasharray = railLen + ' ' + (railLen + 2);
    rail.style.transition = 'none';
    rail.style.strokeDashoffset = prefersReduced ? '0' : String(railLen);
    void rail.getBoundingClientRect();
  }
  function drawSpine() {                 // one confident left→right sweep that paints it on
    if (!rail) return;
    if (prefersReduced) { rail.style.strokeDashoffset = '0'; return; }
    rail.style.transition = 'stroke-dashoffset var(--m-brush) var(--e-brush)';
    void rail.getBoundingClientRect();
    rail.style.strokeDashoffset = '0';
  }

  seedSpine();
  const loadTime = prefersReduced ? 250 : 1100;
  setTimeout(function () {
    if (loader) loader.classList.add('gone');
    drawSpine();
    document.body.classList.add('splash-idle');   // fades the wordmark in over the swoosh
  }, loadTime);
});

const buttonMarginFromEdge = 5;

// Standby screen functionality
document.addEventListener('DOMContentLoaded', function() {
  const standbyScreen = document.getElementById('standbyScreen');
  const slideButton = document.getElementById('slideButton');
  
  if (!slideButton) {
    console.warn('Slide button not found, skipping splash screen setup');
    return;
  }
  
  const slideTrack = slideButton.parentElement;
  
  // Mode selection variables
  let selectedMode = 'demo'; // Default to demo mode
  const railTrack = document.querySelector('.rail-track');
  const railSlider = document.getElementById('modeSlider');
  const labelLeft = document.querySelector('.mode-label-left');
  const labelRight = document.querySelector('.mode-label-right');
  
  // Setup mode toggle functionality
  setupModeToggle();
  
  function setupModeToggle() {
    let isSliderDragging = false;
    let sliderStartX = 0;
    let sliderStartPos = 0;
    
    // Rail toggle click event listener
    if (railTrack) {
      railTrack.addEventListener('click', (e) => {
        // Don't trigger click if we were dragging
        if (isSliderDragging) return;
        
        const rect = railTrack.getBoundingClientRect();
        const clickX = e.clientX - rect.left;
        const railWidth = rect.width;
        
        // If clicked on left half, select demo mode
        if (clickX < railWidth / 2) {
          selectMode('demo');
        } else {
          selectMode('printer');
        }
      });
    }
    
    // Make slider draggable
    if (railSlider) {
      // Mouse events
      railSlider.addEventListener('mousedown', startDrag);
      document.addEventListener('mousemove', handleDrag);
      document.addEventListener('mouseup', endDrag);
      
      // Touch events
      railSlider.addEventListener('touchstart', startDrag, { passive: false });
      document.addEventListener('touchmove', handleDrag, { passive: false });
      document.addEventListener('touchend', endDrag, { passive: false });
    }
    
    function startDrag(e) {
      isSliderDragging = true;
      sliderStartX = e.type === 'mousedown' ? e.clientX : e.touches[0].clientX;
      
      const rect = railSlider.getBoundingClientRect();
      sliderStartPos = rect.left;
      
      railSlider.style.transition = 'none';
      e.preventDefault();
    }
    
    function handleDrag(e) {
      if (!isSliderDragging) return;
      
      e.preventDefault();
      const currentX = e.type === 'mousemove' ? e.clientX : e.touches[0].clientX;
      const deltaX = currentX - sliderStartX;
      
      const railRect = railTrack.getBoundingClientRect();
      const railWidth = railRect.width;
      const sliderWidth = railSlider.offsetWidth;
      const maxPosition = railWidth - sliderWidth - 8; // 8px total padding (4px each side)
      
      // Calculate new position
      let newPosition;
      if (selectedMode === 'demo') {
        newPosition = Math.max(4, Math.min(maxPosition, 4 + deltaX));
      } else {
        newPosition = Math.max(4, Math.min(maxPosition, maxPosition + deltaX));
      }
      
      // Apply position
      railSlider.style.left = newPosition + 'px';
      railSlider.style.right = 'auto';
    }
    
    function endDrag() {
      if (!isSliderDragging) return;
      
      isSliderDragging = false;
      railSlider.style.transition = 'left 400ms cubic-bezier(0.22,1,0.36,1), right 400ms cubic-bezier(0.22,1,0.36,1), transform 150ms cubic-bezier(0.22,1,0.36,1)';
      
      const railRect = railTrack.getBoundingClientRect();
      const sliderRect = railSlider.getBoundingClientRect();
      const railWidth = railRect.width;
      const sliderCenter = sliderRect.left - railRect.left + (sliderRect.width / 2);
      
      // Determine which side the slider ended up on
      if (sliderCenter < railWidth / 2) {
        selectMode('demo');
      } else {
        selectMode('printer');
      }
    }
  }
  
  function selectMode(mode) {
    selectedMode = mode;
    
    // Update visual state
    if (mode === 'demo') {
      railSlider.style.left = '4px';
      railSlider.style.right = 'auto';
      labelLeft.classList.add('active');
      labelRight.classList.remove('active');
      //console.log('Selected Demo Mode - will use mock printer');
    } else {
      railSlider.style.left = 'auto';
      railSlider.style.right = '4px';
      labelRight.classList.add('active');
      labelLeft.classList.remove('active');
      //console.log('Selected Printer Mode - will connect to real printer');
    }
  }
  
  // Initialize with demo mode as default
  selectMode('demo');
  
  let isDragging = false;
  let startX = 0;
  let currentX = 0;
  let slideDistance = 0;
  
  const maxSlideDistance = slideTrack.offsetWidth - slideButton.offsetWidth - 10;
  const constrainedMaxDistance = maxSlideDistance - buttonMarginFromEdge;
  const threshold = constrainedMaxDistance * 0.85; // 85% of the constrained distance

  // Mouse events
  slideButton.addEventListener('mousedown', startSlide);
  document.addEventListener('mousemove', handleSlide);
  document.addEventListener('mouseup', endSlide);
  
  // Touch events for mobile with passive: false to allow preventDefault
  slideButton.addEventListener('touchstart', startSlide, { passive: false });
  document.addEventListener('touchmove', handleSlide, { passive: false });
  document.addEventListener('touchend', endSlide, { passive: false });
  
  function startSlide(e) {
    isDragging = true;
    startX = e.type === 'mousedown' ? e.clientX : e.touches[0].clientX;
    slideButton.style.transition = 'none';
    slideTrack.classList.add('sliding');
  }
  
  function handleSlide(e) {
    if (!isDragging) return;
    
    e.preventDefault();
    currentX = e.type === 'mousemove' ? e.clientX : e.touches[0].clientX;
    
    // Calculate slide distance with edge constraint
    const constrainedMaxDistance = maxSlideDistance - buttonMarginFromEdge;
    slideDistance = Math.max(0, Math.min(constrainedMaxDistance, currentX - startX));
    
    slideButton.style.transform = `translateX(${slideDistance}px)`;
    
    // The puck masks the label as it sweeps over it (no terracotta in-fill):
    // everything to the LEFT of the puck's leading edge is masked away.
    const labelEl = document.getElementById('slideLabel');
    if (labelEl) {
      const trackW = slideTrack.offsetWidth || 1;
      const puckRight = slideButton.offsetLeft + slideDistance + slideButton.offsetWidth;
      const pct = Math.max(0, Math.min(100, (puckRight / trackW) * 100));
      const grad = `linear-gradient(90deg, transparent ${pct}%, #000 ${Math.min(100, pct + 3)}%)`;
      labelEl.style.webkitMaskImage = grad;
      labelEl.style.maskImage = grad;
    }
  }
  
  function endSlide() {
    if (!isDragging) return;
    
    isDragging = false;
    slideButton.style.transition = 'transform 0.3s ease';
    slideTrack.classList.remove('sliding');
    
    if (slideDistance >= threshold) {
      // Complete the slide
      completeSlide();
    } else {
      // Snap back — restore the full label
      slideButton.style.transform = 'translateX(0px)';
      const labelEl = document.getElementById('slideLabel');
      if (labelEl) { labelEl.style.webkitMaskImage = 'none'; labelEl.style.maskImage = 'none'; }
    }
  }
  
  function completeSlide() {
    // Calculate the constrained maximum distance (same margin as start position)
    const constrainedMaxDistance = maxSlideDistance - buttonMarginFromEdge;
    
    // Animate to constrained slide distance (not full distance)
    slideButton.classList.add('sliding');
    slideButton.style.transform = `translateX(${constrainedMaxDistance}px)`;
    // The puck has swept the whole label away
    const labelEl = document.getElementById('slideLabel');
    if (labelEl) labelEl.style.opacity = '0';
    
    //console.log(`Slide completed at ${constrainedMaxDistance}px (${buttonMarginFromEdge}px from edge)`);
    
    // Wait for animation, then start the homing process
    setTimeout(() => {
      startHomingProcess();
    }, 600);
  }

  function startHomingProcess() {
    //console.log(`Starting homing process in ${selectedMode} mode...`);
    
    // Set global mode for the application
    window.isDemoMode = (selectedMode === 'demo');
    // Drive the in-pill DEMO chip (focus mode) off a body class.
    document.body.classList.toggle('demo-mode', window.isDemoMode);

    // Only the real/mock-printer mode needs the printer-log socket.
    // In Demo Mode we deliberately never open it (see printer-log.js B4 fix).
    if (!window.isDemoMode && window.printerLog && typeof window.printerLog.connectSocket === 'function') {
      window.printerLog.connectSocket();
    }

    // Send mode information to backend only if not in demo mode
    if (selectedMode !== 'demo' && window.printIntegration && window.printIntegration.socket) {
      window.printIntegration.socket.emit('programStarted', { 
        useMockPrinter: false 
      });
      //console.log(`Program started signal sent in ${selectedMode} mode`);
    } else if (selectedMode === 'demo') {
      //console.log('Demo mode: Not sending programStarted signal to backend');
      // Ensure mock printer is enabled for demo mode
      if (window.printIntegration) {
        window.printIntegration.useMockPrinter = true;
        // Force disconnect any existing real connection and connect to mock
        if (window.printIntegration.socket && window.printIntegration.socket.connected) {
          window.printIntegration.socket.disconnect();
        }
        window.printIntegration.isConnected = false;
        window.printIntegration.connect();
      }
    }
    
    // Proceed to check layers and start program
    checkLayersAndStartPrint();
  }

  function checkLayersAndStartPrint() {
    //console.log('Checking layers for printing...');
    
    // Check if we have access to the layers array
    if (window.layersManager && window.layersManager.layers) {
      const layers = window.layersManager.layers;
      let validLayersCount = 0;
      
      // Check first 5 indices for valid layers
      for (let i = 0; i < Math.min(5, layers.length); i++) {
        if (layers[i] && layers[i].layer !== null) {
          validLayersCount++;
          //console.log(`Layer ${i + 1}: Valid`);
        } else {
          //console.log(`Layer ${i + 1}: Empty`);
        }
      }
      
      if (validLayersCount >= 5) {
        //console.log(`Found ${validLayersCount} valid layers, starting print process...`);
        
        // Start the print process
        if (window.printIntegration && typeof window.printIntegration.startLayerPrinting === 'function') {
          // In demo mode, ensure we use the mock printing
          if (selectedMode === 'demo') {
            window.printIntegration.useMockPrinter = true;
          }
          window.printIntegration.startLayerPrinting(layers);
        }
      } else if (validLayersCount > 0) {
        //console.log(`! Found only ${validLayersCount} valid layers, but need at least 5 to start printing !`);
        
        // Show feedback to user via printer log
        if (window.printerLog) {
          window.printerLog.addMessage({
            message: `! Need at least 5 layers to print. Currently have ${validLayersCount} !`,
            status: 'info'
          });
        }
      } else {
        //console.log('! No valid layers found in first 5 indices !');
        
        // Show feedback to user via printer log
        if (window.printerLog) {
          window.printerLog.addMessage({
            message: '! No layers created yet. Create some layers in the path editor first !',
            status: 'info'
          });
        }
      }
    } else {
      // Layers manager not available — surface a benign message instead of failing silently (B2)
      if (window.printerLog) {
        window.printerLog.addMessage({
          message: 'Layers not available yet — draw at least 5 layers, then press Print.',
          status: 'info'
        });
      }
    }

    // Proceed to start the main program
    startProgram();
  }
  
  function startProgram() {
    //console.log(`Starting DIRECTED program in ${selectedMode} mode...`);
    
    // Show demo indicator if in demo mode
    if (selectedMode === 'demo') {
      const demoIndicator = document.getElementById('demoIndicator');
      if (demoIndicator) {
        demoIndicator.classList.add('visible');
        //console.log('Demo mode indicator displayed');
      }
    }
    
    // Fade out standby screen
    standbyScreen.classList.add('hidden');
    
    // Show main app after standby screen fades
    setTimeout(() => {
      //console.log('Hiding standby screen...');
      standbyScreen.style.display = 'none';
      
      //console.log('Adding app-started class to body...');
      // Add class to body to show main app components
      document.body.classList.add('app-started');

      // Clear any stale inline styles the pre-start layout hacks left on the pill
      // (margin-left on #topBarCenter), now that focus mode owns the top bar.
      if (typeof window.adjustControlButtonPosition === 'function') window.adjustControlButtonPosition();
      const _tbc = document.getElementById('topBarCenter');
      if (_tbc) _tbc.style.removeProperty('margin-left');
      const _sb = document.getElementById('stopButton');
      if (_sb) _sb.style.removeProperty('background-color');
      
      // Verify elements are visible
      const topBar = document.getElementById('topBar');
      const mainContent = document.getElementById('mainContent');
      //console.log('TopBar display:', window.getComputedStyle(topBar).display);
      //console.log('MainContent display:', window.getComputedStyle(mainContent).display);
      
      // Trigger window resize to ensure proper canvas sizing
      setTimeout(() => {
        //console.log('Triggering window resize...');
        
        // Use a more compatible approach - just trigger resize handlers
        if (window.onresize) {
          window.onresize();
        }
        
        // Alternative: manually trigger any resize functions that might exist
        if (typeof window.handleResize === 'function') {
          window.handleResize();
        }
        
        // Force canvas reinitialization
        const pathEditor = document.getElementById('PathEditorView');
        const simulation = document.getElementById('SimulationView');
        if (pathEditor) {
          //console.log('PathEditor canvas size:', pathEditor.width, 'x', pathEditor.height);
        }
        if (simulation) {
          //console.log('Simulation canvas size:', simulation.width, 'x', simulation.height);
        }
        
        // Initialize print integration if available
        if (window.printIntegration && typeof window.printIntegration.startPrint === 'function') {
          //console.log('Print integration ready');
          //console.log('DIRECTED interface ready');
        } else {
          //console.log('! Print integration not yet available, will retry !');
          // Retry in case the integration isn't loaded yet
          setTimeout(() => {
            if (window.printIntegration) {
              //console.log('DIRECTED interface ready (delayed)');
            }
          }, 2000);
        }
      }, 100);
      
    }, 800);
  }
});
