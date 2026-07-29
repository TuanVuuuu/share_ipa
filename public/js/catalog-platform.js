(function () {
    const zone = document.getElementById('catalog-platform-zone');
    const titleEl = document.getElementById('platform-title');
    const subEl = document.getElementById('platform-sub');
    const listEl = document.getElementById('platform-list');
    const emptyEl = document.getElementById('platform-empty');

    function parsePlatform() {
        const match = window.location.pathname.match(/^\/(ios|android)\/?$/);
        return match ? match[1] : 'ios';
    }

    function setLoading(loading) {
        if (!zone) return;
        zone.classList.toggle('is-loading', !!loading);
        if (loading && emptyEl) emptyEl.style.display = 'none';
    }

    async function init() {
        const platform = parsePlatform();
        const platformLabel = platform === 'android' ? 'Android' : 'iOS';
        const listPath = CatalogDetail.buildPlatformListPath(platform);

        if (titleEl) titleEl.textContent = `Ứng dụng ${platformLabel}`;
        document.title = `Ứng dụng ${platformLabel} — Share IPA`;
        setLoading(true);

        try {
            const authRes = await fetch('/api/auth-status');
            const authData = await authRes.json();
            if (!authData.authenticated) {
                window.location.href = `/?next=${encodeURIComponent(listPath)}`;
                return;
            }
            const permissions = authData.permissions || [];
            if (!permissions.includes('view_catalog')) {
                window.location.href = '/';
                return;
            }

            const res = await fetch(`/api/catalog/${platform}`);
            if (!res.ok) throw new Error('Không tải được danh mục.');
            const data = await res.json();
            const items = Array.isArray(data.items) ? data.items : [];
            const groups = CatalogDetail.groupByBundle(items);

            setLoading(false);
            listEl.innerHTML = '';

            if (!groups.length) {
                if (subEl) subEl.textContent = `Chưa có ứng dụng ${platformLabel} trong danh mục.`;
                emptyEl.style.display = 'block';
                emptyEl.textContent = `Chưa có ứng dụng ${platformLabel}.`;
                return;
            }

            if (subEl) {
                subEl.textContent = data.configured === false
                    ? '⚠️ Chưa cấu hình GITHUB_TOKEN/GITHUB_REPO trong .env nên danh mục trống.'
                    : `${groups.length} ứng dụng ${platformLabel}.`;
            }

            groups.forEach((group) => {
                listEl.appendChild(CatalogDetail.createAppFolderCard(group));
            });
        } catch (err) {
            setLoading(false);
            if (subEl) subEl.textContent = err.message || 'Lỗi tải danh mục.';
            emptyEl.style.display = 'block';
            emptyEl.textContent = err.message || 'Lỗi tải danh mục.';
        }
    }

    init();
})();
