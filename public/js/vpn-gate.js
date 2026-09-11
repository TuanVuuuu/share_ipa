(function (global) {
    const TIMEOUT_MS = 3000;
    const POLL_MS = 150;
    const MSG_DENIED = 'Không có quyền truy cập';
    const MSG_AUTH_ERROR = 'Xác thực lỗi';

    function checkUrl() {
        const raw = String(global.__VPN_CHECK_URL__ || '').trim();
        if (!raw || raw.indexOf('__VPN_CHECK__') !== -1) return '';
        return raw;
    }

    function popupState(win) {
        if (!win) return 'blocked';
        if (win.closed) return 'closed';
        try {
            const href = String((win.location && win.location.href) || '');
            if (!href || href === 'about:blank') return 'pending';
            return 'pending';
        } catch (_) {
            return 'ready';
        }
    }

    function closePopup(win) {
        if (!win || win.closed) return;
        try { win.close(); } catch (_) { /* iOS có thể không đóng được */ }
    }

    async function grantAndReload() {
        const res = await fetch('/api/vpn-grant', { method: 'POST' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) {
            throw new Error(MSG_AUTH_ERROR);
        }
        global.location.reload();
    }

    function render() {
        const wrap = document.createElement('div');
        wrap.className = 'vpn-gate';
        wrap.innerHTML = `
            <h3>${MSG_DENIED}</h3>
            <p data-vpn-hint></p>
            <div class="vpn-gate-actions">
                <button type="button" class="btn vpn-lan-btn" data-vpn-open>Xác thực</button>
            </div>
        `;
        return wrap;
    }

    function bind(wrap) {
        const hint = wrap.querySelector('[data-vpn-hint]');
        const openBtn = wrap.querySelector('[data-vpn-open]');
        if (!openBtn || !hint) return;

        let timer = null;
        const stop = () => {
            if (timer) {
                clearInterval(timer);
                timer = null;
            }
        };

        const fail = (win) => {
            stop();
            closePopup(win);
            openBtn.disabled = false;
            hint.textContent = MSG_AUTH_ERROR;
        };

        openBtn.addEventListener('click', () => {
            const url = checkUrl();
            if (!url) {
                hint.textContent = MSG_AUTH_ERROR;
                return;
            }

            stop();
            openBtn.disabled = true;
            hint.textContent = '';

            const win = global.open(url, 'share-ipa-vpn-check');
            if (!win) {
                fail(null);
                return;
            }

            const started = Date.now();
            let sawPending = false;
            timer = setInterval(() => {
                const state = popupState(win);
                if (state === 'pending') sawPending = true;
                if (state === 'ready' && sawPending) {
                    stop();
                    closePopup(win);
                    grantAndReload().catch(() => {
                        openBtn.disabled = false;
                        hint.textContent = MSG_AUTH_ERROR;
                    });
                    return;
                }
                if (state === 'closed' || Date.now() - started >= TIMEOUT_MS) {
                    fail(win);
                }
            }, POLL_MS);
        });
    }

    function mount(container) {
        if (!container) return;
        container.innerHTML = '';
        const wrap = render();
        container.appendChild(wrap);
        bind(wrap);
        const inModal = !!container.closest('.modal-card');
        container.classList.toggle('is-open', !inModal);
        container.classList.toggle('is-embedded', inModal);
        container.style.display = '';
        if (inModal) container.closest('.modal-card').classList.add('is-denied');
    }

    function hide(container) {
        if (!container) return;
        const modal = container.closest('.modal-card');
        if (modal) modal.classList.remove('is-denied');
        container.classList.remove('is-open', 'is-embedded');
        container.innerHTML = '';
        container.style.display = 'none';
    }

    global.VpnGate = { render, mount, hide };
})(window);
