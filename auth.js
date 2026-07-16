// ─── Auth nhiều tài khoản + phân quyền theo role ───────────────────────────
// Danh sách tài khoản đọc từ users.json (không commit git vì chứa mật khẩu).
// Nếu users.json không tồn tại, fallback về 1 tài khoản admin lấy từ .env
// (ACCESS_USERNAME/ACCESS_PASSWORD) để tương thích ngược bản cũ.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const USERS_CONFIG_PATH = path.join(__dirname, 'users.json');
const SESSION_SECRET = process.env.SESSION_SECRET || 'share-ipa-local-secret-change-me';

// Ma trận quyền theo role. 'upload_build': được đẩy bản build. 'delete_build': được xóa bản build.
const ROLE_PERMISSIONS = {
    admin: ['upload_build', 'delete_build'],
    dev: ['upload_build'],
};

function loadUsers() {
    try {
        if (fs.existsSync(USERS_CONFIG_PATH)) {
            const parsed = JSON.parse(fs.readFileSync(USERS_CONFIG_PATH, 'utf8'));
            if (Array.isArray(parsed) && parsed.length) {
                return parsed
                    .filter(u => u && u.username && u.password)
                    .map(u => ({
                        username: String(u.username).trim(),
                        password: String(u.password),
                        role: ROLE_PERMISSIONS[u.role] ? u.role : 'dev',
                    }));
            }
        }
    } catch (err) {
        console.error('[AUTH] ❌ Không đọc được users.json:', err.message);
    }

    // Fallback tương thích ngược: 1 tài khoản admin duy nhất từ .env
    const legacyUsername = process.env.ACCESS_USERNAME?.trim();
    const legacyPassword = process.env.ACCESS_PASSWORD?.trim();
    if (legacyUsername && legacyPassword) {
        return [{ username: legacyUsername, password: legacyPassword, role: 'admin' }];
    }
    return [];
}

const USERS = loadUsers();
console.log(`[AUTH] Đã tải ${USERS.length} tài khoản: ${USERS.map(u => `${u.username}(${u.role})`).join(', ') || '(trống)'}`);

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
    return { username: user.username, role: user.role, permissions: getPermissions(user.role) };
}

function verifyCredentials(username, password) {
    const user = findUser((username || '').toString().trim());
    if (user && user.password === (password || '').toString().trim()) return user;
    return null;
}

// Ký token phiên đăng nhập bằng HMAC để tránh người dùng tự sửa cookie giả danh tài khoản khác.
function sign(value) {
    return crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('hex');
}

function createSessionToken(username) {
    const payload = Buffer.from(username, 'utf8').toString('base64url');
    return `${payload}.${sign(payload)}`;
}

function verifySessionToken(token) {
    if (!token || typeof token !== 'string' || !token.includes('.')) return null;
    const [payload, signature] = token.split('.');
    if (!payload || !signature) return null;

    const expected = sign(payload);
    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expected);
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null;

    try {
        const username = Buffer.from(payload, 'base64url').toString('utf8');
        return findUser(username);
    } catch (_) {
        return null;
    }
}

module.exports = {
    verifyCredentials,
    createSessionToken,
    verifySessionToken,
    hasPermission,
    getPermissions,
    toPublicUser,
};
