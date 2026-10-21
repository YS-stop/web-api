/**
 * auth.js (middleware)
 *
 * JWT 鉴权中间件：验证 Authorization Bearer token，注入 req.user。
 */

import { verifyToken } from '../services/jwt.js';
import { getUserById } from '../services/userService.js';

export async function requireAuth(req, res, next) {
    try {
        const authHeader = req.headers.authorization || '';
        const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
        if (!token) {
            return res.status(401).json({ error: '未登录' });
        }
        const payload = verifyToken(token);
        const user = await getUserById(payload.userId);
        if (!user || user.status !== 'active') {
            return res.status(401).json({ error: '用户不存在或已禁用' });
        }
        req.user = user;
        next();
    } catch (error) {
        return res.status(401).json({ error: error.message || '鉴权失败' });
    }
}

export function requireRole(...roles) {
    return (req, res, next) => {
        if (!req.user || !roles.includes(req.user.role)) {
            return res.status(403).json({ error: '无权限' });
        }
        next();
    };
}

export default { requireAuth, requireRole };
