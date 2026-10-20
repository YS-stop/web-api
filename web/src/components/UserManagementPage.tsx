import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { ArrowLeft, X, ShieldCheck, Key, Trash2, Network, ChevronDown, ChevronRight, Search } from 'lucide-react';
import type { AuthUser } from '../hooks/useAuth';

interface ManagedUser {
    id: string;
    name: string;
    avatarUrl: string;
    role: string;
    status: string;
    lastLoginAt: string;
    createdAt: string;
    permissions?: Record<string, boolean>;
}

const ROLE_META: Record<string, { label: string; rank: number; badge: string; dot: string }> = {
    admin: { label: '管理员', rank: 3, badge: 'bg-[#e8f1ff] text-[#1677ff]', dot: '#1677ff' },
    project_manager: { label: '项目主管', rank: 2, badge: 'bg-[#eef6ff] text-[#0e6fff]', dot: '#0e6fff' },
    team_leader: { label: '组长', rank: 1, badge: 'bg-[#fff3e8] text-[#ff7d00]', dot: '#ff7d00' },
    user: { label: '组员', rank: 0, badge: 'bg-[#f2f3f5] text-[#86909c]', dot: '#86909c' },
};

const ROLE_ORDER = ['admin', 'project_manager', 'team_leader', 'user'];

// 功能权限点（与后端 userService.PERMISSIONS 保持一致）
const PERMISSION_META: { key: string; label: string; desc: string }[] = [
    { key: 'project_manage', label: '项目管理', desc: '创建、编辑、删除项目/工作流' },
    { key: 'image_generate', label: '图片生成', desc: '使用 AI 生成图片' },
    { key: 'video_generate', label: '视频生成', desc: '使用 AI 生成视频' },
    { key: 'storyboard', label: '分镜脚本', desc: 'AI 编剧与分镜生成' },
    { key: 'social_post', label: '社交发布', desc: '发布到 Twitter / TikTok' },
    { key: 'asset_library', label: '素材库', desc: '保存与管理素材资源' },
    { key: 'member_manage', label: '成员管理', desc: '查看和管理成员' },
];

// 各角色默认权限（用于「重置为角色默认」）
const DEFAULT_PERMISSIONS_BY_ROLE: Record<string, Record<string, boolean>> = {
    admin: Object.fromEntries(PERMISSION_META.map(p => [p.key, true])),
    project_manager: { project_manage: true, image_generate: true, video_generate: true, storyboard: true, social_post: true, asset_library: true, member_manage: false },
    team_leader: { project_manage: false, image_generate: true, video_generate: true, storyboard: true, social_post: false, asset_library: true, member_manage: false },
    user: { project_manage: false, image_generate: true, video_generate: true, storyboard: false, social_post: false, asset_library: false, member_manage: false },
};

function canManage(operatorRole: string | undefined, targetRole: string): boolean {
    if (operatorRole === 'admin') return true;
    if (operatorRole === 'project_manager') return targetRole === 'team_leader';
    if (operatorRole === 'team_leader') return targetRole === 'user';
    return false;
}

interface OrgNode {
    id: string;
    name: string;
    avatarUrl: string;
    role: string;
    children?: OrgNode[];
}

function toOrgNode(u: { id: string; name: string; avatarUrl?: string; role: string }): OrgNode {
    return { id: u.id, name: u.name, avatarUrl: u.avatarUrl || '', role: u.role };
}

function distribute<T>(items: T[], buckets: number): T[][] {
    if (buckets <= 0) return [];
    const result: T[][] = Array.from({ length: buckets }, () => []);
    items.forEach((item, i) => result[i % buckets].push(item));
    return result;
}

// 由真实用户构建组织架构；管理员为独立身份，不纳入「主管 → 组长 → 组员」层级
function buildOrg(users: ManagedUser[]): { admins: OrgNode[]; tree: OrgNode[] } {
    const admins = users.filter(u => u.role === 'admin').map(toOrgNode);
    const pms = users.filter(u => u.role === 'project_manager').map(toOrgNode);
    const tls = users.filter(u => u.role === 'team_leader').map(toOrgNode);
    const members = users.filter(u => u.role === 'user').map(toOrgNode);

    // 组员 → 组长
    const memberGroups = distribute(members, tls.length);
    const tlNodes = tls.map((tl, i) => ({
        ...tl,
        children: memberGroups[i] || [],
    }));

    // 组长 → 项目主管
    const tlGroups = distribute(tlNodes, pms.length);
    const pmNodes = pms.map((pm, i) => ({
        ...pm,
        children: tlGroups[i] || [],
    }));

    return { admins, tree: pmNodes };
}

// 在组织架构树中查找节点
function findNode(nodes: OrgNode[], id: string): OrgNode | null {
    for (const n of nodes) {
        if (n.id === id) return n;
        if (n.children?.length) {
            const found = findNode(n.children, id);
            if (found) return found;
        }
    }
    return null;
}

// 收集某节点下所有指定角色的下级
function collectByRole(node: OrgNode, role: string): OrgNode[] {
    const result: OrgNode[] = [];
    const walk = (n: OrgNode) => {
        if (n.role === role) result.push(n);
        n.children?.forEach(walk);
    };
    node.children?.forEach(walk);
    return result;
}

const OrgTreeNode: React.FC<{
    node: OrgNode;
    collapsed: Set<string>;
    onToggle: (id: string) => void;
    selectedId: string;
    onSelect: (id: string) => void;
}> = ({ node, collapsed, onToggle, selectedId, onSelect }) => {
    const meta = ROLE_META[node.role] || ROLE_META.user;
    const hasChildren = !!(node.children && node.children.length > 0);
    const isCollapsed = collapsed.has(node.id);
    const isSelected = selectedId === node.id;

    return (
        <div>
            <div
                className={`flex items-center gap-1.5 py-1.5 pr-2 pl-1 rounded-lg cursor-pointer select-none transition-colors ${isSelected ? 'bg-[#e8f1ff]' : 'hover:bg-slate-50'}`}
                onClick={() => onSelect(node.id)}
            >
                {hasChildren ? (
                    <button
                        onClick={(e) => { e.stopPropagation(); onToggle(node.id); }}
                        className="w-[18px] h-[18px] flex items-center justify-center rounded hover:bg-slate-200 text-slate-400 shrink-0"
                    >
                        {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                    </button>
                ) : (
                    <span className="w-[18px] shrink-0" />
                )}
                {node.avatarUrl ? (
                    <img src={node.avatarUrl} alt={node.name} className="w-7 h-7 rounded-full object-cover shrink-0 bg-slate-100" />
                ) : (
                    <div className="w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-medium shrink-0 text-white" style={{ background: meta.dot }}>
                        {(node.name || '?').slice(0, 1)}
                    </div>
                )}
                <span className={`text-sm truncate flex-1 ${isSelected ? 'text-[#1677ff] font-medium' : 'text-slate-800'}`}>{node.name}</span>
                <span className={`px-1.5 py-0.5 rounded text-[10px] ${meta.badge}`}>{meta.label}</span>
            </div>
            {hasChildren && !isCollapsed && (
                <div className="ml-[13px] pl-3 border-l border-slate-200">
                    {node.children!.map(child => (
                        <OrgTreeNode key={child.id} node={child} collapsed={collapsed} onToggle={onToggle} selectedId={selectedId} onSelect={onSelect} />
                    ))}
                </div>
            )}
        </div>
    );
};

// 右侧详情：点击组织架构中某个节点（主管/组长/组员）后展示其数据
const NodeDetail: React.FC<{ node: OrgNode; canEdit: boolean; onEdit: () => void }> = ({ node, canEdit, onEdit }) => {
    const meta = ROLE_META[node.role] || ROLE_META.user;
    const directChildren = node.children || [];
    const teamMembers = collectByRole(node, 'user');

    return (
        <div className="space-y-5">
            {/* 节点信息头 */}
            <div className="bg-white rounded-xl border border-slate-200 p-5 flex items-center gap-4">
                {node.avatarUrl ? (
                    <img src={node.avatarUrl} alt={node.name} className="w-14 h-14 rounded-full object-cover shrink-0 bg-slate-100" />
                ) : (
                    <div className="w-14 h-14 rounded-full flex items-center justify-center text-lg font-medium shrink-0 text-white" style={{ background: meta.dot }}>
                        {(node.name || '?').slice(0, 1)}
                    </div>
                )}
                <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                        <span className="text-[16px] font-semibold text-slate-900 truncate">{node.name}</span>
                        <span className={`px-1.5 py-0.5 rounded text-xs ${meta.badge}`}>{meta.label}</span>
                    </div>
                    <div className="text-xs text-slate-400 mt-0.5">飞书账号 · 组织架构成员</div>
                </div>
                {canEdit && (
                    <button onClick={onEdit} className="shrink-0 h-8 px-3 rounded-lg bg-[#1677ff] text-white text-sm hover:bg-[#0e6fff] transition-colors flex items-center gap-1">
                        <Key size={14} />
                        权限设置
                    </button>
                )}
            </div>

            {/* 项目主管：统计卡片 */}
            {node.role === 'project_manager' && (
                <div className="grid grid-cols-2 gap-4">
                    <div className="bg-white rounded-xl border border-slate-200 p-4 flex items-center gap-3">
                        <div className="w-10 h-10 rounded-lg bg-[#fff3e8] flex items-center justify-center text-[#ff7d00] font-semibold">{directChildren.length}</div>
                        <div>
                            <div className="text-sm font-medium text-slate-800">管理的组长</div>
                            <div className="text-xs text-slate-400">直属下级</div>
                        </div>
                    </div>
                    <div className="bg-white rounded-xl border border-slate-200 p-4 flex items-center gap-3">
                        <div className="w-10 h-10 rounded-lg bg-[#f2f3f5] flex items-center justify-center text-[#86909c] font-semibold">{teamMembers.length}</div>
                        <div>
                            <div className="text-sm font-medium text-slate-800">团队组员</div>
                            <div className="text-xs text-slate-400">所有下级组员</div>
                        </div>
                    </div>
                </div>
            )}

            {/* 直属下级列表 */}
            {directChildren.length > 0 && (
                <div className="bg-white rounded-xl border border-slate-200">
                    <div className="px-4 py-3 border-b border-slate-100 font-semibold text-slate-900">
                        {node.role === 'project_manager' ? '管理的组长' : '管理的组员'}
                    </div>
                    <div className="divide-y divide-slate-100">
                        {directChildren.map(child => {
                            const cmeta = ROLE_META[child.role] || ROLE_META.user;
                            return (
                                <div key={child.id} className="flex items-center gap-3 px-4 py-3">
                                    {child.avatarUrl ? (
                                        <img src={child.avatarUrl} alt={child.name} className="w-9 h-9 rounded-full object-cover shrink-0 bg-slate-100" />
                                    ) : (
                                        <div className="w-9 h-9 rounded-full flex items-center justify-center text-xs font-medium shrink-0 text-white" style={{ background: cmeta.dot }}>
                                            {(child.name || '?').slice(0, 1)}
                                        </div>
                                    )}
                                    <div className="min-w-0 flex-1">
                                        <div className="text-sm font-medium text-slate-800 truncate">{child.name}</div>
                                        {child.role === 'team_leader' && <div className="text-xs text-slate-400">{child.children?.length || 0} 名组员</div>}
                                    </div>
                                    <span className={`px-1.5 py-0.5 rounded text-[10px] ${cmeta.badge}`}>{cmeta.label}</span>
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}

            {/* 项目主管：团队全部组员 */}
            {node.role === 'project_manager' && teamMembers.length > 0 && (
                <div className="bg-white rounded-xl border border-slate-200">
                    <div className="px-4 py-3 border-b border-slate-100 font-semibold text-slate-900">团队组员</div>
                    <div className="grid grid-cols-3 gap-3 p-4">
                        {teamMembers.map(m => (
                            <div key={m.id} className="flex items-center gap-2 p-2 rounded-lg bg-[#f7f9fc]">
                                {m.avatarUrl ? (
                                    <img src={m.avatarUrl} alt={m.name} className="w-7 h-7 rounded-full object-cover shrink-0 bg-slate-100" />
                                ) : (
                                    <div className="w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-medium shrink-0 text-white" style={{ background: ROLE_META.user.dot }}>
                                        {(m.name || '?').slice(0, 1)}
                                    </div>
                                )}
                                <span className="text-sm text-slate-700 truncate">{m.name}</span>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* 组员：无下级时的占位提示 */}
            {directChildren.length === 0 && (
                <div className="bg-white rounded-xl border border-slate-200 p-10 text-center">
                    <p className="text-sm text-slate-400">该成员暂无下级，可直接在左侧切换其他节点查看</p>
                </div>
            )}
        </div>
    );
};

interface UserManagementPageProps {
    user: AuthUser | null;
    onBack: () => void;
}

export const UserManagementPage: React.FC<UserManagementPageProps> = ({ user, onBack }) => {
    const [users, setUsers] = useState<ManagedUser[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [drawerOpen, setDrawerOpen] = useState(false);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const [form, setForm] = useState<{ role: string; status: string; permissions: Record<string, boolean> }>({ role: 'user', status: 'active', permissions: {} });

    const token = typeof localStorage !== 'undefined' ? localStorage.getItem('twitcanva_auth_token') || '' : '';
    const operatorRole = user?.role;
    const assignableRoles = ROLE_ORDER.filter(r => canManage(operatorRole, r));
    const myMeta = ROLE_META[operatorRole ?? ''];
    const isManager = operatorRole === 'admin' || operatorRole === 'project_manager' || operatorRole === 'team_leader';
    const isAdmin = operatorRole === 'admin';
    const displayUsers = users;
    const editingUser = editingId ? displayUsers.find(u => u.id === editingId) || null : null;
    const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
    const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
    const [search, setSearch] = useState('');
    const [selectedId, setSelectedId] = useState<string>('__admin__');
    const org = buildOrg(users);
    const selectedNode = selectedId === '__admin__' ? null : findNode(org.tree, selectedId);

    // 搜索过滤
    const filtered = useMemo(() => {
        const q = search.trim().toLowerCase();
        if (!q) return displayUsers;
        return displayUsers.filter(u => u.name.toLowerCase().includes(q) || (ROLE_META[u.role]?.label || '').includes(q));
    }, [displayUsers, search]);

    const toggleGroup = (role: string) => {
        setCollapsedGroups(prev => {
            const next = new Set(prev);
            if (next.has(role)) next.delete(role); else next.add(role);
            return next;
        });
    };

    // 非管理员看不到「管理员」入口，默认落在第一个项目主管，且选中项失效时自动重选
    useEffect(() => {
        if (isAdmin) return;
        if (selectedId === '__admin__' || !findNode(org.tree, selectedId)) {
            if (org.tree.length > 0) setSelectedId(org.tree[0].id);
        }
    }, [isAdmin, selectedId, org.tree]);

    const toggleCollapse = (id: string) => {
        setCollapsed(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        });
    };

    const fetchUsers = useCallback(async () => {
        setLoading(true);
        try {
            const resp = await fetch('/api/users', { headers: { Authorization: 'Bearer ' + token } });
            if (!resp.ok) {
                const data = await resp.json().catch(() => ({}));
                throw new Error(data.error || ('加载用户失败 (' + resp.status + ')'));
            }
            const data = await resp.json();
            setUsers(data.users || []);
            setError('');
        } catch (e) {
            setError((e as Error).message);
        } finally {
            setLoading(false);
        }
    }, [token]);

    useEffect(() => {
        fetchUsers();
    }, [fetchUsers]);

    const openEdit = (u: ManagedUser) => {
        setEditingId(u.id);
        setForm({
            role: u.role,
            status: u.status,
            permissions: { ...(DEFAULT_PERMISSIONS_BY_ROLE[u.role] || DEFAULT_PERMISSIONS_BY_ROLE.user), ...(u.permissions || {}) },
        });
        setDrawerOpen(true);
    };

    const togglePermission = (key: string) => {
        setForm(prev => ({ ...prev, permissions: { ...prev.permissions, [key]: !prev.permissions[key] } }));
    };

    const resetPermissions = () => {
        setForm(prev => ({ ...prev, permissions: { ...(DEFAULT_PERMISSIONS_BY_ROLE[prev.role] || DEFAULT_PERMISSIONS_BY_ROLE.user) } }));
    };

    const closeDrawer = () => {
        if (saving) return;
        setDrawerOpen(false);
        setEditingId(null);
    };

    const save = async () => {
        if (!editingId) return;
        setSaving(true);
        setError('');
        try {
            const resp = await fetch('/api/users/' + editingId, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
                body: JSON.stringify(form),
            });
            if (!resp.ok) {
                const data = await resp.json().catch(() => ({}));
                throw new Error(data.error || ('保存失败 (' + resp.status + ')'));
            }
            setDrawerOpen(false);
            setEditingId(null);
            fetchUsers();
        } catch (e) {
            setError((e as Error).message);
        } finally {
            setSaving(false);
        }
    };

    const toggleStatus = async (u: ManagedUser) => {
        const status = u.status === 'active' ? 'disabled' : 'active';
        try {
            const resp = await fetch('/api/users/' + u.id + '/status', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
                body: JSON.stringify({ status }),
            });
            if (!resp.ok) {
                const data = await resp.json().catch(() => ({}));
                setError(data.error || '操作失败');
                return;
            }
            fetchUsers();
        } catch (e) {
            setError((e as Error).message);
        }
    };

    const removeUser = async (u: ManagedUser) => {
        if (!window.confirm('确定删除用户「' + u.name + '」吗？')) return;
        try {
            const resp = await fetch('/api/users/' + u.id, {
                method: 'DELETE',
                headers: { Authorization: 'Bearer ' + token },
            });
            if (!resp.ok) {
                const data = await resp.json().catch(() => ({}));
                setError(data.error || '删除失败');
                return;
            }
            fetchUsers();
        } catch (e) {
            setError((e as Error).message);
        }
    };

    // 非管理角色无访问权限（后端也会拦截，此处给友好提示）
    if (!isManager) {
        return (
            <div
                className="h-screen w-screen flex flex-col bg-[#f0f2f5] text-slate-800 font-sans overflow-hidden"
                style={{ '--focus-ring': '#1677ff', '--focus-ring-offset': '1px' } as React.CSSProperties}
            >
                <header className="shrink-0 h-14 flex items-center gap-3 px-4 bg-white border-b border-slate-200">
                    <button onClick={onBack} className="flex items-center gap-1.5 h-9 px-3 rounded-lg text-sm text-slate-600 hover:bg-slate-100 transition-colors">
                        <ArrowLeft size={16} />
                        返回
                    </button>
                    <h1 className="text-[16px] font-semibold text-slate-900 flex items-center gap-2">
                        <ShieldCheck size={18} className="text-[#1677ff]" />
                        用户管理与权限
                    </h1>
                </header>
                <div className="flex-1 flex items-center justify-center">
                    <div className="text-center">
                        <ShieldCheck size={48} className="mx-auto text-slate-300 mb-4" />
                        <p className="text-slate-500 font-medium mb-1">无权限访问</p>
                        <p className="text-sm text-slate-400">只有管理员、项目主管或组长可以访问用户管理</p>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div
            className="h-screen w-screen flex flex-col bg-[#f0f2f5] text-slate-800 font-sans overflow-hidden"
            style={{ '--focus-ring': '#1677ff', '--focus-ring-offset': '1px' } as React.CSSProperties}
        >
            {/* 顶栏 */}
            <header className="shrink-0 h-14 flex items-center gap-3 px-4 bg-white border-b border-slate-200">
                <button
                    onClick={onBack}
                    className="flex items-center gap-1.5 h-9 px-3 rounded-lg text-sm text-slate-600 hover:bg-slate-100 transition-colors"
                >
                    <ArrowLeft size={16} />
                    返回
                </button>
                <h1 className="text-[16px] font-semibold text-slate-900 flex items-center gap-2">
                    <ShieldCheck size={18} className="text-[#1677ff]" />
                    用户管理与权限
                </h1>
                <div className="ml-auto flex items-center gap-2.5">
                    <span className="text-xs text-slate-400 flex items-center">
                        我的角色
                        <span className={`px-1.5 py-0.5 rounded ml-1.5 text-xs font-medium ${myMeta?.badge || 'bg-[#f2f3f5] text-[#86909c]'}`}>
                            {myMeta?.label || '组员'}
                        </span>
                    </span>
                    <div className="w-8 h-8 rounded-full bg-[#1677ff] text-white flex items-center justify-center text-xs font-medium">
                        {(user?.name || 'U').slice(0, 1)}
                    </div>
                </div>
            </header>

            {/* 内容 */}
            <main className="flex-1 flex overflow-hidden">
                {/* 左侧：组织架构 */}
                <aside className="w-[300px] shrink-0 bg-white border-r border-slate-200 flex flex-col">
                    <div className="flex items-center gap-2 px-4 h-12 border-b border-slate-100 shrink-0">
                        <Network size={16} className="text-[#1677ff]" />
                        <span className="font-semibold text-slate-900">组织架构</span>
                    </div>
                    <div className="flex-1 overflow-y-auto p-3">
                        {/* 管理员（独立身份，仅管理员可见，不纳入下级层级） */}
                        {isAdmin && (
                            <>
                                <div className="text-[11px] text-slate-400 font-medium px-2 mb-1 mt-1">管理员</div>
                                {org.admins.map((admin) => {
                                    const meta = ROLE_META.admin;
                                    const isSelected = selectedId === '__admin__';
                                    return (
                                        <div
                                            key={admin.id}
                                            className={`flex items-center gap-1.5 py-1.5 pr-2 pl-1 rounded-lg cursor-pointer select-none transition-colors ${isSelected ? 'bg-[#e8f1ff]' : 'hover:bg-slate-50'}`}
                                            onClick={() => setSelectedId('__admin__')}
                                        >
                                            <span className="w-[18px] shrink-0" />
                                            {admin.avatarUrl ? (
                                                <img src={admin.avatarUrl} alt={admin.name} className="w-7 h-7 rounded-full object-cover shrink-0 bg-slate-100" />
                                            ) : (
                                                <div className="w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-medium shrink-0 text-white" style={{ background: meta.dot }}>
                                                    {(admin.name || '?').slice(0, 1)}
                                                </div>
                                            )}
                                            <span className={`text-sm truncate flex-1 ${isSelected ? 'text-[#1677ff] font-medium' : 'text-slate-800'}`}>{admin.name}</span>
                                            <span className={`px-1.5 py-0.5 rounded text-[10px] ${meta.badge}`}>管理员</span>
                                        </div>
                                    );
                                })}

                                <div className="my-2 border-t border-slate-100" />
                            </>
                        )}

                        <div className="text-[11px] text-slate-400 font-medium px-2 mb-1">项目主管</div>
                        {org.tree.map(node => (
                            <OrgTreeNode key={node.id} node={node} collapsed={collapsed} onToggle={toggleCollapse} selectedId={selectedId} onSelect={setSelectedId} />
                        ))}
                    </div>
                </aside>

                {/* 右侧：内容区 */}
                <div className="flex-1 overflow-y-auto">
                    {selectedId === '__admin__' ? (
                    <div className="max-w-[1000px] mx-auto px-6 py-6 space-y-4">
                    {/* 搜索框 */}
                    <div>
                        <div className="flex items-center gap-3">
                            <div className="relative flex-1 max-w-sm">
                                <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                                <input
                                    value={search}
                                    onChange={(e) => setSearch(e.target.value)}
                                    placeholder="搜索成员姓名或角色"
                                    style={{ colorScheme: 'light' }}
                                    className="w-full h-9 pl-9 pr-3 rounded-lg border border-slate-200 bg-white text-sm text-slate-800 placeholder:text-slate-400 outline-none focus:border-[#4558dc] focus:ring-0 focus-visible:outline-none transition-colors"
                                />
                            </div>
                            <span className="text-sm text-slate-400 shrink-0">共 {filtered.length} 人</span>
                        </div>
                    </div>

                    {error && (
                        <div className="px-3 py-2 rounded-lg bg-[#ffece8] text-[#f53f3f] text-sm">{error}</div>
                    )}

                    {loading ? (
                        <div className="bg-white rounded-xl border border-slate-200 p-10 text-center">
                            <p className="text-slate-400 text-sm">加载中...</p>
                        </div>
                    ) : filtered.length === 0 ? (
                        <div className="bg-white rounded-xl border border-slate-200 p-10 text-center">
                            <p className="text-slate-400 text-sm">{search ? '没有匹配的成员' : '暂无用户'}</p>
                        </div>
                    ) : (
                        ROLE_ORDER.map((role) => {
                            const group = filtered.filter(u => u.role === role);
                            if (group.length === 0) return null;
                            const roleMeta = ROLE_META[role];
                            const isCollapsed = collapsedGroups.has(role);
                            return (
                                <div key={role} className="bg-white rounded-xl border border-slate-200">
                                    <div className="flex items-center gap-2 px-4 h-11 cursor-pointer select-none" onClick={() => toggleGroup(role)}>
                                        <span className="text-slate-400 flex items-center">
                                            {isCollapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
                                        </span>
                                        <span className="w-2 h-2 rounded-full shrink-0" style={{ background: roleMeta.dot }} />
                                        <span className="font-semibold text-slate-900">{roleMeta.label}</span>
                                        <span className="text-sm text-slate-400">{group.length} 人</span>
                                    </div>
                                    {!isCollapsed && (
                                        <div className="border-t border-slate-100 divide-y divide-slate-50">
                                            {group.map((u) => {
                                                const manageable = u.id !== user?.id && canManage(operatorRole, u.role);
                                                return (
                                                    <div key={u.id} className="flex items-center gap-3 px-4 py-2.5 hover:bg-[#f7f9fc] transition-colors">
                                                        {u.avatarUrl ? (
                                                            <img src={u.avatarUrl} alt={u.name} className="w-9 h-9 rounded-full object-cover shrink-0 bg-slate-100" />
                                                        ) : (
                                                            <div className="w-9 h-9 rounded-full flex items-center justify-center text-sm font-medium shrink-0 text-white" style={{ background: roleMeta.dot }}>
                                                                {(u.name || '?').slice(0, 1)}
                                                            </div>
                                                        )}
                                                        <div className="min-w-0 flex-1">
                                                            <div className="font-medium text-slate-800 truncate flex items-center gap-1.5">
                                                                {u.name}
                                                                {u.id === user?.id && <span className="text-[10px] text-[#1677ff] border border-[#1677ff] rounded px-1">我</span>}
                                                            </div>
                                                            <div className="text-xs text-slate-400">飞书账号</div>
                                                        </div>
                                                        {manageable ? (
                                                            <button
                                                                onClick={() => toggleStatus(u)}
                                                                className={`shrink-0 text-xs px-2 py-0.5 rounded transition-opacity hover:opacity-80 ${u.status === 'active' ? 'text-[#00b42a] bg-[#e8ffea]' : 'text-[#86909c] bg-[#f2f3f5]'}`}
                                                            >
                                                                {u.status === 'active' ? '启用' : '禁用'}
                                                            </button>
                                                        ) : (
                                                            <span className={`shrink-0 text-xs px-2 py-0.5 rounded ${u.status === 'active' ? 'text-[#00b42a] bg-[#e8ffea]' : 'text-[#86909c] bg-[#f2f3f5]'}`}>
                                                                {u.status === 'active' ? '启用' : '禁用'}
                                                            </span>
                                                        )}
                                                        {manageable && (
                                                            <div className="flex items-center gap-1.5 shrink-0">
                                                                <button onClick={() => openEdit(u)} className="h-7 px-2.5 rounded border border-slate-200 text-slate-600 hover:border-[#1677ff] hover:text-[#1677ff] text-xs transition-colors flex items-center gap-1">
                                                                    <Key size={13} />
                                                                    权限设置
                                                                </button>
                                                                <button onClick={() => removeUser(u)} title="删除" className="h-7 w-7 rounded border border-slate-200 text-slate-400 hover:border-[#f53f3f] hover:text-[#f53f3f] transition-colors flex items-center justify-center">
                                                                    <Trash2 size={14} />
                                                                </button>
                                                            </div>
                                                        )}
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    )}
                                </div>
                            );
                        })
                    )}
                    </div>
                    ) : (
                    <div className="max-w-[1000px] mx-auto px-6 py-6">
                        {selectedNode ? (
                            <NodeDetail
                                node={selectedNode}
                                canEdit={canManage(operatorRole, selectedNode.role)}
                                onEdit={() => {
                                    const target = displayUsers.find(u => u.id === selectedNode.id);
                                    if (target) openEdit(target);
                                }}
                            />
                        ) : (
                            <div className="bg-white rounded-xl border border-slate-200 p-10 text-center">
                                <p className="text-sm text-slate-400">请选择左侧组织架构中的节点查看数据</p>
                            </div>
                        )}
                    </div>
                    )}
                </div>
            </main>

            {/* 抽屉（新增/编辑） */}
            <div className={`fixed inset-0 z-50 ${drawerOpen ? '' : 'pointer-events-none'}`}>
                <div
                    className={`absolute inset-0 bg-black/40 transition-opacity duration-300 ${drawerOpen ? 'opacity-100' : 'opacity-0'}`}
                    onClick={closeDrawer}
                />
                <div className={`absolute right-0 top-0 h-full w-[460px] max-w-[92vw] bg-white shadow-2xl flex flex-col transform transition-transform duration-300 ${drawerOpen ? 'translate-x-0' : 'translate-x-full'}`}>
                    <div className="flex items-center justify-between px-5 h-14 border-b border-slate-100">
                        <h2 className="text-[16px] font-semibold text-slate-900">用户权限设置</h2>
                        <button onClick={closeDrawer} className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-400 hover:bg-slate-100 hover:text-slate-600">
                            <X size={18} />
                        </button>
                    </div>

                    <div className="flex-1 overflow-y-auto px-5 py-5 space-y-5">
                        {/* 只读的飞书身份信息 */}
                        <div className="flex items-center gap-3 p-3 rounded-xl bg-[#f7f9fc] border border-slate-100">
                            {editingUser?.avatarUrl ? (
                                <img src={editingUser.avatarUrl} alt={editingUser.name} className="w-10 h-10 rounded-full object-cover shrink-0 bg-slate-100" />
                            ) : (
                                <div className="w-10 h-10 rounded-full bg-[#1677ff] text-white flex items-center justify-center text-sm font-medium shrink-0">
                                    {(editingUser?.name || '?').slice(0, 1)}
                                </div>
                            )}
                            <div className="min-w-0">
                                <div className="text-sm font-medium text-slate-800 truncate">{editingUser?.name || '—'}</div>
                                <div className="text-xs text-slate-400">飞书身份信息 · 登录自动同步</div>
                            </div>
                        </div>
                        <div>
                            <label className="block text-sm font-medium text-slate-700 mb-1.5">角色</label>
                            <select
                                value={form.role}
                                onChange={(e) => setForm({ ...form, role: e.target.value })}
                                className="w-full h-9 px-3 rounded-lg border border-slate-200 text-sm bg-white outline-none focus:border-[#1677ff] transition-colors"
                            >
                                {assignableRoles.map((r) => (
                                    <option key={r} value={r}>{ROLE_META[r].label}</option>
                                ))}
                            </select>
                            <p className="text-xs text-slate-400 mt-1.5">你只能分配不超过自己权限的角色</p>
                        </div>
                        <div>
                            <label className="block text-sm font-medium text-slate-700 mb-1.5">状态</label>
                            <div className="flex gap-2">
                                {[
                                    { value: 'active', label: '启用' },
                                    { value: 'disabled', label: '禁用' },
                                ].map((s) => (
                                    <button
                                        key={s.value}
                                        onClick={() => setForm({ ...form, status: s.value })}
                                        className={`flex-1 h-9 rounded-lg text-sm border transition-colors ${form.status === s.value ? 'bg-[#e8f1ff] border-[#1677ff] text-[#1677ff] font-medium' : 'border-slate-200 text-slate-600 hover:bg-slate-50'}`}
                                    >
                                        {s.label}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* 功能权限设置 */}
                        <div>
                            <div className="flex items-center justify-between mb-1.5">
                                <label className="text-sm font-medium text-slate-700">功能权限</label>
                                <button onClick={resetPermissions} className="text-xs text-[#1677ff] hover:underline">
                                    重置为角色默认
                                </button>
                            </div>
                            <div className="rounded-xl border border-slate-200 divide-y divide-slate-100">
                                {PERMISSION_META.map((p) => {
                                    const enabled = !!form.permissions[p.key];
                                    return (
                                        <div key={p.key} className="flex items-center justify-between gap-3 px-3 py-2.5">
                                            <div className="min-w-0">
                                                <div className="text-sm text-slate-800">{p.label}</div>
                                                <div className="text-xs text-slate-400 truncate">{p.desc}</div>
                                            </div>
                                            <button
                                                onClick={() => togglePermission(p.key)}
                                                className={`relative w-10 h-[22px] rounded-full transition-colors shrink-0 ${enabled ? 'bg-[#1677ff]' : 'bg-slate-300'}`}
                                            >
                                                <span
                                                    className={`absolute top-[3px] left-[3px] w-4 h-4 rounded-full bg-white shadow transition-transform ${enabled ? 'translate-x-[18px]' : 'translate-x-0'}`}
                                                />
                                            </button>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    </div>

                    <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-slate-100">
                        <button onClick={closeDrawer} disabled={saving} className="h-9 px-4 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 text-sm transition-colors disabled:opacity-50">
                            取消
                        </button>
                        <button onClick={save} disabled={saving} className="h-9 px-5 rounded-lg bg-[#1677ff] hover:bg-[#4080ff] text-white text-sm font-medium transition-colors disabled:opacity-50">
                            {saving ? '保存中...' : '保存'}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default UserManagementPage;
