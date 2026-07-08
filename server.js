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

const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'https://share-ipa.vunt.info';
const CATALOG_PATH = 'catalog.json';       // Chỉ mục danh sách app trên repo lưu trữ
const CATALOG_MAX_ITEMS = 200;             // Giới hạn số bản ghi giữ lại trong danh mục

console.log('========== ENV ==========');
console.log('__dirname:', __dirname);
console.log('cwd:', process.cwd());

console.log('ACCESS_USERNAME:', process.env.ACCESS_USERNAME);
console.log('ACCESS_PASSWORD:', process.env.ACCESS_PASSWORD);

console.log('USERNAME:', process.env.USERNAME);
console.log('PASSWORD:', process.env.PASSWORD);

console.log('GITHUB_REPO:', process.env.GITHUB_REPO);
console.log('GITHUB_TOKEN:', process.env.GITHUB_TOKEN ? '***(đã cấu hình)' : '(chưa cấu hình)');

console.log('=========================');

const app = express();
const PORT = 3000;
const AUTH_COOKIE_NAME = 'share_ipa_auth';

const UPLOADS_MAIN_DIR = '/Users/sds/dev/share_ipa/uploads';
const ARCHIVE_STORAGE_DIR = '/Users/sds/dev/share_ipa/storage';

if (!fs.existsSync(UPLOADS_MAIN_DIR)) fs.mkdirSync(UPLOADS_MAIN_DIR, { recursive: true });
if (!fs.existsSync(ARCHIVE_STORAGE_DIR)) fs.mkdirSync(ARCHIVE_STORAGE_DIR, { recursive: true });

// Tối ưu bộ nhớ: Lưu thẳng file vào đĩa thay vì ngậm trên RAM để tránh crash khi nhiều người upload cùng lúc
const storage = multer.diskStorage({
    destination: (req, file, cb) => { cb(null, UPLOADS_MAIN_DIR); },
    filename: (req, file, cb) => { cb(null, `app_${Date.now()}_${file.originalname}`); }
});
const upload = multer({ storage: storage, limits: { fileSize: 200 * 1024 * 1024 } }); // Hạn mức hẳn 200MB

function parseCookies(cookieHeader = '') {
    return cookieHeader.split(';').reduce((acc, part) => {
        const [rawKey, ...rawValue] = part.trim().split('=');
        if (!rawKey) return acc;
        acc[decodeURIComponent(rawKey)] = decodeURIComponent(rawValue.join('='));
        return acc;
    }, {});
}

function getConfiguredCredentials() {
    return {
        username: process.env.ACCESS_USERNAME?.trim() || '',
        password: process.env.ACCESS_PASSWORD?.trim() || ''
    };
}

function isAuthenticated(req) {
    const cookies = parseCookies(req.headers.cookie || '');
    return cookies[AUTH_COOKIE_NAME] === 'true';
}

function requireAuth(req, res, next) {
    if (isAuthenticated(req)) return next();
    return res.status(401).json({ success: false, message: 'Vui lòng đăng nhập trước khi sử dụng.' });
}

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Trang chính và tài nguyên tĩnh mở tự do (không bắt buộc đăng nhập)
app.use(express.static('public'));
app.use('/uploads', express.static(UPLOADS_MAIN_DIR));
app.use('/storage', express.static(ARCHIVE_STORAGE_DIR));

// Đường dẫn /login cũ giờ trỏ thẳng về trang chính (ô đăng nhập nằm ngay trong trang)
app.get('/login', (req, res) => res.redirect('/'));

// Trang cài đặt độc lập cho người quét QR (mở màn hình riêng, chỉ hiện 1 bản build)
app.get('/install', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'install.html'));
});

// Kiểm tra trạng thái đăng nhập cho frontend
app.get('/api/auth-status', (req, res) => {
    res.json({ authenticated: isAuthenticated(req) });
});

// Đăng nhập bằng AJAX ngay trong trang chính
app.post('/api/login', (req, res) => {
    const { username = '', password = '' } = req.body || {};
    const configured = getConfiguredCredentials();

    const typedUsername = username.toString().trim();
    const typedPassword = password.toString().trim();

    if (typedUsername === configured.username &&
        typedPassword === configured.password) {

        res.setHeader(
            'Set-Cookie',
            `${AUTH_COOKIE_NAME}=true; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`
        );

        return res.json({ success: true });
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

// Chỉ bảo vệ các API nhạy cảm phía sau
app.use('/api/upload-secure', requireAuth);
app.use('/api/logs', requireAuth);
app.use('/api/catalog', requireAuth);

const systemLogs = [];
let logClients = [];

function logToUI(message, type = 'info') {
    const time = new Date().toLocaleTimeString();
    const logEntry = { time, message, type };
    systemLogs.push(logEntry);
    if (systemLogs.length > 100) systemLogs.shift();
    logClients.forEach(client => client.res.write(`data: ${JSON.stringify(logEntry)}\n\n`));
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

// 💾 Thêm một bản ghi app mới vào đầu danh mục và đẩy lên GitHub
async function appendToCatalog(record) {
    if (!github.isConfigured()) {
        logToUI('⚠️ Chưa cấu hình GITHUB_TOKEN/GITHUB_REPO nên bỏ qua bước lưu danh mục.', 'info');
        return;
    }

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

    list.unshift(record);
    if (list.length > CATALOG_MAX_ITEMS) list = list.slice(0, CATALOG_MAX_ITEMS);

    await github.putFile(
        CATALOG_PATH,
        JSON.stringify(list, null, 2),
        `add ${record.appName} ${record.version} (${record.buildNumber})`,
        sha
    );
}

app.get('/api/catalog', async (req, res) => {
    try {
        const list = await readCatalog();
        res.json({ success: true, configured: github.isConfigured(), items: list });
    } catch (err) {
        res.status(500).json({ success: false, message: `Không tải được danh mục: ${err.message}` });
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
                version: record.version,
                buildNumber: record.buildNumber,
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

app.get('/api/logs', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    systemLogs.forEach(log => res.write(`data: ${JSON.stringify(log)}\n\n`));
    const clientId = Date.now();
    logClients.push({ id: clientId, res });
    req.on('close', () => { logClients = logClients.filter(client => client.id !== clientId); });
});

// Endpoint siêu tốc: Xử lý local, không đẩy file nặng qua bên thứ 3
app.post('/api/upload-secure', upload.single('ipaFile'), async (req, res) => {
    const startTime = performance.now();

    if (!req.file) {
        return res.status(400).json({ success: false, message: 'Không tìm thấy tệp tin IPA.' });
    }

    const finalFilename = req.file.filename;
    const finalPath = req.file.path;
    const formattedTotalSize = formatBytes(req.file.size);

    try {
        logToUI(`📥 Đã nhận và lưu kho tệp tin (${formattedTotalSize}) thành công vào ổ đĩa Mac!`, 'success');
        logToUI(`⚡ Bắt đầu bóc tách Metadata IPA bằng AppInfoParser...`, 'info');

        const parser = new AppInfoParser(finalPath);

        try {
            const result = await parser.parse();
            const appInfo = {
                bundleId: result.CFBundleIdentifier || 'com.unknown.app',
                version: result.CFBundleShortVersionString || '1.0.0',
                buildNumber: result.CFBundleVersion || '1',
                appName: result.CFBundleDisplayName || result.CFBundleName || 'Ứng dụng iOS'
            };

            const iconBase64 = result.icon || 'https://cdn-icons-png.flaticon.com/512/5115/5115293.png';
            const totalProcessTime = ((performance.now() - startTime) / 1000).toFixed(2);

            logToUI(`✅ Phân tích cấu trúc thành công: ${appInfo.appName} | Phiên bản: ${appInfo.version} trong ${totalProcessTime} giây`, 'success');

            // 📁 Phân loại lưu trữ lâu dài
            const safeAppName = appInfo.appName.replace(/[/\\?%*:|"<>\s]/g, '_');
            const appStorageDirName = `${safeAppName}_${appInfo.bundleId}`;
            const targetAppFolder = path.join(ARCHIVE_STORAGE_DIR, appStorageDirName);

            if (!fs.existsSync(targetAppFolder)) fs.mkdirSync(targetAppFolder, { recursive: true });

            // Sao chép sang bộ lưu trữ lưu trữ song song
            fs.copyFileSync(finalPath, path.join(targetAppFolder, finalFilename));

            // Lưu file cấu hình lịch sử dạng JSON
            const metadataInfo = {
                ...appInfo,
                filename: finalFilename,
                fileSize: formattedTotalSize,
                uploadedAt: new Date().toISOString(),
                processTimeSeconds: totalProcessTime
            };
            fs.writeFileSync(path.join(targetAppFolder, `${finalFilename}.json`), JSON.stringify(metadataInfo, null, 4));

            // 🧹 Kiểm soát dọn dẹp (Giới hạn tối đa 10 bản build gần nhất)
            const currentFiles = fs.readdirSync(targetAppFolder);
            const ipaFiles = currentFiles
                .filter(f => f.endsWith('.ipa'))
                .map(f => {
                    const filePath = path.join(targetAppFolder, f);
                    return { name: f, path: filePath, ctime: fs.statSync(filePath).ctimeMs };
                })
                .sort((a, b) => a.ctime - b.ctime);

            if (ipaFiles.length > 10) {
                const deleteCount = ipaFiles.length - 10;
                logToUI(`⚠️ Vượt quá 10 bản build. Tiến hành tự động xóa bỏ ${deleteCount} tệp cũ...`, 'info');
                for (let k = 0; k < deleteCount; k++) {
                    if (fs.existsSync(ipaFiles[k].path)) fs.unlinkSync(ipaFiles[k].path);
                    if (fs.existsSync(ipaFiles[k].path + '.json')) fs.unlinkSync(ipaFiles[k].path + '.json');
                }
            }

            // 🌐 TẠO FILE PLIST ĐỂ PHỤC VỤ CÀI ĐẶT OTA PUBLIC QUA CLOUDFLARE HTTPS
            const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>items</key><array><dict><key>assets</key><array><dict><key>kind</key><string>software-package</string><key>url</key><string>${PUBLIC_BASE_URL}/uploads/${finalFilename}</string></dict></array><key>metadata</key><dict><key>bundle-identifier</key><string>${appInfo.bundleId}</string><key>bundle-version</key><string>${appInfo.version}</string><key>kind</key><string>software</string><key>title</key><string>${appInfo.appName}</string></dict></dict></array></dict></plist>`;

            const plistFilename = `${finalFilename}.plist`;
            fs.writeFileSync(path.join(UPLOADS_MAIN_DIR, plistFilename), plistContent);

            const manifestUrl = `${PUBLIC_BASE_URL}/uploads/${plistFilename}`;
            const downloadUrl = `itms-services://?action=download-manifest&url=${encodeURIComponent(manifestUrl)}`;
            const shareUrl = `${PUBLIC_BASE_URL}/install?plist=${plistFilename}`;

            logToUI(`🎉 Toàn bộ quy trình hoàn tất! Sẵn sàng chia sẻ dữ liệu công khai.`, 'success');

            // 🔳 Tạo ảnh QR (data URL) từ link cài đặt để lưu vĩnh viễn trong danh mục
            let qrDataUrl = '';
            try {
                qrDataUrl = await QRCode.toDataURL(shareUrl, { width: 320, margin: 1 });
            } catch (qrErr) {
                logToUI(`⚠️ Không tạo được ảnh QR để lưu: ${qrErr.message}`, 'info');
            }

            // 🗂️ Lưu bản ghi vào danh mục app trên GitHub (không chặn nếu lỗi)
            const catalogRecord = {
                id: finalFilename,
                appName: appInfo.appName,
                bundleId: appInfo.bundleId,
                version: appInfo.version,
                buildNumber: appInfo.buildNumber,
                icon: iconBase64,
                qr: qrDataUrl,
                fileSize: formattedTotalSize,
                shareUrl,
                downloadUrl,
                uploadedAt: metadataInfo.uploadedAt,
                processTimeSeconds: totalProcessTime
            };

            try {
                await appendToCatalog(catalogRecord);
                logToUI('🗂️ Đã lưu thông tin app vào danh mục trên GitHub.', 'success');
            } catch (catalogErr) {
                logToUI(`⚠️ Lưu danh mục lên GitHub thất bại: ${catalogErr.message}`, 'error');
            }

            // Trả phản hồi cho Frontend
            return res.json({
                success: true,
                downloadUrl,
                shareUrl,
                processTime: totalProcessTime,
                appInfo: { ...appInfo, icon: iconBase64 }
            });

        } catch (parserError) {
            logToUI(`❌ Trích xuất thông tin IPA thất bại: ${parserError.message}`, 'error');
            return res.status(500).json({ success: false, message: `Lỗi bóc tách cấu trúc file IPA: ${parserError.message}` });
        }

    } catch (error) {
        logToUI(`❌ Hệ thống gặp lỗi xử lý: ${error.message}`, 'error');
        return res.status(500).json({ success: false, message: `Lỗi hệ thống Server nội bộ: ${error.message}` });
    }
});

const server = app.listen(PORT, () => console.log(`Diawi Local-First System active on port ${PORT}`));
server.timeout = 600000;
server.keepAliveTimeout = 600000;