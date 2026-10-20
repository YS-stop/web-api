/**
 * feishu.js
 *
 * 飞书开放平台 OAuth 网页应用登录服务。
 * 流程：授权页 → code → app_access_token → user_access_token → 用户信息
 */

const FEISHU_BASE_URL = 'https://open.feishu.cn';

let cachedAppToken = null;
let cachedAppTokenExpireAt = 0;

/**
 * 获取 app_access_token（带内存缓存，7200 秒有效，提前 60 秒刷新）
 */
export async function getAppAccessToken() {
    if (cachedAppToken && Date.now() < cachedAppTokenExpireAt) {
        return cachedAppToken;
    }
    // 必须在调用时读取环境变量：ESM 会提升 import，模块加载时 dotenv.config() 尚未执行，
    // 顶层直接读 process.env.FEISHU_APP_ID 会得到 undefined（与 twitter.js / tiktok-post.js 同理）。
    const appId = process.env.FEISHU_APP_ID;
    const appSecret = process.env.FEISHU_APP_SECRET;
    if (!appId || !appSecret) {
        throw new Error('飞书应用未配置（FEISHU_APP_ID / FEISHU_APP_SECRET）');
    }

    const resp = await fetch(FEISHU_BASE_URL + '/open-apis/auth/v3/app_access_token/internal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    });
    const data = await resp.json();
    if (data.code !== 0) {
        throw new Error('飞书 app_access_token 获取失败: ' + (data.msg || JSON.stringify(data)));
    }
    cachedAppToken = data.app_access_token;
    cachedAppTokenExpireAt = Date.now() + (data.expire - 60) * 1000;
    return cachedAppToken;
}

/**
 * 用授权码换取 user_access_token
 */
export async function exchangeCodeForUserAccessToken(code) {
    const appAccessToken = await getAppAccessToken();
    const resp = await fetch(FEISHU_BASE_URL + '/open-apis/authen/v1/access_token', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + appAccessToken,
        },
        body: JSON.stringify({ grant_type: 'authorization_code', code }),
    });
    const data = await resp.json();
    if (data.code !== 0) {
        throw new Error('飞书 code 换 token 失败: ' + (data.msg || JSON.stringify(data)));
    }
    return data.data;
}

/**
 * 用 user_access_token 获取用户信息
 */
export async function getUserInfo(userAccessToken) {
    const resp = await fetch(FEISHU_BASE_URL + '/open-apis/authen/v1/user_info', {
        headers: { 'Authorization': 'Bearer ' + userAccessToken },
    });
    const data = await resp.json();
    if (data.code !== 0) {
        throw new Error('飞书获取用户信息失败: ' + (data.msg || JSON.stringify(data)));
    }
    return data.data;
}

/**
 * 获取当前应用所属企业（租户）名称。
 * 飞书 user_info 不返回企业名称，这里用 app_access_token（企业自建应用等价于 tenant_access_token）
 * 调用「获取企业信息」接口，返回企业全称（如「博远众合」）。失败返回空字符串。
 */
export async function getTenantName() {
    // 兜底：飞书权限未开通时，可用环境变量 COMPANY_NAME 手动指定公司名
    const envCompany = process.env.COMPANY_NAME || '';
    try {
        const appAccessToken = await getAppAccessToken();
        const resp = await fetch(FEISHU_BASE_URL + '/open-apis/tenant/v2/tenant/query', {
            headers: { 'Authorization': 'Bearer ' + appAccessToken },
        });
        const data = await resp.json();
        if (data.code === 0 && data.data && data.data.tenant && data.data.tenant.name) {
            return data.data.tenant.name;
        }
        console.warn('[feishu] 获取企业名称失败，飞书返回:', JSON.stringify(data));
    } catch (e) {
        console.error('[feishu] 获取企业名称失败:', e);
    }
    return envCompany;
}

/**
 * 完整登录流程：code → 用户信息
 */
export async function authenticateWithCode(code) {
    const tokenData = await exchangeCodeForUserAccessToken(code);
    const userInfo = await getUserInfo(tokenData.access_token);
    return userInfo;
}

export default { getAppAccessToken, exchangeCodeForUserAccessToken, getUserInfo, getTenantName, authenticateWithCode };
