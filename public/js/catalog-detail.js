(function (global) {
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

    function createDetailView(refs) {
        const {
            appDetailZone,
            detailPageSub,
            detailHeader,
            detailIcon,
            detailName,
            detailBundle,
            detailBuilds,
            detailEmpty,
            detailAuth,
            detailShareBtn,
            qrModal,
            qrModalClose,
            qrModalTitle,
            qrModalVersion,
            qrModalImage,
            qrModalUrl,
            qrModalCopy,
            qrModalInstall
        } = refs;

        function buildBuildMetaTags(item) {
            const tags = [];
            if (item.minimumOsVersion) {
                tags.push(`<span class="build-tag build-tag-ios">iOS ${escapeHtml(item.minimumOsVersion)}+</span>`);
            }
            if (item.profileType) {
                tags.push(`<span class="build-tag build-tag-profile">${escapeHtml(item.profileType)}</span>`);
            }
            if (item.provisionedDevicesCount != null) {
                tags.push(`<span class="build-tag build-tag-devices">${item.provisionedDevicesCount} thiết bị</span>`);
            }
            return tags.join('');
        }

        function openQrModal(item) {
            qrModalTitle.innerText = item.appName || 'Ứng dụng';
            qrModalVersion.innerText = `${item.bundleId || ''} • v${item.version} (Build ${item.buildNumber})`;
            qrModalUrl.value = item.shareUrl || '';
            qrModalInstall.href = item.downloadUrl || '#';

            // Cập nhật thẻ thông tin bổ sung trong modal
            const existingMeta = qrModal.querySelector('.qr-modal-meta');
            if (existingMeta) existingMeta.remove();
            const metaTags = buildBuildMetaTags(item);
            if (metaTags) {
                const metaEl = document.createElement('div');
                metaEl.className = 'qr-modal-meta';
                metaEl.innerHTML = metaTags;
                qrModalVersion.insertAdjacentElement('afterend', metaEl);
            }

            qrModalImage.innerHTML = '';
            const img = document.createElement('img');
            if (item.qr) {
                img.src = item.qr;
            } else if (item.shareUrl && typeof qrcode === 'function') {
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

        if (qrModalClose) {
            qrModalClose.addEventListener('click', closeQrModal);
            qrModal.addEventListener('click', (e) => { if (e.target === qrModal) closeQrModal(); });
            document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeQrModal(); });
            qrModalCopy.addEventListener('click', async () => {
                await copyText(qrModalUrl.value, qrModalCopy);
            });
        }

        if (detailShareBtn) {
            detailShareBtn.addEventListener('click', () => copyText(window.location.href, detailShareBtn));
        }

        function stopLoading() {
            appDetailZone.classList.remove('is-loading');
        }

        function resetView() {
            appDetailZone.classList.add('is-loading');
            detailPageSub.style.display = '';
            detailPageSub.innerText = 'Đang tải...';
            detailHeader.style.display = 'none';
            detailBuilds.innerHTML = '';
            detailEmpty.style.display = 'none';
            if (detailAuth) detailAuth.style.display = 'none';
            if (detailShareBtn) detailShareBtn.style.display = 'none';
        }

        function renderBuilds(builds) {
            detailBuilds.innerHTML = '';
            builds.forEach((build, index) => {
                const metaTags = buildBuildMetaTags(build);
                const row = document.createElement('div');
                row.className = 'build-row';
                row.innerHTML = `
                    <div class="build-info">
                        <span class="badge">v${escapeHtml(build.version)} (Build ${escapeHtml(build.buildNumber)})</span>
                        ${index === 0 ? '<span class="build-latest">Mới nhất</span>' : ''}
                        <div class="build-sub">📦 ${escapeHtml(build.fileSize || '--')} • 🕒 ${escapeHtml(formatDateTime(build.uploadedAt))}</div>
                        ${metaTags ? `<div class="build-tags">${metaTags}</div>` : ''}
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

            if (detailShareBtn) detailShareBtn.style.display = 'inline-block';
            detailHeader.style.display = 'flex';
            renderBuilds(builds);
        }

        function showAuthRequired() {
            stopLoading();
            detailPageSub.style.display = 'none';
            if (detailAuth) detailAuth.style.display = 'block';
        }

        function showEmpty(message) {
            stopLoading();
            detailPageSub.innerText = message;
            detailEmpty.style.display = 'block';
        }

        return {
            resetView,
            renderAppDetail,
            showAuthRequired,
            showEmpty,
            stopLoading
        };
    }

    global.CatalogDetail = {
        FALLBACK_ICON,
        escapeHtml,
        formatDateTime,
        createDetailView
    };
})(window);
