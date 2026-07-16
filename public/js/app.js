// Tương thích QR cũ: link dạng /?plist=... được chuyển sang trang cài đặt riêng /install
(function redirectLegacyPlist() {
    const params = new URLSearchParams(window.location.search);
    if (params.get('plist')) {
        window.location.replace('/install' + window.location.search);
    }
})();

const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const progressArea = document.getElementById('progress-area');
const progressFill = document.getElementById('progress-bar-fill');
const progressPercent = document.getElementById('progress-percent');
const statusLabel = document.getElementById('status-label');
const progressStartTime = document.getElementById('progress-start-time');
const progressEndTime = document.getElementById('progress-end-time');
const progressDuration = document.getElementById('progress-duration');
const progressSpeed = document.getElementById('progress-speed');
const progressEta = document.getElementById('progress-eta');
const progressActivity = document.getElementById('progress-activity');
const progressActivityText = document.getElementById('progress-activity-text');
const resultZone = document.getElementById('result-zone');
const logsContainer = document.getElementById('terminal-logs');
const shareUrlInput = document.getElementById('share-url');
const copyLinkButton = document.getElementById('copy-link-btn');
const downloadQrButton = document.getElementById('download-qr-btn');
let progressTimer = null;
let qrDownloadDataUrl = '';
let isProcessing = false;

// Cập nhật dòng "đang làm gì" ngay dưới thanh tiến trình để trấn an người dùng
function setActivity(message, state = 'active') {
    if (!progressActivity || !progressActivityText) return;
    progressActivity.classList.remove('done', 'error');
    if (state === 'done') progressActivity.classList.add('done');
    else if (state === 'error') progressActivity.classList.add('error');
    progressActivityText.innerText = message;
}

const authBox = document.getElementById('auth-box');
const authStatus = document.getElementById('auth-status');
const authForm = document.getElementById('auth-form');
const authError = document.getElementById('auth-error');
const authSubmit = document.getElementById('auth-submit');
const logoutBtn = document.getElementById('logout-btn');
const authUsernameLabel = document.getElementById('auth-username-label');
const authRoleBadge = document.getElementById('auth-role-badge');

const catalogContainer = document.getElementById('catalog-container');
const catalogList = document.getElementById('catalog-list');
const catalogEmpty = document.getElementById('catalog-empty');
const catalogSub = document.getElementById('catalog-sub');
const catalogRefreshBtn = document.getElementById('catalog-refresh-btn');

const protectedAreas = [dropZone, progressArea, resultZone];

let isAuthenticated = false;
let currentUser = null; // { username, role, permissions }
let logsSource = null;

function canDeleteBuild() {
    return !!(currentUser && currentUser.permissions && currentUser.permissions.includes('delete_build'));
}

// Kết nối nhận log real-time từ máy Mac (chỉ khi đã đăng nhập)
let logsReconnectTimer = null;

function connectLogs() {
    if (logsSource) return;
    logsSource = new EventSource('/api/logs');

    logsSource.onmessage = function(event) {
        let data;
        try { data = JSON.parse(event.data); } catch (e) { return; }
        appendLog(data.time, data.message, data.type);
        // Khi đang xử lý, phản chiếu hoạt động thật của máy chủ lên dòng ngay dưới thanh tiến trình
        if (isProcessing && data.type !== 'error') {
            setActivity(data.message, 'active');
        }
    };

    logsSource.onerror = function() {
        // Đóng kết nối lỗi hiện tại rồi tự kết nối lại (nếu vẫn đăng nhập)
        if (logsSource) {
            logsSource.close();
            logsSource = null;
        }
        clearTimeout(logsReconnectTimer);
        if (isAuthenticated) {
            logsReconnectTimer = setTimeout(connectLogs, 3000);
        }
    };
}

function applyAuthState(authenticated) {
    isAuthenticated = authenticated;
    if (!authenticated) currentUser = null;
    authBox.style.display = authenticated ? 'none' : 'block';
    authStatus.style.display = authenticated ? 'flex' : 'none';
    if (authenticated && currentUser) {
        authUsernameLabel.innerText = currentUser.username;
        authRoleBadge.innerText = currentUser.role;
    }
    protectedAreas.forEach(el => el.classList.toggle('locked', !authenticated));

    catalogContainer.style.display = authenticated ? '' : 'none';
    logsContainer.style.display = authenticated ? '' : 'none';

    if (authenticated) {
        connectLogs();
        loadCatalog();
    } else {
        setCatalogLoading(false);
        clearTimeout(logsReconnectTimer);
        if (logsSource) {
            logsSource.close();
            logsSource = null;
        }
    }
}

const FALLBACK_ICON = 'https://cdn-icons-png.flaticon.com/512/5115/5115293.png';

function escapeHtml(text) {
    return String(text == null ? '' : text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function formatDateTime(iso) {
    if (!iso) return '--';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleString('vi-VN');
}

let catalogItems = [];

function getBuildsForBundle(bundleId, platform) {
    return catalogItems
        .filter(item => (item.bundleId || item.id) === bundleId)
        .filter(item => !platform || (item.platform || 'ios') === platform)
        .sort((a, b) => (new Date(b.uploadedAt).getTime() || 0) - (new Date(a.uploadedAt).getTime() || 0));
}

// SPA: giữ trang chủ sống — mở chi tiết app bằng pushState thay vì tải lại trang
const homeView = document.getElementById('home-view');
const appDetailView = document.getElementById('app-detail-view');
let detailViewCtrl = null;
let homeScrollY = 0;
const HOME_TITLE = 'Share IPA';

if (homeView && appDetailView && window.CatalogDetail) {
    detailViewCtrl = CatalogDetail.createDetailView({
        appDetailZone: document.getElementById('app-detail-zone'),
        detailPageSub: document.getElementById('detail-page-sub'),
        detailHeader: document.getElementById('detail-header'),
        detailIcon: document.getElementById('detail-icon'),
        detailName: document.getElementById('detail-name'),
        detailBundle: document.getElementById('detail-bundle'),
        detailBuilds: document.getElementById('detail-builds'),
        detailEmpty: document.getElementById('detail-empty'),
        detailAuth: document.getElementById('detail-auth'),
        detailShareBtn: document.getElementById('detail-share-btn'),
        canDeleteBuild: canDeleteBuild,
        onDeleteBuild: handleDeleteBuild,
        qrModal: document.getElementById('qr-modal'),
        qrModalClose: document.getElementById('qr-modal-close'),
        qrModalTitle: document.getElementById('qr-modal-title'),
        qrModalVersion: document.getElementById('qr-modal-version'),
        qrModalImage: document.getElementById('qr-modal-image'),
        qrModalUrl: document.getElementById('qr-modal-url'),
        qrModalCopy: document.getElementById('qr-modal-copy'),
        qrModalInstall: document.getElementById('qr-modal-install')
    });

    document.getElementById('detail-back').addEventListener('click', () => history.back());
    window.addEventListener('popstate', syncRouteFromUrl);
}

function showAppDetailPanel(group) {
    if (!detailViewCtrl) return;
    homeScrollY = window.scrollY;
    homeView.classList.add('spa-view-hidden');
    appDetailView.classList.remove('spa-view-hidden');
    detailViewCtrl.renderAppDetail(group);
    window.scrollTo(0, 0);
}

function hideAppDetailPanel() {
    if (!homeView || !appDetailView) return;
    appDetailView.classList.add('spa-view-hidden');
    homeView.classList.remove('spa-view-hidden');
    document.title = HOME_TITLE;
    window.scrollTo(0, homeScrollY);
}

function parseAppDetailRoute() {
    const match = window.location.pathname.match(/^\/(ios|android)\/app\/?$/);
    if (!match) return null;
    const params = new URLSearchParams(window.location.search);
    const bundleId = (params.get('bundle') || '').trim();
    if (!bundleId) return null;
    return { platform: match[1], bundleId };
}

function buildAppDetailPath(platform, bundleId) {
    const p = platform === 'android' ? 'android' : 'ios';
    return `/${p}/app?bundle=${encodeURIComponent(bundleId)}`;
}

function syncRouteFromUrl() {
    const route = parseAppDetailRoute();
    // Tương thích cũ: /app?bundle=...&platform=...
    if (!route && window.location.pathname === '/app') {
        const params = new URLSearchParams(window.location.search);
        const bundleId = (params.get('bundle') || '').trim();
        if (bundleId) {
            const platform = params.get('platform') === 'android' ? 'android' : 'ios';
            history.replaceState({ view: 'app-detail', bundleId, platform }, '', buildAppDetailPath(platform, bundleId));
            const builds = getBuildsForBundle(bundleId, platform);
            if (builds.length) {
                showAppDetailPanel({ latest: builds[0], builds });
                return;
            }
        }
    }
    if (route) {
        const builds = getBuildsForBundle(route.bundleId, route.platform);
        if (builds.length) {
            showAppDetailPanel({ latest: builds[0], builds });
            return;
        }
    }
    hideAppDetailPanel();
}

// Xóa 1 bản build (chỉ khả dụng với tài khoản có quyền 'delete_build') rồi làm mới danh mục + view hiện tại.
// Cập nhật thẳng vào catalogItems đang có trong bộ nhớ (không chờ fetch lại /api/catalog) để tránh
// hiển thị dữ liệu cũ nếu API GitHub trả về chậm/chưa kịp đồng bộ ngay sau khi ghi.
async function handleDeleteBuild(build) {
    if (!canDeleteBuild()) return;
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

        // Xóa ngay khỏi danh sách trong bộ nhớ rồi vẽ lại giao diện — không phụ thuộc round-trip mạng
        catalogItems = catalogItems.filter(item => item.id !== build.id);
        renderCatalog(true);

        const route = parseAppDetailRoute();
        if (route) {
            const builds = getBuildsForBundle(route.bundleId, route.platform);
            if (builds.length) {
                detailViewCtrl.renderAppDetail({ latest: builds[0], builds });
            } else {
                // Không còn bản build nào của app này — quay về trang chủ (điều hướng SPA, không tải lại trang).
                // Dùng replaceState (thay vì back()) để tránh phụ thuộc lịch sử trình duyệt và không bị tải lại trang.
                history.replaceState({ view: 'home' }, '', '/');
                hideAppDetailPanel();
            }
        }
    } catch (err) {
        alert(err.message);
    }
}

function navigateToAppDetail(bundleId, platform) {
    const builds = getBuildsForBundle(bundleId, platform);
    if (!builds.length) return;
    const p = platform === 'android' ? 'android' : 'ios';
    history.pushState(
        { view: 'app-detail', bundleId, platform: p },
        '',
        buildAppDetailPath(p, bundleId)
    );
    showAppDetailPanel({ latest: builds[0], builds });
}

function setCatalogLoading(loading) {
    catalogContainer.classList.toggle('is-loading', loading);
    if (loading) catalogEmpty.style.display = 'none';
}

async function loadCatalog() {
    if (!isAuthenticated) return;
    setCatalogLoading(true);
    try {
        const res = await fetch('/api/catalog');
        if (!res.ok) throw new Error('Không tải được danh mục.');
        const data = await res.json();
        catalogItems = Array.isArray(data.items) ? data.items : [];
        if (!data.configured) {
            catalogSub.innerText = '⚠️ Chưa cấu hình GITHUB_TOKEN/GITHUB_REPO trong .env nên danh mục trống.';
        }
        renderCatalog(data.configured);
    } catch (err) {
        setCatalogLoading(false);
        catalogSub.innerText = `Lỗi tải danh mục: ${err.message}`;
        catalogList.innerHTML = '';
        catalogEmpty.style.display = 'none';
    }
}

// Gom nhóm theo platform + bundleId: mỗi nhóm là 1 "thư mục app" kèm toàn bộ bản build
function groupByBundle(items) {
    const map = new Map();
    items.forEach(item => {
        const platform = item.platform || 'ios';
        const key = `${platform}:${item.bundleId || item.id}`;
        if (!map.has(key)) map.set(key, { key, platform, builds: [] });
        map.get(key).builds.push(item);
    });

    const groups = Array.from(map.values());
    groups.forEach(g => {
        g.builds.sort((a, b) => (new Date(b.uploadedAt).getTime() || 0) - (new Date(a.uploadedAt).getTime() || 0));
        g.latest = g.builds[0];
        g.count = g.builds.length;
    });
    return groups.sort((x, y) => (new Date(y.latest.uploadedAt).getTime() || 0) - (new Date(x.latest.uploadedAt).getTime() || 0));
}

function createAppCard(group) {
    const { latest, count, platform } = group;
    const platformLabel = platform === 'android' ? 'Android' : 'iOS';
    const platformClass = platform === 'android' ? 'build-tag-android' : 'build-tag-ios';
    const card = document.createElement('div');
    card.className = 'app-card folder-card';
    card.innerHTML = `
        <div class="app-card-top">
            <img src="${escapeHtml(latest.icon || FALLBACK_ICON)}" alt="icon" onerror="this.src='${FALLBACK_ICON}'">
            <div class="app-card-info">
                <h4>${escapeHtml(latest.appName)}</h4>
                <p class="app-card-bundle">${escapeHtml(latest.bundleId)}</p>
            </div>
        </div>
        <div class="app-card-meta">
            <span class="build-tag ${platformClass}">${platformLabel}</span>
            <span class="badge">📁 ${count} bản build</span>
            <span>🆕 v${escapeHtml(latest.version)} (Build ${escapeHtml(latest.buildNumber)})</span>
            <span>🕒 ${escapeHtml(formatDateTime(latest.uploadedAt))}</span>
        </div>
        <div class="app-card-actions">
            <button type="button" class="btn view-all-btn">Xem tất cả</button>
        </div>
    `;
    card.addEventListener('click', () => navigateToAppDetail(latest.bundleId, platform));
    return card;
}

function appendCatalogSection(container, title, platform, groups) {
    if (!groups.length) return;
    const section = document.createElement('section');
    section.className = `catalog-section catalog-section-${platform}`;
    section.innerHTML = `
        <div class="catalog-section-head">
            <h3 class="catalog-section-title">
                <span class="build-tag ${platform === 'android' ? 'build-tag-android' : 'build-tag-ios'}">${title}</span>
                <span class="catalog-section-count">${groups.length} ứng dụng</span>
            </h3>
        </div>
    `;
    const grid = document.createElement('div');
    grid.className = 'catalog-grid';
    groups.forEach((group) => grid.appendChild(createAppCard(group)));
    section.appendChild(grid);
    container.appendChild(section);
}

function renderCatalog(configured) {
    setCatalogLoading(false);
    const groups = groupByBundle(catalogItems);
    const iosGroups = groups.filter((g) => g.platform !== 'android');
    const androidGroups = groups.filter((g) => g.platform === 'android');
    catalogList.innerHTML = '';

    if (configured !== false) {
        const parts = [];
        if (iosGroups.length) parts.push(`${iosGroups.length} iOS`);
        if (androidGroups.length) parts.push(`${androidGroups.length} Android`);
        catalogSub.innerText = parts.length
            ? `Có ${parts.join(' · ')} trong danh mục.`
            : 'Danh sách các ứng dụng đã xử lý và lưu trữ.';
    }

    if (!groups.length) {
        catalogEmpty.style.display = 'block';
        return;
    }
    catalogEmpty.style.display = 'none';

    appendCatalogSection(catalogList, 'iOS', 'ios', iosGroups);
    appendCatalogSection(catalogList, 'Android', 'android', androidGroups);
}

catalogRefreshBtn.addEventListener('click', loadCatalog);

async function checkAuthStatus() {
    try {
        const res = await fetch('/api/auth-status');
        const data = await res.json();
        currentUser = data.authenticated
            ? { username: data.username, role: data.role, permissions: data.permissions || [] }
            : null;
        applyAuthState(!!data.authenticated);
    } catch (err) {
        currentUser = null;
        applyAuthState(false);
    }
}

authForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    authError.textContent = '';
    authSubmit.disabled = true;
    const original = authSubmit.innerText;
    authSubmit.innerText = 'Đang đăng nhập...';

    try {
        const res = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username: document.getElementById('auth-username').value,
                password: document.getElementById('auth-password').value
            })
        });
        const data = await res.json();
        if (!res.ok || !data.success) {
            throw new Error(data.message || 'Đăng nhập thất bại.');
        }
        authForm.reset();
        currentUser = { username: data.username, role: data.role, permissions: data.permissions || [] };
        applyAuthState(true);
    } catch (err) {
        authError.textContent = err.message;
    } finally {
        authSubmit.disabled = false;
        authSubmit.innerText = original;
    }
});

logoutBtn.addEventListener('click', async () => {
    try {
        await fetch('/api/logout', { method: 'POST' });
    } catch (err) { /* ignore */ }
    applyAuthState(false);
});

checkAuthStatus();

function appendLog(time, message, type) {
    const div = document.createElement('div');
    div.className = `log-line log-${type}`;
    div.innerText = `[${time}] ${message}`;
    logsContainer.appendChild(div);
    logsContainer.scrollTop = logsContainer.scrollHeight;
}

dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('dragover'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    if (e.dataTransfer.files.length > 0) handleFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener('change', (e) => { if (e.target.files.length > 0) handleFile(e.target.files[0]); });

function handleFile(file) {
    if (!isAuthenticated) {
        alert('Vui lòng đăng nhập trước khi tải lên tệp tin.');
        return;
    }
    if (!file.name.endsWith('.ipa') && !file.name.endsWith('.apk')) {
        alert('Vui lòng chỉ chọn tệp tin định dạng .ipa hoặc .apk');
        return;
    }
    uploadSecure(file);
}

function updateProgress(percent, message, state = 'active') {
    const safePercent = Math.min(Math.max(percent, 0), 100);
    progressFill.style.width = `${safePercent}%`;
    if (state === 'complete') progressFill.style.background = 'var(--success)';
    else if (state === 'error') progressFill.style.background = 'var(--danger)';
    else progressFill.style.background = 'var(--primary)';
    progressPercent.innerText = `${Math.round(safePercent)}%`;
    statusLabel.innerText = message;
}

function formatBytesClient(bytes) {
    if (!bytes || bytes <= 0) return '0 MB';
    const mb = bytes / (1024 * 1024);
    if (mb >= 1) return `${mb.toFixed(1)} MB`;
    return `${(bytes / 1024).toFixed(0)} KB`;
}

// Định dạng tốc độ mạng: byte/giây -> MB/s hoặc KB/s
function formatSpeed(bytesPerSecond) {
    if (!bytesPerSecond || bytesPerSecond <= 0) return '--';
    const mbps = bytesPerSecond / (1024 * 1024);
    if (mbps >= 1) return `${mbps.toFixed(2)} MB/s`;
    return `${(bytesPerSecond / 1024).toFixed(0)} KB/s`;
}

// Định dạng thời gian còn lại: giây -> "1 phút 05 giây" / "42 giây"
function formatEta(seconds) {
    if (!isFinite(seconds) || seconds <= 0) return '--';
    const s = Math.round(seconds);
    if (s < 60) return `${s} giây`;
    const m = Math.floor(s / 60);
    const rest = s % 60;
    return `${m} phút ${rest.toString().padStart(2, '0')} giây`;
}

let uploadStartedAt = null;

function startProcessingUI() {
    clearInterval(progressTimer);
    isProcessing = true;
    progressArea.style.display = 'block';
    resultZone.style.display = 'none';
    updateProgress(0, 'Đang chuẩn bị tải tệp tin lên máy chủ...');
    setActivity('Đang khởi tạo tiến trình...', 'active');

    uploadStartedAt = new Date();
    progressStartTime.innerText = uploadStartedAt.toLocaleTimeString('vi-VN');
    progressEndTime.innerText = 'Đang xử lý...';
    progressDuration.innerText = 'Đang xử lý...';
    progressSpeed.innerText = 'Đang đo...';
    progressEta.innerText = 'Đang tính...';
    return uploadStartedAt;
}

function failUpload(message) {
    clearInterval(progressTimer);
    isProcessing = false;
    updateProgress(0, `❌ Thất bại: ${message}`, 'error');
    setActivity(message, 'error');
    progressDuration.innerText = 'Thất bại';
    progressEta.innerText = '--';
}

function renderSuccess(finalResult, startedAt) {
    isProcessing = false;
    const finishedAt = new Date();
    const totalDuration = ((finishedAt - startedAt) / 1000).toFixed(2);

    updateProgress(100, 'Hoàn tất xử lý thành công!', 'complete');
    setActivity('Hoàn tất! Ứng dụng đã sẵn sàng chia sẻ.', 'done');
    progressEndTime.innerText = finishedAt.toLocaleTimeString('vi-VN');
    progressDuration.innerText = `${totalDuration} giây`;
    progressEta.innerText = 'Hoàn tất';

    document.getElementById('res-icon').src = finalResult.appInfo.icon;
    document.getElementById('res-name').innerText = finalResult.appInfo.appName;
    document.getElementById('res-bundle').innerText = finalResult.appInfo.bundleId;
    document.getElementById('res-version').innerText = `Phiên bản: ${finalResult.appInfo.version} (Build ${finalResult.appInfo.buildNumber})`;
    document.getElementById('res-link').href = finalResult.downloadUrl;
    document.getElementById('res-time').innerText = `⏱️ Bắt đầu: ${startedAt.toLocaleTimeString('vi-VN')} • Kết thúc: ${finishedAt.toLocaleTimeString('vi-VN')} • Tổng: ${totalDuration} giây`;
    shareUrlInput.value = finalResult.shareUrl;

    const qrBox = document.getElementById('qrcode-box');
    qrBox.innerHTML = '';
    const qr = qrcode(0, 'M');
    qr.addData(finalResult.shareUrl);
    qr.make();
    const qrImg = document.createElement('img');
    qrImg.src = qr.createDataURL(8, 0);
    qrImg.alt = 'Mã QR chia sẻ IPA';
    qrImg.width = 220;
    qrImg.height = 220;
    qrBox.appendChild(qrImg);
    qrDownloadDataUrl = qrImg.src;

    resultZone.style.display = 'block';
    loadCatalog();
}

function finishUpload(xhr, startedAt) {
    clearInterval(progressTimer);

    const status = xhr.status;
    const contentType = (xhr.getResponseHeader('content-type') || '').toLowerCase();
    const rawText = xhr.responseText || '';

    // Proxy/CDN trả về HTML thay vì JSON (quá dung lượng, gateway timeout, mất kết nối...)
    if (!contentType.includes('application/json')) {
        let hint;
        if (status === 413) hint = 'Tệp vượt quá giới hạn dung lượng cho phép (Cloudflare miễn phí giới hạn 100MB mỗi request).';
        else if (status === 502 || status === 504) hint = 'Máy chủ phản hồi quá lâu (gateway timeout).';
        else if (status === 0) hint = 'Kết nối tới máy chủ bị gián đoạn giữa chừng.';
        else hint = `Máy chủ trả về phản hồi không phải JSON (mã ${status}).`;
        failUpload(`${hint} Vui lòng kiểm tra Log Terminal bên dưới.`);
        return;
    }

    let result;
    try {
        result = JSON.parse(rawText);
    } catch (e) {
        failUpload('Không đọc được phản hồi JSON từ máy chủ.');
        return;
    }

    if (status < 200 || status >= 300 || !result.success) {
        failUpload(result.message || `Lỗi xử lý từ máy chủ (mã ${status}).`);
        return;
    }

    renderSuccess(result, startedAt);
}

let stallTimer = null;

function clearStallWatch() {
    clearTimeout(stallTimer);
    stallTimer = null;
}

// Nếu quá lâu không có thêm byte nào được gửi đi thì cảnh báo nghi treo
function armStallWatch() {
    clearStallWatch();
    stallTimer = setTimeout(() => {
        progressSpeed.innerText = '0 KB/s (nghẽn)';
        setActivity('⚠️ Đường truyền đang bị nghẽn (không có dữ liệu mới ~15 giây). Máy chủ có thể đang bận hoặc mạng chập chờn — vui lòng chờ hoặc thử lại.', 'active');
    }, 15000);
}

// ─── Shared upload helpers ───────────────────────────────────────────────────
let _uploadCompletedBytes = 0;
let _uploadInFlightBytes = {};
let _uploadStartTs = 0;
const _speedSamples = [];

function _resetUploadState() {
    _uploadCompletedBytes = 0;
    _uploadInFlightBytes = {};
    _uploadStartTs = performance.now();
    _speedSamples.length = 0;
}

function _recordSpeedSample() {
    const now = performance.now();
    const total = _uploadCompletedBytes + Object.values(_uploadInFlightBytes).reduce((a, b) => a + b, 0);
    _speedSamples.push({ t: now, b: total });
    if (_speedSamples.length > 60) _speedSamples.shift();
}

function _getSlidingSpeed() {
    const now = performance.now();
    const windowMs = 8000;
    while (_speedSamples.length > 1 && now - _speedSamples[0].t > windowMs) _speedSamples.shift();
    if (_speedSamples.length < 2) {
        const elapsedSec = (now - _uploadStartTs) / 1000;
        const total = _uploadCompletedBytes + Object.values(_uploadInFlightBytes).reduce((a, b) => a + b, 0);
        return elapsedSec > 0 ? total / elapsedSec : 0;
    }
    const dt = (_speedSamples[_speedSamples.length - 1].t - _speedSamples[0].t) / 1000;
    const db = _speedSamples[_speedSamples.length - 1].b - _speedSamples[0].b;
    return dt > 0 ? db / dt : 0;
}

function _refreshProgress(fileSize, concurrency) {
    const totalSent = _uploadCompletedBytes + Object.values(_uploadInFlightBytes).reduce((a, b) => a + b, 0);
    const speed = _getSlidingSpeed();
    const pct = (totalSent / fileSize) * 100;
    const mapped = Math.min(pct * 0.9, 90);
    updateProgress(mapped, `Đang tải lên: ${Math.round(pct)}% (${formatBytesClient(totalSent)} / ${formatBytesClient(fileSize)})`);
    progressSpeed.innerText = formatSpeed(speed);
    progressEta.innerText = speed > 0 ? formatEta((fileSize - totalSent) / speed) : '--';
    setActivity(`Đang truyền ${concurrency} luồng song song • ${formatBytesClient(totalSent)} / ${formatBytesClient(fileSize)} • ${formatSpeed(speed)}`, 'active');
}

// Polling kết quả xử lý file sau khi server nhận jobId
async function _pollJobResult(jobId) {
    let p = 92;
    clearInterval(progressTimer);
    progressTimer = setInterval(() => {
        p = Math.min(p + 0.3, 98);
        updateProgress(p, 'Máy chủ đang xử lý file và tạo liên kết chia sẻ...');
    }, 400);

    const pollStart = Date.now();
    while (true) {
        await new Promise(r => setTimeout(r, 2000));
        if (Date.now() - pollStart > 10 * 60 * 1000) {
            throw new Error('Máy chủ xử lý quá 10 phút, vui lòng kiểm tra Log Terminal hoặc thử lại.');
        }
        let statusData;
        try {
            const statusRes = await fetch(`/api/upload-status/${jobId}`);
            statusData = await statusRes.json().catch(() => null);
        } catch (_) { continue; }

        if (!statusData) continue;
        if (statusData.status === 'done' && statusData.result) return statusData.result;
        if (statusData.status === 'error') throw new Error(statusData.message || 'Máy chủ xử lý file thất bại.');
    }
}
// ─────────────────────────────────────────────────────────────────────────────

async function uploadSecure(file) {
    const startedAt = startProcessingUI();
    _resetUploadState();

    // Thử R2 direct upload trước; nếu server chưa cấu hình R2 thì fallback chunk cũ
    let r2Info = null;
    try {
        const r2StartRes = await fetch('/api/r2-start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ originalName: file.name }),
        });
        const r2StartData = await r2StartRes.json().catch(() => null);
        if (r2StartData && r2StartData.success && r2StartData.r2Available) {
            r2Info = { r2UploadId: r2StartData.r2UploadId, objectKey: r2StartData.objectKey };
        }
    } catch (_) { /* mạng lỗi → fallback */ }

    if (r2Info) {
        return uploadViaR2(file, startedAt, r2Info);
    } else {
        return uploadViaChunks(file, startedAt);
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// LUỒNG R2: client PUT trực tiếp lên Cloudflare R2, không qua Tunnel
// Part size 8MB (R2 yêu cầu ≥5MB/part trừ part cuối)
// ══════════════════════════════════════════════════════════════════════════════
async function uploadViaR2(file, startedAt, { r2UploadId, objectKey }) {
    const PART_SIZE  = 8 * 1024 * 1024; // 8MB/part
    const CONCURRENCY = 4;
    const MAX_RETRY  = 3;
    const totalParts = Math.ceil(file.size / PART_SIZE);
    const collectedParts = []; // { partNumber, etag }

    // PUT 1 part thẳng lên R2 qua presigned URL, trả về ETag
    const callR2PartApi = (partBlob, partNumber) => {
        return new Promise((resolve, reject) => {
            let attempt = 0;

            async function tryUpload() {
                // Lấy presigned URL từ server (nhỏ, qua tunnel, rất nhanh)
                let presignedUrl;
                try {
                    const res = await fetch('/api/r2-part-url', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ r2UploadId, objectKey, partNumber }),
                    });
                    const data = await res.json().catch(() => null);
                    if (!data || !data.success) throw new Error((data && data.message) || 'Lỗi lấy presigned URL.');
                    presignedUrl = data.presignedUrl;
                } catch (err) { handleError(err); return; }

                // PUT blob thẳng lên R2 (không qua Cloudflare Tunnel!)
                const xhr = new XMLHttpRequest();
                _uploadInFlightBytes[partNumber] = 0;

                xhr.upload.addEventListener('progress', (e) => {
                    if (!e.lengthComputable) return;
                    _uploadInFlightBytes[partNumber] = e.loaded;
                    _recordSpeedSample();
                    _refreshProgress(file.size, CONCURRENCY);
                    armStallWatch();
                });

                xhr.addEventListener('load', () => {
                    if (xhr.status >= 200 && xhr.status < 300) {
                        const etag = xhr.getResponseHeader('ETag');
                        _uploadInFlightBytes[partNumber] = partBlob.size;
                        resolve({ partNumber, etag });
                    } else {
                        handleError(new Error(`Part #${partNumber} thất bại (HTTP ${xhr.status}).`));
                    }
                });
                xhr.addEventListener('error', () => handleError(new Error(`Lỗi mạng gửi part #${partNumber}.`)));
                xhr.addEventListener('timeout', () => handleError(new Error(`Part #${partNumber} timeout (>120s).`)));
                xhr.timeout = 120 * 1000;

                xhr.open('PUT', presignedUrl);
                xhr.send(partBlob);
            }

            function handleError(err) {
                delete _uploadInFlightBytes[partNumber];
                attempt++;
                if (attempt > MAX_RETRY) { reject(err); return; }
                setTimeout(tryUpload, Math.min(1000 * Math.pow(2, attempt - 1), 8000));
            }

            tryUpload();
        });
    };

    try {
        armStallWatch();
        _recordSpeedSample();
        setActivity(`R2 direct upload — ${CONCURRENCY} luồng song song (không qua Tunnel)...`, 'active');

        let nextPart = 1; // R2 partNumber bắt đầu từ 1
        const worker = async () => {
            while (nextPart <= totalParts) {
                const pNum = nextPart++;
                const start = (pNum - 1) * PART_SIZE;
                const end = Math.min(start + PART_SIZE, file.size);
                const blob = file.slice(start, end);
                const { partNumber, etag } = await callR2PartApi(blob, pNum);
                _uploadCompletedBytes += (end - start);
                delete _uploadInFlightBytes[partNumber];
                collectedParts.push({ partNumber, etag });
                _recordSpeedSample();
                _refreshProgress(file.size, CONCURRENCY);
            }
        };

        const workers = [];
        for (let w = 0; w < Math.min(CONCURRENCY, totalParts); w++) workers.push(worker());
        await Promise.all(workers);

        clearStallWatch();
        updateProgress(92, 'Upload R2 hoàn tất. Máy chủ đang ghép và phân tích file...');
        setActivity('R2 đã nhận đủ dữ liệu — máy chủ đang hoàn tất...', 'active');

        // Finalize: gửi danh sách ETags để R2 ghép + server parse IPA ở nền
        const finCtrl = new AbortController();
        const finTimeout = setTimeout(() => finCtrl.abort(), 30 * 1000);
        let jobId;
        try {
            const finRes = await fetch('/api/r2-finalize', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    r2UploadId, objectKey,
                    parts: collectedParts,
                    originalName: file.name,
                    totalSize: file.size,
                }),
                signal: finCtrl.signal,
            });
            const finData = await finRes.json().catch(() => null);
            if (!finRes.ok || !finData || !finData.success) {
                throw new Error((finData && finData.message) || `Lỗi r2-finalize (mã ${finRes.status}).`);
            }
            jobId = finData.jobId;
        } finally {
            clearTimeout(finTimeout);
        }

        const result = await _pollJobResult(jobId);
        clearInterval(progressTimer);
        renderSuccess(result, startedAt);
    } catch (err) {
        clearInterval(progressTimer);
        clearStallWatch();
        failUpload(err.name === 'AbortError'
            ? 'Finalize timeout. Vui lòng thử lại.'
            : (err.message || 'Không thể kết nối tới máy chủ.'));
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// LUỒNG FALLBACK: chunk qua server (dùng khi R2 chưa cấu hình)
// ══════════════════════════════════════════════════════════════════════════════
async function uploadViaChunks(file, startedAt) {
    const CHUNK_SIZE  = 3 * 1024 * 1024;
    const CONCURRENCY = 4;
    const MAX_RETRY   = 3;
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
    const uploadId = Date.now().toString() + Math.random().toString(36).slice(2, 8);

    const callChunkApi = (chunkBlob, index) => {
        return new Promise((resolve, reject) => {
            let attempt = 0;
            const tryUpload = () => {
                const xhr = new XMLHttpRequest();
                _uploadInFlightBytes[index] = 0;

                xhr.upload.addEventListener('progress', (e) => {
                    if (!e.lengthComputable) return;
                    _uploadInFlightBytes[index] = e.loaded;
                    _recordSpeedSample();
                    _refreshProgress(file.size, CONCURRENCY);
                    armStallWatch();
                });

                xhr.addEventListener('load', () => {
                    let data = null;
                    try { data = JSON.parse(xhr.responseText); } catch (_) {}
                    if (xhr.status >= 200 && xhr.status < 300 && data && data.success) {
                        resolve();
                    } else {
                        onError(new Error((data && data.message) || `Chunk #${index + 1} thất bại (HTTP ${xhr.status}).`));
                    }
                });
                xhr.addEventListener('error', () => onError(new Error(`Lỗi mạng chunk #${index + 1}.`)));
                xhr.addEventListener('timeout', () => onError(new Error(`Chunk #${index + 1} timeout.`)));
                xhr.timeout = 90 * 1000;

                const onError = (err) => {
                    delete _uploadInFlightBytes[index];
                    attempt++;
                    if (attempt > MAX_RETRY) { reject(err); return; }
                    setTimeout(tryUpload, Math.min(1000 * Math.pow(2, attempt - 1), 8000));
                };

                const formData = new FormData();
                formData.append('chunk', chunkBlob, `${file.name}.part${index}`);
                formData.append('uploadId', uploadId);
                formData.append('chunkIndex', String(index));
                formData.append('totalChunks', String(totalChunks));
                formData.append('originalName', file.name);
                xhr.open('POST', '/api/upload-chunk');
                xhr.send(formData);
            };
            tryUpload();
        });
    };

    try {
        armStallWatch();
        _recordSpeedSample();
        setActivity(`Chunk upload — ${CONCURRENCY} luồng song song...`, 'active');

        let nextIndex = 0;
        const worker = async () => {
            while (nextIndex < totalChunks) {
                const i = nextIndex++;
                const start = i * CHUNK_SIZE;
                const end = Math.min(start + CHUNK_SIZE, file.size);
                await callChunkApi(file.slice(start, end), i);
                _uploadCompletedBytes += (end - start);
                delete _uploadInFlightBytes[i];
                _recordSpeedSample();
                _refreshProgress(file.size, CONCURRENCY);
            }
        };

        const workers = [];
        for (let w = 0; w < Math.min(CONCURRENCY, totalChunks); w++) workers.push(worker());
        await Promise.all(workers);

        clearStallWatch();
        updateProgress(92, 'Đã tải xong. Máy chủ đang ghép chunk và phân tích file...');
        setActivity('Máy chủ đang xử lý...', 'active');

        const finCtrl = new AbortController();
        const finTimeout = setTimeout(() => finCtrl.abort(), 30 * 1000);
        let jobId;
        try {
            const finRes = await fetch('/api/upload-finalize', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ uploadId, totalChunks, originalName: file.name, totalSize: file.size }),
                signal: finCtrl.signal,
            });
            const finData = await finRes.json().catch(() => null);
            if (!finRes.ok || !finData || !finData.success) {
                throw new Error((finData && finData.message) || `Lỗi finalize (mã ${finRes.status}).`);
            }
            jobId = finData.jobId;
        } finally {
            clearTimeout(finTimeout);
        }

        const result = await _pollJobResult(jobId);
        clearInterval(progressTimer);
        renderSuccess(result, startedAt);
    } catch (err) {
        clearInterval(progressTimer);
        clearStallWatch();
        failUpload(err.name === 'AbortError'
            ? 'Chunk upload bị timeout (>90s). Mạng quá chậm hoặc proxy nghẽn.'
            : (err.message || 'Không thể kết nối tới máy chủ. Kiểm tra mạng rồi thử lại.'));
    }
}

copyLinkButton.addEventListener('click', async () => {
    const url = shareUrlInput.value;
    if (!url) return;

    try {
        await navigator.clipboard.writeText(url);
        copyLinkButton.innerText = 'Đã sao chép';
        setTimeout(() => {
            copyLinkButton.innerText = 'Sao chép';
        }, 1500);
    } catch (error) {
        shareUrlInput.select();
        document.execCommand('copy');
        copyLinkButton.innerText = 'Đã sao chép';
        setTimeout(() => {
            copyLinkButton.innerText = 'Sao chép';
        }, 1500);
    }
});

downloadQrButton.addEventListener('click', () => {
    if (!qrDownloadDataUrl) return;
    const link = document.createElement('a');
    link.href = qrDownloadDataUrl;
    link.download = 'qrcode-share-ipa.png';
    link.click();
});
