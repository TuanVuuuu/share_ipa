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
const protectedAreas = [dropZone, progressArea, resultZone, logsContainer];

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
    }
}

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
