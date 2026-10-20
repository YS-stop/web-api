import { useState, useEffect, useCallback } from 'react';

export interface AuthUser {
    id: string;
    name: string;
    avatarUrl: string;
    role: 'admin' | 'project_manager' | 'team_leader' | 'user';
    status: string;
    companyName?: string;
}

const TOKEN_KEY = 'twitcanva_auth_token';

export function useAuth() {
    const [user, setUser] = useState<AuthUser | null>(null);
    const [loading, setLoading] = useState(true);

    // 初始化：若本地有 token，验证并拉取当前用户
    useEffect(() => {
        const token = localStorage.getItem(TOKEN_KEY);
        if (!token) {
            setLoading(false);
            return;
        }
        fetch('/api/auth/me', { headers: { Authorization: 'Bearer ' + token } })
            .then(r => (r.ok ? r.json() : Promise.reject()))
            .then(data => setUser(data.user))
            .catch(() => { localStorage.removeItem(TOKEN_KEY); setUser(null); })
            .finally(() => setLoading(false));
    }, []);

    const login = useCallback((user: AuthUser, token: string) => {
        localStorage.setItem(TOKEN_KEY, token);
        setUser(user);
    }, []);

    const logout = useCallback(() => {
        localStorage.removeItem(TOKEN_KEY);
        setUser(null);
    }, []);

    return { user, loading, login, logout, isLoggedIn: !!user };
}

export default useAuth;
