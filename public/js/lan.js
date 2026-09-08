/**
 * Ưu tiên tải IPA/APK qua LAN khi thiết bị cùng mạng với máy chủ.
 * Probe /api/lan-info + /api/lan-ping; nếu tới được → rewrite downloadUrl sang host nội bộ.
 */
(function (global) {
    const PROBE_TIMEOUT_MS = 900;
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
            // iOS OTA cần HTTPS (trừ localhost khi dev)
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

    async function probeLanPing(baseUrl) {
        if (!baseUrl) return false;
        const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
        const timer = ctrl ? setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS) : null;
        try {
            const res = await fetch(`${baseUrl}/api/lan-ping`, {
                method: 'GET',
                mode: 'cors',
                cache: 'no-store',
                signal: ctrl ? ctrl.signal : undefined,
            });
            if (!res.ok) return false;
            const data = await res.json().catch(() => null);
            return !!(data && data.ok);
        } catch (_) {
            return false;
        } finally {
            if (timer) clearTimeout(timer);
        }
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

        if (!info || !info.success || !info.baseUrl) return null;

        try {
            if (new URL(info.baseUrl).origin === global.location.origin) {
                return info.baseUrl;
            }
        } catch (_) { /* ignore */ }

        return (await probeLanPing(info.baseUrl)) ? info.baseUrl : null;
    }

    function getLanBase() {
        if (!cachedPromise) cachedPromise = resolveLanBase();
        return cachedPromise;
    }

    async function preferDownloadUrl(item) {
        const fallback = rewriteLegacyHost(item && item.downloadUrl);
        if (!item || !item.id) return fallback;

        const lanBase = await getLanBase();
        if (!lanBase) return fallback;

        // Chỉ dùng LAN khi server xác nhận còn file local (tránh 404 với bản chỉ trên R2 cũ)
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
        isActive: async () => !!(await getLanBase()),
    };
})(typeof window !== 'undefined' ? window : globalThis);
