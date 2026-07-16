const path = require('path');

require('dotenv').config({
    path: path.join(__dirname, '.env')
});

const express = require('express');
const multer = require('multer');
const fs = require('fs');
const AppInfoParser = require('app-info-parser');
const QRCode = require('qrcode');
const github = require('./github');
const auth = require('./auth');

const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'https://share-ipa.vunt.info';
const CATALOG_PATH = 'catalog.json';       // Chỉ mục danh sách app trên repo lưu trữ
const CATALOG_MAX_ITEMS = 200;             // Giới hạn số bản ghi giữ lại trong danh mục

// 👉 CHỖ DUY NHẤT cần đổi mỗi khi cập nhật giao diện (CSS/JS) để phá cache trình duyệt/CDN.
// Đổi giá trị này (ví dụ tăng lên '3', '4'...) rồi deploy là đủ.
const ASSET_VERSION = process.env.ASSET_VERSION || '11';

// ─── Cloudflare R2 ──────────────────────────────────────────────────────────
// File IPA upload thẳng từ browser lên R2 (không qua Tunnel) → tốc độ CDN edge.
// Nếu biến môi trường chưa set, hệ thống tự động fallback về luồng chunk cũ.
let r2Client = null;
let _R2Cmd = {};
let r2GetSignedUrl = null;

function isR2Configured() {
    return !!(
        process.env.R2_ACCOUNT_ID &&
        process.env.R2_ACCESS_KEY_ID &&
        process.env.R2_SECRET_ACCESS_KEY &&
        process.env.R2_BUCKET &&
        process.env.R2_PUBLIC_URL
    );
}

if (isR2Configured()) {
    try {
        const { S3Client, CreateMultipartUploadCommand, UploadPartCommand,
                CompleteMultipartUploadCommand, AbortMultipartUploadCommand,
                DeleteObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
        const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

        r2Client = new S3Client({
            region: 'auto',
            endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
            credentials: {
                accessKeyId: process.env.R2_ACCESS_KEY_ID,
                secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
            },
        });

        _R2Cmd = {
            CreateMultipartUploadCommand, UploadPartCommand,
            CompleteMultipartUploadCommand, AbortMultipartUploadCommand,
            DeleteObjectCommand, GetObjectCommand,
        };
        r2GetSignedUrl = getSignedUrl;
        console.log('[R2] ✅ Client đã khởi tạo. Bucket:', process.env.R2_BUCKET);
    } catch (err) {
        console.error('[R2] ❌ Không thể khởi tạo client:', err.message);
        r2Client = null;
    }
} else {
    console.log('[R2] ⚠️  Chưa cấu hình — sẽ dùng luồng chunk upload cũ.');
}

// Xóa một object khỏi R2. Dùng khi dọn dẹp bản build cũ để giữ dưới 10GB.
async function deleteR2Object(key) {
    if (!r2Client || !key) return;
    try {
        await r2Client.send(new _R2Cmd.DeleteObjectCommand({
            Bucket: process.env.R2_BUCKET,
            Key: key,
        }));
        console.log('[R2] 🗑️  Deleted:', key);
    } catch (err) {
        console.error('[R2] ❌ Delete failed:', key, err.message);
    }
}

// Helper: stream R2 GetObject body xuống file local (dùng khi finalize cần parse IPA)
function streamToFile(readable, filePath) {
    return new Promise((resolve, reject) => {
        const ws = fs.createWriteStream(filePath);
        readable.pipe(ws);
        readable.on('error', reject);
        ws.on('finish', resolve);
        ws.on('error', reject);
    });
}
// ─────────────────────────────────────────────────────────────────────────────

console.log('========== ENV ==========');
console.log('__dirname:', __dirname);
console.log('cwd:', process.cwd());

console.log('GITHUB_REPO:', process.env.GITHUB_REPO);
console.log('GITHUB_TOKEN:', process.env.GITHUB_TOKEN ? '***(đã cấu hình)' : '(chưa cấu hình)');

console.log('=========================');

const app = express();
const PORT = 3000;
const AUTH_COOKIE_NAME = 'share_ipa_auth';

const UPLOADS_MAIN_DIR = '/Users/sds/dev/share_ipa/uploads';
const ARCHIVE_STORAGE_DIR = '/Users/sds/dev/share_ipa/storage';
const CHUNKS_DIR = path.join(UPLOADS_MAIN_DIR, 'chunks');

if (!fs.existsSync(UPLOADS_MAIN_DIR)) fs.mkdirSync(UPLOADS_MAIN_DIR, { recursive: true });
if (!fs.existsSync(ARCHIVE_STORAGE_DIR)) fs.mkdirSync(ARCHIVE_STORAGE_DIR, { recursive: true });
if (!fs.existsSync(CHUNKS_DIR)) fs.mkdirSync(CHUNKS_DIR, { recursive: true });

// Tối ưu bộ nhớ: Lưu thẳng file vào đĩa thay vì ngậm trên RAM để tránh crash khi nhiều người upload cùng lúc
const storage = multer.diskStorage({
    destination: (req, file, cb) => { cb(null, UPLOADS_MAIN_DIR); },
    filename: (req, file, cb) => { cb(null, `app_${Date.now()}_${file.originalname}`); }
});
const upload = multer({ storage: storage, limits: { fileSize: 500 * 1024 * 1024 } }); // Hạn mức 500MB
const chunkUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

function parseCookies(cookieHeader = '') {
    return cookieHeader.split(';').reduce((acc, part) => {
        const [rawKey, ...rawValue] = part.trim().split('=');
        if (!rawKey) return acc;
        acc[decodeURIComponent(rawKey)] = decodeURIComponent(rawValue.join('='));
        return acc;
    }, {});
}

// Lấy tài khoản đang đăng nhập từ cookie phiên đã ký (HMAC) — trả về null nếu chưa đăng nhập/cookie không hợp lệ.
function getSessionUser(req) {
    const cookies = parseCookies(req.headers.cookie || '');
    return auth.verifySessionToken(cookies[AUTH_COOKIE_NAME]);
}

function isAuthenticated(req) {
    return !!getSessionUser(req);
}

function requireAuth(req, res, next) {
    if (isAuthenticated(req)) return next();
    return res.status(401).json({ success: false, message: 'Vui lòng đăng nhập trước khi sử dụng.' });
}

// Middleware chặn theo quyền cụ thể (ví dụ: 'delete_build') — dùng cho các API nhạy cảm hơn requireAuth thường.
function requirePermission(permission) {
    return (req, res, next) => {
        const user = getSessionUser(req);
        if (!user) {
            return res.status(401).json({ success: false, message: 'Vui lòng đăng nhập trước khi sử dụng.' });
        }
        if (!auth.hasPermission(user, permission)) {
            return res.status(403).json({ success: false, message: 'Tài khoản của bạn không có quyền thực hiện hành động này.' });
        }
        req.currentUser = user;
        next();
    };
}

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Tạo block Open Graph + Twitter Card meta tags để Discord/Slack unfurl link đẹp
function buildOgMeta({ title, description, image, url } = {}) {
    const esc = (s = '') => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const t = esc(title || 'Share IPA');
    const d = esc(description || 'Nền tảng chia sẻ và cài đặt ứng dụng iOS/Android nội bộ dễ dàng.');
    const img = image || `${PUBLIC_BASE_URL}/ic_launcher_web.png`;
    const u = url || PUBLIC_BASE_URL;
    return [
        `<meta property="og:type" content="website">`,
        `<meta property="og:site_name" content="Share IPA">`,
        `<meta property="og:url" content="${u}">`,
        `<meta property="og:title" content="${t}">`,
        `<meta property="og:description" content="${d}">`,
        `<meta property="og:image" content="${img}">`,
        `<meta name="twitter:card" content="summary">`,
        `<meta name="twitter:title" content="${t}">`,
        `<meta name="twitter:description" content="${d}">`,
        `<meta name="twitter:image" content="${img}">`,
    ].join('\n    ');
}

// Trả về file HTML kèm chèn version cho asset (thay __V__ bằng ASSET_VERSION) để phá cache
function sendHtmlWithVersion(res, fileName) {
    const filePath = path.join(__dirname, 'public', fileName);
    fs.readFile(filePath, 'utf8', (err, html) => {
        if (err) {
            res.status(404).send('Not found');
            return;
        }
        const rendered = html.replace(/__V__/g, ASSET_VERSION);
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.send(rendered);
    });
}

// Trả về HTML với version + OG meta tags được inject động
function sendHtmlWithOg(res, fileName, ogMeta) {
    const filePath = path.join(__dirname, 'public', fileName);
    fs.readFile(filePath, 'utf8', (err, html) => {
        if (err) {
            res.status(404).send('Not found');
            return;
        }
        let rendered = html.replace(/__V__/g, ASSET_VERSION);
        if (ogMeta) {
            rendered = rendered.replace('<!-- __OG_META__ -->', ogMeta);
        } else {
            rendered = rendered.replace('<!-- __OG_META__ -->', '');
        }
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.send(rendered);
    });
}

// Các trang HTML được phục vụ động (chèn version) — đặt TRƯỚC express.static để ưu tiên
app.get('/', (req, res) => {
    const og = buildOgMeta({
        title: 'Share IPA',
        description: 'Nền tảng chia sẻ và cài đặt ứng dụng iOS/Android nội bộ. Upload file .ipa hoặc .apk và chia sẻ link cài đặt ngay lập tức.',
        url: `${PUBLIC_BASE_URL}/`,
    });
    sendHtmlWithOg(res, 'index.html', og);
});

// Trang chính và tài nguyên tĩnh mở tự do (không bắt buộc đăng nhập)
// HTML luôn tải mới, các asset (.js/.css) revalidate để tránh phục vụ bản cũ sau khi deploy
app.use(express.static('public', {
    etag: true,
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) {
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        } else {
            res.setHeader('Cache-Control', 'no-cache');
        }
    }
}));
app.use('/uploads', express.static(UPLOADS_MAIN_DIR, {
    setHeaders: (res, filePath) => {
        if (filePath.toLowerCase().endsWith('.apk')) {
            res.setHeader('Content-Type', 'application/vnd.android.package-archive');
            res.setHeader('Content-Disposition', `attachment; filename="${path.basename(filePath)}"`);
        }
    }
}));
app.use('/storage', express.static(ARCHIVE_STORAGE_DIR));

// Đường dẫn /login cũ giờ trỏ thẳng về trang chính (ô đăng nhập nằm ngay trong trang)
app.get('/login', (req, res) => res.redirect('/'));

// Trang cài đặt độc lập cho người quét QR (mở màn hình riêng, chỉ hiện 1 bản build)
app.get('/install', async (req, res) => {
    const rawPlist = (req.query.plist || req.query.id || '').toString().trim();
    let og = buildOgMeta({
        title: 'Cài đặt ứng dụng — Share IPA',
        description: 'Quét mã QR hoặc nhấn nút để cài đặt ứng dụng iOS/Android nội bộ.',
        url: rawPlist ? `${PUBLIC_BASE_URL}/install?${rawPlist.endsWith('.plist') ? 'plist' : 'id'}=${encodeURIComponent(rawPlist)}` : `${PUBLIC_BASE_URL}/install`,
    });
    if (rawPlist) {
        try {
            const targetId = rawPlist.replace(/\.plist$/i, '');
            const list = await readCatalog();
            const record = list.find(item => item.id === targetId);
            if (record) {
                const platformLabel = record.platform === 'android' ? 'Android' : 'iOS';
                const installQuery = record.platform === 'android'
                    ? `id=${encodeURIComponent(record.id)}`
                    : `plist=${encodeURIComponent(rawPlist)}`;
                og = buildOgMeta({
                    title: `${record.appName} v${record.version} — Share IPA`,
                    description: `Cài đặt ${record.appName} (${platformLabel}) phiên bản ${record.version} (build ${record.buildNumber}) · ${record.bundleId}`,
                    image: record.icon || undefined,
                    url: `${PUBLIC_BASE_URL}/install?${installQuery}`,
                });
            }
        } catch (_) { /* giữ OG mặc định nếu catalog lỗi */ }
    }
    sendHtmlWithOg(res, 'install.html', og);
});

// Trang chi tiết ứng dụng theo platform: /ios/app?bundle=... | /android/app?bundle=...
function buildAppDetailPath(platform, bundleId) {
    const p = platform === 'android' ? 'android' : 'ios';
    return bundleId
        ? `/${p}/app?bundle=${encodeURIComponent(bundleId)}`
        : `/${p}/app`;
}

async function serveAppDetailPage(req, res, platform) {
    const bundleId = (req.query.bundle || '').toString().trim();
    const platformLabel = platform === 'android' ? 'Android' : 'iOS';
    const appUrl = `${PUBLIC_BASE_URL}${buildAppDetailPath(platform, bundleId)}`;
    let og = buildOgMeta({
        title: `Chi tiết ứng dụng ${platformLabel} — Share IPA`,
        description: `Xem danh sách các bản build ${platformLabel} nội bộ.`,
        url: appUrl,
    });
    if (bundleId) {
        try {
            const list = await readCatalog();
            const builds = list
                .filter(item => (item.bundleId || item.id) === bundleId)
                .filter(item => (item.platform || 'ios') === platform)
                .sort((a, b) => (new Date(b.uploadedAt).getTime() || 0) - (new Date(a.uploadedAt).getTime() || 0));
            if (builds.length > 0) {
                const latest = builds[0];
                og = buildOgMeta({
                    title: `${latest.appName} (${platformLabel}) — Share IPA`,
                    description: `${latest.appName} · ${bundleId} · Phiên bản mới nhất: ${latest.version} (build ${latest.buildNumber}) · ${builds.length} bản build`,
                    image: latest.icon || undefined,
                    url: appUrl,
                });
            }
        } catch (_) { /* giữ OG mặc định nếu catalog lỗi */ }
    }
    sendHtmlWithOg(res, 'app-detail.html', og);
}

app.get('/ios/app', (req, res) => serveAppDetailPage(req, res, 'ios'));
app.get('/android/app', (req, res) => serveAppDetailPage(req, res, 'android'));

// Tương thích ngược: /app?bundle=...&platform=... → /ios/app hoặc /android/app
app.get('/app', (req, res) => {
    const bundleId = (req.query.bundle || '').toString().trim();
    const platform = (req.query.platform || '').toString().trim().toLowerCase() === 'android'
        ? 'android'
        : 'ios';
    res.redirect(301, buildAppDetailPath(platform, bundleId));
});

// Kiểm tra trạng thái đăng nhập cho frontend (kèm role/quyền để bật/tắt tính năng như xóa bản build)
app.get('/api/auth-status', (req, res) => {
    const user = getSessionUser(req);
    if (!user) return res.json({ authenticated: false });
    res.json({ authenticated: true, ...auth.toPublicUser(user) });
});

// Đăng nhập bằng AJAX ngay trong trang chính
app.post('/api/login', (req, res) => {
    const { username = '', password = '' } = req.body || {};
    const user = auth.verifyCredentials(username, password);

    if (user) {
        const token = auth.createSessionToken(user.username);
        res.setHeader(
            'Set-Cookie',
            `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`
        );

        return res.json({ success: true, ...auth.toPublicUser(user) });
    }

    return res.status(401).json({ success: false, message: 'Tên đăng nhập hoặc mật khẩu không đúng.' });
});

app.post('/api/logout', (req, res) => {
    res.setHeader(
        'Set-Cookie',
        `${AUTH_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
    );
    res.json({ success: true });
});

// Chỉ bảo vệ các API nhạy cảm phía sau — đẩy bản build yêu cầu quyền 'upload_build'
app.use('/api/upload-secure', requirePermission('upload_build'));
app.use('/api/upload-chunk', requirePermission('upload_build'));
app.use('/api/upload-finalize', requirePermission('upload_build'));
app.use('/api/logs', requireAuth);
app.use('/api/catalog', requireAuth);

const systemLogs = [];
let logClients = [];

function logToUI(message, type = 'info') {
    const time = new Date().toLocaleTimeString();
    const logEntry = { time, message, type };
    systemLogs.push(logEntry);
    if (systemLogs.length > 100) systemLogs.shift();
    logClients.forEach(client => {
        client.res.write(`data: ${JSON.stringify(logEntry)}\n\n`);
        // Ép Node đẩy dữ liệu ngay nếu response có hàm flush (khi bật nén/proxy)
        if (typeof client.res.flush === 'function') client.res.flush();
    });
}

// Nhường event loop 1 nhịp để cú res.write ở trên thực sự được đẩy tới client.
// Nếu không, các log ghi trước một tác vụ đồng bộ nặng (parse IPA, copy file lớn)
// sẽ bị Node gộp lại và chỉ tới nơi khi xử lý xong -> mất tính real-time.
function flushTick() {
    return new Promise(resolve => setImmediate(resolve));
}

// Ghi log rồi nhường event loop, đảm bảo dòng log tới trình duyệt ngay lập tức.
async function logRealtime(message, type = 'info') {
    logToUI(message, type);
    await flushTick();
}

function formatBytes(bytes, decimals = 2) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

// 📚 Đọc toàn bộ danh mục app đã lưu trên repo GitHub
async function readCatalog() {
    if (!github.isConfigured()) return [];
    const file = await github.getFile(CATALOG_PATH);
    if (!file) return [];
    try {
        const parsed = JSON.parse(file.content);
        return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
        console.error('Không đọc được catalog.json:', err.message);
        return [];
    }
}

// Đọc file catalog.json kèm sha (cần sha để ghi đè an toàn qua GitHub API)
async function loadCatalogFile() {
    const file = await github.getFile(CATALOG_PATH);
    let list = [];
    let sha;
    if (file) {
        sha = file.sha;
        try {
            const parsed = JSON.parse(file.content);
            if (Array.isArray(parsed)) list = parsed;
        } catch (err) {
            logToUI(`⚠️ catalog.json hiện tại không hợp lệ, sẽ khởi tạo lại. (${err.message})`, 'info');
        }
    }
    return { list, sha };
}

// Xóa file vật lý của một bản build (R2 object hoặc file local + bản sao lưu trữ + plist)
async function deletePhysicalBuildFiles(record) {
    if (record.r2ObjectKey) {
        await deleteR2Object(record.r2ObjectKey);
        return;
    }
    try {
        const localPath = path.join(UPLOADS_MAIN_DIR, record.id);
        if (fs.existsSync(localPath)) await fs.promises.unlink(localPath);

        if ((record.platform || 'ios') !== 'android') {
            const plistPath = `${localPath}.plist`;
            if (fs.existsSync(plistPath)) await fs.promises.unlink(plistPath);
        }

        const safeAppName = (record.appName || '').replace(/[/\\?%*:|"<>\s]/g, '_');
        const appFolder = path.join(ARCHIVE_STORAGE_DIR, `${safeAppName}_${record.bundleId}`);
        const archivedFile = path.join(appFolder, record.id);
        if (fs.existsSync(archivedFile)) await fs.promises.unlink(archivedFile);
        const archivedMeta = `${archivedFile}.json`;
        if (fs.existsSync(archivedMeta)) await fs.promises.unlink(archivedMeta);
    } catch (err) {
        logToUI(`⚠️ Lỗi khi xóa file vật lý của bản build: ${err.message}`, 'info');
    }
}

// 💾 Thêm một bản ghi app mới vào đầu danh mục và đẩy lên GitHub.
// Tự động dọn dẹp: giới hạn 10 build/app (R2) và CATALOG_MAX_ITEMS toàn cục.
// Trả về mảng các entry bị xóa (để caller xóa R2 object tương ứng nếu cần).
async function appendToCatalog(record) {
    if (!github.isConfigured()) {
        logToUI('⚠️ Chưa cấu hình GITHUB_TOKEN/GITHUB_REPO nên bỏ qua bước lưu danh mục.', 'info');
        return [];
    }

    const { list, sha } = await loadCatalogFile();
    const removed = [];

    // Per-app limit: giữ tối đa 10 build/app trong R2 — xóa bản cũ nhất trước khi thêm mới
    if (record.r2ObjectKey && record.bundleId) {
        const MAX_PER_APP = 10;
        const recordPlatform = record.platform || 'ios';
        const appBuilds = list
            .filter(item => item.bundleId === record.bundleId && item.r2ObjectKey && (item.platform || 'ios') === recordPlatform)
            .sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));

        if (appBuilds.length >= MAX_PER_APP) {
            const toEvict = appBuilds.slice(MAX_PER_APP - 1); // giữ MAX_PER_APP-1 cũ + 1 mới = MAX_PER_APP
            for (const old of toEvict) {
                removed.push(old);
                const idx = list.indexOf(old);
                if (idx !== -1) list.splice(idx, 1);
            }
        }
    }

    list.unshift(record);

    // Global catalog limit
    if (list.length > CATALOG_MAX_ITEMS) {
        const trimmed = list.splice(CATALOG_MAX_ITEMS);
        removed.push(...trimmed);
    }

    await github.putFile(
        CATALOG_PATH,
        JSON.stringify(list, null, 2),
        `add ${record.appName} ${record.version} (${record.buildNumber})`,
        sha
    );

    return removed;
}

app.get('/api/catalog', async (req, res) => {
    try {
        const list = await readCatalog();
        res.json({ success: true, configured: github.isConfigured(), items: list });
    } catch (err) {
        res.status(500).json({ success: false, message: `Không tải được danh mục: ${err.message}` });
    }
});

// 🗑️ Xóa một bản build khỏi danh mục + kho lưu trữ. Chỉ tài khoản có quyền 'delete_build' (role admin).
app.post('/api/catalog/delete', requirePermission('delete_build'), async (req, res) => {
    try {
        const targetId = (req.body?.id || '').toString().trim();
        if (!targetId) {
            return res.status(400).json({ success: false, message: 'Thiếu id bản build cần xóa.' });
        }
        if (!github.isConfigured()) {
            return res.status(500).json({ success: false, message: 'Chưa cấu hình GITHUB_TOKEN/GITHUB_REPO nên không thể cập nhật danh mục.' });
        }

        const { list, sha } = await loadCatalogFile();
        const idx = list.findIndex(item => item.id === targetId);
        if (idx === -1) {
            return res.status(404).json({ success: false, message: 'Không tìm thấy bản build này trong danh mục (có thể đã bị xóa).' });
        }

        const [removedRecord] = list.splice(idx, 1);
        const actor = req.currentUser.username;

        await github.putFile(
            CATALOG_PATH,
            JSON.stringify(list, null, 2),
            `delete ${removedRecord.appName} ${removedRecord.version} (${removedRecord.buildNumber}) by ${actor}`,
            sha
        );

        await deletePhysicalBuildFiles(removedRecord);

        logToUI(`🗑️ ${actor} đã xóa bản build "${removedRecord.appName}" v${removedRecord.version} (Build ${removedRecord.buildNumber})`, 'info');

        return res.json({ success: true, removed: removedRecord });
    } catch (err) {
        logToUI(`❌ Lỗi khi xóa bản build: ${err.message}`, 'error');
        return res.status(500).json({ success: false, message: `Lỗi khi xóa bản build: ${err.message}` });
    }
});

// 🌐 Endpoint CÔNG KHAI: trả về thông tin của ĐÚNG MỘT bản build theo plist/id
// Phục vụ trang cài đặt khi người dùng quét QR (không yêu cầu đăng nhập).
app.get('/api/app-info', async (req, res) => {
    try {
        const rawPlist = (req.query.plist || req.query.id || '').toString();
        if (!rawPlist) {
            return res.status(400).json({ success: false, message: 'Thiếu tham số plist.' });
        }

        // shareUrl dạng ?plist=<finalFilename>.plist, trong khi id trong catalog = <finalFilename>
        const targetId = rawPlist.replace(/\.plist$/i, '');

        const list = await readCatalog();
        const record = list.find(item => item.id === targetId);

        if (!record) {
            return res.status(404).json({ success: false, message: 'Không tìm thấy thông tin bản build này.' });
        }

        // Chỉ trả về thông tin của riêng bản build được yêu cầu
        return res.json({
            success: true,
            item: {
                appName: record.appName,
                bundleId: record.bundleId,
                platform: record.platform || 'ios',
                version: record.version,
                buildNumber: record.buildNumber,
                minimumOsVersion: record.minimumOsVersion || null,
                profileType: record.profileType || null,
                provisionedDevices: record.provisionedDevices || null,
                provisionedDevicesCount: record.provisionedDevicesCount ?? null,
                icon: record.icon,
                fileSize: record.fileSize,
                uploadedAt: record.uploadedAt,
                shareUrl: record.shareUrl,
                downloadUrl: record.downloadUrl
            }
        });
    } catch (err) {
        res.status(500).json({ success: false, message: `Không tải được thông tin bản build: ${err.message}` });
    }
});

// 🌐 Endpoint CÔNG KHAI: danh sách build của một app theo bundleId (+ platform)
// Phục vụ trang /ios/app và /android/app chia sẻ cho tester (không yêu cầu đăng nhập).
app.get('/api/app-builds', async (req, res) => {
    try {
        const bundleId = (req.query.bundle || '').toString().trim();
        const platformFilter = (req.query.platform || '').toString().trim().toLowerCase();
        if (!bundleId) {
            return res.status(400).json({ success: false, message: 'Thiếu tham số bundle.' });
        }

        const list = await readCatalog();
        const builds = list
            .filter(item => (item.bundleId || item.id) === bundleId)
            .filter(item => !platformFilter || (item.platform || 'ios') === platformFilter)
            .map(item => ({
                appName: item.appName,
                bundleId: item.bundleId,
                platform: item.platform || 'ios',
                version: item.version,
                buildNumber: item.buildNumber,
                minimumOsVersion: item.minimumOsVersion || null,
                profileType: item.profileType || null,
                provisionedDevices: item.provisionedDevices || null,
                provisionedDevicesCount: item.provisionedDevicesCount ?? null,
                icon: item.icon,
                qr: item.qr,
                fileSize: item.fileSize,
                uploadedAt: item.uploadedAt,
                shareUrl: item.shareUrl,
                downloadUrl: item.downloadUrl
            }))
            .sort((a, b) => (new Date(b.uploadedAt).getTime() || 0) - (new Date(a.uploadedAt).getTime() || 0));

        if (!builds.length) {
            return res.status(404).json({ success: false, message: `Không có bản build nào cho "${bundleId}".` });
        }

        return res.json({ success: true, bundleId, platform: platformFilter || null, builds });
    } catch (err) {
        res.status(500).json({ success: false, message: `Không tải được danh sách build: ${err.message}` });
    }
});

app.get('/api/logs', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Chống buffering ở proxy (nginx/CDN)
    res.flushHeaders();

    // Gợi ý thời gian client tự kết nối lại nếu rớt
    res.write('retry: 3000\n\n');

    // Phát lại các log gần đây để terminal không bị trống
    systemLogs.forEach(log => res.write(`data: ${JSON.stringify(log)}\n\n`));

    // Dòng xác nhận đã kết nối (đảm bảo terminal luôn có ít nhất 1 dòng, chứng minh luồng hoạt động)
    const connectedEntry = {
        time: new Date().toLocaleTimeString(),
        message: '🔌 Đã kết nối luồng log real-time. Sẵn sàng theo dõi tiến trình.',
        type: 'success'
    };
    res.write(`data: ${JSON.stringify(connectedEntry)}\n\n`);

    const clientId = Date.now();
    logClients.push({ id: clientId, res });

    // Heartbeat định kỳ để giữ kết nối sống và buộc proxy xả dữ liệu
    const heartbeat = setInterval(() => {
        res.write(': ping\n\n');
    }, 15000);

    req.on('close', () => {
        clearInterval(heartbeat);
        logClients = logClients.filter(client => client.id !== clientId);
    });
});

// Nhận file có bắt lỗi rõ ràng + log tiến trình ra terminal của server để chẩn đoán treo
const uploadSingle = upload.single('ipaFile');
function receiveUpload(req, res, next) {
    const rawLen = Number(req.headers['content-length'] || 0);
    const humanLen = rawLen ? formatBytes(rawLen) : 'không rõ';
    const t0 = Date.now();
    console.log(`[UPLOAD] ⬇️  Bắt đầu nhận request body (Content-Length=${humanLen})`);
    logToUI(`⬇️ Máy chủ bắt đầu nhận tệp (${humanLen})...`, 'info');

    // Cảnh báo nếu quá lâu chưa nhận xong body (giúp phát hiện nghẽn ở proxy/mạng/đĩa)
    const slowWatch = setInterval(() => {
        console.warn(`[UPLOAD] ⏳ Vẫn đang nhận body sau ${((Date.now() - t0) / 1000).toFixed(0)}s...`);
    }, 10000);

    req.on('aborted', () => {
        clearInterval(slowWatch);
        console.error('[UPLOAD] ❌ Client/proxy đã ngắt kết nối giữa chừng (request aborted).');
        logToUI('❌ Kết nối tải lên bị ngắt giữa chừng (client/proxy đóng kết nối).', 'error');
    });

    uploadSingle(req, res, (err) => {
        clearInterval(slowWatch);
        if (err) {
            console.error('[UPLOAD] ❌ Lỗi khi nhận tệp:', err.message);
            logToUI(`❌ Lỗi khi nhận tệp: ${err.message}`, 'error');
            return res.status(400).json({ success: false, message: `Lỗi nhận tệp: ${err.message}` });
        }
        console.log(`[UPLOAD] ✅ Đã nhận xong body sau ${((Date.now() - t0) / 1000).toFixed(1)}s`);
        next();
    });
}

// Xác định loại provisioning profile từ thông tin embedded profile
function getProfileType(mobileProvision) {
    if (!mobileProvision) return null;
    if (mobileProvision.ProvisionsAllDevices) return 'Enterprise';
    const allowGetTask = (mobileProvision.Entitlements || {})['get-task-allow'];
    if (Array.isArray(mobileProvision.ProvisionedDevices) && mobileProvision.ProvisionedDevices.length > 0) {
        return allowGetTask ? 'Development' : 'Ad Hoc';
    }
    return allowGetTask ? 'Development' : 'App Store';
}

function detectPlatform(filename) {
    return path.extname(filename || '').toLowerCase() === '.apk' ? 'android' : 'ios';
}

function resolveApkAppName(result) {
    const label = result?.application?.label ?? result?.['application-label'];
    if (typeof label === 'string' && label.trim()) return label.trim();
    if (label && typeof label === 'object') {
        const candidate = label[''] || label.en || label['en-US']
            || Object.values(label).find((v) => typeof v === 'string' && v.trim());
        if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    }
    return null;
}

function mapParsedAppInfo(result, platform) {
    if (platform === 'android') {
        const minSdk = result.usesSdk?.minSdkVersion ?? result.minSdkVersion ?? null;
        return {
            platform: 'android',
            bundleId: result.package || 'com.unknown.app',
            version: String(result.versionName ?? '1.0.0'),
            buildNumber: String(result.versionCode ?? '1'),
            appName: resolveApkAppName(result) || 'Ứng dụng Android',
            minimumOsVersion: minSdk != null ? String(minSdk) : null,
            profileType: null,
            provisionedDevices: null,
            provisionedDevicesCount: null,
        };
    }

    const mobileProvision = result.mobileProvision || null;
    return {
        platform: 'ios',
        bundleId: result.CFBundleIdentifier || 'com.unknown.app',
        version: result.CFBundleShortVersionString || '1.0.0',
        buildNumber: result.CFBundleVersion || '1',
        appName: result.CFBundleDisplayName || result.CFBundleName || 'Ứng dụng iOS',
        minimumOsVersion: result.MinimumOSVersion || null,
        profileType: getProfileType(mobileProvision),
        provisionedDevices: Array.isArray(mobileProvision?.ProvisionedDevices)
            ? mobileProvision.ProvisionedDevices
            : null,
        provisionedDevicesCount: Array.isArray(mobileProvision?.ProvisionedDevices)
            ? mobileProvision.ProvisionedDevices.length
            : null,
    };
}

// 🧠 HÀM DÙNG CHUNG: bóc tách IPA/APK đã nằm sẵn trên đĩa -> tạo link -> trả phản hồi -> lưu trữ ở nền.
// Dùng cho cả upload 1 lần (upload-secure), chunk cũ (upload-finalize), lẫn R2 (r2-finalize).
// r2ObjectKey: nếu có, file đang nằm trên R2 → dùng URL R2, bỏ qua local archive.
async function processUploadedIpa(res, { finalFilename, finalPath, fileSizeBytes, r2ObjectKey = null, uploadedBy = null }) {
    const startTime = performance.now();
    const formattedTotalSize = formatBytes(fileSizeBytes);
    const platform = detectPlatform(finalFilename);
    const packageLabel = platform === 'android' ? 'APK' : 'IPA';

    try {
        await logRealtime(`📥 Đã nhận và lưu kho tệp tin (${formattedTotalSize}) thành công vào ổ đĩa Mac!`, 'success');
        await logRealtime(`⚡ Bắt đầu bóc tách Metadata ${packageLabel} bằng AppInfoParser...`, 'info');

        const parser = new AppInfoParser(finalPath);

        try {
            const result = await parser.parse();
            const appInfo = mapParsedAppInfo(result, platform);
            const iconBase64 = result.icon || 'https://cdn-icons-png.flaticon.com/512/5115/5115293.png';
            const totalProcessTime = ((performance.now() - startTime) / 1000).toFixed(2);

            await logRealtime(`✅ Phân tích cấu trúc thành công: ${appInfo.appName} | Phiên bản: ${appInfo.version} (${platform}) trong ${totalProcessTime} giây`, 'success');
            if (uploadedBy) {
                await logRealtime(`👤 Người đẩy bản build: ${uploadedBy}`, 'info');
            }

            // URL công khai của file: R2 (nếu upload qua R2) hoặc local (legacy)
            const filePublicUrl = r2ObjectKey
                ? `${process.env.R2_PUBLIC_URL}/${r2ObjectKey}`
                : `${PUBLIC_BASE_URL}/uploads/${finalFilename}`;

            let downloadUrl;
            let shareUrl;

            if (platform === 'android') {
                // Android: tải thẳng APK — không cần plist / itms-services
                downloadUrl = filePublicUrl;
                shareUrl = `${PUBLIC_BASE_URL}/install?id=${encodeURIComponent(finalFilename)}`;
            } else {
                const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>items</key><array><dict><key>assets</key><array><dict><key>kind</key><string>software-package</string><key>url</key><string>${filePublicUrl}</string></dict></array><key>metadata</key><dict><key>bundle-identifier</key><string>${appInfo.bundleId}</string><key>bundle-version</key><string>${appInfo.version}</string><key>kind</key><string>software</string><key>title</key><string>${appInfo.appName}</string></dict></dict></array></dict></plist>`;

                const plistFilename = `${finalFilename}.plist`;
                await fs.promises.writeFile(path.join(UPLOADS_MAIN_DIR, plistFilename), plistContent);

                const manifestUrl = `${PUBLIC_BASE_URL}/uploads/${plistFilename}`;
                downloadUrl = `itms-services://?action=download-manifest&url=${encodeURIComponent(manifestUrl)}`;
                shareUrl = `${PUBLIC_BASE_URL}/install?plist=${plistFilename}`;
            }

            const uploadedAt = new Date().toISOString();

            await logRealtime('🎉 Đã tạo xong link cài đặt! Đang hoàn tất lưu trữ ở chế độ nền...', 'success');

            res.json({
                success: true,
                downloadUrl,
                shareUrl,
                processTime: totalProcessTime,
                appInfo: { ...appInfo, icon: iconBase64 }
            });

            (async () => {
                try {
                    if (!r2ObjectKey) {
                        // ── Chế độ legacy: lưu bản sao vật lý trên ổ đĩa local ──
                        const safeAppName = appInfo.appName.replace(/[/\\?%*:|"<>\s]/g, '_');
                        const appStorageDirName = `${safeAppName}_${appInfo.bundleId}`;
                        const targetAppFolder = path.join(ARCHIVE_STORAGE_DIR, appStorageDirName);

                        if (!fs.existsSync(targetAppFolder)) fs.mkdirSync(targetAppFolder, { recursive: true });

                        await logRealtime('🗄️ Đang sao lưu bản build vào kho lưu trữ...', 'info');
                        await fs.promises.copyFile(finalPath, path.join(targetAppFolder, finalFilename));

                        const metadataInfo = {
                            ...appInfo,
                            filename: finalFilename,
                            fileSize: formattedTotalSize,
                            uploadedAt,
                            processTimeSeconds: totalProcessTime
                        };
                        await fs.promises.writeFile(path.join(targetAppFolder, `${finalFilename}.json`), JSON.stringify(metadataInfo, null, 4));

                        const archiveExt = platform === 'android' ? '.apk' : '.ipa';
                        const currentFiles = fs.readdirSync(targetAppFolder);
                        const packageFiles = currentFiles
                            .filter(f => f.endsWith(archiveExt))
                            .map(f => {
                                const filePath = path.join(targetAppFolder, f);
                                return { name: f, path: filePath, ctime: fs.statSync(filePath).ctimeMs };
                            })
                            .sort((a, b) => a.ctime - b.ctime);

                        if (packageFiles.length > 10) {
                            const deleteCount = packageFiles.length - 10;
                            await logRealtime(`⚠️ Vượt quá 10 bản build. Tiến hành tự động xóa bỏ ${deleteCount} tệp cũ...`, 'info');
                            for (let k = 0; k < deleteCount; k++) {
                                if (fs.existsSync(packageFiles[k].path)) fs.unlinkSync(packageFiles[k].path);
                                if (fs.existsSync(packageFiles[k].path + '.json')) fs.unlinkSync(packageFiles[k].path + '.json');
                            }
                        }
                    }
                    // ── R2 mode: file đã nằm trên R2, không cần lưu local ──
                    // (file tạm sẽ bị xóa bởi r2-finalize sau khi hàm này return)

                    let qrDataUrl = '';
                    try {
                        qrDataUrl = await QRCode.toDataURL(shareUrl, { width: 320, margin: 1 });
                    } catch (qrErr) {
                        logToUI(`⚠️ Không tạo được ảnh QR để lưu: ${qrErr.message}`, 'info');
                    }

                    const catalogRecord = {
                        id: finalFilename,
                        appName: appInfo.appName,
                        bundleId: appInfo.bundleId,
                        platform: appInfo.platform,
                        version: appInfo.version,
                        buildNumber: appInfo.buildNumber,
                        minimumOsVersion: appInfo.minimumOsVersion,
                        profileType: appInfo.profileType,
                        provisionedDevices: appInfo.provisionedDevices,
                        provisionedDevicesCount: appInfo.provisionedDevicesCount,
                        icon: iconBase64,
                        qr: qrDataUrl,
                        fileSize: formattedTotalSize,
                        fileSizeBytes,                   // raw bytes để tính dung lượng R2
                        shareUrl,
                        downloadUrl,
                        uploadedAt,
                        processTimeSeconds: totalProcessTime,
                        r2ObjectKey: r2ObjectKey || null, // null = legacy local storage
                        uploadedBy: uploadedBy || null,   // lưu vết ai đã đẩy bản build này
                    };

                    await logRealtime('☁️ Đang đồng bộ thông tin app lên danh mục GitHub...', 'info');
                    const removedFromCatalog = await appendToCatalog(catalogRecord);

                    // Xóa R2 objects của các entry bị loại khỏi danh mục
                    for (const item of removedFromCatalog) {
                        if (item.r2ObjectKey) {
                            await deleteR2Object(item.r2ObjectKey);
                            logToUI(`🗑️ R2 cleanup: ${item.appName} ${item.version} (${item.fileSize || ''})`, 'info');
                        }
                    }

                    await logRealtime('🗂️ Đã lưu xong danh mục. Toàn bộ quy trình hoàn tất!', 'success');
                } catch (bgErr) {
                    console.error('[BACKGROUND] Lỗi xử lý nền:', bgErr.message);
                    logToUI(`⚠️ Lỗi khi hoàn tất lưu trữ ở nền: ${bgErr.message}`, 'error');
                }
            })();
            return;
        } catch (parserError) {
            logToUI(`❌ Trích xuất thông tin ${packageLabel} thất bại: ${parserError.message}`, 'error');
            return res.status(500).json({ success: false, message: `Lỗi bóc tách cấu trúc file ${packageLabel}: ${parserError.message}` });
        }
    } catch (error) {
        logToUI(`❌ Hệ thống gặp lỗi xử lý: ${error.message}`, 'error');
        return res.status(500).json({ success: false, message: `Lỗi hệ thống Server nội bộ: ${error.message}` });
    }
}

// Upload 1 lần (cũ) vẫn giữ lại để tương thích ngược.
app.post('/api/upload-secure', receiveUpload, async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ success: false, message: 'Không tìm thấy tệp tin IPA/APK.' });
    }
    const sessionUser = getSessionUser(req);
    return processUploadedIpa(res, {
        finalFilename: req.file.filename,
        finalPath: req.file.path,
        fileSizeBytes: req.file.size,
        uploadedBy: sessionUser?.username || null
    });
});

// Upload chunk: mỗi request nhỏ để không chạm timeout 100s của Cloudflare.
app.post('/api/upload-chunk', chunkUpload.single('chunk'), async (req, res) => {
    try {
        const { uploadId = '', chunkIndex = '', totalChunks = '' } = req.body || {};
        const idx = Number(chunkIndex);
        const total = Number(totalChunks);

        if (!uploadId || !Number.isInteger(idx) || idx < 0 || !Number.isInteger(total) || total <= 0) {
            return res.status(400).json({ success: false, message: 'Thiếu hoặc sai metadata chunk.' });
        }
        if (!req.file || !req.file.buffer) {
            return res.status(400).json({ success: false, message: 'Không nhận được dữ liệu chunk.' });
        }

        const chunkPath = path.join(CHUNKS_DIR, `upload_${uploadId}_${idx}`);
        await fs.promises.writeFile(chunkPath, req.file.buffer);

        if (idx === 0) {
            await logRealtime(`🧩 Bắt đầu nhận upload theo chunk (ID: ${uploadId}, tổng ${total} phần)...`, 'info');
        }
        if (idx === total - 1) {
            await logRealtime(`🧩 Đã nhận xong ${total}/${total} chunk. Chuẩn bị ghép tệp...`, 'info');
        }

        return res.json({ success: true, chunkIndex: idx });
    } catch (err) {
        logToUI(`❌ Lỗi nhận chunk: ${err.message}`, 'error');
        return res.status(500).json({ success: false, message: `Lỗi nhận chunk: ${err.message}` });
    }
});

// ─── Job store: theo dõi tiến trình xử lý IPA nền ───────────────────────────
// Mỗi entry: { status: 'pending'|'done'|'error', result, error, createdAt }
const jobStore = new Map();

// Dọn dẹp job cũ hơn 30 phút để tránh rò rỉ bộ nhớ
setInterval(() => {
    const cutoff = Date.now() - 30 * 60 * 1000;
    for (const [id, job] of jobStore) {
        if (job.createdAt < cutoff) jobStore.delete(id);
    }
}, 5 * 60 * 1000);

// Client hỏi kết quả sau khi finalize trả về jobId
app.get('/api/upload-status/:jobId', requireAuth, (req, res) => {
    const job = jobStore.get(req.params.jobId);
    if (!job) return res.status(404).json({ success: false, message: 'Không tìm thấy job.' });
    if (job.status === 'pending') return res.json({ success: true, status: 'pending' });
    if (job.status === 'done') return res.json({ success: true, status: 'done', result: job.result });
    return res.json({ success: false, status: 'error', message: job.error });
});

// Finalize: ghép các chunk thành file IPA hoàn chỉnh rồi đưa vào pipeline xử lý chung.
// Trả về jobId NGAY LẬP TỨC để tránh proxy timeout (Cloudflare 100s, v.v.)
// Client polling /api/upload-status/:jobId mỗi 2 giây để lấy kết quả.
app.post('/api/upload-finalize', async (req, res) => {
    try {
        const { uploadId = '', totalChunks = '', originalName = '', totalSize = '' } = req.body || {};
        const total = Number(totalChunks);

        if (!uploadId || !Number.isInteger(total) || total <= 0 || !originalName) {
            return res.status(400).json({ success: false, message: 'Thiếu thông tin để finalize upload.' });
        }

        // Kiểm tra nhanh tất cả chunk đã có mặt trước khi nhận job
        for (let i = 0; i < total; i++) {
            const chunkPath = path.join(CHUNKS_DIR, `upload_${uploadId}_${i}`);
            if (!fs.existsSync(chunkPath)) {
                return res.status(400).json({ success: false, message: `Thiếu chunk #${i}. Vui lòng upload lại.` });
            }
        }

        const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        jobStore.set(jobId, { status: 'pending', createdAt: Date.now() });
        const uploadedBy = getSessionUser(req)?.username || null;

        // Trả về jobId ngay — client sẽ polling để nhận kết quả
        res.json({ success: true, status: 'pending', jobId });

        // Xử lý nặng ở nền, không giữ HTTP connection
        (async () => {
            try {
                const safeOriginalName = path.basename(originalName).replace(/[^\w.\-]/g, '_');
                const finalFilename = `app_${Date.now()}_${safeOriginalName}`;
                const finalPath = path.join(UPLOADS_MAIN_DIR, finalFilename);

                await logRealtime(`🧵 Bắt đầu ghép ${total} chunk thành tệp hoàn chỉnh...`, 'info');

                for (let i = 0; i < total; i++) {
                    const chunkPath = path.join(CHUNKS_DIR, `upload_${uploadId}_${i}`);
                    const buf = await fs.promises.readFile(chunkPath);
                    await fs.promises.appendFile(finalPath, buf);
                    await fs.promises.unlink(chunkPath);
                }

                const fileStat = await fs.promises.stat(finalPath);
                const expectedSize = Number(totalSize) || fileStat.size;
                await logRealtime(`🧵 Ghép chunk hoàn tất (${formatBytes(fileStat.size)}). Chuyển sang xử lý file...`, 'success');

                // processUploadedIpa gọi res.json() để trả kết quả — ta dùng mock res để bắt kết quả
                const mockRes = {
                    _statusCode: 200,
                    _body: null,
                    status(code) { this._statusCode = code; return this; },
                    json(body) { this._body = body; }
                };

                await processUploadedIpa(mockRes, { finalFilename, finalPath, fileSizeBytes: expectedSize, uploadedBy });

                if (mockRes._statusCode >= 200 && mockRes._statusCode < 300 && mockRes._body?.success) {
                    jobStore.set(jobId, { status: 'done', result: mockRes._body, createdAt: Date.now() });
                } else {
                    const errMsg = mockRes._body?.message || 'Lỗi không xác định khi xử lý file.';
                    jobStore.set(jobId, { status: 'error', error: errMsg, createdAt: Date.now() });
                    logToUI(`❌ Xử lý file thất bại (job ${jobId}): ${errMsg}`, 'error');
                }
            } catch (err) {
                jobStore.set(jobId, { status: 'error', error: err.message, createdAt: Date.now() });
                logToUI(`❌ Lỗi finalize nền (job ${jobId}): ${err.message}`, 'error');
            }
        })();
    } catch (err) {
        logToUI(`❌ Lỗi finalize upload chunk: ${err.message}`, 'error');
        return res.status(500).json({ success: false, message: `Lỗi ghép chunk: ${err.message}` });
    }
});

// ─── Cloudflare R2 Upload API ────────────────────────────────────────────────
app.use('/api/r2-start',    requirePermission('upload_build'));
app.use('/api/r2-part-url', requirePermission('upload_build'));
app.use('/api/r2-finalize', requirePermission('upload_build'));

// Bước 1: Khởi tạo multipart upload trên R2, nhận UploadId + objectKey
app.post('/api/r2-start', async (req, res) => {
    if (!r2Client) {
        return res.json({ success: false, r2Available: false, message: 'R2 chưa được cấu hình trên máy chủ.' });
    }
    try {
        const { originalName = 'app.ipa' } = req.body;
        const safeName = path.basename(originalName).replace(/[^\w.\-]/g, '_');
        const objectKey = `uploads/app_${Date.now()}_${safeName}`;
        const contentType = safeName.toLowerCase().endsWith('.apk')
            ? 'application/vnd.android.package-archive'
            : 'application/octet-stream';

        const { UploadId } = await r2Client.send(new _R2Cmd.CreateMultipartUploadCommand({
            Bucket: process.env.R2_BUCKET,
            Key: objectKey,
            ContentType: contentType,
        }));

        logToUI(`🚀 R2 multipart upload bắt đầu: ${safeName}`, 'info');
        return res.json({ success: true, r2Available: true, r2UploadId: UploadId, objectKey });
    } catch (err) {
        console.error('[R2] r2-start error:', err.message);
        return res.status(500).json({ success: false, message: `Lỗi khởi tạo R2 upload: ${err.message}` });
    }
});

// Bước 2: Server ký presigned URL để client PUT từng part thẳng lên R2
app.post('/api/r2-part-url', async (req, res) => {
    if (!r2Client) return res.status(500).json({ success: false, message: 'R2 chưa được cấu hình.' });
    try {
        const { r2UploadId, objectKey, partNumber } = req.body;
        if (!r2UploadId || !objectKey || !partNumber) {
            return res.status(400).json({ success: false, message: 'Thiếu tham số r2UploadId/objectKey/partNumber.' });
        }
        const url = await r2GetSignedUrl(
            r2Client,
            new _R2Cmd.UploadPartCommand({
                Bucket: process.env.R2_BUCKET,
                Key: objectKey,
                UploadId: r2UploadId,
                PartNumber: Number(partNumber),
            }),
            { expiresIn: 3600 }
        );
        return res.json({ success: true, presignedUrl: url });
    } catch (err) {
        console.error('[R2] r2-part-url error:', err.message);
        return res.status(500).json({ success: false, message: `Lỗi tạo presigned URL: ${err.message}` });
    }
});

// Bước 3: Hoàn tất multipart upload, kích hoạt xử lý IPA ở nền
// Trả về jobId ngay, client polling /api/upload-status/:jobId
app.post('/api/r2-finalize', async (req, res) => {
    if (!r2Client) return res.status(500).json({ success: false, message: 'R2 chưa được cấu hình.' });
    try {
        const { r2UploadId, objectKey, parts, originalName = '', totalSize = 0 } = req.body;

        if (!r2UploadId || !objectKey || !Array.isArray(parts) || !parts.length) {
            return res.status(400).json({ success: false, message: 'Thiếu thông tin để hoàn tất R2 upload.' });
        }

        // Hoàn tất multipart upload trên R2 (R2 ghép tất cả parts lại)
        await r2Client.send(new _R2Cmd.CompleteMultipartUploadCommand({
            Bucket: process.env.R2_BUCKET,
            Key: objectKey,
            UploadId: r2UploadId,
            MultipartUpload: {
                Parts: parts
                    .map(p => ({ PartNumber: Number(p.partNumber), ETag: p.etag }))
                    .sort((a, b) => a.PartNumber - b.PartNumber),
            },
        }));

        const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        jobStore.set(jobId, { status: 'pending', createdAt: Date.now() });
        const uploadedBy = getSessionUser(req)?.username || null;
        res.json({ success: true, status: 'pending', jobId });

        // Xử lý nền: tải IPA từ R2 về temp → parse → trả kết quả → dọn temp
        (async () => {
            const tmpFilename = `tmp_${jobId}_${path.basename(objectKey)}`;
            const tmpPath = path.join(UPLOADS_MAIN_DIR, tmpFilename);
            try {
                await logRealtime('☁️ R2 đã nhận xong. Đang tải file về máy chủ để phân tích...', 'info');

                const { Body } = await r2Client.send(new _R2Cmd.GetObjectCommand({
                    Bucket: process.env.R2_BUCKET,
                    Key: objectKey,
                }));
                await streamToFile(Body, tmpPath);

                const fileStat = await fs.promises.stat(tmpPath);
                await logRealtime(`✅ Đã tải về (${formatBytes(fileStat.size)}). Đang phân tích metadata...`, 'success');

                const finalFilename = path.basename(objectKey);
                const mockRes = {
                    _statusCode: 200, _body: null,
                    status(c) { this._statusCode = c; return this; },
                    json(b) { this._body = b; },
                };

                await processUploadedIpa(mockRes, {
                    finalFilename,
                    finalPath: tmpPath,
                    fileSizeBytes: Number(totalSize) || fileStat.size,
                    r2ObjectKey: objectKey,
                    uploadedBy,
                });

                if (mockRes._statusCode >= 200 && mockRes._statusCode < 300 && mockRes._body?.success) {
                    jobStore.set(jobId, { status: 'done', result: mockRes._body, createdAt: Date.now() });
                } else {
                    const errMsg = mockRes._body?.message || 'Lỗi không xác định khi xử lý file.';
                    jobStore.set(jobId, { status: 'error', error: errMsg, createdAt: Date.now() });
                    logToUI(`❌ R2 processing failed (job ${jobId}): ${errMsg}`, 'error');
                    await deleteR2Object(objectKey); // Dọn object lỗi khỏi R2
                }
            } catch (err) {
                jobStore.set(jobId, { status: 'error', error: err.message, createdAt: Date.now() });
                logToUI(`❌ Lỗi r2-finalize nền (job ${jobId}): ${err.message}`, 'error');
                await deleteR2Object(objectKey);
            } finally {
                fs.promises.unlink(tmpPath).catch(() => {});
            }
        })();
    } catch (err) {
        logToUI(`❌ Lỗi r2-finalize: ${err.message}`, 'error');
        return res.status(500).json({ success: false, message: `Lỗi hoàn tất R2 upload: ${err.message}` });
    }
});
// ─────────────────────────────────────────────────────────────────────────────

const server = app.listen(PORT, () => console.log(`Diawi Local-First System active on port ${PORT}`));
server.timeout = 600000;
server.keepAliveTimeout = 600000;