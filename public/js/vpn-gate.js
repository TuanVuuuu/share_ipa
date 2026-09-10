(function (global) {
    function escapeHtml(text) {
        return String(text == null ? '' : text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    async function consumeGrantFromUrl() {
        const params = new URLSearchParams(global.location.search);
        const token = (params.get('vpn_grant') || '').trim();
        if (!token) return false;
        params.delete('vpn_grant');
        const next = global.location.pathname
            + (params.toString() ? `?${params}` : '')
            + global.location.hash;
        try {
            const res = await fetch('/api/vpn-redeem', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify({ token }),
            });
            history.replaceState(null, '', next);
            if (res.ok) {
                global.location.reload();
                return true;
            }
        } catch (_) {
            history.replaceState(null, '', next);
        }
        return false;
    }

    async function resolveLanGrantUrl() {
        let lanBase = '';
        const embedded = String(global.__LAN_BASE_URL__ || '').trim();
        if (embedded && embedded.indexOf('__LAN_BASE__') === -1) {
            lanBase = embedded.replace(/\/$/, '');
        }
        if (!lanBase) {
            try {
                const res = await fetch('/api/lan-info', { cache: 'no-store' });
                const info = await res.json();
                lanBase = (info && info.baseUrl) ? String(info.baseUrl).replace(/\/$/, '') : '';
            } catch (_) {
                return '';
            }
        }
        if (!lanBase) return '';
        const next = encodeURIComponent(global.location.href.split('#')[0]);
        return `${lanBase}/api/vpn-grant?next=${next}`;
    }

    function render(lanGrantUrl) {
        const wrap = document.createElement('div');
        wrap.className = 'vpn-gate';
        wrap.innerHTML = `
            <h3>Yêu cầu truy cập bị từ chối</h3>
            <p>Liên hệ Admin để được cấp quyền truy cập.</p>
            ${lanGrantUrl ? `<a class="btn vpn-lan-btn" href="${escapeHtml(lanGrantUrl)}">Đã bật VPN — tiếp tục</a>` : ''}
        `;
        return wrap;
    }

    async function mount(container) {
        if (!container) return;
        container.innerHTML = '';
        const inModal = !!container.closest('.modal-card');
        container.classList.toggle('is-open', !inModal);
        container.classList.toggle('is-embedded', inModal);
        container.style.display = '';
        if (inModal) container.closest('.modal-card').classList.add('is-denied');
        const lanGrantUrl = await resolveLanGrantUrl();
        container.innerHTML = '';
        container.appendChild(render(lanGrantUrl));
    }

    function hide(container) {
        if (!container) return;
        const modal = container.closest('.modal-card');
        if (modal) modal.classList.remove('is-denied');
        container.classList.remove('is-open', 'is-embedded');
        container.innerHTML = '';
        container.style.display = 'none';
    }

    consumeGrantFromUrl();
    global.VpnGate = { render, mount, hide };
})(window);
