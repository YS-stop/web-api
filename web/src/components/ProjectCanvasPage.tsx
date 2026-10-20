/**
 * ProjectCanvasPage.tsx
 *
 * 项目专属画布（与自由画布 /canvas 完全分离）。
 * 从「项目列表」进入某个项目后，这里展示该项目的：
 *   - 项目信息（名称 / 编号 / 阶段 / 分集进度）
 *   - 剧本分集（每集标题 / 概要 / 原文）
 *   - 资产内容（人物 / 场景 / 道具）
 *   - 左侧工具栏（可缩放 + 剧本/资产入口）
 * 画布上可以围绕每一集搭建「文本 → 图片 → 视频」的节点流，实现每集视频。
 */

import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
    ArrowLeft,
    Plus,
    BookOpen,
    ZoomIn,
    ZoomOut,
    Users,
    MapPin,
    Package,
    Loader2,
    FileText,
    Film,
    X,
    Search,
    Type,
    Image as ImageIcon,
    LayoutTemplate,
    Video,
    Sparkles,
    Save,
    ChevronUp,
    ChevronDown,
    Layers,
} from 'lucide-react';
import { Project, fetchProject } from '../services/projectService';
import { AnalyzedEpisode, ScriptAnalysis, formatDurationSeconds } from '../services/scriptAnalysisService';
import { useCanvasNavigation } from '../hooks/useCanvasNavigation';
import { useNodeManagement } from '../hooks/useNodeManagement';
import { useNodeDragging } from '../hooks/useNodeDragging';
import { useConnectionDragging } from '../hooks/useConnectionDragging';
import { useSelectionBox } from '../hooks/useSelectionBox';
import { useGeneration } from '../hooks/useGeneration';
import { useTextNodeHandlers } from '../hooks/useTextNodeHandlers';
import { useImageNodeHandlers } from '../hooks/useImageNodeHandlers';
import { useVideoMerge } from '../hooks/useVideoMerge';
import { VideoMergePanel } from './modals/VideoMergePanel';
import { buildShotNodes, buildShotNodesRemote, countImportableShots } from '../services/shotImportService';
import { CanvasNode } from './canvas/CanvasNode';
import { ConnectionsLayer } from './canvas/ConnectionsLayer';
import { NodeData, NodeType, NodeStatus, Viewport } from '../types';
import { AssetLibraryPanel } from './AssetLibraryPanel';
import { TemplateLibraryPanel, WorkflowTemplate } from './TemplateLibraryPanel';
import { ChatPanel, ChatBubble } from './ChatPanel';
import { loadAssetStore } from './AssetConfirmPanel';
import { ShotPanel } from './ShotPanel';
import { ShotState, writeBackShotVideo, getEpisodeShots, RefAssets } from '../services/shotService';
import { buildShotChain, buildShotsChain, placeChainOrigin } from '../services/shotToCanvasService';
import { getGenerationStatus, getVideoTaskStatus } from '../services/generationService';
import { extractVideoLastFrame } from '../utils/videoHelpers';
import { addCanvasJob, removeCanvasJob, getEpisodeCanvasJobs, loadCanvasJobs, updateCanvasJob } from '../services/canvasJobStore';
import { DEFAULT_IMAGE_MODEL, DEFAULT_VIDEO_MODEL } from '../constants/modelDefaults';

// ============================================================================
// 常量
// ============================================================================

const STATUS_STYLE: Record<string, string> = {
    制作中: 'bg-[#e8f1ff] text-[#1677ff]',
    已完成: 'bg-[#e8ffea] text-[#00b42a]',
    审核中: 'bg-[#fff3e8] text-[#ff7d00]',
    待启动: 'bg-[#f2f3f5] text-[#86909c]',
};

const ASSET_META = {
    characters: { label: '人物', icon: Users, color: 'text-violet-300 bg-violet-500/15' },
    scenes: { label: '场景', icon: MapPin, color: 'text-emerald-300 bg-emerald-500/15' },
    props: { label: '道具', icon: Package, color: 'text-amber-300 bg-amber-500/15' },
} as const;

type AssetKey = keyof typeof ASSET_META;

/**
 * 画布资产面板展示项：
 * 兼容「资产确认」的 EditableAsset（含造型 looks）与剧本解析的 AssetItem。
 */
type CanvasAssetItem = {
    name: string;
    /** 角色别名：分镜里的出场角色可能写成小名，匹配参考图时要认 */
    aliases?: string[];
    description?: string;
    imageUrl?: string;
    looks?: { name?: string; imageUrl?: string }[];
};

/** 左侧面板 Tab：分集 / 全剧资产 / 当前集的人物、场景、道具 */
type PanelTab = 'episodes' | 'shots' | 'assets' | 'characters' | 'scenes' | 'props';

/** 像素尺寸 → 最接近的标准图片比例 */
const getClosestAspectRatio = (width: number, height: number): string => {
    const ratio = width / height;
    const standardRatios = [
        { label: '1:1', value: 1 },
        { label: '16:9', value: 16 / 9 },
        { label: '9:16', value: 9 / 16 },
        { label: '4:3', value: 4 / 3 },
        { label: '3:4', value: 3 / 4 },
        { label: '3:2', value: 3 / 2 },
        { label: '2:3', value: 2 / 3 },
    ];
    let closest = standardRatios[0];
    let minDiff = Math.abs(ratio - closest.value);
    for (const r of standardRatios) {
        const diff = Math.abs(ratio - r.value);
        if (diff < minDiff) {
            minDiff = diff;
            closest = r;
        }
    }
    return closest.label;
};

/** 像素尺寸 → 视频比例（仅 16:9 或 9:16） */
const getClosestVideoAspectRatio = (width: number, height: number): string => {
    return width / height >= 1 ? '16:9' : '9:16';
};

interface ContextMenuState {
    isOpen: boolean;
    x: number;
    y: number;
    nodeId?: string;
}

// ============================================================================
// 组件
// ============================================================================

interface ProjectCanvasPageProps {
    projectId: string;
    onBack: () => void;
}

export const ProjectCanvasPage: React.FC<ProjectCanvasPageProps> = ({ projectId, onBack }) => {
    // ---------- 项目数据 ----------
    const [project, setProject] = useState<Project | null>(null);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState('');

    // ---------- 剧本/资产面板 ----------
    const [scriptPanelOpen, setScriptPanelOpen] = useState(true);
    const [panelTab, setPanelTab] = useState<PanelTab>('episodes');
    const [activeEpisode, setActiveEpisode] = useState(0);
    const [episodeSearch, setEpisodeSearch] = useState('');
    const [toolbarCollapsed, setToolbarCollapsed] = useState(true);
    const [headerCollapsed, setHeaderCollapsed] = useState(false);
    const [assetLibraryOpen, setAssetLibraryOpen] = useState(false);
    const [templateLibraryOpen, setTemplateLibraryOpen] = useState(false);
    const [isChatOpen, setIsChatOpen] = useState(false);
    const [isDraggingNodeToChat, setIsDraggingNodeToChat] = useState(false);
    /** 分镜导入结果提示（3 秒后自动消失） */
    const [shotsImportTip, setShotsImportTip] = useState<string | null>(null);
    /** 当前画布已加载完成的集号（用于「进入画布自动识别分镜」） */
    const [canvasReadyKey, setCanvasReadyKey] = useState<string | null>(null);

    // ---------- 画布 hooks ----------
    const { viewport, setViewport, canvasRef, handleWheel, handleSliderZoom } = useCanvasNavigation();
    const { nodes, setNodes, selectedNodeIds, setSelectedNodeIds, updateNode, deleteNode, clearSelection } =
        useNodeManagement();
    const {
        handleNodePointerDown,
        updateNodeDrag,
        endNodeDrag,
        startPanning,
        updatePanning,
        endPanning,
        releasePointerCapture,
    } = useNodeDragging();
    const {
        isDraggingConnection,
        connectionStart,
        tempConnectionEnd,
        hoveredNodeId: connectionHoveredNodeId,
        selectedConnection,
        setSelectedConnection,
        handleConnectorPointerDown,
        updateConnectionDrag,
        completeConnectionDrag,
        handleEdgeClick,
    } = useConnectionDragging();
    const { selectionBox, isSelecting, startSelection, updateSelection, endSelection } = useSelectionBox();

    // ---------- 生成任务台账（离开画布后仍可恢复结果） ----------
    /** 当前集号（供 useGeneration 回调读取，避免声明顺序问题） */
    const activeEpisodeNoRef = useRef<number | null>(null);
    /** 画布落盘函数（同上，延迟挂载） */
    const persistEpisodeRef = useRef<((episode: number, epNodes: NodeData[], epViewport: Viewport) => Promise<boolean>) | null>(null);
    /** 组件是否仍挂载：卸载后保留台账，交给下次进入画布认领结果 */
    const mountedRef = useRef(true);
    useEffect(() => {
        // StrictMode 下开发环境会 mount → unmount → mount，这里必须重新置位
        mountedRef.current = true;
        return () => { mountedRef.current = false; };
    }, []);

    const { handleGenerate } = useGeneration({
        nodes,
        updateNode,
        channel: 'project',
        onVideoJobStart: (node) => {
            const ep = activeEpisodeNoRef.current;
            if (ep == null) return;
            addCanvasJob(projectId, {
                nodeId: node.id,
                episode: ep,
                startedAt: Date.now(),
                model: node.videoModel,
                prompt: node.prompt?.slice(0, 80),
            });
            // 先把画布落盘：否则离开后回来节点不存在，恢复时无处回填结果
            persistEpisodeRef.current?.(ep, nodesRef.current, viewportRef.current);
        },
        onVideoJobEnd: (nodeId, outcome) => {
            if (outcome === 'error') {
                const failedJob = loadCanvasJobs(projectId).find((j) => j.nodeId === nodeId);
                // Seedance 任务由服务端裁定最终状态：保留台账，下次进入画布按 taskId 确认
                // （厂商失败会立即返回 failed；若只是前端超时，服务端可能稍后完成并落盘）
                if (!failedJob?.taskId) removeCanvasJob(projectId, nodeId);
                return;
            }

            const job = loadCanvasJobs(projectId).find((j) => j.nodeId === nodeId);
            const currentEp = activeEpisodeNoRef.current;
            // 结果属于发起生成的那一集：若用户已切到别的集，保留台账，切回该集时再恢复
            if (!job || currentEp == null || Number(job.episode) !== Number(currentEp)) {
                return;
            }
            // 节点已被删除：没必要再恢复
            if (!nodesRef.current.some((n) => n.id === nodeId)) {
                removeCanvasJob(projectId, nodeId);
                return;
            }

            // 成功：等节点状态写入后再落盘并清台账；若此时已卸载则保留台账留给恢复
            setTimeout(async () => {
                if (!mountedRef.current) return;
                await persistEpisodeRef.current?.(Number(job.episode), nodesRef.current, viewportRef.current);
                removeCanvasJob(projectId, nodeId);
            }, 400);
        },
        onVideoTaskSubmitted: (nodeId, taskId) => {
            // 记下服务端任务 id：离开页面后可按任务状态恢复（失败原因也能拿到）
            updateCanvasJob(projectId, nodeId, { taskId });
        },
    });

    // 文本 / 图片节点快捷操作（写内容 / 文生图 / 文生视频 / 图生图 / 图生视频 / 换角度）
    const { handleWriteContent, handleTextToVideo, handleTextToImage } = useTextNodeHandlers({
        nodes,
        updateNode,
        setNodes,
        setSelectedNodeIds,
    });
    const { handleImageToImage, handleImageToVideo, handleChangeAngleGenerate } = useImageNodeHandlers({
        nodes,
        setNodes,
        setSelectedNodeIds,
        onGenerateNode: handleGenerate,
    });

    // 视频合并成片（VIDEO_MERGE 节点）
    const {
        mergeModal,
        isMerging,
        mergeError,
        currentClips,
        currentNode: mergeCurrentNode,
        handleOpenMerge,
        handleCloseMerge,
        handleReorderClips,
        handleMerge,
    } = useVideoMerge({ nodes, updateNode });

    const handleGenerateRef = useRef(handleGenerate);
    useEffect(() => {
        handleGenerateRef.current = handleGenerate;
    }, [handleGenerate]);

    // 分镜导入提示 3 秒后自动消失
    useEffect(() => {
        if (!shotsImportTip) return;
        const timer = setTimeout(() => setShotsImportTip(null), 3000);
        return () => clearTimeout(timer);
    }, [shotsImportTip]);

    // 阻止浏览器默认的 Ctrl/Cmd + 滚轮页面缩放（画布缩放由 handleWheel 自行处理）
    useEffect(() => {
        const handleNativeWheel = (e: WheelEvent) => {
            if (e.ctrlKey || e.metaKey) {
                e.preventDefault();
            }
        };
        window.addEventListener('wheel', handleNativeWheel, { passive: false });
        return () => window.removeEventListener('wheel', handleNativeWheel);
    }, []);

    // ---------- 画布持久化（按 projectId + 集号 加载 / 保存，分集隔离） ----------
    const initializedRef = useRef(false);
    const skipMarkRef = useRef(false);
    const [saveState, setSaveState] = useState<'saving' | 'saved' | 'idle'>('saved');

    // 每集画布内存缓存：集号 -> { nodes, viewport }，切集时快速往返、避免重复请求
    const episodeCanvasCacheRef = useRef<Record<string, { nodes: NodeData[]; viewport: Viewport }>>({});
    // 追踪最新 nodes / viewport，供切集时写回缓存（避免闭包拿到旧值）
    const nodesRef = useRef<NodeData[]>([]);
    const viewportRef = useRef<Viewport>({ x: 0, y: 0, zoom: 1 });
    nodesRef.current = nodes;
    viewportRef.current = viewport;

    // 节点 / 视口发生变化时，仅标记为「未保存」，不自动保存
    useEffect(() => {
        if (!initializedRef.current) return;
        if (skipMarkRef.current) {
            skipMarkRef.current = false;
            return;
        }
        setSaveState('idle');
    }, [nodes, viewport]);

    // 持久化某一集画布（手动保存与切集自动保存复用）
    const persistEpisode = async (episode: number, epNodes: NodeData[], epViewport: Viewport) => {
        try {
            const res = await fetch(`/api/project-workflows/${encodeURIComponent(projectId)}/${encodeURIComponent(episode)}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ nodes: epNodes, viewport: epViewport }),
            });
            return res.ok;
        } catch {
            return false;
        }
    };

    // 让 useGeneration 的任务回调能拿到最新落盘函数
    persistEpisodeRef.current = persistEpisode;

    // 加载指定集号画布（优先内存缓存，其次后端；未保存过则清空画布）
    const loadEpisodeCanvas = (episode: number) => {
        const key = String(episode);
        const cached = episodeCanvasCacheRef.current[key];
        if (cached) {
            skipMarkRef.current = true;
            setNodes(cached.nodes);
            setViewport(cached.viewport);
            setCanvasReadyKey(key);
            return;
        }
        setCanvasReadyKey(null);
        fetch(`/api/project-workflows/${encodeURIComponent(projectId)}/${encodeURIComponent(episode)}`)
            .then((r) => (r.ok ? r.json() : null))
            .then((data) => {
                const nextNodes: NodeData[] = data && Array.isArray(data.nodes) ? data.nodes : [];
                const nextViewport: Viewport = (data && data.viewport) || { x: 0, y: 0, zoom: 1 };
                episodeCanvasCacheRef.current[key] = { nodes: nextNodes, viewport: nextViewport };
                skipMarkRef.current = true; // 恢复期间不标记为未保存
                setNodes(nextNodes);
                setViewport(nextViewport);
                setCanvasReadyKey(key);
            })
            .catch(() => {})
            .finally(() => {
                initializedRef.current = true;
            });
    };

    // ---------- 右键菜单 ----------
    const [contextMenu, setContextMenu] = useState<ContextMenuState>({ isOpen: false, x: 0, y: 0 });

    // ---------- 加载项目 ----------
    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        setLoadError('');
        fetchProject(projectId)
            .then((p) => {
                if (!cancelled) setProject(p);
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

    const analysis: ScriptAnalysis | null = project?.scriptAnalysis || null;
    const episodes = analysis?.episodes || [];
    const globalAssets = analysis?.assets || { characters: [], scenes: [], props: [] };

    // ---------- 资产确认数据（继承工作流，按集隔离） ----------
    // 画布侧直接读取工作流「资产确认」的结果；每集独立取用，互不污染。
    const assetStore = useMemo(() => loadAssetStore(projectId), [projectId]);
    const currentEpisodeNo = episodes[activeEpisode]?.episode;

    /** 当前集资产：优先「资产确认」结果（含生成图/造型），缺失时回退剧本解析的原始资产 */
    const currentEpisodeAssets: Record<AssetKey, CanvasAssetItem[]> = useMemo(() => {
        const fallback = episodes[activeEpisode]?.assets;
        const confirmed = currentEpisodeNo != null ? assetStore?.[currentEpisodeNo] : undefined;
        const pick = (key: AssetKey): CanvasAssetItem[] => {
            const fromStore = confirmed?.[key];
            if (fromStore && fromStore.length > 0) return fromStore as CanvasAssetItem[];
            const fromScript = fallback?.[key];
            return (fromScript || []) as CanvasAssetItem[];
        };
        return { characters: pick('characters'), scenes: pick('scenes'), props: pick('props') };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [episodes, activeEpisode, currentEpisodeNo, assetStore]);

    /** 取资产可用的图片：主图优先，其次任一造型图 */
    const getAssetImageUrl = (item: CanvasAssetItem): string | undefined =>
        item.imageUrl || item.looks?.find((l) => l.imageUrl)?.imageUrl;

    /**
     * 分镜参考图匹配数据源：用「资产确认」里已生成图片的资产。
     * 剧本解析的 assets 只有名字没有图，直接匹配会导致人物参考图节点建不出来。
     */
    const shotRefAssets: RefAssets = useMemo(() => {
        const pick = (list: CanvasAssetItem[]) => list.map((a) => ({
            name: a.name,
            aliases: a.aliases,
            imageUrl: a.imageUrl,
            looks: a.looks?.map((l) => ({ imageUrl: l.imageUrl })),
        }));
        return {
            characters: pick(currentEpisodeAssets.characters),
            scenes: pick(currentEpisodeAssets.scenes),
            props: pick(currentEpisodeAssets.props),
        };
    }, [currentEpisodeAssets]);

    const filteredEpisodes = useMemo(() => {
        const kw = episodeSearch.trim().toLowerCase();
        if (!kw) return episodes;
        return episodes.filter((e) => (e.title + String(e.episode)).toLowerCase().includes(kw));
    }, [episodes, episodeSearch]);

    const currentEpisode: AnalyzedEpisode | undefined = episodes[activeEpisode];
    // 供 useGeneration 的任务台账回调读取当前集
    activeEpisodeNoRef.current = currentEpisode?.episode ?? null;

    // 首次项目就绪 + 切换集号时，加载对应集画布
    useEffect(() => {
        const ep = episodes[activeEpisode];
        if (!ep) return;
        loadEpisodeCanvas(ep.episode);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeEpisode, project]);

    // 手动保存当前集画布
    const handleSave = async () => {
        if (saveState === 'saving') return;
        const ep = episodes[activeEpisode];
        if (!ep) return;
        setSaveState('saving');
        const ok = await persistEpisode(ep.episode, nodes, viewport);
        setSaveState(ok ? 'saved' : 'idle');
    };

    // 切换分集：先缓存并自动保存当前集，再切到目标集（目标集由上面的 effect 加载）
    const switchEpisode = (targetIdx: number) => {
        if (targetIdx === activeEpisode) return;
        const curEp = episodes[activeEpisode];
        if (curEp) {
            const key = String(curEp.episode);
            episodeCanvasCacheRef.current[key] = { nodes: nodesRef.current, viewport: viewportRef.current };
            // 切集自动保存当前集，避免忘记保存导致丢失
            persistEpisode(curEp.episode, nodesRef.current, viewportRef.current);
        }
        setSaveState('saved');
        setActiveEpisode(targetIdx);
    };

    // ---------- 节点操作 ----------
    const addCustomNode = (node: NodeData) => {
        setNodes((prev) => [...prev, node]);
        setSelectedNodeIds([node.id]);
    };

    /** 在画布中心添加一个节点 */
    const addNodeAtCenter = (type: NodeType) => {
        const centerX = (window.innerWidth / 2 - viewport.x) / viewport.zoom - 170;
        const centerY = (window.innerHeight / 2 - viewport.y) / viewport.zoom - 100;
        const isVideo = type === NodeType.VIDEO;
        const node: NodeData = {
            id: crypto.randomUUID(),
            type,
            x: centerX,
            y: centerY,
            prompt: '',
            status: NodeStatus.IDLE,
            model: isVideo ? DEFAULT_VIDEO_MODEL : DEFAULT_IMAGE_MODEL,
            imageModel: type === NodeType.IMAGE ? DEFAULT_IMAGE_MODEL : undefined,
            videoModel: isVideo ? DEFAULT_VIDEO_MODEL : undefined,
            aspectRatio: project?.aspectRatio || '9:16',
            resolution: isVideo ? '720p' : '1K',
            parentIds: [],
        };
        addCustomNode(node);
    };

    /** 连接器短按：在右侧新增图片节点并建立连接 */
    const handleAddNext = (id: string, direction: 'left' | 'right') => {
        const source = nodes.find((n) => n.id === id);
        if (!source) return;
        const GAP = 100;
        const NODE_WIDTH = 340;
        const node: NodeData = {
            id: crypto.randomUUID(),
            type: NodeType.IMAGE,
            x: direction === 'right' ? source.x + NODE_WIDTH + GAP : source.x - NODE_WIDTH - GAP,
            y: source.y,
            prompt: '',
            status: NodeStatus.IDLE,
            model: DEFAULT_IMAGE_MODEL,
            imageModel: DEFAULT_IMAGE_MODEL,
            aspectRatio: project?.aspectRatio || '9:16',
            resolution: '1K',
            parentIds: direction === 'right' ? [id] : [],
        };
        addCustomNode(node);
    };

    /** 连接完成：文本节点向子节点同步提示词 */
    const handleConnectionMade = (parentId: string, childId: string) => {
        const parent = nodes.find((n) => n.id === parentId);
        if (parent?.type === NodeType.TEXT && parent.prompt) {
            updateNode(childId, { prompt: parent.prompt });
        }
    };

    /** 把某一集的剧本内容作为文本节点放到画布 */
    const handleAddEpisodeText = (ep: AnalyzedEpisode) => {
        const centerX = (window.innerWidth / 2 - viewport.x) / viewport.zoom - 170;
        const centerY = (window.innerHeight / 2 - viewport.y) / viewport.zoom - 100;
        const prompt = [
            `《${project?.dramaName || ''}》第 ${ep.episode} 集 ${ep.title}`,
            ep.summary,
            ep.content,
        ]
            .filter(Boolean)
            .join('\n\n');
        addCustomNode({
            id: crypto.randomUUID(),
            type: NodeType.TEXT,
            x: centerX,
            y: centerY,
            title: `第 ${ep.episode} 集 ${ep.title}`,
            prompt,
            status: NodeStatus.IDLE,
            model: '',
            aspectRatio: 'Auto',
            resolution: 'Auto',
            parentIds: [],
        });
    };

    /** 为该集生成视频节点（并自动触发生成） */
    const handleGenerateEpisodeVideo = (ep: AnalyzedEpisode) => {
        if (!project) return;
        const centerX = (window.innerWidth / 2 - viewport.x) / viewport.zoom - 190;
        const centerY = (window.innerHeight / 2 - viewport.y) / viewport.zoom - 120;
        const prompt = [
            `《${project.dramaName}》第 ${ep.episode} 集 ${ep.title}`,
            ep.summary,
        ]
            .filter(Boolean)
            .join('\n');
        const node: NodeData = {
            id: crypto.randomUUID(),
            type: NodeType.VIDEO,
            x: centerX,
            y: centerY,
            title: `第 ${ep.episode} 集 ${ep.title}`,
            prompt,
            status: NodeStatus.IDLE,
            model: DEFAULT_VIDEO_MODEL,
            videoModel: DEFAULT_VIDEO_MODEL,
            videoDuration: 5,
            aspectRatio: project.aspectRatio || '9:16',
            resolution: '720p',
            parentIds: [],
        };
        addCustomNode(node);
        setTimeout(() => handleGenerateRef.current(node.id), 120);
    };

    /**
     * 把工作流「分镜片段」里已生成的片段导入当前集画布。
     *
     * 数据源是 ShotEditorPanel 写在 localStorage 的 shot-editor:<projectId>，
     * 按集号取，所以每集导入的片段天然隔离。
     *
     * 导入后会自动为本集建一个 VIDEO_MERGE 节点，父节点按分镜顺序连好，
     * 用户双击即可一键拼成整集成片。
     */
    const handleImportEpisodeShots = async (ep: AnalyzedEpisode) => {
        const importParams = {
            projectId,
            episode: ep.episode,
            // 放在当前视口中心偏左上，避免遮挡已有节点
            originX: (window.innerWidth / 2 - viewport.x) / viewport.zoom - 400,
            originY: (window.innerHeight / 2 - viewport.y) / viewport.zoom - 200,
            aspectRatio: project?.aspectRatio || '9:16',
            includeImages: true,
            createMergeNode: true,
            existingNodes: nodes,
        };

        // 优先走后端转换（规则集中），后端不可用时回落本地实现
        const result =
            (await buildShotNodesRemote(importParams)) ?? buildShotNodes(importParams);

        if (result.nodes.length === 0) {
            setShotsImportTip(
                `第 ${ep.episode} 集没有可导入的分镜片段（请先在工作流里生成分镜视频）`
            );
            return;
        }

        setNodes((prev) => [...prev, ...result.nodes]);
        setSelectedNodeIds(result.mergeNodeId ? [result.mergeNodeId] : [result.nodes[0].id]);

        const parts = [];
        if (result.videoCount > 0) parts.push(`${result.videoCount} 个视频`);
        if (result.imageCount > 0) parts.push(`${result.imageCount} 张分镜图`);
        if (result.mergeNodeId) parts.push('已自动建好合并节点');
        setShotsImportTip(`第 ${ep.episode} 集导入完成：${parts.join('，')}`);
    };

    // ---------- 分镜面板 → 画布 ----------
    /** 当前视图中心在画布坐标系里的位置（作为链路起点） */
    const getCanvasOrigin = () => ({
        x: (window.innerWidth / 2 - viewport.x) / viewport.zoom - 340,
        y: (window.innerHeight / 2 - viewport.y) / viewport.zoom - 200,
    });

    /**
     * 把新链路整体平移到不与现有节点重叠的位置。
     * 链路内部相对位置保持不变（参考图仍在视频节点左侧并垂直居中）。
     */
    const placeNewChain = (built: NodeData[], origin: { x: number; y: number }): NodeData[] => {
        if (built.length === 0) return built;
        const minX = Math.min(...built.map((n) => n.x));
        const maxX = Math.max(...built.map((n) => n.x + 360));
        const minY = Math.min(...built.map((n) => n.y));
        const maxY = Math.max(...built.map((n) => n.y + 430));
        const target = placeChainOrigin(nodesRef.current, origin, {
            width: Math.max(360, maxX - minX),
            height: Math.max(430, maxY - minY),
        });
        const dx = target.x - origin.x;
        const dy = target.y - origin.y;
        if (dx === 0 && dy === 0) return built;
        return built.map((n) => ({ ...n, x: n.x + dx, y: n.y + dy }));
    };

    /** 把视口对准刚加入的链路，避免节点落在屏幕外找不到（返回应用的视口便于持久化） */
    const focusOnNodes = (list: NodeData[]): Viewport => {
        if (list.length === 0) return viewportRef.current;
        const minX = Math.min(...list.map((n) => n.x));
        const maxX = Math.max(...list.map((n) => n.x + 360));
        const minY = Math.min(...list.map((n) => n.y));
        const maxY = Math.max(...list.map((n) => n.y + 430));
        const w = Math.max(480, maxX - minX + 260);
        const h = Math.max(480, maxY - minY + 260);
        const zoom = Math.min(1, Math.max(0.3, Math.min(window.innerWidth / w, window.innerHeight / h)));
        const cx = (minX + maxX) / 2;
        const cy = (minY + maxY) / 2;
        const next: Viewport = {
            zoom,
            x: window.innerWidth / 2 - cx * zoom,
            y: window.innerHeight / 2 - cy * zoom,
        };
        setViewport(next);
        return next;
    };

    /** 把分镜链路加入画布（统一入口：参考图数据源、落点避让、提示与聚焦） */
    const appendShotChain = (
        built: { nodes: NodeData[]; videoNodeIds?: string[]; refCount?: number; reusedRefCount?: number; skipped?: number },
        origin: { x: number; y: number }
    ) => {
        const placed = placeNewChain(built.nodes, origin);
        setNodes((prev) => [...prev, ...placed]);
        const selectIds = built.videoNodeIds && built.videoNodeIds.length > 0
            ? built.videoNodeIds
            : placed.filter((n) => n.type === NodeType.VIDEO).map((n) => n.id);
        setSelectedNodeIds(selectIds);
        focusOnNodes(placed);
        return placed;
    };

    /** 把一个分镜的已有成片 / 分镜图 + 人物参考图放到画布（不触发生成） */
    const handleAddShotToCanvas = (shot: ShotState) => {
        if (!currentEpisode) return;

        // 同一分镜已在画布上时不再重复铺一遍，直接定位过去
        const existed = nodesRef.current.find(
            (n) => n.type === NodeType.VIDEO && n.shotEpisode === currentEpisode.episode && n.shotNumber === shot.shotNumber
        );
        if (existed) {
            setSelectedNodeIds([existed.id]);
            focusOnNodes([existed]);
            setShotsImportTip(`镜头 ${shot.shotNumber} 已经在画布上了`);
            return;
        }

        const origin = getCanvasOrigin();
        const built = buildShotChain({
            projectId,
            episode: currentEpisode,
            shot,
            originX: origin.x,
            originY: origin.y,
            contentType: project?.category,
            aspectRatio: project?.aspectRatio || '9:16',
            existingNodes: nodesRef.current,
            refAssets: shotRefAssets,
            /**
             * 复用画布上已有的同图节点：
             * 同一角色的图只出现一次，各片段的视频节点都连到这张图上，
             * 而不是每个片段各复制一份图，导致画布上同一张脸出现很多次。
             */
            reuseExistingRefs: true,
        });
        // appendShotChain 内部已经做了「选中视频节点 + 聚焦整条链路」
        const placed = appendShotChain(built, origin);
        const newRefs = placed.filter((n) => n.type === NodeType.IMAGE).length;
        setShotsImportTip(
            built.refCount === 0
                ? `镜头 ${shot.shotNumber} 已加入画布，但没有匹配到参考图（该片段未提到角色/场景/道具，或资产图还没生成）`
                : `镜头 ${shot.shotNumber} 已加入画布：${built.refCount} 张参考图（新建 ${newRefs} 张、复用 ${built.reusedRefCount} 张）+ 1 个视频节点`
        );
    };

    /** 批量把整集分镜放到画布 */
    const handleAddAllShots = (shots: ShotState[]) => {
        if (!currentEpisode || shots.length === 0) return;
        const origin = getCanvasOrigin();
        const built = buildShotsChain({
            projectId,
            episode: currentEpisode,
            shots,
            originX: origin.x,
            originY: origin.y,
            contentType: project?.category,
            aspectRatio: project?.aspectRatio || '9:16',
            existingNodes: nodesRef.current,
            refAssets: shotRefAssets,
            // 整集铺开时每行也自带参考图，避免连线跨行、看不清谁是谁
            reuseExistingRefs: false,
        });
        if (built.nodes.length === 0) {
            setShotsImportTip('这些分镜已经在画布上了');
            return;
        }
        appendShotChain(built, origin);
        setShotsImportTip(
            `已加入 ${built.videoNodeIds.length} 个分镜` +
            (built.skipped > 0 ? `（跳过 ${built.skipped} 个已在画布上的分镜）` : '')
        );
    };

    /** 单个分镜一键成片：建链路后触发生成（已有成片的节点不重复生成） */
    const handleGenerateShot = (shot: ShotState) => {
        if (!currentEpisode) return;
        const origin = getCanvasOrigin();
        const built = buildShotChain({
            projectId,
            episode: currentEpisode,
            shot,
            originX: origin.x,
            originY: origin.y,
            contentType: project?.category,
            aspectRatio: project?.aspectRatio || '9:16',
            existingNodes: nodesRef.current,
            refAssets: shotRefAssets,
            reuseExistingRefs: false,
        });
        appendShotChain(built, origin);
        if (!built.hasExistingVideo) {
            setTimeout(() => handleGenerateRef.current(built.videoNodeId), 150);
        }
    };

    /** 批量一键成片：整集分镜铺到画布后逐个触发生成 */
    const handleGenerateAllShots = (shots: ShotState[]) => {
        if (!currentEpisode || shots.length === 0) return;
        const origin = getCanvasOrigin();
        const built = buildShotsChain({
            projectId,
            episode: currentEpisode,
            shots,
            originX: origin.x,
            originY: origin.y,
            contentType: project?.category,
            aspectRatio: project?.aspectRatio || '9:16',
            existingNodes: nodesRef.current,
            refAssets: shotRefAssets,
            reuseExistingRefs: false,
        });
        if (built.nodes.length === 0) {
            setShotsImportTip('这些分镜已经在画布上了');
            return;
        }
        appendShotChain(built, origin);
        // 逐个错峰触发，避免同一时刻挤满生成队列
        built.videoNodeIds.forEach((id, i) => {
            const target = built.nodes.find((n) => n.id === id);
            if (target?.status === NodeStatus.SUCCESS) return;
            setTimeout(() => handleGenerateRef.current(id), 150 + i * 200);
        });
    };

    /**
     * 进入画布自动识别分镜：
     * 该集画布为空、且工作流里已拆分过该集分镜时，自动铺成「参考图 → 视频」链路。
     * 每集只自动导入一次（localStorage 记标记），之后由用户通过分镜面板手动添加，
     * 避免删掉节点后又被动重新铺满。
     */
    useEffect(() => {
        if (!canvasReadyKey) return;
        const ep = episodes[activeEpisode];
        if (!ep || String(ep.episode) !== canvasReadyKey) return;
        // 只在空画布时自动识别，避免和用户已有布局混在一起
        if (nodesRef.current.length > 0) return;

        const markerKey = `shot-canvas-auto:${projectId}:${ep.episode}`;
        if (localStorage.getItem(markerKey)) return;

        const shots = getEpisodeShots(projectId, ep.episode);
        if (shots.length === 0) return;

        const origin = { x: 160, y: 160 };
        const built = buildShotsChain({
            projectId,
            episode: ep,
            shots,
            originX: origin.x,
            originY: origin.y,
            contentType: project?.category,
            aspectRatio: project?.aspectRatio || '9:16',
            existingNodes: [],
            refAssets: shotRefAssets,
            reuseExistingRefs: false,
        });
        if (built.nodes.length === 0) return;

        // 构建成功后再记标记，避免异常情况下永久跳过自动识别
        localStorage.setItem(markerKey, String(Date.now()));

        setNodes((prev) => [...prev, ...built.nodes]);
        setSelectedNodeIds(built.videoNodeIds);
        const nextViewport = focusOnNodes(built.nodes);
        // 自动识别后直接切到「分镜」Tab，让用户看到识别结果
        setPanelTab('shots');
        setScriptPanelOpen(true);
        setShotsImportTip(`已自动识别第 ${ep.episode} 集的 ${built.videoNodeIds.length} 个分镜并铺到画布`);
        // 自动导入后立即落盘，避免用户没点保存就离开导致节点丢失
        episodeCanvasCacheRef.current[String(ep.episode)] = { nodes: built.nodes, viewport: nextViewport };
        persistEpisode(ep.episode, built.nodes, nextViewport);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [canvasReadyKey, activeEpisode, projectId]);

    /**
     * 回到画布时认领「上次离开时还在生成」的视频任务。
     *
     * Seedance 任务由服务端后台推进并落盘，前端只需把结果取回来：
     *   - 有 taskId 时先查任务状态（能立即拿到失败原因 / 完成结果）；
     *   - 任务记录丢失（服务重启后过期）时回退查 /api/generation-status/:nodeId。
     */
    useEffect(() => {
        if (!canvasReadyKey) return;
        const ep = episodes[activeEpisode];
        if (!ep) return;

        const jobs = getEpisodeCanvasJobs(projectId, ep.episode);
        if (jobs.length === 0) return;

        let cancelled = false;
        const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

        /** 把服务端结果写回节点、回写分镜并落盘 */
        const applySuccess = async (job: { nodeId: string }, rawUrl: string) => {
            const resultUrl = `${rawUrl}?t=${Date.now()}`;
            // 补抽末帧，保证恢复后的视频节点仍能作为下游节点的输入
            let lastFrame: string | undefined;
            try {
                lastFrame = await extractVideoLastFrame(resultUrl);
            } catch {
                /* 抽帧失败不影响结果展示 */
            }
            updateNode(job.nodeId, {
                status: NodeStatus.SUCCESS,
                resultUrl,
                lastFrame,
                errorMessage: undefined,
            });
            // 回写分镜 + 落盘后再清台账（落盘失败/已卸载则保留，下次继续认领）
            setTimeout(async () => {
                if (!mountedRef.current) return;
                const n = nodesRef.current.find((x) => x.id === job.nodeId);
                if (n?.shotEpisode != null && n.shotNumber != null) {
                    writeBackShotVideo(projectId, n.shotEpisode, n.shotNumber, rawUrl);
                }
                await persistEpisodeRef.current?.(ep.episode, nodesRef.current, viewportRef.current);
                removeCanvasJob(projectId, job.nodeId);
            }, 400);
        };

        const resume = async (job: { nodeId: string; startedAt: number; taskId?: string }) => {
            // 节点已不在本集画布（被删除 / 从未落盘）：清掉台账，不再轮询
            if (!nodesRef.current.some((n) => n.id === job.nodeId)) {
                removeCanvasJob(projectId, job.nodeId);
                return;
            }

            updateNode(job.nodeId, { status: NodeStatus.LOADING, errorMessage: undefined });
            // 服务端最长等待约 11 分钟，这里多留 4 分钟余量
            const deadline = job.startedAt + 15 * 60 * 1000;

            while (!cancelled && Date.now() < deadline) {
                // 1) 优先查服务端任务状态：成功/失败都能立刻知道
                if (job.taskId) {
                    try {
                        const taskStatus = await getVideoTaskStatus(job.taskId);
                        if (cancelled) return;
                        if (taskStatus.status === 'succeeded' && taskStatus.resultUrl) {
                            await applySuccess(job, taskStatus.resultUrl);
                            return;
                        }
                        if (taskStatus.status === 'failed') {
                            updateNode(job.nodeId, {
                                status: NodeStatus.ERROR,
                                errorMessage: taskStatus.error || '视频生成失败，请重新生成',
                            });
                            removeCanvasJob(projectId, job.nodeId);
                            return;
                        }
                    } catch {
                        /* 任务记录丢失/查询失败 → 走下面的落盘结果兜底 */
                    }
                }

                // 2) 回退：按 nodeId 查服务端已落盘的产物
                try {
                    const status = await getGenerationStatus(job.nodeId);
                    if (cancelled) return;
                    if (status.status === 'success' && status.resultUrl) {
                        await applySuccess(job, status.resultUrl);
                        return;
                    }
                } catch {
                    /* 网络波动，继续轮询 */
                }
                await sleep(5000);
            }

            if (!cancelled) {
                updateNode(job.nodeId, {
                    status: NodeStatus.ERROR,
                    errorMessage: '生成未完成（离开页面期间中断），请重新生成',
                });
                removeCanvasJob(projectId, job.nodeId);
            }
        };

        setShotsImportTip(`检测到 ${jobs.length} 个未完成的生成任务，正在恢复…`);
        jobs.forEach((job) => { void resume(job); });

        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [canvasReadyKey, activeEpisode, projectId]);

    // ---------- 资产库 / 模板库 ----------
    /** 从资产库选择素材 → 在画布中心创建对应图片 / 视频节点 */
    const handleLibrarySelect = (url: string, type: 'image' | 'video') => {
        const centerX = (window.innerWidth / 2 - viewport.x) / viewport.zoom - 170;
        const centerY = (window.innerHeight / 2 - viewport.y) / viewport.zoom - 150;
        const isVideo = type === 'video';

        const createNode = (resultAspectRatio?: string, aspectRatio?: string) => {
            const model = isVideo ? DEFAULT_VIDEO_MODEL : DEFAULT_IMAGE_MODEL;
            addCustomNode({
                id: crypto.randomUUID(),
                type: isVideo ? NodeType.VIDEO : NodeType.IMAGE,
                x: centerX,
                y: centerY,
                prompt: '资产库素材',
                status: NodeStatus.SUCCESS,
                resultUrl: url,
                resultAspectRatio,
                model,
                videoModel: isVideo ? model : undefined,
                imageModel: !isVideo ? model : undefined,
                aspectRatio: aspectRatio || (isVideo ? '16:9' : '1:1'),
                resolution: isVideo ? 'Auto' : '1K',
                parentIds: [],
            });
        };

        if (!isVideo) {
            const img = new Image();
            img.onload = () =>
                createNode(`${img.naturalWidth}/${img.naturalHeight}`, getClosestAspectRatio(img.naturalWidth, img.naturalHeight));
            img.onerror = () => createNode(undefined, '1:1');
            img.src = url;
        } else {
            const video = document.createElement('video');
            video.onloadedmetadata = () =>
                createNode(`${video.videoWidth}/${video.videoHeight}`, getClosestVideoAspectRatio(video.videoWidth, video.videoHeight));
            video.onerror = () => createNode(undefined, '16:9');
            video.src = url;
        }
        setAssetLibraryOpen(false);
    };

    /** 应用工作流模板：按模板节点结构在画布中心批量创建节点 */
    const handleApplyTemplate = (template: WorkflowTemplate) => {
        const centerX = (window.innerWidth / 2 - viewport.x) / viewport.zoom;
        const centerY = (window.innerHeight / 2 - viewport.y) / viewport.zoom;
        const ids = template.nodes.map(() => crypto.randomUUID());
        const newNodes: NodeData[] = template.nodes.map((spec, i) => {
            const isVideo = spec.type === NodeType.VIDEO;
            return {
                id: ids[i],
                type: spec.type,
                x: centerX + spec.dx - 200,
                y: centerY + spec.dy - 100,
                prompt: spec.prompt || '',
                title: spec.title,
                status: NodeStatus.IDLE,
                model: isVideo ? DEFAULT_VIDEO_MODEL : DEFAULT_IMAGE_MODEL,
                videoModel: isVideo ? DEFAULT_VIDEO_MODEL : undefined,
                imageModel: spec.type === NodeType.IMAGE ? DEFAULT_IMAGE_MODEL : undefined,
                aspectRatio: project?.aspectRatio || '9:16',
                resolution: isVideo ? '720p' : '1K',
                parentIds: (spec.parentIndices || []).map((idx) => ids[idx]),
            };
        });
        setNodes((prev) => [...prev, ...newNodes]);
        setSelectedNodeIds(newNodes.map((n) => n.id));
        setTemplateLibraryOpen(false);
    };

    // ---------- 指针事件 ----------
    const handlePointerDown = (e: React.PointerEvent) => {
        if ((e.target as HTMLElement).id === 'project-canvas-bg') {
            // 左键（button 0）：框选；中键（button 1）：平移画布
            if (e.button === 0) {
                startSelection(e);
            } else {
                startPanning(e);
            }
            clearSelection();
            setSelectedConnection(null);
            setContextMenu((prev) => ({ ...prev, isOpen: false }));
        }
    };

    const handlePointerMove = (e: React.PointerEvent) => {
        // 1. 框选更新
        if (updateSelection(e)) return;
        // 2. 节点拖动
        if (updateNodeDrag(e, viewport, setNodes, selectedNodeIds)) return;
        // 3. 连线拖动
        if (updateConnectionDrag(e, nodes, viewport)) return;
        // 4. 画布平移（框选时不触发）
        if (!isSelecting) {
            updatePanning(e, setViewport);
        }
    };

    const handlePointerUp = (e: React.PointerEvent) => {
        // 1. 框选结束
        if (isSelecting) {
            const selectedIds = endSelection(nodes, viewport);
            setSelectedNodeIds(selectedIds);
            releasePointerCapture(e);
            return;
        }
        // 2. 连线结束
        if (completeConnectionDrag(handleAddNext, setNodes, nodes, handleConnectionMade)) {
            releasePointerCapture(e);
            return;
        }
        endPanning();
        endNodeDrag();
        releasePointerCapture(e);
    };

    /** 以画布中心为锚点调整缩放（左下角缩放控件复用） */
    const zoomBy = (delta: number) => {
        const zoom = Math.min(2, Math.max(0.1, viewport.zoom + delta));
        const cx = window.innerWidth / 2;
        const cy = window.innerHeight / 2;
        setViewport({
            zoom,
            x: cx - (cx - viewport.x) * (zoom / viewport.zoom),
            y: cy - (cy - viewport.y) * (zoom / viewport.zoom),
        });
    };

    const handleGlobalContextMenu = (e: React.MouseEvent) => {
        e.preventDefault();
        setContextMenu({ isOpen: true, x: e.clientX, y: e.clientY });
    };

    const handleNodeContextMenu = (e: React.MouseEvent, nodeId: string) => {
        e.preventDefault();
        setContextMenu({ isOpen: true, x: e.clientX, y: e.clientY, nodeId });
    };

    // ---------- 键盘删除 ----------
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if ((e.key === 'Delete' || e.key === 'Backspace') && selectedNodeIds.length > 0) {
                const target = (e.target as HTMLElement);
                if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
                setNodes((prev) => prev.filter((n) => !selectedNodeIds.includes(n.id)));
                setSelectedNodeIds([]);
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [selectedNodeIds, setNodes, setSelectedNodeIds]);

    // ============================================================================
    // 渲染
    // ============================================================================

    if (loading) {
        return (
            <div className="w-screen h-screen bg-[#0b0b12] flex items-center justify-center text-neutral-500 text-sm">
                <Loader2 size={20} className="animate-spin mr-2" />
                正在加载项目画布…
            </div>
        );
    }

    if (loadError || !project) {
        return (
            <div className="w-screen h-screen bg-[#0b0b12] flex flex-col items-center justify-center gap-4 text-neutral-400">
                <div className="text-sm">{loadError || '项目不存在'}</div>
                <button
                    onClick={onBack}
                    className="h-9 px-4 rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-sm transition-colors"
                >
                    返回项目列表
                </button>
            </div>
        );
    }

    return (
        <div className="w-screen h-screen bg-[#0b0b12] text-white overflow-hidden select-none font-sans">
            {/* ============ 返回按钮（独立，始终显示） ============ */}
            <button
                onClick={onBack}
                className="fixed top-4 left-4 z-50 h-11 px-2.5 rounded-lg flex items-center justify-center border border-white/10 bg-[#161521]/85 backdrop-blur-xl text-neutral-100 hover:bg-white/[.12] transition-colors"
                title="返回项目列表"
            >
                <ArrowLeft size={15} />
            </button>

            {/* ============ 项目信息卡片（可收起，与返回键同一水平线） ============ */}
            {headerCollapsed ? (
                <button
                    onClick={() => setHeaderCollapsed(false)}
                    className="fixed top-4 left-14 z-50 w-8 h-8 rounded-lg flex items-center justify-center border border-white/10 bg-[#161521]/85 backdrop-blur-xl text-neutral-300 hover:text-white transition-colors"
                    title="展开项目信息"
                >
                    <ChevronDown size={16} />
                </button>
            ) : (
                <header
                    className="fixed top-4 left-14 z-50 flex items-center gap-2.5 h-11 pl-1.5 pr-2 rounded-xl border shadow-lg backdrop-blur-xl"
                    style={{
                        background: 'rgba(18, 17, 29, .85)',
                        borderColor: 'rgba(196, 181, 253, .13)',
                        boxShadow: '0 10px 28px rgba(0, 0, 0, .28)',
                    }}
                >
                    <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-violet-500 to-cyan-400 flex items-center justify-center shrink-0">
                        <Film size={15} className="text-white" />
                    </div>
                    <div className="flex flex-col leading-tight min-w-0">
                        <div className="flex items-center gap-1.5 min-w-0">
                            <span className="text-[13px] font-semibold text-neutral-100 truncate max-w-[180px]">{project.name}</span>
                            <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] shrink-0 ${STATUS_STYLE[project.status] || 'bg-[#f2f3f5] text-[#86909c]'}`}>
                                {project.status}
                            </span>
                        </div>
                        <div className="text-[10px] text-neutral-400 mt-0.5 truncate max-w-[220px]">
                            {project.code} · {project.category} · {project.stage}
                        </div>
                    </div>
                    <button
                        onClick={handleSave}
                        disabled={saveState === 'saving'}
                        className={`flex items-center gap-1.5 h-7 px-2.5 rounded-lg text-[12px] font-medium transition-colors shrink-0 ml-0.5 ${
                            saveState === 'idle'
                                ? 'bg-violet-600 hover:bg-violet-500 text-white'
                                : 'border border-white/10 bg-white/[.06] text-neutral-300 hover:bg-white/[.12]'
                        } disabled:cursor-not-allowed disabled:opacity-70`}
                        title="保存画布"
                    >
                        {saveState === 'saving' ? (
                            <>
                                <Loader2 size={13} className="animate-spin" />
                                保存中
                            </>
                        ) : saveState === 'saved' ? (
                            <>
                                <Save size={13} />
                                已保存
                            </>
                        ) : (
                            <>
                                <Save size={13} />
                                保存
                            </>
                        )}
                    </button>
                    <button
                        onClick={() => setHeaderCollapsed(true)}
                        className="w-7 h-7 rounded-lg flex items-center justify-center text-neutral-500 hover:text-white hover:bg-white/10 transition-colors shrink-0"
                        title="收起项目信息"
                    >
                        <ChevronUp size={15} />
                    </button>
                </header>
            )}

            {/* ============ 左侧工具栏（可折叠：默认圆点，点击展开） ============ */}
            {toolbarCollapsed ? (
                <button
                    onClick={() => setToolbarCollapsed(false)}
                    className="fixed left-5 top-1/2 -translate-y-1/2 w-7 h-7 rounded-full flex items-center justify-center shadow-md shadow-violet-500/20 bg-gradient-to-br from-violet-400 to-violet-600 text-white hover:scale-105 transition-all duration-200 z-50"
                    title="展开工具栏"
                >
                    <Plus size={14} />
                </button>
            ) : (
                <div className="fixed left-5 top-1/2 -translate-y-1/2 flex flex-col items-center gap-2 p-1.5 rounded-2xl shadow-2xl backdrop-blur-xl z-50 bg-[#161521]/90 border border-violet-200/10">
                    <button
                        onClick={() => setToolbarCollapsed(true)}
                        className="w-9 h-9 rounded-xl flex items-center justify-center text-neutral-400 hover:text-white hover:bg-white/10 transition-all duration-200"
                        title="收起工具栏"
                    >
                        <X size={16} />
                    </button>
                    <button
                        onClick={() => setContextMenu({ isOpen: true, x: 76, y: window.innerHeight / 2 - 20 })}
                        className="w-10 h-10 rounded-xl flex items-center justify-center hover:scale-105 transition-all duration-200 shadow-lg bg-gradient-to-br from-violet-400 to-violet-600 text-white shadow-violet-500/25"
                        title="添加节点"
                    >
                        <Plus size={20} />
                    </button>
                    <button
                        onClick={() => setScriptPanelOpen((v) => !v)}
                        className={`w-9 h-9 rounded-xl flex items-center justify-center transition-all duration-200 ${scriptPanelOpen ? 'bg-violet-500/20 text-violet-200' : 'text-neutral-400 hover:text-white hover:bg-white/10'}`}
                        title="剧本分集 / 资产"
                    >
                        <BookOpen size={20} />
                    </button>
                    <button
                        onClick={() => {
                            setScriptPanelOpen(false);
                            setTemplateLibraryOpen(false);
                            setAssetLibraryOpen((v) => !v);
                        }}
                        className={`w-9 h-9 rounded-xl flex items-center justify-center transition-all duration-200 ${assetLibraryOpen ? 'bg-violet-500/20 text-violet-200' : 'text-neutral-400 hover:text-white hover:bg-white/10'}`}
                        title="资产库"
                    >
                        <ImageIcon size={20} />
                    </button>
                    <button
                        onClick={() => {
                            setScriptPanelOpen(false);
                            setAssetLibraryOpen(false);
                            setTemplateLibraryOpen((v) => !v);
                        }}
                        className={`w-9 h-9 rounded-xl flex items-center justify-center transition-all duration-200 ${templateLibraryOpen ? 'bg-violet-500/20 text-violet-200' : 'text-neutral-400 hover:text-white hover:bg-white/10'}`}
                        title="模板库"
                    >
                        <LayoutTemplate size={20} />
                    </button>
                </div>
            )}

            {/* ============ 剧本 / 资产侧边面板 ============ */}
            {scriptPanelOpen && (
                <aside
                    className="fixed left-[76px] top-[88px] bottom-6 w-[380px] rounded-2xl border border-white/10 bg-[#161521]/92 backdrop-blur-xl shadow-2xl z-40 flex flex-col overflow-hidden"
                >
                    {/* 面板头 */}
                    <div className="flex items-center justify-between px-4 pt-3.5 pb-2.5 border-b border-white/8">
                        <div className="flex items-center gap-2">
                            <BookOpen size={16} className="text-violet-300" />
                            <span className="text-[14px] font-semibold text-neutral-100">剧本内容 · 资产</span>
                        </div>
                        <button
                            onClick={() => setScriptPanelOpen(false)}
                            className="w-7 h-7 rounded-lg flex items-center justify-center text-neutral-400 hover:bg-white/10 hover:text-white transition-colors"
                        >
                            <X size={15} />
                        </button>
                    </div>

                    {/* Tab */}
                    <div className="flex items-center gap-1 px-3 pt-2.5 pb-1.5 overflow-x-auto shrink-0">
                        {([
                            ['episodes', `分集 (${episodes.length})`],
                            ['shots', '分镜'],
                            ['assets', '全剧资产'],
                            ['characters', '人物'],
                            ['scenes', '场景'],
                            ['props', '道具'],
                        ] as const).map(([key, label]) => (
                            <button
                                key={key}
                                onClick={() => setPanelTab(key)}
                                className={`px-2.5 h-8 rounded-lg text-[12px] whitespace-nowrap shrink-0 transition-colors ${panelTab === key ? 'bg-violet-500/20 text-violet-200 font-medium' : 'text-neutral-400 hover:bg-white/5'}`}
                            >
                                {label}
                            </button>
                        ))}
                    </div>

                    {/* ===== 分集 Tab ===== */}
                    {panelTab === 'episodes' && (
                        <>
                            <div className="px-4 pb-2">
                                <div className="relative">
                                    <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-500" />
                                    <input
                                        type="text"
                                        value={episodeSearch}
                                        onChange={(e) => setEpisodeSearch(e.target.value)}
                                        placeholder="搜索分集标题"
                                        className="w-full h-8 pl-8 pr-3 rounded-lg bg-white/5 border border-white/10 text-[13px] text-neutral-200 placeholder:text-neutral-500 focus:outline-none focus:border-violet-400/50"
                                    />
                                </div>
                            </div>

                            <div className="flex-1 min-h-0 flex">
                                {/* 分集目录 */}
                                <div className="w-[118px] shrink-0 border-r border-white/8 overflow-y-auto">
                                    {filteredEpisodes.length === 0 ? (
                                        <div className="p-3 text-[12px] text-neutral-500">无匹配分集</div>
                                    ) : (
                                        filteredEpisodes.map((ep) => {
                                            const globalIdx = episodes.indexOf(ep);
                                            const active = activeEpisode === globalIdx;
                                            return (
                                                <button
                                                    key={ep.episode}
                                                    onClick={() => switchEpisode(globalIdx)}
                                                    className={`w-full text-left px-3 py-2 border-l-2 transition-colors ${active ? 'bg-violet-500/15 border-violet-400' : 'border-transparent hover:bg-white/5'}`}
                                                >
                                                    <div className={`text-[12px] font-medium ${active ? 'text-violet-200' : 'text-neutral-300'}`}>
                                                        第 {String(ep.episode).padStart(2, '0')} 集
                                                    </div>
                                                    <div className={`text-[11px] truncate ${active ? 'text-violet-200/70' : 'text-neutral-500'}`}>
                                                        {ep.title}
                                                    </div>
                                                </button>
                                            );
                                        })
                                    )}
                                </div>

                                {/* 分集详情 */}
                                <div className="flex-1 min-w-0 overflow-y-auto">
                                    {currentEpisode ? (
                                        <div className="p-3">
                                            <div className="flex items-center gap-2 mb-2">
                                                <span className="text-[11px] text-neutral-500">第 {String(currentEpisode.episode).padStart(2, '0')} 集</span>
                                                <span className="text-[13px] font-semibold text-neutral-100 truncate">{currentEpisode.title}</span>
                                            </div>
                                            <div className="flex items-center gap-3 text-[11px] text-neutral-500 mb-2">
                                                <span>{currentEpisode.wordCount} 字</span>
                                                <span>{formatDurationSeconds(currentEpisode.durationSeconds)}</span>
                                            </div>
                                            <div className="text-[12px] text-neutral-300 leading-relaxed bg-white/5 rounded-lg p-2.5 mb-2">
                                                {currentEpisode.summary || '暂无概要'}
                                            </div>

                                            {/* 该集资产 */}
                                            {(() => {
                                                const a = currentEpisode.assets;
                                                const count = a.characters.length + a.scenes.length + a.props.length;
                                                if (count === 0) {
                                                    return <div className="text-[12px] text-neutral-500 mb-3">该集未识别到资产</div>;
                                                }
                                                return (
                                                    <div className="space-y-2 mb-3">
                                                        {(Object.keys(ASSET_META) as AssetKey[]).map((key) => {
                                                            const items = a[key] || [];
                                                            if (items.length === 0) return null;
                                                            const meta = ASSET_META[key];
                                                            return (
                                                                <div key={key} className="flex items-center gap-2">
                                                                    <meta.icon size={13} className={meta.color.split(' ')[0]} />
                                                                    <span className="text-[11px] text-neutral-400 w-8 shrink-0">{meta.label}</span>
                                                                    <div className="flex flex-wrap gap-1">
                                                                        {items.map((it, i) => (
                                                                            <span key={i} className="text-[11px] px-1.5 py-0.5 rounded bg-white/5 text-neutral-300">
                                                                                {it.name}
                                                                            </span>
                                                                        ))}
                                                                    </div>
                                                                </div>
                                                            );
                                                        })}
                                                    </div>
                                                );
                                            })()}

                                            {currentEpisode.content ? (
                                                <div className="text-[11px] text-neutral-400 leading-relaxed whitespace-pre-wrap bg-white/5 rounded-lg p-2.5 mb-3 max-h-[140px] overflow-y-auto">
                                                    {currentEpisode.content}
                                                </div>
                                            ) : null}

                                            {/* 操作 */}
                                            <div className="flex flex-col gap-1.5">
                                                <button
                                                    onClick={() => handleGenerateEpisodeVideo(currentEpisode)}
                                                    className="flex items-center justify-center gap-1.5 h-8 rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-[12px] font-medium transition-colors"
                                                >
                                                    <Sparkles size={14} />
                                                    生成该集视频
                                                </button>

                                                {/* 分镜片段导入：把工作流分镜里已生成的片段搬进本集画布 */}
                                                <button
                                                    onClick={() => void handleImportEpisodeShots(currentEpisode)}
                                                    className="flex items-center justify-center gap-1.5 h-8 rounded-lg border border-white/10 text-neutral-300 hover:bg-white/5 text-[12px] transition-colors"
                                                >
                                                    <Layers size={14} />
                                                    分镜片段导入画布
                                                    {(() => {
                                                        const c = countImportableShots(projectId, currentEpisode.episode);
                                                        if (c.withVideo + c.withImageOnly === 0) return null;
                                                        return (
                                                            <span className="text-[10px] px-1.5 py-px rounded-full bg-violet-500/20 text-violet-300">
                                                                {c.withVideo > 0 ? `${c.withVideo} 视频` : `${c.withImageOnly} 图`}
                                                            </span>
                                                        );
                                                    })()}
                                                </button>

                                                <button
                                                    onClick={() => handleAddEpisodeText(currentEpisode)}
                                                    className="flex items-center justify-center gap-1.5 h-8 rounded-lg border border-white/10 text-neutral-300 hover:bg-white/5 text-[12px] transition-colors"
                                                >
                                                    <FileText size={14} />
                                                    剧本内容添加到画布
                                                </button>
                                            </div>
                                        </div>
                                    ) : (
                                        <div className="flex h-full items-center justify-center text-[12px] text-neutral-500">
                                            请选择左侧分集
                                        </div>
                                    )}
                                </div>
                            </div>
                        </>
                    )}

                    {/* ===== 分镜 Tab ===== */}
                    {panelTab === 'shots' && (
                        <ShotPanel
                            projectId={projectId}
                            episode={currentEpisode}
                            contentType={project?.category}
                            aspectRatio={project?.aspectRatio || '9:16'}
                            targetDuration={project?.targetDuration}
                            refAssets={shotRefAssets}
                            onAddShotToCanvas={handleAddShotToCanvas}
                            onAddAllShots={handleAddAllShots}
                            onGenerateShot={handleGenerateShot}
                            onGenerateAllShots={handleGenerateAllShots}
                        />
                    )}

                    {/* ===== 资产 Tab ===== */}
                    {panelTab === 'assets' && (
                        <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-3">
                            <div className="text-[12px] text-neutral-500">
                                全剧共识别 人物 {globalAssets.characters.length} · 场景 {globalAssets.scenes.length} · 道具 {globalAssets.props.length}
                            </div>
                            {(Object.keys(ASSET_META) as AssetKey[]).map((key) => {
                                const meta = ASSET_META[key];
                                const items = globalAssets[key] || [];
                                return (
                                    <div key={key} className="border border-white/8 rounded-xl overflow-hidden">
                                        <div className="flex items-center gap-1.5 px-3 py-2 bg-white/5 border-b border-white/8">
                                            <meta.icon size={14} className={meta.color.split(' ')[0]} />
                                            <span className="text-[13px] font-medium text-neutral-200">{meta.label}</span>
                                            <span className="text-[12px] text-neutral-500 ml-auto">{items.length}</span>
                                        </div>
                                        <div className="p-2 space-y-1">
                                            {items.length === 0 ? (
                                                <div className="text-[12px] text-neutral-600 text-center py-2">—</div>
                                            ) : (
                                                items.map((it, i) => (
                                                    <div key={i} className="px-2 py-1.5 rounded hover:bg-white/5">
                                                        <div className="text-[13px] text-neutral-200 font-medium">{it.name}</div>
                                                        {it.description && <div className="text-[11px] text-neutral-500 mt-0.5 leading-snug">{it.description}</div>}
                                                    </div>
                                                ))
                                            )}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    )}

                    {/* ===== 当前集分类资产（人物 / 场景 / 道具，继承资产确认，按集隔离） ===== */}
                    {(panelTab === 'characters' || panelTab === 'scenes' || panelTab === 'props') && (() => {
                        const key = panelTab as AssetKey;
                        const meta = ASSET_META[key];
                        const items = currentEpisodeAssets[key] || [];
                        return (
                            <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-2">
                                <div className="flex items-center gap-1.5 px-1 text-[12px] text-neutral-500">
                                    <meta.icon size={13} className={meta.color.split(' ')[0]} />
                                    <span>
                                        第 {currentEpisodeNo != null ? String(currentEpisodeNo).padStart(2, '0') : '—'} 集 · {meta.label}
                                    </span>
                                    <span className="ml-auto">{items.length}</span>
                                </div>
                                {items.length === 0 ? (
                                    <div className="text-[12px] text-neutral-600 text-center py-8">
                                        该集暂无{meta.label}资产
                                        <br />
                                        请在「资产确认」中完善
                                    </div>
                                ) : (
                                    items.map((item, i) => {
                                        const url = getAssetImageUrl(item);
                                        return (
                                            <div
                                                key={i}
                                                className="group flex items-center gap-2.5 p-2 rounded-xl border border-white/[0.08] bg-white/[0.03] hover:bg-white/[0.06] transition-colors"
                                            >
                                                <div className="w-12 h-12 rounded-lg overflow-hidden bg-white/[0.06] shrink-0 flex items-center justify-center">
                                                    {url ? (
                                                        <img src={url} alt={item.name} className="w-full h-full object-cover" />
                                                    ) : (
                                                        <meta.icon size={16} className="text-neutral-600" />
                                                    )}
                                                </div>
                                                <div className="flex-1 min-w-0">
                                                    <div className="text-[13px] font-medium text-neutral-200 truncate">{item.name}</div>
                                                    {item.description && (
                                                        <div className="text-[11px] text-neutral-500 truncate">{item.description}</div>
                                                    )}
                                                </div>
                                                <button
                                                    onClick={() => { if (url) handleLibrarySelect(url, 'image'); }}
                                                    disabled={!url}
                                                    title={url ? '添加到画布' : '该资产尚未生成图片'}
                                                    className="h-7 px-2.5 rounded-lg text-[12px] shrink-0 transition-colors bg-violet-600/90 hover:bg-violet-500 text-white disabled:bg-white/[0.06] disabled:text-neutral-600 disabled:cursor-not-allowed"
                                                >
                                                    加到画布
                                                </button>
                                            </div>
                                        );
                                    })
                                )}
                            </div>
                        );
                    })()}
                </aside>
            )}

            {/* ============ 资产库面板 ============ */}
            <AssetLibraryPanel
                isOpen={assetLibraryOpen}
                onClose={() => setAssetLibraryOpen(false)}
                onSelectAsset={handleLibrarySelect}
                canvasTheme="dark"
            />

            {/* ============ 模板库面板 ============ */}
            <TemplateLibraryPanel
                isOpen={templateLibraryOpen}
                onClose={() => setTemplateLibraryOpen(false)}
                onApplyTemplate={handleApplyTemplate}
                canvasTheme="dark"
            />

            {/* ============ 画布 ============ */}
            <div
                ref={canvasRef}
                id="project-canvas-bg"
                className="absolute inset-0 cursor-default"
                style={{
                    background:
                        'radial-gradient(circle at 50% -20%, rgba(112, 77, 206, .16), transparent 38%), radial-gradient(circle at 0% 100%, rgba(14, 165, 233, .08), transparent 32%)',
                }}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onWheel={handleWheel}
                onContextMenu={handleGlobalContextMenu}
            >
                <div
                    style={{
                        transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
                        transformOrigin: '0 0',
                        width: '100%',
                        height: '100%',
                        pointerEvents: 'none',
                    }}
                >
                    {/* 网格背景 */}
                    <div
                        className="absolute -top-[10000px] -left-[10000px] w-[20000px] h-[20000px]"
                        style={{
                            backgroundImage: 'radial-gradient(rgba(170, 155, 235, .34) 1px, transparent 1px)',
                            backgroundSize: '24px 24px',
                            opacity: 0.42,
                        }}
                    />

                    {/* 连接线 */}
                    <svg className="absolute top-0 left-0 w-full h-full overflow-visible pointer-events-none z-0">
                        <ConnectionsLayer
                            nodes={nodes}
                            viewport={viewport}
                            canvasTheme="dark"
                            isDraggingConnection={isDraggingConnection}
                            connectionStart={connectionStart}
                            tempConnectionEnd={tempConnectionEnd}
                            selectedConnection={selectedConnection}
                            onEdgeClick={handleEdgeClick}
                        />
                    </svg>

                    {/* 节点 */}
                    <div className="pointer-events-auto">
                        {nodes.map((node) => (
                            <CanvasNode
                                key={node.id}
                                data={node}
                                inputUrl={(() => {
                                    if (!node.parentIds || node.parentIds.length === 0) return undefined;
                                    const parent = nodes.find((n) => n.id === node.parentIds![0]);
                                    // 视频类编辑节点需要父节点的真实视频地址，不能用 lastFrame（末帧图）
                                    if ((node.type === NodeType.VIDEO_EDITOR || node.type === NodeType.VIDEO_MERGE)
                                        && parent?.type === NodeType.VIDEO) {
                                        return parent.resultUrl;
                                    }
                                    if (parent?.type === NodeType.VIDEO && parent.lastFrame) return parent.lastFrame;
                                    return parent?.resultUrl;
                                })()}
                                connectedImageNodes={(() => {
                                    if (!node.parentIds || node.parentIds.length === 0) return [];
                                    return node.parentIds
                                        .map((pid) => nodes.find((n) => n.id === pid))
                                        .filter((p) => p && (p.type === NodeType.IMAGE || p.type === NodeType.VIDEO) && p.resultUrl)
                                        .map((p) => ({
                                            id: p!.id,
                                            url: (p!.type === NodeType.VIDEO ? p!.lastFrame : p!.resultUrl) || p!.resultUrl!,
                                            type: p!.type,
                                        }));
                                })()}
                                onUpdate={updateNode}
                                onGenerate={handleGenerate}
                                onAddNext={handleAddNext}
                                onWriteContent={handleWriteContent}
                                onTextToVideo={handleTextToVideo}
                                onTextToImage={handleTextToImage}
                                onImageToImage={handleImageToImage}
                                onImageToVideo={handleImageToVideo}
                                onChangeAngleGenerate={handleChangeAngleGenerate}
                                selected={selectedNodeIds.includes(node.id)}
                                showControls={selectedNodeIds.length === 1 && selectedNodeIds.includes(node.id)}
                                onSelect={(id) => setSelectedNodeIds([id])}
                                onNodePointerDown={(e) => {
                                    setSelectedNodeIds([node.id]);
                                    handleNodePointerDown(e, node.id);
                                }}
                                onContextMenu={handleNodeContextMenu}
                                onConnectorDown={handleConnectorPointerDown}
                                isHoveredForConnection={connectionHoveredNodeId === node.id}
                                onOpenEditor={(nodeId) => {
                                    const target = nodes.find((n) => n.id === nodeId);
                                    if (!target) return;
                                    if (target.type === NodeType.VIDEO_MERGE) {
                                        handleOpenMerge(nodeId);
                                    }
                                }}
                                zoom={viewport.zoom}
                                canvasTheme="dark"
                                onDragStart={() => setIsDraggingNodeToChat(true)}
                                onDragEnd={() => setIsDraggingNodeToChat(false)}
                            />
                        ))}
                    </div>
                </div>

                {/* 框选框（屏幕坐标，画布变换之外） */}
                {selectionBox.isActive && (
                    <div
                        className="absolute pointer-events-none"
                        style={{
                            left: Math.min(selectionBox.startX, selectionBox.endX),
                            top: Math.min(selectionBox.startY, selectionBox.endY),
                            width: Math.abs(selectionBox.endX - selectionBox.startX),
                            height: Math.abs(selectionBox.endY - selectionBox.startY),
                            border: '2px solid #8b5cf6',
                            backgroundColor: 'rgba(139, 92, 246, 0.1)',
                            zIndex: 1000,
                        }}
                    />
                )}
            </div>

            {/* ============ 左下角缩放控件 ============ */}
            <div className="fixed bottom-5 left-5 z-50 flex items-center gap-1 px-1.5 py-0.5 rounded-md backdrop-blur-xl bg-[#161521]/45 border border-white/5 opacity-60 hover:opacity-100 transition-opacity duration-200">
                <button
                    onClick={() => zoomBy(-0.2)}
                    className="w-4 h-4 rounded flex items-center justify-center text-neutral-500 hover:text-white hover:bg-white/10 transition-colors"
                    title="缩小"
                >
                    <ZoomOut size={11} />
                </button>
                <input
                    type="range"
                    min="0.1"
                    max="2"
                    step="0.1"
                    value={viewport.zoom}
                    onChange={handleSliderZoom}
                    className="w-10 h-1 accent-violet-500/70 cursor-pointer"
                />
                <button
                    onClick={() => zoomBy(0.2)}
                    className="w-4 h-4 rounded flex items-center justify-center text-neutral-500 hover:text-white hover:bg-white/10 transition-colors"
                    title="放大"
                >
                    <ZoomIn size={11} />
                </button>
                <span className="text-[9px] text-neutral-500 w-7 text-center tabular-nums">{Math.round(viewport.zoom * 100)}%</span>
            </div>

            {/* ============ 右键菜单 ============ */}
            {contextMenu.isOpen && (
                <>
                    <div
                        className="fixed inset-0 z-[99]"
                        onClick={() => setContextMenu({ isOpen: false, x: 0, y: 0 })}
                    />
                    <div
                        className="fixed z-[100]"
                        style={{ left: contextMenu.x, top: contextMenu.y }}
                    >
                        <div className="min-w-[150px] rounded-xl bg-[#1a1a28] border border-white/10 shadow-2xl py-1 overflow-hidden">
                            {contextMenu.nodeId ? (
                                <button
                                    onClick={() => {
                                        deleteNode(contextMenu.nodeId!);
                                        setContextMenu({ isOpen: false, x: 0, y: 0 });
                                    }}
                                    className="w-full text-left px-3 py-2 text-[13px] text-red-400 hover:bg-white/5 transition-colors"
                                >
                                    删除节点
                                </button>
                            ) : (
                                <>
                                    {([
                                        { key: 'text', label: '添加文本节点', icon: Type, type: NodeType.TEXT },
                                        { key: 'image', label: '添加图片节点', icon: ImageIcon, type: NodeType.IMAGE },
                                        { key: 'video', label: '添加视频节点', icon: Video, type: NodeType.VIDEO },
                                        { key: 'merge', label: '添加合并成片节点', icon: Layers, type: NodeType.VIDEO_MERGE },
                                    ] as const).map(({ key, label, icon: Icon, type }) => (
                                        <button
                                            key={key}
                                            onClick={() => {
                                                addNodeAtCenter(type);
                                                setContextMenu({ isOpen: false, x: 0, y: 0 });
                                            }}
                                            className="w-full flex items-center gap-2 px-3 py-2 text-[13px] text-neutral-200 hover:bg-white/5 transition-colors"
                                        >
                                            <Icon size={15} className="text-neutral-400" />
                                            {label}
                                        </button>
                                    ))}
                                </>
                            )}
                        </div>
                    </div>
                </>
            )}

            {/* 空画布提示 */}
            {nodes.length === 0 && !scriptPanelOpen && (
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                    <div className="text-center text-neutral-500 text-sm">
                        <Film size={32} className="mx-auto mb-3 text-neutral-600" />
                        <div>打开左侧「剧本内容 · 资产」面板，选择分集生成视频</div>
                    </div>
                </div>
            )}
            {/* 聊天智能体 */}
            <ChatBubble onClick={() => setIsChatOpen(prev => !prev)} isOpen={isChatOpen} />
            <ChatPanel isOpen={isChatOpen} onClose={() => setIsChatOpen(false)} isDraggingNode={isDraggingNodeToChat} canvasTheme="dark" scope={`project-${projectId}`} />

            {/* 分镜导入结果提示 */}
            {shotsImportTip && (
                <div className="fixed left-1/2 top-24 -translate-x-1/2 z-[90] pointer-events-none">
                    <div className="rounded-lg bg-neutral-900/95 border border-violet-500/30 px-4 py-2 text-[12px] text-violet-200 shadow-xl">
                        {shotsImportTip}
                    </div>
                </div>
            )}

            {/* 视频合并成片面板 */}
            <VideoMergePanel
                isOpen={mergeModal.isOpen}
                nodeId={mergeModal.nodeId}
                clips={currentClips}
                isMerging={isMerging}
                error={mergeError}
                resultUrl={mergeCurrentNode?.resultUrl}
                resultDuration={mergeCurrentNode?.mergeResultDuration}
                initialTransition={mergeCurrentNode?.mergeTransition}
                initialTransitionDuration={mergeCurrentNode?.mergeTransitionDuration}
                initialAudioMode={mergeCurrentNode?.mergeAudioMode}
                initialAudioUrl={mergeCurrentNode?.mergeAudioUrl}
                initialTransitions={mergeCurrentNode?.mergeTransitions}
                episode={mergeCurrentNode?.mergeEpisode ?? (activeEpisode || undefined)}
                projectId={projectId}
                onClose={handleCloseMerge}
                onReorder={handleReorderClips}
                onMerge={handleMerge}
            />
        </div>
    );
};

export default ProjectCanvasPage;
