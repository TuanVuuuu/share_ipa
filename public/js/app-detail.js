let isAdminUser = false;
let sessionVpn = null;
let sessionVpnAccess = false;

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
    detailVpnToggle: document.getElementById('detail-vpn-toggle'),
    detailVpnCheckbox: document.getElementById('detail-vpn-checkbox'),
    detailVpnBadge: document.getElementById('detail-vpn-badge'),
    detailVpnGate: document.getElementById('detail-vpn-gate'),
    canDeleteBuild: () => isAdminUser,
    canManageApp: () => isAdminUser,
    onDeleteBuild: handleDeleteBuild,
    onToggleVisibility: handleToggleVisibility,
    onDeleteAll: handleDeleteAll,
    onToggleVpn: handleToggleVpn,
    qrModal: document.getElementById('qr-modal'),
    qrModalClose: document.getElementById('qr-modal-close'),
    qrModalTitle: document.getElementById('qr-modal-title'),
    qrModalVersion: document.getElementById('qr-modal-version'),
    qrModalImage: document.getElementById('qr-modal-image'),
    qrModalUrl: document.getElementById('qr-modal-url'),
    qrModalCopy: document.getElementById('qr-modal-copy'),
    qrModalInstall: document.getElementById('qr-modal-install'),
    qrModalVpn: document.getElementById('qr-modal-vpn'),
    qrModalScanHint: document.getElementById('qr-modal-scan-hint')
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

function currentGroupFromBuilds(builds, extra) {
    const flags = extra || {};
    return {
        latest: builds[0],
        builds,
        hidden: !!flags.hidden,
        vpnRequired: !!flags.vpnRequired,
        vpnAccess: !!flags.vpnAccess,
        vpn: flags.vpn || null,
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
        detailView.renderAppDetail(currentGroupFromBuilds(builds, {
            hidden: nextHidden,
            vpnRequired: group.vpnRequired,
            vpnAccess: group.vpnAccess,
            vpn: group.vpn,
        }));
    } catch (err) {
        alert(err.message);
        detailView.setAdminBusy(false);
    }
}

async function handleToggleVpn(group, vpnRequired) {
    if (!isAdminUser || !group || !group.latest) return;
    const bundleId = group.latest.bundleId;
    const platform = group.latest.platform || 'ios';
    detailView.setAdminBusy(true);
    try {
        const res = await fetch('/api/catalog/vpn-required', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ bundleId, platform, vpnRequired })
        });
        const data = await res.json().catch(() => null);
        if (!res.ok || !data || !data.success) {
            throw new Error((data && data.message) || 'Cập nhật VPN thất bại.');
        }
        const builds = (group.builds || []).map((item) => ({ ...item, vpnRequired }));
        detailView.renderAppDetail(currentGroupFromBuilds(builds, {
            hidden: group.hidden,
            vpnRequired,
            vpnAccess: group.vpnAccess,
            vpn: group.vpn,
        }));
    } catch (err) {
        alert(err.message);
        const box = document.getElementById('detail-vpn-checkbox');
        if (box) box.checked = !!group.vpnRequired;
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
        if (data.vpnRequired && !res.ok && detailView.showVpnGate) {
            detailView.showVpnGate(data.vpn, data.message);
            return;
        }
        if (!res.ok || !data.success) {
            detailView.showEmpty(data.message || 'Không tải được danh sách build.');
            return;
        }

        const builds = Array.isArray(data.builds) ? data.builds : [];
        if (!builds.length) {
            detailView.showEmpty(`Không có bản build ${platform === 'android' ? 'Android' : 'iOS'} nào cho "${bundleId}".`);
            return;
        }

        detailView.renderAppDetail(currentGroupFromBuilds(builds, {
            hidden: data.hidden,
            vpnRequired: data.vpnRequired,
            vpnAccess: data.vpnAccess != null ? !!data.vpnAccess : sessionVpnAccess,
            vpn: data.vpn || sessionVpn,
        }));
    } catch (err) {
        detailView.stopLoading();
        document.getElementById('detail-page-sub').innerText = `Lỗi: ${err.message}`;
    }
}

async function init() {
    if (window.VpnGate && window.VpnGate.ready) {
        await window.VpnGate.ready;
    }
    try {
        const authRes = await fetch('/api/auth-status');
        const authData = await authRes.json().catch(() => ({}));
        isAdminUser = !!(authData.authenticated && authData.role === 'admin');
        sessionVpn = authData.vpn || null;
        sessionVpnAccess = !!authData.vpnAccess;
    } catch (_) {
        isAdminUser = false;
    }
    await loadAppDetail();
}

init();
