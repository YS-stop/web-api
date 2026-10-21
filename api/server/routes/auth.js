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
async function verifyCompanyMember(userInfo) {
    const envTenant = process.env.FEISHU_TENANT_KEY;
    if (envTenant) {
        if (userInfo.tenant_key !== envTenant) {
            return { allowed: false, reason: '非本公司人员，禁止访问' };
        }
        return { allowed: true };
    }
    const companyTenant = await getCompanyTenantKey();
    if (companyTenant) {
        if (userInfo.tenant_key !== companyTenant) {
            return { allowed: false, reason: '非本公司人员，禁止访问' };
        }
        return { allowed: true };
    }
    return { allowed: true };
}

/**
 * 动态生成飞书回调地址：优先取请求来源（前端页面地址），谁访问就回调到谁的 IP。
 * 这样多台电脑各自跑前端（各自 IP）时，登录回调不会固定跳回某一台。
 * 飞书后台「重定向 URL」白名单需包含所有可能的前端地址。
 */
function resolveRedirectUri(req) {
    const referer = req.headers.referer;
    if (referer) {
        try {
            const u = new URL(referer);
            return `${u.protocol}//${u.host}/auth/callback`;
        } catch {
            // referer 非法时忽略，继续尝试 origin
        }
    }
    const origin = req.headers.origin;
    if (origin) {
        return `${origin}/auth/callback`;
    }
    return null;
}

// 获取飞书授权页 URL（供前端跳转）
router.get('/feishu/login-url', (req, res) => {
    // 禁用缓存：回调地址随请求来源动态变化，绝不能被浏览器/ETag 304 缓存，
    // 否则多台电脑各自 IP 访问时，会拿到缓存里的旧 redirect_uri 导致重定向不回来
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    const appId = process.env.FEISHU_APP_ID;
    if (!appId) {
        return res.status(500).json({ error: 'FEISHU_APP_ID not configured' });
    }
    const redirectUri = resolveRedirectUri(req)
        || process.env.FEISHU_REDIRECT_URI
        || 'http://localhost:8025/auth/callback';
    const url = 'https://open.feishu.cn/open-apis/authen/v1/index?app_id=' + appId + '&redirect_uri=' + encodeURIComponent(redirectUri);

    console.log('[auth:login-url] referer=%s -> redirect_uri=%s', req.headers.referer || '(无)', redirectUri);

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
        const verify = await verifyCompanyMember(userInfo);
        if (!verify.allowed) {
            return res.status(403).json({ error: verify.reason });
        }

        const user = await findOrCreateUser(userInfo);

        // 首次登录：由管理员锁定本公司（企业）标识，之后仅本公司人员可登录
        if (!process.env.FEISHU_TENANT_KEY && !(await getCompanyTenantKey()) && userInfo.tenant_key && user.role === 'admin') {
            await setCompanyTenantKey(userInfo.tenant_key);
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
