const GITHUB_API = 'https://api.github.com';

function getConfig() {
    const token = (process.env.GITHUB_TOKEN || '').trim();
    const repo = (process.env.GITHUB_REPO || '').trim();
    const branch = (process.env.GITHUB_BRANCH || 'main').trim();
    return { token, repo, branch };
}

function isConfigured() {
    const { token, repo } = getConfig();
    return Boolean(token && repo);
}

function buildHeaders(token) {
    return {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'share-ipa-app'
    };
}

// Lấy nội dung 1 file trong repo. Trả về { content, sha } hoặc null nếu file chưa tồn tại.
async function getFile(filePath) {
    const { token, repo, branch } = getConfig();
    const url = `${GITHUB_API}/repos/${repo}/contents/${encodeURIComponent(filePath)}?ref=${encodeURIComponent(branch)}`;
    const res = await fetch(url, { headers: buildHeaders(token) });

    if (res.status === 404) return null;
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`GitHub getFile ${filePath} lỗi ${res.status}: ${text}`);
    }

    const data = await res.json();
    const content = Buffer.from(data.content || '', 'base64').toString('utf8');
    return { content, sha: data.sha };
}

// Tạo mới hoặc cập nhật 1 file. contentBuffer là Buffer hoặc string.
async function putFile(filePath, contentBuffer, message, sha) {
    const { token, repo, branch } = getConfig();
    const url = `${GITHUB_API}/repos/${repo}/contents/${encodeURIComponent(filePath)}`;

    const body = {
        message: message || `update ${filePath}`,
        content: Buffer.from(contentBuffer).toString('base64'),
        branch
    };
    if (sha) body.sha = sha;

    const res = await fetch(url, {
        method: 'PUT',
        headers: { ...buildHeaders(token), 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });

    if (!res.ok) {
        const text = await res.text();
        throw new Error(`GitHub putFile ${filePath} lỗi ${res.status}: ${text}`);
    }

    return res.json();
}

module.exports = { getConfig, isConfigured, getFile, putFile };
