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

const catalogContainer = document.getElementById('catalog-container');
const catalogList = document.getElementById('catalog-list');
const catalogEmpty = document.getElementById('catalog-empty');
const catalogSub = document.getElementById('catalog-sub');
const catalogRefreshBtn = document.getElementById('catalog-refresh-btn');

const protectedAreas = [dropZone, progressArea, resultZone, logsContainer, catalogContainer];

let isAuthenticated = false;
let logsSource = null;

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
    authBox.style.display = authenticated ? 'none' : 'block';
    authStatus.style.display = authenticated ? 'flex' : 'none';
    protectedAreas.forEach(el => el.classList.toggle('locked', !authenticated));

    if (authenticated) {
        connectLogs();
        loadCatalog();
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

function getBuildsForBundle(bundleId) {
    return catalogItems
        .filter(item => (item.bundleId || item.id) === bundleId)
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

function syncRouteFromUrl() {
    const bundleId = new URLSearchParams(window.location.search).get('bundle');
    if (window.location.pathname === '/app' && bundleId) {
        const builds = getBuildsForBundle(bundleId);
        if (builds.length) {
            showAppDetailPanel({ latest: builds[0], builds });
            return;
        }
    }
    hideAppDetailPanel();
}

function navigateToAppDetail(bundleId) {
    const builds = getBuildsForBundle(bundleId);
    if (!builds.length) return;
    history.pushState(
        { view: 'app-detail', bundleId },
        '',
        `/app?bundle=${encodeURIComponent(bundleId)}`
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

// Gom nhóm theo bundleId: mỗi nhóm là 1 "thư mục app" kèm toàn bộ bản build
function groupByBundle(items) {
    const map = new Map();
    items.forEach(item => {
        const key = item.bundleId || item.id;
        if (!map.has(key)) map.set(key, { key, builds: [] });
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

function renderCatalog(configured) {
    setCatalogLoading(false);
    const groups = groupByBundle(catalogItems);
    catalogList.innerHTML = '';

    if (configured !== false) {
        catalogSub.innerText = groups.length
            ? `Có ${groups.length} ứng dụng trong danh mục.`
            : 'Danh sách các ứng dụng đã xử lý và lưu trữ.';
    }

    if (!groups.length) {
        catalogEmpty.style.display = 'block';
        return;
    }
    catalogEmpty.style.display = 'none';

    groups.forEach((group) => {
        const { latest, count } = group;
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
                <span class="badge">📁 ${count} bản build</span>
                <span>🆕 v${escapeHtml(latest.version)} (Build ${escapeHtml(latest.buildNumber)})</span>
                <span>🕒 ${escapeHtml(formatDateTime(latest.uploadedAt))}</span>
            </div>
            <div class="app-card-actions">
                <button type="button" class="btn view-all-btn">Xem tất cả</button>
            </div>
        `;
        const open = () => navigateToAppDetail(latest.bundleId || group.key);
        card.addEventListener('click', open);
        catalogList.appendChild(card);
    });
}

catalogRefreshBtn.addEventListener('click', loadCatalog);

async function checkAuthStatus() {
    try {
        const res = await fetch('/api/auth-status');
        const data = await res.json();
        applyAuthState(!!data.authenticated);
    } catch (err) {
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
    clearTimeout(logsReconnectTimer);
    if (logsSource) {
        logsSource.close();
        logsSource = null;
    }
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
    if (!file.name.endsWith('.ipa')) {
        alert('Vui lòng chỉ chọn tệp tin định dạng .ipa');
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

async function uploadSecure(file) {
    const startedAt = startProcessingUI();
    const CHUNK_SIZE = 6 * 1024 * 1024;   // 6MB/chunk: ít vòng gửi hơn mà vẫn dưới timeout 100s
    const CONCURRENCY = 4;                 // số chunk gửi song song để lấp đầy băng thông
    const MAX_RETRY = 2;                   // tự thử lại chunk lỗi trước khi bỏ cuộc
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
    const uploadId = Date.now().toString() + Math.random().toString(36).slice(2, 8);

    let completedBytes = 0;
    const uploadStartTs = performance.now();

    const callChunkApi = async (chunkBlob, index) => {
        let attempt = 0;
        while (true) {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 60 * 1000); // mỗi chunk tối đa 60s
            try {
                const formData = new FormData();
                formData.append('chunk', chunkBlob, `${file.name}.part${index}`);
                formData.append('uploadId', uploadId);
                formData.append('chunkIndex', String(index));
                formData.append('totalChunks', String(totalChunks));
                formData.append('originalName', file.name);

                const res = await fetch('/api/upload-chunk', {
                    method: 'POST',
                    body: formData,
                    signal: controller.signal
                });
                const data = await res.json().catch(() => ({ success: false, message: 'Phản hồi không hợp lệ khi upload chunk.' }));
                if (!res.ok || !data.success) {
                    throw new Error(data.message || `Upload chunk #${index + 1} thất bại.`);
                }
                return;
            } catch (e) {
                attempt++;
                if (attempt > MAX_RETRY) throw e;
                await new Promise(r => setTimeout(r, 800 * attempt)); // chờ ngắn rồi thử lại
            } finally {
                clearTimeout(timeout);
            }
        }
    };

    const refreshProgress = () => {
        armStallWatch();
        const elapsedSec = (performance.now() - uploadStartTs) / 1000;
        const avgBps = elapsedSec > 0 ? completedBytes / elapsedSec : 0;
        const uploadedPercent = (completedBytes / file.size) * 100;
        const mapped = Math.min(uploadedPercent * 0.9, 90);
        updateProgress(mapped, `Đang tải lên: ${Math.round(uploadedPercent)}% (${formatBytesClient(completedBytes)} / ${formatBytesClient(file.size)})`);
        progressSpeed.innerText = formatSpeed(avgBps);
        const remainingBytes = file.size - completedBytes;
        progressEta.innerText = avgBps > 0 ? formatEta(remainingBytes / avgBps) : '--';
        setActivity(`Đang truyền song song ${CONCURRENCY} luồng (${formatBytesClient(completedBytes)} / ${formatBytesClient(file.size)}) • ${formatSpeed(avgBps)}`, 'active');
    };

    try {
        armStallWatch();
        setActivity(`Đang tải lên song song ${CONCURRENCY} luồng...`, 'active');

        // Hàng đợi chỉ số chunk + nhóm worker rút việc song song
        let nextIndex = 0;
        const worker = async () => {
            while (nextIndex < totalChunks) {
                const i = nextIndex++;
                const start = i * CHUNK_SIZE;
                const end = Math.min(start + CHUNK_SIZE, file.size);
                const chunk = file.slice(start, end);
                await callChunkApi(chunk, i);
                completedBytes += (end - start);
                refreshProgress();
            }
        };

        const workers = [];
        for (let w = 0; w < Math.min(CONCURRENCY, totalChunks); w++) workers.push(worker());
        await Promise.all(workers);

        clearStallWatch();
        progressEta.innerText = 'Đã tải xong';
        updateProgress(92, 'Đã tải lên xong. Máy chủ đang ghép chunk và phân tích IPA...');
        setActivity('Máy chủ đang ghép các phần tệp và phân tích IPA', 'active');

        let p = 92;
        clearInterval(progressTimer);
        progressTimer = setInterval(() => {
            p = Math.min(p + 0.5, 98);
            updateProgress(p, 'Máy chủ đang xử lý IPA và tạo liên kết chia sẻ...');
        }, 400);

        const finalizeRes = await fetch('/api/upload-finalize', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                uploadId,
                totalChunks,
                originalName: file.name,
                totalSize: file.size
            })
        });

        const result = await finalizeRes.json().catch(() => null);
        clearInterval(progressTimer);
        if (!finalizeRes.ok || !result || !result.success) {
            throw new Error((result && result.message) || `Lỗi xử lý từ máy chủ (mã ${finalizeRes.status}).`);
        }

        renderSuccess(result, startedAt);
    } catch (err) {
        clearInterval(progressTimer);
        clearStallWatch();
        const isAbort = err && (err.name === 'AbortError');
        failUpload(isAbort
            ? 'Một chunk upload bị timeout (>60s). Mạng quá chậm hoặc proxy đang nghẽn.'
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
