(function (global) {
    function checkUrl() {
        const raw = global.__VPN_CHECK_URL__;
        if (raw && String(raw).indexOf('__VPN_CHECK__') === -1) return String(raw);
        return 'http://10.110.131.11:8888';
    }

    async function grantAndReload() {
        const res = await fetch('/api/vpn-grant', { method: 'POST' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) {
            throw new Error(data.message || 'Không xác thực được mạng.');
        }
        global.location.reload();
    }

    function render() {
        const wrap = document.createElement('div');
        wrap.className = 'vpn-gate';
        wrap.innerHTML = `
            <h3>Kiểm tra mạng</h3>
            <p data-vpn-hint>Ứng dụng này cần VPN. Bấm xác thực để mở trang kiểm tra. Nếu chưa bật VPN, trình duyệt sẽ báo lỗi mạng.</p>
            <div class="vpn-gate-actions">
                <button type="button" class="btn vpn-lan-btn" data-vpn-open>Xác thực mạng</button>
                <button type="button" class="btn secondary" data-vpn-continue style="display:none;">Trang đã mở được — tiếp tục</button>
            </div>
        `;
        return wrap;
    }

    function bind(wrap) {
        const hint = wrap.querySelector('[data-vpn-hint]');
        const openBtn = wrap.querySelector('[data-vpn-open]');
        const contBtn = wrap.querySelector('[data-vpn-continue]');
        if (!openBtn || !contBtn || !hint) return;

        let popup = null;

        const finish = () => {
            if (popup && !popup.closed) {
                try { popup.close(); } catch (_) { /* iOS có thể không đóng tab */ }
            }
            popup = null;
            grantAndReload().catch((err) => {
                hint.textContent = err.message || 'Không xác thực được mạng.';
            });
        };

        openBtn.addEventListener('click', () => {
            const url = checkUrl();
            popup = global.open(url, 'share-ipa-vpn-check');
            contBtn.style.display = '';
            if (!popup) {
                hint.textContent = 'Không mở được tab mới. Tự mở ' + url + ' trên trình duyệt. Nếu vào được thì quay lại đây và bấm Tiếp tục.';
                return;
            }
            hint.textContent = 'Đã mở trang kiểm tra. Nếu trình duyệt báo lỗi mạng: đóng tab đó, bật VPN rồi xác thực lại. Nếu vào được: bấm Tiếp tục — tab kiểm tra sẽ đóng và quay về đây.';
        });

        contBtn.addEventListener('click', finish);
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
