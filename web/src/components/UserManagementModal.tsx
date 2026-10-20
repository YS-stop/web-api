import React, { useState, useEffect } from 'react';
import { X } from 'lucide-react';

interface User {
    id: string;
    name: string;
    email: string;
    mobile: string;
    role: string;
    status: string;
    lastLoginAt: string;
}

const ROLE_OPTIONS = [
    { value: 'admin', label: '管理员' },
    { value: 'project_manager', label: '项目主管' },
    { value: 'team_leader', label: '组长' },
    { value: 'user', label: '用户' },
];

interface UserManagementModalProps {
    isOpen: boolean;
    onClose: () => void;
}

export const UserManagementModal: React.FC<UserManagementModalProps> = ({ isOpen, onClose }) => {
    const [users, setUsers] = useState<User[]>([]);
    const [loading, setLoading] = useState(false);

    const token = typeof localStorage !== 'undefined' ? localStorage.getItem('twitcanva_auth_token') || '' : '';

    const fetchUsers = async () => {
        setLoading(true);
        try {
            const resp = await fetch('/api/users', { headers: { Authorization: 'Bearer ' + token } });
            if (resp.ok) {
                const data = await resp.json();
                setUsers(data.users || []);
            }
        } catch (e) {
            console.error('加载用户失败:', e);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        if (isOpen) fetchUsers();
    }, [isOpen]);

    const updateRole = async (id: string, role: string) => {
        await fetch('/api/users/' + id + '/role', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
            body: JSON.stringify({ role }),
        });
        fetchUsers();
    };

    const toggleStatus = async (id: string, status: string) => {
        await fetch('/api/users/' + id + '/status', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
            body: JSON.stringify({ status }),
        });
        fetchUsers();
    };

    const removeUser = async (id: string) => {
        await fetch('/api/users/' + id, { method: 'DELETE', headers: { Authorization: 'Bearer ' + token } });
        fetchUsers();
    };

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-[130]">
            <div className="w-[640px] max-w-[92vw] max-h-[80vh] rounded-2xl border border-neutral-700 bg-[#1a1a1a] flex flex-col overflow-hidden">
                <div className="flex items-center justify-between p-4 border-b border-neutral-800">
                    <h3 className="text-lg font-semibold text-white">用户管理</h3>
                    <button onClick={onClose} className="p-2 rounded-lg hover:bg-neutral-800 text-neutral-400 hover:text-white">
                        <X size={18} />
                    </button>
                </div>
                <div className="flex-1 overflow-y-auto p-4 space-y-2">
                    {loading && <p className="text-neutral-400 text-sm text-center py-8">加载中...</p>}
                    {!loading && users.length === 0 && <p className="text-neutral-400 text-sm text-center py-8">暂无用户</p>}
                    {users.map(u => (
                        <div key={u.id} className="flex items-center gap-3 p-3 rounded-lg border border-neutral-800 bg-[#0f0f0f]">
                            <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2">
                                    <span className="text-white text-sm font-medium truncate">{u.name || '未命名'}</span>
                                    {u.status === 'disabled' && (
                                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/20 text-red-400">已禁用</span>
                                    )}
                                </div>
                                <p className="text-neutral-500 text-xs truncate">{u.email || u.mobile || '-'}</p>
                            </div>
                            <select
                                value={u.role}
                                onChange={e => updateRole(u.id, e.target.value)}
                                className="text-xs bg-neutral-800 border border-neutral-700 text-neutral-200 rounded-lg px-2 py-1"
                            >
                                {ROLE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                            </select>
                            <button
                                onClick={() => toggleStatus(u.id, u.status === 'active' ? 'disabled' : 'active')}
                                className="text-xs px-2 py-1 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-neutral-300"
                            >
                                {u.status === 'active' ? '禁用' : '启用'}
                            </button>
                            <button
                                onClick={() => removeUser(u.id)}
                                className="text-xs px-2 py-1 rounded-lg bg-red-500/10 hover:bg-red-500/20 text-red-400"
                            >
                                删除
                            </button>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
};

export default UserManagementModal;
