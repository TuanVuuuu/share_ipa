const dlCard = document.getElementById('dl-card');
const dlContent = document.getElementById('dl-content');
const dlError = document.getElementById('dl-error');
const dlErrorText = document.getElementById('dl-error-text');
const dlAppName = document.getElementById('dl-app-name');
const dlAppIcon = document.getElementById('dl-app-icon');
const dlBanner = document.getElementById('dl-banner');
const dlBannerImage = document.getElementById('dl-banner-image');
const dlTop = document.getElementById('dl-top');
const dlQr = document.getElementById('dl-qr');
const dlVersion = document.getElementById('dl-version');
const dlPlatformBadge = document.getElementById('dl-platform-badge');
const dlInstallBtn = document.getElementById('dl-install-btn');
const dlHowto = document.getElementById('dl-howto');
const dlHint = document.getElementById('dl-hint');
const dlScanLabel = document.getElementById('dl-scan-label');
const tabIos = document.getElementById('tab-ios');
const tabAndroid = document.getElementById('tab-android');

const builds = { ios: null, android: null };
let activePlatform = null;
let categoryName = '';
let categoryIconUrl = '';

function isAndroidUa() {
    return /Android/i.test(navigator.userAgent || '');
}

function isIosUa() {
    return /iPad|iPhone|iPod/i.test(navigator.userAgent || '');
}

function isNavigableUrl(value) {
    return /^https?:\/\//i.test(String(value || '').trim());
}

function customShareItem(platform, target, storedQr) {
    return {
        platform,
        isCustom: true,
        customTarget: target || '',
        storedQr: storedQr || '',
        shareUrl: '',
        downloadUrl: '',
    };
}

function makeQr(data) {
    if (!data || typeof qrcode !== 'function') return null;
    for (const level of ['H', 'M', 'L']) {
        try {
            const qr = qrcode(0, level);
            qr.addData(data);
            qr.make();
            return qr;
        } catch (_) { /* nội dung dài hơn mức ECC hiện tại */ }
    }
    return null;
}

function resetInstallButton() {
    dlInstallBtn.onclick = null;
    dlInstallBtn.textContent = 'Cài đặt ngay';
}

function setScanLabel(text) {
    if (dlScanLabel) dlScanLabel.textContent = text;
}

function setCategoryTitle(name) {
    categoryName = (name || '').trim();
    const title = categoryName || 'Tải ứng dụng';
    dlAppName.textContent = title;
    document.title = title;
}

function setCategoryIcon(iconUrl, altText) {
    categoryIconUrl = (iconUrl || '').trim();
    if (!categoryIconUrl || !dlAppIcon) {
        if (dlAppIcon) {
            dlAppIcon.hidden = true;
            dlAppIcon.removeAttribute('src');
        }
        return;
    }
    dlAppIcon.src = categoryIconUrl;
    dlAppIcon.alt = altText || categoryName || 'App icon';
    dlAppIcon.hidden = false;
}

function stopLoading() {
    dlCard.classList.remove('is-loading');
}

function showError(message) {
    stopLoading();
    dlContent.style.display = 'none';
    dlError.style.display = '';
    dlErrorText.textContent = message;
}

function renderQr(shareUrl, storedQr) {
    dlQr.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'dl-qr-wrap';

    // Dùng error correction H để vẫn quét được khi có logo giữa QR
    const qr = shareUrl ? makeQr(shareUrl) : null;
    if (qr) {
        wrap.innerHTML = qr.createImgTag(6, 8);
        const img = wrap.querySelector('img');
        if (img) {
            img.alt = 'QR code';
            img.className = 'dl-qr-image';
        }
    } else if (storedQr) {
        const img = document.createElement('img');
        img.src = storedQr;
        img.alt = 'QR code';
        img.className = 'dl-qr-image';
        wrap.appendChild(img);
    } else {
        return;
    }

    if (categoryIconUrl) {
        const logo = document.createElement('div');
        logo.className = 'dl-qr-logo';
        const logoImg = document.createElement('img');
        logoImg.src = categoryIconUrl;
        logoImg.alt = categoryName || 'icon';
        logo.appendChild(logoImg);
        wrap.appendChild(logo);
    }

    dlQr.appendChild(wrap);
}

tabIos.addEventListener('click', () => {
    if (builds.ios) setActiveTab('ios');
});
tabAndroid.addEventListener('click', () => {
    if (builds.android) setActiveTab('android');
});

function setActiveTab(platform) {
    activePlatform = platform;
    tabIos.classList.toggle('is-active', platform === 'ios');
    tabAndroid.classList.toggle('is-active', platform === 'android');
    tabIos.setAttribute('aria-selected', platform === 'ios' ? 'true' : 'false');
    tabAndroid.setAttribute('aria-selected', platform === 'android' ? 'true' : 'false');
    renderBuild(builds[platform]);
}

function currentHostUrl(value) {
    if (!value || typeof value !== 'string') return value;
    if (window.LanTransfer) return window.LanTransfer.rewriteLegacyHost(value);
    return value.replace(/share-ipa\.vunt\.info/g, window.location.host);
}

function renderCustomBuild(item) {
    const platform = item.platform || activePlatform || 'ios';
    setScanLabel('Quét mã QR');
    dlVersion.textContent = 'QR';
    dlPlatformBadge.textContent = platform;
    dlPlatformBadge.className = `build-tag ${platform === 'android' ? 'build-tag-android' : 'build-tag-ios'}`;
    renderQr(item.customTarget, item.storedQr);
    dlHowto.style.display = 'none';
    resetInstallButton();
    dlInstallBtn.style.display = 'none';
    dlHint.textContent = 'Quét mã QR bằng camera của thiết bị.';
}

function redirectUrlForDevice() {
    if (isIosUa() && builds.ios && builds.ios.isCustom && isNavigableUrl(builds.ios.customTarget)) {
        return builds.ios.customTarget;
    }
    if (isAndroidUa() && builds.android && builds.android.isCustom && isNavigableUrl(builds.android.customTarget)) {
        return builds.android.customTarget;
    }
    return '';
}

async function renderBuild(item) {
    if (!item) {
        setScanLabel('Quét để tải');
        dlVersion.textContent = 'Chưa có bản cho nền tảng này';
        dlPlatformBadge.textContent = activePlatform || '';
        dlPlatformBadge.className = `build-tag ${activePlatform === 'android' ? 'build-tag-android' : 'build-tag-ios'}`;
        resetInstallButton();
        dlInstallBtn.style.display = 'none';
        dlHowto.style.display = 'none';
        dlQr.innerHTML = '';
        dlHint.textContent = '';
        return;
    }

    if (item.isCustom) {
        renderCustomBuild(item);
        return;
    }

    setScanLabel('Quét để tải');
    resetInstallButton();

    if (categoryName) setCategoryTitle(categoryName);

    const ver = item.version || '?';
    const bn = item.buildNumber != null && item.buildNumber !== '' ? ` (${item.buildNumber})` : '';
    dlVersion.textContent = `Version ${ver}${bn}`;

    const platform = item.platform || activePlatform || 'ios';
    dlPlatformBadge.textContent = platform;
    dlPlatformBadge.className = `build-tag ${platform === 'android' ? 'build-tag-android' : 'build-tag-ios'}`;

    const shareUrl = currentHostUrl(item.shareUrl);
    let downloadUrl = currentHostUrl(item.downloadUrl);
    let viaLan = false;
    if (window.LanTransfer) {
        downloadUrl = await window.LanTransfer.preferDownloadUrl(item);
        const lanBase = await window.LanTransfer.getLanBase();
        viaLan = !!(lanBase && item.localFileAvailable && downloadUrl && downloadUrl !== item.downloadUrl);
    }

    renderQr(shareUrl, item.qr);

    dlInstallBtn.style.display = '';
    dlInstallBtn.href = downloadUrl || shareUrl || '#';
    dlHowto.style.display = platform === 'ios' ? '' : 'none';

    if (platform === 'android') {
        dlHint.textContent = viaLan
            ? 'Đang dùng mạng nội bộ — tải nhanh hơn.'
            : (isAndroidUa()
                ? 'Nhấn Cài đặt để tải file APK.'
                : 'Mở trang này trên thiết bị Android, hoặc quét QR bằng điện thoại.');
    } else {
        dlHint.textContent = viaLan
            ? 'Đang dùng mạng nội bộ — tải nhanh hơn.'
            : (isIosUa()
                ? 'Nhấn Cài đặt rồi Trust chứng chỉ trong Cài đặt nếu được hỏi.'
                : 'Mở trang này trên iPhone/iPad, hoặc quét QR bằng Camera.');
    }
}

function showVpnGate(needLogin) {
    stopLoading();
    dlContent.style.display = 'none';
    dlError.style.display = 'none';
    tabIos.style.display = 'none';
    tabAndroid.style.display = 'none';
    const top = document.getElementById('dl-top');
    if (top) top.style.display = 'none';
    setCategoryTitle('');
    setCategoryIcon('');
    const gate = document.getElementById('vpn-gate-root');
    if (gate && window.VpnGate) window.VpnGate.mount(gate);
}

async function fetchBuild(id) {
    if (!id) return null;
    try {
        const res = await fetch(`/api/app-info?id=${encodeURIComponent(id)}`);
        const data = await res.json();
        if (data.vpnRequired) {
            const err = new Error(data.message || 'Không có quyền truy cập');
            err.vpnRequired = true;
            err.needLogin = data.needLogin !== false;
            err.vpn = data.vpn;
            throw err;
        }
        if (!res.ok || !data.success || !data.item) return null;
        return data.item;
    } catch (err) {
        if (err && err.vpnRequired) throw err;
        return null;
    }
}

async function init() {
    const params = new URLSearchParams(window.location.search);
    const shareId = (params.get('s') || '').trim();
    let iosId = (params.get('ios') || '').trim();
    let androidId = (params.get('android') || '').trim();
    let productTitle = '';
    let productBanner = '';
    let productIcon = '';
    let shareMeta = null;
    let iosCustom = '';
    let androidCustom = '';
    let iosQr = '';
    let androidQr = '';

    if (shareId) {
        try {
            const res = await fetch(`/api/download-shares/${encodeURIComponent(shareId)}`);
            const data = await res.json();
            if (data.vpnRequired) {
                showVpnGate(data.needLogin);
                return;
            }
            if (!res.ok || !data.success || !data.item) {
                throw new Error(data.message || 'Không tìm thấy link chia sẻ.');
            }
            shareMeta = data.item;
            iosId = data.item.iosBuildId || '';
            androidId = data.item.androidBuildId || '';
            iosCustom = data.item.iosCustomTarget || '';
            androidCustom = data.item.androidCustomTarget || '';
            iosQr = data.item.iosQr || '';
            androidQr = data.item.androidQr || '';
            if (!iosCustom && (data.item.iosCustom || iosQr)) iosCustom = 'qr';
            if (!androidCustom && (data.item.androidCustom || androidQr)) androidCustom = 'qr';
            productTitle = data.item.productName || '';
            productBanner = currentHostUrl(data.item.productBanner || '');
            productIcon = currentHostUrl(data.item.productIcon || '');
            setCategoryTitle(productTitle);
            setCategoryIcon(productIcon, productTitle);
        } catch (err) {
            showError(err.message || 'Không tải được link chia sẻ.');
            setCategoryTitle('');
            setCategoryIcon('');
            tabIos.style.display = 'none';
            tabAndroid.style.display = 'none';
            return;
        }
    }

    if (!iosId && !androidId && !iosCustom && !androidCustom) {
        showError('Liên kết không hợp lệ. Thiếu thông tin bản build.');
        setCategoryTitle('');
        setCategoryIcon('');
        tabIos.style.display = 'none';
        tabAndroid.style.display = 'none';
        return;
    }

    try {
        const [iosRes, androidRes] = await Promise.all([
            iosId ? fetchBuild(iosId) : Promise.resolve(null),
            androidId ? fetchBuild(androidId) : Promise.resolve(null),
        ]);

        builds.ios = null;
        builds.android = null;
        for (const item of [iosRes, androidRes]) {
            if (!item) continue;
            if ((item.platform || 'ios') === 'android') builds.android = item;
            else builds.ios = item;
        }

        if (iosCustom) builds.ios = customShareItem('ios', iosCustom === 'qr' ? '' : iosCustom, iosQr);
        if (androidCustom) builds.android = customShareItem('android', androidCustom === 'qr' ? '' : androidCustom, androidQr);

        if (shareMeta) {
            if (builds.ios && !builds.ios.isCustom) {
                if (!builds.ios.version && shareMeta.iosVersion) builds.ios.version = shareMeta.iosVersion;
                if (builds.ios.buildNumber == null && shareMeta.iosBuildNumber) {
                    builds.ios.buildNumber = shareMeta.iosBuildNumber;
                }
            }
            if (builds.android && !builds.android.isCustom) {
                if (!builds.android.version && shareMeta.androidVersion) builds.android.version = shareMeta.androidVersion;
                if (builds.android.buildNumber == null && shareMeta.androidBuildNumber) {
                    builds.android.buildNumber = shareMeta.androidBuildNumber;
                }
            }
        }

        const redirectUrl = redirectUrlForDevice();
        if (redirectUrl) {
            window.location.replace(redirectUrl);
            return;
        }

        if (!builds.ios && !builds.android) {
            showError('Không tìm thấy bản build tương ứng.');
            return;
        }

        tabIos.style.display = builds.ios ? '' : 'none';
        tabAndroid.style.display = builds.android ? '' : 'none';

        let initial = builds.ios ? 'ios' : 'android';
        if (builds.ios && builds.android) {
            if (isAndroidUa()) initial = 'android';
            else if (isIosUa()) initial = 'ios';
        } else if (builds.android) {
            initial = 'android';
        }

        setCategoryTitle(productTitle);
        setCategoryIcon(productIcon, productTitle);
        if (productBanner) {
            dlBannerImage.src = productBanner;
            dlBannerImage.alt = productTitle || 'Banner';
            dlBanner.hidden = false;
            if (dlTop) dlTop.classList.add('has-banner');
        } else {
            dlBanner.hidden = true;
            dlBannerImage.removeAttribute('src');
            if (dlTop) dlTop.classList.remove('has-banner');
        }

        stopLoading();
        setActiveTab(initial);
    } catch (err) {
        if (err && err.vpnRequired) {
            showVpnGate(err.needLogin);
            return;
        }
        showError(err.message || 'Không tải được thông tin bản build.');
        setCategoryTitle(productTitle);
        setCategoryIcon(productIcon, productTitle);
    }
}

init();
