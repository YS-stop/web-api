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
import { ChangeRequestModal } from './modals/ChangeRequestModal';

interface ProjectDetailPageProps {
    projectId: string;
    user: { name?: string; avatarUrl?: string; role?: string } | null;
    onBack: () => void;
    /** 进入画布：带上集号，画布直接定位到该集 */
    onEnterWorkflow?: (projectId: string, episode?: number) => void;
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

/** 详情页查看态使用静态演示数据，保证页面视觉与参考稿一致 */
const MOCK_PROJECT = {
    name: '长夜微光 AI 短剧制作',
    status: '制作中',
    summary: '长夜微光 · 真人短剧 · 锁定剧本 长夜微光·分集定稿 V3',
    code: 'XM-P-24091',
    owner: '林雪琪',
    department: '短剧制作部',
    updatedAt: '8分钟前',
    progress: 23,
};

const DETAIL_TABS: { key: DetailTabKey; label: string; count?: number; dot?: boolean }[] = [
    { key: 'overview', label: '项目概览' },
    { key: 'episodes', label: '分集管理', count: 80 },
    { key: 'assets', label: '项目资产' },
    { key: 'tasks', label: '生成任务', dot: true },
    { key: 'versions', label: '版本记录' },
    { key: 'reviews', label: '审核记录' },
    { key: 'settings', label: '项目设置' },
];

const FLOW_STEPS = [
    { title: '剧本锁定', detail: 'V3 已锁定', state: 'done', number: 1 },
    { title: '解析与资产', detail: '80 集已解析', state: 'done', number: 2 },
    { title: '分镜生产', detail: '24 集已完成', state: 'active', number: 3 },
    { title: '镜头视频', detail: '18 集生产中', state: 'active', number: 4 },
    { title: '整集成片', detail: '12 集已通过', state: 'pending', number: 5 },
] as const;

const FLOW_LINES = ['bg-[#a9e7bf]', 'bg-[#a9e7bf]', 'bg-[#d4d1fb]', 'bg-[#e8eaf1]'];

const PRODUCTION_STATS = [
    { label: '解析完成', value: '80 / 80 集' },
    { label: '分镜完成', value: '24 / 80 集' },
    { label: '视频完成', value: '18 / 80 集' },
    { label: '成片通过', value: '12 / 80 集' },
];

const PENDING_TASKS = [
    { title: '第04集分镜待复审', meta: '周主编 · 16分钟前', color: '#ff9f1c' },
    { title: '3个异常镜头待重试', meta: '系统任务 · 32分钟前', color: '#ff4d4f' },
    { title: '角色“陈远”待确认', meta: '资产审核 · 今天 09:42', color: '#1677ff' },
];

const RECENT_EPISODES = [
    { episode: '第 01 集', title: '雨夜重逢', stage: '镜头生成中', stageClass: 'bg-[#e8f2ff] text-[#2f74ff]', updated: '8分钟前' },
    { episode: '第 02 集', title: '被隐藏的来电', stage: '成片审核', stageClass: 'bg-[#f5eaff] text-[#8b5cf6]', updated: '今天 10:08' },
];

const ACTIVITIES = [
    { title: '第01集镜头18生成完成', meta: '火山引擎 · V2.10 · 8分钟前', color: '#2f6bff' },
    { title: '第04集分镜被退回', meta: '人物服装连续性需调整 · 18分钟前', color: '#f5a623' },
    { title: '第03集成片审核通过', meta: '周主编 · 昨天 18:42', color: '#00b42a' },
    { title: '剧本解析完成', meta: '共识别80集、642场 · 09-23 10:26', color: '#2f6bff' },
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

const EPISODE_STATS = [
    { label: '总集数', value: '80', color: 'text-[#1c2745]' },
    { label: '生产中', value: '26', color: 'text-[#ff7d00]' },
    { label: '待审核', value: '14', color: 'text-[#ff9f1c]' },
    { label: '已完成', value: '12', color: 'text-[#00b42a]' },
    { label: '异常镜头', value: '3', color: 'text-[#ff4d4f]' },
];

const EPISODE_STAGE_OPTIONS = ['全部阶段', '镜头生成中', '成片审核', '已完成', '分镜审核', '资产确认', '单集分析完成', '待初始化'];
const EPISODE_REVIEW_OPTIONS = ['全部审核状态', '分镜已通过', '待成片审核', '全部通过', '有修改意见', '待审核', '待确认', '未提交'];

const EMPTY_EPISODE_FILTERS: EpisodeFilters = {
    query: '',
    stage: '全部阶段',
    review: '全部审核状态',
};

const EPISODE_RECORDS: EpisodeRecord[] = [
    {
        id: '01',
        title: '雨夜重逢',
        detail: '2,646 字 · 01:32',
        assets: '5 / 8 / 12',
        assetKinds: '角色 / 场景 / 道具',
        storyboard: '24 / 24',
        video: '18 / 24 · 2异常',
        videoAlert: true,
        final: '待生成',
        finalTone: 'gray',
        stage: '镜头生成中',
        stageTone: 'blue',
        review: '分镜已通过',
        updated: '8分钟前',
    },
    {
        id: '02',
        title: '被隐藏的来电',
        detail: '2,630 字 · 01:26',
        assets: '4 / 6 / 9',
        assetKinds: '角色 / 场景 / 道具',
        storyboard: '22 / 22',
        video: '22 / 22',
        final: '待审核',
        finalTone: 'yellow',
        stage: '成片审核',
        stageTone: 'purple',
        review: '待成片审核',
        updated: '今天 10:08',
    },
    {
        id: '03',
        title: '身份裂缝',
        detail: '3,012 字 · 01:38',
        assets: '6 / 7 / 14',
        assetKinds: '角色 / 场景 / 道具',
        storyboard: '26 / 26',
        video: '26 / 26',
        final: '已完成',
        finalTone: 'green',
        stage: '已完成',
        stageTone: 'green',
        review: '全部通过',
        updated: '昨天 18:42',
    },
    {
        id: '04',
        title: '旧案线索',
        detail: '2,780 字 · 01:29',
        assets: '5 / 9 / 11',
        assetKinds: '角色 / 场景 / 道具',
        storyboard: '19 / 23',
        video: '0 / 23 · 1异常',
        videoAlert: true,
        final: '未开始',
        finalTone: 'gray',
        stage: '分镜审核',
        stageTone: 'orange',
        review: '有修改意见',
        updated: '昨天 16:18',
    },
    {
        id: '05',
        title: '交换条件',
        detail: '2,519 字 · 01:21',
        assets: '4 / 5 / 8',
        assetKinds: '角色 / 场景 / 道具',
        storyboard: '0 / 21',
        video: '0 / 21',
        final: '未开始',
        finalTone: 'gray',
        stage: '资产确认',
        stageTone: 'cyan',
        review: '待审核',
        updated: '09-23 14:20',
    },
    {
        id: '06',
        title: '追车',
        detail: '2,926 字 · 01:35',
        assets: '7 / 10 / 16',
        assetKinds: '角色 / 场景 / 道具',
        storyboard: '0 / 25',
        video: '0 / 25',
        final: '未开始',
        finalTone: 'gray',
        stage: '单集分析完成',
        stageTone: 'blue',
        review: '待确认',
        updated: '09-23 11:06',
    },
    {
        id: '07',
        title: '证人的谎言',
        detail: '2,712 字 · 01:28',
        assets: '5 / 8 / 10',
        assetKinds: '角色 / 场景 / 道具',
        storyboard: '0 / 22',
        video: '0 / 22',
        final: '未开始',
        finalTone: 'gray',
        stage: '待初始化',
        stageTone: 'gray',
        review: '未提交',
        updated: '09-22 18:30',
    },
];

type TaskStatusTone = 'blue' | 'yellow' | 'green';

interface GenerationTask {
    id: string;
    title: string;
    node: string;
    service: string;
    progress: number;
    status: string;
    statusTone: TaskStatusTone;
    cost: string;
    trigger: string;
    canRetry: boolean;
    abnormal: boolean;
}

const TASK_STATUS_STYLES: Record<TaskStatusTone, string> = {
    blue: 'bg-[#e8f2ff] text-[#2f74ff]',
    yellow: 'bg-[#fff7e8] text-[#d98100]',
    green: 'bg-[#e8ffea] text-[#00b42a]',
};

const GENERATION_TASKS: GenerationTask[] = [
    {
        id: 'TASK-98316',
        title: '第01集 · 镜头视频批量生成',
        node: '镜头视频',
        service: '火山引擎 Seedance',
        progress: 78,
        status: '运行中',
        statusTone: 'blue',
        cost: '¥36.20',
        trigger: '系统',
        canRetry: false,
        abnormal: false,
    },
    {
        id: 'TASK-98312',
        title: '第04集 · 分镜重生成',
        node: '分镜',
        service: '火山引擎',
        progress: 100,
        status: '待审核',
        statusTone: 'yellow',
        cost: '¥1.32',
        trigger: '林雪琪',
        canRetry: true,
        abnormal: false,
    },
    {
        id: 'TASK-98297',
        title: '全剧 · 角色资产解析',
        node: '项目资产',
        service: '剧情分析服务',
        progress: 100,
        status: '已完成',
        statusTone: 'green',
        cost: '¥18.60',
        trigger: '系统',
        canRetry: true,
        abnormal: false,
    },
];

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

const VERSION_RECORDS: VersionRecord[] = [
    {
        object: '第04集 · 镜头脚本',
        version: 'V6',
        description: '基于 V5 修改服装连续性',
        status: '当前使用',
        statusTone: 'green',
        creator: '林雪琪',
        createdAt: '今天 10:24',
    },
    {
        object: '角色 · 陈述',
        version: 'V3',
        description: '重新生成角色定妆',
        status: '待选用',
        statusTone: 'gray',
        creator: '江云天',
        createdAt: '今天 09:42',
    },
    {
        object: '第03集 · 整集成片',
        version: 'V4',
        description: '调整字幕和片尾',
        status: '当前使用',
        statusTone: 'green',
        creator: '林雪琪',
        createdAt: '昨天 18:42',
    },
    {
        object: '全剧剧本解析',
        version: 'V3',
        description: '确认最终拆集版本',
        status: '已锁定',
        statusTone: 'green',
        creator: '林雪琪',
        createdAt: '09-23 10:26',
    },
];

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

const REVIEW_RECORDS: ReviewRecord[] = [
    {
        object: '第04集 · 镜头脚本',
        version: 'V6',
        node: '分镜审核',
        scope: '内容制作部 / 分镜审核角色',
        result: '待复审',
        resultTone: 'yellow',
        submitter: '林雪琪',
        createdAt: '今天 10:24',
    },
    {
        object: '角色 · 陈述',
        version: 'V3',
        node: '资产审核',
        scope: '美术部 / 资产审核角色',
        result: '待审核',
        resultTone: 'yellow',
        submitter: '江云天',
        createdAt: '今天 09:42',
    },
    {
        object: '第03集 · 整集成片',
        version: 'V4',
        node: '成片审核',
        scope: '内容部 / 成片审核角色',
        result: '已通过',
        resultTone: 'green',
        submitter: '林雪琪',
        createdAt: '昨天 18:42',
    },
    {
        object: '全剧剧本解析',
        version: 'V3',
        node: '解析确认',
        scope: '内容部 / 剧本审核角色',
        result: '已通过',
        resultTone: 'green',
        submitter: '系统',
        createdAt: '09-23 10:26',
    },
];

type AssetStatusTone = 'green' | 'yellow';

interface SharedAsset {
    id: string;
    name: string;
    initial: string;
    role: string;
    referenceCount: number;
    meta: string;
    status: string;
    statusTone: AssetStatusTone;
    gradient: string;
}

const ASSET_STATUS_STYLES: Record<AssetStatusTone, string> = {
    green: 'text-[#00b42a]',
    yellow: 'text-[#d98100]',
};

const SHARED_ASSETS: SharedAsset[] = [
    {
        id: 'asset-linxia',
        name: '林夏',
        initial: '林',
        role: '女主角 · 18集引用',
        referenceCount: 18,
        meta: '当前版本 V2 · 项目内可复用 · 今日更新',
        status: '已通过',
        statusTone: 'green',
        gradient: 'linear-gradient(135deg, #34415e 0%, #52617e 100%)',
    },
    {
        id: 'asset-zhoucheng',
        name: '周承',
        initial: '周',
        role: '男主角 · 16集引用',
        referenceCount: 16,
        meta: '当前版本 V3 · 项目内可复用 · 今日更新',
        status: '已通过',
        statusTone: 'green',
        gradient: 'linear-gradient(135deg, #8c6d53 0%, #aa8569 100%)',
    },
    {
        id: 'asset-chenshu',
        name: '陈述',
        initial: '陈',
        role: '配角 · 9集引用',
        referenceCount: 9,
        meta: '当前版本 V4 · 项目内可复用 · 今日更新',
        status: '待审核',
        statusTone: 'yellow',
        gradient: 'linear-gradient(135deg, #4f686b 0%, #6b8584 100%)',
    },
    {
        id: 'asset-zhoumu',
        name: '周母',
        initial: '周',
        role: '配角 · 6集引用',
        referenceCount: 6,
        meta: '当前版本 V5 · 项目内可复用 · 今日更新',
        status: '已通过',
        statusTone: 'green',
        gradient: 'linear-gradient(135deg, #6a587a 0%, #8a7299 100%)',
    },
];

const ASSET_CATEGORIES = ['角色', '场景', '道具'];
const ASSET_STATUS_OPTIONS = ['全部审核状态', '已通过', '待审核'];
const ASSET_SORT_OPTIONS = ['最近更新', '引用最多', '名称排序'];

/** 项目详情子页面：视觉按参考稿重构，数据仅用于查看态静态展示 */
export const ProjectDetailPage: React.FC<ProjectDetailPageProps> = ({ projectId, user, onBack, onEnterWorkflow }) => {
    const [project, setProject] = useState<Project | null>(null);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState('');
    const [activeTab, setActiveTab] = useState<DetailTabKey>('episodes');
    const [settingsForm, setSettingsForm] = useState<SettingsForm>(() => ({ ...EMPTY_SETTINGS }));
    const [settingsSaving, setSettingsSaving] = useState(false);
    const [settingsError, setSettingsError] = useState('');
    const [episodeSearch, setEpisodeSearch] = useState('');
    const [episodeStageFilter, setEpisodeStageFilter] = useState('全部阶段');
    const [episodeReviewFilter, setEpisodeReviewFilter] = useState('全部审核状态');
    const [appliedEpisodeFilters, setAppliedEpisodeFilters] = useState<EpisodeFilters>(() => ({ ...EMPTY_EPISODE_FILTERS }));
    const [selectedEpisodes, setSelectedEpisodes] = useState<string[]>([]);
    const [tasksAbnormalOnly, setTasksAbnormalOnly] = useState(false);
    const [assetCategory, setAssetCategory] = useState('角色');
    const [assetSearch, setAssetSearch] = useState('');
    const [assetStatusFilter, setAssetStatusFilter] = useState('全部审核状态');
    const [assetSort, setAssetSort] = useState('最近更新');
    const [showChangeRequest, setShowChangeRequest] = useState(false);
    const [toast, setToast] = useState('');

    const canEdit = canEditProject(user?.role);
    const canRequest = canRequestChange(user?.role);

    const loadProject = async () => {
        setLoading(true);
        setLoadError('');
        setActiveTab('episodes');
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
        setActiveTab('episodes');
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
        onEnterWorkflow?.(projectId, episode);
    };

    const withCurrentOption = (options: string[], current: string): string[] =>
        current && !options.includes(current) ? [current, ...options] : options;

    /**
     * 分集列表：优先用项目真实的剧本解析结果。
     * 之前这里直接用写死的 EPISODE_RECORDS，导致点进项目看到的永远是
     * 演示的「第 01 集 雨夜重逢」，与该项目实际的分集对不上。
     */
    const episodeRecords = useMemo<EpisodeRecord[]>(() => {
        const list = project?.scriptAnalysis?.episodes || [];
        if (list.length === 0) return EPISODE_RECORDS;
        return list.map((ep) => {
            const assets = ep.assets;
            const countOf = (k: 'characters' | 'scenes' | 'props') => assets?.[k]?.length ?? 0;
            const chars = countOf('characters');
            const scenes = countOf('scenes');
            const props = countOf('props');
            const total = chars + scenes + props;
            const sec = Math.max(0, Math.round(ep.durationSeconds || 0));
            const mm = String(Math.floor(sec / 60)).padStart(2, '0');
            const ss = String(sec % 60).padStart(2, '0');
            return {
                id: String(ep.episode).padStart(2, '0'),
                title: ep.title || `第 ${ep.episode} 集`,
                detail: `${(ep.wordCount || 0).toLocaleString()} 字 · ${mm}:${ss}`,
                assets: total > 0 ? `${chars} / ${scenes} / ${props}` : '未识别',
                assetKinds: total > 0 ? '角色 / 场景 / 道具' : '待识别',
                storyboard: '—',
                video: '—',
                final: '未开始',
                finalTone: 'gray',
                stage: '待制作',
                stageTone: 'gray',
                review: '—',
                updated: ep.content ? '已切分' : '—',
            };
        });
    }, [project]);

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

    const visibleTasks = tasksAbnormalOnly
        ? GENERATION_TASKS.filter((task) => task.abnormal)
        : GENERATION_TASKS;

    const visibleAssets = SHARED_ASSETS
        .filter((asset) => assetCategory === '角色')
        .filter((asset) => assetStatusFilter === '全部审核状态' || asset.status === assetStatusFilter)
        .filter((asset) => {
            const keyword = assetSearch.trim().toLowerCase();
            return !keyword || `${asset.name} ${asset.role}`.toLowerCase().includes(keyword);
        })
        .sort((left, right) => {
            if (assetSort === '引用最多') return right.referenceCount - left.referenceCount;
            if (assetSort === '名称排序') return left.name.localeCompare(right.name, 'zh-CN');
            return 0;
        });

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
                            <h1 className="truncate text-[20px] font-semibold text-[#1c2745]">{MOCK_PROJECT.name}</h1>
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
                                进入工作流
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
                                            <h2 className="truncate text-[20px] font-semibold text-[#1c2745]">{MOCK_PROJECT.name}</h2>
                                            <span className="inline-flex shrink-0 items-center rounded bg-[#e8f2ff] px-2 py-0.5 text-[11px] text-[#2f6bff]">
                                                {MOCK_PROJECT.status}
                                            </span>
                                        </div>
                                        <p className="mt-1.5 text-[12px] text-[#7f889d]">{MOCK_PROJECT.summary}</p>
                                        <div className="mt-4 flex flex-wrap items-center gap-y-2 text-[12px] text-[#9ca4b7]">
                                            <span>项目编号 {MOCK_PROJECT.code}</span>
                                            <span className="mx-4 h-3 w-px bg-[#e5e7ef]" />
                                            <span>负责人 {MOCK_PROJECT.owner}</span>
                                            <span className="mx-4 h-3 w-px bg-[#e5e7ef]" />
                                            <span>{MOCK_PROJECT.department}</span>
                                            <span className="mx-4 h-3 w-px bg-[#e5e7ef]" />
                                            <span>最近更新 {MOCK_PROJECT.updatedAt}</span>
                                        </div>
                                    </div>
                                </div>

                                <div className="w-[270px] shrink-0">
                                    <div className="flex items-end justify-between text-[11px] text-[#9ca4b7]">
                                        <span>整剧进度</span>
                                        <strong className="text-[18px] font-semibold leading-none text-[#1c2745]">{MOCK_PROJECT.progress}%</strong>
                                    </div>
                                    <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-[#edf0f7]">
                                        <div className="h-full rounded-full bg-[linear-gradient(90deg,#5b56ee,#433bd9)]" style={{ width: `${MOCK_PROJECT.progress}%` }} />
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
                                    {'dot' in tab && tab.dot ? <span className="h-1.5 w-1.5 rounded-full bg-[#ff4d4f]" /> : null}
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
                                            {FLOW_STEPS.map((step, index) => (
                                                <React.Fragment key={step.title}>
                                                    {index > 0 && <div className={`mx-3 h-px min-w-[28px] flex-1 ${FLOW_LINES[index - 1]}`} />}
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
                                            {PRODUCTION_STATS.map((stat) => (
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
                                        <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-[#ff4d4f] px-1 text-[11px] font-medium text-white">5</span>
                                    </div>
                                    <div className="flex flex-1 flex-col px-6">
                                        {PENDING_TASKS.map((task) => (
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
                                                    {RECENT_EPISODES.map((episode) => (
                                                        <tr key={episode.episode} className="border-b border-[#f0f1f5] text-[13px] text-[#1d2129] last:border-b-0">
                                                            <td className="px-4 py-[17px] font-medium">{episode.episode}</td>
                                                            <td className="px-4 py-[17px]">{episode.title}</td>
                                                            <td className="px-4 py-[17px]">
                                                                <span className={`inline-flex rounded px-2 py-1 text-[11px] ${episode.stageClass}`}>{episode.stage}</span>
                                                            </td>
                                                            <td className="px-4 py-[17px]">{episode.updated}</td>
                                                            <td className="px-4 py-[17px]">
                                                                <button type="button" onClick={() => handleEnterWorkflow()} className="text-[#4558dc] transition-colors hover:text-[#6878e7]">进入画布</button>
                                                            </td>
                                                        </tr>
                                                    ))}
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
                                            {ACTIVITIES.map((activity) => (
                                                <div key={activity.title} className="flex items-start gap-3">
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
                                            className="h-8 cursor-not-allowed rounded-[4px] border border-[#e5e6eb] bg-[#f7f8fa] px-3 text-[12px] text-[#c9cdd4]"
                                        >
                                            批量初始化画布
                                        </button>
                                        <button
                                            type="button"
                                            disabled
                                            className="h-8 cursor-not-allowed rounded-[4px] border border-[#e5e6eb] bg-[#f7f8fa] px-3 text-[12px] text-[#c9cdd4]"
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
                                    {EPISODE_STATS.map((stat, index) => (
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
                                                        <td className="whitespace-nowrap px-4 py-4 align-middle">{episode.review}</td>
                                                        <td className="whitespace-nowrap px-4 py-4 align-middle text-[#4e5969]">{episode.updated}</td>
                                                        <td className="px-4 py-4 align-middle">
                                                            <div className="flex items-center gap-4 whitespace-nowrap">
                                                                <button type="button" onClick={() => handleEnterWorkflow(Number(episode.id))} className="text-[#2f74ff] transition-colors hover:text-[#5c8fff]">进入画布</button>
                                                                <button type="button" onClick={() => setToast(`查看第 ${episode.id} 集制作进度`)} className="text-[#2f74ff] transition-colors hover:text-[#5c8fff]">进度</button>
                                                                <button
                                                                    type="button"
                                                                    aria-label={`第 ${episode.id} 集更多操作`}
                                                                    onClick={() => setToast('更多操作暂未接入')}
                                                                    className="text-[#86909c] transition-colors hover:text-[#4558dc]"
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
                                        <h2 className="text-[18px] font-semibold text-[#1c2745]">项目共享资产</h2>
                                        <p className="mt-1 text-[12px] text-[#9ca4b7]">具备查看和复用权限即可直接引用；无权限时向管理员申请授权，不要求原创建者确认</p>
                                    </div>
                                    <div className="flex w-[132px] flex-col gap-2">
                                        <button
                                            type="button"
                                            onClick={() => setToast('已打开素材库选择入口')}
                                            className="h-8 rounded-[4px] border border-[#d9d9d9] bg-white px-3 text-[12px] text-[#1d2129] transition-colors hover:border-[#4558dc] hover:text-[#4558dc]"
                                        >
                                            从素材库选择
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => setToast('已打开外部素材上传入口')}
                                            className="flex h-8 items-center justify-center gap-1.5 rounded-[4px] border border-[#d9d9d9] bg-white px-3 text-[12px] text-[#1d2129] transition-colors hover:border-[#4558dc] hover:text-[#4558dc]"
                                        >
                                            <Upload size={13} />
                                            上传外部素材
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => setToast('已打开新建角色资产入口')}
                                            className="flex h-8 items-center justify-center gap-1.5 rounded-[4px] bg-[#4558dc] px-3 text-[12px] font-medium text-white transition-colors hover:bg-[#5c6fe4]"
                                        >
                                            <Plus size={14} />
                                            新建角色资产
                                        </button>
                                    </div>
                                </div>

                                <div className="flex flex-wrap items-center gap-2">
                                    <label className="relative block w-[132px]">
                                        <select
                                            value={assetCategory}
                                            onChange={(event) => setAssetCategory(event.target.value)}
                                            className="project-detail-input h-8 w-full appearance-none rounded-[4px] border border-transparent bg-[#f7f8fa] pl-3 pr-8 text-[12px] text-[#1d2129] outline-none transition-colors focus:border-[#4558dc] focus:bg-white"
                                        >
                                            {withCurrentOption(ASSET_CATEGORIES, assetCategory).map((option) => (
                                                <option key={option} value={option}>{option}</option>
                                            ))}
                                        </select>
                                        <ChevronDown size={13} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[#c9cdd4]" />
                                    </label>

                                    <label className="relative block w-[280px] max-w-full">
                                        <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[#86909c]" />
                                        <input
                                            type="search"
                                            value={assetSearch}
                                            onChange={(event) => setAssetSearch(event.target.value)}
                                            placeholder={`搜索${assetCategory}资产`}
                                            className="project-detail-input h-8 w-full rounded-[4px] border border-transparent bg-[#f7f8fa] pl-8 pr-3 text-[12px] text-[#1d2129] outline-none transition-colors placeholder:text-[#9ca4b7] focus:border-[#4558dc] focus:bg-white"
                                        />
                                    </label>

                                    <label className="relative block w-[136px]">
                                        <select
                                            value={assetStatusFilter}
                                            onChange={(event) => setAssetStatusFilter(event.target.value)}
                                            className="project-detail-input h-8 w-full appearance-none rounded-[4px] border border-transparent bg-[#f7f8fa] pl-3 pr-8 text-[12px] text-[#1d2129] outline-none transition-colors focus:border-[#4558dc] focus:bg-white"
                                        >
                                            {withCurrentOption(ASSET_STATUS_OPTIONS, assetStatusFilter).map((option) => (
                                                <option key={option} value={option}>{option}</option>
                                            ))}
                                        </select>
                                        <ChevronDown size={13} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[#c9cdd4]" />
                                    </label>

                                    <label className="relative block w-[164px]">
                                        <select
                                            value={assetSort}
                                            onChange={(event) => setAssetSort(event.target.value)}
                                            className="project-detail-input h-8 w-full appearance-none rounded-[4px] border border-transparent bg-[#f7f8fa] pl-3 pr-8 text-[12px] text-[#1d2129] outline-none transition-colors focus:border-[#4558dc] focus:bg-white"
                                        >
                                            {withCurrentOption(ASSET_SORT_OPTIONS, assetSort).map((option) => (
                                                <option key={option} value={option}>{option}</option>
                                            ))}
                                        </select>
                                        <ChevronDown size={13} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[#c9cdd4]" />
                                    </label>
                                </div>

                                <div className="grid grid-cols-4 gap-4 max-[1400px]:grid-cols-3 max-[1050px]:grid-cols-2 max-[720px]:grid-cols-1">
                                    {visibleAssets.map((asset) => (
                                        <article key={asset.id} className="flex min-w-0 flex-col overflow-hidden rounded-[10px] border border-[#e9ebf2] bg-white shadow-[0_2px_8px_rgba(33,43,83,0.03)]">
                                            <div className="relative h-[126px] shrink-0 overflow-hidden" style={{ background: asset.gradient }}>
                                                <span className="absolute left-4 top-3 select-none text-[32px] font-semibold leading-none text-white/90">{asset.initial}</span>
                                                <span className={`absolute right-3 top-3 inline-flex rounded-[3px] bg-white/95 px-2 py-1 text-[11px] shadow-sm ${ASSET_STATUS_STYLES[asset.statusTone]}`}>
                                                    {asset.status}
                                                </span>
                                            </div>
                                            <div className="flex flex-1 flex-col px-5 py-5">
                                                <h3 className="text-[16px] font-semibold text-[#1c2745]">{asset.name}</h3>
                                                <p className="mt-2 text-[13px] text-[#4e5969]">{asset.role}</p>
                                                <p className="mt-4 text-[11px] text-[#9ca4b7]">{asset.meta}</p>
                                            </div>
                                            <div className="grid grid-cols-2 divide-x divide-[#eef0f6] border-t border-[#eef0f6]">
                                                <button
                                                    type="button"
                                                    onClick={() => setToast(`查看 ${asset.name} 资产详情`)}
                                                    className="h-11 text-[12px] text-[#4e5969] transition-colors hover:bg-[#fafbff] hover:text-[#4558dc]"
                                                >
                                                    查看详情
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={() => setToast(`编辑 ${asset.name} 资产版本`)}
                                                    className="h-11 text-[12px] text-[#4e5969] transition-colors hover:bg-[#fafbff] hover:text-[#4558dc]"
                                                >
                                                    编辑版本
                                                </button>
                                            </div>
                                        </article>
                                    ))}
                                    {visibleAssets.length === 0 && (
                                        <div className="col-span-full flex min-h-[260px] items-center justify-center rounded-[10px] border border-[#e9ebf2] bg-white text-[13px] text-[#9ca4b7]">
                                            暂无匹配的{assetCategory}资产
                                        </div>
                                    )}
                                </div>
                            </div>
                        ) : activeTab === 'tasks' ? (
                            <div className="mt-4 space-y-4">
                                <div className="flex flex-wrap items-start justify-between gap-4">
                                    <div>
                                        <h2 className="text-[18px] font-semibold text-[#1c2745]">生成任务</h2>
                                        <p className="mt-1 text-[12px] text-[#9ca4b7]">统一查看解析、分镜、视频与成片任务，可重试失败节点</p>
                                    </div>
                                    <div className="flex w-[86px] flex-col gap-2">
                                        <button
                                            type="button"
                                            onClick={() => setToast('任务列表已刷新')}
                                            className="flex h-8 items-center justify-center gap-1.5 rounded-[4px] border border-[#d9d9d9] bg-white text-[12px] text-[#1d2129] transition-colors hover:border-[#4558dc] hover:text-[#4558dc]"
                                        >
                                            <RefreshCw size={13} />
                                            刷新
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => setTasksAbnormalOnly((current) => !current)}
                                            className={`h-8 rounded-[4px] border text-[12px] transition-colors ${tasksAbnormalOnly ? 'border-[#4558dc] bg-[#f5f6ff] text-[#4558dc]' : 'border-[#d9d9d9] bg-white text-[#1d2129] hover:border-[#4558dc] hover:text-[#4558dc]'}`}
                                        >
                                            仅看异常
                                        </button>
                                    </div>
                                </div>

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
                                                    <th className="w-[90px] px-4 py-4 font-medium">费用</th>
                                                    <th className="w-[100px] px-4 py-4 font-medium">触发人</th>
                                                    <th className="w-[130px] px-4 py-4 font-medium">操作</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {visibleTasks.map((task) => (
                                                    <tr key={task.id} className="border-b border-[#f0f1f5] text-[12px] text-[#1d2129] last:border-b-0 hover:bg-[#fafbff]">
                                                        <td className="px-6 py-6 align-middle">
                                                            <div className="text-[13px] font-medium text-[#1c2745]">{task.title}</div>
                                                            <div className="mt-1.5 text-[11px] text-[#9ca4b7]">{task.id}</div>
                                                        </td>
                                                        <td className="px-4 py-6 align-middle">{task.node}</td>
                                                        <td className="px-4 py-6 align-middle">{task.service}</td>
                                                        <td className="px-4 py-6 align-middle">
                                                            <div className="flex items-center gap-2">
                                                                <div className="relative h-1.5 w-[174px] rounded-full bg-[#edf0f7]">
                                                                    <div
                                                                        className={`h-full rounded-full ${task.progress >= 100 ? 'bg-[#5ac25f]' : 'bg-[#2f74ff]'}`}
                                                                        style={{ width: `${task.progress}%` }}
                                                                    />
                                                                    {task.progress >= 100 && (
                                                                        <span className="absolute -right-1 top-1/2 flex h-3.5 w-3.5 -translate-y-1/2 items-center justify-center rounded-full bg-[#5ac25f] text-white">
                                                                            <Check size={9} strokeWidth={3} />
                                                                        </span>
                                                                    )}
                                                                </div>
                                                                {task.progress < 100 && (
                                                                    <span className="text-[11px] text-[#4e5969]">{task.progress}%</span>
                                                                )}
                                                            </div>
                                                        </td>
                                                        <td className="px-4 py-6 align-middle">
                                                            <span className={`inline-flex rounded-[3px] px-2 py-1 text-[11px] ${TASK_STATUS_STYLES[task.statusTone]}`}>{task.status}</span>
                                                        </td>
                                                        <td className="whitespace-nowrap px-4 py-6 align-middle">{task.cost}</td>
                                                        <td className="whitespace-nowrap px-4 py-6 align-middle">{task.trigger}</td>
                                                        <td className="px-4 py-6 align-middle">
                                                            <div className="flex items-center gap-6 whitespace-nowrap">
                                                                <button type="button" onClick={() => setToast(`查看 ${task.id} 任务日志`)} className="text-[#2f74ff] transition-colors hover:text-[#5c8fff]">日志</button>
                                                                <button
                                                                    type="button"
                                                                    disabled={!task.canRetry}
                                                                    onClick={() => setToast(`已提交重试：${task.title}`)}
                                                                    className="text-[#2f74ff] transition-colors hover:text-[#5c8fff] disabled:cursor-not-allowed disabled:text-[#c9cdd4]"
                                                                >
                                                                    重试
                                                                </button>
                                                            </div>
                                                        </td>
                                                    </tr>
                                                ))}
                                                {visibleTasks.length === 0 && (
                                                    <tr>
                                                        <td colSpan={8} className="px-6 py-20 text-center text-[13px] text-[#9ca4b7]">暂无异常任务</td>
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
                                                {VERSION_RECORDS.map((record) => (
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
                                                {REVIEW_RECORDS.map((record) => (
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
