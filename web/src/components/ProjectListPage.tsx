import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
    FolderKanban,
    Plus,
    Search,
    RotateCcw,
    RefreshCw,
    SlidersHorizontal,
    ChevronDown,
    ChevronLeft,
    ChevronRight,
    Clock,
    AlertTriangle,
    Play,
    Settings,
    ClipboardCheck,
    PenTool,
    Check,
} from 'lucide-react';
import { CreateProjectModal, CreateProjectData } from './modals/CreateProjectModal';
import { Project, fetchProjects, createProject, fetchChangeRequests, canApprove, canCreateProject, canAssignProject, CONTENT_TYPES } from '../services/projectService';
import { computeProjectProgress, ProjectProgress } from '../services/projectProgress';
import { persistUiState, fetchProjectProgress } from '../services/projectStateService';

const ROLE_LABELS: Record<string, string> = {
    admin: '管理员',
    project_manager: '项目主管',
    team_leader: '组长',
    user: '组员',
};

/** 状态标签配色 */
const STATUS_STYLE: Record<string, string> = {
    制作中: 'bg-[#e6f4ff] text-[#1677ff]',
    已完成: 'bg-[#f6ffed] text-[#52c41a]',
    审核中: 'bg-[#fffbe6] text-[#faad14]',
    待启动: 'bg-[#fafafa] text-[#8c8c8c]',
};

/** 状态视图 Tab */
const TABS = ['生产中', '待审核', '有异常'] as const;
type TabKey = (typeof TABS)[number];

/** 图例标签配色，与表格状态色保持同一语义 */
const TAB_STYLE: Record<TabKey, { idle: string; active: string }> = {
    生产中: {
        idle: 'bg-[#e6f4ff] text-[#1677ff]',
        active: 'bg-[#e6f4ff] text-[#1677ff] ring-1 ring-inset ring-[#1677ff]/50 font-medium',
    },
    待审核: {
        idle: 'bg-[#fffbe6] text-[#faad14]',
        active: 'bg-[#fffbe6] text-[#faad14] ring-1 ring-inset ring-[#faad14]/60 font-medium',
    },
    有异常: {
        idle: 'bg-[#fff2f0] text-[#ff4d4f]',
        active: 'bg-[#fff2f0] text-[#ff4d4f] ring-1 ring-inset ring-[#ff4d4f]/50 font-medium',
    },
};

/** 可自定义显示的表格列（宽度按原型 1600px 表格折算为百分比） */
const ALL_COLUMNS = [
    { key: 'project', label: '项目 / 编号', w: 16.875, center: false },
    { key: 'script', label: '剧目与锁定剧本', w: 16.25, center: false },
    { key: 'owner', label: '负责人', w: 9.375, center: false },
    { key: 'stage', label: '当前生产阶段', w: 9.6875, center: false },
    { key: 'progress', label: '分集进度', w: 12.8125, center: false },
    { key: 'abnormal', label: '异常', w: 5, center: true },
    { key: 'status', label: '状态', w: 6.25, center: false },
    { key: 'updated', label: '最近更新', w: 7.5, center: false },
    { key: 'actions', label: '操作', w: 20, center: false },
] as const;
type ColumnKey = (typeof ALL_COLUMNS)[number]['key'];

const DEFAULT_FILTERS = { type: '全部类型', source: '全部来源', status: '全部状态' };
const PAGE_SIZE = 10;

function formatRelativeTime(iso: string): string {
    if (!iso) return '—';
    const t = new Date(iso).getTime();
    if (isNaN(t)) return iso;
    const diff = Date.now() - t;
    const min = Math.floor(diff / 60000);
    if (min < 1) return '刚刚';
    if (min < 60) return min + ' 分钟前';
    const hr = Math.floor(min / 60);
    if (hr < 24) return hr + ' 小时前';
    const day = Math.floor(hr / 24);
    if (day < 30) return day + ' 天前';
    return new Date(iso).toLocaleDateString();
}

/** 距上次刷新的相对时间文案 */
function formatRefreshAgo(timestamp: number): string {
    const min = Math.floor((Date.now() - timestamp) / 60000);
    if (min < 1) return '刚刚';
    return `${min} 分钟前`;
}

interface FilterSelectProps {
    value: string;
    options: string[];
    onChange: (v: string) => void;
    width: number;
}

/** 填充式下拉 */
const FilterSelect: React.FC<FilterSelectProps> = ({ value, options, onChange, width }) => {
    const [open, setOpen] = useState(false);
    return (
        <div className="relative">
            <button
                type="button"
                onClick={() => setOpen(!open)}
                onBlur={() => setOpen(false)}
                style={{ width }}
                className="flex items-center justify-between gap-2 h-8 px-[11px] rounded-md bg-[rgba(0,0,0,0.04)] border border-transparent text-[rgba(0,0,0,0.88)] text-sm hover:bg-[rgba(0,0,0,0.06)] transition-colors"
            >
                <span className="truncate">{value}</span>
                <ChevronDown size={12} className="text-[rgba(0,0,0,0.45)] shrink-0" />
            </button>
            {open && (
                <div className="absolute z-30 top-full mt-1 w-full bg-white rounded-lg shadow-[0_6px_16px_rgba(0,0,0,0.08),0_3px_6px_-4px_rgba(0,0,0,0.12),0_9px_28px_8px_rgba(0,0,0,0.05)] py-1 max-h-[260px] overflow-y-auto">
                    {options.map((o) => (
                        <button
                            key={o}
                            type="button"
                            onMouseDown={() => { onChange(o); setOpen(false); }}
                            className={`block w-full text-left px-3 py-1.5 text-sm transition-colors hover:bg-[#fafafa] ${value === o ? 'text-[#4558dc] font-medium bg-[#f0f4ff]' : 'text-[rgba(0,0,0,0.88)]'}`}
                        >
                            {o}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
};

interface ProjectListPageProps {
    user: { name?: string; avatarUrl?: string; role?: string } | null;
    onEnterCanvas: (projectId: string) => void;
    onEnterWorkflow: (projectId: string) => void;
    onOpenProjectDetail: (projectId: string) => void;
    onOpenFreeCanvas: () => void;
    onOpenSettings?: () => void;
    onOpenApprovals?: () => void;
}

export const ProjectListPage: React.FC<ProjectListPageProps> = ({ user, onEnterCanvas, onEnterWorkflow, onOpenProjectDetail, onOpenFreeCanvas, onOpenSettings, onOpenApprovals }) => {
    const [activeTab, setActiveTab] = useState<TabKey | null>(null);
    const [draftFilters, setDraftFilters] = useState(DEFAULT_FILTERS);
    const [appliedFilters, setAppliedFilters] = useState(DEFAULT_FILTERS);
    const [draftKeyword, setDraftKeyword] = useState('');
    const [appliedKeyword, setAppliedKeyword] = useState('');
    const [projects, setProjects] = useState<Project[]>([]);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState('');
    const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
    // 可指派的组长列表（管理员 / 项目主管新建项目时使用）
    const [leaders, setLeaders] = useState<{ id: string; name: string }[]>([]);
    const [pendingCount, setPendingCount] = useState(0);
    const [lastLoadedAt, setLastLoadedAt] = useState(Date.now());
    // 每 30s 触发一次，驱动「数据刷新于 X 分钟前」重新计算
    const [, setTick] = useState(0);
    const [page, setPage] = useState(1);
    const [visibleColumns, setVisibleColumns] = useState<ColumnKey[]>(ALL_COLUMNS.map((c) => c.key));
    const [columnMenuOpen, setColumnMenuOpen] = useState(false);

    // ---------- 表格横向滚动：驱动首列 / 操作列固定时的阴影提示 ----------
    const scrollRef = useRef<HTMLDivElement | null>(null);
    const [scrollState, setScrollState] = useState({ left: false, right: false });

    const syncScrollShadows = () => {
        const el = scrollRef.current;
        if (!el) return;
        const maxLeft = el.scrollWidth - el.clientWidth;
        setScrollState({
            left: el.scrollLeft > 1,
            right: maxLeft > 1 && el.scrollLeft < maxLeft - 1,
        });
    };

    useEffect(() => {
        syncScrollShadows();
        const onResize = () => syncScrollShadows();
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
    }, [visibleColumns, loading, projects.length]);

    const canApproveRole = canApprove(user?.role);
    const canCreateRole = canCreateProject(user?.role);
    const canAssignRole = canAssignProject(user?.role);

    const loadProjects = async () => {
        setLoading(true);
        setLoadError('');
        try {
            setProjects(await fetchProjects());
            setLastLoadedAt(Date.now());
        } catch (e: any) {
            setLoadError(e.message || '加载项目失败');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => { loadProjects(); }, []);

    useEffect(() => {
        const timer = setInterval(() => setTick((t) => t + 1), 30000);
        return () => clearInterval(timer);
    }, []);

    // 审批入口角标（仅管理员 / 项目主管）
    useEffect(() => {
        if (!canApproveRole) return;
        fetchChangeRequests()
            .then((rs) => setPendingCount(rs.filter((r) => r.status === 'pending').length))
            .catch(() => setPendingCount(0));
    }, [canApproveRole]);

    // 管理员 / 项目主管：拉取组长列表，用于新建项目时指派归属组长
    useEffect(() => {
        if (!canAssignRole) return;
        const token = typeof localStorage !== 'undefined' ? localStorage.getItem('twitcanva_auth_token') || '' : '';
        fetch('/api/users', { headers: { Authorization: 'Bearer ' + token } })
            .then((r) => (r.ok ? r.json() : Promise.reject(new Error('加载成员失败'))))
            .then((data) => {
                const list = (data.users || [])
                    .filter((u: any) => u.role === 'team_leader')
                    .map((u: any) => ({ id: u.id, name: u.name || String(u.id).slice(0, 6) }));
                setLeaders(list);
            })
            .catch(() => setLeaders([]));
    }, [canAssignRole]);

    const handleCreateProject = async (data: CreateProjectData) => {
        try {
            await createProject(data);
            await loadProjects();
        } catch (e: any) {
            alert('创建项目失败：' + (e.message || '未知错误'));
        }
    };

    // ---------- 项目进度：优先用服务端聚合结果，失败时回退本地缓存推导 ----------
    const [serverProgress, setServerProgress] = useState<Record<string, ProjectProgress>>({});

    useEffect(() => {
        let cancelled = false;
        if (projects.length === 0) {
            setServerProgress({});
            return undefined;
        }
        (async () => {
            const remote = (await fetchProjectProgress()) as Record<string, ProjectProgress>;
            if (!cancelled) setServerProgress(remote);
        })();
        return () => {
            cancelled = true;
        };
    }, [projects.length]);

    const progressMap = useMemo(() => {
        const map: Record<string, ProjectProgress> = {};
        projects.forEach((p) => {
            map[p.id] = serverProgress[p.id] || computeProjectProgress(p.id, p.totalEpisodes);
        });
        return map;
    }, [projects, serverProgress]);

    // ---------- 摘要指标（全部由真实数据汇总） ----------
    const stats = useMemo(() => {
        let active = 0;
        let running = 0;
        let confirm = 0;
        let abnormal = 0;
        projects.forEach((p) => {
            const prog = progressMap[p.id];
            if (!prog) return;
            if (prog.started && prog.status !== '已完成') active += 1;
            running += prog.runningEpisodes;
            confirm += prog.pendingConfirm;
            abnormal += prog.abnormal;
        });
        return [
            { key: 'active', label: '在制项目', value: active, note: `共 ${projects.length} 个项目`, tone: '' },
            { key: 'running', label: '运行中的分集', value: running, note: '视频生成中', tone: '' },
            { key: 'confirm', label: '待人工确认', value: confirm, note: '分镜待生成视频', tone: 'text-[#d98c2d]' },
            { key: 'abnormal', label: '异常任务', value: abnormal, note: '超时未完成', tone: 'text-[#d65d66]' },
        ];
    }, [projects, progressMap]);

    // ---------- Tab + 筛选过滤 ----------
    const filteredProjects = useMemo(() => {
        return projects.filter((p) => {
            const prog = progressMap[p.id];
            if (!prog) return false;

            // 状态视图
            if (activeTab === '待审核' && prog.status !== '审核中') return false;
            if (activeTab === '有异常' && prog.abnormal <= 0) return false;

            // 下拉筛选（点击「查询」后生效）
            if (appliedFilters.type !== '全部类型' && p.category !== appliedFilters.type) return false;
            if (appliedFilters.source !== '全部来源' && p.scriptSource !== appliedFilters.source) return false;
            if (appliedFilters.status !== '全部状态' && prog.status !== appliedFilters.status) return false;

            // 关键词搜索（项目 / 剧目 / 剧本 / 负责人）
            const kw = appliedKeyword.trim().toLowerCase();
            if (kw) {
                const haystack = [p.name, p.dramaName, p.scriptName, p.owner, p.code].join(' ').toLowerCase();
                if (!haystack.includes(kw)) return false;
            }
            return true;
        });
    }, [projects, progressMap, activeTab, appliedFilters, appliedKeyword]);

    // ---------- 分页 ----------
    const totalPages = Math.max(1, Math.ceil(filteredProjects.length / PAGE_SIZE));
    const safePage = Math.min(page, totalPages);
    const pageProjects = filteredProjects.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

    useEffect(() => {
        if (page > totalPages) setPage(1);
    }, [totalPages, page]);

    const handleSearch = () => {
        setAppliedFilters({ ...draftFilters });
        setAppliedKeyword(draftKeyword);
        setPage(1);
    };

    const handleReset = () => {
        setDraftFilters(DEFAULT_FILTERS);
        setAppliedFilters(DEFAULT_FILTERS);
        setDraftKeyword('');
        setAppliedKeyword('');
        setActiveTab(null);
        setPage(1);
    };

    const toggleColumn = (key: ColumnKey) => {
        setVisibleColumns((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
    };

    const isColVisible = (key: ColumnKey) => visibleColumns.includes(key);
    const visibleCols = ALL_COLUMNS.filter((c) => isColVisible(c.key));
    const visibleWidthSum = visibleCols.reduce((s, c) => s + c.w, 0) || 1;
    const visibleColumnCount = visibleCols.length || 1;

    return (
        <div
            className="drama-projects-page h-screen w-screen overflow-hidden text-[rgba(0,0,0,0.88)]"
            style={{
                background: 'linear-gradient(#ffffff, #f5f5f5 28%)',
                backgroundAttachment: 'fixed',
                fontFamily: 'AlibabaSans, Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif',
            }}
        >
            <style>{`
                /* 浅色管理页主题：覆盖全局焦点环令牌（index.html 默认值是画布的紫罗兰色） */
                .drama-projects-page { color-scheme: light; --focus-ring: #4558dc; --focus-ring-offset: 1px; }
                .drama-projects-page ::-webkit-scrollbar { width: 8px; height: 8px; }
                .drama-projects-page ::-webkit-scrollbar-track { background: transparent; }
                .drama-projects-page ::-webkit-scrollbar-thumb { background: rgba(0, 0, 0, 0.16); border-radius: 4px; }
                .drama-projects-page ::-webkit-scrollbar-thumb:hover { background: rgba(0, 0, 0, 0.28); }
                /* 搜索框由外层容器统一给出焦点边框，输入框本身不再画 outline，避免双重描边 */
                .drama-projects-page .project-search-input:focus-visible { outline: none; }
            `}</style>

            <main className="flex h-full flex-col overflow-hidden">
                {/* 顶部全局栏 */}
                <header className="shrink-0 h-14 flex items-center justify-between px-4 border-b border-[rgba(5,5,5,0.06)] bg-[rgba(255,255,255,0.6)] backdrop-blur-[8px] z-20">
                    <div className="flex items-center gap-2.5">
                        {/*<div className="w-7 h-7 rounded-lg bg-[linear-gradient(135deg,#5367e7,#7357d9)] flex items-center justify-center shrink-0">*/}
                        {/*    <span className="text-white text-[13px] font-bold leading-none">星</span>*/}
                        {/*</div>*/}
                        {/*<span className="text-[15px] font-semibold text-[#27304b] tracking-tight">星幕中台</span>*/}
                    </div>

                    <div className="flex items-center gap-3">
                        <div className="w-px h-4 bg-[rgba(5,5,5,0.06)]" />
                        <div className="flex items-center gap-2">
                            {user?.avatarUrl ? (
                                <img src={user.avatarUrl} alt={user.name} className="w-7 h-7 rounded-full object-cover shrink-0" />
                            ) : (
                                <div className="w-7 h-7 rounded-full bg-[#4558dc] text-white flex items-center justify-center text-xs font-medium shrink-0">
                                    {(user?.name || 'U').slice(0, 1)}
                                </div>
                            )}
                            <div className="leading-tight">
                                <div className="text-[13px] text-[rgba(0,0,0,0.88)]">{user?.name || '用户'}</div>
                                <div className="text-[11px] text-[rgba(0,0,0,0.45)]">{user?.role ? (ROLE_LABELS[user.role] || user.role) : ''}</div>
                            </div>
                            {onOpenSettings && (
                                <button
                                    onClick={onOpenSettings}
                                    title="设置"
                                    className="ml-1 w-8 h-8 rounded-md flex items-center justify-center text-[rgba(0,0,0,0.45)] hover:text-[#4558dc] hover:bg-[rgba(0,0,0,0.04)] transition-colors shrink-0"
                                >
                                    <Settings size={16} />
                                </button>
                            )}
                        </div>
                    </div>
                </header>

                {/* 页头（固定）：面包屑 + 标题 + 操作 */}
                <div className="shrink-0 bg-white px-10 pt-2 pb-4 border-b border-[#f0f0f0]">
                    <nav className="flex items-center text-sm pt-[18px] text-[rgba(0,0,0,0.45)]">
                            <button
                                type="button"
                                onClick={() => { /* 已在当前模块 */ }}
                                className="px-1 -mx-1 rounded text-[rgba(0,0,0,0.45)] hover:text-[#4558dc] transition-colors"
                            >
                                短剧创作
                            </button>
                            <span className="mx-2 text-[rgba(0,0,0,0.45)]">/</span>
                            <span className="text-[rgba(0,0,0,0.88)]">项目列表</span>
                        </nav>

                        <div className="flex items-center justify-between mt-2 pt-2 h-14">
                            <div className="flex items-center min-w-0">
                                <h1 className="text-[20px] font-semibold leading-8 text-[rgba(0,0,0,0.88)] mr-3 whitespace-nowrap">短剧项目</h1>
                                <p className="text-sm text-[rgba(0,0,0,0.65)] mr-3 truncate">从锁定剧本到分集画布的统一制作入口</p>
                            </div>
                            <div className="flex items-center gap-3 shrink-0">
                                {canApproveRole && (
                                    <button
                                        onClick={onOpenApprovals}
                                        className="relative flex items-center gap-1.5 h-10 px-4 rounded-lg border border-[#d9d9d9] bg-white text-[rgba(0,0,0,0.88)] text-base hover:border-[#4558dc] hover:text-[#4558dc] transition-colors shadow-[0_2px_0_rgba(0,0,0,0.02)]"
                                    >
                                        <ClipboardCheck size={16} />
                                        申请审批
                                        {pendingCount > 0 && (
                                            <span className="absolute -top-1.5 -right-1.5 min-w-[20px] h-5 px-1.5 rounded-full bg-[#ff4d4f] text-white text-xs font-medium flex items-center justify-center shadow-[0_0_0_1px_#fff]">
                                                {pendingCount}
                                            </span>
                                        )}
                                    </button>
                                )}
                                <button
                                    onClick={onOpenFreeCanvas}
                                    className="flex items-center gap-1.5 h-10 px-4 rounded-lg border border-[#d9d9d9] bg-white text-[rgba(0,0,0,0.88)] text-base hover:border-[#4558dc] hover:text-[#4558dc] transition-colors shadow-[0_2px_0_rgba(0,0,0,0.02)] hidden"
                                >
                                    <PenTool size={16} />
                                    自由画布
                                </button>
                                {canCreateRole && (
                                    <button
                                        onClick={() => setIsCreateModalOpen(true)}
                                        className="flex items-center gap-2 h-10 px-[15px] rounded-lg bg-[#4558dc] hover:bg-[#6d82e8] active:bg-[#2f3cb5] text-white text-base transition-colors shadow-[0_2px_0_rgba(5,72,255,0.06)]"
                                    >
                                        <Plus size={16} />
                                        新建制作项目
                                    </button>
                                )}
                            </div>
                        </div>
                    </div>

                    {/* 内容区（唯一滚动容器） */}
                    <div className="flex-1 min-h-0 overflow-y-auto px-10 pt-[18px] pb-6">
                        {/* 生产摘要条：4 项指标 + 状态图例 */}
                        <div className="grid grid-cols-[repeat(4,minmax(135px,1fr))_minmax(280px,1.4fr)] max-[1180px]:grid-cols-4 max-[800px]:grid-cols-2 bg-white border border-[#e7e9f3] rounded-xl shadow-[0_4px_18px_rgba(33,43,83,0.04)] mb-4 overflow-hidden">
                            {stats.map((s) => (
                                <div key={s.key} className="flex flex-col justify-center min-h-[92px] px-5 py-[17px] border-r border-[#eef0f6] last:border-r-0">
                                    <span className="text-xs text-[#7f889d]">{s.label}</span>
                                    <strong className={`text-[25px] font-bold leading-[1.15] my-0.5 tabular-nums text-[#27304b] ${s.tone}`}>{s.value}</strong>
                                    <small className="text-[10px] text-[#9ca4b7]">{s.note}</small>
                                </div>
                            ))}
                            <div className="max-[1180px]:hidden flex flex-wrap content-center gap-[7px] min-h-[92px] px-5 py-[17px] bg-[linear-gradient(135deg,#fafbff,#f6f4ff)]">
                                {TABS.map((t) => (
                                    <button
                                        key={t}
                                        onClick={() => {
                                            setActiveTab((current) => (current === t ? null : t));
                                            setPage(1);
                                        }}
                                        aria-pressed={activeTab === t}
                                        className={`inline-flex items-center h-[22px] px-[7px] rounded text-xs border border-transparent whitespace-nowrap transition-all ${activeTab === t ? TAB_STYLE[t].active : TAB_STYLE[t].idle}`}
                                    >
                                        {t}
                                    </button>
                                ))}
                                <span className="basis-full text-[11px] text-[rgba(0,0,0,0.45)]">数据刷新于 {formatRefreshAgo(lastLoadedAt)}</span>
                            </div>
                        </div>

                        {/* 筛选卡片 */}
                        <div className="bg-white border border-[#eef0f6] rounded-[10px] shadow-[0_3px_12px_rgba(28,37,74,0.03)] py-0.5 mb-4">
                            <div className="p-6 flex flex-wrap items-center gap-2">
                                <div className="relative flex items-center gap-1.5 h-8 w-[320px] px-[11px] rounded-md bg-[rgba(0,0,0,0.04)] border border-transparent focus-within:border-[#4558dc] transition-colors">
                                    <Search size={14} className="text-[rgba(0,0,0,0.45)] shrink-0" />
                                    <input
                                        value={draftKeyword}
                                        onChange={(e) => setDraftKeyword(e.target.value)}
                                        onKeyDown={(e) => { if (e.key === 'Enter') handleSearch(); }}
                                        className="project-search-input flex-1 min-w-0 bg-transparent border-0 outline-none text-sm text-[rgba(0,0,0,0.88)] placeholder:text-[rgba(0,0,0,0.25)]"
                                        placeholder="搜索项目、剧目、剧本或负责人"
                                    />
                                </div>
                                <FilterSelect width={130} value={draftFilters.type} options={['全部类型', ...CONTENT_TYPES]} onChange={(v) => setDraftFilters({ ...draftFilters, type: v })} />
                                <FilterSelect width={140} value={draftFilters.source} options={['全部来源', '资源库', '本地上传']} onChange={(v) => setDraftFilters({ ...draftFilters, source: v })} />
                                <FilterSelect width={130} value={draftFilters.status} options={['全部状态', '制作中', '审核中', '已完成', '待启动']} onChange={(v) => setDraftFilters({ ...draftFilters, status: v })} />
                                <button
                                    onClick={handleSearch}
                                    className="h-8 px-[15px] rounded-md bg-[#4558dc] hover:bg-[#6d82e8] active:bg-[#2f3cb5] text-white text-sm transition-colors shadow-[0_2px_0_rgba(5,72,255,0.06)]"
                                >
                                    查 询
                                </button>
                                <button
                                    onClick={handleReset}
                                    className="h-8 px-[15px] rounded-md border border-[#d9d9d9] bg-white text-[rgba(0,0,0,0.88)] hover:border-[#4558dc] hover:text-[#4558dc] text-sm transition-colors shadow-[0_2px_0_rgba(0,0,0,0.02)]"
                                >
                                    重 置
                                </button>
                            </div>
                        </div>

                        {/* 列表卡片 */}
                        <div className="bg-white border border-[#eef0f8] rounded-xl shadow-[0_4px_18px_rgba(18,28,70,0.035)] overflow-hidden">
                            {/* 卡片标题栏 */}
                            <div className="flex items-center justify-between h-14 px-6 border-b border-[#f0f0f0]">
                                <div className="flex items-center gap-2 min-w-0">
                                    <span className="text-base font-semibold text-[rgba(0,0,0,0.88)]">制作项目</span>
                                    <span className="inline-flex items-center h-[22px] px-[7px] rounded bg-[#f5f5f5] text-xs font-semibold text-[rgba(0,0,0,0.88)] whitespace-nowrap">
                                        {filteredProjects.length} 个
                                    </span>
                                </div>
                                <div className="flex items-center gap-2">
                                    <button
                                        onClick={loadProjects}
                                        disabled={loading}
                                        className="flex items-center gap-1.5 h-8 px-[15px] rounded-md border border-[#d9d9d9] bg-white text-[rgba(0,0,0,0.88)] hover:border-[#4558dc] hover:text-[#4558dc] text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed shadow-[0_2px_0_rgba(0,0,0,0.02)]"
                                    >
                                        <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
                                        刷新
                                    </button>
                                    <div className="relative">
                                        <button
                                            onClick={() => setColumnMenuOpen((v) => !v)}
                                            onBlur={() => setTimeout(() => setColumnMenuOpen(false), 150)}
                                            className="flex items-center h-8 px-[15px] rounded-md border border-[#d9d9d9] bg-white text-[rgba(0,0,0,0.88)] hover:border-[#4558dc] hover:text-[#4558dc] text-sm transition-colors shadow-[0_2px_0_rgba(0,0,0,0.02)]"
                                        >
                                            自定义列
                                        </button>
                                        {columnMenuOpen && (
                                            <div className="absolute right-0 z-30 top-full mt-1 w-[190px] bg-white rounded-lg shadow-[0_6px_16px_rgba(0,0,0,0.08),0_3px_6px_-4px_rgba(0,0,0,0.12),0_9px_28px_8px_rgba(0,0,0,0.05)] py-1">
                                                {ALL_COLUMNS.map((c) => (
                                                    <button
                                                        key={c.key}
                                                        type="button"
                                                        onMouseDown={(e) => { e.preventDefault(); toggleColumn(c.key); }}
                                                        className="w-full px-3 py-1.5 text-sm text-left flex items-center justify-between gap-2 hover:bg-[#fafafa] text-[rgba(0,0,0,0.88)] transition-colors"
                                                    >
                                                        <span>{c.label}</span>
                                                        {isColVisible(c.key) && <Check size={14} className="text-[#4558dc] shrink-0" />}
                                                    </button>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                </div>
                            </div>

                            {/* 表格（负边距让表格铺满卡片宽度，与原型一致） */}
                            <div className="p-6">
                                <div
                                    ref={scrollRef}
                                    onScroll={syncScrollShadows}
                                    className="-mx-6 -mb-6 mt-1 overflow-x-auto"
                                >
                                    <table className="w-full text-sm" style={{ tableLayout: 'fixed', minWidth: 1400 }}>
                                        <colgroup>
                                            {visibleCols.map((c) => (
                                                <col key={c.key} style={{ width: `${(c.w / visibleWidthSum) * 100}%` }} />
                                            ))}
                                        </colgroup>
                                        <thead>
                                            <tr>
                                                {visibleCols.map((c) => {
                                                    const isFirst = c.key === 'project';
                                                    const isLast = c.key === 'actions';
                                                    const fixed = isFirst || isLast;
                                                    return (
                                                        <th
                                                            key={c.key}
                                                            className={`text-left font-medium text-[#7c869c] bg-[#fafbff] px-4 py-4 whitespace-nowrap border-b border-[#f0f0f0] ${c.center ? 'text-center' : ''} ${fixed ? 'sticky z-20 bg-[#fafbff]' : ''} ${isFirst && scrollState.left ? 'shadow-[inset_-9px_0_8px_-8px_rgba(0,0,0,0.16)]' : ''} ${isLast && scrollState.right ? 'shadow-[inset_9px_0_8px_-8px_rgba(0,0,0,0.16)]' : ''}`}
                                                            style={fixed ? { [isFirst ? 'left' : 'right']: 0 } : undefined}
                                                        >
                                                            {c.label}
                                                        </th>
                                                    );
                                                })}
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {loading ? (
                                                <tr>
                                                    <td colSpan={visibleColumnCount} className="px-4 py-16 text-center text-sm text-[rgba(0,0,0,0.45)]">加载中...</td>
                                                </tr>
                                            ) : loadError ? (
                                                <tr>
                                                    <td colSpan={visibleColumnCount} className="px-4 py-16 text-center text-sm text-[#ff4d4f]">{loadError}</td>
                                                </tr>
                                            ) : filteredProjects.length === 0 ? (
                                                <tr>
                                                    <td colSpan={visibleColumnCount} className="px-4 py-16 text-center text-sm text-[rgba(0,0,0,0.45)]">
                                                        {projects.length === 0 ? '暂无项目，点击右上角「新建制作项目」开始' : '当前筛选条件下没有项目'}
                                                    </td>
                                                </tr>
                                            ) : pageProjects.map((p) => {
                                                const prog = progressMap[p.id];
                                                const total = prog?.totalEpisodes || 0;
                                                const done = prog?.doneEpisodes || 0;
                                                const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
                                                const started = prog?.started;
                                                return (
                                                    <tr key={p.id} className="group border-b border-[#f0f0f0] hover:bg-[#fafafa] transition-colors">
                                                        {isColVisible('project') && (
                                                            <td
                                                                className={`px-4 py-4 align-middle bg-white group-hover:bg-[#fafafa] sticky z-10 transition-colors ${scrollState.left ? 'shadow-[inset_-9px_0_8px_-8px_rgba(0,0,0,0.16)]' : ''}`}
                                                                style={{ left: 0 }}
                                                            >
                                                                <button onClick={() => onOpenProjectDetail(p.id)} className="flex flex-col items-start text-left group">
                                                                    <strong className="text-sm font-bold text-[#1c2745] group-hover:text-[#4558dc] transition-colors">{p.name}</strong>
                                                                    <small className="text-[11.2px] text-[#9299aa] mt-1">{p.code} · {p.category}</small>
                                                                </button>
                                                            </td>
                                                        )}
                                                        {isColVisible('script') && (
                                                            <td className="px-4 py-4 align-middle">
                                                                <div className="flex flex-col gap-[3px]">
                                                                    <strong className="text-sm font-bold text-[#303953]">{p.dramaName}</strong>
                                                                    <small className="text-xs text-[#8e97aa]">{p.scriptName} · {p.scriptSource}</small>
                                                                </div>
                                                            </td>
                                                        )}
                                                        {isColVisible('owner') && (
                                                            <td className="px-4 py-4 align-middle text-[#47516c]">
                                                                <div>{p.owner}</div>
                                                                <small className="block mt-1 text-xs text-[#9299aa]">{p.department}</small>
                                                                <small className="block mt-0.5 text-[11px] text-[#4558dc]">
                                                                    组长：{p.leaderName || (p.leaderId ? '已分配' : '未分配')}
                                                                </small>
                                                            </td>
                                                        )}
                                                        {isColVisible('stage') && (
                                                            <td className="px-4 py-4 align-middle">
                                                                <span className="inline-flex items-center h-[22px] px-[7px] rounded bg-[#e6f4ff] text-[#0958d9] text-xs whitespace-nowrap">{prog?.stage || '—'}</span>
                                                            </td>
                                                        )}
                                                        {isColVisible('progress') && (
                                                            <td className="px-4 py-4 align-middle text-[#47516c]">
                                                                <div className="min-w-[180px]">
                                                                    <span className="block mb-1">{done} / {total} 集</span>
                                                                    <div className="h-1.5 w-full rounded-full bg-[rgba(0,0,0,0.06)] overflow-hidden">
                                                                        <div
                                                                            className={`h-full rounded-full transition-all ${pct >= 100 ? 'bg-[#52c41a]' : 'bg-[#1677ff]'}`}
                                                                            style={{ width: pct + '%' }}
                                                                        />
                                                                    </div>
                                                                </div>
                                                            </td>
                                                        )}
                                                        {isColVisible('abnormal') && (
                                                            <td className="px-4 py-4 align-middle text-center">
                                                                {prog && prog.abnormal > 0 ? (
                                                                    <span className="inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full bg-[#ff4d4f] text-white text-xs shadow-[0_0_0_1px_#fff]">{prog.abnormal}</span>
                                                                ) : (
                                                                    <span className="text-[rgba(0,0,0,0.45)]">—</span>
                                                                )}
                                                            </td>
                                                        )}
                                                        {isColVisible('status') && (
                                                            <td className="px-4 py-4 align-middle">
                                                                <span className={`inline-flex items-center h-[22px] px-[7px] rounded text-xs whitespace-nowrap ${STATUS_STYLE[prog?.status || '待启动'] || 'bg-[#fafafa] text-[#8c8c8c]'}`}>
                                                                    {prog?.status || '待启动'}
                                                                </span>
                                                            </td>
                                                        )}
                                                        {isColVisible('updated') && (
                                                            <td className="px-4 py-4 align-middle text-[#47516c] whitespace-nowrap">{formatRelativeTime(p.updatedAt)}</td>
                                                        )}
                                                        {isColVisible('actions') && (
                                                            <td
                                                                className={`px-4 py-4 align-middle bg-white group-hover:bg-[#fafafa] sticky z-10 transition-colors ${scrollState.right ? 'shadow-[inset_9px_0_8px_-8px_rgba(0,0,0,0.16)]' : ''}`}
                                                                style={{ right: 0 }}
                                                            >
                                                                <div className="flex items-center">
                                                                    <button
                                                                        onClick={() => onOpenProjectDetail(p.id)}
                                                                        className="h-8 px-[10px] rounded-md text-sm text-[#1677ff] hover:text-[#4096ff] hover:bg-[rgba(0,0,0,0.04)] transition-colors whitespace-nowrap"
                                                                    >
                                                                        项目详情
                                                                    </button>
                                                                    <button
                                                                        onClick={() => onEnterCanvas(p.id)}
                                                                        className="h-8 px-[10px] rounded-md text-sm text-[#1677ff] hover:text-[#4096ff] hover:bg-[rgba(0,0,0,0.04)] transition-colors whitespace-nowrap"
                                                                    >
                                                                        进入画布
                                                                    </button>
                                                                    <button
                                                                        onClick={() => {
                                                                            // 首次点击即视为「开始」，之后按钮变为「进入工作流」
                                                                            try { localStorage.setItem(`project-started:${p.id}`, '1'); } catch { /* ignore */ }
                                                                            persistUiState(p.id, 'project-started', '1');
                                                                            onEnterWorkflow(p.id);
                                                                        }}
                                                                        className="h-8 px-[10px] rounded-md text-sm text-[#1677ff] hover:text-[#4096ff] hover:bg-[rgba(0,0,0,0.04)] transition-colors whitespace-nowrap hidden"
                                                                    >
                                                                        {started ? '进入工作流' : '开始'}
                                                                    </button>
                                                                </div>
                                                            </td>
                                                        )}
                                                    </tr>
                                                );
                                            })}
                                        </tbody>
                                    </table>
                                </div>
                            </div>

                            {/* 分页 */}
                            <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-[#f0f0f0]">
                                <span className="text-sm text-[rgba(0,0,0,0.88)] mr-1">共 {filteredProjects.length} 个项目</span>
                                <button
                                    onClick={() => setPage((v) => Math.max(1, v - 1))}
                                    disabled={safePage <= 1}
                                    className="w-8 h-8 rounded-md flex items-center justify-center text-[rgba(0,0,0,0.88)] transition-colors enabled:hover:text-[#4558dc] enabled:hover:border-[#4558dc] disabled:text-[rgba(0,0,0,0.25)] disabled:cursor-not-allowed"
                                >
                                    <ChevronLeft size={12} />
                                </button>
                                {Array.from({ length: totalPages }, (_, i) => i + 1)
                                    .filter((n) => n === 1 || n === totalPages || Math.abs(n - safePage) <= 1)
                                    .map((n, idx, arr) => (
                                        <React.Fragment key={n}>
                                            {idx > 0 && n - arr[idx - 1] > 1 && <span className="px-1 text-[rgba(0,0,0,0.25)]">…</span>}
                                            <button
                                                onClick={() => setPage(n)}
                                                className={`w-8 h-8 rounded-md text-sm transition-colors ${n === safePage
                                                    ? 'border border-[#4558dc] text-[#4558dc] font-semibold bg-white'
                                                    : 'border border-transparent text-[rgba(0,0,0,0.88)] hover:text-[#4558dc] hover:border-[#4558dc]'}`}
                                            >
                                                {n}
                                            </button>
                                        </React.Fragment>
                                    ))}
                                <button
                                    onClick={() => setPage((v) => Math.min(totalPages, v + 1))}
                                    disabled={safePage >= totalPages}
                                    className="w-8 h-8 rounded-md flex items-center justify-center text-[rgba(0,0,0,0.88)] transition-colors enabled:hover:text-[#4558dc] enabled:hover:border-[#4558dc] disabled:text-[rgba(0,0,0,0.25)] disabled:cursor-not-allowed"
                                >
                                    <ChevronRight size={12} />
                                </button>
                            </div>
                        </div>
                    </div>
                {/* 底部 */}
                <footer className="text-center text-xs text-slate-400 py-3">星幕中台 V2.4 · 短剧生产闭环交互原型</footer>
            </main>

            {/* 新建制作项目弹窗 */}
            <CreateProjectModal
                isOpen={isCreateModalOpen}
                onClose={() => setIsCreateModalOpen(false)}
                onCreate={handleCreateProject}
                userRole={user?.role}
                leaders={leaders}
            />

        </div>
    );
};

export default ProjectListPage;
