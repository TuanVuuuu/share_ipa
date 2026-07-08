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
const resultZone = document.getElementById('result-zone');
const logsContainer = document.getElementById('terminal-logs');
const shareUrlInput = document.getElementById('share-url');
const copyLinkButton = document.getElementById('copy-link-btn');
const downloadQrButton = document.getElementById('download-qr-btn');
let progressTimer = null;
let qrDownloadDataUrl = '';

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
function connectLogs() {
    if (logsSource) return;
    logsSource = new EventSource('/api/logs');
    logsSource.onmessage = function(event) {
        const data = JSON.parse(event.data);
        appendLog(data.time, data.message, data.type);
    };
    logsSource.onerror = function() {
        logsSource.close();
        logsSource = null;
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

// Gom nhóm theo bundleId, chỉ hiển thị bản build mới nhất của mỗi app
function groupLatestByBundle(items) {
    const map = new Map();
    items.forEach(item => {
        const key = item.bundleId || item.id;
        const existing = map.get(key);
        if (!existing) {
            map.set(key, { latest: item, count: 1 });
        } else {
            existing.count += 1;
            const a = new Date(item.uploadedAt).getTime() || 0;
            const b = new Date(existing.latest.uploadedAt).getTime() || 0;
            if (a > b) existing.latest = item;
        }
    });
    return Array.from(map.values())
        .sort((x, y) => (new Date(y.latest.uploadedAt).getTime() || 0) - (new Date(x.latest.uploadedAt).getTime() || 0));
}

function renderCatalog(configured) {
    const groups = groupLatestByBundle(catalogItems);
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

    groups.forEach(({ latest, count }) => {
        const card = document.createElement('div');
        card.className = 'app-card';
        card.innerHTML = `
            <div class="app-card-top">
                <img src="${escapeHtml(latest.icon || FALLBACK_ICON)}" alt="icon" onerror="this.src='${FALLBACK_ICON}'">
                <div class="app-card-info">
                    <h4>${escapeHtml(latest.appName)}</h4>
                    <p class="app-card-bundle">${escapeHtml(latest.bundleId)}</p>
                </div>
            </div>
            <div class="app-card-meta">
                <span class="badge">v${escapeHtml(latest.version)} (Build ${escapeHtml(latest.buildNumber)})</span>
                <span>📦 ${escapeHtml(latest.fileSize || '--')}${count > 1 ? ` • ${count} bản build` : ''}</span>
                <span>🕒 ${escapeHtml(formatDateTime(latest.uploadedAt))}</span>
            </div>
            <div class="app-card-actions">
                <button type="button" class="btn qr-btn">Xem QR</button>
                <a class="btn secondary" href="${escapeHtml(latest.downloadUrl)}">Cài đặt</a>
            </div>
        `;
        card.querySelector('.qr-btn').addEventListener('click', () => openQrModal(latest));
        catalogList.appendChild(card);
    });
}

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

function updateProgress(percent, message, isComplete = false) {
    const safePercent = Math.min(Math.max(percent, 0), 100);
    progressFill.style.width = `${safePercent}%`;
    progressFill.style.background = isComplete ? 'var(--success)' : 'var(--primary)';
    progressPercent.innerText = `${Math.round(safePercent)}%`;
    statusLabel.innerText = message;
}

function startProcessingUI() {
    clearInterval(progressTimer);
    progressArea.style.display = 'block';
    resultZone.style.display = 'none';
    updateProgress(5, 'Đang chuẩn bị tải tệp tin lên máy chủ...');

    const startedAt = new Date();
    progressStartTime.innerText = startedAt.toLocaleTimeString('vi-VN');
    progressEndTime.innerText = 'Đang xử lý...';
    progressDuration.innerText = 'Đang xử lý...';

    let simulatedProgress = 8;
    progressTimer = setInterval(() => {
        simulatedProgress = Math.min(simulatedProgress + Math.random() * 8 + 2, 92);
        updateProgress(simulatedProgress, simulatedProgress < 80 ? 'Máy chủ đang xử lý dữ liệu...' : 'Đang kết nối và chuẩn bị kết quả...');
    }, 450);

    return startedAt;
}

async function uploadSecure(file) {
    const startedAt = startProcessingUI();

    try {
        const formData = new FormData();
        formData.append('ipaFile', file);

        const response = await fetch('/api/upload-secure', {
            method: 'POST',
            body: formData
        });

        clearInterval(progressTimer);
        updateProgress(95, 'Máy chủ đang hoàn tất xử lý và tạo liên kết chia sẻ...', false);

        const contentType = response.headers.get("content-type");
        if (!contentType || !contentType.includes("application/json")) {
            throw new Error("Máy chủ trả về phản hồi lỗi dạng HTML/Văn bản thay vì JSON. Vui lòng kiểm tra Log Terminal bên dưới.");
        }

        const finalResult = await response.json();

        if (!finalResult.success) {
            throw new Error(finalResult.message || 'Lỗi xử lý không xác định từ Server.');
        }

        const finishedAt = new Date();
        const totalDuration = ((finishedAt - startedAt) / 1000).toFixed(2);

        updateProgress(100, 'Hoàn tất xử lý thành công!', true);
        progressEndTime.innerText = finishedAt.toLocaleTimeString('vi-VN');
        progressDuration.innerText = `${totalDuration} giây`;

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

        // Danh mục vừa được cập nhật ở server, tải lại để hiển thị app mới
        loadCatalog();

    } catch (err) {
        clearInterval(progressTimer);
        updateProgress(0, `❌ Thất bại: ${err.message}`, false);
        progressFill.style.background = 'var(--danger)';
        progressDuration.innerText = 'Thất bại';
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
