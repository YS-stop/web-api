import React, { useEffect, useMemo, useState } from 'react';
import {
    AlertTriangle,
    ArrowRight,
    Check,
    ChevronLeft,
    ChevronDown,
    ChevronRight,
    Clapperboard,
    GitBranch,
    Loader2,
    MoreVertical,
    Plus,
    RefreshCw,
    Search,
    Send,
    Upload,
} from 'lucide-react';
import {
    DEPARTMENTS,
    OWNERS,
    PRODUCTION_MODES,
    ASPECT_RATIOS,
    Project,
    ProjectEditableFields,
    canEditProject,
    canRequestChange,
    fetchProject,
    submitChangeRequest,
    updateProject,
} from '../services/projectService';
import { persistUiState } from '../services/projectStateService';
import {
    fetchProjectJobs,
    isJobAbnormal,
    describeJob,
    retryJob,
    JOB_KIND_META,
} from '../services/generationTaskService';
import type { ProjectJob } from '../services/generationTaskService';
import { ChangeRequestModal } from './modals/ChangeRequestModal';
import { AssetConfirmPanel } from './AssetConfirmPanel';
import type { EpisodeMap } from './AssetConfirmPanel';
import { loadAssetStore } from './AssetConfirmPanel';
import {
    deriveEpisodeStatuses,
    deriveProjectStats,
    formatDuration,
    formatRelativeTime,
    STAGE_LABEL,
} from '../services/episodeStatus';
import type { EpisodeStatus, ProjectStats } from '../services/episodeStatus';

interface ProjectDetailPageProps {
    projectId: string;
    /** id 用于判断任务是否为「我」触发的（任务台账里的 created_by 是用户 id） */
    user: { id?: string; name?: string; avatarUrl?: string; role?: string } | null;
    onBack: () => void;
    /** 进入画布：带上集号，画布直接定位到该集 */
    onEnterWorkflow?: (projectId: string, episode?: number) => void;
    /** 初始激活的标签页（如工作流页跳转过来时直达「项目资产」） */
    initialTab?: string;
}

type DetailTabKey = 'overview' | 'episodes' | 'assets' | 'tasks' | 'versions' | 'reviews' | 'settings';

interface SettingsForm {
    name: string;
    department: string;
    owner: string;
    productionMode: string;
    aspectRatio: string;
    generationService: string;
}

const GENERATION_SERVICES = ['火山引擎 · 公司统一服务账号'];

const EMPTY_SETTINGS: SettingsForm = {
    name: '',
    department: '',
    owner: '',
    productionMode: '',
    aspectRatio: '',
    generationService: GENERATION_SERVICES[0],
};

const SETTINGS_OPTION_FIELDS: Array<{
    key: keyof SettingsForm;
    label: string;
    options: string[];
    disabled?: boolean;
}> = [
    { key: 'department', label: '归属部门', options: DEPARTMENTS },
    { key: 'owner', label: '项目负责人', options: OWNERS },
    { key: 'productionMode', label: '默认流程模式', options: PRODUCTION_MODES },
    { key: 'aspectRatio', label: '默认画幅', options: ASPECT_RATIOS },
    { key: 'generationService', label: '生成服务', options: GENERATION_SERVICES, disabled: true },
];

const buildSettingsForm = (project: Project | null): SettingsForm => ({
    name: project?.name || '',
    department: project?.department || '',
    owner: project?.owner || '',
    productionMode: project?.productionMode || '',
    aspectRatio: project?.aspectRatio || '',
    generationService: GENERATION_SERVICES[0],
});

const DETAIL_TABS: { key: DetailTabKey; label: string; count?: number; dot?: boolean }[] = [
    { key: 'overview', label: '项目概览' },
    { key: 'episodes', label: '分集管理' },
    { key: 'assets', label: '项目资产' },
    { key: 'tasks', label: '生成任务', dot: true },
    { key: 'versions', label: '版本记录' },
    { key: 'reviews', label: '审核记录' },
    { key: 'settings', label: '项目设置' },
];

type EpisodeBadgeTone = 'gray' | 'yellow' | 'green' | 'blue' | 'purple' | 'orange' | 'cyan';

interface EpisodeRecord {
    id: string;
    title: string;
    detail: string;
    assets: string;
    assetKinds: string;
    storyboard: string;
    video: string;
    videoAlert?: boolean;
    final: string;
    finalTone: EpisodeBadgeTone;
    stage: string;
    stageTone: EpisodeBadgeTone;
    review: string;
    reviewTone: EpisodeBadgeTone;
    updated: string;
}

interface EpisodeFilters {
    query: string;
    stage: string;
    review: string;
}

const EPISODE_BADGE_TONES: Record<EpisodeBadgeTone, string> = {
    gray: 'bg-[#f2f3f5] text-[#86909c]',
    yellow: 'bg-[#fff7e8] text-[#d98100]',
    green: 'bg-[#e8ffea] text-[#00b42a]',
    blue: 'bg-[#e8f2ff] text-[#2f74ff]',
    purple: 'bg-[#f5eaff] text-[#8b5cf6]',
    orange: 'bg-[#fff3e8] text-[#ff7d00]',
    cyan: 'bg-[#e6faf7] text-[#10b5a7]',
};

const EPISODE_STAGE_OPTIONS = ['全部阶段', '镜头生成中', '成片审核', '已完成', '分镜审核', '资产确认', '单集分析完成', '待初始化'];
const EPISODE_REVIEW_OPTIONS = ['全部审核状态', '分镜已通过', '待成片审核', '全部通过', '有修改意见', '待审核', '待确认', '未提交'];

const EMPTY_EPISODE_FILTERS: EpisodeFilters = {
    query: '',
    stage: '全部阶段',
    review: '全部审核状态',
};

type TaskStatusTone = 'blue' | 'yellow' | 'green' | 'red';

/**
 * 生成任务行：直接来自后端 project_jobs 台账（一次真实生成尝试 = 一行）。
 * 之前这里是由逐集产物进度反推的「假任务」，失败与重试都没有落点；
 * 现在保留 job 引用，日志与重试都落在真实任务上。
 */
interface GenerationTask {
    id: string;
    title: string;
    node: string;
    service: string;
    /** 真实任务没有细粒度进度：运行中为 null，完成后为 100 */
    progress: number | null;
    status: string;
    statusTone: TaskStatusTone;
    /** 该任务最近一次状态变化的相对时间 */
    updatedAt: string;
    canRetry: boolean;
    abnormal: boolean;
    /** 触发人快照：后端按 token 在任务创建时写入，之后不覆盖 */
    actorId: string;
    actorName: string;
    actorRole: string;
    /** 是否有可靠的触发人记录（005 迁移前的历史任务为空） */
    actorKnown: boolean;
    /** 是否由当前登录账号触发 */
    isMe: boolean;
    job: ProjectJob;
}

/** 角色标签：与用户管理页口径一致 */
const ACTOR_ROLE_META: Record<string, { label: string; badge: string }> = {
    admin: { label: '管理员', badge: 'bg-[#e8f1ff] text-[#1677ff]' },
    project_manager: { label: '项目主管', badge: 'bg-[#eef6ff] text-[#0e6fff]' },
    team_leader: { label: '组长', badge: 'bg-[#fff3e8] text-[#ff7d00]' },
    user: { label: '组员', badge: 'bg-[#f2f3f5] text-[#86909c]' },
};

const TASK_STATUS_STYLES: Record<TaskStatusTone, string> = {
    blue: 'bg-[#e8f2ff] text-[#2f74ff]',
    yellow: 'bg-[#fff7e8] text-[#d98100]',
    green: 'bg-[#e8ffea] text-[#00b42a]',
    red: 'bg-[#ffece8] text-[#f53f3f]',
};

type VersionStatusTone = 'green' | 'gray';

interface VersionRecord {
    object: string;
    version: string;
    description: string;
    status: string;
    statusTone: VersionStatusTone;
    creator: string;
    createdAt: string;
}

const VERSION_STATUS_STYLES: Record<VersionStatusTone, string> = {
    green: 'bg-[#e8ffea] text-[#00b42a]',
    gray: 'bg-[#f2f3f5] text-[#86909c]',
};

type ReviewResultTone = 'yellow' | 'green';

interface ReviewRecord {
    object: string;
    version: string;
    node: string;
    scope: string;
    result: string;
    resultTone: ReviewResultTone;
    submitter: string;
    createdAt: string;
}

const REVIEW_RESULT_STYLES: Record<ReviewResultTone, string> = {
    yellow: 'bg-[#fff7e8] text-[#d98100]',
    green: 'bg-[#e8ffea] text-[#00b42a]',
};

/** 项目详情子页面：视觉按参考稿重构，数据仅用于查看态静态展示 */
export const ProjectDetailPage: React.FC<ProjectDetailPageProps> = ({ projectId, user, onBack, onEnterWorkflow, initialTab }) => {
    const [project, setProject] = useState<Project | null>(null);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState('');
    /** 合法的详情标签集合，用于校验 URL 传入的 tab */
    const resolvedInitialTab: DetailTabKey = DETAIL_TABS.some((t) => t.key === initialTab)
        ? (initialTab as DetailTabKey)
        : 'episodes';
    const [activeTab, setActiveTab] = useState<DetailTabKey>(resolvedInitialTab);
    const [settingsForm, setSettingsForm] = useState<SettingsForm>(() => ({ ...EMPTY_SETTINGS }));
    const [settingsSaving, setSettingsSaving] = useState(false);
    const [settingsError, setSettingsError] = useState('');
    const [episodeSearch, setEpisodeSearch] = useState('');
    const [episodeStageFilter, setEpisodeStageFilter] = useState('全部阶段');
    const [episodeReviewFilter, setEpisodeReviewFilter] = useState('全部审核状态');
    const [appliedEpisodeFilters, setAppliedEpisodeFilters] = useState<EpisodeFilters>(() => ({ ...EMPTY_EPISODE_FILTERS }));
    const [selectedEpisodes, setSelectedEpisodes] = useState<string[]>([]);
    const [tasksAbnormalOnly, setTasksAbnormalOnly] = useState(false);
    /**
     * 任务按人筛选：'all' 全部 / 'me' 仅我 / 'id:<userId>' 指定人。
     * 同组多人共用同一批项目，靠触发人区分每条任务是谁发起的。
     */
    const [tasksActorFilter, setTasksActorFilter] = useState('all');
    const [showChangeRequest, setShowChangeRequest] = useState(false);
    const [toast, setToast] = useState('');
    /** 生成任务台账（后端 project_jobs）：进入详情页即拉一次，用于顶部异常红点 */
    const [projectJobs, setProjectJobs] = useState<ProjectJob[]>([]);
    const [jobsLoading, setJobsLoading] = useState(false);
    const [jobsError, setJobsError] = useState('');
    /** 展开「日志」的任务 id（展示发起参数与失败原因） */
    const [expandedJobId, setExpandedJobId] = useState<string | null>(null);
    /**
     * 本地数据变更令牌：资产确认 / 分镜视频都写在 localStorage，
     * 面板改动后自增该值，触发逐集状态与各标签统计重新推导。
     */
    const [assetRefreshToken, setAssetRefreshToken] = useState(0);

    const canEdit = canEditProject(user?.role);
    const canRequest = canRequestChange(user?.role);

    const loadProject = async () => {
        setLoading(true);
        setLoadError('');
        setActiveTab(resolvedInitialTab);
        setSettingsForm({ ...EMPTY_SETTINGS });
        try {
            const data = await fetchProject(projectId);
            setProject(data);
            setSettingsForm(buildSettingsForm(data));
        } catch (e: any) {
            setLoadError(e.message || '加载项目失败');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        setLoadError('');
        // 切项目时回到该次进入指定的标签（默认分集管理），避免沿用上一个项目停留的标签
        setActiveTab(resolvedInitialTab);
        setSettingsForm({ ...EMPTY_SETTINGS });
        fetchProject(projectId)
            .then((data) => {
                if (!cancelled) {
                    setProject(data);
                    setSettingsForm(buildSettingsForm(data));
                }
            })
            .catch((e: any) => {
                if (!cancelled) setLoadError(e.message || '加载项目失败');
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [projectId]);

    useEffect(() => {
        if (!toast) return;
        const timer = window.setTimeout(() => setToast(''), 2500);
        return () => window.clearTimeout(timer);
    }, [toast]);

    /**
     * 刷新任务台账。
     * 任务由生成侧写入（提交时 running，结束时补终态），这里只读不推导，
     * 避免又回到「用产物进度反推出看起来像任务」的老路。
     */
    const refreshJobs = React.useCallback(async () => {
        setJobsLoading(true);
        setJobsError('');
        try {
            setProjectJobs(await fetchProjectJobs(projectId));
        } catch (error: any) {
            setJobsError(error?.message || '加载生成任务失败');
            setProjectJobs([]);
        } finally {
            setJobsLoading(false);
        }
    }, [projectId]);

    // 进入详情页拉一次：顶部「生成任务」红点依赖它
    useEffect(() => {
        void refreshJobs();
    }, [refreshJobs]);

    // 切到「生成任务」时再拉一次：任务可能在别的页面刚刚结束
    useEffect(() => {
        if (activeTab === 'tasks') void refreshJobs();
    }, [activeTab, refreshJobs]);

    // 有运行中的任务时低频轮询，结束后自动变成终态，不必手动点刷新
    const hasRunningJob = useMemo(
        () => projectJobs.some((job) => job.status === 'running'),
        [projectJobs],
    );
    useEffect(() => {
        if (activeTab !== 'tasks' || !hasRunningJob) return;
        const timer = window.setInterval(() => void refreshJobs(), 10000);
        return () => window.clearInterval(timer);
    }, [activeTab, hasRunningJob, refreshJobs]);

    const setSettingsField = (key: keyof SettingsForm, value: string) => {
        setSettingsForm((prev) => ({ ...prev, [key]: value }));
    };

    const resetSettings = () => {
        setSettingsForm(buildSettingsForm(project));
        setSettingsError('');
    };

    const handleSaveSettings = async () => {
        if (!project) return;
        setSettingsSaving(true);
        setSettingsError('');
        try {
            const name = settingsForm.name.trim();
            if (!name) {
                setSettingsError('项目名称不能为空');
                return;
            }
            const fields: ProjectEditableFields = {
                name,
                department: settingsForm.department,
                owner: settingsForm.owner,
                productionMode: settingsForm.productionMode,
                aspectRatio: settingsForm.aspectRatio,
            };
            const updated = await updateProject(project.id, fields);
            setProject(updated);
            setSettingsForm(buildSettingsForm(updated));
            setToast('项目设置已保存');
        } catch (e: any) {
            setSettingsError(e.message || '保存失败');
        } finally {
            setSettingsSaving(false);
        }
    };

    const handleSubmitRequest = async (changes: ProjectEditableFields, reason: string) => {
        if (!project) return;
        await submitChangeRequest(project.id, changes, reason);
        setToast('申请已提交，等待主管审批');
    };

    const handleEnterWorkflow = (episode?: number) => {
        try {
            localStorage.setItem(`project-started:${projectId}`, '1');
            // 记住这次进入的是哪一集：画布与工作流页都以这个 key 作为「当前集」，
            // 从列表/详情不同入口进来都能回到同一集。
            if (episode) localStorage.setItem(`shot-editor:active-episode:${projectId}`, String(episode));
        } catch {
            /* 忽略浏览器存储不可用 */
        }
        persistUiState(projectId, 'project-started', '1');
        if (episode) persistUiState(projectId, 'active-episode', episode);
        onEnterWorkflow?.(projectId, episode);
    };

    const withCurrentOption = (options: string[], current: string): string[] =>
        current && !options.includes(current) ? [current, ...options] : options;

    /**
     * 逐集制作状态：由「剧本解析 + 资产确认 + 分镜/视频」真实数据推导。
     *
     * 之前这里的分镜 / 镜头视频 / 成片 / 当前阶段 / 审核状态全是占位符（—、待制作），
     * 顶部统计（总集数 80、生产中 26…）也是写死的演示值，与实际进度无关。
     * 现在统一走 episodeStatus 派生层，分集表逐行、各标签统计都取自同一份数据。
     */
    const episodeStatuses = useMemo<EpisodeStatus[]>(() => {
        const list = project?.scriptAnalysis?.episodes || [];
        if (list.length === 0) return [];
        return deriveEpisodeStatuses({
            projectId,
            episodes: list,
            fallbackUpdatedAt: project?.updatedAt,
        });
    }, [project, projectId, assetRefreshToken]);

    /** 全项目统计：直接由逐集状态相加，保证与分集表逐行一致 */
    const projectStats = useMemo<ProjectStats>(
        () => deriveProjectStats(episodeStatuses),
        [episodeStatuses]
    );

    /** 分集表行数据 */
    const episodeRecords = useMemo<EpisodeRecord[]>(
        () => episodeStatuses.map((s) => ({
            id: s.id,
            title: s.title,
            detail: `${s.wordCount.toLocaleString()} 字 · ${formatDuration(s.durationSeconds)}`,
            assets: s.assetTotal > 0
                ? `${s.assetCounts.characters} / ${s.assetCounts.scenes} / ${s.assetCounts.props}`
                : '未识别',
            assetKinds: s.assetTotal > 0
                ? (s.assetGenerated > 0 ? `已出图 ${s.assetGenerated} / ${s.assetTotal}` : '角色 / 场景 / 道具')
                : '待识别',
            storyboard: s.shotTotal > 0 ? `${s.shotTotal} 个` : '未拆分',
            video: s.shotTotal > 0
                ? `${s.shotVideoDone} / ${s.shotTotal}${s.abnormal > 0 ? ` · ${s.abnormal}异常` : s.shotsGenerating > 0 ? ` · ${s.shotsGenerating}生成中` : ''}`
                : '—',
            videoAlert: s.abnormal > 0,
            final: s.final,
            finalTone: s.finalTone,
            stage: s.stage,
            stageTone: s.stageTone,
            review: s.review,
            reviewTone: s.reviewTone,
            updated: formatRelativeTime(s.updatedAt),
        })),
        [episodeStatuses]
    );

    const visibleEpisodes = episodeRecords.filter((episode) => {
        const keyword = appliedEpisodeFilters.query.trim().toLowerCase();
        const matchesKeyword = !keyword || `${episode.id} ${episode.title}`.toLowerCase().includes(keyword);
        const matchesStage = appliedEpisodeFilters.stage === '全部阶段' || episode.stage === appliedEpisodeFilters.stage;
        const matchesReview = appliedEpisodeFilters.review === '全部审核状态' || episode.review === appliedEpisodeFilters.review;
        return matchesKeyword && matchesStage && matchesReview;
    });

    const allVisibleEpisodesSelected = visibleEpisodes.length > 0
        && visibleEpisodes.every((episode) => selectedEpisodes.includes(episode.id));

    const applyEpisodeFilters = () => {
        setAppliedEpisodeFilters({
            query: episodeSearch,
            stage: episodeStageFilter,
            review: episodeReviewFilter,
        });
    };

    const resetEpisodeFilters = () => {
        setEpisodeSearch('');
        setEpisodeStageFilter('全部阶段');
        setEpisodeReviewFilter('全部审核状态');
        setAppliedEpisodeFilters({ ...EMPTY_EPISODE_FILTERS });
        setSelectedEpisodes([]);
    };

    const toggleEpisodeSelection = (episodeId: string) => {
        setSelectedEpisodes((current) => current.includes(episodeId)
            ? current.filter((id) => id !== episodeId)
            : [...current, episodeId]);
    };

    const toggleAllVisibleEpisodes = () => {
        const visibleIds = visibleEpisodes.map((episode) => episode.id);
        setSelectedEpisodes((current) => {
            if (visibleIds.every((id) => current.includes(id))) {
                return current.filter((id) => !visibleIds.includes(id));
            }
            return Array.from(new Set([...current, ...visibleIds]));
        });
    };


    /**
     * 「项目资产」标签页的数据来源。
     * 资产确认面板以「集」为组织维度，只有真实解析出的分集才能进面板；
     * 没有解析结果时给空数组，由面板外层显示引导文案，而不是套用演示分集。
     */
    const assetEpisodes = useMemo(() => project?.scriptAnalysis?.episodes || [], [project]);

    /** 从「分集管理」点进来时记住的当前集，用于资产面板默认定位 */
    const assetInitialEpisode = useMemo(() => {
        if (assetEpisodes.length === 0) return undefined;
        try {
            const saved = Number(localStorage.getItem(`shot-editor:active-episode:${projectId}`));
            return assetEpisodes.some((ep) => ep.episode === saved) ? saved : assetEpisodes[0].episode;
        } catch {
            return assetEpisodes[0].episode;
        }
    }, [assetEpisodes, projectId]);

    /** 资产面板回传的最新资产表（含生成图）；未回传前先用本地缓存，避免顶部统计闪 0 */
    const [assetState, setAssetState] = useState<EpisodeMap | null>(() => loadAssetStore(projectId));

    useEffect(() => {
        setAssetState(loadAssetStore(projectId));
    }, [projectId]);

    const handleAssetsChange = React.useCallback((map: EpisodeMap) => {
        setAssetState((prev) => (JSON.stringify(prev) === JSON.stringify(map) ? prev : map));
        // 资产变动会改变「已出图 / 资产确认」统计，触发逐集状态重新推导
        setAssetRefreshToken((n) => n + 1);
    }, []);

    /**
     * 资产统计：直接取逐集状态的汇总（同一资产跨集共享 id，逐集推导时按集不去重，
     * 但顶部只需要「项目级去重后的资产数」，因此这里仍用本地资产表去重统计）。
     */
    const assetSummary = useMemo(() => {
        const map = assetState || {};
        let total = 0;
        let generated = 0;
        const seen = new Set<string>();
        for (const catMap of Object.values(map)) {
            for (const key of ['characters', 'scenes', 'props'] as const) {
                for (const asset of catMap?.[key] || []) {
                    if (seen.has(asset.id)) continue;
                    seen.add(asset.id);
                    total += 1;
                    if (asset.imageUrl || asset.looks?.some((look) => look.imageUrl)) generated += 1;
                }
            }
        }
        return { total, generated };
    }, [assetState]);

    /**
     * 生成任务列表：直接映射后端 project_jobs 台账。
     * 每一行都是一次真实的生成尝试，状态与失败原因由生成侧在任务结束时写入，
     * 不再由逐集产物进度「反推」。
     */
    const generationTasks = useMemo<GenerationTask[]>(() => {
        return projectJobs.map((job) => {
            const meta = JOB_KIND_META[job.kind] || { node: '生成任务', service: '生成服务' };
            const abnormal = isJobAbnormal(job);
            const failed = job.status === 'failed';
            const succeeded = job.status === 'succeeded';
            const updatedTs = job.updatedAt ? Date.parse(job.updatedAt) : job.startedAt;

            return {
                id: job.id,
                title: describeJob(job),
                node: meta.node,
                service: meta.service,
                // 真实任务没有细粒度进度：完成后 100，其余留空由 UI 显示为「进行中」
                progress: succeeded ? 100 : null,
                status: succeeded ? '已完成' : failed ? '失败' : abnormal ? '超时' : '运行中',
                statusTone: succeeded ? 'green' : (failed || abnormal) ? 'red' : 'blue',
                updatedAt: formatRelativeTime(updatedTs || null),
                canRetry: failed || abnormal,
                abnormal,
                actorId: job.createdBy,
                actorName: job.createdByName || '未命名用户',
                actorRole: job.createdByRole,
                actorKnown: Boolean(job.createdBy),
                isMe: Boolean(user?.id) && job.createdBy === user?.id,
                job,
            };
        });
    }, [projectJobs, user?.id]);

    /**
     * 触发人下拉选项：只聚合任务里真实出现过的人。
     * 不拉全量用户表，避免下拉里全是从未生成过的人。
     */
    const taskActors = useMemo(() => {
        const map = new Map<string, { id: string; name: string; role: string }>();
        for (const job of projectJobs) {
            if (!job.createdBy || map.has(job.createdBy)) continue;
            map.set(job.createdBy, {
                id: job.createdBy,
                name: job.createdByName || '未命名用户',
                role: job.createdByRole || '',
            });
        }
        return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    }, [projectJobs]);

    /** 历史任务数（005 迁移前写入，没有触发人记录） */
    const legacyTaskCount = useMemo(
        () => projectJobs.filter((job) => !job.createdBy).length,
        [projectJobs],
    );

    /** 生成任务列表：支持「仅看异常」+「按触发人」筛选，两者叠加 */
    const visibleTasks = generationTasks.filter((task) => {
        if (tasksAbnormalOnly && !task.abnormal) return false;
        if (tasksActorFilter === 'me' && !task.isMe) return false;
        if (tasksActorFilter.startsWith('id:') && task.actorId !== tasksActorFilter.slice(3)) return false;
        return true;
    });

    /** 异常任务数：驱动顶部「生成任务」红点 */
    const abnormalTaskCount = useMemo(
        () => generationTasks.filter((task) => task.abnormal).length,
        [generationTasks],
    );

    /** 刷新任务台账（按钮 + 重试后复用） */
    const handleRefreshTasks = async () => {
        await refreshJobs();
        setToast('任务列表已刷新');
    };

    /**
     * 重试任务。
     * 资产出图可以直接按原参数重发；视频任务缺参考图与首帧，重发会得到不同画面，
     * 因此改为跳回画布对应集，在那里带着完整上下文重试。
     */
    const handleRetryTask = async (task: GenerationTask) => {
        const result = await retryJob(projectId, task.job);
        setToast(result.message);
        if (result.ok) {
            setExpandedJobId(null);
            await refreshJobs();
            return;
        }
        if (result.needCanvas && task.job.episode) {
            onEnterWorkflow?.(projectId, task.job.episode);
        }
    };

    /**
     * 版本记录：把逐集在各节点上「已产生的产物」列成版本行。
     * 只有真正落地的节点才有版本（解析 → 资产设定图 → 分镜脚本 → 整集成片）。
     */
    const versionRecords = useMemo<VersionRecord[]>(() => {
        const list: VersionRecord[] = [];
        const owner = project?.owner || '系统';

        if (project?.scriptName || episodeStatuses.length > 0) {
            list.push({
                object: `全剧剧本 · ${project?.scriptName || '解析结果'}`,
                version: 'V1',
                description: `锁定 ${episodeStatuses.length} 集分集结构`,
                status: '已锁定',
                statusTone: 'green',
                creator: owner,
                createdAt: project?.createdAt || '—',
            });
        }

        for (const ep of episodeStatuses) {
            const epLabel = `第${ep.id}集`;

            if (ep.assetGenerated > 0) {
                list.push({
                    object: `${epLabel} · 角色 / 场景 / 道具设定图`,
                    version: 'V1',
                    description: `已生成 ${ep.assetGenerated} / ${ep.assetTotal} 项，跨集共享`,
                    status: ep.assetGenerated >= ep.assetTotal ? '当前使用' : '部分生成',
                    statusTone: ep.assetGenerated >= ep.assetTotal ? 'green' : 'gray',
                    creator: owner,
                    createdAt: formatRelativeTime(ep.updatedAt),
                });
            }

            if (ep.shotTotal > 0) {
                list.push({
                    object: `${epLabel} · 镜头脚本`,
                    version: 'V1',
                    description: `拆出 ${ep.shotTotal} 个镜头，合并 ${ep.sceneMerged} / ${ep.sceneTotal} 场`,
                    status: ep.sceneMerged >= ep.sceneTotal ? '当前使用' : '待选用',
                    statusTone: ep.sceneMerged >= ep.sceneTotal ? 'green' : 'gray',
                    creator: owner,
                    createdAt: formatRelativeTime(ep.updatedAt),
                });
            }

            if (ep.finalDone) {
                list.push({
                    object: `${epLabel} · 整集成片`,
                    version: 'V1',
                    description: `${ep.shotVideoDone} 个镜头已合成，时长 ${formatDuration(ep.durationSeconds)}`,
                    status: '当前使用',
                    statusTone: 'green',
                    creator: owner,
                    createdAt: formatRelativeTime(ep.updatedAt),
                });
            }
        }

        return list;
    }, [episodeStatuses, project]);

    /**
     * 审核记录：与分集表「审核状态」列同源。
     * 只列出已进入审核流的集（有分镜或已成片），未提交的集不进审核池。
     */
    const reviewRecords = useMemo<ReviewRecord[]>(() => {
        const list: ReviewRecord[] = [];
        const submitter = project?.owner || '系统';

        for (const ep of episodeStatuses) {
            const epLabel = `第${ep.id}集`;

            if (ep.sceneTotal > 0) {
                const pending = ep.sceneMerged < ep.sceneTotal;
                list.push({
                    object: `${epLabel} · 镜头脚本`,
                    version: 'V1',
                    node: '分镜审核',
                    scope: '内容制作部 / 分镜审核角色',
                    result: pending ? '待审核' : '已通过',
                    resultTone: pending ? 'yellow' : 'green',
                    submitter,
                    createdAt: formatRelativeTime(ep.updatedAt),
                });
            }

            if (ep.shotTotal > 0 && ep.shotVideoDone >= ep.shotTotal) {
                list.push({
                    object: `${epLabel} · 整集成片`,
                    version: 'V1',
                    node: '成片审核',
                    scope: '内容部 / 成片审核角色',
                    result: ep.finalDone ? '已通过' : '待复审',
                    resultTone: ep.finalDone ? 'green' : 'yellow',
                    submitter,
                    createdAt: formatRelativeTime(ep.updatedAt),
                });
            }
        }

        return list;
    }, [episodeStatuses, project]);

    // ========================================================================
    // 概览标签：全部由 projectStats / episodeStatuses 推导
    // ========================================================================

    /** 生产总览的五个流程节点：详情可由真实统计拼出，state 决定圆点样式 */
    const overviewFlow = useMemo(() => {
        const s = projectStats;
        const total = s.total;
        const state = (done: boolean, active: boolean): 'done' | 'active' | 'pending' =>
            done ? 'done' : active ? 'active' : 'pending';

        // 剧本是否锁定：有解析结果即视为已锁定分集
        const locked = total > 0;
        return [
            {
                number: 1,
                title: '剧本锁定',
                detail: locked ? `${project?.scriptName || '剧本'} 已锁定` : '待锁定剧本',
                state: state(locked, !locked),
            },
            {
                number: 2,
                title: '解析与资产',
                detail: locked ? `${total} 集已解析 · 资产 ${s.assetGenerated}/${s.assetTotal}` : '待解析',
                state: state(s.assetGenerated > 0 && s.assetGenerated >= s.assetTotal, locked && s.assetGenerated < s.assetTotal),
            },
            {
                number: 3,
                title: '分镜生产',
                detail: s.shotTotal > 0
                    ? `${episodeStatuses.filter((e) => e.shotTotal > 0).length} 集已拆分镜`
                    : '待拆分镜',
                state: state(s.shotTotal > 0 && s.shotVideoDone >= s.shotTotal, s.shotTotal > 0 && s.shotVideoDone < s.shotTotal),
            },
            {
                number: 4,
                title: '镜头视频',
                detail: s.shotTotal > 0 ? `${s.videoDoneEpisodes} 集已完成 · ${s.runningEpisodes} 集生产中` : '未开始',
                state: state(s.videoDoneEpisodes > 0 && s.videoDoneEpisodes >= total, s.shotVideoDone > 0 && s.videoDoneEpisodes < total),
            },
            {
                number: 5,
                title: '整集成片',
                detail: s.doneEpisodes > 0 ? `${s.doneEpisodes} 集已通过` : '未开始',
                state: state(s.doneEpisodes > 0 && s.doneEpisodes >= total, s.videoDoneEpisodes > 0 && s.doneEpisodes < total),
            },
        ];
    }, [projectStats, episodeStatuses, project]);

    /** 流程条连线颜色：前一段连通则为绿，正在推进为紫，未开始为灰 */
    const flowLines = useMemo(
        () => overviewFlow.slice(0, -1).map((step, i) => {
            const next = overviewFlow[i + 1];
            if (step.state === 'done' && next.state === 'done') return 'bg-[#a9e7bf]';
            if (step.state === 'done' || next.state === 'active') return 'bg-[#d4d1fb]';
            return 'bg-[#e8eaf1]';
        }),
        [overviewFlow]
    );

    /** 生产统计四宫格 */
    const productionStats = useMemo(() => {
        const s = projectStats;
        const total = s.total;
        return [
            { label: '解析完成', value: `${episodeStatuses.filter((e) => e.stageKey !== 'pendingInit').length} / ${total} 集` },
            { label: '分镜完成', value: `${episodeStatuses.filter((e) => e.shotTotal > 0).length} / ${total} 集` },
            { label: '视频完成', value: `${s.videoDoneEpisodes} / ${total} 集` },
            { label: '成片通过', value: `${s.doneEpisodes} / ${total} 集` },
        ];
    }, [projectStats, episodeStatuses]);

    /**
     * 待我处理：按优先级从真实数据里挑出需要人工介入的项
     * （异常镜头 → 待审核集数 → 待确认资产），没有则显示空态。
     */
    const pendingTasks = useMemo(() => {
        /** actionable=false 表示空态占位，不计入红点数量 */
        const items: { title: string; meta: string; color: string; actionable: boolean }[] = [];

        if (projectStats.abnormal > 0) {
            items.push({
                title: `${projectStats.abnormal} 个异常镜头待重试`,
                meta: '系统任务 · 超过 15 分钟未完成',
                color: '#ff4d4f',
                actionable: true,
            });
        }

        const reviewEps = episodeStatuses.filter((e) =>
            e.review === '待审核' || e.review === '待成片审核' || e.review === '待确认'
        );
        if (reviewEps.length > 0) {
            const first = reviewEps[0];
            items.push({
                title: `第 ${first.id} 集 ${first.stage}待复审`,
                meta: reviewEps.length > 1 ? `另有 ${reviewEps.length - 1} 集待处理` : first.review,
                color: '#ff9f1c',
                actionable: true,
            });
        }

        // 待确认资产：从已解析的集里找出还没出设定图的资产
        const assetStore = assetState || {};
        let pendingAssetTotal = 0;
        let pendingAssetSample = '';
        let pendingAssetEpisode = '';
        for (const ep of episodeStatuses) {
            const catMap = assetStore[String(ep.episode)] as Record<string, { name?: string; imageUrl?: string; looks?: { imageUrl?: string }[] }[]> | undefined;
            if (!catMap) continue;
            const pending = ['characters', 'scenes', 'props']
                .flatMap((k) => catMap[k] || [])
                .filter((a) => !a.imageUrl && !a.looks?.some((l) => l.imageUrl));
            if (pending.length === 0) continue;
            pendingAssetTotal += pending.length;
            if (!pendingAssetSample) {
                pendingAssetSample = pending[0].name || '未命名';
                pendingAssetEpisode = ep.id;
            }
        }
        if (pendingAssetTotal > 0) {
            items.push({
                title: `资产「${pendingAssetSample}」等 ${pendingAssetTotal} 项待生成设定图`,
                meta: `第 ${pendingAssetEpisode} 集起 · 资产确认`,
                color: '#1677ff',
                actionable: true,
            });
        }

        if (items.length === 0) {
            items.push({
                title: '暂无待处理事项',
                meta: episodeStatuses.length > 0 ? '所有分集均已进入生产' : '请先在「分集管理」确认剧本解析结果',
                color: '#00b42a',
                actionable: false,
            });
        }
        return items;
    }, [projectStats, episodeStatuses, assetState]);

    /**
     * 最近生产的分集：按「有视频任务/已出图」优先 + 集号顺序取前两条，
     * 与分集表同源，不再写死「雨夜重逢」。
     */
    const recentEpisodes = useMemo(() => {
        const sorted = [...episodeStatuses].sort((a, b) => {
            if (b.progress !== a.progress) return b.progress - a.progress;
            return a.episode - b.episode;
        });
        return sorted.slice(0, 2).map((e) => ({
            episode: `第 ${e.id} 集`,
            title: e.title,
            stage: e.stage,
            stageClass: EPISODE_BADGE_TONES[e.stageTone],
            updated: formatRelativeTime(e.updatedAt),
        }));
    }, [episodeStatuses]);

    /** 项目动态：把真实的里程碑事件拼出来（解析完成 / 资产出图 / 镜头视频进度） */
    const activities = useMemo(() => {
        const items: { title: string; meta: string; color: string }[] = [];
        const s = projectStats;

        if (s.total > 0) {
            items.push({
                title: '剧本解析完成',
                meta: `共识别 ${s.total} 集、资产 ${s.assetTotal} 项`,
                color: '#2f6bff',
            });
        }
        if (s.assetGenerated > 0) {
            items.push({
                title: `资产设定图已生成 ${s.assetGenerated} 项`,
                meta: `覆盖 ${s.assetDoneEpisodes} 集 · 项目资产`,
                color: '#10b5a7',
            });
        }
        if (s.shotTotal > 0) {
            items.push({
                title: `分镜已拆分 ${s.shotTotal} 个片段`,
                meta: `镜头视频 ${s.shotVideoDone} / ${s.shotTotal}`,
                color: '#8b5cf6',
            });
        }
        if (s.doneEpisodes > 0) {
            items.push({
                title: `整集成片已完成 ${s.doneEpisodes} 集`,
                meta: `进度 ${s.progressPercent}%`,
                color: '#00b42a',
            });
        }
        if (items.length === 0) {
            items.push({ title: '项目已创建，等待解析剧本', meta: project?.createdAt || '—', color: '#c9cdd4' });
        }
        return items.slice(0, 4);
    }, [projectStats, project]);

    /**
     * 顶部项目概览条：字段全部来自真实项目记录，
     * 进度百分比取逐集加权进度（与分集表、各标签统计同源）。
     */
    const projectHeader = useMemo(() => {
        const total = projectStats.total || project?.totalEpisodes || 0;
        const segments = [
            project?.category,
            project?.productionMode,
            project?.scriptName ? `锁定剧本 ${project.scriptName}` : '',
        ].filter(Boolean);
        const completed = total > 0 && projectStats.doneEpisodes >= total;
        const started = projectStats.inProduction > 0 || projectStats.doneEpisodes > 0;
        return {
            name: project?.name || '未命名项目',
            status: completed ? '已完成' : started ? '制作中' : '待制作',
            statusTone: completed
                ? 'bg-[#e8ffea] text-[#00b42a]'
                : started
                    ? 'bg-[#e8f2ff] text-[#2f6bff]'
                    : 'bg-[#f2f3f5] text-[#86909c]',
            summary: segments.length > 0 ? segments.join(' · ') : '暂无项目描述',
            code: project?.code || projectId,
            owner: project?.owner || '未指派',
            department: project?.department || '—',
            updatedAt: project?.updatedAt || '—',
            progress: projectStats.progressPercent,
        };
    }, [project, projectId, projectStats]);

    return (
        <div className="project-detail-page h-screen w-screen overflow-hidden bg-[#f5f6fa] text-[#1d2129]">
            <style>{`
                .project-detail-page { color-scheme: light; --focus-ring: #4558dc; --focus-ring-offset: 1px; }
                .project-detail-page ::-webkit-scrollbar { width: 8px; height: 8px; }
                .project-detail-page ::-webkit-scrollbar-track { background: transparent; }
                .project-detail-page ::-webkit-scrollbar-thumb { background: rgba(0,0,0,.16); border-radius: 4px; }
                .project-detail-page ::-webkit-scrollbar-thumb:hover { background: rgba(0,0,0,.28); }
                .project-detail-page .project-detail-input:focus-visible { outline: none; }
                @keyframes project-detail-spin { to { transform: rotate(360deg); } }
                .project-detail-page .project-detail-spinner { animation: project-detail-spin .8s linear infinite; }
            `}</style>

            <main className="flex h-full flex-col overflow-hidden">
                <header className="shrink-0 border-b border-[#f0f0f0] bg-white">
                    <nav className="flex items-center px-10 pt-[18px] text-[13px] text-[rgba(0,0,0,0.45)]" aria-label="面包屑">
                        <button type="button" onClick={onBack} className="-mx-1 rounded px-1 transition-colors hover:text-[#4558dc]">短剧创作</button>
                        <span className="mx-2">/</span>
                        <button type="button" onClick={onBack} className="-mx-1 rounded px-1 transition-colors hover:text-[#4558dc]">项目列表</button>
                        <span className="mx-2">/</span>
                        <span className="text-[rgba(0,0,0,0.88)]">项目详情</span>
                    </nav>

                    <div className="flex min-h-[72px] items-center justify-between gap-6 px-10 pb-4 pt-1">
                        <div className="flex min-w-0 items-baseline gap-3">
                            <span className="shrink-0 text-[16px] font-semibold text-[#1c2745]">短剧项目</span>
                            <span className="shrink-0 text-[22px] font-light text-[#c9cdd4]">/</span>
                            <h1 className="truncate text-[20px] font-semibold text-[#1c2745]">{projectHeader.name}</h1>
                        </div>

                        <div className="flex shrink-0 items-center gap-3">
                            {canRequest && (
                                <button
                                    type="button"
                                    onClick={() => setShowChangeRequest(true)}
                                    disabled={!project}
                                    className="flex h-9 items-center gap-1.5 rounded-md border border-[#d9d9d9] bg-white px-3.5 text-[14px] text-[#1d2129] transition-colors hover:border-[#4558dc] hover:text-[#4558dc] disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                    <Send size={15} />
                                    申请修改
                                </button>
                            )}
                            <button
                                type="button"
                                onClick={() => handleEnterWorkflow()}
                                className="flex h-9 items-center gap-1.5 rounded-md bg-[#4558dc] px-4 text-[14px] font-medium text-white transition-colors hover:bg-[#5c6fe4]"
                            >
                                <GitBranch size={15} />
                                进入画布
                            </button>
                        </div>
                    </div>
                </header>

                <div className="min-h-0 flex-1 overflow-y-auto px-10 py-5">
                    <div className="mx-auto max-w-[1840px]">
                        <section className="rounded-[10px] border border-[#e9ebf2] bg-white px-6 py-6 shadow-[0_2px_8px_rgba(33,43,83,0.03)]">
                            <div className="flex items-center justify-between gap-8">
                                <div className="flex min-w-0 items-center gap-4">
                                    <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-[12px] bg-[linear-gradient(135deg,#6967f2,#4a42de)] text-white shadow-[0_8px_18px_rgba(69,88,220,0.2)]">
                                        <Clapperboard size={28} strokeWidth={1.8} />
                                    </div>
                                    <div className="min-w-0">
                                        <div className="flex flex-wrap items-center gap-2.5">
                                            <h2 className="truncate text-[20px] font-semibold text-[#1c2745]">{projectHeader.name}</h2>
                                            <span className={`inline-flex shrink-0 items-center rounded px-2 py-0.5 text-[11px] ${projectHeader.statusTone}`}>
                                                {projectHeader.status}
                                            </span>
                                        </div>
                                        <p className="mt-1.5 text-[12px] text-[#7f889d]">{projectHeader.summary}</p>
                                        <div className="mt-4 flex flex-wrap items-center gap-y-2 text-[12px] text-[#9ca4b7]">
                                            <span>项目编号 {projectHeader.code}</span>
                                            <span className="mx-4 h-3 w-px bg-[#e5e7ef]" />
                                            <span>负责人 {projectHeader.owner}</span>
                                            <span className="mx-4 h-3 w-px bg-[#e5e7ef]" />
                                            <span>{projectHeader.department}</span>
                                            <span className="mx-4 h-3 w-px bg-[#e5e7ef]" />
                                            <span>最近更新 {projectHeader.updatedAt}</span>
                                        </div>
                                    </div>
                                </div>

                                <div className="w-[270px] shrink-0">
                                    <div className="flex items-end justify-between text-[11px] text-[#9ca4b7]">
                                        <span>整剧进度</span>
                                        <strong className="text-[18px] font-semibold leading-none text-[#1c2745]">{projectHeader.progress}%</strong>
                                    </div>
                                    <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-[#edf0f7]">
                                        <div className="h-full rounded-full bg-[linear-gradient(90deg,#5b56ee,#433bd9)]" style={{ width: `${projectHeader.progress}%` }} />
                                    </div>
                                </div>
                            </div>
                        </section>

                        <nav className="mt-4 flex h-[54px] min-w-0 items-center gap-9 overflow-x-auto rounded-[10px] border border-[#e9ebf2] bg-white px-6 shadow-[0_2px_8px_rgba(33,43,83,0.03)]" aria-label="项目详情页签">
                            {DETAIL_TABS.map((tab) => (
                                <button
                                    key={tab.key}
                                    type="button"
                                    onClick={() => setActiveTab(tab.key)}
                                    aria-current={activeTab === tab.key ? 'page' : undefined}
                                    className={`relative flex h-full shrink-0 items-center gap-1.5 whitespace-nowrap text-[14px] transition-colors ${activeTab === tab.key ? 'font-semibold text-[#4558dc]' : 'text-[#4e5969] hover:text-[#4558dc]'}`}
                                >
                                    {tab.label}
                                    {(() => {
                                        // 分集数量用真实解析结果，避免写着演示的 80 集
                                        const count =
                                            tab.key === 'episodes'
                                                ? project?.scriptAnalysis?.episodes?.length || tab.count
                                                : tab.count;
                                        return count ? (
                                            <span className="inline-flex h-[18px] min-w-[24px] items-center justify-center rounded-full bg-[#f2f3f5] px-1.5 text-[10px] font-normal text-[#86909c]">{count}</span>
                                        ) : null;
                                    })()}
                                    {tab.key === 'tasks' && abnormalTaskCount > 0 ? (
                                        <span
                                            className="inline-flex h-[16px] min-w-[16px] items-center justify-center rounded-full bg-[#ff4d4f] px-1 text-[10px] font-normal leading-none text-white"
                                            title={`${abnormalTaskCount} 个异常任务`}
                                        >
                                            {abnormalTaskCount > 99 ? '99+' : abnormalTaskCount}
                                        </span>
                                    ) : null}
                                    {activeTab === tab.key && <span className="absolute bottom-0 left-0 h-[2px] w-full rounded-full bg-[#4558dc]" />}
                                </button>
                            ))}
                        </nav>

                        {loadError && (
                            <div role="alert" className="mt-4 flex items-start gap-2 rounded-[8px] border border-[#ffccc7] bg-[#fff2f0] px-4 py-3 text-[12px] text-[#cf1322]">
                                <AlertTriangle size={15} className="mt-0.5 shrink-0" />
                                <span>{loadError}</span>
                            </div>
                        )}

                        {activeTab === 'overview' ? (
                            <div className="mt-4 grid grid-cols-[minmax(0,2fr)_minmax(360px,1fr)] items-start gap-5 max-[1100px]:grid-cols-1">
                                {/* 生产总览 */}
                                <section className="flex min-h-[285px] flex-col overflow-hidden rounded-[10px] border border-[#e9ebf2] bg-white shadow-[0_2px_8px_rgba(33,43,83,0.03)]">
                                    <div className="flex h-[64px] shrink-0 items-center justify-between border-b border-[#eef0f6] px-6">
                                        <h2 className="text-[16px] font-semibold text-[#1c2745]">生产总览</h2>
                                        <button type="button" onClick={() => handleEnterWorkflow()} className="text-[13px] text-[#4558dc] transition-colors hover:text-[#6878e7]">打开第 01 集画布</button>
                                    </div>
                                    <div className="flex flex-1 flex-col px-6 pb-6 pt-6">
                                        <div className="flex items-center overflow-x-auto pb-1">
                                            {overviewFlow.map((step, index) => (
                                                <React.Fragment key={step.title}>
                                                    {index > 0 && <div className={`mx-3 h-px min-w-[28px] flex-1 ${flowLines[index - 1]}`} />}
                                                    <div className="flex shrink-0 items-center gap-2.5">
                                                        <span className={`flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-medium ${step.state === 'done' ? 'bg-[#10b981] text-white' : step.state === 'active' ? 'bg-[#5b56ee] text-white' : 'border border-[#d9d9d9] bg-white text-[#a0a6b4]'}`}>
                                                            {step.state === 'done' ? <Check size={11} strokeWidth={3} /> : step.number}
                                                        </span>
                                                        <div className="whitespace-nowrap">
                                                            <div className="text-[12px] font-medium text-[#1d2129]">{step.title}</div>
                                                            <div className="mt-0.5 text-[11px] text-[#9ca4b7]">{step.detail}</div>
                                                        </div>
                                                    </div>
                                                </React.Fragment>
                                            ))}
                                        </div>

                                        <div className="mt-8 grid grid-cols-4 gap-2 max-[850px]:grid-cols-2">
                                            {productionStats.map((stat) => (
                                                <div key={stat.label} className="rounded-[5px] bg-[#f7f8fc] px-4 py-3">
                                                    <div className="text-[11px] text-[#9ca4b7]">{stat.label}</div>
                                                    <div className="mt-1.5 text-[15px] font-semibold text-[#1c2745]">{stat.value}</div>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                </section>

                                {/* 待我处理 */}
                                <section className="flex min-h-[326px] flex-col overflow-hidden rounded-[10px] border border-[#e9ebf2] bg-white shadow-[0_2px_8px_rgba(33,43,83,0.03)]">
                                    <div className="flex h-[64px] shrink-0 items-center justify-between border-b border-[#eef0f6] px-6">
                                        <h2 className="text-[16px] font-semibold text-[#1c2745]">待我处理</h2>
                                        {pendingTasks.some((task) => task.actionable) ? (
                                            <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-[#ff4d4f] px-1 text-[11px] font-medium text-white">
                                                {pendingTasks.filter((task) => task.actionable).length}
                                            </span>
                                        ) : (
                                            <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-[#f2f3f5] px-1 text-[11px] font-medium text-[#86909c]">0</span>
                                        )}
                                    </div>
                                    <div className="flex flex-1 flex-col px-6">
                                        {pendingTasks.map((task) => (
                                            <div key={task.title} className="flex flex-1 items-center gap-3 border-b border-[#f0f1f5] py-4 last:border-b-0">
                                                <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: task.color }} />
                                                <div className="min-w-0 flex-1">
                                                    <div className="truncate text-[13px] font-medium text-[#1d2129]">{task.title}</div>
                                                    <div className="mt-1 text-[11px] text-[#9ca4b7]">{task.meta}</div>
                                                </div>
                                                <ArrowRight size={16} className="shrink-0 text-[#c2c7d2]" />
                                            </div>
                                        ))}
                                    </div>
                                </section>

                                {/* 最近生产的分集 */}
                                <section className="flex min-h-[270px] flex-col overflow-hidden rounded-[10px] border border-[#e9ebf2] bg-white shadow-[0_2px_8px_rgba(33,43,83,0.03)]">
                                    <div className="flex h-[64px] shrink-0 items-center justify-between border-b border-[#eef0f6] px-6">
                                        <h2 className="text-[16px] font-semibold text-[#1c2745]">最近生产的分集</h2>
                                        <span className="text-[13px] text-[#4558dc]">查看全部</span>
                                    </div>
                                    <div className="flex-1 px-6 pb-5 pt-4">
                                        <div className="overflow-x-auto">
                                            <table className="w-full min-w-[620px] border-collapse text-left">
                                                <thead>
                                                    <tr className="bg-[#fafbfc] text-[12px] text-[#4e5969]">
                                                        <th className="w-[14%] px-4 py-3 font-medium">集数</th>
                                                        <th className="w-[26%] px-4 py-3 font-medium">标题</th>
                                                        <th className="w-[22%] px-4 py-3 font-medium">阶段</th>
                                                        <th className="w-[21%] px-4 py-3 font-medium">更新</th>
                                                        <th className="w-[17%] px-4 py-3 font-medium">操作</th>
                                                    </tr>
                                                </thead>
                                                <tbody>
                                                    {recentEpisodes.length === 0 ? (
                                                        <tr>
                                                            <td colSpan={5} className="px-4 py-12 text-center text-[12px] text-[#9ca4b7]">
                                                                暂无生产中的数据，请先在「分集管理」完成剧本解析
                                                            </td>
                                                        </tr>
                                                    ) : (
                                                        recentEpisodes.map((episode) => (
                                                            <tr key={episode.episode} className="border-b border-[#f0f1f5] text-[13px] text-[#1d2129] last:border-b-0">
                                                                <td className="px-4 py-[17px] font-medium">{episode.episode}</td>
                                                                <td className="max-w-0 truncate px-4 py-[17px]">{episode.title}</td>
                                                                <td className="px-4 py-[17px]">
                                                                    <span className={`inline-flex rounded px-2 py-1 text-[11px] ${episode.stageClass}`}>{episode.stage}</span>
                                                                </td>
                                                                <td className="px-4 py-[17px]">{episode.updated}</td>
                                                                <td className="px-4 py-[17px]">
                                                                    <button
                                                                        type="button"
                                                                        onClick={() => handleEnterWorkflow(Number(episode.episode.replace(/[^\d]/g, '')) || undefined)}
                                                                        className="text-[#4558dc] transition-colors hover:text-[#6878e7]"
                                                                    >
                                                                        进入画布
                                                                    </button>
                                                                </td>
                                                            </tr>
                                                        ))
                                                    )}
                                                </tbody>
                                            </table>
                                        </div>
                                    </div>
                                </section>

                                {/* 项目动态 */}
                                <section className="flex min-h-[270px] flex-col overflow-hidden rounded-[10px] border border-[#e9ebf2] bg-white shadow-[0_2px_8px_rgba(33,43,83,0.03)]">
                                    <div className="flex h-[64px] shrink-0 items-center border-b border-[#eef0f6] px-6">
                                        <h2 className="text-[16px] font-semibold text-[#1c2745]">项目动态</h2>
                                    </div>
                                    <div className="flex-1 px-6 py-5">
                                        <div className="space-y-5">
                                            {activities.map((activity, index) => (
                                                <div key={`${activity.title}-${index}`} className="flex items-start gap-3">
                                                    <span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full border-2 bg-white" style={{ borderColor: activity.color }} />
                                                    <div className="min-w-0">
                                                        <div className="text-[12.5px] font-medium text-[#1d2129]">{activity.title}</div>
                                                        <div className="mt-1 text-[11px] text-[#9ca4b7]">{activity.meta}</div>
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                </section>
                            </div>
                        ) : activeTab === 'episodes' ? (
                            <div className="mt-4 space-y-4">
                                <div className="flex flex-wrap items-start justify-between gap-4">
                                    <div>
                                        <h2 className="text-[18px] font-semibold text-[#1c2745]">分集生产轨道</h2>
                                        <p className="mt-1 text-[12px] text-[#9ca4b7]">每集拥有独立画布、版本、审核与生成任务</p>
                                    </div>
                                    <div className="flex w-[132px] flex-col gap-1.5">
                                        <button
                                            type="button"
                                            disabled
                                            className="h-8 cursor-not-allowed rounded-[4px] border border-[#e5e6eb] bg-[#f7f8fa] px-3 text-[12px] text-[#c9cdd4] hidden"
                                        >
                                            批量初始化画布
                                        </button>
                                        <button
                                            type="button"
                                            disabled
                                            className="h-8 cursor-not-allowed rounded-[4px] border border-[#e5e6eb] bg-[#f7f8fa] px-3 text-[12px] text-[#c9cdd4] hidden"
                                        >
                                            设置协作角色
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => handleEnterWorkflow()}
                                            className="h-8 rounded-[4px] bg-[#4558dc] px-3 text-[12px] font-medium text-white transition-colors hover:bg-[#5c6fe4]"
                                        >
                                            进入最近画布
                                        </button>
                                    </div>
                                </div>

                                <section className="grid grid-cols-5 overflow-hidden rounded-[10px] border border-[#e9ebf2] bg-white shadow-[0_2px_8px_rgba(33,43,83,0.03)] max-[900px]:grid-cols-2">
                                    {[
                                        { label: '总集数', value: String(projectStats.total), color: 'text-[#1c2745]' },
                                        { label: '生产中', value: String(projectStats.inProduction), color: 'text-[#ff7d00]' },
                                        { label: '待审核', value: String(projectStats.pendingReview), color: 'text-[#ff9f1c]' },
                                        { label: '已完成', value: String(projectStats.done), color: 'text-[#00b42a]' },
                                        { label: '异常镜头', value: String(projectStats.abnormal), color: 'text-[#ff4d4f]' },
                                    ].map((stat, index) => (
                                        <div
                                            key={stat.label}
                                            className={`flex min-h-[92px] flex-col items-center justify-center px-4 py-4 ${index > 0 ? 'border-l border-[#f0f1f5]' : ''}`}
                                        >
                                            <span className="text-[11px] text-[#86909c]">{stat.label}</span>
                                            <strong className={`mt-1.5 text-[20px] font-semibold leading-none ${stat.color}`}>{stat.value}</strong>
                                        </div>
                                    ))}
                                </section>

                                <section className="flex flex-wrap items-center gap-3 rounded-[10px] border border-[#e9ebf2] bg-white px-6 py-4 shadow-[0_2px_8px_rgba(33,43,83,0.03)]">
                                    <label className="relative block w-[280px] max-w-full">
                                        <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[#86909c]" />
                                        <input
                                            type="search"
                                            value={episodeSearch}
                                            onChange={(event) => setEpisodeSearch(event.target.value)}
                                            onKeyDown={(event) => {
                                                if (event.key === 'Enter') applyEpisodeFilters();
                                            }}
                                            placeholder="搜索集数或标题"
                                            className="project-detail-input h-8 w-full rounded-[4px] border border-transparent bg-[#f7f8fa] pl-8 pr-3 text-[12px] text-[#1d2129] outline-none transition-colors placeholder:text-[#9ca4b7] focus:border-[#4558dc] focus:bg-white"
                                        />
                                    </label>

                                    <label className="relative block w-[166px]">
                                        <select
                                            value={episodeStageFilter}
                                            onChange={(event) => setEpisodeStageFilter(event.target.value)}
                                            className="project-detail-input h-8 w-full appearance-none rounded-[4px] border border-transparent bg-[#f7f8fa] pl-3 pr-8 text-[12px] text-[#1d2129] outline-none transition-colors focus:border-[#4558dc] focus:bg-white"
                                        >
                                            {withCurrentOption(EPISODE_STAGE_OPTIONS, episodeStageFilter).map((option) => (
                                                <option key={option} value={option}>{option}</option>
                                            ))}
                                        </select>
                                        <ChevronDown size={13} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[#c9cdd4]" />
                                    </label>

                                    <label className="relative block w-[162px]">
                                        <select
                                            value={episodeReviewFilter}
                                            onChange={(event) => setEpisodeReviewFilter(event.target.value)}
                                            className="project-detail-input h-8 w-full appearance-none rounded-[4px] border border-transparent bg-[#f7f8fa] pl-3 pr-8 text-[12px] text-[#1d2129] outline-none transition-colors focus:border-[#4558dc] focus:bg-white"
                                        >
                                            {withCurrentOption(EPISODE_REVIEW_OPTIONS, episodeReviewFilter).map((option) => (
                                                <option key={option} value={option}>{option}</option>
                                            ))}
                                        </select>
                                        <ChevronDown size={13} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[#c9cdd4]" />
                                    </label>

                                    <button
                                        type="button"
                                        onClick={applyEpisodeFilters}
                                        className="h-8 rounded-[4px] bg-[#4558dc] px-4 text-[12px] font-medium text-white transition-colors hover:bg-[#5c6fe4]"
                                    >
                                        查询
                                    </button>
                                    <button
                                        type="button"
                                        onClick={resetEpisodeFilters}
                                        className="h-8 rounded-[4px] border border-[#d9d9d9] bg-white px-4 text-[12px] text-[#1d2129] transition-colors hover:border-[#4558dc] hover:text-[#4558dc]"
                                    >
                                        重置
                                    </button>
                                </section>

                                <section className="overflow-hidden rounded-[10px] border border-[#e9ebf2] bg-white shadow-[0_2px_8px_rgba(33,43,83,0.03)]">
                                    <div className="overflow-x-auto">
                                        <table className="w-full min-w-[1180px] border-collapse text-left">
                                            <thead>
                                                <tr className="border-b border-[#eef0f6] bg-[#fafbfc] text-[12px] text-[#1d2129]">
                                                    <th className="w-[52px] px-6 py-3">
                                                        <input
                                                            type="checkbox"
                                                            aria-label="全选分集"
                                                            checked={allVisibleEpisodesSelected}
                                                            onChange={toggleAllVisibleEpisodes}
                                                            className="h-3.5 w-3.5 cursor-pointer rounded-[2px] accent-[#4558dc]"
                                                        />
                                                    </th>
                                                    <th className="w-[230px] px-4 py-3 font-medium">集数 / 标题</th>
                                                    <th className="w-[138px] px-4 py-3 font-medium">引用资产</th>
                                                    <th className="w-[104px] px-4 py-3 font-medium">分镜</th>
                                                    <th className="w-[132px] px-4 py-3 font-medium">镜头视频</th>
                                                    <th className="w-[104px] px-4 py-3 font-medium">成片</th>
                                                    <th className="w-[126px] px-4 py-3 font-medium">当前阶段</th>
                                                    <th className="w-[120px] px-4 py-3 font-medium">审核状态</th>
                                                    <th className="w-[120px] px-4 py-3 font-medium">最近更新</th>
                                                    <th className="w-[150px] px-4 py-3 font-medium">操作</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {visibleEpisodes.map((episode) => (
                                                    <tr key={episode.id} className="border-b border-[#f0f1f5] text-[12px] text-[#1d2129] last:border-b-0 hover:bg-[#fafbff]">
                                                        <td className="px-6 py-4 align-middle">
                                                            <input
                                                                type="checkbox"
                                                                aria-label={`选择第 ${episode.id} 集`}
                                                                checked={selectedEpisodes.includes(episode.id)}
                                                                onChange={() => toggleEpisodeSelection(episode.id)}
                                                                className="h-3.5 w-3.5 cursor-pointer rounded-[2px] accent-[#4558dc]"
                                                            />
                                                        </td>
                                                        <td className="px-4 py-4 align-middle">
                                                            <div className="flex items-center gap-2.5">
                                                                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[4px] bg-[#eef0ff] text-[11px] font-semibold text-[#4558dc]">{episode.id}</span>
                                                                <div className="min-w-0">
                                                                    <div className="truncate text-[13px] font-medium text-[#1d2129]">{episode.title}</div>
                                                                    <div className="mt-1 text-[11px] text-[#9ca4b7]">{episode.detail}</div>
                                                                </div>
                                                            </div>
                                                        </td>
                                                        <td className="px-4 py-4 align-middle">
                                                            <div>{episode.assets}</div>
                                                            <div className="mt-1 text-[11px] text-[#9ca4b7]">{episode.assetKinds}</div>
                                                        </td>
                                                        <td className="px-4 py-4 align-middle">{episode.storyboard}</td>
                                                        <td className={`px-4 py-4 align-middle ${episode.videoAlert ? 'font-medium text-[#f04438]' : ''}`}>{episode.video}</td>
                                                        <td className="px-4 py-4 align-middle">
                                                            <span className={`inline-flex rounded-[3px] px-2 py-1 text-[11px] ${EPISODE_BADGE_TONES[episode.finalTone]}`}>{episode.final}</span>
                                                        </td>
                                                        <td className="px-4 py-4 align-middle">
                                                            <span className={`inline-flex rounded-[3px] px-2 py-1 text-[11px] ${EPISODE_BADGE_TONES[episode.stageTone]}`}>{episode.stage}</span>
                                                        </td>
                                                        <td className="whitespace-nowrap px-4 py-4 align-middle">
                                                            {episode.review === '—' ? (
                                                                <span className="text-[#c9cdd4]">—</span>
                                                            ) : (
                                                                <span className={`inline-flex rounded-[3px] px-2 py-1 text-[11px] ${EPISODE_BADGE_TONES[episode.reviewTone]}`}>{episode.review}</span>
                                                            )}
                                                        </td>
                                                        <td className="whitespace-nowrap px-4 py-4 align-middle text-[#4e5969]">{episode.updated}</td>
                                                        <td className="px-4 py-4 align-middle">
                                                            <div className="flex items-center gap-4 whitespace-nowrap">
                                                                <button type="button" onClick={() => handleEnterWorkflow(Number(episode.id))} className="text-[#2f74ff] transition-colors hover:text-[#5c8fff]">进入画布</button>
                                                                <button type="button" onClick={() => setToast(`查看第 ${episode.id} 集制作进度`)} className="text-[#2f74ff] transition-colors hover:text-[#5c8fff] hidden">进度</button>
                                                                <button
                                                                    type="button"
                                                                    aria-label={`第 ${episode.id} 集更多操作`}
                                                                    onClick={() => setToast('更多操作暂未接入')}
                                                                    className="text-[#86909c] transition-colors hover:text-[#4558dc] hidden"
                                                                >
                                                                    <MoreVertical size={15} />
                                                                </button>
                                                            </div>
                                                        </td>
                                                    </tr>
                                                ))}
                                                {visibleEpisodes.length === 0 && (
                                                    <tr>
                                                        <td colSpan={10} className="px-6 py-16 text-center text-[13px] text-[#9ca4b7]">暂无匹配的分集</td>
                                                    </tr>
                                                )}
                                            </tbody>
                                        </table>
                                    </div>
                                </section>
                            </div>
                        ) : activeTab === 'assets' ? (
                            <div className="mt-4 space-y-4">
                                <div className="flex flex-wrap items-start justify-between gap-4">
                                    <div>
                                        <h2 className="text-[18px] font-semibold text-[#1c2745]">项目资产</h2>
                                        <p className="mt-1 text-[12px] text-[#9ca4b7]">
                                            确认 AI 从剧本提取的角色 / 场景 / 道具，生成并管理设定图；同一资产跨集复用同一张图
                                        </p>
                                    </div>
                                    <div className="text-right text-[12px] text-[#9ca4b7]">
                                        <div>
                                            已识别资产{' '}
                                            <strong className="text-[15px] font-semibold text-[#1c2745]">
                                                {projectStats.assetTotal || assetSummary.total}
                                            </strong>{' '}
                                            项
                                        </div>
                                        <div className="mt-1">
                                            已生成设定图{' '}
                                            <strong className="text-[15px] font-semibold text-[#4558dc]">
                                                {projectStats.assetGenerated || assetSummary.generated}
                                            </strong>{' '}
                                            项
                                        </div>
                                    </div>
                                </div>

                                {assetEpisodes.length === 0 ? (
                                    <section className="rounded-[10px] border border-[#e9ebf2] bg-white px-6 py-16 text-center shadow-[0_2px_8px_rgba(33,43,83,0.03)]">
                                        <div className="text-[13px] text-[#9ca4b7]">
                                            该项目暂无剧本解析结果，请先在「分集管理」中完成剧本解析后再确认资产
                                        </div>
                                    </section>
                                ) : (
                                    <AssetConfirmPanel
                                        projectId={projectId}
                                        episodes={assetEpisodes}
                                        contentType={project?.category}
                                        initialEpisode={assetInitialEpisode}
                                        fillHeight={false}
                                        onAssetsChange={handleAssetsChange}
                                    />
                                )}
                            </div>
                        ) : activeTab === 'tasks' ? (
                            <div className="mt-4 space-y-4">
                                <div className="flex flex-wrap items-start justify-between gap-4">
                                    <div>
                                        <h2 className="text-[18px] font-semibold text-[#1c2745]">生成任务</h2>
                                        <p className="mt-1 text-[12px] text-[#9ca4b7]">资产、分镜与画布节点的每一次生成都会留痕，失败与超时可从这里重试</p>
                                    </div>
                                    <div className="flex flex-wrap items-center gap-2">
                                        <select
                                            value={tasksActorFilter}
                                            onChange={(event) => setTasksActorFilter(event.target.value)}
                                            title="按触发人筛选任务"
                                            className="h-8 rounded-[4px] border border-[#d9d9d9] bg-white px-2 text-[12px] text-[#1d2129] outline-none transition-colors hover:border-[#4558dc] focus:border-[#4558dc]"
                                        >
                                            <option value="all">全部人员</option>
                                            {user?.id && <option value="me">仅看我发起的</option>}
                                            {taskActors.map((actor) => (
                                                <option key={actor.id} value={`id:${actor.id}`}>
                                                    {actor.name}
                                                    {ACTOR_ROLE_META[actor.role] ? `（${ACTOR_ROLE_META[actor.role].label}）` : ''}
                                                </option>
                                            ))}
                                        </select>
                                        <button
                                            type="button"
                                            onClick={() => setTasksAbnormalOnly((current) => !current)}
                                            className={`h-8 rounded-[4px] border px-3 text-[12px] transition-colors ${tasksAbnormalOnly ? 'border-[#4558dc] bg-[#f5f6ff] text-[#4558dc]' : 'border-[#d9d9d9] bg-white text-[#1d2129] hover:border-[#4558dc] hover:text-[#4558dc]'}`}
                                        >
                                            仅看异常{abnormalTaskCount > 0 ? ` ${abnormalTaskCount}` : ''}
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => void handleRefreshTasks()}
                                            disabled={jobsLoading}
                                            className="flex h-8 items-center justify-center gap-1.5 rounded-[4px] border border-[#d9d9d9] bg-white px-3 text-[12px] text-[#1d2129] transition-colors hover:border-[#4558dc] hover:text-[#4558dc] disabled:cursor-not-allowed disabled:text-[#c9cdd4]"
                                        >
                                            <RefreshCw size={13} className={jobsLoading ? 'animate-spin' : undefined} />
                                            刷新
                                        </button>
                                    </div>
                                </div>

                                {legacyTaskCount > 0 && (
                                    <div className="rounded-[8px] border border-[#ffe8ba] bg-[#fffbe6] px-4 py-2.5 text-[12px] text-[#ad6800]">
                                        有 {legacyTaskCount} 条任务产生于改造前，未记录触发人，显示为「未记录」；此后新发起的任务都会按登录账号记人。
                                    </div>
                                )}

                                {jobsError && (
                                    <div role="alert" className="flex items-start gap-2 rounded-[8px] border border-[#ffccc7] bg-[#fff2f0] px-4 py-3 text-[12px] text-[#cf1322]">
                                        <AlertTriangle size={15} className="mt-0.5 shrink-0" />
                                        <span className="flex-1">{jobsError}</span>
                                        <button type="button" onClick={() => void handleRefreshTasks()} className="shrink-0 text-[#cf1322] underline">
                                            重试
                                        </button>
                                    </div>
                                )}

                                <section className="overflow-hidden rounded-[10px] border border-[#e9ebf2] bg-white shadow-[0_2px_8px_rgba(33,43,83,0.03)]">
                                    <div className="overflow-x-auto">
                                        <table className="w-full min-w-[1100px] border-collapse text-left">
                                            <thead>
                                                <tr className="border-b border-[#eef0f6] bg-[#fafbfc] text-[12px] text-[#1d2129]">
                                                    <th className="w-[320px] px-6 py-4 font-medium">任务 / 编号</th>
                                                    <th className="w-[110px] px-4 py-4 font-medium">节点</th>
                                                    <th className="w-[180px] px-4 py-4 font-medium">生成服务</th>
                                                    <th className="w-[220px] px-4 py-4 font-medium">进度</th>
                                                    <th className="w-[90px] px-4 py-4 font-medium">状态</th>
                                                    <th className="w-[110px] px-4 py-4 font-medium">最近更新</th>
                                                    <th className="w-[170px] px-4 py-4 font-medium">触发人</th>
                                                    <th className="w-[130px] px-4 py-4 font-medium">操作</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {visibleTasks.map((task) => (
                                                    <React.Fragment key={task.id}>
                                                        <tr className="border-b border-[#f0f1f5] text-[12px] text-[#1d2129] hover:bg-[#fafbff]">
                                                            <td className="px-6 py-6 align-middle">
                                                                <div className="text-[13px] font-medium text-[#1c2745]">{task.title}</div>
                                                                <div className="mt-1.5 text-[11px] text-[#9ca4b7]">{task.id}</div>
                                                            </td>
                                                            <td className="px-4 py-6 align-middle">{task.node}</td>
                                                            <td className="px-4 py-6 align-middle">{task.service}</td>
                                                            <td className="px-4 py-6 align-middle">
                                                                <div className="flex items-center gap-2">
                                                                    <div className="relative h-1.5 w-[174px] rounded-full bg-[#edf0f7]">
                                                                        {task.progress === null ? (
                                                                            task.statusTone === 'red' ? (
                                                                                <div className="h-full w-full rounded-full bg-[#ffece8]" />
                                                                            ) : (
                                                                                <div className="h-full w-1/3 animate-pulse rounded-full bg-[#2f74ff]" />
                                                                            )
                                                                        ) : (
                                                                            <div
                                                                                className="h-full rounded-full bg-[#5ac25f]"
                                                                                style={{ width: `${task.progress}%` }}
                                                                            />
                                                                        )}
                                                                        {task.progress === 100 && (
                                                                            <span className="absolute -right-1 top-1/2 flex h-3.5 w-3.5 -translate-y-1/2 items-center justify-center rounded-full bg-[#5ac25f] text-white">
                                                                                <Check size={9} strokeWidth={3} />
                                                                            </span>
                                                                        )}
                                                                    </div>
                                                                    <span className={`text-[11px] ${task.progress === 100 ? 'text-[#00b42a]' : 'text-[#4e5969]'}`}>
                                                                        {task.progress === null
                                                                            ? (task.statusTone === 'red' ? '未完成' : '进行中')
                                                                            : `${task.progress}%`}
                                                                    </span>
                                                                </div>
                                                            </td>
                                                            <td className="px-4 py-6 align-middle">
                                                                <span className={`inline-flex rounded-[3px] px-2 py-1 text-[11px] ${TASK_STATUS_STYLES[task.statusTone]}`}>{task.status}</span>
                                                            </td>
                                                            <td className="whitespace-nowrap px-4 py-6 align-middle">{task.updatedAt}</td>
                                                            <td className="whitespace-nowrap px-4 py-6 align-middle">
                                                                {task.actorKnown ? (
                                                                    <div className="flex items-center gap-1.5">
                                                                        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#4558dc] text-[11px] text-white">
                                                                            {task.actorName.slice(0, 1)}
                                                                        </span>
                                                                        <span className="max-w-[64px] truncate" title={task.actorName}>{task.actorName}</span>
                                                                        {task.isMe && (
                                                                            <span className="rounded-[3px] bg-[#e8f1ff] px-1 py-0.5 text-[10px] text-[#1677ff]">我</span>
                                                                        )}
                                                                        {ACTOR_ROLE_META[task.actorRole] && (
                                                                            <span className={`rounded-[3px] px-1 py-0.5 text-[10px] ${ACTOR_ROLE_META[task.actorRole].badge}`}>
                                                                                {ACTOR_ROLE_META[task.actorRole].label}
                                                                            </span>
                                                                        )}
                                                                    </div>
                                                                ) : (
                                                                    <span className="text-[#c9cdd4]" title="改造前的历史任务没有记录触发人">未记录</span>
                                                                )}
                                                            </td>
                                                            <td className="px-4 py-6 align-middle">
                                                                <div className="flex items-center gap-6 whitespace-nowrap">
                                                                    <button
                                                                        type="button"
                                                                        onClick={() => setExpandedJobId((current) => (current === task.id ? null : task.id))}
                                                                        className="text-[#2f74ff] transition-colors hover:text-[#5c8fff]"
                                                                    >
                                                                        {expandedJobId === task.id ? '收起' : '日志'}
                                                                    </button>
                                                                    <button
                                                                        type="button"
                                                                        disabled={!task.canRetry}
                                                                        onClick={() => void handleRetryTask(task)}
                                                                        className="text-[#2f74ff] transition-colors hover:text-[#5c8fff] disabled:cursor-not-allowed disabled:text-[#c9cdd4]"
                                                                    >
                                                                        重试
                                                                    </button>
                                                                </div>
                                                            </td>
                                                        </tr>
                                                        {expandedJobId === task.id && (
                                                            <tr className="border-b border-[#f0f1f5] bg-[#fafbff]">
                                                                <td colSpan={8} className="px-6 py-5">
                                                                    <div className="space-y-3 text-[12px] text-[#4e5969]">
                                                                        {task.job.payload?.error && (
                                                                            <div className="flex items-start gap-2 rounded-[6px] border border-[#ffccc7] bg-[#fff2f0] px-3 py-2 text-[#cf1322]">
                                                                                <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                                                                                <span>{String(task.job.payload.error)}</span>
                                                                            </div>
                                                                        )}
                                                                        <div className="grid gap-x-8 gap-y-1.5 sm:grid-cols-2">
                                                                            <div>
                                                                                触发人：
                                                                                <span className="text-[#1d2129]">
                                                                                    {task.actorKnown
                                                                                        ? `${task.actorName}${ACTOR_ROLE_META[task.actorRole] ? ` · ${ACTOR_ROLE_META[task.actorRole].label}` : ''}`
                                                                                        : '未记录（改造前任务）'}
                                                                                </span>
                                                                            </div>
                                                                            <div>触发账号：<span className="text-[#1d2129]">{task.actorId || '—'}</span></div>
                                                                            <div>任务编号：<span className="text-[#1d2129]">{task.id}</span></div>
                                                                            <div>服务端任务：<span className="text-[#1d2129]">{String(task.job.payload?.taskId || '—')}</span></div>
                                                                            <div>提交时间：<span className="text-[#1d2129]">{task.job.startedAt ? new Date(task.job.startedAt).toLocaleString() : '—'}</span></div>
                                                                            <div>结束时间：<span className="text-[#1d2129]">{task.job.payload?.finishedAt ? new Date(Number(task.job.payload.finishedAt)).toLocaleString() : '—'}</span></div>
                                                                            <div>模型：<span className="text-[#1d2129]">{String(task.job.payload?.videoModel || task.job.payload?.imageModel || '—')}</span></div>
                                                                            <div>参数：<span className="text-[#1d2129]">{String(task.job.payload?.resolution || '—')} · {String(task.job.payload?.aspectRatio || '—')}{(task.job.payload?.duration ? ` · ${task.job.payload.duration}s` : '')}</span></div>
                                                                        </div>
                                                                        {task.job.payload?.prompt && (
                                                                            <div className="rounded-[6px] bg-white p-3 ring-1 ring-[#eef0f6]">
                                                                                <div className="mb-1 text-[11px] text-[#9ca4b7]">提示词</div>
                                                                                <div className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words text-[#1d2129]">{String(task.job.payload.prompt)}</div>
                                                                            </div>
                                                                        )}
                                                                    </div>
                                                                </td>
                                                            </tr>
                                                        )}
                                                    </React.Fragment>
                                                ))}
                                                {visibleTasks.length === 0 && (
                                                    <tr>
                                                        <td colSpan={8} className="px-6 py-20 text-center text-[13px] text-[#9ca4b7]">
                                                            {jobsLoading
                                                                ? '正在加载任务…'
                                                                : tasksAbnormalOnly
                                                                    ? '暂无异常任务'
                                                                    : '暂无生成任务。生成资产图、镜头视频或画布节点后，这里会自动出现对应的任务记录'}
                                                        </td>
                                                    </tr>
                                                )}
                                            </tbody>
                                        </table>
                                    </div>
                                    <div className="flex h-[52px] items-center justify-between gap-2 border-t border-[#eef0f6] px-6 text-[12px] text-[#9ca4b7]">
                                        <span>
                                            共 {generationTasks.length} 条任务
                                            {abnormalTaskCount > 0 ? `，其中 ${abnormalTaskCount} 条异常` : ''}
                                        </span>
                                        <span>每次生成尝试都会留痕，最多保留最近 200 条</span>
                                    </div>
                                </section>
                            </div>
                        ) : activeTab === 'versions' ? (
                            <div className="mt-4 space-y-4">
                                <div className="flex flex-wrap items-start justify-between gap-4">
                                    <div>
                                        <h2 className="text-[18px] font-semibold text-[#1c2745]">版本记录</h2>
                                        <p className="mt-1 text-[12px] text-[#9ca4b7]">查看剧本、资产、分镜、镜头和成片的历史版本与引用关系</p>
                                    </div>
                                    <button
                                        type="button"
                                        onClick={() => setToast('版本清单已导出')}
                                        className="h-8 rounded-[4px] border border-[#d9d9d9] bg-white px-4 text-[12px] text-[#1d2129] transition-colors hover:border-[#4558dc] hover:text-[#4558dc]"
                                    >
                                        导出本版清单
                                    </button>
                                </div>

                                <section className="overflow-hidden rounded-[10px] border border-[#e9ebf2] bg-white shadow-[0_2px_8px_rgba(33,43,83,0.03)]">
                                    <div className="overflow-x-auto">
                                        <table className="w-full min-w-[1040px] border-collapse text-left">
                                            <thead>
                                                <tr className="border-b border-[#eef0f6] bg-[#fafbfc] text-[12px] text-[#1d2129]">
                                                    <th className="w-[270px] px-6 py-3.5 font-medium">对象</th>
                                                    <th className="w-[100px] px-4 py-3.5 font-medium">版本</th>
                                                    <th className="w-[320px] px-4 py-3.5 font-medium">版本说明</th>
                                                    <th className="w-[120px] px-4 py-3.5 font-medium">使用状态</th>
                                                    <th className="w-[120px] px-4 py-3.5 font-medium">创建人</th>
                                                    <th className="w-[150px] px-4 py-3.5 font-medium">创建时间</th>
                                                    <th className="w-[190px] px-4 py-3.5 font-medium">操作</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {versionRecords.map((record) => (
                                                    <tr key={`${record.object}-${record.version}`} className="border-b border-[#f0f1f5] text-[12px] text-[#1d2129] last:border-b-0 hover:bg-[#fafbff]">
                                                        <td className="px-6 py-5 align-middle font-medium text-[#1c2745]">{record.object}</td>
                                                        <td className="px-4 py-5 align-middle">{record.version}</td>
                                                        <td className="px-4 py-5 align-middle">{record.description}</td>
                                                        <td className="px-4 py-5 align-middle">
                                                            <span className={`inline-flex rounded-[3px] px-2 py-1 text-[11px] ${VERSION_STATUS_STYLES[record.statusTone]}`}>{record.status}</span>
                                                        </td>
                                                        <td className="whitespace-nowrap px-4 py-5 align-middle">{record.creator}</td>
                                                        <td className="whitespace-nowrap px-4 py-5 align-middle text-[#4e5969]">{record.createdAt}</td>
                                                        <td className="px-4 py-5 align-middle">
                                                            <div className="flex items-center gap-6 whitespace-nowrap">
                                                                <button
                                                                    type="button"
                                                                    onClick={() => setToast(`查看 ${record.object} ${record.version} 版本差异`)}
                                                                    className="text-[#2f74ff] transition-colors hover:text-[#5c8fff]"
                                                                >
                                                                    查看差异
                                                                </button>
                                                                <button
                                                                    type="button"
                                                                    onClick={() => setToast(`查看 ${record.object} 的引用关系`)}
                                                                    className="text-[#2f74ff] transition-colors hover:text-[#5c8fff]"
                                                                >
                                                                    引用关系
                                                                </button>
                                                            </div>
                                                        </td>
                                                    </tr>
                                                ))}
                                                {versionRecords.length === 0 && (
                                                    <tr>
                                                        <td colSpan={7} className="px-6 py-20 text-center text-[13px] text-[#9ca4b7]">暂无版本记录，完成剧本解析后自动生成首个版本</td>
                                                    </tr>
                                                )}
                                            </tbody>
                                        </table>
                                    </div>
                                    <div className="flex h-[52px] items-center justify-end gap-2 border-t border-[#eef0f6] px-6">
                                        <button type="button" disabled aria-label="上一页" className="flex h-8 w-8 cursor-not-allowed items-center justify-center rounded-[4px] text-[#c9cdd4]">
                                            <ChevronLeft size={17} />
                                        </button>
                                        <button type="button" aria-current="page" className="flex h-8 min-w-8 items-center justify-center rounded-[4px] border border-[#4558dc] bg-white px-2 text-[12px] text-[#4558dc]">1</button>
                                        <button type="button" disabled aria-label="下一页" className="flex h-8 w-8 cursor-not-allowed items-center justify-center rounded-[4px] text-[#c9cdd4]">
                                            <ChevronRight size={17} />
                                        </button>
                                    </div>
                                </section>
                            </div>
                        ) : activeTab === 'reviews' ? (
                            <div className="mt-4 space-y-4">
                                <div className="flex flex-wrap items-start justify-between gap-4">
                                    <div>
                                        <h2 className="text-[18px] font-semibold text-[#1c2745]">审核记录</h2>
                                        <p className="mt-1 text-[12px] text-[#9ca4b7]">审核任务按管理员配置的部门与角色进入审核池，不由制作人员指定个人</p>
                                    </div>
                                    <button
                                        type="button"
                                        onClick={() => setToast('审核记录已导出')}
                                        className="h-8 rounded-[4px] border border-[#d9d9d9] bg-white px-4 text-[12px] text-[#1d2129] transition-colors hover:border-[#4558dc] hover:text-[#4558dc]"
                                    >
                                        导出审核记录
                                    </button>
                                </div>

                                <section className="overflow-hidden rounded-[10px] border border-[#e9ebf2] bg-white shadow-[0_2px_8px_rgba(33,43,83,0.03)]">
                                    <div className="overflow-x-auto">
                                        <table className="w-full min-w-[1120px] border-collapse text-left">
                                            <thead>
                                                <tr className="border-b border-[#eef0f6] bg-[#fafbfc] text-[12px] text-[#1d2129]">
                                                    <th className="w-[260px] px-6 py-3.5 font-medium">审核对象</th>
                                                    <th className="w-[100px] px-4 py-3.5 font-medium">版本</th>
                                                    <th className="w-[150px] px-4 py-3.5 font-medium">审核节点</th>
                                                    <th className="w-[280px] px-4 py-3.5 font-medium">责任范围</th>
                                                    <th className="w-[110px] px-4 py-3.5 font-medium">结果</th>
                                                    <th className="w-[120px] px-4 py-3.5 font-medium">提交人</th>
                                                    <th className="w-[150px] px-4 py-3.5 font-medium">时间</th>
                                                    <th className="w-[120px] px-4 py-3.5 font-medium">操作</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {reviewRecords.map((record) => (
                                                    <tr key={`${record.object}-${record.version}`} className="border-b border-[#f0f1f5] text-[12px] text-[#1d2129] last:border-b-0 hover:bg-[#fafbff]">
                                                        <td className="px-6 py-5 align-middle font-medium text-[#1c2745]">{record.object}</td>
                                                        <td className="px-4 py-5 align-middle">{record.version}</td>
                                                        <td className="px-4 py-5 align-middle">{record.node}</td>
                                                        <td className="px-4 py-5 align-middle">{record.scope}</td>
                                                        <td className="px-4 py-5 align-middle">
                                                            <span className={`inline-flex rounded-[3px] px-2 py-1 text-[11px] ${REVIEW_RESULT_STYLES[record.resultTone]}`}>{record.result}</span>
                                                        </td>
                                                        <td className="whitespace-nowrap px-4 py-5 align-middle">{record.submitter}</td>
                                                        <td className="whitespace-nowrap px-4 py-5 align-middle text-[#4e5969]">{record.createdAt}</td>
                                                        <td className="px-4 py-5 align-middle">
                                                            <button
                                                                type="button"
                                                                onClick={() => setToast(`查看 ${record.object} ${record.version} 审核详情`)}
                                                                className="whitespace-nowrap text-[#2f74ff] transition-colors hover:text-[#5c8fff]"
                                                            >
                                                                审核详情
                                                            </button>
                                                        </td>
                                                    </tr>
                                                ))}
                                                {reviewRecords.length === 0 && (
                                                    <tr>
                                                        <td colSpan={8} className="px-6 py-20 text-center text-[13px] text-[#9ca4b7]">暂无审核记录，分镜拆分后自动进入分镜审核池</td>
                                                    </tr>
                                                )}
                                            </tbody>
                                        </table>
                                    </div>
                                    <div className="flex h-[52px] items-center justify-end gap-2 border-t border-[#eef0f6] px-6">
                                        <button type="button" disabled aria-label="上一页" className="flex h-8 w-8 cursor-not-allowed items-center justify-center rounded-[4px] text-[#c9cdd4]">
                                            <ChevronLeft size={17} />
                                        </button>
                                        <button type="button" aria-current="page" className="flex h-8 min-w-8 items-center justify-center rounded-[4px] border border-[#4558dc] bg-white px-2 text-[12px] text-[#4558dc]">1</button>
                                        <button type="button" disabled aria-label="下一页" className="flex h-8 w-8 cursor-not-allowed items-center justify-center rounded-[4px] text-[#c9cdd4]">
                                            <ChevronRight size={17} />
                                        </button>
                                    </div>
                                </section>
                            </div>
                        ) : activeTab === 'settings' ? (
                            <div className="mt-4">
                                <section className="overflow-hidden rounded-[10px] border border-[#e9ebf2] bg-white shadow-[0_2px_8px_rgba(33,43,83,0.03)]">
                                    <div className="flex h-[62px] items-center border-b border-[#eef0f6] px-6">
                                        <h2 className="text-[16px] font-semibold text-[#1c2745]">项目基础设置</h2>
                                    </div>
                                    <div className="px-6 py-6">
                                        <div className="grid grid-cols-2 gap-x-10 gap-y-6 max-[760px]:grid-cols-1">
                                            <label className="block min-w-0">
                                                <span className="mb-2 block text-[12px] text-[#4e5969]">项目名称</span>
                                                <input
                                                    type="text"
                                                    value={settingsForm.name}
                                                    onChange={(event) => setSettingsField('name', event.target.value)}
                                                    disabled={!canEdit || loading}
                                                    placeholder="请输入项目名称"
                                                    className="project-detail-input h-[34px] w-full rounded-[6px] border border-transparent bg-[#f7f8fa] px-3 text-[13px] text-[#1d2129] outline-none transition-colors placeholder:text-[#c9cdd4] hover:bg-[#f2f3f7] focus:border-[#4558dc] focus:bg-white disabled:cursor-not-allowed disabled:text-[#86909c] disabled:hover:bg-[#f7f8fa]"
                                                />
                                            </label>
                                            {SETTINGS_OPTION_FIELDS.map((field) => {
                                                const disabled = field.disabled || !canEdit || loading;
                                                return (
                                                    <label key={field.key} className="block min-w-0">
                                                        <span className="mb-2 block text-[12px] text-[#4e5969]">{field.label}</span>
                                                        <span className="relative block">
                                                            <select
                                                                value={settingsForm[field.key]}
                                                                onChange={(event) => setSettingsField(field.key, event.target.value)}
                                                                disabled={disabled}
                                                                className="project-detail-input h-[34px] w-full appearance-none rounded-[6px] border border-transparent bg-[#f7f8fa] pl-3 pr-9 text-[13px] text-[#1d2129] outline-none transition-colors hover:bg-[#f2f3f7] focus:border-[#4558dc] focus:bg-white disabled:cursor-not-allowed disabled:text-[#86909c] disabled:hover:bg-[#f7f8fa]"
                                                            >
                                                                {withCurrentOption(field.options, settingsForm[field.key]).map((option) => (
                                                                    <option key={option} value={option}>{option}</option>
                                                                ))}
                                                            </select>
                                                            <ChevronDown
                                                                size={14}
                                                                className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[#c9cdd4]"
                                                            />
                                                        </span>
                                                    </label>
                                                );
                                            })}
                                        </div>

                                        {settingsError && (
                                            <p role="alert" className="mt-5 flex items-start gap-2 text-[12px] text-[#f04438]">
                                                <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                                                <span>{settingsError}</span>
                                            </p>
                                        )}

                                        <div className="mt-7 flex flex-wrap items-center gap-3">
                                            <button
                                                type="button"
                                                onClick={handleSaveSettings}
                                                disabled={!project || !canEdit || settingsSaving || loading}
                                                className="flex h-8 items-center justify-center gap-1.5 rounded-[6px] bg-[#4558dc] px-4 text-[13px] font-medium text-white transition-colors hover:bg-[#5c6fe4] disabled:cursor-not-allowed disabled:opacity-50"
                                            >
                                                {settingsSaving && <Loader2 size={14} className="project-detail-spinner" />}
                                                {settingsSaving ? '保存中…' : '保存设置'}
                                            </button>
                                            <button
                                                type="button"
                                                onClick={resetSettings}
                                                disabled={!canEdit || settingsSaving || loading}
                                                className="h-8 rounded-[6px] border border-[#d9d9d9] bg-white px-4 text-[13px] text-[#1d2129] transition-colors hover:border-[#4558dc] hover:text-[#4558dc] disabled:cursor-not-allowed disabled:opacity-50"
                                            >
                                                取消修改
                                            </button>
                                            {!canEdit && (
                                                <span className="text-[12px] text-[#9ca4b7]">当前角色仅可查看项目设置</span>
                                            )}
                                        </div>
                                        <div className="mt-[10px] flex min-h-[44px] items-center gap-3 rounded-[6px] border border-[#ffe58f] bg-[#fffbe6] px-4 py-2.5 text-[12px] text-[#6b5300]">
                                            <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-[#ff9f1c] text-[10px] font-bold leading-none text-white">!</span>
                                            <span>解绑剧目、删除项目、批量回滚属于高风险操作，需要主管审批并写入操作日志。</span>
                                        </div>
                                    </div>
                                </section>

                            </div>
                        ) : (
                            <section className="mt-4 flex min-h-[260px] items-center justify-center rounded-[10px] border border-[#e9ebf2] bg-white px-6 py-10 shadow-[0_2px_8px_rgba(33,43,83,0.03)]">
                                <div className="text-center">
                                    <div className="text-[15px] font-medium text-[#1d2129]">
                                        {DETAIL_TABS.find((tab) => tab.key === activeTab)?.label}功能暂未接入
                                    </div>
                                    <p className="mt-2 text-[12px] text-[#9ca4b7]">你可以在“项目概览”查看生产状态，或前往“项目设置”维护基础信息。</p>
                                </div>
                            </section>
                        )}
                    </div>
                </div>
            </main>

            {showChangeRequest && project && (
                <ChangeRequestModal
                    project={project}
                    onClose={() => setShowChangeRequest(false)}
                    onSubmit={handleSubmitRequest}
                />
            )}

            {toast && (
                <div className="fixed bottom-7 left-1/2 z-[120] -translate-x-1/2 rounded-md bg-[#1d2129] px-4 py-2.5 text-[13px] text-white shadow-[0_10px_30px_rgba(18,24,45,0.24)]">
                    {toast}
                </div>
            )}
        </div>
    );
};

export default ProjectDetailPage;
