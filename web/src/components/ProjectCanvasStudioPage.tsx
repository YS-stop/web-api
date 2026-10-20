import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    AlertTriangle,
    ArrowLeft,
    Check,
    CheckCircle2,
    ChevronDown,
    ChevronLeft,
    ChevronRight,
    Circle,
    Clapperboard,
    Clock3,
    Copy,
    Ellipsis,
    FileText,
    Film,
    FolderOpen,
    Grid2X2,
    History,
    Image as ImageIcon,
    Layers3,
    LayoutTemplate,
    Library,
    ListChecks,
    Maximize2,
    MessageSquare,
    Minus,
    MonitorPlay,
    Music2,
    Plus,
    RefreshCw,
    Scan,
    Search,
    Send,
    Settings,
    Sparkles,
    Subtitles,
    Trash2,
    Type,
    Upload,
    UserRound,
    Users,
    Video,
    Wand2,
    X,
} from 'lucide-react';
import { fetchProject, Project } from '../services/projectService';

type StudioNodeTone = 'success' | 'warning' | 'info' | 'danger' | 'neutral';

interface ReviewComment {
    author: string;
    role: string;
    content: string;
    time: string;
}

interface StudioNode {
    id: string;
    section: string;
    title: string;
    meta: string;
    footer: string;
    status: string;
    tone: StudioNodeTone;
    stage: 1 | 2 | 3;
    x: number;
    y: number;
    service: string;
    prompt: string;
    scope: string;
    version: string;
    cost: string;
    comments: ReviewComment[];
}

interface StudioAsset {
    id: string;
    name: string;
    role: string;
    status: string;
    tone: StudioNodeTone;
    accent: string;
    category: 'characters' | 'scenes' | 'props';
    detail: string;
}

interface StudioTask {
    id: string;
    title: string;
    meta: string;
    progress: number;
    state: 'running' | 'queued' | 'done';
}

type AssetTab = StudioAsset['category'];
type DialogKey = 'script' | 'storyboard' | 'versions' | 'tasks' | 'shots' | 'review' | 'asset' | null;

const FALLBACK_PROJECT: Project = {
    id: 'demo-project',
    code: 'XM-P-24091',
    name: '长夜微光 AI 短剧制作',
    category: '2D精致韩漫',
    department: '短剧制作部',
    owner: '林雪琪',
    productionMode: '人工逐节点',
    aspectRatio: '9:16',
    targetDuration: 92,
    scriptSource: '原创剧本',
    scriptName: '长夜微光_第01集',
    dramaName: '长夜微光',
    totalEpisodes: 80,
    stage: '分镜与镜头',
    doneEpisodes: 18,
    abnormal: 0,
    status: '制作中',
    createdAt: '2026-10-12T09:00:00+08:00',
    updatedAt: '2026-10-20T10:24:00+08:00',
    createdBy: '林雪琪',
};

const STAGES = [
    { id: 1, label: '01 · 剧本与单集分析', accent: 'bg-[#6c5ce7]' },
    { id: 2, label: '02 · 项目资产与分镜', accent: 'bg-[#f59e0b]' },
    { id: 3, label: '03 · 声音字幕与成片', accent: 'bg-[#3b82f6]' },
] as const;

const INITIAL_NODES: StudioNode[] = [
    {
        id: 'script-input',
        section: '输入',
        title: '第 01 集剧本',
        meta: '共 12 场 · 2,440 字',
        footer: '无编辑任务',
        status: '已通过',
        tone: 'success',
        stage: 1,
        x: 40,
        y: 190,
        service: '系统默认 · 剧本解析适配器',
        prompt: '按场次拆分剧本，识别角色、场景、道具、对白和动作描述，并保留原文上下文。',
        scope: '制作部 / 当前项目',
        version: 'V6',
        cost: '¥0.00',
        comments: [],
    },
    {
        id: 'script-analysis',
        section: '剧本分析',
        title: '剧情单元与实体',
        meta: '剧情单元 9 · 引用资产 25',
        footer: '¥0.06',
        status: '已通过',
        tone: 'success',
        stage: 1,
        x: 236,
        y: 190,
        service: '系统默认 · 剧情分析适配器',
        prompt: '提炼本集剧情单元，标注人物动机、冲突、转场与需要复用的项目实体。',
        scope: '制作部 / 当前项目',
        version: 'V6',
        cost: '¥0.06',
        comments: [],
    },
    {
        id: 'character-assets',
        section: '项目资产',
        title: '角色资产',
        meta: '林夏 / 周承 / 陈远',
        footer: '¥0.00',
        status: '待审核',
        tone: 'warning',
        stage: 2,
        x: 456,
        y: 86,
        service: '系统默认 · 资产解析适配器',
        prompt: '锁定角色造型与视觉特征，保持全剧人物一致性。角色“陈远”仍需完成资产确认。',
        scope: '制作部 / 当前项目',
        version: 'V6',
        cost: '¥0.00',
        comments: [
            {
                author: '内容制作部',
                role: '审核角色',
                content: '角色“陈远”的造型参考尚未确认，请先完成资产门禁后再生成下游视频。',
                time: '今天 09:48',
            },
        ],
    },
    {
        id: 'scene-assets',
        section: '项目资产',
        title: '场景与道具',
        meta: '雨夜街道 / 公寓 / 手机',
        footer: '¥0.00',
        status: '已通过',
        tone: 'success',
        stage: 2,
        x: 456,
        y: 280,
        service: '系统默认 · 资产解析适配器',
        prompt: '统一场景光线、空间关系和关键道具外观，确保镜头之间连续。',
        scope: '制作部 / 当前项目',
        version: 'V6',
        cost: '¥0.00',
        comments: [],
    },
    {
        id: 'shot-script',
        section: '分镜',
        title: '镜头脚本',
        meta: '24 个镜头 · 预计 92 秒',
        footer: '¥1.32',
        status: '待审核',
        tone: 'warning',
        stage: 2,
        x: 652,
        y: 190,
        service: '系统默认 · 分镜生成适配器',
        prompt: '按竖屏短剧节奏拆分镜头，控制单镜时长，并补全景别、机位、动作与声音提示。',
        scope: '制作部 / 当前项目',
        version: 'V6',
        cost: '¥1.32',
        comments: [
            {
                author: '内容制作部',
                role: '审核角色',
                content: '请复核镜头 19 与镜头 20 的跳切节奏，避免人物视线方向不连续。',
                time: '今天 10:02',
            },
        ],
    },
    {
        id: 'shot-video',
        section: '视频生成',
        title: '镜头视频',
        meta: '18 / 24 已生成 · 3 个候选',
        footer: '¥96.20',
        status: '生成中',
        tone: 'info',
        stage: 2,
        x: 846,
        y: 190,
        service: '系统默认 · 火山引擎适配器',
        prompt: '雨夜街道，女主撑伞回头，情绪压抑，电影感光影，竖屏构图。保持角色造型与镜头脚本一致。',
        scope: '制作部 / 当前项目',
        version: 'V6',
        cost: '¥96.20',
        comments: [],
    },
    {
        id: 'audio-assets',
        section: '声音',
        title: '配音与音频',
        meta: '对白 21 条 · 环境声 4 条',
        footer: '¥1.32',
        status: '待审核',
        tone: 'warning',
        stage: 3,
        x: 1040,
        y: 86,
        service: '系统默认 · 火山引擎适配器',
        prompt: '根据角色声线生成对白，叠加雨夜街道环境声，并保留可编辑的音轨分层。',
        scope: '制作部 / 当前项目',
        version: 'V6',
        cost: '¥1.32',
        comments: [],
    },
    {
        id: 'subtitle-timeline',
        section: '字幕',
        title: '字幕与时间轴',
        meta: '对白已对齐 · 2 处待确认',
        footer: '¥0.60',
        status: '输入已变化',
        tone: 'danger',
        stage: 3,
        x: 1040,
        y: 280,
        service: '系统默认 · 火山引擎适配器',
        prompt: '雨夜城市街道，女主撑伞回头，情绪压抑，电影感光影，竖屏构图。',
        scope: '制作部 / 当前项目',
        version: 'V6',
        cost: '¥0.60',
        comments: [
            {
                author: '内容制作部',
                role: '审核角色',
                content: '上游镜头版本发生变化，请重新校验字幕时间轴。',
                time: '今天 10:24',
            },
        ],
    },
];

const ASSETS: StudioAsset[] = [
    {
        id: 'lin-xia',
        name: '林夏',
        role: '女主角 · 已审核',
        status: '已审核',
        tone: 'success',
        accent: 'from-[#b98a9f] via-[#d7b5c0] to-[#6d4d5b]',
        category: 'characters',
        detail: '长发，米色风衣，情绪克制。全剧造型已锁定。',
    },
    {
        id: 'zhou-cheng',
        name: '周承',
        role: '男主角 · 已审核',
        status: '已审核',
        tone: 'success',
        accent: 'from-[#6e8da2] via-[#9db1c1] to-[#42576a]',
        category: 'characters',
        detail: '短外套，冷峻气质，夜间场景为主。全剧造型已锁定。',
    },
    {
        id: 'chen-yuan',
        name: '陈远',
        role: '配角 · 待审核',
        status: '待审核',
        tone: 'warning',
        accent: 'from-[#92a0a4] via-[#b9b4a8] to-[#6c7068]',
        category: 'characters',
        detail: '灰色夹克，沉默寡言。造型参考尚未完成最终确认。',
    },
    {
        id: 'rain-street',
        name: '雨夜街道',
        role: '主场景 · 已审核',
        status: '已审核',
        tone: 'success',
        accent: 'from-[#33445f] via-[#64748b] to-[#111827]',
        category: 'scenes',
        detail: '湿滑路面、霓虹反光、低照度电影感街景。',
    },
    {
        id: 'apartment',
        name: '公寓',
        role: '内景 · 已审核',
        status: '已审核',
        tone: 'success',
        accent: 'from-[#b99e7a] via-[#d8c7a8] to-[#6d5943]',
        category: 'scenes',
        detail: '暖色室内光，凌乱桌面，窗外持续下雨。',
    },
    {
        id: 'phone',
        name: '手机',
        role: '关键道具 · 已审核',
        status: '已审核',
        tone: 'success',
        accent: 'from-[#64748b] via-[#94a3b8] to-[#1e293b]',
        category: 'props',
        detail: '黑色直板手机，屏幕裂痕，作为第 19 镜的关键线索。',
    },
];

const FLOW_NAV = [
    { id: '01', label: '第 01 集剧本', target: 'script-input', tone: 'success' },
    { id: '02', label: '剧情单元与实体', target: 'script-analysis', tone: 'success' },
    { id: '03', label: '角色资产', target: 'character-assets', tone: 'warning' },
    { id: '04', label: '场景与道具', target: 'scene-assets', tone: 'success' },
    { id: '05', label: '镜头脚本', target: 'shot-script', tone: 'warning' },
    { id: '06', label: '镜头视频', target: 'shot-video', tone: 'info' },
    { id: '07', label: '配音与音频', target: 'audio-assets', tone: 'warning' },
    { id: '08', label: '字幕与时间轴', target: 'subtitle-timeline', tone: 'danger' },
    { id: '09', label: '字幕校对', target: 'subtitle-timeline', tone: 'neutral' },
    { id: '10', label: '本集成片', target: 'shot-video', tone: 'neutral' },
] as const;

const TASKS: StudioTask[] = [
    { id: 'task-1', title: '镜头 18 · 雨夜回头', meta: '火山引擎适配器 · 预计剩余 42 秒', progress: 78, state: 'running' },
    { id: 'task-2', title: '镜头 19 · 手机特写', meta: '统一任务队列 · 排队中', progress: 12, state: 'queued' },
    { id: 'task-3', title: '镜头 17 · 走出公寓', meta: '已完成 · ¥2.10', progress: 100, state: 'done' },
];

const STORYBOARD_SHOTS = [
    { no: '17', title: '走出公寓', camera: '中景 / 跟拍', duration: '4.2s' },
    { no: '18', title: '雨夜回头', camera: '近景 / 慢推', duration: '3.8s' },
    { no: '19', title: '手机特写', camera: '特写 / 固定', duration: '2.6s' },
    { no: '20', title: '霓虹倒影', camera: '空镜 / 下摇', duration: '3.1s' },
    { no: '21', title: '沉默对视', camera: '双人近景', duration: '5.0s' },
];

const TONE_STYLES: Record<StudioNodeTone, string> = {
    success: 'bg-[#eaf8ef] text-[#22a55a]',
    warning: 'bg-[#fff7df] text-[#e69a13]',
    info: 'bg-[#eaf2ff] text-[#2f74ff]',
    danger: 'bg-[#fff0f0] text-[#f04444]',
    neutral: 'bg-[#f1f3f7] text-[#8a94a6]',
};

const DOT_STYLES: Record<string, string> = {
    success: 'bg-[#22c55e]',
    warning: 'bg-[#f59e0b]',
    info: 'bg-[#3b82f6]',
    danger: 'bg-[#ef4444]',
    neutral: 'bg-[#c8ceda]',
};

const CANVAS_WIDTH = 1260;
const CANVAS_HEIGHT = 520;

const NODE_ICONS: Record<string, React.ComponentType<{ size?: number; className?: string; strokeWidth?: number }>> = {
    'script-input': FileText,
    'script-analysis': Wand2,
    'character-assets': UserRound,
    'scene-assets': ImageIcon,
    'shot-script': Clapperboard,
    'shot-video': Video,
    'audio-assets': Music2,
    'subtitle-timeline': Subtitles,
};

type ConnectorSide = 'top' | 'right' | 'bottom' | 'left';

interface ConnectorEdge {
    id: string;
    from: string;
    to: string;
    fromSide: ConnectorSide;
    toSide: ConnectorSide;
}

const CONNECTOR_SIDES: ConnectorSide[] = ['top', 'right', 'bottom', 'left'];
const isConnectorSide = (value: string | undefined): value is ConnectorSide => (
    value === 'top' || value === 'right' || value === 'bottom' || value === 'left'
);

const INITIAL_CONNECTOR_EDGES: ConnectorEdge[] = [
    { id: 'input-analysis', from: 'script-input', to: 'script-analysis', fromSide: 'right', toSide: 'left' },
    { id: 'analysis-character', from: 'script-analysis', to: 'character-assets', fromSide: 'right', toSide: 'left' },
    { id: 'analysis-scene', from: 'script-analysis', to: 'scene-assets', fromSide: 'right', toSide: 'left' },
    { id: 'character-shot', from: 'character-assets', to: 'shot-script', fromSide: 'right', toSide: 'left' },
    { id: 'scene-shot', from: 'scene-assets', to: 'shot-script', fromSide: 'right', toSide: 'left' },
    { id: 'shot-video', from: 'shot-script', to: 'shot-video', fromSide: 'right', toSide: 'left' },
    { id: 'video-audio', from: 'shot-video', to: 'audio-assets', fromSide: 'right', toSide: 'left' },
    { id: 'video-subtitle', from: 'shot-video', to: 'subtitle-timeline', fromSide: 'right', toSide: 'left' },
];

const NODE_WIDTH = 176;
const NODE_HEIGHT = 110;

const SIDE_NORMALS: Record<ConnectorSide, [number, number]> = {
    top: [0, -1],
    right: [1, 0],
    bottom: [0, 1],
    left: [-1, 0],
};

const getConnectorAnchor = (x: number, y: number, side: ConnectorSide) => {
    if (side === 'top') return { x: x + NODE_WIDTH / 2, y };
    if (side === 'right') return { x: x + NODE_WIDTH, y: y + NODE_HEIGHT / 2 };
    if (side === 'bottom') return { x: x + NODE_WIDTH / 2, y: y + NODE_HEIGHT };
    return { x, y: y + NODE_HEIGHT / 2 };
};

const buildConnectorPath = (
    fromX: number,
    fromY: number,
    fromSide: ConnectorSide,
    toX: number,
    toY: number,
    toSide: ConnectorSide,
): string => {
    const start = getConnectorAnchor(fromX, fromY, fromSide);
    const end = getConnectorAnchor(toX, toY, toSide);
    const dx = end.x - start.x;
    const dy = end.y - start.y;

    if (Math.abs(dy) < 0.5 && fromSide === 'right' && toSide === 'left' && dx >= 0) {
        return `M${start.x} ${start.y} H${end.x}`;
    }
    if (Math.abs(dy) < 0.5 && fromSide === 'left' && toSide === 'right' && dx <= 0) {
        return `M${start.x} ${start.y} H${end.x}`;
    }
    if (Math.abs(dx) < 0.5 && fromSide === 'bottom' && toSide === 'top' && dy >= 0) {
        return `M${start.x} ${start.y} V${end.y}`;
    }
    if (Math.abs(dx) < 0.5 && fromSide === 'top' && toSide === 'bottom' && dy <= 0) {
        return `M${start.x} ${start.y} V${end.y}`;
    }

    const distance = Math.max(34, Math.min(130, Math.hypot(dx, dy) * 0.38));
    const [fromNormalX, fromNormalY] = SIDE_NORMALS[fromSide];
    const [toNormalX, toNormalY] = SIDE_NORMALS[toSide];
    const control1X = start.x + fromNormalX * distance;
    const control1Y = start.y + fromNormalY * distance;
    const control2X = end.x + toNormalX * distance;
    const control2Y = end.y + toNormalY * distance;
    return `M${start.x} ${start.y} C${control1X} ${control1Y} ${control2X} ${control2Y} ${end.x} ${end.y}`;
};

const getFacingSide = (dx: number, dy: number): ConnectorSide => {
    if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'left' : 'right';
    return dy >= 0 ? 'top' : 'bottom';
};

const buildConnectionPreviewPath = (
    fromX: number,
    fromY: number,
    fromSide: ConnectorSide,
    toX: number,
    toY: number,
): string => {
    const start = getConnectorAnchor(fromX, fromY, fromSide);
    const dx = toX - start.x;
    const dy = toY - start.y;
    const endSide = getFacingSide(dx, dy);
    const distance = Math.max(30, Math.min(110, Math.hypot(dx, dy) * 0.36));
    const [fromNormalX, fromNormalY] = SIDE_NORMALS[fromSide];
    const [toNormalX, toNormalY] = SIDE_NORMALS[endSide];
    return `M${start.x} ${start.y} C${start.x + fromNormalX * distance} ${start.y + fromNormalY * distance} ${toX + toNormalX * distance} ${toY + toNormalY * distance} ${toX} ${toY}`;
};

interface StudioNodeCardProps {
    node: StudioNode;
    selected: boolean;
    dimmed: boolean;
    connectionTargetSide: ConnectorSide | null;
    onSelect: (nodeId: string) => void;
    onPointerDown: (nodeId: string, event: React.PointerEvent<HTMLButtonElement>) => void;
    onPointerMove: (event: React.PointerEvent<HTMLButtonElement>) => void;
    onPointerUp: (event: React.PointerEvent<HTMLButtonElement>) => void;
    onConnectionPointerDown: (nodeId: string, side: ConnectorSide, event: React.PointerEvent<HTMLSpanElement>) => void;
    onConnectionPointerMove: (event: React.PointerEvent<HTMLSpanElement>) => void;
    onConnectionPointerUp: (event: React.PointerEvent<HTMLSpanElement>) => void;
}

const StudioNodeCard = memo(({
    node,
    selected,
    dimmed,
    connectionTargetSide,
    onSelect,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onConnectionPointerDown,
    onConnectionPointerMove,
    onConnectionPointerUp,
}: StudioNodeCardProps) => {
    const Icon = NODE_ICONS[node.id] || Circle;
    const stage = STAGES.find((item) => item.id === node.stage)!;
    const sideLabels: Record<ConnectorSide, string> = { top: '上', right: '右', bottom: '下', left: '左' };
    const sidePositions: Record<ConnectorSide, string> = {
        top: 'left-1/2 top-0 -translate-x-1/2 -translate-y-1/2',
        right: 'right-0 top-1/2 translate-x-1/2 -translate-y-1/2',
        bottom: 'left-1/2 bottom-0 -translate-x-1/2 translate-y-1/2',
        left: 'left-0 top-1/2 -translate-x-1/2 -translate-y-1/2',
    };
    return (
        <button
            type="button"
            data-canvas-node-id={node.id}
            onClick={() => onSelect(node.id)}
            onPointerDown={(event) => onPointerDown(node.id, event)}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            className={`studio-node-card group absolute w-[176px] h-[110px] rounded-[6px] border bg-white text-left overflow-visible cursor-grab active:cursor-grabbing transition-[border-color,box-shadow] ${dimmed ? 'opacity-35' : 'opacity-100'} ${connectionTargetSide ? 'border-[#6a6af8] ring-2 ring-[#6a6af8]/20 z-20' : selected ? 'border-[#6a6af8] shadow-[0_0_0_2px_rgba(106,106,248,.14),0_8px_20px_rgba(50,58,90,.10)] z-10' : 'border-[#e2e6ef] shadow-[0_2px_5px_rgba(25,34,58,.06)] hover:shadow-[0_7px_16px_rgba(25,34,58,.10)]'}`}
            style={{ left: node.x, top: node.y, touchAction: 'none' }}
        >
            <span className={`absolute left-0 right-0 top-0 h-[3px] ${stage.accent}`} />
            <span className={`absolute right-2 top-2 h-[16px] px-1.5 rounded-[3px] text-[8px] leading-[16px] font-medium ${TONE_STYLES[node.tone]}`}>
                {node.status}
            </span>
            <span className="block px-2.5 pt-2.5 text-[8px] text-[#9da5b5]">{node.section}</span>
            <span className="mt-0.5 block px-2.5 text-[12px] font-semibold text-[#343b4d] truncate" title={node.title}>{node.title}</span>
            <span className="mt-1 block px-2.5 text-[8.5px] text-[#929aab]">{node.meta}</span>
            <span className="mt-1 block px-2.5 text-[8px] text-[#abafbb]">{node.footer}</span>
            <span className={`absolute bottom-2 right-2 w-5 h-5 rounded-full flex items-center justify-center ${selected ? 'bg-[#5b5bf6] text-white' : 'bg-[#eef1f8] text-[#7b86a3]'}`}>
                <Icon size={11} strokeWidth={1.9} />
            </span>
            {CONNECTOR_SIDES.map((side) => {
                const isTarget = connectionTargetSide === side;
                return (
                    <span
                        key={side}
                        data-connection-side={side}
                        title={`从${sideLabels[side]}侧连接节点`}
                        onClick={(event) => event.stopPropagation()}
                        onPointerDown={(event) => onConnectionPointerDown(node.id, side, event)}
                        onPointerMove={onConnectionPointerMove}
                        onPointerUp={onConnectionPointerUp}
                        onPointerCancel={onConnectionPointerUp}
                        className={`absolute z-20 w-5 h-5 flex items-center justify-center cursor-crosshair transition-opacity ${sidePositions[side]} ${selected || isTarget ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
                    >
                        <span className={`w-2 h-2 rounded-full border transition-all ${isTarget ? 'bg-[#5b5bf6] border-[#5b5bf6] scale-150' : selected ? 'bg-white border-[#6a6af8]' : 'bg-white border-[#aeb7c9]'}`} />
                    </span>
                );
            })}
        </button>
    );
}, (prev, next) => (
    prev.node === next.node
    && prev.selected === next.selected
    && prev.dimmed === next.dimmed
    && prev.connectionTargetSide === next.connectionTargetSide
    && prev.onSelect === next.onSelect
    && prev.onPointerDown === next.onPointerDown
    && prev.onPointerMove === next.onPointerMove
    && prev.onPointerUp === next.onPointerUp
    && prev.onConnectionPointerDown === next.onConnectionPointerDown
    && prev.onConnectionPointerMove === next.onConnectionPointerMove
    && prev.onConnectionPointerUp === next.onConnectionPointerUp
));

interface ProjectCanvasStudioPageProps {
    projectId: string;
    onBack: () => void;
}

export const ProjectCanvasStudioPage: React.FC<ProjectCanvasStudioPageProps> = ({ projectId, onBack }) => {
    const [project, setProject] = useState<Project>({ ...FALLBACK_PROJECT, id: projectId });
    const [episodeNo, setEpisodeNo] = useState(1);
    const [mode, setMode] = useState<'auto' | 'manual'>('manual');
    const [nodes, setNodes] = useState<StudioNode[]>(INITIAL_NODES);
    const [connectorEdges, setConnectorEdges] = useState<ConnectorEdge[]>(INITIAL_CONNECTOR_EDGES);
    const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
    const [connectionDraft, setConnectionDraft] = useState<{ nodeId: string; side: ConnectorSide } | null>(null);
    const [connectionTarget, setConnectionTarget] = useState<{ nodeId: string; side: ConnectorSide } | null>(null);
    const [activeStage, setActiveStage] = useState<number | null>(null);
    const [assetTab, setAssetTab] = useState<AssetTab>('characters');
    const [assetSearch, setAssetSearch] = useState('');
    const [assets, setAssets] = useState<StudioAsset[]>(ASSETS);
    const [selectedAssetId, setSelectedAssetId] = useState('lin-xia');
    const [assetsCollapsed, setAssetsCollapsed] = useState(false);
    const [zoom, setZoom] = useState(72);
    const [gridVisible, setGridVisible] = useState(true);
    const [canvasOffset, setCanvasOffset] = useState({ x: 0, y: 0 });
    const [isPanning, setIsPanning] = useState(false);
    const [dialog, setDialog] = useState<DialogKey>(null);
    const [toast, setToast] = useState('');
    const [commentDraft, setCommentDraft] = useState('');
    const [commentComposerOpen, setCommentComposerOpen] = useState(false);
    const [warningDismissed, setWarningDismissed] = useState(false);
    const [activeTaskId, setActiveTaskId] = useState<string | null>('task-1');
    const toastTimer = useRef<number | null>(null);
    const regenerateTimer = useRef<number | null>(null);
    const canvasViewportRef = useRef<HTMLDivElement | null>(null);
    const canvasContentRef = useRef<HTMLDivElement | null>(null);
    const canvasOffsetRef = useRef({ x: 0, y: 0 });
    const pendingCanvasOffsetRef = useRef({ x: 0, y: 0 });
    const panFrameRef = useRef<number | null>(null);
    const connectorPathRefs = useRef(new Map<string, SVGPathElement>());
    const connectorRefCallbacks = useRef(new Map<string, (element: SVGPathElement | null) => void>());
    const connectionPreviewRef = useRef<SVGPathElement | null>(null);
    const connectionTargetRef = useRef<{ nodeId: string; side: ConnectorSide } | null>(null);
    const connectionDragRef = useRef({
        active: false,
        pointerId: -1,
        fromNodeId: '',
        fromSide: 'right' as ConnectorSide,
        element: null as HTMLSpanElement | null,
    });
    const nodeDragRef = useRef({
        active: false,
        dragging: false,
        pointerId: -1,
        nodeId: '',
        startX: 0,
        startY: 0,
        originX: 0,
        originY: 0,
        currentX: 0,
        currentY: 0,
        element: null as HTMLButtonElement | null,
        connectedEdges: [] as ConnectorEdge[],
    });
    const nodesRef = useRef(nodes);
    nodesRef.current = nodes;
    const connectorEdgesRef = useRef(connectorEdges);
    connectorEdgesRef.current = connectorEdges;
    const zoomRef = useRef(zoom);
    zoomRef.current = zoom;
    const panGestureRef = useRef({
        pressed: false,
        dragging: false,
        pointerId: -1,
        startX: 0,
        startY: 0,
        originX: 0,
        originY: 0,
        holdTimer: null as number | null,
    });

    const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
    const nodeByIdRef = useRef(nodeById);
    nodeByIdRef.current = nodeById;
    const selectedNode = (selectedNodeId ? nodeById.get(selectedNodeId) : undefined) || nodes[0];
    const hasSelectedNode = Boolean(selectedNodeId && nodeById.has(selectedNodeId));
    const canDeleteNode = hasSelectedNode && nodes.length > 1;
    const selectedAsset = assets.find((asset) => asset.id === selectedAssetId) || assets[0];

    const getConnectorPathRef = useCallback((edgeId: string) => {
        let callback = connectorRefCallbacks.current.get(edgeId);
        if (!callback) {
            callback = (element) => {
                if (element) connectorPathRefs.current.set(edgeId, element);
                else connectorPathRefs.current.delete(edgeId);
            };
            connectorRefCallbacks.current.set(edgeId, callback);
        }
        return callback;
    }, []);

    const filteredAssets = useMemo(() => {
        const keyword = assetSearch.trim().toLowerCase();
        return assets.filter((asset) => {
            const matchesTab = asset.category === assetTab;
            const matchesKeyword = !keyword || `${asset.name}${asset.role}${asset.detail}`.toLowerCase().includes(keyword);
            return matchesTab && matchesKeyword;
        });
    }, [assets, assetTab, assetSearch]);

    useEffect(() => {
        let cancelled = false;
        fetchProject(projectId)
            .then((data) => {
                if (!cancelled) {
                    setProject({ ...FALLBACK_PROJECT, ...data, id: projectId });
                    if (data.productionMode === '全自动' || data.productionMode === '人工逐节点') {
                        setMode(data.productionMode === '全自动' ? 'auto' : 'manual');
                    }
                }
            })
            .catch(() => {
                // 静态演示页：接口不可用时继续使用内置项目数据。
            });
        return () => {
            cancelled = true;
        };
    }, [projectId]);

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') setDialog(null);
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, []);

    useEffect(() => () => {
        if (toastTimer.current) window.clearTimeout(toastTimer.current);
        if (regenerateTimer.current) window.clearTimeout(regenerateTimer.current);
        if (panGestureRef.current.holdTimer) window.clearTimeout(panGestureRef.current.holdTimer);
        if (panFrameRef.current !== null) window.cancelAnimationFrame(panFrameRef.current);
    }, []);

    const showToast = useCallback((message: string) => {
        setToast(message);
        if (toastTimer.current) window.clearTimeout(toastTimer.current);
        toastTimer.current = window.setTimeout(() => setToast(''), 2600);
    }, []);

    const updateSelectedNode = (patch: Partial<StudioNode>) => {
        if (!selectedNodeId) return;
        setNodes((prev) => prev.map((node) => node.id === selectedNodeId ? { ...node, ...patch } : node));
    };

    const selectNode = useCallback((nodeId: string) => {
        const target = nodesRef.current.find((node) => node.id === nodeId);
        if (!target) return;
        setSelectedNodeId(nodeId);
        setActiveStage(target.stage);
        setCommentComposerOpen(false);
        setCommentDraft('');
    }, []);

    const getCanvasPoint = useCallback((clientX: number, clientY: number) => {
        const rect = canvasContentRef.current?.getBoundingClientRect();
        const scale = zoomRef.current / 100;
        if (!rect || !scale) return null;
        return { x: (clientX - rect.left) / scale, y: (clientY - rect.top) / scale };
    }, []);

    const resolveConnectionTarget = useCallback((clientX: number, clientY: number, fromNodeId: string) => {
        const pointedElement = document.elementFromPoint(clientX, clientY);
        const nodeElement = pointedElement?.closest<HTMLElement>('[data-canvas-node-id]');
        const nodeId = nodeElement?.dataset.canvasNodeId;
        if (!nodeElement || !nodeId || nodeId === fromNodeId) return null;

        const sideElement = pointedElement?.closest<HTMLElement>('[data-connection-side]');
        const pointedSide = sideElement?.dataset.connectionSide;
        let side: ConnectorSide;
        if (isConnectorSide(pointedSide)) {
            side = pointedSide;
        } else {
            const rect = nodeElement.getBoundingClientRect();
            const distances: Array<[ConnectorSide, number]> = [
                ['top', Math.abs(clientY - rect.top)],
                ['right', Math.abs(clientX - rect.right)],
                ['bottom', Math.abs(clientY - rect.bottom)],
                ['left', Math.abs(clientX - rect.left)],
            ];
            side = distances.reduce((nearest, current) => current[1] < nearest[1] ? current : nearest)[0];
        }
        return { nodeId, side };
    }, []);

    const updateConnectionPreview = useCallback((clientX: number, clientY: number) => {
        const gesture = connectionDragRef.current;
        if (!gesture.active) return;
        const sourceNode = nodesRef.current.find((node) => node.id === gesture.fromNodeId);
        if (!sourceNode) return;

        const target = resolveConnectionTarget(clientX, clientY, gesture.fromNodeId);
        const previousTarget = connectionTargetRef.current;
        if (target?.nodeId !== previousTarget?.nodeId || target?.side !== previousTarget?.side) {
            connectionTargetRef.current = target;
            setConnectionTarget(target);
        }

        let path: string | null = null;
        if (target) {
            const targetNode = nodeByIdRef.current.get(target.nodeId);
            if (targetNode) {
                path = buildConnectorPath(
                    sourceNode.x,
                    sourceNode.y,
                    gesture.fromSide,
                    targetNode.x,
                    targetNode.y,
                    target.side,
                );
            }
        } else {
            const point = getCanvasPoint(clientX, clientY);
            if (point) path = buildConnectionPreviewPath(sourceNode.x, sourceNode.y, gesture.fromSide, point.x, point.y);
        }
        if (path) connectionPreviewRef.current?.setAttribute('d', path);
    }, [getCanvasPoint, resolveConnectionTarget]);

    const handleConnectionPointerDown = useCallback((
        nodeId: string,
        side: ConnectorSide,
        event: React.PointerEvent<HTMLSpanElement>,
    ) => {
        event.stopPropagation();
        if (event.button !== 0) return;
        event.preventDefault();
        const element = event.currentTarget;
        try {
            element.setPointerCapture(event.pointerId);
        } catch {}

        connectionDragRef.current = {
            active: true,
            pointerId: event.pointerId,
            fromNodeId: nodeId,
            fromSide: side,
            element,
        };
        connectionTargetRef.current = null;
        setConnectionTarget(null);
        setConnectionDraft({ nodeId, side });
        selectNode(nodeId);
        setActiveStage(null);

        const { clientX, clientY } = event;
        window.requestAnimationFrame(() => updateConnectionPreview(clientX, clientY));
    }, [selectNode, updateConnectionPreview]);

    const handleConnectionPointerMove = useCallback((event: React.PointerEvent<HTMLSpanElement>) => {
        const gesture = connectionDragRef.current;
        if (!gesture.active || gesture.pointerId !== event.pointerId) return;
        event.stopPropagation();
        event.preventDefault();
        updateConnectionPreview(event.clientX, event.clientY);
    }, [updateConnectionPreview]);

    const handleConnectionPointerUp = useCallback((event: React.PointerEvent<HTMLSpanElement>) => {
        const gesture = connectionDragRef.current;
        if (!gesture.active || gesture.pointerId !== event.pointerId) return;
        event.stopPropagation();
        event.preventDefault();

        const target = resolveConnectionTarget(event.clientX, event.clientY, gesture.fromNodeId);
        if (gesture.element && gesture.element.hasPointerCapture(gesture.pointerId)) {
            gesture.element.releasePointerCapture(gesture.pointerId);
        }
        connectionDragRef.current = { ...gesture, active: false, pointerId: -1, element: null };
        connectionTargetRef.current = null;
        setConnectionTarget(null);
        setConnectionDraft(null);

        if (!target) {
            showToast('已取消节点连接');
            return;
        }

        const fromNode = nodesRef.current.find((node) => node.id === gesture.fromNodeId);
        const toNode = nodesRef.current.find((node) => node.id === target.nodeId);
        if (!fromNode || !toNode) return;
        const existingEdge = connectorEdgesRef.current.find((edge) => (
            (edge.from === gesture.fromNodeId && edge.to === target.nodeId)
            || (edge.from === target.nodeId && edge.to === gesture.fromNodeId)
        ));

        setConnectorEdges((prev) => {
            if (existingEdge) {
                return prev.map((edge) => edge.id === existingEdge.id
                    ? { ...edge, from: gesture.fromNodeId, to: target.nodeId, fromSide: gesture.fromSide, toSide: target.side }
                    : edge
                );
            }
            return [...prev, {
                id: `edge-${Date.now()}`,
                from: gesture.fromNodeId,
                to: target.nodeId,
                fromSide: gesture.fromSide,
                toSide: target.side,
            }];
        });
        showToast(existingEdge
            ? `已更新「${fromNode.title}」与「${toNode.title}」之间的连接`
            : `已连接「${fromNode.title}」与「${toNode.title}」`
        );
    }, [resolveConnectionTarget, showToast]);

    const handleNodePointerDown = useCallback((nodeId: string, event: React.PointerEvent<HTMLButtonElement>) => {
        event.stopPropagation();
        if (event.button !== 0) return;
        event.preventDefault();

        const node = nodesRef.current.find((item) => item.id === nodeId);
        if (!node) return;
        const element = event.currentTarget;
        try {
            element.setPointerCapture(event.pointerId);
        } catch {}
        element.style.zIndex = '30';
        element.style.willChange = 'transform';
        const connectedEdges = connectorEdgesRef.current.filter((edge) => edge.from === nodeId || edge.to === nodeId);
        nodeDragRef.current = {
            active: true,
            dragging: false,
            pointerId: event.pointerId,
            nodeId,
            startX: event.clientX,
            startY: event.clientY,
            originX: node.x,
            originY: node.y,
            currentX: node.x,
            currentY: node.y,
            element,
            connectedEdges,
        };
        selectNode(nodeId);
    }, [selectNode]);

    const handleNodePointerMove = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
        const gesture = nodeDragRef.current;
        if (!gesture.active || gesture.pointerId !== event.pointerId) return;
        event.stopPropagation();

        const scale = zoomRef.current / 100;
        const deltaX = (event.clientX - gesture.startX) / scale;
        const deltaY = (event.clientY - gesture.startY) / scale;
        if (!gesture.dragging && Math.abs(deltaX) < 3 && Math.abs(deltaY) < 3) return;
        gesture.dragging = true;

        const x = Math.round(gesture.originX + deltaX);
        const y = Math.round(gesture.originY + deltaY);
        gesture.currentX = x;
        gesture.currentY = y;
        if (gesture.element) {
            gesture.element.style.transform = `translate3d(${x - gesture.originX}px, ${y - gesture.originY}px, 0)`;
        }

        for (const edge of gesture.connectedEdges) {
            const from = edge.from === gesture.nodeId ? null : nodeByIdRef.current.get(edge.from);
            const to = edge.to === gesture.nodeId ? null : nodeByIdRef.current.get(edge.to);
            if ((edge.from !== gesture.nodeId && !from) || (edge.to !== gesture.nodeId && !to)) continue;
            const path = buildConnectorPath(
                edge.from === gesture.nodeId ? x : from!.x,
                edge.from === gesture.nodeId ? y : from!.y,
                edge.fromSide,
                edge.to === gesture.nodeId ? x : to!.x,
                edge.to === gesture.nodeId ? y : to!.y,
                edge.toSide,
            );
            connectorPathRefs.current.get(edge.id)?.setAttribute('d', path);
        }
    }, []);

    const handleNodePointerUp = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
        const gesture = nodeDragRef.current;
        if (!gesture.active || gesture.pointerId !== event.pointerId) return;
        event.stopPropagation();

        const { element, nodeId, currentX, currentY, dragging, pointerId } = gesture;
        gesture.active = false;
        gesture.dragging = false;
        gesture.pointerId = -1;

        if (element) {
            if (dragging) {
                element.style.left = `${currentX}px`;
                element.style.top = `${currentY}px`;
            }
            element.style.transform = '';
            element.style.zIndex = '';
            element.style.willChange = '';
            if (pointerId >= 0 && element.hasPointerCapture(pointerId)) {
                element.releasePointerCapture(pointerId);
            }
        }

        if (dragging) {
            setNodes((prev) => prev.map((node) => node.id === nodeId
                ? { ...node, x: currentX, y: currentY }
                : node
            ));
        }
    }, []);

    const handleEpisodeChange = (nextEpisode: number) => {
        setEpisodeNo(nextEpisode);
        const padded = String(nextEpisode).padStart(2, '0');
        setNodes((prev) => prev.map((node) => node.id === 'script-input'
            ? {
                ...node,
                title: `第 ${padded} 集剧本`,
                meta: nextEpisode === 1 ? '共 12 场 · 2,440 字' : `共 ${10 + nextEpisode} 场 · ${1800 + nextEpisode * 120} 字`,
            }
            : node
        ));
        showToast(`已切换到第 ${padded} 集，画布上下文已同步`);
    };

    const applyCanvasOffsetPreview = (offset: { x: number; y: number }) => {
        if (canvasContentRef.current) {
            canvasContentRef.current.style.transform = `translate3d(${offset.x}px, ${offset.y}px, 0)`;
        }
        if (canvasViewportRef.current) {
            canvasViewportRef.current.style.backgroundPosition = `${offset.x}px ${offset.y}px`;
        }
    };

    const handleCanvasPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
        if (event.button !== 0) return;
        const target = event.target as Element;
        if (target.closest('button, input, textarea, select, a')) return;

        event.preventDefault();
        setSelectedNodeId(null);
        setActiveStage(null);
        setCommentComposerOpen(false);
        setCommentDraft('');
        const viewport = canvasViewportRef.current;
        if (!viewport) return;
        try {
            viewport.setPointerCapture(event.pointerId);
        } catch {}

        if (panGestureRef.current.holdTimer) window.clearTimeout(panGestureRef.current.holdTimer);
        panGestureRef.current = {
            pressed: true,
            dragging: false,
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            originX: canvasOffsetRef.current.x,
            originY: canvasOffsetRef.current.y,
            holdTimer: window.setTimeout(() => {
                if (!panGestureRef.current.pressed) return;
                panGestureRef.current.dragging = true;
                setIsPanning(true);
            }, 180),
        };
    };

    const handleCanvasPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
        const gesture = panGestureRef.current;
        if (!gesture.pressed || !gesture.dragging) return;
        event.preventDefault();
        pendingCanvasOffsetRef.current = {
            x: gesture.originX + event.clientX - gesture.startX,
            y: gesture.originY + event.clientY - gesture.startY,
        };
        if (panFrameRef.current === null) {
            panFrameRef.current = window.requestAnimationFrame(() => {
                panFrameRef.current = null;
                applyCanvasOffsetPreview(pendingCanvasOffsetRef.current);
            });
        }
    };

    const finishCanvasPan = (event: React.PointerEvent<HTMLDivElement>) => {
        const gesture = panGestureRef.current;
        if (!gesture.pressed) return;
        if (gesture.holdTimer) window.clearTimeout(gesture.holdTimer);
        gesture.holdTimer = null;
        gesture.pressed = false;
        const wasDragging = gesture.dragging;
        gesture.dragging = false;

        if (wasDragging) {
            const finalOffset = {
                x: gesture.originX + event.clientX - gesture.startX,
                y: gesture.originY + event.clientY - gesture.startY,
            };
            if (panFrameRef.current !== null) {
                window.cancelAnimationFrame(panFrameRef.current);
                panFrameRef.current = null;
            }
            pendingCanvasOffsetRef.current = finalOffset;
            canvasOffsetRef.current = finalOffset;
            applyCanvasOffsetPreview(finalOffset);
            setCanvasOffset(finalOffset);
            setIsPanning(false);
        }

        const viewport = canvasViewportRef.current;
        if (viewport && gesture.pointerId >= 0 && viewport.hasPointerCapture(gesture.pointerId)) {
            viewport.releasePointerCapture(gesture.pointerId);
        }
        gesture.pointerId = -1;
    };

    const resetCanvasView = () => {
        const zero = { x: 0, y: 0 };
        canvasOffsetRef.current = zero;
        pendingCanvasOffsetRef.current = zero;
        applyCanvasOffsetPreview(zero);
        setCanvasOffset(zero);
        setZoom(72);
        setActiveStage(null);
    };

    const handleAddNode = () => {
        const scale = zoom / 100;
        const centerX = CANVAS_WIDTH / 2 - canvasOffsetRef.current.x / scale;
        const centerY = CANVAS_HEIGHT / 2 - canvasOffsetRef.current.y / scale;
        const x = Math.min(CANVAS_WIDTH - 186, Math.max(10, Math.round(centerX - 88)));
        const y = Math.min(CANVAS_HEIGHT - 120, Math.max(12, Math.round(centerY - 55)));
        const stage: 1 | 2 | 3 = x < 400 ? 1 : x < 850 ? 2 : 3;
        const customIndex = nodesRef.current.filter((node) => node.id.startsWith('custom-node-')).length + 1;
        const newNode: StudioNode = {
            id: `custom-node-${Date.now()}`,
            section: '自定义节点',
            title: `新节点 ${customIndex}`,
            meta: '点击右侧配置生成服务与提示',
            footer: '待配置',
            status: '待配置',
            tone: 'neutral',
            stage,
            x,
            y,
            service: '系统默认 · 火山引擎适配器',
            prompt: '请填写该节点的生成提示。',
            scope: '制作部 / 当前项目',
            version: 'V6',
            cost: '¥0.00',
            comments: [],
        };
        setNodes((prev) => [...prev, newNode]);
        setSelectedNodeId(newNode.id);
        setActiveStage(stage);
        setCommentComposerOpen(false);
        setCommentDraft('');
        showToast(`已新增「${newNode.title}」，可在右侧完成配置`);
    };

    const handleDeleteNode = () => {
        const targetId = selectedNodeId;
        if (!targetId) {
            showToast('请先选中一个画布节点');
            return;
        }
        const currentNodes = nodesRef.current;
        if (currentNodes.length <= 1) {
            showToast('画布至少需要保留一个节点');
            return;
        }
        const targetIndex = currentNodes.findIndex((node) => node.id === targetId);
        if (targetIndex < 0) return;
        const target = currentNodes[targetIndex];
        const nextNodes = currentNodes.filter((node) => node.id !== targetId);
        const nextNode = nextNodes[Math.min(targetIndex, nextNodes.length - 1)];

        setNodes(nextNodes);
        setConnectorEdges((prev) => prev.filter((edge) => edge.from !== targetId && edge.to !== targetId));
        setSelectedNodeId(nextNode.id);
        setActiveStage(nextNode.stage);
        setCommentComposerOpen(false);
        setCommentDraft('');
        showToast(`已删除「${target.title}」及其关联连线`);
    };

    const handleRegenerate = () => {
        updateSelectedNode({ status: '生成中', tone: 'info' });
        setCommentComposerOpen(false);
        showToast(`已提交「${selectedNode.title}」重新生成`);
        if (regenerateTimer.current) window.clearTimeout(regenerateTimer.current);
        regenerateTimer.current = window.setTimeout(() => {
            setNodes((prev) => prev.map((node) => node.id === selectedNode.id
                ? { ...node, status: '待审核', tone: 'warning' }
                : node
            ));
        }, 1800);
    };

    const handleSubmitNode = () => {
        updateSelectedNode({ status: '待审核', tone: 'warning' });
        showToast(`「${selectedNode.title}」已提交当前节点审核`);
    };

    const handleAddComment = () => {
        const content = commentDraft.trim();
        if (!content) return;
        updateSelectedNode({
            comments: [
                ...selectedNode.comments,
                {
                    author: '项目制作部',
                    role: '当前用户',
                    content,
                    time: '刚刚',
                },
            ],
        });
        setCommentDraft('');
        setCommentComposerOpen(false);
        showToast('审核意见已添加');
    };

    const handleConfirmAsset = () => {
        setAssets((prev) => prev.map((asset) => asset.id === 'chen-yuan'
            ? { ...asset, role: '配角 · 已审核', status: '已审核', tone: 'success' }
            : asset
        ));
        setWarningDismissed(true);
        setDialog(null);
        showToast('角色“陈远”资产已确认，门禁已解除');
    };

    const handleReviewSubmit = () => {
        setDialog(null);
        handleSubmitNode();
        showToast('本集审核流程已提交，已通知项目主管');
    };

    const handleDialogPrimary = () => {
        if (dialog === 'asset') {
            handleConfirmAsset();
            return;
        }
        if (dialog === 'review') {
            handleReviewSubmit();
            return;
        }
        if (dialog === 'storyboard') {
            setDialog(null);
            showToast('分镜生成任务已加入队列');
            return;
        }
        setDialog(null);
    };

    const dialogTitles: Record<Exclude<DialogKey, null>, string> = {
        script: `本集剧本 · 第 ${String(episodeNo).padStart(2, '0')} 集`,
        storyboard: '生成分镜',
        versions: '画布版本',
        tasks: '生成任务',
        shots: '镜头版本',
        review: '提交本集审核',
        asset: '资产确认 · 陈远',
    };
    const dialogTitle = dialog ? dialogTitles[dialog] : '';
    const dialogPrimaryLabel = dialog === 'asset'
        ? '确认资产'
        : dialog === 'review'
            ? '确认提交审核'
            : dialog === 'storyboard'
                ? '开始生成分镜'
                : '知道了';

    return (
        <div className="project-studio-canvas h-screen w-screen overflow-hidden bg-[#f7f8fc] text-[#202637] flex">
            <style>{`
                .project-studio-canvas { color-scheme: light; --focus-ring: #5661f5; --focus-ring-offset: 1px; }
                .project-studio-canvas ::-webkit-scrollbar { width: 7px; height: 7px; }
                .project-studio-canvas ::-webkit-scrollbar-track { background: transparent; }
                .project-studio-canvas ::-webkit-scrollbar-thumb { background: rgba(115, 125, 150, .28); border-radius: 999px; }
                .project-studio-canvas ::-webkit-scrollbar-thumb:hover { background: rgba(115, 125, 150, .42); }
                .project-studio-canvas .studio-grid { background-image: radial-gradient(circle, rgba(152, 164, 190, .46) 1px, transparent 1px); background-size: 17px 17px; }
                .project-studio-canvas .studio-canvas-content { contain: layout style; backface-visibility: hidden; }
                .project-studio-canvas .studio-node-card { contain: layout style; backface-visibility: hidden; }
                .project-studio-canvas select.studio-select { appearance: none; -webkit-appearance: none; }
                .project-studio-canvas .studio-node-name-input:focus-visible { outline: none; }
                .project-studio-canvas input::placeholder, .project-studio-canvas textarea::placeholder { color: #a4aabd; }
                .project-studio-canvas textarea { resize: none; }
                .project-studio-canvas [class~="text-[8px]"],
                .project-studio-canvas [class~="text-[8.5px]"],
                .project-studio-canvas [class~="text-[9px]"],
                .project-studio-canvas [class~="text-[9.5px]"],
                .project-studio-canvas [class~="text-[10px]"],
                .project-studio-canvas [class~="text-[10.5px]"],
                .project-studio-canvas [class~="text-[11px]"] { font-size: 12px; }
                @keyframes studio-toast-in { from { opacity: 0; transform: translate(-50%, 8px); } to { opacity: 1; transform: translate(-50%, 0); } }
                .project-studio-canvas .studio-toast { animation: studio-toast-in .18s ease-out both; }
            `}</style>

            {/* 全局窄导航 */}
            <aside className="w-12 shrink-0 bg-white border-r border-[#e8eaf2] flex flex-col items-center py-2.5">
                <button
                    type="button"
                    onClick={() => showToast('工作台导航已展开')}
                    className="w-8 h-8 rounded-lg flex items-center justify-center text-[#a0a7b8] hover:bg-[#f3f4f9] transition-colors"
                    title="展开导航"
                >
                    <ChevronRight size={14} />
                </button>
                <div className="mt-8 flex flex-col items-center gap-2.5">
                    {[
                        { icon: FolderOpen, label: '项目库' },
                        { icon: LayoutTemplate, label: '制作画布', active: true },
                        { icon: Grid2X2, label: '模板中心' },
                        { icon: Clapperboard, label: '分镜工坊' },
                        { icon: MessageSquare, label: '协作消息' },
                        { icon: Users, label: '团队' },
                        { icon: ListChecks, label: '审核任务' },
                    ].map(({ icon: Icon, label, active }) => (
                        <button
                            key={label}
                            type="button"
                            onClick={() => showToast(`${label}已打开`)}
                            className={`w-8 h-8 rounded-lg flex items-center justify-center transition-colors ${active ? 'bg-[#eef0ff] text-[#5b5bf6]' : 'text-[#a0a7b8] hover:bg-[#f3f4f9] hover:text-[#667085]'}`}
                            title={label}
                        >
                            <Icon size={16} strokeWidth={1.8} />
                        </button>
                    ))}
                </div>
                <button
                    type="button"
                    onClick={() => showToast('设置面板已打开')}
                    className="mt-auto w-8 h-8 rounded-lg flex items-center justify-center text-[#a0a7b8] hover:bg-[#f3f4f9] hover:text-[#667085] transition-colors"
                    title="设置"
                >
                    <Settings size={16} strokeWidth={1.8} />
                </button>
            </aside>

            <div className="min-w-0 flex-1 flex flex-col">
                {/* 项目头部 */}
                <header className="shrink-0 h-[126px] px-6 pt-5 flex items-start justify-between gap-6 border-b border-[#f0f1f6] bg-white">
                    <div className="flex items-start gap-3 min-w-0">
                        <button
                            type="button"
                            onClick={onBack}
                            className="mt-1.5 w-8 h-8 rounded-lg flex items-center justify-center text-[#4b5568] hover:bg-[#f4f5f9] transition-colors shrink-0"
                            title="返回项目列表"
                        >
                            <ArrowLeft size={18} />
                        </button>
                        <div className="mt-0.5 w-9 h-9 rounded-[9px] bg-[linear-gradient(135deg,#7657f6,#5b5bf6_54%,#3d9bf6)] text-white flex items-center justify-center shadow-[0_5px_14px_rgba(91,91,246,.24)] shrink-0">
                            <Film size={18} strokeWidth={1.9} />
                        </div>
                        <div className="shrink-0">
                            <h1 className="text-[18px] leading-7 font-semibold text-[#202637] truncate max-w-[420px]">{project.name}</h1>
                            <p className="mt-0.5 text-[11px] text-[#9ca4b6]">项目 {project.code} · 全剧资产共享</p>
                        </div>
                        <div className="ml-4 mt-0.5 flex items-center gap-2 shrink-0">
                            <div className="relative">
                                <select
                                    className="studio-select h-8 pl-3 pr-8 rounded-[5px] border border-[#e6e9f1] bg-[#f6f7fb] text-[12px] font-medium text-[#32394a] outline-none hover:border-[#cfd4e2] focus:border-[#5b5bf6]"
                                    value={episodeNo}
                                    onChange={(event) => handleEpisodeChange(Number(event.target.value))}
                                    aria-label="选择分集"
                                >
                                    {Array.from({ length: 10 }, (_, index) => index + 1).map((episode) => (
                                        <option key={episode} value={episode}>第 {String(episode).padStart(2, '0')} 集</option>
                                    ))}
                                </select>
                                <ChevronDown size={13} className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[#9da5b7]" />
                            </div>
                            <span className="text-[11px] text-[#81899b]">画布 V6</span>
                            <span className="h-3 w-px bg-[#e1e4ec]" />
                            <span className="flex items-center gap-1 text-[11px] text-[#9098aa]">
                                <CheckCircle2 size={12} className="text-[#2bb673]" /> 已自动保存
                            </span>
                        </div>
                    </div>

                    <div className="mt-9 flex items-center gap-2 shrink-0">
                        <div className="h-8 p-0.5 rounded-[6px] bg-[#f4f5f9] border border-[#e8eaf2] flex items-center">
                            <button
                                type="button"
                                onClick={() => { setMode('auto'); showToast('已切换为全自动模式'); }}
                                className={`h-7 px-3 rounded-[4px] text-[11px] transition-colors ${mode === 'auto' ? 'bg-[#5b5bf6] text-white shadow-sm' : 'text-[#6f7789] hover:text-[#343b4c]'}`}
                            >
                                全自动
                            </button>
                            <button
                                type="button"
                                onClick={() => { setMode('manual'); showToast('已切换为人工逐节点模式'); }}
                                className={`h-7 px-3 rounded-[4px] text-[11px] transition-colors ${mode === 'manual' ? 'bg-white text-[#3f4657] shadow-[0_1px_3px_rgba(15,23,42,.1)]' : 'text-[#6f7789] hover:text-[#343b4c]'}`}
                            >
                                人工逐节点
                            </button>
                        </div>
                        {[
                            { key: 'script' as const, label: '本集剧本', icon: FileText },
                            { key: 'storyboard' as const, label: '生成分镜', icon: Clapperboard },
                            { key: 'versions' as const, label: '版本', icon: History },
                            { key: 'tasks' as const, label: '任务', icon: ListChecks, badge: 3 },
                            { key: 'shots' as const, label: '镜头版本', icon: Video },
                        ].map(({ key, label, icon: Icon, badge }) => (
                            <button
                                key={key}
                                type="button"
                                onClick={() => setDialog(key)}
                                className="relative h-8 px-3 rounded-[5px] border border-[#dfe3ed] bg-white text-[11px] text-[#343b4c] flex items-center gap-1.5 hover:border-[#bfc6d8] hover:bg-[#fafbfe] transition-colors"
                            >
                                <Icon size={14} strokeWidth={1.8} />
                                {label}
                                {badge ? (
                                    <span className="absolute -right-1.5 -top-1.5 min-w-[17px] h-[17px] px-1 rounded-full bg-[#ff4d4f] text-white text-[9px] leading-[17px] text-center border-2 border-white">
                                        {badge}
                                    </span>
                                ) : null}
                            </button>
                        ))}
                        <button
                            type="button"
                            onClick={() => setDialog('review')}
                            className="h-8 px-3.5 rounded-[5px] bg-[#5b5bf6] text-white text-[11px] font-medium flex items-center gap-1.5 hover:bg-[#4f4fe9] shadow-[0_4px_12px_rgba(91,91,246,.2)] transition-colors"
                        >
                            <Send size={13} />
                            提交审核
                        </button>
                    </div>
                </header>

                {/* 项目上下文条 */}
                <div className="shrink-0 h-10 px-6 flex items-center justify-between border-b border-[#e4e7f1] bg-[#f4f6fb] text-[11px] text-[#667085]">
                    <div className="flex items-center gap-2.5 min-w-0">
                        <span className="w-2 h-2 rounded-full bg-[#5b8ff9] shrink-0" />
                        <span className="font-medium text-[#3e4759]">{mode === 'manual' ? '人工逐节点模式' : '全自动模式'}</span>
                        <span className="text-[#d0d5e1]">|</span>
                        <span>项目进度 <b className="font-semibold text-[#4f5668]">18 / 80</b> 集</span>
                        <span className="text-[#d0d5e1]">|</span>
                        <span>第 {String(episodeNo).padStart(2, '0')} 集</span>
                        <span>主流程完成 <b className="font-semibold text-[#5b5bf6]">68%</b></span>
                        <div className="w-[190px] h-1.5 rounded-full bg-[#e6e9f3] overflow-hidden">
                            <div className="h-full w-[68%] rounded-full bg-[linear-gradient(90deg,#6d6af9,#5b5bf6)]" />
                        </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                        <span className="px-2 py-1 rounded-[4px] bg-white/80 text-[#6676c9]">中台内嵌工作区</span>
                        <span className="px-2 py-1 rounded-[4px] bg-white/80 text-[#6676c9]">分集独立画布</span>
                        <span className="text-[#9aa2b4]">项目、集数、权限与任务上下文已绑定</span>
                    </div>
                </div>

                {/* 资产门禁提示 */}
                {!warningDismissed && (
                    <div className="shrink-0 h-[52px] px-6 flex items-center justify-between border-b border-[#f3e4bb] bg-[#fff9e9]">
                        <div className="flex items-start gap-2.5 min-w-0">
                            <AlertTriangle size={17} className="mt-1.5 text-[#e5a221] shrink-0" />
                            <div className="min-w-0">
                                <div className="text-[12px] font-medium text-[#7c5a12]">项目资产门禁：角色“陈远”仍待确认</div>
                                <div className="mt-0.5 text-[10px] text-[#a48a55]">可以查看和编辑画布，但正式生成分镜和镜头视频前必须确认引用资产。</div>
                            </div>
                        </div>
                        <button
                            type="button"
                            onClick={() => { setSelectedAssetId('chen-yuan'); setAssetTab('characters'); setDialog('asset'); }}
                            className="h-7 px-3 rounded-[4px] bg-[#3447d3] text-white text-[11px] font-medium hover:bg-[#2c3dbb] transition-colors shrink-0"
                        >
                            处理资产确认
                        </button>
                    </div>
                )}

                <main className="flex-1 min-h-0 flex flex-col">
                    <div className="flex-1 min-h-0 flex">
                        <aside className="w-[278px] shrink-0 bg-white border-r border-[#e6e9f2] overflow-y-auto">
                            <section className="px-3.5 pt-3.5 pb-3 border-b border-[#eef0f5]">
                                <div className="flex items-start justify-between gap-2">
                                    <div>
                                        <h2 className="text-[13px] font-semibold text-[#2d3445]">项目资产</h2>
                                        <p className="mt-0.5 text-[10px] text-[#a2a9b8]">全剧共享 · 权限校验后直接复用</p>
                                    </div>
                                    <button
                                        type="button"
                                        onClick={() => setAssetsCollapsed((value) => !value)}
                                        className="w-6 h-6 rounded flex items-center justify-center text-[#a2a9b8] hover:bg-[#f4f5f9] hover:text-[#687184] transition-colors"
                                        title={assetsCollapsed ? '展开项目资产' : '收起项目资产'}
                                    >
                                        <ChevronDown size={14} className={`transition-transform ${assetsCollapsed ? '-rotate-90' : ''}`} />
                                    </button>
                                </div>

                                {!assetsCollapsed && (
                                    <>
                                        <div className="relative mt-3">
                                            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#a8afbd]" />
                                            <input
                                                value={assetSearch}
                                                onChange={(event) => setAssetSearch(event.target.value)}
                                                placeholder="搜索角色、场景、道具"
                                                className="h-8 w-full rounded-[5px] border border-[#e5e8f0] bg-[#fafbfe] pl-8 pr-3 text-[11px] text-[#374052] outline-none transition-colors focus:border-[#8b8cf7] focus:bg-white"
                                            />
                                        </div>

                                        <div className="mt-2.5 grid grid-cols-3 gap-1 rounded-[5px] bg-[#f5f6fa] p-0.5">
                                            {([
                                                { key: 'characters' as const, label: '角色' },
                                                { key: 'scenes' as const, label: '场景' },
                                                { key: 'props' as const, label: '道具' },
                                            ]).map((tab) => (
                                                <button
                                                    key={tab.key}
                                                    type="button"
                                                    onClick={() => setAssetTab(tab.key)}
                                                    className={`h-7 rounded-[4px] text-[11px] transition-colors ${assetTab === tab.key ? 'bg-white text-[#343b4d] font-medium shadow-[0_1px_3px_rgba(15,23,42,.08)]' : 'text-[#858da0] hover:text-[#4d5669]'}`}
                                                >
                                                    {tab.label}
                                                </button>
                                            ))}
                                        </div>

                                        <div className="mt-1.5 space-y-0.5">
                                            {filteredAssets.map((asset) => (
                                                <button
                                                    key={asset.id}
                                                    type="button"
                                                    onClick={() => { setSelectedAssetId(asset.id); showToast(`已选中${asset.category === 'characters' ? '角色' : asset.category === 'scenes' ? '场景' : '道具'}“${asset.name}”`); }}
                                                    className={`w-full flex items-center gap-2.5 rounded-[5px] px-1.5 py-2 text-left transition-colors ${selectedAssetId === asset.id ? 'bg-[#f1f2ff]' : 'hover:bg-[#f7f8fb]'}`}
                                                >
                                                    <span className={`w-8 h-8 rounded-[5px] bg-gradient-to-br ${asset.accent} flex items-center justify-center text-[11px] font-semibold text-white/95 shadow-inner shrink-0`}>
                                                        {asset.name.slice(0, 1)}
                                                    </span>
                                                    <span className="min-w-0 flex-1">
                                                        <span className="block truncate text-[12px] font-medium text-[#394153]">{asset.name}</span>
                                                        <span className="mt-0.5 block truncate text-[10px] text-[#9aa2b2]">{asset.role}</span>
                                                    </span>
                                                    <Ellipsis size={14} className="text-[#b2b8c5] shrink-0" />
                                                </button>
                                            ))}
                                            {filteredAssets.length === 0 && (
                                                <div className="py-6 text-center text-[11px] text-[#a3aaba]">没有匹配的资产</div>
                                            )}
                                        </div>

                                        <button
                                            type="button"
                                            onClick={() => showToast('已打开中台素材选择器')}
                                            className="mt-2.5 h-8 w-full rounded-[5px] border border-[#dfe3ed] bg-white text-[11px] text-[#475064] flex items-center justify-center gap-2 hover:border-[#bfc6d8] hover:bg-[#fafbfe] transition-colors"
                                        >
                                            <FolderOpen size={14} strokeWidth={1.8} />
                                            选择中台素材
                                        </button>
                                    </>
                                )}
                            </section>

                            <section className="px-3.5 py-3">
                                <div className="flex items-center justify-between">
                                    <h2 className="text-[13px] font-semibold text-[#2d3445]">流程导航</h2>
                                    <span className="text-[10px] text-[#a2a9b8]">10 个核心节点</span>
                                </div>
                                <div className="mt-2 space-y-0.5">
                                    {FLOW_NAV.map((item) => {
                                        const target = nodes.find((node) => node.id === item.target);
                                        const label = item.id === '01' ? `第 ${String(episodeNo).padStart(2, '0')} 集剧本` : item.label;
                                        return (
                                            <button
                                                key={item.id}
                                                type="button"
                                                onClick={() => selectNode(item.target)}
                                                className={`w-full h-[31px] px-2 rounded-[4px] flex items-center gap-2 text-left transition-colors ${selectedNodeId === item.target ? 'bg-[#f1f2ff] text-[#4f51d9]' : 'text-[#7b8497] hover:bg-[#f7f8fb] hover:text-[#424b5d]'}`}
                                            >
                                                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${DOT_STYLES[item.tone]}`} />
                                                <span className="w-4 text-[10px] text-[#b1b7c3]">{item.id}</span>
                                                <span className="min-w-0 flex-1 truncate text-[11px]">{label}</span>
                                                {target && selectedNodeId === target.id ? <ChevronRight size={12} className="text-[#7779e5]" /> : null}
                                            </button>
                                        );
                                    })}
                                </div>
                            </section>
                        </aside>
                        <section className="flex-1 min-w-0 flex flex-col bg-white">
                            <div className="shrink-0 h-10 px-2.5 flex items-center justify-between border-b border-[#edf0f5] bg-white">
                                <div className="flex items-center gap-1">
                                    <button
                                        type="button"
                                        onClick={handleAddNode}
                                        className="w-7 h-7 rounded-[4px] border border-[#e3e6ee] bg-white text-[#5d6577] flex items-center justify-center hover:border-[#bfc6d8] hover:bg-[#fafbfe] transition-colors"
                                        title="新增画布节点"
                                    >
                                        <Plus size={15} />
                                    </button>
                                    <button
                                        type="button"
                                        onClick={handleDeleteNode}
                                        disabled={!canDeleteNode}
                                        className={`w-7 h-7 rounded-[4px] border border-[#e3e6ee] bg-white flex items-center justify-center transition-colors ${!canDeleteNode ? 'text-[#c4c9d4] opacity-50 cursor-not-allowed' : 'text-[#7d8597] hover:border-[#f0b4b4] hover:bg-[#fff7f7] hover:text-[#d94b4b]'}`}
                                        title={!hasSelectedNode ? '请先选中画布节点' : nodes.length <= 1 ? '画布至少需要保留一个节点' : '删除当前画布节点'}
                                    >
                                        <Trash2 size={14} />
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => setGridVisible((value) => !value)}
                                        className={`w-7 h-7 rounded-[4px] flex items-center justify-center transition-colors ${gridVisible ? 'bg-[#f1f2ff] text-[#5b5bf6]' : 'text-[#7d8597] hover:bg-[#f5f6fa]'}`}
                                        title="显示或隐藏网格"
                                    >
                                        <Grid2X2 size={15} />
                                    </button>
                                    <button
                                        type="button"
                                        onClick={resetCanvasView}
                                        className="w-7 h-7 rounded-[4px] text-[#7d8597] flex items-center justify-center hover:bg-[#f5f6fa] transition-colors"
                                        title="适应画布"
                                    >
                                        <Maximize2 size={15} />
                                    </button>
                                </div>

                                <div className="flex items-center gap-1 text-[10px]">
                                    {STAGES.map((stage, index) => (
                                        <React.Fragment key={stage.id}>
                                            {index > 0 && <span className="px-1 text-[#c3c8d3]">/</span>}
                                            <button
                                                type="button"
                                                onClick={() => setActiveStage((current) => current === stage.id ? null : stage.id)}
                                                className={`px-1.5 py-1 rounded-[3px] transition-colors ${activeStage === stage.id ? 'bg-[#eef0ff] text-[#5b5bf6] font-medium' : 'text-[#9aa2b2] hover:text-[#657087]'}`}
                                            >
                                                {stage.label.replace(/^0\d · /, '')}
                                            </button>
                                        </React.Fragment>
                                    ))}
                                </div>

                                <div className="flex items-center gap-1">
                                    <button
                                        type="button"
                                        onClick={() => setZoom((value) => Math.max(40, value - 8))}
                                        className="w-6 h-6 rounded-[4px] text-[#687184] flex items-center justify-center hover:bg-[#f5f6fa] transition-colors"
                                        title="缩小"
                                    >
                                        <Minus size={13} />
                                    </button>
                                    <span className="w-9 text-center text-[10px] text-[#555e70]">{zoom}%</span>
                                    <button
                                        type="button"
                                        onClick={() => setZoom((value) => Math.min(130, value + 8))}
                                        className="w-6 h-6 rounded-[4px] border border-[#e3e6ee] text-[#687184] flex items-center justify-center hover:bg-[#f5f6fa] transition-colors"
                                        title="放大"
                                    >
                                        <Plus size={13} />
                                    </button>
                                </div>
                            </div>

                            <div
                                ref={canvasViewportRef}
                                className={`relative flex-1 min-h-0 overflow-hidden select-none ${isPanning ? 'cursor-grabbing' : 'cursor-grab'} ${gridVisible ? 'studio-grid' : 'bg-white'}`}
                                style={{
                                    touchAction: 'none',
                                    backgroundPosition: `${canvasOffset.x}px ${canvasOffset.y}px`,
                                    backgroundSize: `${17 * zoom / 100}px ${17 * zoom / 100}px`,
                                }}
                                onPointerDown={handleCanvasPointerDown}
                                onPointerMove={handleCanvasPointerMove}
                                onPointerUp={finishCanvasPan}
                                onPointerCancel={finishCanvasPan}
                                onDragStart={(event) => event.preventDefault()}
                                title="长按画布并拖动可平移"
                            >
                                <div className="min-w-full min-h-full p-5 flex items-center justify-center">
                                    <div
                                        ref={canvasContentRef}
                                        className="studio-canvas-content relative shrink-0"
                                        style={{
                                            width: CANVAS_WIDTH * zoom / 100,
                                            height: CANVAS_HEIGHT * zoom / 100,
                                            transform: `translate3d(${canvasOffset.x}px, ${canvasOffset.y}px, 0)`,
                                            willChange: 'transform',
                                            pointerEvents: isPanning ? 'none' : undefined,
                                        }}
                                    >
                                        <div
                                            className="absolute left-0 top-0 origin-top-left"
                                            style={{ width: CANVAS_WIDTH, height: CANVAS_HEIGHT, transform: `scale(${zoom / 100})` }}
                                        >
                                            {/*{STAGES.map((stage) => (*/}
                                            {/*    <button*/}
                                            {/*        key={stage.id}*/}
                                            {/*        type="button"*/}
                                            {/*        onClick={() => setActiveStage((current) => current === stage.id ? null : stage.id)}*/}
                                            {/*        className={`absolute top-8 flex items-center gap-1.5 text-[9px] transition-opacity ${activeStage !== null && activeStage !== stage.id ? 'opacity-35' : 'opacity-100'} ${activeStage === stage.id ? 'text-[#4d51cd] font-medium' : 'text-[#a0a7b7] hover:text-[#70798d]'}`}*/}
                                            {/*        style={{ left: stage.id === 1 ? 40 : stage.id === 2 ? 456 : 1040 }}*/}
                                            {/*    >*/}
                                            {/*        <span className={`w-1.5 h-1.5 rounded-full ${stage.accent}`} />*/}
                                            {/*        {stage.label}*/}
                                            {/*    </button>*/}
                                            {/*))}*/}

                                            <svg
                                                className="absolute inset-0 pointer-events-none overflow-visible"
                                                width={CANVAS_WIDTH}
                                                height={CANVAS_HEIGHT}
                                                viewBox={`0 0 ${CANVAS_WIDTH} ${CANVAS_HEIGHT}`}
                                                aria-hidden="true"
                                            >
                                                <defs>
                                                    <marker id="studio-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                                                        <path d="M 0 0 L 8 4 L 0 8 z" fill="#aeb8ce" />
                                                    </marker>
                                                    <marker id="studio-preview-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                                                        <path d="M 0 0 L 8 4 L 0 8 z" fill="#6a6af8" />
                                                    </marker>
                                                </defs>
                                                {connectorEdges.map((edge) => {
                                                    const from = nodeById.get(edge.from);
                                                    const to = nodeById.get(edge.to);
                                                    if (!from || !to) return null;
                                                    return (
                                                        <path
                                                            key={edge.id}
                                                            ref={getConnectorPathRef(edge.id)}
                                                            d={buildConnectorPath(from.x, from.y, edge.fromSide, to.x, to.y, edge.toSide)}
                                                            fill="none"
                                                            stroke="#b8c1d4"
                                                            strokeWidth="1.3"
                                                            markerEnd="url(#studio-arrow)"
                                                        />
                                                    );
                                                })}
                                                {connectionDraft && (
                                                    <path
                                                        ref={connectionPreviewRef}
                                                        fill="none"
                                                        stroke="#6a6af8"
                                                        strokeWidth="1.5"
                                                        strokeDasharray="5 4"
                                                        markerEnd="url(#studio-preview-arrow)"
                                                    />
                                                )}
                                            </svg>

                                            {nodes.map((node) => {
                                                const selected = selectedNodeId === node.id;
                                                const dimmed = activeStage !== null && activeStage !== node.stage;
                                                return (
                                                    <StudioNodeCard
                                                        key={node.id}
                                                        node={node}
                                                        selected={selected}
                                                        dimmed={dimmed}
                                                        connectionTargetSide={connectionTarget?.nodeId === node.id ? connectionTarget.side : null}
                                                        onSelect={selectNode}
                                                        onPointerDown={handleNodePointerDown}
                                                        onPointerMove={handleNodePointerMove}
                                                        onPointerUp={handleNodePointerUp}
                                                        onConnectionPointerDown={handleConnectionPointerDown}
                                                        onConnectionPointerMove={handleConnectionPointerMove}
                                                        onConnectionPointerUp={handleConnectionPointerUp}
                                                    />
                                                );
                                            })}
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </section>
                        <aside className="w-[292px] shrink-0 bg-white border-l border-[#e6e9f2] flex flex-col">
                            {hasSelectedNode ? (
                                <>
                            <div className="shrink-0 px-4 pt-3 pb-3 border-b border-[#eef0f5]">
                                <div className="text-[11px] font-medium text-[#8d95a7]">节点名称</div>
                                <input
                                    type="text"
                                    aria-label="节点名称"
                                    value={selectedNode.title}
                                    maxLength={40}
                                    onChange={(event) => updateSelectedNode({ title: event.target.value })}
                                    className="studio-node-name-input mt-1.5 h-8 w-full px-2.5 rounded-[4px] border border-[#e4e7ef] bg-white text-[10.5px] text-[#4e576a] outline-none transition-colors focus:border-[#8b8cf7]"
                                    placeholder="请输入节点名称"
                                />
                            </div>

                            <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3">
                                <div>
                                    <div className="flex items-center justify-between text-[11px] text-[#4d5669]">
                                        <span>生成服务</span>
                                        <span className="text-[9px] text-[#b0b6c3]">管理员配置</span>
                                    </div>
                                    <div className="relative mt-1.5">
                                        <select
                                            value={selectedNode.service}
                                            onChange={(event) => updateSelectedNode({ service: event.target.value })}
                                            className="studio-select h-8 w-full rounded-[4px] border border-[#e4e7ef] bg-white pl-2.5 pr-7 text-[10.5px] text-[#4e576a] outline-none focus:border-[#8b8cf7]"
                                        >
                                            <option>系统默认 · 火山引擎适配器</option>
                                            <option>系统默认 · 剧本解析适配器</option>
                                            <option>系统默认 · 剧情分析适配器</option>
                                            <option>系统默认 · 资产解析适配器</option>
                                            <option>系统默认 · 分镜生成适配器</option>
                                        </select>
                                        <ChevronDown size={12} className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[#9da5b7]" />
                                    </div>
                                </div>

                                <div className="mt-3">
                                    <div className="text-[11px] text-[#4d5669]">生成提示</div>
                                    <textarea
                                        value={selectedNode.prompt}
                                        onChange={(event) => updateSelectedNode({ prompt: event.target.value })}
                                        rows={4}
                                        className="mt-1.5 w-full min-h-[92px] rounded-[4px] border border-[#e4e7ef] bg-white px-2.5 py-2 text-[10.5px] leading-[1.65] text-[#4d5669] outline-none focus:border-[#8b8cf7]"
                                    />
                                </div>

                                <div className="mt-3 grid grid-cols-2 gap-2">
                                    <div className="rounded-[4px] border border-[#eef0f5] bg-[#fafbfe] px-2.5 py-2">
                                        <div className="text-[9px] text-[#a1a8b7]">责任范围</div>
                                        <div className="mt-1 text-[10.5px] text-[#4d5669]">{selectedNode.scope}</div>
                                    </div>
                                    <div className="rounded-[4px] border border-[#eef0f5] bg-[#fafbfe] px-2.5 py-2">
                                        <div className="text-[9px] text-[#a1a8b7]">当前版本</div>
                                        <div className="mt-1 text-[10.5px] text-[#4d5669]">{selectedNode.version}</div>
                                    </div>
                                    <div className="rounded-[4px] border border-[#eef0f5] bg-[#fafbfe] px-2.5 py-2">
                                        <div className="text-[9px] text-[#a1a8b7]">审核状态</div>
                                        <div className={`mt-1 flex items-center gap-1 text-[10.5px] ${selectedNode.tone === 'danger' ? 'text-[#e5484d]' : selectedNode.tone === 'warning' ? 'text-[#d89012]' : 'text-[#3e4759]'}`}>
                                            <span className={`w-1.5 h-1.5 rounded-full ${DOT_STYLES[selectedNode.tone]}`} />
                                            {selectedNode.status}
                                        </div>
                                    </div>
                                    <div className="rounded-[4px] border border-[#eef0f5] bg-[#fafbfe] px-2.5 py-2">
                                        <div className="text-[9px] text-[#a1a8b7]">累计费用</div>
                                        <div className="mt-1 text-[10.5px] text-[#4d5669]">{selectedNode.cost}</div>
                                    </div>
                                </div>

                                <div className="mt-4 border-t border-[#eef0f5] pt-3">
                                    <div className="flex items-center justify-between">
                                        <div className="text-[12px] font-medium text-[#3d4557]">审核意见</div>
                                        <button
                                            type="button"
                                            onClick={() => setCommentComposerOpen((value) => !value)}
                                            className="text-[10.5px] text-[#5b5bf6] flex items-center gap-1 hover:text-[#4445d8] transition-colors"
                                        >
                                            <MessageSquare size={12} />
                                            添加
                                        </button>
                                    </div>

                                    <div className="mt-2 space-y-2">
                                        {selectedNode.comments.length === 0 && (
                                            <div className="rounded-[4px] bg-[#f8f9fc] px-3 py-2.5 text-[10.5px] text-[#a0a7b7]">
                                                暂无审核意见
                                            </div>
                                        )}
                                        {selectedNode.comments.map((comment, index) => (
                                            <div key={`${comment.time}-${index}`} className="rounded-[4px] border border-[#f4e8c8] bg-[#fff9e9] px-2.5 py-2.5">
                                                <div className="flex items-center gap-2">
                                                    <span className="w-5 h-5 rounded-full bg-[#b9bdca] flex items-center justify-center text-[8px] text-white">
                                                        {comment.author.slice(0, 1)}
                                                    </span>
                                                    <span className="text-[9.5px] text-[#8f7b4d]">{comment.author} · {comment.role}</span>
                                                </div>
                                                <p className="mt-1.5 text-[10px] leading-[1.65] text-[#806e45]">{comment.content}</p>
                                                <p className="mt-1 text-[9px] text-[#b4a274]">{comment.time}</p>
                                            </div>
                                        ))}
                                    </div>

                                    {commentComposerOpen && (
                                        <div className="mt-2 rounded-[4px] border border-[#e4e7ef] bg-white p-2">
                                            <textarea
                                                value={commentDraft}
                                                onChange={(event) => setCommentDraft(event.target.value)}
                                                rows={2}
                                                placeholder="输入审核意见..."
                                                className="w-full text-[10.5px] leading-[1.6] text-[#4d5669] outline-none"
                                            />
                                            <div className="mt-1.5 flex justify-end gap-1.5">
                                                <button
                                                    type="button"
                                                    onClick={() => { setCommentComposerOpen(false); setCommentDraft(''); }}
                                                    className="h-6 px-2 rounded-[3px] border border-[#e2e5ed] text-[10px] text-[#6f7789] hover:bg-[#f8f9fc]"
                                                >
                                                    取消
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={handleAddComment}
                                                    className="h-6 px-2 rounded-[3px] bg-[#5b5bf6] text-[10px] text-white hover:bg-[#4f4fe9]"
                                                >
                                                    添加
                                                </button>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            </div>

                            <div className="shrink-0 px-3 py-3 border-t border-[#eef0f5] flex items-center gap-2">
                                <button
                                    type="button"
                                    onClick={handleRegenerate}
                                    className="h-8 px-3 rounded-[4px] border border-[#dadde8] bg-white text-[11px] text-[#4c5568] flex items-center justify-center gap-1.5 hover:border-[#bfc6d8] hover:bg-[#fafbfe] transition-colors shrink-0"
                                >
                                    <RefreshCw size={13} />
                                    重新生成
                                </button>
                                <button
                                    type="button"
                                    onClick={handleSubmitNode}
                                    className="h-8 flex-1 rounded-[4px] bg-[#4f51d9] text-white text-[11px] font-medium flex items-center justify-center gap-1.5 hover:bg-[#4143c7] transition-colors"
                                >
                                    <Send size={12} />
                                    提交当前节点审核
                                </button>
                            </div>
                                </>
                            ) : (
                                <div className="flex flex-1 flex-col items-center justify-center px-8 text-center">
                                    <span className="w-10 h-10 rounded-full border border-dashed border-[#d9dee9] flex items-center justify-center text-[#9ca5b7]">
                                        <Circle size={16} />
                                    </span>
                                    <div className="mt-3 text-[13px] font-medium text-[#4b5365]">未选中画布节点</div>
                                    <div className="mt-1.5 text-[12px] leading-5 text-[#9aa2b2]">
                                        点击画布中的节点即可查看配置、删除或提交审核。
                                    </div>
                                </div>
                            )}
                        </aside>
                    </div>
                    <footer className="shrink-0 h-[96px] border-t border-[#e6e9f2] bg-white flex">
                        <div className="w-[278px] shrink-0 px-4 border-r border-[#e9ecf3] flex flex-col justify-center">
                            <div className="flex items-center gap-2">
                                <span className="w-2 h-2 rounded-full bg-[#5b8ff9]" />
                                <span className="text-[12px] font-semibold text-[#343b4d]">生成任务</span>
                            </div>
                            <div className="mt-1.5 text-[10px] text-[#9ca4b5]">3 个进行中，队列状态实时同步</div>
                            <div className="mt-1 flex items-center gap-1 text-[9px] text-[#5b5bf6]">
                                <Sparkles size={10} />
                                智能调度已启用
                            </div>
                        </div>

                        <div className="flex-1 min-w-0 grid grid-cols-3 divide-x divide-[#edf0f5]">
                            {TASKS.map((task) => {
                                const active = activeTaskId === task.id;
                                return (
                                    <button
                                        key={task.id}
                                        type="button"
                                        onClick={() => {
                                            setActiveTaskId(task.id);
                                            selectNode(task.id === 'task-3' ? 'shot-script' : 'shot-video');
                                        }}
                                        className={`min-w-0 px-4 text-left flex flex-col justify-center transition-colors ${active ? 'bg-[#fafbff]' : 'hover:bg-[#fbfbfd]'}`}
                                    >
                                        <div className="flex items-center gap-2 min-w-0">
                                            {task.state === 'done' ? (
                                                <CheckCircle2 size={17} className="text-[#22c55e] shrink-0" />
                                            ) : (
                                                <span className={`w-[17px] h-[17px] rounded-full flex items-center justify-center shrink-0 ${task.state === 'running' ? 'bg-[#eef1ff] text-[#5b5bf6]' : 'bg-[#f2f4f8] text-[#9ba3b3]'}`}>
                                                    {task.state === 'running' ? <RefreshCw size={11} className="animate-spin" /> : <Clock3 size={11} />}
                                                </span>
                                            )}
                                            <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-[#3d4557]">{task.title}</span>
                                        </div>
                                        <div className="mt-1 pl-[25px] text-[9px] text-[#9da5b4] truncate">{task.meta}</div>
                                        <div className="mt-2 pl-[25px] flex items-center gap-2">
                                            <div className="h-1.5 flex-1 rounded-full bg-[#edf0f6] overflow-hidden">
                                                <div
                                                    className={`h-full rounded-full ${task.state === 'done' ? 'bg-[#22c55e]' : 'bg-[#4f7cff]'}`}
                                                    style={{ width: `${task.progress}%` }}
                                                />
                                            </div>
                                            <span className="w-7 text-right text-[9px] text-[#6b7488]">{task.progress}%</span>
                                        </div>
                                    </button>
                                );
                            })}
                        </div>

                        <div className="w-[104px] shrink-0 border-l border-[#e9ecf3] flex items-center justify-center">
                            <button
                                type="button"
                                onClick={() => setDialog('tasks')}
                                className="h-8 w-[62px] rounded-[4px] border border-[#dce0e9] bg-white text-[11px] text-[#515a6d] hover:border-[#bfc6d8] hover:bg-[#fafbfe] transition-colors"
                            >
                                查看
                            </button>
                        </div>
                    </footer>
                </main>
            </div>

            {toast && (
                <div className="studio-toast fixed left-1/2 bottom-[122px] -translate-x-1/2 z-[70] px-4 py-2.5 rounded-lg bg-[#1f2636] text-white text-[12px] shadow-[0_12px_28px_rgba(15,23,42,.24)]">
                    {toast}
                </div>
            )}

            {dialog && (
                <div
                    className="fixed inset-0 z-[80] flex items-center justify-center bg-[#111827]/20 backdrop-blur-[1px] p-6"
                    onMouseDown={(event) => {
                        if (event.target === event.currentTarget) setDialog(null);
                    }}
                >
                    <div
                        className={`w-full ${dialog === 'script' || dialog === 'storyboard' ? 'max-w-[720px]' : 'max-w-[520px]'} max-h-[82vh] rounded-[10px] border border-[#e1e5ef] bg-white shadow-[0_24px_70px_rgba(20,28,50,.22)] flex flex-col overflow-hidden`}
                        onMouseDown={(event) => event.stopPropagation()}
                    >
                        <div className="shrink-0 h-12 px-5 flex items-center justify-between border-b border-[#eef0f5]">
                            <div className="text-[13px] font-semibold text-[#30384a]">{dialogTitle}</div>
                            <button
                                type="button"
                                onClick={() => setDialog(null)}
                                className="w-7 h-7 rounded-[4px] text-[#8f97a9] flex items-center justify-center hover:bg-[#f4f5f9] hover:text-[#555e70] transition-colors"
                                title="关闭"
                            >
                                <X size={15} />
                            </button>
                        </div>

                        <div className="flex-1 min-h-0 overflow-y-auto p-5">
                            {dialog === 'script' && (
                                <div className="grid grid-cols-[minmax(0,1fr)_180px] gap-5">
                                    <div className="space-y-4 text-[11px] leading-[1.9] text-[#4c5568]">
                                        <div>
                                            <div className="mb-1.5 flex items-center gap-2">
                                                <span className="px-1.5 py-0.5 rounded bg-[#f1f2ff] text-[9px] text-[#5b5bf6]">场景 01</span>
                                                <span className="text-[11px] font-semibold text-[#30384a]">雨夜街道 · 外景</span>
                                            </div>
                                            <p>雨水沿着霓虹灯牌落下，街道泛着冷蓝色的光。林夏撑着透明伞站在路口，风衣下摆被夜风吹起。她停下脚步，却没有回头。</p>
                                            <p className="mt-1.5 text-[#8b94a6]">林夏（低声）：如果我今天没有出现，你会不会当作什么都没发生过？</p>
                                        </div>
                                        <div>
                                            <div className="mb-1.5 flex items-center gap-2">
                                                <span className="px-1.5 py-0.5 rounded bg-[#f1f2ff] text-[9px] text-[#5b5bf6]">场景 02</span>
                                                <span className="text-[11px] font-semibold text-[#30384a]">旧公寓 · 内景</span>
                                            </div>
                                            <p>门锁发出轻响。周承站在昏暗的客厅里，手机屏幕的亮光映在他脸上。桌面上散着几张被雨水打湿的照片。</p>
                                            <p className="mt-1.5 text-[#8b94a6]">周承：你终于愿意把那天的事说清楚了。</p>
                                        </div>
                                        <div className="text-[10px] text-[#a0a7b7]">共 12 场 · 2,440 字 · 最近同步于今天 10:22</div>
                                    </div>
                                    <aside className="space-y-2.5">
                                        {[
                                            ['锁定版本', 'V6'],
                                            ['角色引用', '林夏 / 周承 / 陈远'],
                                            ['场景引用', '雨夜街道 / 旧公寓'],
                                            ['镜头预估', '24 个 · 92 秒'],
                                        ].map(([label, value]) => (
                                            <div key={label} className="rounded-[5px] border border-[#edf0f5] bg-[#fafbfe] px-3 py-2.5">
                                                <div className="text-[9px] text-[#a0a7b7]">{label}</div>
                                                <div className="mt-1 text-[10.5px] text-[#4b5467]">{value}</div>
                                            </div>
                                        ))}
                                    </aside>
                                </div>
                            )}

                            {dialog === 'storyboard' && (
                                <div>
                                    <div className="rounded-[6px] border border-[#f2e5c2] bg-[#fff9e9] px-3 py-2.5 text-[10.5px] leading-[1.65] text-[#8c7646]">
                                        将基于当前剧本与资产引用生成 {STORYBOARD_SHOTS.length} 个演示镜头。角色“陈远”尚未确认，正式生成前会再次校验资产门禁。
                                    </div>
                                    <div className="mt-3 divide-y divide-[#eef0f5] rounded-[6px] border border-[#e8ebf2] overflow-hidden">
                                        {STORYBOARD_SHOTS.map((shot) => (
                                            <div key={shot.no} className="flex items-center gap-3 px-3 py-2.5">
                                                <span className="w-7 h-7 rounded-[5px] bg-[#eef0ff] text-[#5b5bf6] text-[10px] font-semibold flex items-center justify-center">{shot.no}</span>
                                                <div className="flex-1 min-w-0">
                                                    <div className="text-[11px] font-medium text-[#3e4658]">镜头 {shot.no} · {shot.title}</div>
                                                    <div className="mt-0.5 text-[9.5px] text-[#9aa2b2]">{shot.camera}</div>
                                                </div>
                                                <div className="text-[10px] text-[#6f7789]">{shot.duration}</div>
                                                <CheckCircle2 size={15} className="text-[#aab1bf]" />
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {dialog === 'versions' && (
                                <div className="space-y-2">
                                    {[
                                        { version: 'V6', time: '今天 10:24', author: '林雪琪', note: '当前版本 · 调整字幕时间轴', active: true },
                                        { version: 'V5', time: '今天 09:58', author: '林雪琪', note: '重生成镜头 18-20 的候选视频' },
                                        { version: 'V4', time: '昨天 18:32', author: '周承', note: '同步第 1 集镜头脚本与角色资产' },
                                        { version: 'V3', time: '昨天 16:10', author: '系统', note: '首次生成完整分集画布' },
                                    ].map((version) => (
                                        <div key={version.version} className={`flex items-center gap-3 rounded-[5px] border px-3 py-2.5 ${version.active ? 'border-[#c9cbff] bg-[#f7f7ff]' : 'border-[#edf0f5] bg-white'}`}>
                                            <span className={`w-8 h-8 rounded-[5px] text-[10px] font-semibold flex items-center justify-center ${version.active ? 'bg-[#5b5bf6] text-white' : 'bg-[#f1f3f8] text-[#7a8396]'}`}>{version.version}</span>
                                            <div className="flex-1 min-w-0">
                                                <div className="text-[10.5px] text-[#444d5f]">{version.note}</div>
                                                <div className="mt-0.5 text-[9px] text-[#9fa7b6]">{version.author} · {version.time}</div>
                                            </div>
                                            {version.active && <span className="text-[9px] text-[#5b5bf6]">当前</span>}
                                        </div>
                                    ))}
                                </div>
                            )}

                            {dialog === 'tasks' && (
                                <div className="space-y-2.5">
                                    {TASKS.map((task) => (
                                        <button
                                            key={task.id}
                                            type="button"
                                            onClick={() => setActiveTaskId(task.id)}
                                            className={`w-full rounded-[6px] border px-3 py-3 text-left transition-colors ${activeTaskId === task.id ? 'border-[#c9cbff] bg-[#f8f8ff]' : 'border-[#e9ecf3] bg-white hover:bg-[#fafbfe]'}`}
                                        >
                                            <div className="flex items-center justify-between gap-3">
                                                <div className="text-[11px] font-medium text-[#3d4557]">{task.title}</div>
                                                <span className={`text-[9px] ${task.state === 'done' ? 'text-[#22a55a]' : 'text-[#6f7789]'}`}>{task.state === 'done' ? '已完成' : task.state === 'queued' ? '排队中' : '生成中'}</span>
                                            </div>
                                            <div className="mt-1 text-[9.5px] text-[#9aa2b2]">{task.meta}</div>
                                            <div className="mt-2 flex items-center gap-2">
                                                <div className="h-1.5 flex-1 rounded-full bg-[#edf0f6] overflow-hidden">
                                                    <div className={`h-full rounded-full ${task.state === 'done' ? 'bg-[#22c55e]' : 'bg-[#4f7cff]'}`} style={{ width: `${task.progress}%` }} />
                                                </div>
                                                <span className="w-8 text-right text-[9px] text-[#6b7488]">{task.progress}%</span>
                                            </div>
                                        </button>
                                    ))}
                                </div>
                            )}

                            {dialog === 'shots' && (
                                <div className="space-y-2.5">
                                    {STORYBOARD_SHOTS.slice(1, 5).map((shot, index) => (
                                        <div key={shot.no} className="flex items-center gap-3 rounded-[6px] border border-[#e9ecf3] bg-white p-2.5">
                                            <div className={`w-16 h-10 rounded-[4px] bg-gradient-to-br ${index % 2 === 0 ? 'from-[#3d506c] via-[#63758e] to-[#151e2d]' : 'from-[#a98f70] via-[#c7b398] to-[#635343]'} flex items-center justify-center`}>
                                                <Video size={15} className="text-white/85" />
                                            </div>
                                            <div className="flex-1 min-w-0">
                                                <div className="text-[10.5px] font-medium text-[#41495b]">镜头 {shot.no} · {shot.title}</div>
                                                <div className="mt-0.5 text-[9px] text-[#9ba3b3]">{shot.camera} · {shot.duration}</div>
                                            </div>
                                            <span className={`px-1.5 py-0.5 rounded text-[8.5px] ${index === 0 ? 'bg-[#eaf2ff] text-[#2f74ff]' : 'bg-[#eaf8ef] text-[#22a55a]'}`}>{index === 0 ? '生成中' : '已生成'}</span>
                                            <button type="button" onClick={() => showToast(`已选择镜头 ${shot.no} 的当前版本`)} className="text-[9px] text-[#5b5bf6] hover:text-[#4344cc]">选择</button>
                                        </div>
                                    ))}
                                </div>
                            )}

                            {dialog === 'review' && (
                                <div>
                                    <div className="rounded-[6px] border border-[#e8ebf2] bg-[#fafbfe] px-3.5 py-3">
                                        <div className="text-[11px] font-medium text-[#3c4456]">第 {String(episodeNo).padStart(2, '0')} 集 · 本集审核</div>
                                        <div className="mt-1 text-[10px] text-[#929aab]">提交后当前节点会进入审核流程，项目主管将收到待办通知。</div>
                                    </div>
                                    <div className="mt-3 space-y-2">
                                        {[
                                            { label: '剧本与分镜', value: '已通过', ok: true },
                                            { label: '角色与场景资产', value: warningDismissed ? '已通过' : '1 项待确认', ok: warningDismissed },
                                            { label: '镜头视频', value: '18 / 24 已生成', ok: true },
                                            { label: '字幕与时间轴', value: '2 处待确认', ok: false },
                                        ].map((item) => (
                                            <div key={item.label} className="flex items-center justify-between rounded-[5px] border border-[#edf0f5] px-3 py-2 text-[10.5px]">
                                                <span className="text-[#596275]">{item.label}</span>
                                                <span className={`flex items-center gap-1 ${item.ok ? 'text-[#22a55a]' : 'text-[#d89012]'}`}>
                                                    {item.ok ? <CheckCircle2 size={12} /> : <AlertTriangle size={12} />}
                                                    {item.value}
                                                </span>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {dialog === 'asset' && selectedAsset && (
                                <div>
                                    <div className="flex gap-3">
                                        <div className={`w-20 h-24 rounded-[6px] bg-gradient-to-br ${selectedAsset.accent} flex items-end justify-center pb-2 text-[10px] text-white/90`}>
                                            {selectedAsset.name}
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <div className="flex items-center gap-2">
                                                <div className="text-[14px] font-semibold text-[#30384a]">{selectedAsset.name}</div>
                                                <span className={`px-1.5 py-0.5 rounded text-[8.5px] ${TONE_STYLES[selectedAsset.tone]}`}>{selectedAsset.status}</span>
                                            </div>
                                            <div className="mt-1 text-[10px] text-[#9098aa]">{selectedAsset.role}</div>
                                            <div className="mt-2 text-[10.5px] leading-[1.7] text-[#626b7e]">{selectedAsset.detail}</div>
                                            <div className="mt-2 rounded-[4px] bg-[#f7f8fc] px-2.5 py-2 text-[9.5px] text-[#8f97a8]">引用范围：第 01 集 · 场景 01、场景 03</div>
                                        </div>
                                    </div>
                                    {!warningDismissed && (
                                        <div className="mt-3 rounded-[5px] border border-[#f4e7c4] bg-[#fff9e9] px-3 py-2.5 text-[10px] leading-[1.7] text-[#8b7647]">
                                            确认后将锁定该角色的造型与视觉特征，可用于正式分镜和镜头视频生成。
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>

                        <div className="shrink-0 px-5 py-3 border-t border-[#eef0f5] flex items-center justify-end gap-2 bg-[#fbfcfe]">
                            <button
                                type="button"
                                onClick={() => setDialog(null)}
                                className="h-8 px-3.5 rounded-[4px] border border-[#dfe3ed] bg-white text-[11px] text-[#5d6678] hover:border-[#bfc6d8] hover:bg-[#fafbfe] transition-colors"
                            >
                                {dialog === 'review' || dialog === 'storyboard' ? '取消' : '关闭'}
                            </button>
                            {dialog !== 'script' && dialog !== 'versions' && dialog !== 'tasks' && dialog !== 'shots' && (
                                <button
                                    type="button"
                                    onClick={handleDialogPrimary}
                                    className="h-8 px-4 rounded-[4px] bg-[#5b5bf6] text-white text-[11px] font-medium hover:bg-[#4f4fe9] transition-colors"
                                >
                                    {dialogPrimaryLabel}
                                </button>
                            )}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default ProjectCanvasStudioPage;
