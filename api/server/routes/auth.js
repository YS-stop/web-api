/**
 * auth.js
 *
 * 飞书登录认证路由。
 * 流程：code → 用户信息 → 身份校验 → 建号 → 签发 JWT。
 */

import express from 'express';
import { authenticateWithCode } from '../services/feishu.js';
import { findOrCreateUser, getCompanyTenantKey, setCompanyTenantKey, sanitizeUser } from '../services/userService.js';
import { signToken } from '../services/jwt.js';
import { requireAuth } from '../middleware/auth.js';

const router = express.Router();

/**
 * 身份校验：以「本公司」为主效验身份。
 * 1) 若配置了 FEISHU_TENANT_KEY，强制校验飞书企业标识；
 * 2) 否则以首次登录锁定下来的本公司 tenant_key 为准；
 * 3) 两者都未锁定前，放行并允许后续锁定。
 */
function verifyCompanyMember(userInfo) {
    const envTenant = process.env.FEISHU_TENANT_KEY;
    if (envTenant) {
        if (userInfo.tenant_key !== envTenant) {
            return { allowed: false, reason: '非本公司人员，禁止访问' };
        }
        return { allowed: true };
    }
    const companyTenant = getCompanyTenantKey();
    if (companyTenant) {
        if (userInfo.tenant_key !== companyTenant) {
            return { allowed: false, reason: '非本公司人员，禁止访问' };
        }
        return { allowed: true };
    }
    return { allowed: true };
}

// 获取飞书授权页 URL（供前端跳转）
router.get('/feishu/login-url', (req, res) => {
    const appId = process.env.FEISHU_APP_ID;
    const redirectUri = process.env.FEISHU_REDIRECT_URI || 'http://192.168.20.239:8025/auth/callback';
    if (!appId) {
        return res.status(500).json({ error: 'FEISHU_APP_ID not configured' });
    }
    const url = 'https://open.feishu.cn/open-apis/authen/v1/index?app_id=' + appId + '&redirect_uri=' + encodeURIComponent(redirectUri);
    res.json({ url });
});

// 飞书登录回调：code → 用户信息 → 身份校验 → 建号 → JWT
router.post('/feishu/callback', async (req, res) => {
    try {
        const { code } = req.body;
        if (!code) {
            return res.status(400).json({ error: 'code is required' });
        }
        const userInfo = await authenticateWithCode(code);

        // 身份校验
        const verify = verifyCompanyMember(userInfo);
        if (!verify.allowed) {
            return res.status(403).json({ error: verify.reason });
        }

        const user = findOrCreateUser(userInfo);

        // 首次登录：由管理员锁定本公司（企业）标识，之后仅本公司人员可登录
        if (!process.env.FEISHU_TENANT_KEY && !getCompanyTenantKey() && userInfo.tenant_key && user.role === 'admin') {
            setCompanyTenantKey(userInfo.tenant_key);
        }

        const token = signToken({ userId: user.id, role: user.role });
        res.json({ success: true, token, user: sanitizeUser(user) });
    } catch (error) {
        console.error('飞书登录失败:', error);
        res.status(500).json({ error: error.message || '飞书登录失败' });
    }
});

// 当前登录用户
router.get('/me', requireAuth, (req, res) => {
    res.json({ user: sanitizeUser(req.user) });
});

export default router;
