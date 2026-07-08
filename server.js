const path = require('path');

require('dotenv').config({
    path: path.join(__dirname, '.env')
});

const express = require('express');
const multer = require('multer');
const fs = require('fs');
const AppInfoParser = require('app-info-parser');

console.log('========== ENV ==========');
console.log('__dirname:', __dirname);
console.log('cwd:', process.cwd());

console.log('ACCESS_USERNAME:', process.env.ACCESS_USERNAME);
console.log('ACCESS_PASSWORD:', process.env.ACCESS_PASSWORD);

console.log('USERNAME:', process.env.USERNAME);
console.log('PASSWORD:', process.env.PASSWORD);

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

function requireAuth(req, res, next) {
    console.log("COOKIE =", req.headers.cookie);
    if (req.path === '/login' || req.path === '/api/login') return next();

    const cookies = parseCookies(req.headers.cookie || '');
    if (cookies[AUTH_COOKIE_NAME] === 'true') return next();

    if (req.path.startsWith('/api/')) {
        return res.status(401).json({ success: false, message: 'Vui lòng đăng nhập trước khi sử dụng.' });
    }

    return res.redirect('/login');
}

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/login', (req, res) => {
    console.log('===== LOGIN =====');
    console.log(req.body);

    const { username = '', password = '' } = req.body || {};
    const configured = getConfiguredCredentials();

    console.log('Typed Username:', username);
    console.log('Typed Password:', password);

    console.log('Config Username:', configured.username);
    console.log('Config Password:', configured.password);
    console.log('=================');

    const typedUsername = username.toString().trim();
    const typedPassword = password.toString().trim();

    if (typedUsername === configured.username &&
        typedPassword === configured.password) {

        res.setHeader(
            'Set-Cookie',
            `${AUTH_COOKIE_NAME}=true; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`
        );

        return res.redirect('/');
    }

    return res.redirect('/login?error=1');
});

app.use(requireAuth);
app.use(express.static('public'));
app.use('/uploads', express.static(UPLOADS_MAIN_DIR));
app.use('/storage', express.static(ARCHIVE_STORAGE_DIR));

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
<plist version="1.0"><dict><key>items</key><array><dict><key>assets</key><array><dict><key>kind</key><string>software-package</string><key>url</key><string>https://share-ipa.vunt.info/uploads/${finalFilename}</string></dict></array><key>metadata</key><dict><key>bundle-identifier</key><string>${appInfo.bundleId}</string><key>bundle-version</key><string>${appInfo.version}</string><key>kind</key><string>software</string><key>title</key><string>${appInfo.appName}</string></dict></dict></array></dict></plist>`;

            const plistFilename = `${finalFilename}.plist`;
            fs.writeFileSync(path.join(UPLOADS_MAIN_DIR, plistFilename), plistContent);

            logToUI(`🎉 Toàn bộ quy trình hoàn tất! Sẵn sàng chia sẻ dữ liệu công khai.`, 'success');

            // Trả phản hồi ngay lập tức cho Frontend
            return res.json({
                success: true,
                downloadUrl: `itms-services://?action=download-manifest&url=${encodeURIComponent(`https://share-ipa.vunt.info/uploads/${plistFilename}`)}`,
                shareUrl: `https://share-ipa.vunt.info/?plist=${plistFilename}`,
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