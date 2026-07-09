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

// 👉 CHỖ DUY NHẤT cần đổi mỗi khi cập nhật giao diện (CSS/JS) để phá cache trình duyệt/CDN.
// Đổi giá trị này (ví dụ tăng lên '3', '4'...) rồi deploy là đủ.
const ASSET_VERSION = process.env.ASSET_VERSION || '6';

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
const CHUNKS_DIR = path.join(UPLOADS_MAIN_DIR, 'chunks');

if (!fs.existsSync(UPLOADS_MAIN_DIR)) fs.mkdirSync(UPLOADS_MAIN_DIR, { recursive: true });
if (!fs.existsSync(ARCHIVE_STORAGE_DIR)) fs.mkdirSync(ARCHIVE_STORAGE_DIR, { recursive: true });
if (!fs.existsSync(CHUNKS_DIR)) fs.mkdirSync(CHUNKS_DIR, { recursive: true });

// Tối ưu bộ nhớ: Lưu thẳng file vào đĩa thay vì ngậm trên RAM để tránh crash khi nhiều người upload cùng lúc
const storage = multer.diskStorage({
    destination: (req, file, cb) => { cb(null, UPLOADS_MAIN_DIR); },
    filename: (req, file, cb) => { cb(null, `app_${Date.now()}_${file.originalname}`); }
});
const upload = multer({ storage: storage, limits: { fileSize: 200 * 1024 * 1024 } }); // Hạn mức hẳn 200MB
const chunkUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

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

// Các trang HTML được phục vụ động (chèn version) — đặt TRƯỚC express.static để ưu tiên
app.get('/', (req, res) => sendHtmlWithVersion(res, 'index.html'));

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
app.use('/uploads', express.static(UPLOADS_MAIN_DIR));
app.use('/storage', express.static(ARCHIVE_STORAGE_DIR));

// Đường dẫn /login cũ giờ trỏ thẳng về trang chính (ô đăng nhập nằm ngay trong trang)
app.get('/login', (req, res) => res.redirect('/'));

// Trang cài đặt độc lập cho người quét QR (mở màn hình riêng, chỉ hiện 1 bản build)
app.get('/install', (req, res) => sendHtmlWithVersion(res, 'install.html'));

// Trang chi tiết ứng dụng: danh sách tất cả bản build của một app
app.get('/app', (req, res) => sendHtmlWithVersion(res, 'app-detail.html'));

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
app.use('/api/upload-chunk', requireAuth);
app.use('/api/upload-finalize', requireAuth);
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

// 🧠 HÀM DÙNG CHUNG: bóc tách IPA đã nằm sẵn trên đĩa -> tạo link -> trả phản hồi -> lưu trữ ở nền.
// Dùng cho cả upload 1 lần (upload-secure) lẫn upload chia nhỏ (upload-finalize).
async function processUploadedIpa(res, { finalFilename, finalPath, fileSizeBytes }) {
    const startTime = performance.now();
    const formattedTotalSize = formatBytes(fileSizeBytes);

    try {
        await logRealtime(`📥 Đã nhận và lưu kho tệp tin (${formattedTotalSize}) thành công vào ổ đĩa Mac!`, 'success');
        await logRealtime(`⚡ Bắt đầu bóc tách Metadata IPA bằng AppInfoParser...`, 'info');

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

            await logRealtime(`✅ Phân tích cấu trúc thành công: ${appInfo.appName} | Phiên bản: ${appInfo.version} trong ${totalProcessTime} giây`, 'success');

            const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>items</key><array><dict><key>assets</key><array><dict><key>kind</key><string>software-package</string><key>url</key><string>${PUBLIC_BASE_URL}/uploads/${finalFilename}</string></dict></array><key>metadata</key><dict><key>bundle-identifier</key><string>${appInfo.bundleId}</string><key>bundle-version</key><string>${appInfo.version}</string><key>kind</key><string>software</string><key>title</key><string>${appInfo.appName}</string></dict></dict></array></dict></plist>`;

            const plistFilename = `${finalFilename}.plist`;
            await fs.promises.writeFile(path.join(UPLOADS_MAIN_DIR, plistFilename), plistContent);

            const manifestUrl = `${PUBLIC_BASE_URL}/uploads/${plistFilename}`;
            const downloadUrl = `itms-services://?action=download-manifest&url=${encodeURIComponent(manifestUrl)}`;
            const shareUrl = `${PUBLIC_BASE_URL}/install?plist=${plistFilename}`;
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
                        await logRealtime(`⚠️ Vượt quá 10 bản build. Tiến hành tự động xóa bỏ ${deleteCount} tệp cũ...`, 'info');
                        for (let k = 0; k < deleteCount; k++) {
                            if (fs.existsSync(ipaFiles[k].path)) fs.unlinkSync(ipaFiles[k].path);
                            if (fs.existsSync(ipaFiles[k].path + '.json')) fs.unlinkSync(ipaFiles[k].path + '.json');
                        }
                    }

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
                        version: appInfo.version,
                        buildNumber: appInfo.buildNumber,
                        icon: iconBase64,
                        qr: qrDataUrl,
                        fileSize: formattedTotalSize,
                        shareUrl,
                        downloadUrl,
                        uploadedAt,
                        processTimeSeconds: totalProcessTime
                    };

                    await logRealtime('☁️ Đang đồng bộ thông tin app lên danh mục GitHub...', 'info');
                    await appendToCatalog(catalogRecord);
                    await logRealtime('🗂️ Đã lưu xong danh mục. Toàn bộ quy trình hoàn tất!', 'success');
                } catch (bgErr) {
                    console.error('[BACKGROUND] Lỗi xử lý nền:', bgErr.message);
                    logToUI(`⚠️ Lỗi khi hoàn tất lưu trữ ở nền: ${bgErr.message}`, 'error');
                }
            })();
            return;
        } catch (parserError) {
            logToUI(`❌ Trích xuất thông tin IPA thất bại: ${parserError.message}`, 'error');
            return res.status(500).json({ success: false, message: `Lỗi bóc tách cấu trúc file IPA: ${parserError.message}` });
        }
    } catch (error) {
        logToUI(`❌ Hệ thống gặp lỗi xử lý: ${error.message}`, 'error');
        return res.status(500).json({ success: false, message: `Lỗi hệ thống Server nội bộ: ${error.message}` });
    }
}

// Upload 1 lần (cũ) vẫn giữ lại để tương thích ngược.
app.post('/api/upload-secure', receiveUpload, async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ success: false, message: 'Không tìm thấy tệp tin IPA.' });
    }
    return processUploadedIpa(res, {
        finalFilename: req.file.filename,
        finalPath: req.file.path,
        fileSizeBytes: req.file.size
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

// Finalize: ghép các chunk thành file IPA hoàn chỉnh rồi đưa vào pipeline xử lý chung.
app.post('/api/upload-finalize', async (req, res) => {
    try {
        const { uploadId = '', totalChunks = '', originalName = '', totalSize = '' } = req.body || {};
        const total = Number(totalChunks);

        if (!uploadId || !Number.isInteger(total) || total <= 0 || !originalName) {
            return res.status(400).json({ success: false, message: 'Thiếu thông tin để finalize upload.' });
        }

        const safeOriginalName = path.basename(originalName).replace(/[^\w.\-]/g, '_');
        const finalFilename = `app_${Date.now()}_${safeOriginalName}`;
        const finalPath = path.join(UPLOADS_MAIN_DIR, finalFilename);

        await logRealtime(`🧵 Bắt đầu ghép ${total} chunk thành tệp IPA hoàn chỉnh...`, 'info');

        for (let i = 0; i < total; i++) {
            const chunkPath = path.join(CHUNKS_DIR, `upload_${uploadId}_${i}`);
            if (!fs.existsSync(chunkPath)) {
                return res.status(400).json({ success: false, message: `Thiếu chunk #${i}. Vui lòng upload lại.` });
            }
            const buf = await fs.promises.readFile(chunkPath);
            await fs.promises.appendFile(finalPath, buf);
            await fs.promises.unlink(chunkPath);
        }

        const fileStat = await fs.promises.stat(finalPath);
        const expectedSize = Number(totalSize) || fileStat.size;
        await logRealtime(`🧵 Ghép chunk hoàn tất (${formatBytes(fileStat.size)}). Chuyển sang xử lý IPA...`, 'success');

        return processUploadedIpa(res, {
            finalFilename,
            finalPath,
            fileSizeBytes: expectedSize
        });
    } catch (err) {
        logToUI(`❌ Lỗi finalize upload chunk: ${err.message}`, 'error');
        return res.status(500).json({ success: false, message: `Lỗi ghép chunk: ${err.message}` });
    }
});

const server = app.listen(PORT, () => console.log(`Diawi Local-First System active on port ${PORT}`));
server.timeout = 600000;
server.keepAliveTimeout = 600000;