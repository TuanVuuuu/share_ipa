const path = require('path');
const os = require('os');
const http = require('http');

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

const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'https://share-ipa.vunt.site';
const LEGACY_PUBLIC_HOSTS = ['share-ipa.vunt.info'];
// URL máy chủ trong LAN (vd: http://192.168.1.105:3080). Để trống → tự nhận IP LAN + Caddy :3080.
const LAN_BASE_URL = (process.env.LAN_BASE_URL || '').trim().replace(/\/$/, '');
const CATALOG_IOS_PATH = 'catalog-ios.json';         // Danh mục riêng cho iOS
const CATALOG_ANDROID_PATH = 'catalog-android.json'; // Danh mục riêng cho Android
const DOWNLOAD_PRODUCTS_PATH = 'download-products.json'; // Mục download do admin tạo (tên + bundle)
const DOWNLOAD_SHARES_PATH = 'download-shares.json';     // Link do tester tạo và lưu
const CATALOG_MAX_ITEMS = 200;             // Giới hạn số bản ghi giữ lại trong mỗi danh mục

// 👉 CHỖ DUY NHẤT cần đổi mỗi khi cập nhật giao diện (CSS/JS) để phá cache trình duyệt/CDN.
// Đổi giá trị này (ví dụ tăng lên '3', '4'...) rồi deploy là đủ.
const ASSET_VERSION = process.env.ASSET_VERSION || '32';

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
const PORT = Number(process.env.PORT) || 3081;
const AUTH_COOKIE_NAME = 'share_ipa_auth';

function lanIpPriority(ip) {
    const host = String(ip || '').replace(/^::ffff:/, '');
    if (/^192\.168\./.test(host)) return 0;
    if (/^10\./.test(host)) return 1;
    const m = host.match(/^172\.(\d+)\./);
    if (m) {
        const n = Number(m[1]);
        if (n >= 16 && n <= 31) return 2;
    }
    if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)) return 3;
    return 9;
}

function getLanIpv4Addresses() {
    const nets = os.networkInterfaces();
    const out = [];
    for (const name of Object.keys(nets || {})) {
        for (const net of nets[name] || []) {
            const family = net.family === 4 || net.family === 'IPv4';
            if (!family || net.internal || !net.address) continue;
            if (/^169\.254\./.test(net.address)) continue;
            out.push(net.address);
        }
    }
    out.sort((a, b) => lanIpPriority(a) - lanIpPriority(b) || a.localeCompare(b));
    return out;
}

function resolveConfiguredLanBaseUrl() {
    if (LAN_BASE_URL) return LAN_BASE_URL;
    const ips = getLanIpv4Addresses();
    if (!ips.length) return '';
    return `http://${ips[0]}:${PORT}`;
}

function getLanCandidateBaseUrls() {
    const urls = [];
    const seen = new Set();
    const add = (u) => {
        if (!u || seen.has(u)) return;
        seen.add(u);
        urls.push(u);
    };
    if (LAN_BASE_URL) add(LAN_BASE_URL);
    for (const ip of getLanIpv4Addresses()) {
        add(`http://${ip}:${PORT}`);
        if (Number(PORT) !== 3080) add(`http://${ip}:3080`);
    }
    return urls;
}

function isPrivateHostname(hostname) {
    const host = String(hostname || '').split(':')[0].toLowerCase();
    if (!host) return false;
    if (host === 'localhost' || host.endsWith('.local')) return true;
    if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return true;
    const m = host.match(/^172\.(\d+)\./);
    if (m) {
        const n = Number(m[1]);
        return n >= 16 && n <= 31;
    }
    if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)) return true;
    return false;
}

function requestBaseUrl(req) {
    const xfProto = (req.headers['x-forwarded-proto'] || '').toString().split(',')[0].trim();
    const proto = xfProto || req.protocol || 'http';
    const xfHost = (req.headers['x-forwarded-host'] || '').toString().split(',')[0].trim();
    const host = xfHost || req.headers.host || `localhost:${PORT}`;
    return `${proto}://${host}`.replace(/\/$/, '');
}

function getExternalClientIp(req) {
    const cf = (req.headers['cf-connecting-ip'] || '').toString().trim();
    if (cf) return cf.replace(/^::ffff:/, '');
    const xf = (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim();
    if (xf) return xf.replace(/^::ffff:/, '');
    const raw = String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
    if (raw && raw !== '127.0.0.1' && raw !== '::1') return raw;
    return '';
}

function isLanRequest(req) {
    const xfHost = (req.headers['x-forwarded-host'] || '').toString().split(',')[0].trim();
    const hostHeader = xfHost || req.headers.host || '';
    const host = hostHeader.split(':')[0];
    if (isPrivateHostname(host)) return true;

    const lanBase = resolveConfiguredLanBaseUrl();
    if (lanBase) {
        try {
            if (new URL(lanBase).host === hostHeader) return true;
        } catch (_) { /* ignore */ }
    }

    // Request đi qua Cloudflare Tunnel/CDN: IP client là WAN, không phải LAN.
    if ((req.headers['cf-connecting-ip'] || '').toString().trim()) return false;

    const clientIp = getExternalClientIp(req);
    if (clientIp && isPrivateHostname(clientIp) && clientIp !== '127.0.0.1' && clientIp !== '::1') {
        return true;
    }
    return false;
}

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
const chunkUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024 } });

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

app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: false, limit: '5mb' }));

const LAN_PIXEL_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
);

function setLanCors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Cache-Control', 'no-store');
}

function sendLanInfo(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    const baseUrl = resolveConfiguredLanBaseUrl();
    const candidates = getLanCandidateBaseUrls();
    res.json({
        success: true,
        enabled: !!baseUrl,
        baseUrl: baseUrl || null,
        candidates,
        addresses: getLanIpv4Addresses(),
        publicBaseUrl: PUBLIC_BASE_URL,
        viaLanHost: isLanRequest(req),
    });
}

// LAN probe — gắn sớm (trước static) để không bị middleware khác nuốt request
app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'OPTIONS') return next();
    const p = req.path || '';
    if (p !== '/api/lan-info' && p !== '/api/lan' && p !== '/api/lan-ping' && p !== '/api/lan-pixel') {
        return next();
    }
    if (req.method === 'OPTIONS') {
        setLanCors(res);
        return res.status(204).end();
    }
    if (p === '/api/lan-ping') {
        setLanCors(res);
        return res.json({ ok: true, t: Date.now() });
    }
    if (p === '/api/lan-pixel') {
        setLanCors(res);
        res.setHeader('Content-Type', 'image/png');
        return res.send(LAN_PIXEL_PNG);
    }
    return sendLanInfo(req, res);
});

// Trả JSON khi body quá lớn / JSON lỗi (tránh client nhận HTML rồi fail parse)
app.use((err, req, res, next) => {
    if (!err) return next();
    if (err.type === 'entity.too.large') {
        return res.status(413).json({ success: false, message: 'Dữ liệu gửi lên quá lớn (ảnh icon/banner). Hãy dùng ảnh nhỏ hơn.' });
    }
    if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
        return res.status(400).json({ success: false, message: 'JSON không hợp lệ.' });
    }
    return next(err);
});

// Tạo block Open Graph + Twitter Card meta tags để Discord/Slack unfurl link đẹp
function buildOgMeta({ title, description, image, url } = {}) {
    const esc = (s = '') => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const t = esc(title || 'Share IPA');
    const d = esc(description || 'Nền tảng chia sẻ và cài đặt ứng dụng iOS/Android nội bộ dễ dàng.');
    const img = rewritePublicUrl(image || `${PUBLIC_BASE_URL}/ic_launcher_web.png`);
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
app.get('/uploads/:filename', (req, res, next) => {
    const filename = path.basename(req.params.filename || '');
    if (!filename.toLowerCase().endsWith('.plist')) return next();
    const filePath = path.join(UPLOADS_MAIN_DIR, filename);
    fs.readFile(filePath, 'utf8', (err, content) => {
        if (err) return next();
        let out = rewritePublicUrl(content);
        // Cùng mạng / truy cập qua LAN: trỏ IPA về host hiện tại nếu file còn trên đĩa
        const ipaName = filename.replace(/\.plist$/i, '');
        if (uploadsFileExists(ipaName)) {
            const packageUrl = `${requestBaseUrl(req)}/uploads/${encodeURIComponent(ipaName)}`;
            out = out.replace(
                /(<key>url<\/key>\s*<string>)[^<]*(<\/string>)/i,
                `$1${packageUrl}$2`
            );
        }
        res.setHeader('Content-Type', 'application/xml; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.send(out);
    });
});
app.use('/uploads', express.static(UPLOADS_MAIN_DIR, {
    setHeaders: (res, filePath) => {
        if (filePath.toLowerCase().endsWith('.apk')) {
            res.setHeader('Content-Type', 'application/vnd.android.package-archive');
            res.setHeader('Content-Disposition', `attachment; filename="${path.basename(filePath)}"`);
        } else if (filePath.toLowerCase().endsWith('.ipa')) {
            res.setHeader('Content-Type', 'application/octet-stream');
            res.setHeader('Content-Disposition', `attachment; filename="${path.basename(filePath)}"`);
        }
    }
}));
app.use('/storage', express.static(ARCHIVE_STORAGE_DIR));

// Đăng ký lại route LAN dạng app.get (phòng trường hợp middleware sớm bị bỏ qua)
app.get('/api/lan-ping', (req, res) => {
    setLanCors(res);
    res.json({ ok: true, t: Date.now() });
});
app.get('/api/lan-pixel', (req, res) => {
    setLanCors(res);
    res.setHeader('Content-Type', 'image/png');
    res.send(LAN_PIXEL_PNG);
});
app.options('/api/lan-ping', (req, res) => {
    setLanCors(res);
    res.status(204).end();
});
app.options('/api/lan-pixel', (req, res) => {
    setLanCors(res);
    res.status(204).end();
});
app.get('/api/lan-info', sendLanInfo);
app.get('/api/lan', sendLanInfo);

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

// Trang danh sách mục download (admin tạo / quản lý)
app.get('/download', (req, res) => {
    const user = getSessionUser(req);
    if (!user) {
        return res.redirect(`/?next=${encodeURIComponent('/download')}`);
    }
    if (!auth.hasPermission(user, 'create_download_link')) {
        return res.redirect('/');
    }
    // Link cũ /download?id=... → chuyển sang trang chi tiết
    const legacyId = (req.query.id || '').toString().trim();
    if (legacyId) {
        return res.redirect(`/download/detail?id=${encodeURIComponent(legacyId)}`);
    }
    const og = buildOgMeta({
        title: 'Mục download — Share IPA',
        description: 'Danh sách mục download do admin tạo để chia sẻ bản build cho đối tác.',
        url: `${PUBLIC_BASE_URL}/download`,
    });
    sendHtmlWithOg(res, 'download.html', og);
});

// Trang chi tiết 1 mục: chọn bản iOS/Android và tạo link
app.get('/download/detail', (req, res) => {
    const user = getSessionUser(req);
    const id = (req.query.id || '').toString().trim();
    const nextPath = id
        ? `/download/detail?id=${encodeURIComponent(id)}`
        : '/download';
    if (!user) {
        return res.redirect(`/?next=${encodeURIComponent(nextPath)}`);
    }
    if (!auth.hasPermission(user, 'create_download_link')) {
        return res.redirect('/');
    }
    if (!id) {
        return res.redirect('/download');
    }
    const og = buildOgMeta({
        title: 'Tạo link tải — Share IPA',
        description: 'Chọn bản iOS và Android để tạo link chia sẻ cho tester đối tác.',
        url: `${PUBLIC_BASE_URL}/download/detail?id=${encodeURIComponent(id)}`,
    });
    sendHtmlWithOg(res, 'download.html', og);
});

// Trang public đối tác: /dl?s=<shareId> hoặc /dl?ios=<id>&android=<id>
app.get('/dl', async (req, res) => {
    const shareId = (req.query.s || '').toString().trim();
    let iosId = (req.query.ios || '').toString().trim();
    let androidId = (req.query.android || '').toString().trim();
    let productName = '';

    if (shareId) {
        try {
            const shares = await readJsonArrayFile(DOWNLOAD_SHARES_PATH);
            const share = shares.find(item => item.id === shareId);
            if (share) {
                iosId = share.iosBuildId || '';
                androidId = share.androidBuildId || '';
                productName = share.productName || '';
            }
        } catch (_) { /* giữ query gốc */ }
    }

    const qs = new URLSearchParams();
    if (shareId) qs.set('s', shareId);
    else {
        if (iosId) qs.set('ios', iosId);
        if (androidId) qs.set('android', androidId);
    }
    const pageUrl = qs.toString()
        ? `${PUBLIC_BASE_URL}/dl?${qs.toString()}`
        : `${PUBLIC_BASE_URL}/dl`;

    let og = buildOgMeta({
        title: productName ? `${productName} — Share IPA` : 'Tải ứng dụng — Share IPA',
        description: 'Quét mã QR hoặc nhấn nút để cài đặt bản build đã được chia sẻ.',
        url: pageUrl,
    });

    const firstId = iosId || androidId;
    if (firstId) {
        try {
            const list = await readCatalog();
            const record = list.find(item => item.id === firstId)
                || (androidId && androidId !== firstId ? list.find(item => item.id === androidId) : null);
            if (record) {
                og = buildOgMeta({
                    title: `${productName || record.appName} — Share IPA`,
                    description: `Cài đặt ${productName || record.appName} · chọn nền tảng iOS hoặc Android`,
                    image: record.icon || undefined,
                    url: pageUrl,
                });
            }
        } catch (_) { /* giữ OG mặc định */ }
    }
    sendHtmlWithOg(res, 'dl.html', og);
});

// Trang danh sách app theo platform: /ios | /android
function servePlatformCatalogPage(req, res, platform) {
    const user = getSessionUser(req);
    const listPath = platform === 'android' ? '/android' : '/ios';
    if (!user) {
        return res.redirect(`/?next=${encodeURIComponent(listPath)}`);
    }
    if (!auth.hasPermission(user, 'view_catalog')) {
        return res.redirect('/');
    }
    const platformLabel = platform === 'android' ? 'Android' : 'iOS';
    const og = buildOgMeta({
        title: `Ứng dụng ${platformLabel} — Share IPA`,
        description: `Danh sách toàn bộ ứng dụng ${platformLabel} trong danh mục.`,
        url: `${PUBLIC_BASE_URL}${listPath}`,
    });
    sendHtmlWithOg(res, 'catalog-platform.html', og);
}

app.get('/ios', (req, res) => servePlatformCatalogPage(req, res, 'ios'));
app.get('/android', (req, res) => servePlatformCatalogPage(req, res, 'android'));

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
app.use('/api/logs', requirePermission('upload_build'));
app.use('/api/catalog', requirePermission('view_catalog'));

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

function currentPublicHost() {
    try {
        return new URL(PUBLIC_BASE_URL).host;
    } catch (_) {
        return 'share-ipa.vunt.site';
    }
}

function rewritePublicUrl(value) {
    if (!value || typeof value !== 'string') return value;
    const host = currentPublicHost();
    let out = value;
    for (const legacy of LEGACY_PUBLIC_HOSTS) {
        if (!legacy || legacy === host) continue;
        if (out.includes(legacy)) out = out.split(legacy).join(host);
    }
    return out;
}

function withCurrentPublicUrls(item) {
    if (!item || typeof item !== 'object') return item;
    const next = { ...item };
    for (const key of ['shareUrl', 'downloadUrl', 'icon', 'qr', 'productIcon', 'productBanner', 'banner']) {
        if (typeof next[key] === 'string') next[key] = rewritePublicUrl(next[key]);
    }
    return next;
}

function buildClientDownloadUrl(record, baseUrl) {
    if (!record || !record.id || !baseUrl) return null;
    const platform = record.platform || 'ios';
    if (platform === 'android') {
        return `${baseUrl}/uploads/${encodeURIComponent(record.id)}`;
    }
    const plistFilename = record.id.toLowerCase().endsWith('.plist')
        ? record.id
        : `${record.id}.plist`;
    const manifestUrl = `${baseUrl}/uploads/${encodeURIComponent(plistFilename)}`;
    return `itms-services://?action=download-manifest&url=${encodeURIComponent(manifestUrl)}`;
}

// Chuẩn hóa bản ghi trả client: có id + cờ localFileAvailable để frontend ưu tiên LAN
function toClientBuild(record, req) {
    if (!record) return null;
    const item = withCurrentPublicUrls({ ...record });
    const id = item.id || null;
    const localFileAvailable = !!(id && uploadsFileExists(id));
    item.localFileAvailable = localFileAvailable;

    if (localFileAvailable && req && isLanRequest(req)) {
        const lanDownload = buildClientDownloadUrl(item, requestBaseUrl(req));
        if (lanDownload) item.downloadUrl = lanDownload;
    }
    return item;
}

function uploadsFileExists(filename) {
    const safe = path.basename(filename || '');
    if (!safe || safe !== filename) return false;
    try {
        return fs.existsSync(path.join(UPLOADS_MAIN_DIR, safe));
    } catch (_) {
        return false;
    }
}

function fallbackBuildFromId(targetId) {
    const id = String(targetId || '').replace(/\.plist$/i, '');
    if (!id) return null;
    const isAndroid = id.toLowerCase().endsWith('.apk');
    if (isAndroid) {
        if (!uploadsFileExists(id)) return null;
        return withCurrentPublicUrls({
            id,
            platform: 'android',
            appName: id,
            shareUrl: `${PUBLIC_BASE_URL}/install?id=${encodeURIComponent(id)}`,
            downloadUrl: `${PUBLIC_BASE_URL}/uploads/${id}`,
        });
    }

    const plistFilename = `${id}.plist`;
    if (!uploadsFileExists(id) && !uploadsFileExists(plistFilename)) return null;
    const manifestUrl = `${PUBLIC_BASE_URL}/uploads/${plistFilename}`;
    return withCurrentPublicUrls({
        id,
        platform: 'ios',
        appName: id,
        shareUrl: `${PUBLIC_BASE_URL}/install?plist=${encodeURIComponent(plistFilename)}`,
        downloadUrl: `itms-services://?action=download-manifest&url=${encodeURIComponent(manifestUrl)}`,
    });
}

function catalogPathForPlatform(platform) {
    return platform === 'android' ? CATALOG_ANDROID_PATH : CATALOG_IOS_PATH;
}

// 📚 Đọc danh mục theo platform (ios/android). Không truyền platform → gộp cả hai.
async function readCatalog(platform) {
    if (!github.isConfigured()) return [];
    if (platform === 'ios' || platform === 'android') {
        const file = await github.getFile(catalogPathForPlatform(platform));
        if (!file) return [];
        try {
            const parsed = JSON.parse(file.content);
            return Array.isArray(parsed) ? parsed.map(withCurrentPublicUrls) : [];
        } catch (err) {
            console.error(`Không đọc được ${catalogPathForPlatform(platform)}:`, err.message);
            return [];
        }
    }
    // Gộp cả hai danh mục
    const [ios, android] = await Promise.all([readCatalog('ios'), readCatalog('android')]);
    return [...ios, ...android];
}

// Đọc file catalog theo platform kèm sha (cần sha để ghi đè an toàn qua GitHub API)
async function loadCatalogFile(platform) {
    const filePath = catalogPathForPlatform(platform);
    const file = await github.getFile(filePath);
    let list = [];
    let sha;
    if (file) {
        sha = file.sha;
        try {
            const parsed = JSON.parse(file.content);
            if (Array.isArray(parsed)) list = parsed;
        } catch (err) {
            logToUI(`⚠️ ${filePath} hiện tại không hợp lệ, sẽ khởi tạo lại. (${err.message})`, 'info');
        }
    }
    return { list, sha };
}

// ─── Download products / shares (GitHub JSON) ───────────────────────────────
function makeShortId() {
    return require('crypto').randomBytes(6).toString('hex');
}

async function readJsonArrayFile(filePath) {
    if (!github.isConfigured()) return [];
    const file = await github.getFile(filePath);
    if (!file) return [];
    try {
        const parsed = JSON.parse(file.content);
        return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
        console.error(`Không đọc được ${filePath}:`, err.message);
        return [];
    }
}

async function loadJsonArrayFile(filePath) {
    const file = await github.getFile(filePath);
    let list = [];
    let sha;
    if (file) {
        sha = file.sha;
        try {
            const parsed = JSON.parse(file.content);
            if (Array.isArray(parsed)) list = parsed;
        } catch (err) {
            logToUI(`⚠️ ${filePath} không hợp lệ, sẽ khởi tạo lại. (${err.message})`, 'info');
        }
    }
    return { list, sha };
}

async function saveJsonArrayFile(filePath, list, message, sha) {
    await github.putFile(filePath, JSON.stringify(list, null, 2), message, sha);
}

// Lưu data URL ảnh vào /uploads/download-assets, trả về URL public (tránh nhồi base64 vào GitHub JSON)
function persistDownloadImage(dataUrlOrUrl, kind) {
    const raw = (dataUrlOrUrl || '').toString().trim();
    if (!raw) return null;
    if (/^https?:\/\//i.test(raw) || raw.startsWith('/uploads/')) return rewritePublicUrl(raw);

    const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/i.exec(raw);
    if (!match) return null;

    const mime = match[1].toLowerCase();
    const extMap = {
        'image/jpeg': 'jpg',
        'image/jpg': 'jpg',
        'image/png': 'png',
        'image/webp': 'webp',
        'image/gif': 'gif',
    };
    const ext = extMap[mime] || 'png';
    const buf = Buffer.from(match[2], 'base64');
    if (buf.length > 2 * 1024 * 1024) {
        throw new Error(`Ảnh ${kind} vượt quá 2MB sau khi nén.`);
    }

    const dir = path.join(UPLOADS_MAIN_DIR, 'download-assets');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const filename = `dl_${kind}_${Date.now()}_${makeShortId()}.${ext}`;
    fs.writeFileSync(path.join(dir, filename), buf);
    return `${PUBLIC_BASE_URL}/uploads/download-assets/${encodeURIComponent(filename)}`;
}

function publicProduct(p) {
    return withCurrentPublicUrls({
        id: p.id,
        name: p.name,
        iosBundleId: p.iosBundleId || '',
        androidBundleId: p.androidBundleId || '',
        icon: p.icon || null,
        banner: p.banner || null,
        createdAt: p.createdAt || null,
        createdBy: p.createdBy || null,
        updatedAt: p.updatedAt || null,
    });
}

function publicShare(s) {
    return withCurrentPublicUrls({
        id: s.id,
        productId: s.productId,
        productName: s.productName || '',
        productIcon: s.productIcon || null,
        productBanner: s.productBanner || null,
        iosBuildId: s.iosBuildId || null,
        androidBuildId: s.androidBuildId || null,
        iosVersion: s.iosVersion || null,
        iosBuildNumber: s.iosBuildNumber || null,
        androidVersion: s.androidVersion || null,
        androidBuildNumber: s.androidBuildNumber || null,
        createdAt: s.createdAt || null,
        createdBy: s.createdBy || null,
        shareUrl: `${PUBLIC_BASE_URL}/dl?s=${encodeURIComponent(s.id)}`,
    });
}

// Xóa file vật lý của một bản build (R2 object + cache LAN local + bản sao lưu trữ + plist)
async function deletePhysicalBuildFiles(record) {
    if (record.r2ObjectKey) {
        await deleteR2Object(record.r2ObjectKey);
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

// 💾 Thêm một bản ghi app mới vào đầu danh mục tương ứng (ios/android) và đẩy lên GitHub.
// Tự động dọn dẹp: giới hạn 10 build/app (R2) và CATALOG_MAX_ITEMS mỗi danh mục.
// Trả về mảng các entry bị xóa (để caller xóa R2 object tương ứng nếu cần).
async function appendToCatalog(record) {
    if (!github.isConfigured()) {
        logToUI('⚠️ Chưa cấu hình GITHUB_TOKEN/GITHUB_REPO nên bỏ qua bước lưu danh mục.', 'info');
        return [];
    }

    const platform = record.platform || 'ios';
    const { list, sha } = await loadCatalogFile(platform);
    const removed = [];

    // Per-app limit: giữ tối đa 10 build/app trong R2 — xóa bản cũ nhất trước khi thêm mới
    if (record.r2ObjectKey && record.bundleId) {
        const MAX_PER_APP = 10;
        const appBuilds = list
            .filter(item => item.bundleId === record.bundleId && item.r2ObjectKey)
            .sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));

        if (appBuilds.length >= MAX_PER_APP) {
            const toEvict = appBuilds.slice(MAX_PER_APP - 1);
            for (const old of toEvict) {
                removed.push(old);
                const idx = list.indexOf(old);
                if (idx !== -1) list.splice(idx, 1);
            }
        }
    }

    list.unshift(record);

    // Per-catalog limit
    if (list.length > CATALOG_MAX_ITEMS) {
        const trimmed = list.splice(CATALOG_MAX_ITEMS);
        removed.push(...trimmed);
    }

    await github.putFile(
        catalogPathForPlatform(platform),
        JSON.stringify(list, null, 2),
        `add ${record.appName} ${record.version} (${record.buildNumber})`,
        sha
    );

    return removed;
}

// /api/catalog/ios — chỉ trả iOS
app.get('/api/catalog/ios', async (req, res) => {
    try {
        const list = await readCatalog('ios');
        res.json({ success: true, configured: github.isConfigured(), items: list.map(item => toClientBuild(item, req)) });
    } catch (err) {
        res.status(500).json({ success: false, message: `Không tải được danh mục iOS: ${err.message}` });
    }
});

// /api/catalog/android — chỉ trả Android
app.get('/api/catalog/android', async (req, res) => {
    try {
        const list = await readCatalog('android');
        res.json({ success: true, configured: github.isConfigured(), items: list.map(item => toClientBuild(item, req)) });
    } catch (err) {
        res.status(500).json({ success: false, message: `Không tải được danh mục Android: ${err.message}` });
    }
});

// /api/catalog — gộp cả hai (backward compat)
app.get('/api/catalog', async (req, res) => {
    try {
        const list = await readCatalog();
        res.json({ success: true, configured: github.isConfigured(), items: list.map(item => toClientBuild(item, req)) });
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

        // Tìm bản build trong đúng catalog theo platform (thử ios trước, sau đó android)
        let list, sha, foundPlatform;
        for (const plt of ['ios', 'android']) {
            const loaded = await loadCatalogFile(plt);
            const idx2 = loaded.list.findIndex(item => item.id === targetId);
            if (idx2 !== -1) {
                list = loaded.list;
                sha = loaded.sha;
                foundPlatform = plt;
                break;
            }
        }

        if (!list) {
            return res.status(404).json({ success: false, message: 'Không tìm thấy bản build này trong danh mục (có thể đã bị xóa).' });
        }

        const idx = list.findIndex(item => item.id === targetId);
        const [removedRecord] = list.splice(idx, 1);
        const actor = req.currentUser.username;

        await github.putFile(
            catalogPathForPlatform(foundPlatform),
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

// ─── Download products (admin tạo) + shares (tester lưu) ────────────────────
app.get('/api/download-products', requirePermission('create_download_link'), async (req, res) => {
    try {
        const list = await readJsonArrayFile(DOWNLOAD_PRODUCTS_PATH);
        const sorted = [...list].sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'vi'));
        res.json({ success: true, items: sorted.map(publicProduct) });
    } catch (err) {
        res.status(500).json({ success: false, message: `Không tải được mục download: ${err.message}` });
    }
});

app.post('/api/download-products', requirePermission('manage_download_products'), async (req, res) => {
    try {
        if (!github.isConfigured()) {
            return res.status(500).json({ success: false, message: 'Chưa cấu hình GitHub nên không thể lưu mục download.' });
        }
        const name = (req.body?.name || '').toString().trim();
        const iosBundleId = (req.body?.iosBundleId || '').toString().trim();
        const androidBundleId = (req.body?.androidBundleId || '').toString().trim();
        let icon = null;
        let banner = null;
        try {
            icon = persistDownloadImage(req.body?.icon, 'icon');
            banner = persistDownloadImage(req.body?.banner, 'banner');
        } catch (imgErr) {
            return res.status(400).json({ success: false, message: imgErr.message });
        }
        if (!name) {
            return res.status(400).json({ success: false, message: 'Thiếu tên mục download.' });
        }
        if (!iosBundleId && !androidBundleId) {
            return res.status(400).json({ success: false, message: 'Cần ít nhất một bundleId (iOS hoặc Android).' });
        }

        const { list, sha } = await loadJsonArrayFile(DOWNLOAD_PRODUCTS_PATH);
        const now = new Date().toISOString();
        const product = {
            id: makeShortId(),
            name,
            iosBundleId,
            androidBundleId,
            icon,
            banner,
            createdAt: now,
            updatedAt: now,
            createdBy: req.currentUser.username,
        };
        list.unshift(product);
        await saveJsonArrayFile(DOWNLOAD_PRODUCTS_PATH, list, `add download product ${name}`, sha);
        logToUI(`📦 ${req.currentUser.username} tạo mục download "${name}"`, 'info');
        return res.json({ success: true, item: publicProduct(product) });
    } catch (err) {
        return res.status(500).json({ success: false, message: `Lỗi tạo mục download: ${err.message}` });
    }
});

app.post('/api/download-products/update', requirePermission('manage_download_products'), async (req, res) => {
    try {
        if (!github.isConfigured()) {
            return res.status(500).json({ success: false, message: 'Chưa cấu hình GitHub nên không thể cập nhật mục download.' });
        }
        const id = (req.body?.id || '').toString().trim();
        const name = (req.body?.name || '').toString().trim();
        const iosBundleId = (req.body?.iosBundleId || '').toString().trim();
        const androidBundleId = (req.body?.androidBundleId || '').toString().trim();
        if (!id) return res.status(400).json({ success: false, message: 'Thiếu id mục download.' });
        if (!name) return res.status(400).json({ success: false, message: 'Thiếu tên mục download.' });
        if (!iosBundleId && !androidBundleId) {
            return res.status(400).json({ success: false, message: 'Cần ít nhất một bundleId (iOS hoặc Android).' });
        }

        const { list, sha } = await loadJsonArrayFile(DOWNLOAD_PRODUCTS_PATH);
        const idx = list.findIndex(item => item.id === id);
        if (idx === -1) return res.status(404).json({ success: false, message: 'Không tìm thấy mục download.' });

        let icon = list[idx].icon || null;
        let banner = list[idx].banner || null;
        try {
            if (Object.prototype.hasOwnProperty.call(req.body || {}, 'icon')) {
                icon = persistDownloadImage(req.body?.icon, 'icon');
            }
            if (Object.prototype.hasOwnProperty.call(req.body || {}, 'banner')) {
                banner = persistDownloadImage(req.body?.banner, 'banner');
            }
        } catch (imgErr) {
            return res.status(400).json({ success: false, message: imgErr.message });
        }

        list[idx] = {
            ...list[idx],
            name,
            iosBundleId,
            androidBundleId,
            icon,
            banner,
            updatedAt: new Date().toISOString(),
        };
        await saveJsonArrayFile(DOWNLOAD_PRODUCTS_PATH, list, `update download product ${name}`, sha);
        return res.json({ success: true, item: publicProduct(list[idx]) });
    } catch (err) {
        return res.status(500).json({ success: false, message: `Lỗi cập nhật mục download: ${err.message}` });
    }
});

app.post('/api/download-products/delete', requirePermission('manage_download_products'), async (req, res) => {
    try {
        if (!github.isConfigured()) {
            return res.status(500).json({ success: false, message: 'Chưa cấu hình GitHub nên không thể xóa mục download.' });
        }
        const id = (req.body?.id || '').toString().trim();
        const { list, sha } = await loadJsonArrayFile(DOWNLOAD_PRODUCTS_PATH);
        const idx = list.findIndex(item => item.id === id);
        if (idx === -1) return res.status(404).json({ success: false, message: 'Không tìm thấy mục download.' });
        const [removed] = list.splice(idx, 1);
        await saveJsonArrayFile(DOWNLOAD_PRODUCTS_PATH, list, `delete download product ${removed.name}`, sha);

        try {
            const sharesFile = await loadJsonArrayFile(DOWNLOAD_SHARES_PATH);
            const nextShares = sharesFile.list.filter(s => s.productId !== id);
            if (nextShares.length !== sharesFile.list.length) {
                await saveJsonArrayFile(
                    DOWNLOAD_SHARES_PATH,
                    nextShares,
                    `cleanup shares for deleted product ${removed.name}`,
                    sharesFile.sha
                );
            }
        } catch (_) { /* không chặn xóa product */ }

        logToUI(`🗑️ ${req.currentUser.username} xóa mục download "${removed.name}"`, 'info');
        return res.json({ success: true, removed: publicProduct(removed) });
    } catch (err) {
        return res.status(500).json({ success: false, message: `Lỗi xóa mục download: ${err.message}` });
    }
});

app.get('/api/download-products/:id/builds', requirePermission('create_download_link'), async (req, res) => {
    try {
        const id = (req.params.id || '').toString().trim();
        const products = await readJsonArrayFile(DOWNLOAD_PRODUCTS_PATH);
        const product = products.find(item => item.id === id);
        if (!product) return res.status(404).json({ success: false, message: 'Không tìm thấy mục download.' });

        const catalog = await readCatalog();
        const mapBuild = (item) => ({
            id: item.id,
            appName: item.appName,
            bundleId: item.bundleId,
            platform: item.platform || 'ios',
            version: item.version,
            buildNumber: item.buildNumber,
            icon: item.icon,
            uploadedAt: item.uploadedAt,
            shareUrl: item.shareUrl,
            downloadUrl: item.downloadUrl,
            qr: item.qr || null,
        });
        const sortBuilds = (a, b) => (new Date(b.uploadedAt).getTime() || 0) - (new Date(a.uploadedAt).getTime() || 0);

        const ios = product.iosBundleId
            ? catalog
                .filter(item => (item.bundleId || '') === product.iosBundleId)
                .filter(item => (item.platform || 'ios') !== 'android')
                .map(mapBuild)
                .sort(sortBuilds)
            : [];
        const android = product.androidBundleId
            ? catalog
                .filter(item => (item.bundleId || '') === product.androidBundleId)
                .filter(item => (item.platform || 'ios') === 'android')
                .map(mapBuild)
                .sort(sortBuilds)
            : [];

        const icon = (ios[0] && ios[0].icon) || (android[0] && android[0].icon) || null;
        return res.json({
            success: true,
            product: publicProduct(product),
            ios,
            android,
            icon,
        });
    } catch (err) {
        return res.status(500).json({ success: false, message: `Không tải được bản build: ${err.message}` });
    }
});

app.get('/api/download-shares', requirePermission('create_download_link'), async (req, res) => {
    try {
        const productId = (req.query.productId || '').toString().trim();
        let list = await readJsonArrayFile(DOWNLOAD_SHARES_PATH);
        if (productId) list = list.filter(item => item.productId === productId);
        list = [...list].sort((a, b) => (new Date(b.createdAt).getTime() || 0) - (new Date(a.createdAt).getTime() || 0));
        res.json({ success: true, items: list.map(publicShare) });
    } catch (err) {
        res.status(500).json({ success: false, message: `Không tải được link đã lưu: ${err.message}` });
    }
});

app.post('/api/download-shares', requirePermission('create_download_link'), async (req, res) => {
    try {
        if (!github.isConfigured()) {
            return res.status(500).json({ success: false, message: 'Chưa cấu hình GitHub nên không thể lưu link.' });
        }
        const productId = (req.body?.productId || '').toString().trim();
        const iosBuildId = (req.body?.iosBuildId || '').toString().trim() || null;
        const androidBuildId = (req.body?.androidBuildId || '').toString().trim() || null;
        if (!productId) return res.status(400).json({ success: false, message: 'Thiếu productId.' });
        if (!iosBuildId && !androidBuildId) {
            return res.status(400).json({ success: false, message: 'Cần chọn ít nhất một bản iOS hoặc Android.' });
        }

        const products = await readJsonArrayFile(DOWNLOAD_PRODUCTS_PATH);
        const product = products.find(item => item.id === productId);
        if (!product) return res.status(404).json({ success: false, message: 'Không tìm thấy mục download.' });

        const catalog = await readCatalog();
        const iosBuild = iosBuildId ? catalog.find(item => item.id === iosBuildId) : null;
        const androidBuild = androidBuildId ? catalog.find(item => item.id === androidBuildId) : null;
        if (iosBuildId && !iosBuild) {
            return res.status(400).json({ success: false, message: 'Không tìm thấy bản iOS đã chọn.' });
        }
        if (androidBuildId && !androidBuild) {
            return res.status(400).json({ success: false, message: 'Không tìm thấy bản Android đã chọn.' });
        }
        if (iosBuild && product.iosBundleId && iosBuild.bundleId !== product.iosBundleId) {
            return res.status(400).json({ success: false, message: 'Bản iOS không thuộc mục download này.' });
        }
        if (androidBuild && product.androidBundleId && androidBuild.bundleId !== product.androidBundleId) {
            return res.status(400).json({ success: false, message: 'Bản Android không thuộc mục download này.' });
        }

        const { list, sha } = await loadJsonArrayFile(DOWNLOAD_SHARES_PATH);
        const share = {
            id: makeShortId(),
            productId: product.id,
            productName: product.name,
            productIcon: product.icon || null,
            productBanner: product.banner || null,
            iosBuildId,
            androidBuildId,
            iosVersion: iosBuild ? iosBuild.version : null,
            iosBuildNumber: iosBuild ? iosBuild.buildNumber : null,
            androidVersion: androidBuild ? androidBuild.version : null,
            androidBuildNumber: androidBuild ? androidBuild.buildNumber : null,
            createdAt: new Date().toISOString(),
            createdBy: req.currentUser.username,
        };
        list.unshift(share);
        // Giữ tối đa 500 share
        if (list.length > 500) list.length = 500;
        await saveJsonArrayFile(
            DOWNLOAD_SHARES_PATH,
            list,
            `add download share ${product.name} by ${req.currentUser.username}`,
            sha
        );
        return res.json({ success: true, item: publicShare(share) });
    } catch (err) {
        return res.status(500).json({ success: false, message: `Lỗi lưu link: ${err.message}` });
    }
});

app.post('/api/download-shares/delete', requirePermission('create_download_link'), async (req, res) => {
    try {
        if (!github.isConfigured()) {
            return res.status(500).json({ success: false, message: 'Chưa cấu hình GitHub nên không thể xóa link.' });
        }
        const id = (req.body?.id || '').toString().trim();
        const { list, sha } = await loadJsonArrayFile(DOWNLOAD_SHARES_PATH);
        const idx = list.findIndex(item => item.id === id);
        if (idx === -1) return res.status(404).json({ success: false, message: 'Không tìm thấy link đã lưu.' });

        const share = list[idx];
        const isAdmin = auth.hasPermission(req.currentUser, 'manage_download_products');
        if (!isAdmin && share.createdBy !== req.currentUser.username) {
            return res.status(403).json({ success: false, message: 'Bạn chỉ có thể xóa link do mình tạo.' });
        }
        list.splice(idx, 1);
        await saveJsonArrayFile(DOWNLOAD_SHARES_PATH, list, `delete download share ${id}`, sha);
        return res.json({ success: true });
    } catch (err) {
        return res.status(500).json({ success: false, message: `Lỗi xóa link: ${err.message}` });
    }
});

// Public: resolve share đã lưu cho trang /dl?s=
app.get('/api/download-shares/:id', async (req, res) => {
    try {
        const id = (req.params.id || '').toString().trim();
        const list = await readJsonArrayFile(DOWNLOAD_SHARES_PATH);
        const share = list.find(item => item.id === id);
        if (!share) return res.status(404).json({ success: false, message: 'Không tìm thấy link chia sẻ.' });

        const enriched = { ...share };
        if ((!enriched.productIcon || !enriched.productBanner || !enriched.productName) && enriched.productId) {
            const products = await readJsonArrayFile(DOWNLOAD_PRODUCTS_PATH);
            const product = products.find(item => item.id === enriched.productId);
            if (product) {
                if (!enriched.productName) enriched.productName = product.name || '';
                if (!enriched.productIcon) enriched.productIcon = product.icon || null;
                if (!enriched.productBanner) enriched.productBanner = product.banner || null;
            }
        }

        return res.json({ success: true, item: publicShare(enriched) });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
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
        const record = list.find(item => item.id === targetId) || fallbackBuildFromId(targetId);

        if (!record) {
            return res.status(404).json({ success: false, message: 'Không tìm thấy thông tin bản build này.' });
        }

        const item = toClientBuild(record, req);
        return res.json({
            success: true,
            item: {
                id: item.id,
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
                fileSize: item.fileSize,
                uploadedAt: item.uploadedAt,
                shareUrl: item.shareUrl,
                downloadUrl: item.downloadUrl,
                localFileAvailable: !!item.localFileAvailable,
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
            .map(item => {
                const b = toClientBuild(item, req);
                return {
                    id: b.id,
                    appName: b.appName,
                    bundleId: b.bundleId,
                    platform: b.platform || 'ios',
                    version: b.version,
                    buildNumber: b.buildNumber,
                    minimumOsVersion: b.minimumOsVersion || null,
                    profileType: b.profileType || null,
                    provisionedDevices: b.provisionedDevices || null,
                    provisionedDevicesCount: b.provisionedDevicesCount ?? null,
                    icon: b.icon,
                    qr: b.qr,
                    fileSize: b.fileSize,
                    uploadedAt: b.uploadedAt,
                    shareUrl: b.shareUrl,
                    downloadUrl: b.downloadUrl,
                    localFileAvailable: !!b.localFileAvailable,
                    uploadedBy: b.uploadedBy || null,
                };
            })
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
                    // ── R2 mode: file trên R2; bản local được giữ ở r2-finalize để phục vụ LAN ──

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

                    // Xóa R2 + cache LAN local của các entry bị loại khỏi danh mục
                    for (const item of removedFromCatalog) {
                        await deletePhysicalBuildFiles(item);
                        logToUI(`🗑️ Cleanup: ${item.appName} ${item.version} (${item.fileSize || ''})`, 'info');
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
    const viaLan = isLanRequest(req);
    if (viaLan) {
        await logRealtime(
            `📡 LAN direct upload — đã nhận ${formatBytes(req.file.size)} (không qua R2/Tunnel).`,
            'success'
        );
    }
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
    if (isLanRequest(req)) {
        logToUI('📡 Cùng mạng LAN — nhận file trực tiếp, không qua R2.', 'info');
        return res.json({ success: true, r2Available: false, skipReason: 'lan' });
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

        // Xử lý nền: tải IPA từ R2 về máy → parse → giữ bản local (LAN cache) → trả kết quả
        (async () => {
            const tmpFilename = `tmp_${jobId}_${path.basename(objectKey)}`;
            const tmpPath = path.join(UPLOADS_MAIN_DIR, tmpFilename);
            let keepLocalCache = false;
            let finalFilename = path.basename(objectKey);
            try {
                await logRealtime('☁️ R2 đã nhận xong. Đang tải file về máy chủ để phân tích...', 'info');

                const { Body } = await r2Client.send(new _R2Cmd.GetObjectCommand({
                    Bucket: process.env.R2_BUCKET,
                    Key: objectKey,
                }));
                await streamToFile(Body, tmpPath);

                const fileStat = await fs.promises.stat(tmpPath);
                await logRealtime(`✅ Đã tải về (${formatBytes(fileStat.size)}). Đang phân tích metadata...`, 'success');

                finalFilename = path.basename(objectKey);
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
                    keepLocalCache = true;
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
                if (keepLocalCache) {
                    const destPath = path.join(UPLOADS_MAIN_DIR, finalFilename);
                    try {
                        if (path.resolve(tmpPath) !== path.resolve(destPath)) {
                            await fs.promises.rename(tmpPath, destPath).catch(async () => {
                                await fs.promises.copyFile(tmpPath, destPath);
                                await fs.promises.unlink(tmpPath);
                            });
                        }
                        await logRealtime('📡 Đã giữ bản local để tải nhanh qua LAN.', 'info');
                    } catch (cacheErr) {
                        logToUI(`⚠️ Không giữ được cache LAN: ${cacheErr.message}`, 'info');
                        fs.promises.unlink(tmpPath).catch(() => {});
                    }
                } else {
                    fs.promises.unlink(tmpPath).catch(() => {});
                }
            }
        })();
    } catch (err) {
        logToUI(`❌ Lỗi r2-finalize: ${err.message}`, 'error');
        return res.status(500).json({ success: false, message: `Lỗi hoàn tất R2 upload: ${err.message}` });
    }
});
// ─────────────────────────────────────────────────────────────────────────────

// Xóa catalog.json cũ (đã tách thành catalog-ios.json / catalog-android.json)
(async () => {
    if (!github.isConfigured()) return;
    try {
        const old = await github.getFile('catalog.json');
        if (!old) return;
        console.log('[MIGRATE] Xóa catalog.json cũ khỏi GitHub...');
        const { Octokit } = await import('@octokit/rest').catch(() => null) || {};
        // Dùng GitHub API xóa file: PUT với content rỗng không work — dùng DELETE endpoint
        const { token, repo, branch } = github.getConfig();
        const [owner, repoName] = repo.split('/');
        const delRes = await fetch(`https://api.github.com/repos/${repo}/contents/catalog.json`, {
            method: 'DELETE',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ message: 'remove legacy catalog.json (split to ios/android)', sha: old.sha, branch }),
        });
        if (delRes.ok) {
            console.log('[MIGRATE] ✅ Đã xóa catalog.json cũ.');
        } else {
            const txt = await delRes.text();
            console.warn('[MIGRATE] ⚠️ Không xóa được catalog.json:', txt);
        }
    } catch (err) {
        console.warn('[MIGRATE] ⚠️ Lỗi migration catalog.json:', err.message);
    }
})();

function listRegisteredApiRoutes() {
    try {
        const stack = (app.router && app.router.stack) || [];
        return stack
            .filter((layer) => layer.route && String(layer.route.path || '').startsWith('/api/'))
            .map((layer) => {
                const methods = Object.keys(layer.route.methods || {})
                    .filter((m) => layer.route.methods[m])
                    .map((m) => m.toUpperCase());
                return `${methods.join(',') || 'ALL'} ${layer.route.path}`;
            });
    } catch (_) {
        return [];
    }
}

function tryHandleLanRequest(req, res) {
    const method = req.method || 'GET';
    if (method !== 'GET' && method !== 'OPTIONS') return false;
    let pathname = '/';
    try {
        pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname;
    } catch (_) {
        pathname = String(req.url || '/').split('?')[0] || '/';
    }
    if (
        pathname !== '/api/lan-info'
        && pathname !== '/api/lan'
        && pathname !== '/api/lan-ping'
        && pathname !== '/api/lan-pixel'
    ) {
        return false;
    }

    if (method === 'OPTIONS') {
        setLanCors(res);
        res.writeHead(204);
        res.end();
        return true;
    }
    if (pathname === '/api/lan-ping') {
        setLanCors(res);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok: true, t: Date.now() }));
        return true;
    }
    if (pathname === '/api/lan-pixel') {
        setLanCors(res);
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
        res.end(LAN_PIXEL_PNG);
        return true;
    }

    const baseUrl = resolveConfiguredLanBaseUrl();
    const candidates = getLanCandidateBaseUrls();
    const body = {
        success: true,
        enabled: !!baseUrl,
        baseUrl: baseUrl || null,
        candidates,
        addresses: getLanIpv4Addresses(),
        publicBaseUrl: PUBLIC_BASE_URL,
        viaLanHost: false,
        pid: process.pid,
    };
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
    return true;
}

// Bắt /api/lan* ở tầng http.Server — trước Express — để tránh lỗi match route
const server = http.createServer((req, res) => {
    if (tryHandleLanRequest(req, res)) return;
    return app(req, res);
});

server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
        console.error(`[FATAL] Cổng ${PORT} đang bị chiếm (EADDRINUSE). Chạy: sudo lsof -nP -iTCP:${PORT} -sTCP:LISTEN`);
    } else {
        console.error('[FATAL] HTTP server error:', err);
    }
    process.exit(1);
});

// Chỉ listen localhost — Caddy (:3080) và cloudflared proxy vào đây.
// Tránh bind 0.0.0.0 (dễ EADDRINUSE / lệch IPv4 vs IPv6 với process cũ).
server.listen(PORT, '127.0.0.1', () => {
    const lanBase = resolveConfiguredLanBaseUrl();
    const candidates = getLanCandidateBaseUrls();
    console.log(`Diawi Local-First System active on port ${PORT} (pid ${process.pid})`);
    if (lanBase) {
        console.log(`[LAN] Tải nhanh nội bộ: ${lanBase} (set LAN_BASE_URL trong .env nếu cần)`);
        if (candidates.length > 1) {
            console.log('[LAN] Ứng viên:', candidates.join(', '));
        }
    } else {
        console.log('[LAN] Không phát hiện IP LAN — chỉ phục vụ qua PUBLIC_BASE_URL.');
    }

    const apiRoutes = listRegisteredApiRoutes();
    const lanRoutes = apiRoutes.filter((r) => r.includes('/api/lan'));
    console.log(`[LAN] Express routes: ${lanRoutes.length ? lanRoutes.join(' | ') : '(none)'}`);

    httpGetJson(`http://127.0.0.1:${PORT}/api/lan-info`)
        .then((body) => {
            console.log('[LAN] Self-check OK:', body && body.baseUrl ? body.baseUrl : body, 'pid=', body && body.pid);
        })
        .catch((err) => {
            console.error('[LAN] Self-check FAIL:', err.message);
        });
});
server.timeout = 600000;
server.keepAliveTimeout = 600000;

function httpGetJson(url) {
    return new Promise((resolve, reject) => {
        const req = http.get(url, { timeout: 3000 }, (res) => {
            let raw = '';
            res.on('data', (c) => { raw += c; });
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    try { resolve(JSON.parse(raw)); }
                    catch (e) { reject(new Error(`JSON parse fail: ${raw.slice(0, 200)}`)); }
                } else {
                    reject(new Error(`HTTP ${res.statusCode}: ${raw.replace(/\s+/g, ' ').slice(0, 200)}`));
                }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
}