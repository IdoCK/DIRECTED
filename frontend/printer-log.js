class PrinterLog {
    constructor(containerId) {
        this.container = document.getElementById(containerId);
        this.messages = [];
        this.maxMessages = 50; // Increased to trigger cleanup
        this.socket = null;
        this.isConnected = false;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;

        // --- Typewriter reveal state (highlight line only) -------------------
        this._typing = false;          // a message is currently revealing
        this._typeState = null;        // { el, full, start, msPerChar }
        this._typeRaf = null;

        this._reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        // React live if the OS setting changes mid-session.
        const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
        const onMqChange = (e) => { this._reduceMotion = e.matches; if (e.matches) this.flushTyping(); };
        if (mq.addEventListener) mq.addEventListener('change', onMqChange);
        else if (mq.addListener) mq.addListener(onMqChange); // older browsers

        this.init();
    }
    
    init() {
        this.setupContainer();
        this.setupHistoryViewport();
        this.setupDisclosure();
        this.setupAnchor();
        // If the tab is backgrounded mid-reveal, finalize it so returning shows complete text.
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) this.flushTyping();
        });
        // Socket connection is deferred until mode is known (see splash-screen.js).
        // In Demo Mode the socket is never opened.
        this.addMessage({
            message: 'Initializing printer log...',
            status: 'info'
        });
    }
    
    setupContainer() {
        // Create current message highlight
        this.currentMessageHighlight = document.createElement('button');
        this.currentMessageHighlight.type = 'button';
        this.currentMessageHighlight.setAttribute('aria-label', 'Printer log history');
        this.currentMessageHighlight.setAttribute('aria-expanded', 'false');
        this.currentMessageHighlight.setAttribute('aria-controls', 'printer-log-history');
        this.currentMessageHighlight.className = 'current-message-highlight';
        this.currentMessageHighlight.textContent = 'Latest Status';
        this.container.appendChild(this.currentMessageHighlight);

        // Screen-reader mirror: announces the FULL message text once, instantly.
        // The visible highlight types character-by-character; the a11y announcement is
        // decoupled so SR users never hear per-character narration (a known antipattern).
        this.srMirror = document.createElement('div');
        this.srMirror.className = 'sr-only';
        this.srMirror.setAttribute('aria-live', 'polite');
        this.srMirror.setAttribute('aria-atomic', 'true');
        this.container.appendChild(this.srMirror);
        
        // Create content wrapper
        this.contentWrapper = document.createElement('div');
        this.contentWrapper.className = 'printer-log-content';
        this.contentWrapper.id = 'printer-log-history';
        
        // Create messages container
        this.messagesContainer = document.createElement('div');
        this.messagesContainer.className = 'printer-messages-container';
        
        this.contentWrapper.appendChild(this.messagesContainer);
        this.container.appendChild(this.contentWrapper);
    }
    
    // Click pins the history open. Hover previews it without changing that choice.
    setupDisclosure() {
        this.isPinnedOpen = false;
        this.isHovered = false;
        this.suppressHover = false;
        const update = () => {
            const expanded = this.isPinnedOpen || (this.isHovered && !this.suppressHover);
            this.container.classList.toggle('log-expanded', expanded);
            this.currentMessageHighlight.setAttribute('aria-expanded', String(expanded));
            this.contentWrapper.setAttribute('aria-hidden', String(!expanded));
            this.contentWrapper.inert = !expanded;
            if (expanded) this.measureHistoryViewport();
        };
        this.container.addEventListener('pointerenter', (event) => {
            // Touch can produce sticky hover; only a mouse/pen gets a preview.
            if (event.pointerType === 'touch') return;
            this.isHovered = true;
            update();
        });
        this.container.addEventListener('pointerleave', () => {
            this.isHovered = false;
            this.suppressHover = false;
            update();
        });
        this.container.addEventListener('click', () => {
            this.isPinnedOpen = !this.isPinnedOpen;
            // A second click must close immediately, even while still hovered.
            this.suppressHover = !this.isPinnedOpen;
            update();
        });
        update();
    }

    // The live header is entry one: reveal three histories and half the next.
    setupHistoryViewport() {
        this.historyCue = document.createElement('div');
        this.historyCue.className = 'printer-log-scroll-cue';
        this.historyCue.setAttribute('aria-hidden', 'true');
        this.container.appendChild(this.historyCue);
        this.contentWrapper.addEventListener('scroll', () => this.updateHistoryCue(), { passive: true });
        this.historyObserver = new ResizeObserver(() => this.measureHistoryViewport());
        this.historyObserver.observe(this.messagesContainer);
        this.historyViewportObserver = new ResizeObserver(() => this.updateHistoryCue());
        this.historyViewportObserver.observe(this.contentWrapper);
    }

    measureHistoryViewport() {
        const rows = this.messagesContainer.children;
        if (!rows.length || !this.messagesContainer.getBoundingClientRect().width) return;
        const partial = rows[3];
        if (partial) {
            // Layout pixels avoid double-scaling when the app uses CSS zoom.
            const firstTop = rows[0].offsetTop;
            const partialTop = partial.offsetTop;
            const partialHeight = partial.offsetHeight;
            const style = getComputedStyle(this.contentWrapper);
            const topInset = parseFloat(style.paddingTop) + parseFloat(style.borderTopWidth);
            const height = topInset + partialTop - firstTop + partialHeight / 2;
            this.contentWrapper.style.setProperty('--log-history-height', height + 'px');
            this.container.style.setProperty('--log-cue-height', partialHeight / 2 + 'px');
        } else {
            this.contentWrapper.style.setProperty('--log-history-height', 'none');
        }
        this.updateHistoryCue();
    }

    updateHistoryCue() {
        const view = this.contentWrapper;
        const moreBelow = view.scrollHeight - view.clientHeight - view.scrollTop > 1;
        this.container.classList.toggle('log-more-below', moreBelow);
    }

    setupAnchor() {
        const toolbar = document.getElementById('topBar');
        const leftPanel = document.getElementById('leftContainer');
        if (!toolbar || !leftPanel) return;
        const align = () => {
            const inset = toolbar.getBoundingClientRect().top - leftPanel.getBoundingClientRect().top;
            this.container.style.top = Math.max(0, inset) + 'px';
        };
        this.anchorObserver = new ResizeObserver(align);
        this.anchorObserver.observe(toolbar);
        this.anchorObserver.observe(leftPanel);
        window.addEventListener('resize', align);
        align();
    }

    connectSocket() {
        if (window.isDemoMode) return;   // demo mode never needs this socket
        try {
            this.socket = io(window.location.origin, {
                timeout: 2000,
                transports: ['websocket', 'polling'],
                reconnectionAttempts: 5
            });
            
            this.socket.on('connect', () => {
                this.isConnected = true;
                this.reconnectAttempts = 0;
                
                this.addMessage({
                    message: 'Connected to printer server',
                    status: 'complete'
                });
            });
            
            this.socket.on('printer_status', (data) => {
                this.addMessage(data);
            });

            // Handle print-specific events
            this.socket.on('homingCompleted', () => {
                this.addMessage({
                    message: 'Waiting for 5 layers...',
                    status: 'complete'
                });
            });

            // Handle raw printer responses
            this.socket.on('printer_response', ({ message, status }) => {
                this.addMessage({
                    message: message,
                    status: status || 'printer_raw'
                });
            });

            this.socket.on('layerStarted', ({ layerIndex }) => {
                this.addMessage({
                    message: `Layer ${layerIndex + 1} started - locking it.`,
                    status: 'printing'
                });
            });

            this.socket.on('layerCompleted', ({ layerIndex }) => {
                this.addMessage({
                    message: `Layer ${layerIndex + 1} done.`,
                    status: 'printing'
                });
            });

            this.socket.on('printCompleted', () => {
                this.addMessage({
                    message: 'Print job finished.',
                    status: 'complete'
                });
            });
            
            this.socket.on('disconnect', () => {
                this.isConnected = false;
                this.addMessage({
                    message: 'Disconnected from printer server',
                    status: 'error'
                });
            });
            
            this.socket.on('connect_error', (error) => {
                console.warn('Connection error (retrying):', error);
                this.isConnected = false;
                
                if (this.reconnectAttempts < this.maxReconnectAttempts) {
                    this.reconnectAttempts++;
                    this.addMessage({
                        message: `Connection failed. Retry ${this.reconnectAttempts}/${this.maxReconnectAttempts}...`,
                        status: 'error'
                    });
                } else {
                    this.addMessage({
                        message: 'Server unavailable - please start the server',
                        status: 'error'
                    });
                    // No more demo mode - just show connection error
                }
            });
            
        } catch (error) {
            console.error('Failed to initialize socket:', error);
            this.addMessage({
                message: 'Failed to connect to server - please start the server',
                status: 'error'
            });
            // No demo mode - user should start the server
        }
    }
    
    addMessage(data) {
        const message = {
            text: data.message,
            status: data.status,
            id: Date.now() + Math.random()
        };
        
        
        // Update the current message highlight with the latest message
        // DOM-safe severity rendering — message.text never touches innerHTML (XSS-safe, T-03-05)
        const isLegacyWarning = message.status !== 'warning' && typeof message.text === 'string' &&
            message.text.startsWith('!') && message.text.includes('!');
        const effectiveStatus = isLegacyWarning ? 'warning' : message.status;

        const severityClass = {
            'error':   'log-severity-error',
            'warning': 'log-severity-warning',
            'success': 'log-severity-success',
        }[effectiveStatus] || '';

        const iconGlyph = {
            'error':   '⚠',
            'warning': '⚠',
            'success': '✓',
        }[effectiveStatus] || '';

        const node = document.createElement('span');
        node.className = ('log-severity ' + severityClass).trim();

        if (iconGlyph) {
            const iconEl = document.createElement('span');
            iconEl.className = 'log-icon';
            iconEl.setAttribute('aria-hidden', 'true');
            iconEl.textContent = iconGlyph;   // static glyph — safe
            node.appendChild(iconEl);
        }

        const textEl = document.createElement('span');
        node.appendChild(textEl);

        const fullText = typeof message.text === 'string' ? message.text : String(message.text);

        // Announce the full final string ONCE to screen readers (decoupled from the visual typing).
        const isSevere = (effectiveStatus === 'error' || effectiveStatus === 'warning');
        this.srMirror.setAttribute('aria-live', isSevere ? 'assertive' : 'polite');
        this.srMirror.textContent = fullText;

        this.currentMessageHighlight.replaceChildren(node);

        // Decide instant vs typewriter reveal:
        //  - severe (error/warning): show instantly so safety-critical text is never withheld
        //  - reduced-motion / hidden tab: show instantly
        //  - already typing a previous message (burst): show instantly so we never lag real state
        const showInstant = isSevere || this._reduceMotion || document.hidden || this._typing;
        if (showInstant) {
            this.flushTyping();              // finalize any in-flight reveal (keeps up during bursts)
            textEl.textContent = fullText;   // textContent never interprets HTML — XSS-safe
        } else {
            this.typeInto(textEl, fullText); // progressive textContent.slice — still XSS-safe
        }

        // D-07: pulse once on error/warning arrival only (not info/printing/success)
        if (effectiveStatus === 'error' || effectiveStatus === 'warning') {
            node.classList.add('pulse');
            node.addEventListener('animationend', () => node.classList.remove('pulse'), { once: true });
        }

        // Add current message to array for history
        this.messages.push(message);

        // Re-render all messages except the current one (which is in highlight)
        this.render();

        // Remove old messages if exceeding max count
        if (this.messages.length > this.maxMessages) {
            this.messages.shift();
            this.render(); // Re-render after removing old message
        }

    }
    
    // Progressive character reveal of `full` into `el` via textContent slicing (XSS-safe).
    // Speed scales so total reveal is capped at ~600ms regardless of length; uses rAF so it
    // stays frame-synced and auto-throttles when the tab is backgrounded.
    typeInto(el, full) {
        this.flushTyping(); // only ever one message types at a time
        if (!full) { el.textContent = ''; return; }
        const msPerChar = Math.min(22, Math.max(6, 600 / full.length));
        this._typeState = { el, full, start: null, msPerChar };
        this._typing = true;
        el.textContent = '';
        const step = (ts) => {
            const s = this._typeState;
            if (!s) return;
            if (s.start === null) s.start = ts;
            const chars = Math.floor((ts - s.start) / s.msPerChar);
            if (chars >= s.full.length) {
                s.el.textContent = s.full;
                this._typing = false;
                this._typeState = null;
                this._typeRaf = null;
                return;
            }
            s.el.textContent = s.full.slice(0, Math.max(0, chars));
            this._typeRaf = requestAnimationFrame(step);
        };
        this._typeRaf = requestAnimationFrame(step);
    }

    // Instantly complete any in-flight reveal (used on bursts, reduced-motion, hidden tab).
    flushTyping() {
        if (this._typeRaf) { cancelAnimationFrame(this._typeRaf); this._typeRaf = null; }
        if (this._typeState) {
            this._typeState.el.textContent = this._typeState.full;
            this._typeState = null;
        }
        this._typing = false;
    }

    scrollToTop() {
        // new5: with newest-first ordering, keep the most recent entry visible at the top.
        // Use requestAnimationFrame to ensure DOM is updated before scrolling.
        requestAnimationFrame(() => {
            if (this.contentWrapper) {
                this.contentWrapper.scrollTop = 0;
                this.measureHistoryViewport();
            }
        });
    }
    
    render() {
        // Clear existing messages (replaceChildren with no args is the DOM-safe equivalent of innerHTML='')
        this.messagesContainer.replaceChildren();
        
        // Render all messages except the last one (which is shown in highlight).
        // new5: newest-first — most recent at the TOP, oldest at the bottom. `.reverse()`
        // acts on the slice copy, so `this.messages` (append-order) is untouched.
        const messagesToShow = this.messages.slice(0, -1).reverse();
        messagesToShow.forEach((message) => {
            const messageEl = document.createElement('div');
            messageEl.className = 'printer-message';
            
            // Apply styling based on status — DOM-safe, no innerHTML with message content (T-03-05)
            const isLegacyWarn = typeof message.text === 'string' &&
                message.status !== 'warning' && message.text.startsWith('!') && message.text.includes('!');
            const effStatus = isLegacyWarn ? 'warning' : message.status;

            const sevClass = {
                'error':   'log-severity-error',
                'warning': 'log-severity-warning',
                'success': 'log-severity-success',
            }[effStatus] || '';

            const icon = {
                'error':   '⚠',
                'warning': '⚠',
                'success': '✓',
            }[effStatus] || '';

            const msgNode = document.createElement('span');
            msgNode.className = ('log-severity ' + sevClass).trim();

            if (icon) {
                const iconEl = document.createElement('span');
                iconEl.className = 'log-icon';
                iconEl.setAttribute('aria-hidden', 'true');
                iconEl.textContent = icon;   // static glyph — safe
                msgNode.appendChild(iconEl);
            }

            const bodyEl = document.createElement('span');
            bodyEl.textContent = message.text;   // textContent — XSS-safe
            msgNode.appendChild(bodyEl);

            messageEl.replaceChildren(msgNode);
            
            this.messagesContainer.appendChild(messageEl);
        });
        
        
        // Scroll to top after rendering — newest entry stays in view (new5)
        this.scrollToTop();
    }
    
    getStatusColor(status) {
        return 'black';
    }
    
    startPrint() {
        if (this.socket && this.isConnected) {
            this.socket.emit('start_print');
        } else {
            this.addMessage({
                message: 'Cannot start print - server not connected',
                status: 'error'
            });
        }
    }
    
    disconnect() {
        if (this.socket) {
            this.socket.disconnect();
        }
    }
}

// Create an instance of PrinterLog and make it globally accessible
const printerLog = new PrinterLog('PrinterLog');
window.printerLog = printerLog;

console.log('Printer Log initialized and made globally accessible');

// Export the class for use in other files
window.PrinterLog = PrinterLog;
