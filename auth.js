// ─── Auth nhiều tài khoản + JWT + Google Authenticator (TOTP) ───────────────
// Danh sách tài khoản đọc từ users.json (không commit git vì chứa mật khẩu/secret).
// Nếu users.json không tồn tại, fallback về 1 tài khoản admin lấy từ .env
// (ACCESS_USERNAME/ACCESS_PASSWORD) để tương thích ngược bản cũ.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const { generateSecret, generateURI, verifySync } = require('otplib');
const QRCode = require('qrcode');

const USERS_CONFIG_PATH = path.join(__dirname, 'users.json');
const JWT_SECRET = process.env.JWT_SECRET || process.env.SESSION_SECRET || 'share-ipa-local-secret-change-me';
const TOTP_ISSUER = process.env.TOTP_ISSUER || 'Share IPA';
const ACCESS_TOKEN_TTL_SEC = Math.max(300, Number(process.env.JWT_TTL_SEC) || 86400);
const PENDING_TOKEN_TTL_SEC = Math.max(60, Number(process.env.TOTP_PENDING_TTL_SEC) || 300);
const TOTP_EPOCH_TOLERANCE_SEC = 30;

// Ma trận quyền theo role.
// upload_build: đẩy bản build | delete_build: xóa bản build
// view_catalog: xem danh mục build đầy đủ
// create_download_link: xem mục download + tạo/lưu link gửi đối tác
// manage_download_products: admin tạo/sửa/xóa mục download (tên + bundleId)
// manage_apps: admin ẩn/hiện app và xóa toàn bộ build + dữ liệu GitHub/máy chủ
const ROLE_PERMISSIONS = {
    admin: ['upload_build', 'delete_build', 'view_catalog', 'create_download_link', 'manage_download_products', 'manage_apps'],
    dev: ['upload_build', 'view_catalog', 'create_download_link'],
    tester: ['create_download_link'],
};

function normalizeUser(raw) {
    if (!raw || !raw.username || !raw.password) return null;
    const totpSecret = raw.totpSecret ? String(raw.totpSecret).trim() : '';
    return {
        username: String(raw.username).trim(),
        password: String(raw.password),
        role: ROLE_PERMISSIONS[raw.role] ? raw.role : 'dev',
        totpSecret,
        totpEnabled: totpSecret ? raw.totpEnabled !== false : false,
    };
}

function loadUsersFromDisk() {
    try {
        if (fs.existsSync(USERS_CONFIG_PATH)) {
            const parsed = JSON.parse(fs.readFileSync(USERS_CONFIG_PATH, 'utf8'));
            if (Array.isArray(parsed) && parsed.length) {
                return parsed.map(normalizeUser).filter(Boolean);
            }
        }
    } catch (err) {
        console.error('[AUTH] ❌ Không đọc được users.json:', err.message);
    }

    const legacyUsername = process.env.ACCESS_USERNAME?.trim();
    const legacyPassword = process.env.ACCESS_PASSWORD?.trim();
    if (legacyUsername && legacyPassword) {
        return [{ username: legacyUsername, password: legacyPassword, role: 'admin', totpSecret: '', totpEnabled: false }];
    }
    return [];
}

let USERS = loadUsersFromDisk();
console.log(`[AUTH] Đã tải ${USERS.length} tài khoản: ${USERS.map(u => `${u.username}(${u.role}${u.totpEnabled ? '+2FA' : ''})`).join(', ') || '(trống)'}`);

function reloadUsers() {
    USERS = loadUsersFromDisk();
    return USERS;
}

function persistUsers(users) {
    const payload = users.map(u => {
        const row = {
            username: u.username,
            password: u.password,
            role: u.role,
        };
        if (u.totpSecret) {
            row.totpSecret = u.totpSecret;
            row.totpEnabled = u.totpEnabled !== false;
        }
        return row;
    });
    fs.writeFileSync(USERS_CONFIG_PATH, `${JSON.stringify(payload, null, 4)}\n`, 'utf8');
    USERS = payload.map(normalizeUser).filter(Boolean);
    return USERS;
}

function findUser(username) {
    if (!username) return null;
    return USERS.find(u => u.username === username) || null;
}

function getPermissions(role) {
    return ROLE_PERMISSIONS[role] || [];
}

function hasPermission(user, permission) {
    return !!user && getPermissions(user.role).includes(permission);
}

function toPublicUser(user) {
    if (!user) return null;
    return {
        username: user.username,
        role: user.role,
        permissions: getPermissions(user.role),
        totpEnabled: !!user.totpEnabled,
    };
}

function verifyCredentials(username, password) {
    const user = findUser((username || '').toString().trim());
    if (user && user.password === (password || '').toString().trim()) return user;
    return null;
}

function createAccessToken(username) {
    return jwt.sign(
        { sub: username, typ: 'access' },
        JWT_SECRET,
        { expiresIn: ACCESS_TOKEN_TTL_SEC }
    );
}

function verifyAccessToken(token) {
    if (!token || typeof token !== 'string') return null;
    try {
        const payload = jwt.verify(token, JWT_SECRET);
        if (payload.typ && payload.typ !== 'access') return null;
        const username = payload.sub || payload.username;
        return findUser(username);
    } catch (_) {
        return null;
    }
}

function createPendingToken(username, step, extra = {}) {
    return jwt.sign(
        {
            sub: username,
            typ: 'pending',
            step,
            ...extra,
        },
        JWT_SECRET,
        { expiresIn: PENDING_TOKEN_TTL_SEC }
    );
}

function verifyPendingToken(token, expectedStep) {
    if (!token || typeof token !== 'string') return null;
    try {
        const payload = jwt.verify(token, JWT_SECRET);
        if (payload.typ !== 'pending') return null;
        if (expectedStep && payload.step !== expectedStep) return null;
        const user = findUser(payload.sub);
        if (!user) return null;
        return { user, payload };
    } catch (_) {
        return null;
    }
}

function verifyTotpCode(secret, code) {
    const token = String(code || '').replace(/\s+/g, '');
    if (!secret || !/^\d{6}$/.test(token)) return false;
    const result = verifySync({
        secret,
        token,
        epochTolerance: TOTP_EPOCH_TOLERANCE_SEC,
    });
    return !!(result && result.valid);
}

async function beginTotpSetup(username) {
    const secret = generateSecret();
    const otpauthUrl = generateURI({
        issuer: TOTP_ISSUER,
        label: username,
        secret,
    });
    const qrDataUrl = await QRCode.toDataURL(otpauthUrl, {
        errorCorrectionLevel: 'M',
        margin: 2,
        width: 220,
    });
    const pendingToken = createPendingToken(username, 'totp_setup', { totpSecret: secret });
    return {
        step: 'totp_setup',
        pendingToken,
        otpauthUrl,
        qrDataUrl,
        secret,
        expiresIn: PENDING_TOKEN_TTL_SEC,
    };
}

function enableTotpForUser(username, secret) {
    const users = loadUsersFromDisk();
    const idx = users.findIndex(u => u.username === username);
    if (idx < 0) throw new Error('Không tìm thấy tài khoản.');
    users[idx].totpSecret = secret;
    users[idx].totpEnabled = true;
    persistUsers(users);
    return findUser(username);
}

function fileAccessId(filename) {
    return path.basename(String(filename || '')).replace(/\.plist$/i, '');
}

function sign(value) {
    return crypto.createHmac('sha256', JWT_SECRET).update(value).digest('hex');
}

function createFileAccessToken(filename, ttlSec = 12 * 60 * 60) {
    const id = fileAccessId(filename);
    if (!id) return '';
    const exp = Math.floor(Date.now() / 1000) + ttlSec;
    const payload = Buffer.from(`${id}.${exp}`, 'utf8').toString('base64url');
    return `${payload}.${sign(payload)}`;
}

function hashInstallPin(pin) {
    return crypto.createHmac('sha256', JWT_SECRET).update(`install-pin:${String(pin)}`).digest('hex');
}

function installPinMatches(pin, pinHash) {
    const code = String(pin || '').trim();
    const stored = String(pinHash || '');
    if (!/^\d{6}$/.test(code) || !/^[a-f0-9]{64}$/.test(stored)) return false;
    const actual = Buffer.from(hashInstallPin(code));
    const expected = Buffer.from(stored);
    if (actual.length !== expected.length) return false;
    return crypto.timingSafeEqual(actual, expected);
}

function verifyFileAccessToken(token, filename) {
    if (!token || typeof token !== 'string' || !token.includes('.')) return false;
    const [payload, signature] = token.split('.');
    if (!payload || !signature) return false;

    const expected = sign(payload);
    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expected);
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return false;

    try {
        const decoded = Buffer.from(payload, 'base64url').toString('utf8');
        const lastDot = decoded.lastIndexOf('.');
        if (lastDot <= 0) return false;
        const id = decoded.slice(0, lastDot);
        const exp = Number(decoded.slice(lastDot + 1));
        if (!id || !Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return false;
        return id === fileAccessId(filename);
    } catch (_) {
        return false;
    }
}

// Tương thích tên cũ (session HMAC) — giờ là JWT access token
const createSessionToken = createAccessToken;
const verifySessionToken = verifyAccessToken;

module.exports = {
    verifyCredentials,
    createSessionToken,
    verifySessionToken,
    createAccessToken,
    verifyAccessToken,
    createPendingToken,
    verifyPendingToken,
    beginTotpSetup,
    enableTotpForUser,
    verifyTotpCode,
    createFileAccessToken,
    verifyFileAccessToken,
    hashInstallPin,
    installPinMatches,
    hasPermission,
    getPermissions,
    toPublicUser,
    reloadUsers,
    findUser,
};
