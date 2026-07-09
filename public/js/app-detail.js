const FALLBACK_ICON = 'https://cdn-icons-png.flaticon.com/512/5115/5115293.png';

const appDetailZone = document.getElementById('app-detail-zone');
const detailPageSub = document.getElementById('detail-page-sub');
const detailHeader = document.getElementById('detail-header');
const detailIcon = document.getElementById('detail-icon');
const detailName = document.getElementById('detail-name');
const detailBundle = document.getElementById('detail-bundle');
const detailBuilds = document.getElementById('detail-builds');
const detailEmpty = document.getElementById('detail-empty');
const detailAuth = document.getElementById('detail-auth');
const detailShareBtn = document.getElementById('detail-share-btn');

const qrModal = document.getElementById('qr-modal');
const qrModalClose = document.getElementById('qr-modal-close');
const qrModalTitle = document.getElementById('qr-modal-title');
const qrModalVersion = document.getElementById('qr-modal-version');
const qrModalImage = document.getElementById('qr-modal-image');
const qrModalUrl = document.getElementById('qr-modal-url');
const qrModalCopy = document.getElementById('qr-modal-copy');
const qrModalInstall = document.getElementById('qr-modal-install');

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
    await copyText(url, qrModalCopy);
});

async function copyText(text, button) {
    if (!text) return;
    try {
        await navigator.clipboard.writeText(text);
    } catch (err) {
        const input = document.createElement('input');
        input.value = text;
        document.body.appendChild(input);
        input.select();
        document.execCommand('copy');
        document.body.removeChild(input);
    }
    if (button) {
        const original = button.innerText;
        button.innerText = 'Đã sao chép';
        setTimeout(() => { button.innerText = original; }, 1500);
    }
}

detailShareBtn.addEventListener('click', () => copyText(window.location.href, detailShareBtn));

function stopLoading() {
    appDetailZone.classList.remove('is-loading');
}

function renderBuilds(builds) {
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
}

function renderAppDetail(group) {
    stopLoading();
    const { latest, builds } = group;

    detailIcon.src = latest.icon || FALLBACK_ICON;
    detailIcon.onerror = () => { detailIcon.src = FALLBACK_ICON; };
    detailName.innerText = latest.appName || 'Ứng dụng iOS';
    detailBundle.innerText = latest.bundleId || '';
    detailPageSub.innerText = `${builds.length} bản build của "${latest.appName}".`;
    document.title = `${latest.appName || 'Ứng dụng'} — Share IPA`;

    detailHeader.style.display = 'flex';
    renderBuilds(builds);
}

async function init() {
    const params = new URLSearchParams(window.location.search);
    const bundleId = (params.get('bundle') || '').trim();

    if (!bundleId) {
        stopLoading();
        detailPageSub.innerText = 'Thiếu thông tin ứng dụng.';
        detailEmpty.style.display = 'block';
        return;
    }

    detailShareBtn.style.display = 'inline-block';

    try {
        const authRes = await fetch('/api/auth-status');
        const authData = await authRes.json();
        if (!authData.authenticated) {
            stopLoading();
            detailPageSub.style.display = 'none';
            detailAuth.style.display = 'block';
            return;
        }

        const res = await fetch('/api/catalog');
        if (!res.ok) throw new Error('Không tải được danh mục.');
        const data = await res.json();
        const items = Array.isArray(data.items) ? data.items : [];
        const builds = items
            .filter(item => (item.bundleId || item.id) === bundleId)
            .sort((a, b) => (new Date(b.uploadedAt).getTime() || 0) - (new Date(a.uploadedAt).getTime() || 0));

        if (!builds.length) {
            stopLoading();
            detailPageSub.innerText = `Không có bản build nào cho "${bundleId}".`;
            detailEmpty.style.display = 'block';
            return;
        }

        renderAppDetail({ latest: builds[0], builds });
    } catch (err) {
        stopLoading();
        detailPageSub.innerText = `Lỗi: ${err.message}`;
    }
}

init();
