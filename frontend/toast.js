// Lightweight toast notifications for the DIRECTED UI.
// Exposes window.showToast(message, options).
//
// options = {
//   status: 'info' | 'success' | 'error' | 'warning'  (default 'info'),
//   duration: milliseconds the toast stays visible (default 3000)
// }
(function () {
    function getContainer() {
        let container = document.getElementById('toastContainer');
        if (!container) {
            container = document.createElement('div');
            container.id = 'toastContainer';
            container.className = 'toast-container';
            container.setAttribute('aria-live', 'polite');
            container.setAttribute('aria-atomic', 'false');
            document.body.appendChild(container);
        }
        return container;
    }

    function showToast(message, options) {
        const opts = options || {};
        const status = opts.status || 'info';
        const duration = typeof opts.duration === 'number' ? opts.duration : 3000;

        const container = getContainer();

        const toast = document.createElement('div');
        toast.className = `toast toast-${status}`;
        toast.setAttribute('role', 'status');
        toast.textContent = message;

        container.appendChild(toast);

        // Force a reflow so the enter transition runs.
        // eslint-disable-next-line no-unused-expressions
        toast.offsetHeight;
        toast.classList.add('toast-visible');

        const remove = () => {
            toast.classList.remove('toast-visible');
            toast.addEventListener('transitionend', () => {
                if (toast.parentNode) {
                    toast.parentNode.removeChild(toast);
                }
            }, { once: true });
            // Fallback removal in case transitionend never fires.
            setTimeout(() => {
                if (toast.parentNode) {
                    toast.parentNode.removeChild(toast);
                }
            }, 500);
        };

        const timer = setTimeout(remove, duration);

        // Allow click-to-dismiss.
        toast.addEventListener('click', () => {
            clearTimeout(timer);
            remove();
        });

        return toast;
    }

    window.showToast = showToast;
})();
