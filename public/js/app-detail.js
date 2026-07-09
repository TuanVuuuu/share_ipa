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

async function init() {
    const params = new URLSearchParams(window.location.search);
    const bundleId = (params.get('bundle') || '').trim();

    if (!bundleId) {
        detailView.stopLoading();
        detailView.showEmpty('Thiếu thông tin ứng dụng.');
        return;
    }

    document.getElementById('detail-share-btn').style.display = 'inline-block';

    try {
        const res = await fetch(`/api/app-builds?bundle=${encodeURIComponent(bundleId)}`);
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) {
            throw new Error(data.message || 'Không tải được danh sách build.');
        }

        const builds = Array.isArray(data.builds) ? data.builds : [];
        if (!builds.length) {
            detailView.showEmpty(`Không có bản build nào cho "${bundleId}".`);
            return;
        }

        detailView.renderAppDetail({ latest: builds[0], builds });
    } catch (err) {
        detailView.stopLoading();
        document.getElementById('detail-page-sub').innerText = `Lỗi: ${err.message}`;
    }
}

init();
