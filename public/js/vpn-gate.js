(function (global) {
    function render() {
        const wrap = document.createElement('div');
        wrap.className = 'vpn-gate';
        wrap.innerHTML = `
            <h3>Yêu cầu truy cập bị từ chối</h3>
            <p>Liên hệ Admin để được cấp quyền truy cập.</p>
        `;
        return wrap;
    }

    function mount(container) {
        if (!container) return;
        container.innerHTML = '';
        container.appendChild(render());
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
