// Inactivity Handler - Shows overlay after 2 minutes of inactivity
class InactivityHandler {
    constructor() {
        this.inactivityTimeout = null;
        this.overlay = null;
        this.timeoutDuration = 2 * 60 * 1000; // 2 minutes in milliseconds
        this.isActive = false;
        
        this.init();
    }
    
    init() {
        // Get overlay element
        this.overlay = document.getElementById('inactivityOverlay');
        if (!this.overlay) {
            console.error('Inactivity overlay not found');
            return;
        }
        
        // Bind methods to preserve context
        this.resetTimer = this.resetTimer.bind(this);
        this.showOverlay = this.showOverlay.bind(this);
        this.hideOverlay = this.hideOverlay.bind(this);
        
        // Events that indicate user activity
        this.activityEvents = [
            'mousedown', 'mousemove', 'keypress', 'scroll', 'touchstart', 'touchmove', 'click'
        ];
        
        // Add activity listeners
        this.addActivityListeners();
        
        // Add overlay click handler to dismiss (but not on button clicks)
        this.overlay.addEventListener('click', (e) => {
            if (e.target === this.overlay) {
                this.hideOverlay();
            }
        });
        this.overlay.addEventListener('touchstart', (e) => {
            if (e.target === this.overlay) {
                this.hideOverlay();
            }
        });
        
        // Add Start New Session button handler
        const startNewSessionBtn = document.getElementById('startNewSessionInactivity');
        if (startNewSessionBtn) {
            startNewSessionBtn.addEventListener('click', () => {
                this.startNewSession();
            });
        }
        
        // Start the timer
        this.resetTimer();
        
        console.log('Inactivity handler initialized - 2 minute timeout');
    }
    
    addActivityListeners() {
        this.activityEvents.forEach(event => {
            document.addEventListener(event, this.resetTimer, true);
        });
    }
    
    removeActivityListeners() {
        this.activityEvents.forEach(event => {
            document.removeEventListener(event, this.resetTimer, true);
        });
    }
    
    resetTimer() {
        // Don't reset if overlay is currently showing
        if (this.isActive) return;
        
        // Clear existing timeout
        if (this.inactivityTimeout) {
            clearTimeout(this.inactivityTimeout);
        }
        
        // Set new timeout
        this.inactivityTimeout = setTimeout(this.showOverlay, this.timeoutDuration);
    }
    
    showOverlay() {
        if (this.isActive) return;
        
        console.log('Showing inactivity overlay after 2 minutes of inactivity');
        this.isActive = true;
        
        // Add active class to trigger CSS animation
        this.overlay.classList.add('active');
        
        // Clear the timeout since we're now showing the overlay
        if (this.inactivityTimeout) {
            clearTimeout(this.inactivityTimeout);
            this.inactivityTimeout = null;
        }
    }
    
    hideOverlay() {
        if (!this.isActive) return;
        
        console.log('Hiding inactivity overlay - user activity detected');
        this.isActive = false;
        
        // Remove active class to hide overlay
        this.overlay.classList.remove('active');
        
        // Restart the timer
        this.resetTimer();
    }
    
    // Method to disable inactivity detection (e.g., during active printing)
    disable() {
        console.log('Inactivity handler disabled');
        if (this.inactivityTimeout) {
            clearTimeout(this.inactivityTimeout);
            this.inactivityTimeout = null;
        }
        this.removeActivityListeners();
        this.hideOverlay();
    }
    
    // Method to re-enable inactivity detection
    enable() {
        console.log('Inactivity handler enabled');
        this.addActivityListeners();
        this.resetTimer();
    }
    
    // Start New Session functionality
    startNewSession() {
        console.log('Starting new session from inactivity screen...');
        
        // Hide the inactivity overlay
        this.hideOverlay();
        
        // Use the existing completion screen's startNewSession method if available
        if (window.completionScreen && typeof window.completionScreen.startNewSession === 'function') {
            window.completionScreen.startNewSession();
        } else {
            // Fallback: reload the page to start fresh
            console.log('Completion screen not available, reloading page...');
            window.location.reload();
        }
    }
}

// Initialize when DOM is loaded
// DEACTIVATED (per request): the inactivity "Touch Anywhere / Start New Session"
// overlay timer is disabled. The class above is intentionally left intact so it
// can be re-enabled by uncommenting the line below.
document.addEventListener('DOMContentLoaded', function() {
    // window.inactivityHandler = new InactivityHandler();
});

// Make InactivityHandler available globally
window.InactivityHandler = InactivityHandler;