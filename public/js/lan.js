/**
 * Ưu tiên tải/upload IPA/APK qua LAN khi thiết bị cùng mạng với máy chủ.
 * Probe fetch + pixel (tránh mixed content) + WebRTC cùng subnet.
 */
(function (global) {
    const PROBE_TIMEOUT_MS = 2500;
    let cachedPromise = null;

    function isPrivateHostname(hostname) {
        const host = String(hostname || '').split(':')[0].toLowerCase();
        if (!host) return false;
        if (host === 'localhost' || host.endsWith('.local')) return true;
        if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return true;
        const m = host.match(/^172\.(\d+)\./);
        if (m) {
            const n = Number(m[1]);
            return n >= 16 && n <= 31;
        }
        if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)) return true;
        return false;
    }

    function rewriteLegacyHost(value) {
        if (!value || typeof value !== 'string') return value;
        return value.replace(/share-ipa\.vunt\.info/g, global.location.host);
    }

    function canUseLanForPlatform(platform, lanBase) {
        if (!lanBase) return false;
        try {
            const u = new URL(lanBase);
            if ((platform || 'ios') === 'android') return true;
            return u.protocol === 'https:'
                || u.hostname === 'localhost'
                || u.hostname === '127.0.0.1';
        } catch (_) {
            return false;
        }
    }

    function buildLanDownloadUrl(item, lanBase) {
        if (!item || !item.id || !lanBase) return null;
        const platform = item.platform || 'ios';
        if (!canUseLanForPlatform(platform, lanBase)) return null;
        if (platform === 'android') {
            return `${lanBase}/uploads/${encodeURIComponent(item.id)}`;
        }
        const plist = String(item.id).toLowerCase().endsWith('.plist')
            ? item.id
            : `${item.id}.plist`;
        const manifestUrl = `${lanBase}/uploads/${encodeURIComponent(plist)}`;
        return `itms-services://?action=download-manifest&url=${encodeURIComponent(manifestUrl)}`;
    }

    function sameIpv4Subnet(a, b) {
        const pa = String(a || '').split('.').map(Number);
        const pb = String(b || '').split('.').map(Number);
        if (pa.length !== 4 || pb.length !== 4 || pa.some(Number.isNaN) || pb.some(Number.isNaN)) {
            return false;
        }
        if (pa[0] === 192 && pa[1] === 168) {
            return pb[0] === 192 && pb[1] === 168 && pa[2] === pb[2];
        }
        if (pa[0] === 10) return pb[0] === 10 && pa[1] === pb[1];
        if (pa[0] === 172 && pa[1] >= 16 && pa[1] <= 31) {
            return pb[0] === 172 && pa[1] === pb[1];
        }
        if (pa[0] === 100 && pa[1] >= 64 && pa[1] <= 127) {
            return pb[0] === 100 && pa[1] === pb[1] && pa[2] === pb[2];
        }
        return false;
    }

    function probeLanPing(baseUrl) {
        if (!baseUrl) return Promise.resolve(false);
        const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
        const timer = ctrl ? setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS) : null;
        return fetch(`${baseUrl}/api/lan-ping`, {
            method: 'GET',
            mode: 'cors',
            cache: 'no-store',
            signal: ctrl ? ctrl.signal : undefined,
        }).then((res) => {
            if (!res.ok) return false;
            return res.json().catch(() => null).then((data) => !!(data && data.ok));
        }).catch(() => false).finally(() => {
            if (timer) clearTimeout(timer);
        });
    }

    function probeLanPixel(baseUrl) {
        if (!baseUrl) return Promise.resolve(false);
        return new Promise((resolve) => {
            const img = new Image();
            const timer = setTimeout(() => {
                img.onload = img.onerror = null;
                img.src = '';
                resolve(false);
            }, PROBE_TIMEOUT_MS);
            const done = (ok) => {
                clearTimeout(timer);
                img.onload = img.onerror = null;
                resolve(ok);
            };
            img.onload = () => done(true);
            img.onerror = () => done(false);
            img.referrerPolicy = 'no-referrer';
            img.src = `${baseUrl}/api/lan-pixel?t=${Date.now()}`;
        });
    }

    async function probeLan(baseUrl) {
        if (await probeLanPing(baseUrl)) return true;
        return probeLanPixel(baseUrl);
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
            const timer = setTimeout(finish, 800);
            try {
                pc = new RTC({ iceServers: [] });
                pc.createDataChannel('lan');
                pc.onicecandidate = (e) => {
                    const cand = e && e.candidate && e.candidate.candidate;
                    if (!cand) return;
                    const m = cand.match(/([0-9]{1,3}(?:\.[0-9]{1,3}){3})/);
                    if (m && isPrivateHostname(m[1])) ips.add(m[1]);
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

    async function resolveLanBase() {
        if (isPrivateHostname(global.location.hostname)) {
            return global.location.origin;
        }

        let info = null;
        try {
            const res = await fetch('/api/lan-info', { cache: 'no-store' });
            info = await res.json();
        } catch (_) {
            return null;
        }

        if (!info || !info.success) return null;

        if (info.viaLanHost) {
            return global.location.origin;
        }

        const candidates = Array.isArray(info.candidates) && info.candidates.length
            ? info.candidates
            : (info.baseUrl ? [info.baseUrl] : []);

        const probes = await Promise.all(candidates.map(async (url) => {
            try {
                if (new URL(url).origin === global.location.origin) return url;
            } catch (_) { /* ignore */ }
            return (await probeLan(url)) ? url : null;
        }));
        const probed = probes.find(Boolean);
        if (probed) return probed;

        const localIps = await discoverLocalIpv4s();
        const serverIps = Array.isArray(info.addresses) ? info.addresses : [];
        let fallbackPort = '3000';
        try {
            if (info.baseUrl) fallbackPort = new URL(info.baseUrl).port || '3000';
        } catch (_) { /* ignore */ }
        for (const serverIp of serverIps) {
            if (!localIps.some((lip) => sameIpv4Subnet(lip, serverIp))) continue;
            const match = candidates.find((c) => c.indexOf(serverIp) !== -1);
            return match || `http://${serverIp}:${fallbackPort}`;
        }

        return null;
    }

    function getLanBase() {
        if (!cachedPromise) cachedPromise = resolveLanBase();
        return cachedPromise;
    }

    async function canUploadLocally() {
        if (isPrivateHostname(global.location.hostname)) return true;
        const lanBase = await getLanBase();
        if (!lanBase) return false;
        try {
            return new URL(lanBase).origin === global.location.origin;
        } catch (_) {
            return false;
        }
    }

    async function preferDownloadUrl(item) {
        const fallback = rewriteLegacyHost(item && item.downloadUrl);
        if (!item || !item.id) return fallback;

        const lanBase = await getLanBase();
        if (!lanBase) return fallback;

        const sameOrigin = lanBase === global.location.origin;
        if (!sameOrigin && item.localFileAvailable !== true) return fallback;

        return buildLanDownloadUrl(item, lanBase) || fallback;
    }

    async function applyDownloadHref(anchor, item) {
        if (!anchor || !item) return rewriteLegacyHost(item && item.downloadUrl);
        const url = await preferDownloadUrl(item);
        if (url) anchor.href = url;
        return url;
    }

    global.LanTransfer = {
        getLanBase,
        preferDownloadUrl,
        applyDownloadHref,
        buildLanDownloadUrl,
        rewriteLegacyHost,
        canUploadLocally,
        isPrivateHostname,
        isActive: async () => !!(await getLanBase()),
    };
})(typeof window !== 'undefined' ? window : globalThis);
