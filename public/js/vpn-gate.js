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

    function isTunnelIp(ip) {
        const n = String(ip || '').split('.').map(Number);
        if (n.length !== 4 || n.some((x) => !Number.isInteger(x))) return false;
        if (n[0] === 172 && n[1] === 20) return true;
        if (n[0] === 10 && n[1] === 8) return true;
        if (n[0] === 172 && n[1] === 27) return true;
        return false;
    }

    function discoverLocalIpv4s() {
        return new Promise((resolve) => {
            const RTC = global.RTCPeerConnection || global.webkitRTCPeerConnection;
            if (!RTC) {
                resolve([]);
                return;
            }
            const ips = new Set();
            let pc;
            const finish = () => {
                try { if (pc) pc.close(); } catch (_) { /* ignore */ }
                resolve([...ips]);
            };
            const timer = setTimeout(finish, 900);
            try {
                pc = new RTC({ iceServers: [] });
                pc.createDataChannel('vpn');
                pc.onicecandidate = (e) => {
                    const cand = e && e.candidate && e.candidate.candidate;
                    if (!cand) return;
                    const m = cand.match(/([0-9]{1,3}(?:\.[0-9]{1,3}){3})/);
                    if (m) ips.add(m[1]);
                };
                pc.createOffer().then((offer) => pc.setLocalDescription(offer)).catch(() => {
                    clearTimeout(timer);
                    finish();
                });
            } catch (_) {
                clearTimeout(timer);
                finish();
            }
        });
    }

    async function attestTunnel() {
        const ips = (await discoverLocalIpv4s()).filter(isTunnelIp);
        if (!ips.length) return false;
        const res = await fetch('/api/vpn-attest', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ ips }),
        });
        const data = await res.json().catch(() => null);
        return !!(data && data.success);
    }

    const ready = attestTunnel().catch(() => false);

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

    global.VpnGate = { render, mount, hide, ready };
})(window);
