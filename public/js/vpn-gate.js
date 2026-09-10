(function (global) {
    function escapeHtml(text) {
        return String(text == null ? '' : text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function render(info) {
        const vpn = info || {};
        const portal = vpn.portalUrl || '';
        const clientIp = vpn.clientIp || '';
        const wrap = document.createElement('div');
        wrap.className = 'vpn-gate';
        wrap.innerHTML = `
            <h3>Cần kết nối VPN</h3>
            <p>Ứng dụng này chỉ mở khi máy bạn đang đi qua VPN công ty. Dùng tài khoản VPN của bạn, sau đó tải lại trang này.</p>
            ${portal ? `<p><a href="${escapeHtml(portal)}" target="_blank" rel="noopener">Mở trang đăng nhập VPN</a></p>` : ''}
            ${clientIp ? `<p class="vpn-ip">IP hiện tại: <code>${escapeHtml(clientIp)}</code></p>` : ''}
            <button type="button" class="btn vpn-lan-btn" id="vpn-reload-btn">Đã bật VPN — tải lại trang</button>
        `;
        const reloadBtn = wrap.querySelector('#vpn-reload-btn');
        if (reloadBtn) reloadBtn.addEventListener('click', () => window.location.reload());
        return wrap;
    }

    function mount(container, info) {
        if (!container) return;
        container.innerHTML = '';
        container.appendChild(render(info));
        container.style.display = '';
    }

    function hide(container) {
        if (!container) return;
        container.innerHTML = '';
        container.style.display = 'none';
    }

    global.VpnGate = { render, mount, hide };
})(window);
