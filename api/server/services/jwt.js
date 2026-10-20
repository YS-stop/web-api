/**
 * jwt.js
 *
 * 简单 JWT 实现（HS256，用内置 crypto，无额外依赖）。
 */

import crypto from 'crypto';

function getSecret() {
    // 调用时读取，避免模块加载时 dotenv 尚未执行导致 .env 里的 JWT_SECRET 被忽略
    return process.env.JWT_SECRET || 'twitcanva-dev-secret-change-in-production';
}

function b64url(obj) {
    return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

export function signToken(payload, expiresInSec = 7 * 24 * 3600) {
    const header = b64url({ alg: 'HS256', typ: 'JWT' });
    const now = Math.floor(Date.now() / 1000);
    const body = b64url({ ...payload, iat: now, exp: now + expiresInSec });
    const sig = crypto.createHmac('sha256', getSecret()).update(header + '.' + body).digest('base64url');
    return header + '.' + body + '.' + sig;
}

export function verifyToken(token) {
    const parts = (token || '').split('.');
    if (parts.length !== 3) throw new Error('无效 token');
    const [header, body, signature] = parts;
    const expected = crypto.createHmac('sha256', getSecret()).update(header + '.' + body).digest('base64url');
    if (expected !== signature) throw new Error('token 签名无效');
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (payload.exp && Date.now() / 1000 > payload.exp) throw new Error('token 已过期');
    return payload;
}

export default { signToken, verifyToken };
