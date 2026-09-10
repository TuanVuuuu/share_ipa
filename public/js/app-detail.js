let isAdminUser = false;

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
    detailVisibilityBtn: document.getElementById('detail-visibility-btn'),
    detailDeleteAllBtn: document.getElementById('detail-delete-all-btn'),
    detailHiddenBadge: document.getElementById('detail-hidden-badge'),
    canDeleteBuild: () => isAdminUser,
    canManageApp: () => isAdminUser,
    onDeleteBuild: handleDeleteBuild,
    onToggleVisibility: handleToggleVisibility,
    onDeleteAll: handleDeleteAll,
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

    if (window.location.pathname === '/app') {
        const params = new URLSearchParams(window.location.search);
        const bundleId = (params.get('bundle') || '').trim();
        const platform = params.get('platform') === 'android' ? 'android' : 'ios';
        return { platform, bundleId };
    }

    return { platform: 'ios', bundleId: '' };
}

function currentGroupFromBuilds(builds, hidden) {
    return {
        latest: builds[0],
        builds,
        hidden: !!hidden,
    };
}

async function handleToggleVisibility(group) {
    if (!isAdminUser || !group || !group.latest) return;
    const bundleId = group.latest.bundleId;
    const platform = group.latest.platform || 'ios';
    const nextHidden = !group.hidden;
    const confirmed = confirm(
        nextHidden
            ? `Ẩn "${group.latest.appName}" khỏi danh mục công khai?\nChỉ tài khoản admin còn nhìn thấy ứng dụng này.`
            : `Hiện lại "${group.latest.appName}" trong danh mục?`
    );
    if (!confirmed) return;

    detailView.setAdminBusy(true);
    try {
        const res = await fetch('/api/catalog/visibility', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ bundleId, platform, hidden: nextHidden })
        });
        const data = await res.json().catch(() => null);
        if (!res.ok || !data || !data.success) {
            throw new Error((data && data.message) || 'Cập nhật ẩn/hiện thất bại.');
        }
        const builds = (group.builds || []).map((item) => ({ ...item, hidden: nextHidden }));
        detailView.renderAppDetail(currentGroupFromBuilds(builds, nextHidden));
    } catch (err) {
        alert(err.message);
        detailView.setAdminBusy(false);
    }
}

async function handleDeleteAll(group) {
    if (!isAdminUser || !group || !group.latest) return;
    const bundleId = group.latest.bundleId;
    const platform = group.latest.platform || 'ios';
    const count = (group.builds && group.builds.length) || 0;
    const confirmed = confirm(
        `Xóa TẤT CẢ ${count} bản build của "${group.latest.appName}"?\n\n` +
        `Sẽ xóa toàn bộ thông tin đã lưu trên GitHub và toàn bộ file bản build trên máy chủ.\n` +
        `Hành động này KHÔNG THỂ hoàn tác.`
    );
    if (!confirmed) return;
    const confirmedAgain = confirm('Xác nhận lần nữa: xóa vĩnh viễn toàn bộ dữ liệu ứng dụng này?');
    if (!confirmedAgain) return;

    detailView.setAdminBusy(true);
    try {
        const res = await fetch('/api/catalog/delete-app', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ bundleId, platform })
        });
        const data = await res.json().catch(() => null);
        if (!res.ok || !data || !data.success) {
            throw new Error((data && data.message) || 'Xóa toàn bộ ứng dụng thất bại.');
        }
        window.location.href = platform === 'android' ? '/android' : '/ios';
    } catch (err) {
        alert(err.message);
        detailView.setAdminBusy(false);
    }
}

async function handleDeleteBuild(build) {
    if (!isAdminUser || !build) return;
    const confirmed = confirm(`Xóa bản build "${build.appName}" v${build.version} (Build ${build.buildNumber})?\nHành động này không thể hoàn tác.`);
    if (!confirmed) return;

    try {
        const res = await fetch('/api/catalog/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: build.id })
        });
        const data = await res.json().catch(() => null);
        if (!res.ok || !data || !data.success) {
            throw new Error((data && data.message) || 'Xóa bản build thất bại.');
        }
        await loadAppDetail();
    } catch (err) {
        alert(err.message);
    }
}

async function loadAppDetail() {
    const { platform, bundleId } = parseAppDetailRoute();

    if (!bundleId) {
        detailView.stopLoading();
        detailView.showEmpty('Thiếu thông tin ứng dụng.');
        return;
    }

    if (window.location.pathname === '/app') {
        const canonical = `/${platform}/app?bundle=${encodeURIComponent(bundleId)}`;
        history.replaceState(null, '', canonical);
    }

    try {
        const res = await fetch(
            `/api/app-builds?bundle=${encodeURIComponent(bundleId)}&platform=${encodeURIComponent(platform)}`
        );
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) {
            detailView.showEmpty(data.message || 'Không tải được danh sách build.');
            return;
        }

        const builds = Array.isArray(data.builds) ? data.builds : [];
        if (!builds.length) {
            detailView.showEmpty(`Không có bản build ${platform === 'android' ? 'Android' : 'iOS'} nào cho "${bundleId}".`);
            return;
        }

        detailView.renderAppDetail(currentGroupFromBuilds(builds, data.hidden));
    } catch (err) {
        detailView.stopLoading();
        document.getElementById('detail-page-sub').innerText = `Lỗi: ${err.message}`;
    }
}

async function init() {
    try {
        const authRes = await fetch('/api/auth-status');
        const authData = await authRes.json().catch(() => ({}));
        isAdminUser = !!(authData.authenticated && authData.role === 'admin');
    } catch (_) {
        isAdminUser = false;
    }
    await loadAppDetail();
}

init();
