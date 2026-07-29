/**
 * Script khôi phục catalog.json từ các file IPA/APK còn trong thư mục uploads.
 * Chạy: node rebuild-catalog.js [--dry-run]
 *
 * --dry-run: chỉ in ra danh sách, không ghi lên GitHub
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const fs = require('fs');
const AppInfoParser = require('app-info-parser');
const QRCode = require('qrcode');
const github = require('./github');

const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'https://share-ipa.vunt.info';
const UPLOADS_DIR = '/Users/sds/dev/share_ipa/uploads';
const CATALOG_IOS_PATH = 'catalog-ios.json';
const CATALOG_ANDROID_PATH = 'catalog-android.json';
const DRY_RUN = process.argv.includes('--dry-run');

function detectPlatform(filename) {
    return path.extname(filename).toLowerCase() === '.apk' ? 'android' : 'ios';
}

function getProfileType(mobileProvision) {
    if (!mobileProvision) return null;
    if (mobileProvision.ProvisionsAllDevices) return 'Enterprise';
    const allowGetTask = (mobileProvision.Entitlements || {})['get-task-allow'];
    if (Array.isArray(mobileProvision.ProvisionedDevices) && mobileProvision.ProvisionedDevices.length > 0) {
        return allowGetTask ? 'Development' : 'Ad Hoc';
    }
    return allowGetTask ? 'Development' : 'App Store';
}

function resolveApkAppName(result) {
    const label = result?.application?.label ?? result?.['application-label'];
    if (typeof label === 'string' && label.trim()) return label.trim();
    if (label && typeof label === 'object') {
        const candidate = label[''] || label.en || label['en-US']
            || Object.values(label).find(v => typeof v === 'string' && v.trim());
        if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    }
    return null;
}

function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

async function parseFile(filePath, filename) {
    const platform = detectPlatform(filename);
    const parser = new AppInfoParser(filePath);
    const result = await parser.parse();

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
            icon: result.icon || null,
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
        provisionedDevices: Array.isArray(mobileProvision?.ProvisionedDevices) ? mobileProvision.ProvisionedDevices : null,
        provisionedDevicesCount: Array.isArray(mobileProvision?.ProvisionedDevices) ? mobileProvision.ProvisionedDevices.length : null,
        icon: result.icon || null,
    };
}

async function main() {
    if (!github.isConfigured()) {
        console.error('❌ GITHUB_TOKEN / GITHUB_REPO chưa được cấu hình!');
        process.exit(1);
    }

    console.log(`📂 Quét thư mục: ${UPLOADS_DIR}`);
    console.log(DRY_RUN ? '🔍 Chế độ DRY RUN (không ghi lên GitHub)\n' : '✏️  Sẽ ghi lên GitHub\n');

    const allFiles = fs.readdirSync(UPLOADS_DIR);
    const appFiles = allFiles.filter(f => {
        const ext = path.extname(f).toLowerCase();
        return (ext === '.ipa' || ext === '.apk') && f.startsWith('app_');
    });

    console.log(`📦 Tìm thấy ${appFiles.length} file IPA/APK\n`);

    // Đọc 2 catalog hiện tại để tránh thêm trùng
    async function loadCatalog(filePath) {
        try {
            const file = await github.getFile(filePath);
            if (!file) return { list: [], sha: undefined };
            const parsed = JSON.parse(file.content);
            return { list: Array.isArray(parsed) ? parsed : [], sha: file.sha };
        } catch (e) {
            console.warn(`⚠️  Không đọc được ${filePath}:`, e.message);
            return { list: [], sha: undefined };
        }
    }

    const [iosData, androidData] = await Promise.all([
        loadCatalog(CATALOG_IOS_PATH),
        loadCatalog(CATALOG_ANDROID_PATH),
    ]);

    const existingIds = new Set([
        ...iosData.list.map(i => i.id),
        ...androidData.list.map(i => i.id),
    ]);
    console.log(`📋 Catalog hiện tại: iOS=${iosData.list.length}, Android=${androidData.list.length} mục\n`);

    const newRecords = [];
    let successCount = 0;
    let skipCount = 0;
    let errorCount = 0;

    for (const filename of appFiles) {
        // Bỏ qua nếu đã có trong catalog
        if (existingIds.has(filename)) {
            console.log(`⏭️  Bỏ qua (đã có): ${filename}`);
            skipCount++;
            continue;
        }

        const filePath = path.join(UPLOADS_DIR, filename);
        const stat = fs.statSync(filePath);
        const fileSizeBytes = stat.size;
        const uploadedAt = new Date(stat.birthtimeMs || stat.ctimeMs).toISOString();

        process.stdout.write(`🔍 Đang parse: ${filename} ... `);

        try {
            const appInfo = await parseFile(filePath, filename);
            const platform = appInfo.platform;

            let downloadUrl, shareUrl;
            const filePublicUrl = `${PUBLIC_BASE_URL}/uploads/${filename}`;

            if (platform === 'android') {
                downloadUrl = filePublicUrl;
                shareUrl = `${PUBLIC_BASE_URL}/install?id=${encodeURIComponent(filename)}`;
            } else {
                const plistFilename = `${filename}.plist`;
                const plistPath = path.join(UPLOADS_DIR, plistFilename);
                const manifestUrl = `${PUBLIC_BASE_URL}/uploads/${plistFilename}`;

                // Tạo plist nếu chưa có
                if (!fs.existsSync(plistPath)) {
                    const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>items</key><array><dict><key>assets</key><array><dict><key>kind</key><string>software-package</string><key>url</key><string>${filePublicUrl}</string></dict></array><key>metadata</key><dict><key>bundle-identifier</key><string>${appInfo.bundleId}</string><key>bundle-version</key><string>${appInfo.version}</string><key>kind</key><string>software</string><key>title</key><string>${appInfo.appName}</string></dict></dict></array></dict></plist>`;
                    fs.writeFileSync(plistPath, plistContent);
                }

                downloadUrl = `itms-services://?action=download-manifest&url=${encodeURIComponent(manifestUrl)}`;
                shareUrl = `${PUBLIC_BASE_URL}/install?plist=${plistFilename}`;
            }

            let qrDataUrl = '';
            try {
                qrDataUrl = await QRCode.toDataURL(shareUrl, { width: 320, margin: 1 });
            } catch (_) {}

            const record = {
                id: filename,
                appName: appInfo.appName,
                bundleId: appInfo.bundleId,
                platform: appInfo.platform,
                version: appInfo.version,
                buildNumber: appInfo.buildNumber,
                minimumOsVersion: appInfo.minimumOsVersion,
                profileType: appInfo.profileType,
                provisionedDevices: appInfo.provisionedDevices,
                provisionedDevicesCount: appInfo.provisionedDevicesCount,
                icon: appInfo.icon || 'https://cdn-icons-png.flaticon.com/512/5115/5115293.png',
                qr: qrDataUrl,
                fileSize: formatBytes(fileSizeBytes),
                fileSizeBytes,
                shareUrl,
                downloadUrl,
                uploadedAt,
                r2ObjectKey: null,
                uploadedBy: 'rebuild-catalog',
            };

            newRecords.push(record);
            console.log(`✅ ${appInfo.appName} v${appInfo.version} (${platform})`);
            successCount++;
        } catch (err) {
            console.log(`❌ Lỗi: ${err.message}`);
            errorCount++;
        }
    }

    console.log(`\n📊 Kết quả parse:`);
    console.log(`   ✅ Thành công: ${successCount}`);
    console.log(`   ⏭️  Bỏ qua (đã có): ${skipCount}`);
    console.log(`   ❌ Lỗi: ${errorCount}`);

    if (newRecords.length === 0) {
        console.log('\n✨ Không có mục mới cần thêm vào catalog.');
        return;
    }

    // Tách new records theo platform
    const newIos = newRecords.filter(r => r.platform === 'ios');
    const newAndroid = newRecords.filter(r => r.platform === 'android');

    newIos.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
    newAndroid.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));

    const mergedIos = [...newIos, ...iosData.list];
    const mergedAndroid = [...newAndroid, ...androidData.list];

    console.log(`\n📝 Sẽ thêm: iOS=${newIos.length}, Android=${newAndroid.length} mục mới`);
    console.log(`   Tổng sau merge: iOS=${mergedIos.length}, Android=${mergedAndroid.length}`);

    if (DRY_RUN) {
        console.log('\n🔍 DRY RUN — không ghi lên GitHub. Chạy không có --dry-run để áp dụng.');
        return;
    }

    console.log('\n☁️  Đang đẩy catalog lên GitHub...');
    try {
        if (newIos.length > 0) {
            // Đọc lại SHA mới nhất trước khi ghi để tránh conflict 409
            const latestIos = await loadCatalog(CATALOG_IOS_PATH);
            await github.putFile(CATALOG_IOS_PATH, JSON.stringify(mergedIos, null, 2),
                `rebuild ios catalog: add ${newIos.length} entries`, latestIos.sha);
            console.log(`✅ catalog-ios.json: ${mergedIos.length} mục`);
        }
        if (newAndroid.length > 0) {
            const latestAndroid = await loadCatalog(CATALOG_ANDROID_PATH);
            await github.putFile(CATALOG_ANDROID_PATH, JSON.stringify(mergedAndroid, null, 2),
                `rebuild android catalog: add ${newAndroid.length} entries`, latestAndroid.sha);
            console.log(`✅ catalog-android.json: ${mergedAndroid.length} mục`);
        }
        console.log('\n🎉 Hoàn tất! Catalog đã được cập nhật trên GitHub.');
    } catch (err) {
        console.error('❌ Lỗi khi ghi lên GitHub:', err.message);
        process.exit(1);
    }
}

main().catch(err => {
    console.error('❌ Fatal:', err.message);
    process.exit(1);
});
