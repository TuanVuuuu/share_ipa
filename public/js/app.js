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
const catalogTitle = document.getElementById('catalog-title');
const catalogRefreshBtn = document.getElementById('catalog-refresh-btn');
const catalogDetail = document.getElementById('catalog-detail');
const catalogBack = document.getElementById('catalog-back');
const detailIcon = document.getElementById('detail-icon');
const detailName = document.getElementById('detail-name');
const detailBundle = document.getElementById('detail-bundle');
const detailBuilds = document.getElementById('detail-builds');

const qrModal = document.getElementById('qr-modal');
const qrModalClose = document.getElementById('qr-modal-close');
const qrModalTitle = document.getElementById('qr-modal-title');
const qrModalVersion = document.getElementById('qr-modal-version');
const qrModalImage = document.getElementById('qr-modal-image');
const qrModalUrl = document.getElementById('qr-modal-url');
const qrModalCopy = document.getElementById('qr-modal-copy');
const qrModalInstall = document.getElementById('qr-modal-install');

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

async function loadCatalog() {
    if (!isAuthenticated) return;
    showCatalogList(); // luôn quay về màn danh sách thư mục khi tải lại
    catalogSub.innerText = 'Đang tải danh mục...';
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

// Chuyển về màn hình danh sách thư mục
function showCatalogList() {
    catalogDetail.style.display = 'none';
    catalogList.style.display = 'grid';
    catalogTitle.innerText = 'Danh mục ứng dụng';
}

function renderCatalog(configured) {
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
        const open = () => openAppDetail(group);
        card.addEventListener('click', open);
        catalogList.appendChild(card);
    });
}

// Mở màn chi tiết: danh sách tất cả bản build của 1 app
function openAppDetail(group) {
    const { latest, builds } = group;

    detailIcon.src = latest.icon || FALLBACK_ICON;
    detailIcon.onerror = () => { detailIcon.src = FALLBACK_ICON; };
    detailName.innerText = latest.appName || 'Ứng dụng iOS';
    detailBundle.innerText = latest.bundleId || '';
    catalogTitle.innerText = 'Chi tiết ứng dụng';
    catalogSub.innerText = `${builds.length} bản build của "${latest.appName}".`;

    detailBuilds.innerHTML = '';
    builds.forEach((build, index) => {
        const row = document.createElement('div');
        row.className = 'build-row';
        row.innerHTML = `
            <div class="build-info">
                <span class="badge">v${escapeHtml(build.version)} (Build ${escapeHtml(build.buildNumber)})</span>
                ${index === 0 ? '<span class="build-latest">Mới nhất</span>' : ''}
                <div class="build-sub">📦 ${escapeHtml(build.fileSize || '--')} • 🕒 ${escapeHtml(formatDateTime(build.uploadedAt))}</div>
            </div>
            <div class="build-actions">
                <button type="button" class="btn secondary qr-btn">Xem QR</button>
                <a class="btn install-mini" href="${escapeHtml(build.downloadUrl)}">Cài đặt</a>
            </div>
        `;
        row.querySelector('.qr-btn').addEventListener('click', () => openQrModal(build));
        detailBuilds.appendChild(row);
    });

    catalogList.style.display = 'none';
    catalogEmpty.style.display = 'none';
    catalogDetail.style.display = 'block';
    catalogContainer.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

catalogBack.addEventListener('click', () => {
    showCatalogList();
    const groups = groupByBundle(catalogItems);
    catalogSub.innerText = groups.length
        ? `Có ${groups.length} ứng dụng trong danh mục.`
        : 'Danh sách các ứng dụng đã xử lý và lưu trữ.';
});

function openQrModal(item) {
    qrModalTitle.innerText = item.appName || 'Ứng dụng';
    qrModalVersion.innerText = `${item.bundleId || ''} • v${item.version} (Build ${item.buildNumber})`;
    qrModalUrl.value = item.shareUrl || '';
    qrModalInstall.href = item.downloadUrl || '#';

    qrModalImage.innerHTML = '';
    const img = document.createElement('img');
    if (item.qr) {
        img.src = item.qr;
    } else if (item.shareUrl) {
        const qr = qrcode(0, 'M');
        qr.addData(item.shareUrl);
        qr.make();
        img.src = qr.createDataURL(8, 0);
    }
    img.alt = 'QR cài đặt';
    qrModalImage.appendChild(img);

    qrModal.style.display = 'flex';
}

function closeQrModal() {
    qrModal.style.display = 'none';
}

qrModalClose.addEventListener('click', closeQrModal);
qrModal.addEventListener('click', (e) => { if (e.target === qrModal) closeQrModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeQrModal(); });

qrModalCopy.addEventListener('click', async () => {
    const url = qrModalUrl.value;
    if (!url) return;
    try {
        await navigator.clipboard.writeText(url);
    } catch (err) {
        qrModalUrl.select();
        document.execCommand('copy');
    }
    qrModalCopy.innerText = 'Đã sao chép';
    setTimeout(() => { qrModalCopy.innerText = 'Sao chép'; }, 1500);
});

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
    const CHUNK_SIZE = 4 * 1024 * 1024; // 4MB/chunk: đủ nhỏ để mỗi request không chạm timeout 100s
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
    const uploadId = Date.now().toString() + Math.random().toString(36).slice(2, 8);

    let uploadedBytes = 0;
    let lastBytes = 0;
    let lastTs = performance.now();
    let smoothedBps = 0;

    const callChunkApi = async (chunkBlob, index) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 45 * 1000); // mỗi chunk tối đa 45s
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
        } finally {
            clearTimeout(timeout);
        }
    };

    try {
        armStallWatch();
        for (let i = 0; i < totalChunks; i++) {
            const start = i * CHUNK_SIZE;
            const end = Math.min(start + CHUNK_SIZE, file.size);
            const chunk = file.slice(start, end);

            setActivity(`Đang tải chunk ${i + 1}/${totalChunks} lên máy chủ...`, 'active');
            await callChunkApi(chunk, i);
            armStallWatch();

            uploadedBytes = end;
            const now = performance.now();
            const deltaBytes = uploadedBytes - lastBytes;
            const deltaSec = (now - lastTs) / 1000;
            if (deltaSec > 0 && deltaBytes >= 0) {
                const instantBps = deltaBytes / deltaSec;
                smoothedBps = smoothedBps === 0 ? instantBps : smoothedBps * 0.7 + instantBps * 0.3;
                lastBytes = uploadedBytes;
                lastTs = now;
            }

            const uploadedPercent = (uploadedBytes / file.size) * 100;
            const mapped = Math.min(uploadedPercent * 0.9, 90);
            updateProgress(mapped, `Đang tải lên: ${Math.round(uploadedPercent)}% (${formatBytesClient(uploadedBytes)} / ${formatBytesClient(file.size)})`);
            progressSpeed.innerText = formatSpeed(smoothedBps);
            const remainingBytes = file.size - uploadedBytes;
            progressEta.innerText = smoothedBps > 0 ? formatEta(remainingBytes / smoothedBps) : '--';
            setActivity(`Đang truyền dữ liệu lên máy chủ (${formatBytesClient(uploadedBytes)} / ${formatBytesClient(file.size)}) • ${formatSpeed(smoothedBps)}`, 'active');
        }

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
            ? 'Một chunk upload bị timeout (>45s). Mạng quá chậm hoặc proxy đang nghẽn.'
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
