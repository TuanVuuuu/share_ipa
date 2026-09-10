(function (global) {
    const TIMEOUT_MS = 3000;
    const POLL_MS = 150;

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
            throw new Error(data.message || 'Xác thực thất bại.');
        }
        global.location.reload();
    }

    function render() {
        const wrap = document.createElement('div');
        wrap.className = 'vpn-gate';
        wrap.innerHTML = `
            <h3>Kiểm tra mạng</h3>
            <p data-vpn-hint>Ứng dụng này cần VPN. Bấm xác thực để mở trang kiểm tra (tối đa 3 giây).</p>
            <div class="vpn-gate-actions">
                <button type="button" class="btn vpn-lan-btn" data-vpn-open>Xác thực mạng</button>
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

        const fail = (win, message) => {
            stop();
            closePopup(win);
            openBtn.disabled = false;
            hint.textContent = message;
        };

        openBtn.addEventListener('click', () => {
            const url = checkUrl();
            if (!url) {
                hint.textContent = 'Chưa cấu hình VPN_CHECK_URL trên server.';
                return;
            }

            stop();
            openBtn.disabled = true;
            hint.textContent = 'Đang kiểm tra mạng…';

            const win = global.open(url, 'share-ipa-vpn-check');
            if (!win) {
                fail(null, 'Xác thực thất bại. Trình duyệt chặn tab mới — cho phép pop-up rồi thử lại.');
                return;
            }

            const started = Date.now();
            timer = setInterval(() => {
                const state = popupState(win);
                if (state === 'ready') {
                    stop();
                    closePopup(win);
                    hint.textContent = 'Xác thực thành công. Đang mở ứng dụng…';
                    grantAndReload().catch((err) => {
                        openBtn.disabled = false;
                        hint.textContent = err.message || 'Xác thực thất bại.';
                    });
                    return;
                }
                if (state === 'closed' || Date.now() - started >= TIMEOUT_MS) {
                    fail(win, 'Xác thực thất bại. Không nhận được phản hồi trong 3 giây — bật VPN rồi thử lại.');
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
