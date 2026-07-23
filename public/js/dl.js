const dlCard = document.getElementById('dl-card');
const dlContent = document.getElementById('dl-content');
const dlError = document.getElementById('dl-error');
const dlErrorText = document.getElementById('dl-error-text');
const dlAppName = document.getElementById('dl-app-name');
const dlQr = document.getElementById('dl-qr');
const dlVersion = document.getElementById('dl-version');
const dlPlatformBadge = document.getElementById('dl-platform-badge');
const dlInstallBtn = document.getElementById('dl-install-btn');
const dlHowto = document.getElementById('dl-howto');
const dlHint = document.getElementById('dl-hint');
const tabIos = document.getElementById('tab-ios');
const tabAndroid = document.getElementById('tab-android');

const builds = { ios: null, android: null };
let activePlatform = null;

function isAndroidUa() {
    return /Android/i.test(navigator.userAgent || '');
}

function isIosUa() {
    return /iPad|iPhone|iPod/i.test(navigator.userAgent || '');
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
    if (storedQr) {
        const img = document.createElement('img');
        img.src = storedQr;
        img.alt = 'QR code';
        dlQr.appendChild(img);
        return;
    }
    if (shareUrl && typeof qrcode === 'function') {
        const qr = qrcode(0, 'M');
        qr.addData(shareUrl);
        qr.make();
        dlQr.innerHTML = qr.createImgTag(6, 8);
        const img = dlQr.querySelector('img');
        if (img) {
            img.alt = 'QR code';
            img.style.width = '220px';
            img.style.height = '220px';
        }
    }
}

function setActiveTab(platform) {
    activePlatform = platform;
    tabIos.classList.toggle('is-active', platform === 'ios');
    tabAndroid.classList.toggle('is-active', platform === 'android');
    tabIos.setAttribute('aria-selected', platform === 'ios' ? 'true' : 'false');
    tabAndroid.setAttribute('aria-selected', platform === 'android' ? 'true' : 'false');
    renderBuild(builds[platform]);
}

function renderBuild(item) {
    if (!item) {
        dlVersion.textContent = 'Chưa có bản cho nền tảng này';
        dlPlatformBadge.textContent = activePlatform || '';
        dlPlatformBadge.className = `build-tag ${activePlatform === 'android' ? 'build-tag-android' : 'build-tag-ios'}`;
        dlInstallBtn.style.display = 'none';
        dlHowto.style.display = 'none';
        dlQr.innerHTML = '';
        dlHint.textContent = '';
        return;
    }

    dlAppName.textContent = item.appName || 'Ứng dụng';
    document.title = `${item.appName || 'Ứng dụng'} — Share IPA`;

    const ver = item.version || '?';
    const bn = item.buildNumber != null ? ` (${item.buildNumber})` : '';
    dlVersion.textContent = `Version ${ver}${bn}`;

    const platform = item.platform || activePlatform || 'ios';
    dlPlatformBadge.textContent = platform;
    dlPlatformBadge.className = `build-tag ${platform === 'android' ? 'build-tag-android' : 'build-tag-ios'}`;

    renderQr(item.shareUrl, item.qr);

    dlInstallBtn.style.display = '';
    dlInstallBtn.href = item.downloadUrl || item.shareUrl || '#';
    dlHowto.style.display = platform === 'ios' ? '' : 'none';

    if (platform === 'android') {
        dlHint.textContent = isAndroidUa()
            ? 'Nhấn Cài đặt để tải file APK.'
            : 'Mở trang này trên thiết bị Android, hoặc quét QR bằng điện thoại.';
    } else {
        dlHint.textContent = isIosUa()
            ? 'Nhấn Cài đặt rồi Trust chứng chỉ trong Cài đặt nếu được hỏi.'
            : 'Mở trang này trên iPhone/iPad, hoặc quét QR bằng Camera.';
    }
}

async function fetchBuild(id) {
    if (!id) return null;
    const res = await fetch(`/api/app-info?id=${encodeURIComponent(id)}`);
    const data = await res.json();
    if (!res.ok || !data.success || !data.item) {
        throw new Error(data.message || `Không tìm thấy bản build "${id}".`);
    }
    return data.item;
}

async function init() {
    const params = new URLSearchParams(window.location.search);
    const iosId = (params.get('ios') || '').trim();
    const androidId = (params.get('android') || '').trim();

    if (!iosId && !androidId) {
        showError('Liên kết không hợp lệ. Thiếu thông tin bản build.');
        dlAppName.textContent = 'Share IPA';
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

        dlAppName.textContent = (builds.ios || builds.android).appName || 'Ứng dụng';

        stopLoading();
        setActiveTab(initial);
    } catch (err) {
        showError(err.message || 'Không tải được thông tin bản build.');
        dlAppName.textContent = 'Share IPA';
    }
}

tabIos.addEventListener('click', () => {
    if (builds.ios) setActiveTab('ios');
});
tabAndroid.addEventListener('click', () => {
    if (builds.android) setActiveTab('android');
});

init();
