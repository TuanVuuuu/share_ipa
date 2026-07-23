const FALLBACK_ICON = 'https://cdn-icons-png.flaticon.com/512/5115/5115293.png';

const listView = document.getElementById('list-view');
const pickView = document.getElementById('pick-view');
const appList = document.getElementById('app-list');
const listEmpty = document.getElementById('list-empty');
const pickBack = document.getElementById('pick-back');
const pickIcon = document.getElementById('pick-icon');
const pickName = document.getElementById('pick-name');
const pickSub = document.getElementById('pick-sub');
const iosSelect = document.getElementById('ios-select');
const androidSelect = document.getElementById('android-select');
const iosHint = document.getElementById('ios-hint');
const androidHint = document.getElementById('android-hint');
const shareLinkInput = document.getElementById('share-link-input');
const copyShareBtn = document.getElementById('copy-share-btn');
const openShareBtn = document.getElementById('open-share-btn');

let appsByName = new Map();
let currentApp = null;

function escapeHtml(text) {
    return String(text == null ? '' : text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function formatDateTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleString('vi-VN');
}

function sortBuilds(builds) {
    return [...builds].sort((a, b) => (new Date(b.uploadedAt).getTime() || 0) - (new Date(a.uploadedAt).getTime() || 0));
}

function groupByAppName(items) {
    const map = new Map();
    for (const item of items) {
        const name = (item.appName || item.bundleId || item.id || 'Unknown').trim();
        if (!map.has(name)) {
            map.set(name, { name, ios: [], android: [], icon: item.icon || FALLBACK_ICON });
        }
        const group = map.get(name);
        const platform = item.platform || 'ios';
        if (platform === 'android') group.android.push(item);
        else group.ios.push(item);
        if (item.icon && group.icon === FALLBACK_ICON) group.icon = item.icon;
    }
    for (const group of map.values()) {
        group.ios = sortBuilds(group.ios);
        group.android = sortBuilds(group.android);
    }
    return map;
}

function buildOptionLabel(build) {
    const ver = build.version || '?';
    const bn = build.buildNumber != null ? ` (${build.buildNumber})` : '';
    const when = build.uploadedAt ? ` · ${formatDateTime(build.uploadedAt)}` : '';
    return `v${ver}${bn}${when}`;
}

function fillSelect(selectEl, builds, hintEl, emptyText) {
    selectEl.innerHTML = '';
    if (!builds.length) {
        selectEl.disabled = true;
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = emptyText;
        selectEl.appendChild(opt);
        hintEl.textContent = emptyText;
        return;
    }
    selectEl.disabled = false;
    for (const build of builds) {
        const opt = document.createElement('option');
        opt.value = build.id;
        opt.textContent = buildOptionLabel(build);
        selectEl.appendChild(opt);
    }
    selectEl.value = builds[0].id;
    hintEl.textContent = `${builds.length} bản có sẵn`;
}

function buildShareUrl() {
    const params = new URLSearchParams();
    if (iosSelect.value) params.set('ios', iosSelect.value);
    if (androidSelect.value) params.set('android', androidSelect.value);
    const qs = params.toString();
    return qs ? `${window.location.origin}/dl?${qs}` : '';
}

function refreshShareLink() {
    const url = buildShareUrl();
    shareLinkInput.value = url;
    openShareBtn.href = url || '#';
    openShareBtn.classList.toggle('disabled', !url);
    copyShareBtn.disabled = !url;
}

function showList() {
    listView.style.display = '';
    pickView.style.display = 'none';
    history.replaceState({ view: 'list' }, '', '/download');
    document.title = 'Tạo link tải — Share IPA';
}

function showPick(appName) {
    const app = appsByName.get(appName);
    if (!app) {
        showList();
        return;
    }
    currentApp = app;
    pickIcon.src = app.icon || FALLBACK_ICON;
    pickName.textContent = app.name;
    pickSub.textContent = `${app.ios.length} iOS · ${app.android.length} Android`;

    fillSelect(iosSelect, app.ios, iosHint, 'Chưa có bản iOS');
    fillSelect(androidSelect, app.android, androidHint, 'Chưa có bản Android');
    refreshShareLink();

    listView.style.display = 'none';
    pickView.style.display = '';
    history.replaceState({ view: 'pick', name: appName }, '', `/download?name=${encodeURIComponent(appName)}`);
    document.title = `${app.name} — Tạo link tải`;
}

function renderAppList() {
    appList.classList.remove('is-loading');
    appList.innerHTML = '';
    const names = [...appsByName.keys()].sort((a, b) => a.localeCompare(b, 'vi'));
    if (!names.length) {
        listEmpty.style.display = 'block';
        return;
    }
    listEmpty.style.display = 'none';

    for (const name of names) {
        const app = appsByName.get(name);
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'dl-app-card';
        card.innerHTML = `
            <img src="${escapeHtml(app.icon || FALLBACK_ICON)}" alt="" class="dl-app-card-icon">
            <div class="dl-app-card-info">
                <h4>${escapeHtml(app.name)}</h4>
                <p>${app.ios.length} iOS · ${app.android.length} Android</p>
            </div>
            <span class="dl-app-card-arrow">›</span>
        `;
        card.addEventListener('click', () => showPick(name));
        appList.appendChild(card);
    }
}

async function loadCatalog() {
    appList.classList.add('is-loading');
    listEmpty.style.display = 'none';
    try {
        const authRes = await fetch('/api/auth-status');
        const authData = await authRes.json();
        if (!authData.authenticated) {
            window.location.href = `/?next=${encodeURIComponent('/download')}`;
            return;
        }
        const perms = authData.permissions || [];
        if (!perms.includes('create_download_link')) {
            window.location.href = '/';
            return;
        }

        const res = await fetch('/api/catalog');
        const data = await res.json();
        if (!res.ok || !data.success) {
            throw new Error(data.message || 'Không tải được danh mục.');
        }
        appsByName = groupByAppName(data.items || []);
        renderAppList();

        const params = new URLSearchParams(window.location.search);
        const name = params.get('name');
        if (name && appsByName.has(name)) showPick(name);
        else showList();
    } catch (err) {
        appList.classList.remove('is-loading');
        appList.innerHTML = '';
        listEmpty.style.display = 'block';
        listEmpty.textContent = err.message || 'Lỗi tải danh mục.';
    }
}

iosSelect.addEventListener('change', refreshShareLink);
androidSelect.addEventListener('change', refreshShareLink);
pickBack.addEventListener('click', showList);

copyShareBtn.addEventListener('click', async () => {
    const url = shareLinkInput.value;
    if (!url) return;
    try {
        await navigator.clipboard.writeText(url);
        copyShareBtn.textContent = 'Đã sao chép';
        setTimeout(() => { copyShareBtn.textContent = 'Sao chép'; }, 1500);
    } catch (_) {
        shareLinkInput.select();
        document.execCommand('copy');
    }
});

loadCatalog();
