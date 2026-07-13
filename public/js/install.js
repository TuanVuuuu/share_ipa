const installZone = document.getElementById('install-zone');
const installIcon = document.getElementById('install-icon');
const installName = document.getElementById('install-name');
const installBundle = document.getElementById('install-bundle');
const installVersion = document.getElementById('install-version');
const installExtra = document.getElementById('install-extra');
const installBtn = document.getElementById('install-btn');
const installHint = document.getElementById('install-hint');
const installBack = document.getElementById('install-back');

function formatDateTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleString('vi-VN');
}

function maskUdid(udid) {
    if (!udid || udid.length <= 12) return udid;
    const hasNewFormat = /^[0-9a-f]+-/i.test(udid);
    if (hasNewFormat) {
        const dashIdx = udid.indexOf('-');
        const prefix = udid.slice(0, dashIdx + 1);
        const rest = udid.slice(dashIdx + 1);
        return prefix + rest.slice(0, 4) + '••••••••' + rest.slice(-4);
    }
    return udid.slice(0, 6) + '••••••••••••••••••••••••••••' + udid.slice(-6);
}

function stopLoading() {
    installZone.classList.remove('is-loading');
}

function isAndroidUa() {
    return /Android/i.test(navigator.userAgent || '');
}

function isIosUa() {
    return /iPad|iPhone|iPod/i.test(navigator.userAgent || '');
}

async function init() {
    const params = new URLSearchParams(window.location.search);
    // Hỗ trợ cả link iOS cũ (?plist=...) và Android (?id=...)
    const buildId = params.get('plist') || params.get('id') || '';

    installBack.href = '/';
    installVersion.style.display = 'none';

    if (!buildId) {
        stopLoading();
        installName.innerText = 'Thiếu thông tin bản build';
        installBundle.innerText = 'Liên kết cài đặt không hợp lệ.';
        installBtn.style.display = 'none';
        installHint.innerText = '';
        return;
    }

    // Fallback iOS: dựng sẵn link itms-services từ plist nếu metadata chưa tải được
    // Fallback Android: link tải thẳng APK từ /uploads
    const looksLikePlist = buildId.toLowerCase().endsWith('.plist');
    const looksLikeApk = buildId.toLowerCase().endsWith('.apk');
    if (looksLikePlist) {
        const manifestUrl = `${window.location.origin}/uploads/${buildId}`;
        installBtn.href = `itms-services://?action=download-manifest&url=${encodeURIComponent(manifestUrl)}`;
    } else if (looksLikeApk) {
        installBtn.href = `${window.location.origin}/uploads/${buildId}`;
    } else {
        installBtn.href = '#';
    }

    let platform = looksLikeApk ? 'android' : (looksLikePlist ? 'ios' : null);

    try {
        const res = await fetch(`/api/app-info?${looksLikePlist ? 'plist' : 'id'}=${encodeURIComponent(buildId)}`);
        const data = await res.json();

        if (res.ok && data.success && data.item) {
            const it = data.item;
            platform = it.platform || platform || 'ios';
            const defaultName = platform === 'android' ? 'Ứng dụng Android' : 'Ứng dụng iOS';

            installName.innerText = it.appName || defaultName;
            installBundle.innerText = it.bundleId || '';
            installVersion.innerText = `Phiên bản ${it.version} • Build ${it.buildNumber}`;
            installVersion.style.display = 'inline-block';
            if (it.icon) installIcon.src = it.icon;
            if (it.downloadUrl) installBtn.href = it.downloadUrl;

            const parts = [];
            if (it.fileSize) parts.push(`📦 ${it.fileSize}`);
            if (it.uploadedAt) parts.push(`🕒 ${formatDateTime(it.uploadedAt)}`);
            installExtra.innerText = parts.join('  •  ');

            const tags = [];
            if (platform === 'android') {
                tags.push('<span class="build-tag build-tag-android">Android</span>');
                if (it.minimumOsVersion) {
                    tags.push(`<span class="build-tag build-tag-android">API ${it.minimumOsVersion}+</span>`);
                }
            } else {
                tags.push('<span class="build-tag build-tag-ios">iOS</span>');
                if (it.minimumOsVersion) {
                    tags.push(`<span class="build-tag build-tag-ios">iOS ${it.minimumOsVersion}+</span>`);
                }
                if (it.profileType) {
                    tags.push(`<span class="build-tag build-tag-profile">${it.profileType}</span>`);
                }
                if (it.provisionedDevicesCount != null) {
                    tags.push(`<span class="build-tag build-tag-devices">${it.provisionedDevicesCount} thiết bị</span>`);
                }
            }

            if (tags.length) {
                const tagsEl = document.createElement('div');
                tagsEl.className = 'build-tags install-tags';
                tagsEl.innerHTML = tags.join('');
                installExtra.insertAdjacentElement('afterend', tagsEl);

                const devices = Array.isArray(it.provisionedDevices) ? it.provisionedDevices : [];
                if (platform === 'ios' && devices.length) {
                    const rows = devices.map((udid, i) =>
                        `<div class="device-udid-row"><span class="device-index">${i + 1}.</span><code class="device-udid" title="${udid}">${maskUdid(udid)}</code></div>`
                    ).join('');
                    const detailsEl = document.createElement('details');
                    detailsEl.className = 'devices-details install-devices';
                    detailsEl.innerHTML = `
                        <summary class="devices-summary">
                            <svg class="devices-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>
                            Xem ${devices.length} thiết bị đã được thêm
                        </summary>
                        <div class="devices-list">${rows}</div>`;
                    tagsEl.insertAdjacentElement('afterend', detailsEl);
                }
            }
        } else {
            installName.innerText = 'Không tìm thấy thông tin bản build';
            installBundle.innerText = data.message || 'Bản build có thể đã bị xoá khỏi danh mục.';
            installVersion.style.display = 'none';
        }
    } catch (err) {
        installName.innerText = 'Cài đặt ứng dụng';
        installVersion.style.display = 'none';
    } finally {
        stopLoading();
    }

    if (platform === 'android') {
        installBtn.innerText = 'Tải & cài đặt APK';
        installHint.innerText = 'Mở trang này bằng Android. Nếu bị chặn, bật “Cài đặt từ nguồn không xác định” cho trình duyệt rồi mở lại file APK đã tải.';
        if (isAndroidUa() && installBtn.href && installBtn.href !== '#') {
            setTimeout(() => {
                try { window.location.href = installBtn.href; } catch (_) { /* ignore */ }
            }, 1200);
        }
    } else {
        installHint.innerText = 'Nếu iPhone/iPad không tự chuyển qua màn hình cài đặt, hãy bấm "Cài đặt ngay".';
        if (isIosUa()) {
            setTimeout(() => {
                try { window.location.href = installBtn.href; } catch (_) { /* ignore */ }
            }, 1200);
        }
    }
}

init();
