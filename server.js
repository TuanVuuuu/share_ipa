const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const AppInfoParser = require('app-info-parser');

const app = express();
const PORT = 3000;

const UPLOADS_MAIN_DIR = '/Users/sds/dev/share_ipa/uploads';
const CHUNK_DIR = '/Users/sds/dev/share_ipa/uploads/chunks';

if (!fs.existsSync(UPLOADS_MAIN_DIR)) fs.mkdirSync(UPLOADS_MAIN_DIR, { recursive: true });
if (!fs.existsSync(CHUNK_DIR)) fs.mkdirSync(CHUNK_DIR, { recursive: true });

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

const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

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

app.post('/upload-ipa-chunk', upload.single('ipaChunk'), async (req, res) => {
    try {
        const { chunkIndex, totalChunks, uploadId, originalName, totalSize, chunkSize } = req.body;
        
        if (!uploadId || chunkIndex === undefined) {
            return res.status(400).json({ success: false, message: 'Dữ liệu phân mảnh bị thiếu.' });
        }

        const formattedTotalSize = formatBytes(parseInt(totalSize));
        const formattedChunkSize = formatBytes(parseInt(chunkSize));
        const currentChunkNum = parseInt(chunkIndex) + 1;

        logToUI(`📥 [Mảnh ${currentChunkNum}/${totalChunks}] Đang ghi mảnh ~${formattedChunkSize} (Tổng file IPA: ${formattedTotalSize})`, 'info');

        const thisChunkPath = path.join(CHUNK_DIR, `${uploadId}_${chunkIndex}`);
        fs.writeFileSync(thisChunkPath, req.file.buffer);

        const files = fs.readdirSync(CHUNK_DIR);
        const uploadedChunksForThisFile = files.filter(file => file.startsWith(uploadId));

        if (uploadedChunksForThisFile.length < parseInt(totalChunks)) {
            return res.json({ success: true });
        }

        // --- ĐỦ MẢNH -> TIẾN HÀNH HỢP NHẤT ---
        const startTime = performance.now();
        logToUI(`📦 Đã xác nhận đủ ${totalChunks}/${totalChunks} mảnh trên đĩa. Bắt đầu hợp nhất...`, 'info');

        const finalFilename = `app_${Date.now()}_${originalName}`;  
        const finalPath = path.join(UPLOADS_MAIN_DIR, finalFilename);

        for (let i = 0; i < totalChunks; i++) {
            const chunkPath = path.join(CHUNK_DIR, `${uploadId}_${i}`);
            if (!fs.existsSync(chunkPath)) {
                throw new Error(`Mất mát dữ liệu mảnh số ${i}`);
            }
            const buffer = fs.readFileSync(chunkPath);
            fs.appendFileSync(finalPath, buffer); 
            fs.unlinkSync(chunkPath); 
        }

        logToUI(`⚡ Hợp nhất hoàn tất. Tiến hành trích xuất metadata IPA qua AppInfoParser...`, 'info');
        
        // 🌟 TỰ ĐỘNG ÉP HTTPS CHO DOMAIN PUBLIC KHI SINH LINK CHO IPHONE
        const host = req.get('host');
        const PUBLIC_DOMAIN = host.includes('share-ipa.vunt.info') ? 'https://share-ipa.vunt.info' : `http://${host}`;

        const parser = new AppInfoParser(finalPath);

        parser.parse()
            .then(result => {
                const appInfo = {
                    bundleId: result.CFBundleIdentifier || 'N/A',
                    version: result.CFBundleShortVersionString || 'N/A',
                    buildNumber: result.CFBundleVersion || 'N/A',
                    appName: result.CFBundleDisplayName || result.CFBundleName || 'Ứng dụng iOS'
                };
                const iconBase64 = result.icon || 'https://cdn-icons-png.flaticon.com/512/5115/5115293.png';
                const processTime = ((performance.now() - startTime) / 1000).toFixed(2);

                logToUI(`✅ Phân tích thành công: ${appInfo.appName} | Phiên bản: ${appInfo.version} trong ${processTime}s`, 'success');

                const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>items</key><array><dict><key>assets</key><array><dict><key>kind</key><string>software-package</string><key>url</key><string>https://share-ipa.vunt.info/uploads/${finalFilename}</string></dict></array><key>metadata</key><dict><key>bundle-identifier</key><string>${appInfo.bundleId}</string><key>bundle-version</key><string>${appInfo.version}</string><key>kind</key><string>software</string><key>title</key><string>${appInfo.appName}</string></dict></dict></array></dict></plist>`;

                const plistFilename = `${finalFilename}.plist`;
                fs.writeFileSync(path.join(UPLOADS_MAIN_DIR, plistFilename), plistContent);

                res.json({
                    success: true,
                    // Ép mã QR luôn luôn sinh ra link https public để iPhone của các tầng quét cài được
                    downloadUrl: `itms-services://?action=download-manifest&url=${encodeURIComponent(`https://share-ipa.vunt.info/uploads/${plistFilename}`)}`,
                    shareUrl: `https://share-ipa.vunt.info/?plist=${plistFilename}`,
                    processTime: processTime,
                    appInfo: { ...appInfo, icon: iconBase64 }
                });
            })
            .catch(err => {
                logToUI(`❌ Trích xuất file IPA thất bại: ${err.message}`, 'error');
                res.status(500).json({ success: false, message: 'Lỗi giải mã file IPA.' });
            });

    } catch (error) {
        logToUI(`❌ Khóa luồng ghi, lỗi hệ thống: ${error.message}`, 'error');
        res.status(500).json({ success: false, message: error.message });
    }
});

const server = app.listen(PORT, () => console.log(`Diawi Server Active on port ${PORT}`));
server.timeout = 600000;
server.keepAliveTimeout = 600000;