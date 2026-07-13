const detailView = CatalogDetail.createDetailView({
    appDetailZone: document.getElementById('app-detail-zone'),
    detailPageSub: document.getElementById('detail-page-sub'),
    detailHeader: document.getElementById('detail-header'),
    detailIcon: document.getElementById('detail-icon'),
    detailName: document.getElementById('detail-name'),
    detailBundle: document.getElementById('detail-bundle'),
    detailBuilds: document.getElementById('detail-builds'),
    detailEmpty: document.getElementById('detail-empty'),
    detailAuth: null,
    detailShareBtn: document.getElementById('detail-share-btn'),
    qrModal: document.getElementById('qr-modal'),
    qrModalClose: document.getElementById('qr-modal-close'),
    qrModalTitle: document.getElementById('qr-modal-title'),
    qrModalVersion: document.getElementById('qr-modal-version'),
    qrModalImage: document.getElementById('qr-modal-image'),
    qrModalUrl: document.getElementById('qr-modal-url'),
    qrModalCopy: document.getElementById('qr-modal-copy'),
    qrModalInstall: document.getElementById('qr-modal-install')
});

function parseAppDetailRoute() {
    const match = window.location.pathname.match(/^\/(ios|android)\/app\/?$/);
    if (match) {
        return {
            platform: match[1],
            bundleId: (new URLSearchParams(window.location.search).get('bundle') || '').trim(),
        };
    }

    // Tương thích cũ: /app?bundle=...&platform=...
    if (window.location.pathname === '/app') {
        const params = new URLSearchParams(window.location.search);
        const bundleId = (params.get('bundle') || '').trim();
        const platform = params.get('platform') === 'android' ? 'android' : 'ios';
        return { platform, bundleId };
    }

    return { platform: 'ios', bundleId: '' };
}

async function init() {
    const { platform, bundleId } = parseAppDetailRoute();

    if (!bundleId) {
        detailView.stopLoading();
        detailView.showEmpty('Thiếu thông tin ứng dụng.');
        return;
    }

    // Chuẩn hoá URL nếu còn đang ở /app cũ
    if (window.location.pathname === '/app') {
        const canonical = `/${platform}/app?bundle=${encodeURIComponent(bundleId)}`;
        history.replaceState(null, '', canonical);
    }

    document.getElementById('detail-share-btn').style.display = 'inline-block';

    try {
        const res = await fetch(
            `/api/app-builds?bundle=${encodeURIComponent(bundleId)}&platform=${encodeURIComponent(platform)}`
        );
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) {
            throw new Error(data.message || 'Không tải được danh sách build.');
        }

        const builds = Array.isArray(data.builds) ? data.builds : [];
        if (!builds.length) {
            detailView.showEmpty(`Không có bản build ${platform === 'android' ? 'Android' : 'iOS'} nào cho "${bundleId}".`);
            return;
        }

        detailView.renderAppDetail({ latest: builds[0], builds });
    } catch (err) {
        detailView.stopLoading();
        document.getElementById('detail-page-sub').innerText = `Lỗi: ${err.message}`;
    }
}

init();
