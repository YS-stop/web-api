import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';

interface LoginPageProps {
    onLogin: (user: any, token: string) => void;
}

export const LoginPage: React.FC<LoginPageProps> = ({ onLogin }) => {
    const { t } = useTranslation();
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);

    const handleFeishuLogin = async () => {
        setError(null);
        setLoading(true);
        try {
            // 获取飞书授权页 URL 并跳转
            const resp = await fetch('/api/auth/feishu/login-url', { cache: 'no-store' });
            const data = await resp.json();
            if (!data.url) throw new Error('获取登录地址失败');
            window.location.href = data.url;
        } catch (e: any) {
            setError(e.message || '登录失败');
            setLoading(false);
        }
    };

    return (
        <div className="w-screen h-screen flex items-center justify-center bg-[#050505]">
            <div className="w-[400px] max-w-[90vw] rounded-2xl p-8 border border-neutral-800 bg-[#0f0f0f] text-center">
                <img src="/TwitCanva-logo.png" alt="TwitCanva" className="w-16 h-16 mx-auto mb-4 rounded-xl object-contain bg-black/30" />
                <h1 className="text-2xl font-semibold text-white mb-1">TwitCanva</h1>
                <p className="text-neutral-500 text-sm mb-8">AI 视频工作流平台</p>

                <button
                    onClick={handleFeishuLogin}
                    disabled={loading}
                    className="w-full py-3 rounded-xl bg-[#3370ff] hover:bg-[#2860e0] text-white font-medium flex items-center justify-center gap-2 transition-colors disabled:opacity-50"
                >
                    {loading ? (
                        <span className="animate-pulse">跳转中...</span>
                    ) : (
                        <>
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="white">
                                <path d="M6 4h4v4H6V4zm8 0h4v4h-4V4zM6 10h4v4H6v-4zm8 0h4v4h-4v-4zM6 16h4v4H6v-4zm8 0h4v4h-4v-4z" />
                            </svg>
                            使用飞书登录
                        </>
                    )}
                </button>

                {error && <p className="text-red-400 text-sm mt-4">{error}</p>}
                <p className="text-neutral-600 text-xs mt-6">仅限本公司人员访问</p>
            </div>
        </div>
    );
};

export default LoginPage;
