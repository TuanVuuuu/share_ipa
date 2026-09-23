(function () {
    const PRIMARY = '#FD5C00';
    const HEADER_BG = '#1a1a1e';
    const CARD_BG = '#ffffff';
    const TEXT = '#1d1d1f';
    const MUTED = '#86868b';
    const SUBTEXT = '#4c4c52';
    const WIDTH = 440;

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function safeFilename(name) {
        return String(name || 'share')
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/[^\w.-]+/g, '_')
            .replace(/^_+|_+$/g, '')
            .slice(0, 60) || 'share';
    }

    function loadImage(src) {
        return new Promise((resolve, reject) => {
            if (!src) {
                reject(new Error('Thiếu ảnh.'));
                return;
            }
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error('Không tải được ảnh.'));
            img.src = src;
        });
    }

    function roundRect(ctx, x, y, w, h, r) {
        const radius = Math.min(r, w / 2, h / 2);
        ctx.beginPath();
        ctx.moveTo(x + radius, y);
        ctx.arcTo(x + w, y, x + w, y + h, radius);
        ctx.arcTo(x + w, y + h, x, y + h, radius);
        ctx.arcTo(x, y + h, x, y, radius);
        ctx.arcTo(x, y, x + w, y, radius);
        ctx.closePath();
    }

    function makeQr(text) {
        if (!text || typeof qrcode !== 'function') return null;
        for (const level of ['H', 'M', 'L']) {
            try {
                const qr = qrcode(0, level);
                qr.addData(text);
                qr.make();
                return qr;
            } catch (_) { /* nội dung dài hơn mức ECC hiện tại */ }
        }
        return null;
    }

    function createQrCanvas(text, size) {
        const qr = makeQr(text);
        if (!qr) return null;
        const moduleCount = qr.getModuleCount();
        const cell = Math.floor(size / moduleCount);
        const qrSize = cell * moduleCount;
        const canvas = document.createElement('canvas');
        canvas.width = qrSize;
        canvas.height = qrSize;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, qrSize, qrSize);
        ctx.fillStyle = '#000000';
        for (let row = 0; row < moduleCount; row++) {
            for (let col = 0; col < moduleCount; col++) {
                if (qr.isDark(row, col)) {
                    ctx.fillRect(col * cell, row * cell, cell, cell);
                }
            }
        }
        return canvas;
    }

    function drawTab(ctx, label, x, y, active) {
        ctx.font = '700 18px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        ctx.fillStyle = active ? PRIMARY : 'rgba(255,255,255,0.55)';
        ctx.fillText(label, x, y);
        if (active) {
            const w = ctx.measureText(label).width;
            ctx.fillStyle = PRIMARY;
            ctx.fillRect(x - w / 2, y + 6, w, 3);
        }
    }

    function drawBadge(ctx, text, x, y, platform) {
        ctx.font = '600 11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        const padX = 9;
        const w = ctx.measureText(text).width + padX * 2;
        const h = 20;
        roundRect(ctx, x, y - 14, w, h, 10);
        ctx.fillStyle = platform === 'android' ? '#e8f5e9' : '#e8f4fd';
        ctx.fill();
        ctx.fillStyle = platform === 'android' ? '#2e7d32' : '#1a73e8';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, x + padX, y - 4);
        return w;
    }

    async function renderShareCard(options) {
        const {
            productName,
            iconUrl,
            bannerUrl,
            platform,
            hasIos,
            hasAndroid,
            version,
            buildNumber,
            qrUrl,
            scanLabel,
            installLabel,
            versionLabel,
            showHowto,
            footerHint,
            note,
        } = options;

        const headerH = 280;
        const cardTop = headerH - 36;
        const cardPadX = 22;
        const cardW = WIDTH - 32;
        const cardX = 16;
        const iosHowto = showHowto != null ? !!showHowto : platform === 'ios';
        const cardH = (iosHowto ? 430 : 390) + (note ? 40 : 0);
        const height = cardTop + cardH + 32;

        const canvas = document.createElement('canvas');
        canvas.width = WIDTH;
        canvas.height = height;
        const ctx = canvas.getContext('2d');

        ctx.fillStyle = '#f5f5f7';
        ctx.fillRect(0, 0, WIDTH, height);

        ctx.fillStyle = HEADER_BG;
        ctx.fillRect(0, 0, WIDTH, headerH);

        if (bannerUrl) {
            try {
                const banner = await loadImage(bannerUrl);
                const scale = Math.max(WIDTH / banner.width, headerH / banner.height);
                const bw = banner.width * scale;
                const bh = banner.height * scale;
                ctx.drawImage(banner, (WIDTH - bw) / 2, (headerH - bh) / 2, bw, bh);
                const grad = ctx.createLinearGradient(0, 0, 0, headerH);
                grad.addColorStop(0, 'rgba(0,0,0,0.25)');
                grad.addColorStop(1, 'rgba(0,0,0,0.62)');
                ctx.fillStyle = grad;
                ctx.fillRect(0, 0, WIDTH, headerH);
            } catch (_) {
                /* giữ nền header mặc định */
            }
        }

        let iconImg = null;
        if (iconUrl) {
            try {
                iconImg = await loadImage(iconUrl);
            } catch (_) {
                iconImg = null;
            }
        }

        const centerX = WIDTH / 2;
        let cursorY = 72;

        if (iconImg) {
            const iconSize = 72;
            const iconX = centerX - iconSize / 2;
            roundRect(ctx, iconX, cursorY, iconSize, iconSize, 18);
            ctx.save();
            ctx.clip();
            ctx.drawImage(iconImg, iconX, cursorY, iconSize, iconSize);
            ctx.restore();
            ctx.strokeStyle = 'rgba(255,255,255,0.35)';
            ctx.lineWidth = 2;
            roundRect(ctx, iconX, cursorY, iconSize, iconSize, 18);
            ctx.stroke();
            cursorY += iconSize + 14;
        }

        ctx.font = '700 22px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.shadowColor = 'rgba(0,0,0,0.35)';
        ctx.shadowBlur = 8;
        ctx.shadowOffsetY = 1;
        const title = (productName || 'Tải ứng dụng').slice(0, 48);
        ctx.fillText(title, centerX, cursorY);
        ctx.shadowColor = 'transparent';
        cursorY += 36;

        if (hasIos && hasAndroid) {
            drawTab(ctx, 'IOS', centerX - 56, cursorY + 18, platform === 'ios');
            drawTab(ctx, 'ANDROID', centerX + 56, cursorY + 18, platform === 'android');
        } else if (hasIos) {
            drawTab(ctx, 'IOS', centerX, cursorY + 18, true);
        } else {
            drawTab(ctx, 'ANDROID', centerX, cursorY + 18, true);
        }

        roundRect(ctx, cardX, cardTop, cardW, cardH, 20);
        ctx.fillStyle = CARD_BG;
        ctx.shadowColor = 'rgba(0,0,0,0.12)';
        ctx.shadowBlur = 32;
        ctx.shadowOffsetY = 8;
        ctx.fill();
        ctx.shadowColor = 'transparent';

        let y = cardTop + 28;
        ctx.font = '600 17px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        ctx.fillStyle = PRIMARY;
        ctx.textAlign = 'center';
        ctx.fillText(scanLabel || 'Quét để tải', centerX, y);
        y += 30;

        const qrSize = 220;
        const qrX = centerX - qrSize / 2;
        const qrCanvas = createQrCanvas(qrUrl, qrSize);
        if (qrCanvas) {
            ctx.drawImage(qrCanvas, qrX, y, qrSize, qrSize);
            if (iconImg) {
                const logoSize = 46;
                const logoX = centerX - logoSize / 2;
                const logoY = y + (qrSize - logoSize) / 2;
                ctx.fillStyle = '#ffffff';
                roundRect(ctx, logoX - 4, logoY - 4, logoSize + 8, logoSize + 8, 12);
                ctx.fill();
                roundRect(ctx, logoX, logoY, logoSize, logoSize, 12);
                ctx.save();
                ctx.clip();
                ctx.drawImage(iconImg, logoX, logoY, logoSize, logoSize);
                ctx.restore();
            }
        }
        y += qrSize + 16;

        const ver = version || '?';
        const bn = buildNumber != null ? ` (${buildNumber})` : '';
        ctx.font = '600 16px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        ctx.fillStyle = TEXT;
        const versionText = versionLabel || `Version ${ver}${bn}`;
        const versionW = ctx.measureText(versionText).width;
        const badgeText = platform;
        ctx.font = '600 11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        const badgeW = ctx.measureText(badgeText).width + 18;
        const rowW = versionW + 10 + badgeW;
        const rowStart = centerX - rowW / 2;
        ctx.font = '600 16px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(versionText, rowStart, y);
        drawBadge(ctx, badgeText, rowStart + versionW + 10, y, platform);
        y += 28;

        const btnW = 280;
        const btnH = 36;
        const btnX = centerX - btnW / 2;
        roundRect(ctx, btnX, y, btnW, btnH, 10);
        ctx.fillStyle = PRIMARY;
        ctx.fill();
        ctx.font = '600 16px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(installLabel || 'Cài đặt ngay', centerX, y + btnH / 2);
        y += btnH + 16;

        if (iosHowto) {
            ctx.strokeStyle = '#ececef';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(cardX + cardPadX, y);
            ctx.lineTo(cardX + cardW - cardPadX, y);
            ctx.stroke();
            y += 14;
            ctx.font = '600 14px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
            ctx.fillStyle = PRIMARY;
            ctx.textAlign = 'left';
            ctx.fillText('Cách cài đặt iOS', cardX + cardPadX, y);
            y += 20;
            ctx.font = '13px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
            ctx.fillStyle = SUBTEXT;
            ctx.fillText('Settings → General → VPN & Device Management →', cardX + cardPadX, y);
            y += 18;
            ctx.fillText('Trust chứng chỉ nhà phát triển.', cardX + cardPadX, y);
            y += 22;
        }

        ctx.font = '13px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        ctx.fillStyle = MUTED;
        ctx.textAlign = 'center';
        const hint = footerHint || (platform === 'android'
            ? 'Mở trang này trên thiết bị Android, hoặc quét QR bằng điện thoại.'
            : 'Mở trang này trên iPhone/iPad, hoặc quét QR bằng Camera.');
        wrapText(ctx, hint, centerX, y, cardW - cardPadX * 2, 18);

        return canvas.toDataURL('image/png');
    }

    function wrapText(ctx, text, centerX, y, maxWidth, lineHeight) {
        const words = text.split(' ');
        let line = '';
        const lines = [];
        for (const word of words) {
            const test = line ? `${line} ${word}` : word;
            if (ctx.measureText(test).width > maxWidth && line) {
                lines.push(line);
                line = word;
            } else {
                line = test;
            }
        }
        if (line) lines.push(line);
        ctx.textAlign = 'center';
        for (const ln of lines) {
            ctx.fillText(ln, centerX, y);
            y += lineHeight;
        }
    }

    function triggerDownload(dataUrl, filename) {
        const a = document.createElement('a');
        a.href = dataUrl;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
    }

    async function fetchBuildInfo(buildId) {
        if (!buildId) return null;
        const res = await fetch(`/api/app-info?id=${encodeURIComponent(buildId)}`);
        const data = await res.json();
        if (!res.ok || !data.success) return null;
        return data.item;
    }

    function shareCardJob(platform, share, build) {
        const customTarget = platform === 'android' ? share.androidCustomTarget : share.iosCustomTarget;
        if (customTarget) {
            const note = String((platform === 'android' ? share.androidNote : share.iosNote) || '').replace(/\s+/g, ' ').trim();
            const canOpen = /^https?:\/\//i.test(customTarget);
            return {
                platform,
                version: null,
                buildNumber: null,
                qrUrl: customTarget,
                scanLabel: 'Quét mã QR',
                installLabel: canOpen ? 'Truy cập ngay' : 'Quét mã QR',
                versionLabel: 'QR',
                showHowto: false,
                note,
                footerHint: note || 'Quét mã QR bằng camera của thiết bị.',
            };
        }
        return {
            platform,
            version: build?.version || (platform === 'android' ? share.androidVersion : share.iosVersion),
            buildNumber: build?.buildNumber ?? (platform === 'android' ? share.androidBuildNumber : share.iosBuildNumber),
            qrUrl: build?.shareUrl || share.shareUrl,
            showHowto: platform === 'ios',
        };
    }

    async function downloadShareCardImages(share) {
        if (!share) throw new Error('Thiếu thông tin link.');

        const [iosBuild, androidBuild] = await Promise.all([
            fetchBuildInfo(share.iosBuildId),
            fetchBuildInfo(share.androidBuildId),
        ]);

        const productName = share.productName || iosBuild?.appName || androidBuild?.appName || 'App';
        const iconUrl = share.productIcon || iosBuild?.icon || androidBuild?.icon || '';
        const bannerUrl = share.productBanner || '';
        const hasIos = !!(share.iosBuildId || share.iosCustomTarget || iosBuild);
        const hasAndroid = !!(share.androidBuildId || share.androidCustomTarget || androidBuild);

        const jobs = [];
        if (hasIos) jobs.push(shareCardJob('ios', share, iosBuild));
        if (hasAndroid) jobs.push(shareCardJob('android', share, androidBuild));
        if (!jobs.length) throw new Error('Link này chưa có bản iOS hoặc Android.');

        for (let i = 0; i < jobs.length; i++) {
            const job = jobs[i];
            const dataUrl = await renderShareCard({
                productName,
                iconUrl,
                bannerUrl,
                platform: job.platform,
                hasIos,
                hasAndroid,
                version: job.version,
                buildNumber: job.buildNumber,
                qrUrl: job.qrUrl,
                scanLabel: job.scanLabel,
                installLabel: job.installLabel,
                versionLabel: job.versionLabel,
                showHowto: job.showHowto,
                footerHint: job.footerHint,
                note: job.note,
            });
            const ver = job.version || (job.versionLabel ? 'link' : 'x');
            const bn = job.buildNumber != null ? `-${job.buildNumber}` : '';
            triggerDownload(
                dataUrl,
                `${safeFilename(productName)}-${job.platform}-v${ver}${bn}.png`
            );
            if (i < jobs.length - 1) await sleep(350);
        }
    }

    window.ShareCardImage = { downloadShareCardImages };
})();
