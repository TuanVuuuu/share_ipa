const FALLBACK_ICON = 'https://cdn-icons-png.flaticon.com/512/5115/5115293.png';

const listView = document.getElementById('list-view');
const pickView = document.getElementById('pick-view');
const appList = document.getElementById('app-list');
const listEmpty = document.getElementById('list-empty');
const listSub = document.getElementById('list-sub');
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
const saveShareBtn = document.getElementById('save-share-btn');
const saveShareHint = document.getElementById('save-share-hint');
const savedSharesEl = document.getElementById('saved-shares');
const savedEmpty = document.getElementById('saved-empty');

const adminForm = document.getElementById('admin-product-form');
const adminFormTitle = document.getElementById('admin-form-title');
const productNameInput = document.getElementById('product-name');
const productIosInput = document.getElementById('product-ios-bundle');
const productAndroidInput = document.getElementById('product-android-bundle');
const productSaveBtn = document.getElementById('product-save-btn');
const productCancelBtn = document.getElementById('product-cancel-btn');
const adminFormError = document.getElementById('admin-form-error');

let products = [];
let currentProduct = null;
let currentUser = null;
let editingProductId = null;
let latestShareUrl = '';

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

function canManageProducts() {
    return !!(currentUser && currentUser.permissions && currentUser.permissions.includes('manage_download_products'));
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

function setLatestShare(url) {
    latestShareUrl = url || '';
    shareLinkInput.value = latestShareUrl;
    openShareBtn.href = latestShareUrl || '#';
    openShareBtn.classList.toggle('disabled', !latestShareUrl);
    copyShareBtn.disabled = !latestShareUrl;
}

function showList() {
    listView.style.display = '';
    pickView.style.display = 'none';
    currentProduct = null;
    history.replaceState({ view: 'list' }, '', '/download');
    document.title = 'Tạo link tải — Share IPA';
}

function resetAdminForm() {
    editingProductId = null;
    adminFormTitle.textContent = 'Thêm mục download';
    productNameInput.value = '';
    productIosInput.value = '';
    productAndroidInput.value = '';
    productCancelBtn.style.display = 'none';
    adminFormError.textContent = '';
}

function startEditProduct(product) {
    editingProductId = product.id;
    adminFormTitle.textContent = 'Sửa mục download';
    productNameInput.value = product.name || '';
    productIosInput.value = product.iosBundleId || '';
    productAndroidInput.value = product.androidBundleId || '';
    productCancelBtn.style.display = '';
    adminFormError.textContent = '';
    adminForm.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function renderProductList() {
    appList.classList.remove('is-loading');
    appList.innerHTML = '';
    if (!products.length) {
        listEmpty.style.display = 'block';
        listEmpty.textContent = canManageProducts()
            ? 'Chưa có mục download. Hãy tạo mục mới ở trên.'
            : 'Chưa có mục download. Liên hệ admin để được thêm.';
        return;
    }
    listEmpty.style.display = 'none';

    for (const product of products) {
        const card = document.createElement('div');
        card.className = 'dl-app-card-wrap';
        const mainBtn = document.createElement('button');
        mainBtn.type = 'button';
        mainBtn.className = 'dl-app-card';
        mainBtn.innerHTML = `
            <div class="dl-app-card-icon dl-app-card-icon-text">${escapeHtml((product.name || '?').slice(0, 1).toUpperCase())}</div>
            <div class="dl-app-card-info">
                <h4>${escapeHtml(product.name)}</h4>
                <p>${product.iosBundleId ? 'iOS' : '—'}${product.androidBundleId ? ' · Android' : ''}</p>
            </div>
            <span class="dl-app-card-arrow">›</span>
        `;
        mainBtn.addEventListener('click', () => showPick(product.id));
        card.appendChild(mainBtn);

        if (canManageProducts()) {
            const actions = document.createElement('div');
            actions.className = 'dl-product-actions';
            const editBtn = document.createElement('button');
            editBtn.type = 'button';
            editBtn.className = 'btn secondary';
            editBtn.textContent = 'Sửa';
            editBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                startEditProduct(product);
            });
            const delBtn = document.createElement('button');
            delBtn.type = 'button';
            delBtn.className = 'btn secondary';
            delBtn.textContent = 'Xóa';
            delBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                if (!confirm(`Xóa mục "${product.name}"? Các link đã lưu của mục này cũng sẽ bị xóa.`)) return;
                try {
                    const res = await fetch('/api/download-products/delete', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ id: product.id }),
                    });
                    const data = await res.json();
                    if (!res.ok || !data.success) throw new Error(data.message || 'Xóa thất bại.');
                    products = products.filter(p => p.id !== product.id);
                    renderProductList();
                } catch (err) {
                    alert(err.message);
                }
            });
            actions.appendChild(editBtn);
            actions.appendChild(delBtn);
            card.appendChild(actions);
        }

        appList.appendChild(card);
    }
}

async function loadSavedShares(productId) {
    savedSharesEl.innerHTML = '';
    savedEmpty.style.display = 'none';
    try {
        const res = await fetch(`/api/download-shares?productId=${encodeURIComponent(productId)}`);
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.message || 'Không tải được link đã lưu.');
        const items = data.items || [];
        if (!items.length) {
            savedEmpty.style.display = 'block';
            return;
        }
        for (const share of items) {
            const row = document.createElement('div');
            row.className = 'dl-saved-row';
            const iosLabel = share.iosVersion
                ? `iOS v${share.iosVersion}${share.iosBuildNumber != null ? ` (${share.iosBuildNumber})` : ''}`
                : 'iOS —';
            const andLabel = share.androidVersion
                ? `Android v${share.androidVersion}${share.androidBuildNumber != null ? ` (${share.androidBuildNumber})` : ''}`
                : 'Android —';
            row.innerHTML = `
                <div class="dl-saved-info">
                    <strong>${escapeHtml(iosLabel)} · ${escapeHtml(andLabel)}</strong>
                    <p>${escapeHtml(share.createdBy || '')} · ${escapeHtml(formatDateTime(share.createdAt))}</p>
                    <input type="text" readonly value="${escapeHtml(share.shareUrl)}" class="dl-saved-url">
                </div>
                <div class="dl-saved-actions">
                    <button type="button" class="btn secondary" data-copy>Sao chép</button>
                    <a class="btn secondary" href="${escapeHtml(share.shareUrl)}" target="_blank" rel="noopener">Mở</a>
                    <button type="button" class="btn secondary" data-delete>Xóa</button>
                </div>
            `;
            row.querySelector('[data-copy]').addEventListener('click', async () => {
                try {
                    await navigator.clipboard.writeText(share.shareUrl);
                } catch (_) {
                    row.querySelector('.dl-saved-url').select();
                    document.execCommand('copy');
                }
            });
            row.querySelector('[data-delete]').addEventListener('click', async () => {
                if (!confirm('Xóa link đã lưu này?')) return;
                try {
                    const delRes = await fetch('/api/download-shares/delete', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ id: share.id }),
                    });
                    const delData = await delRes.json();
                    if (!delRes.ok || !delData.success) throw new Error(delData.message || 'Xóa thất bại.');
                    await loadSavedShares(productId);
                } catch (err) {
                    alert(err.message);
                }
            });
            savedSharesEl.appendChild(row);
        }
    } catch (err) {
        savedEmpty.style.display = 'block';
        savedEmpty.textContent = err.message;
    }
}

async function showPick(productId) {
    try {
        const res = await fetch(`/api/download-products/${encodeURIComponent(productId)}/builds`);
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.message || 'Không tải được mục download.');

        currentProduct = data.product;
        pickIcon.src = data.icon || FALLBACK_ICON;
        pickName.textContent = currentProduct.name;
        pickSub.textContent = [
            currentProduct.iosBundleId || null,
            currentProduct.androidBundleId || null,
        ].filter(Boolean).join(' · ');

        fillSelect(iosSelect, data.ios || [], iosHint, currentProduct.iosBundleId ? 'Chưa có bản iOS trong catalog' : 'Chưa cấu hình bundle iOS');
        fillSelect(androidSelect, data.android || [], androidHint, currentProduct.androidBundleId ? 'Chưa có bản Android trong catalog' : 'Chưa cấu hình package Android');
        setLatestShare('');
        saveShareHint.textContent = '';

        listView.style.display = 'none';
        pickView.style.display = '';
        history.replaceState({ view: 'pick', id: productId }, '', `/download?id=${encodeURIComponent(productId)}`);
        document.title = `${currentProduct.name} — Tạo link tải`;

        await loadSavedShares(productId);
    } catch (err) {
        alert(err.message);
        showList();
    }
}

async function saveProduct() {
    adminFormError.textContent = '';
    const payload = {
        name: productNameInput.value.trim(),
        iosBundleId: productIosInput.value.trim(),
        androidBundleId: productAndroidInput.value.trim(),
    };
    if (!payload.name) {
        adminFormError.textContent = 'Nhập tên mục download.';
        return;
    }
    if (!payload.iosBundleId && !payload.androidBundleId) {
        adminFormError.textContent = 'Nhập ít nhất một bundle iOS hoặc Android.';
        return;
    }

    productSaveBtn.disabled = true;
    try {
        const isEdit = !!editingProductId;
        const res = await fetch(isEdit ? '/api/download-products/update' : '/api/download-products', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(isEdit ? { id: editingProductId, ...payload } : payload),
        });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.message || 'Lưu thất bại.');
        if (isEdit) {
            products = products.map(p => p.id === data.item.id ? data.item : p);
        } else {
            products.unshift(data.item);
        }
        products.sort((a, b) => String(a.name).localeCompare(String(b.name), 'vi'));
        resetAdminForm();
        renderProductList();
    } catch (err) {
        adminFormError.textContent = err.message;
    } finally {
        productSaveBtn.disabled = false;
    }
}

async function saveShare() {
    if (!currentProduct) return;
    saveShareHint.textContent = '';
    saveShareBtn.disabled = true;
    try {
        const res = await fetch('/api/download-shares', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                productId: currentProduct.id,
                iosBuildId: iosSelect.value || null,
                androidBuildId: androidSelect.value || null,
            }),
        });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.message || 'Lưu link thất bại.');
        setLatestShare(data.item.shareUrl);
        saveShareHint.textContent = 'Đã lưu link. Có thể sao chép và gửi đối tác.';
        await loadSavedShares(currentProduct.id);
    } catch (err) {
        saveShareHint.textContent = err.message;
    } finally {
        saveShareBtn.disabled = false;
    }
}

async function init() {
    appList.classList.add('is-loading');
    try {
        const authRes = await fetch('/api/auth-status');
        const authData = await authRes.json();
        if (!authData.authenticated) {
            window.location.href = `/?next=${encodeURIComponent('/download')}`;
            return;
        }
        currentUser = {
            username: authData.username,
            role: authData.role,
            permissions: authData.permissions || [],
        };
        if (!currentUser.permissions.includes('create_download_link')) {
            window.location.href = '/';
            return;
        }

        if (canManageProducts()) {
            adminForm.style.display = '';
            listSub.textContent = 'Admin tạo mục (tên + bundle). Tester chọn mục, gắn bản build và lưu link gửi đối tác.';
        }

        const res = await fetch('/api/download-products');
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.message || 'Không tải được mục download.');
        products = data.items || [];
        renderProductList();

        const params = new URLSearchParams(window.location.search);
        const id = params.get('id');
        if (id && products.some(p => p.id === id)) await showPick(id);
        else showList();
    } catch (err) {
        appList.classList.remove('is-loading');
        listEmpty.style.display = 'block';
        listEmpty.textContent = err.message || 'Lỗi tải dữ liệu.';
    }
}

pickBack.addEventListener('click', showList);
productSaveBtn.addEventListener('click', saveProduct);
productCancelBtn.addEventListener('click', resetAdminForm);
saveShareBtn.addEventListener('click', saveShare);

copyShareBtn.addEventListener('click', async () => {
    if (!latestShareUrl) return;
    try {
        await navigator.clipboard.writeText(latestShareUrl);
        copyShareBtn.textContent = 'Đã sao chép';
        setTimeout(() => { copyShareBtn.textContent = 'Sao chép'; }, 1500);
    } catch (_) {
        shareLinkInput.select();
        document.execCommand('copy');
    }
});

init();
