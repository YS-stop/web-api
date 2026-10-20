import React, { useState, useEffect, useRef } from 'react';
import {
    X,
    ChevronDown,
    Check,
    Search,
    Upload,
    FileText,
    ArrowRight,
    Sparkles,
    Users,
    MapPin,
    Package,
    RefreshCw,
    Loader2,
    CheckCircle2,
    AlertCircle,
    Plus,
    Minus,
} from 'lucide-react';
import {
    splitEpisodes,
    analyzeAssets,
    formatDurationSeconds,
    ScriptAnalysis,
} from '../../services/scriptAnalysisService';
import { CONTENT_TYPES, DEPARTMENTS, OWNERS, PRODUCTION_MODES, ASPECT_RATIOS } from '../../services/projectService';

// ============================================================================
// 类型定义
// ============================================================================

/** 新建项目最终提交的数据（供项目列表页组装成完整项目） */
export interface CreateProjectData {
    name: string;
    category: string;         // 内容类型：见 CONTENT_TYPES（国内真人 / 2D 动画 / 3D 系列）
    department: string;       // 制作部门
    owner: string;            // 项目负责人
    productionMode: string;   // 生产模式：全自动 / 人工逐节点
    aspectRatio: string;      // 默认画幅
    targetDuration: number;   // 单集目标时长（秒）
    scriptSource: string;     // 剧本来源：剧本图书馆 / 本地上传
    scriptName: string;       // 锁定剧本名
    dramaName: string;        // 剧目名
    totalEpisodes: number;    // 已确认集数
    scriptAnalysis?: ScriptAnalysis | null; // 剧本分集 + 资产（项目画布展示）
}

interface ScriptItem {
    id: string;
    name: string;
    drama: string;
    genre: string;
    episodes: number;
    words: string;
    version: string;
    updatedAt: string;
}

// ============================================================================
// 演示数据
// ============================================================================

const LIBRARY_SCRIPTS: ScriptItem[] = [
    { id: 's1', name: '长夜微光·分集定稿 V3', drama: '长夜微光', genre: '都市悬疑', episodes: 80, words: '22.8万字', version: 'V3.0', updatedAt: '今天 09:42' },
    { id: 's2', name: '入局者·60集改编稿', drama: '入局者', genre: '逆袭成长', episodes: 60, words: '18.4万字', version: 'V2.6', updatedAt: '昨天 17:20' },
    { id: 's3', name: '逆光生长·第一季 V2', drama: '逆光生长', genre: '家庭情感', episodes: 72, words: '20.1万字', version: 'V2.0', updatedAt: '09-23 14:06' },
];

/** 演示用剧本全文（真实场景中应从剧本图书馆后端读取） */
const DEMO_SCRIPT_TEXTS: Record<string, string> = {
    s1: `《长夜微光》都市悬疑短剧。
刑警林晚秋在调查一起连环失踪案时，发现所有线索都指向十年前一场被掩盖的雨夜车祸，失踪者都与当年肇事逃逸的富商集团有关。
林晚秋与心理侧写师顾沉联手，从雨夜重逢的旧案现场、被隐藏的来电、身份裂缝的线人、旧案线索的物证中层层推进，最终揭开了以「交换条件」维系的地下交易网络。
全剧围绕正义与救赎展开，每集推进一个关键线索，结尾多次反转。`,
    s2: `《入局者》逆袭成长短剧。
底层青年江澈误入一场资本棋局，成为各方势力博弈的棋子。他从被利用、被出卖，到逐步看懂规则、主动入局，利用自己的才智一次次反杀。
全剧围绕「入局-破局-做局」三阶段推进，每集一次身份翻转或资源博弈，最终江澈从棋子变为执棋人。`,
    s3: `《逆光生长》家庭情感短剧。
单亲妈妈苏念带着女儿小满回到老城，与多年未见的父亲、以及各有心结的家人重新生活在一起。
围绕亲情和解、代际冲突与成长，每集聚焦一个家庭矛盾，从误解到理解，最终一家人学会在逆境中彼此支撑、逆光生长。`,
};

/** 5 步向导：分集与资产识别拆为两个独立步骤 */
const STEPS = [
    { title: '项目基础信息', desc: '定义类型、部门和生产模式' },
    { title: '选择剧本', desc: '从资源库选稿或本地上传' },
    { title: '剧本分集', desc: 'AI 智能拆集' },
    { title: '智能解析', desc: 'AI 识别每集资产' },
    { title: '确认创建', desc: '复核信息并创建项目' },
];

/**
 * 按剧本中的「第N集」标记把全文本地切分成若干段。
 * - 兼容阿拉伯数字与全角数字；只把【行内出现的集标记】当作切点，
 *   严格按数字递增、且每个集号只取一次，避免目录 / 梗概里的字样误切；
 * - 第一个集标记之前的内容（标题 / 故事梗概 / 人物小传）整体作为前言，
 *   不并入任何一集。
 * 返回 null 表示未能可靠识别集标记（交给常规 AI 分集）。
 */
function splitByEpisodeMarkers(raw: string): { episode: number; content: string }[] | null {
    const text = String(raw || '');
    const re = /第\s*([0-9０-９]+)\s*集/g;
    type Hit = { no: number; index: number };
    const hits: Hit[] = [];
    let m: RegExpExecArray | null;
    let expected = 1;
    while ((m = re.exec(text)) !== null) {
        const digits = m[1].replace(/[０-９]/g, (d) => String(d.charCodeAt(0) - 0xff10));
        const no = Number(digits);
        // 必须严格按 1,2,3… 递增出现，防止梗概 / 人物小传里的“第N集”造成误切点
        if (no === expected) {
            hits.push({ no, index: m.index });
            expected += 1;
        }
    }
    // 至少 2 集且第 1 集存在，才认为是可靠的“已分集”剧本
    if (hits.length < 2 || hits[0].no !== 1) return null;

    return hits.map((h, i) => {
        const end = i + 1 < hits.length ? hits[i + 1].index : text.length;
        // content 去掉集标记本身这几个字，保留其后的人物/场景/正文
        const markerEnd = text.indexOf('集', h.index) + 1;
        return { episode: h.no, content: text.slice(markerEnd, end) };
    });
}

/** 从 .docx（zip 内的 word/document.xml）提取纯文本，按段落换行 */
async function extractDocxText(buffer: ArrayBuffer): Promise<string> {
    const JSZip = (window as any).JSZip;
    if (!JSZip) throw new Error('文档解析组件未加载');
    const zip = await JSZip.loadAsync(buffer);
    const file = zip.file('word/document.xml');
    if (!file) throw new Error('无效的 Word 文档');
    const xml: string = await file.async('string');
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    const paragraphs = Array.from(doc.getElementsByTagName('w:p'));
    const lines: string[] = [];
    for (const p of paragraphs) {
        const nodes = Array.from(p.getElementsByTagName('w:t'));
        lines.push(nodes.map((n) => n.textContent || '').join(''));
    }
    return lines.join('\n');
}

// ============================================================================
// 基础控件
// ============================================================================

interface SelectFieldProps {
    label: string;
    required?: boolean;
    value: string;
    options: string[];
    onChange: (v: string) => void;
}

const SelectField: React.FC<SelectFieldProps> = ({ label, required, value, options, onChange }) => {
    const [open, setOpen] = useState(false);
    return (
        <div className="flex flex-col gap-1.5">
            <label className="text-[13px] font-medium text-slate-700">
                {required && <span className="text-red-500">* </span>}{label}
            </label>
            <div className="relative">
                <button
                    type="button"
                    onClick={() => setOpen(!open)}
                    onBlur={() => setTimeout(() => setOpen(false), 150)}
                    className="w-full h-9 px-3 rounded-lg border border-slate-200 bg-white text-sm text-slate-700 flex items-center justify-between hover:border-[#1677ff] transition-colors"
                >
                    <span>{value}</span>
                    <ChevronDown size={15} className="text-slate-400" />
                </button>
                {open && (
                    <div className="absolute z-20 top-full mt-1 w-full bg-white border border-slate-200 rounded-lg shadow-lg py-1">
                        {options.map((o) => (
                            <button
                                key={o}
                                type="button"
                                onMouseDown={() => { onChange(o); setOpen(false); }}
                                className={`w-full px-3 py-1.5 text-sm text-left flex items-center justify-between hover:bg-slate-50 ${value === o ? 'text-[#1677ff]' : 'text-slate-600'}`}
                            >
                                <span>{o}</span>
                                {value === o && <Check size={14} />}
                            </button>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
};

interface NumberFieldProps {
    label: string;
    value: number;
    onChange: (v: number) => void;
    min?: number;
    max?: number;
    suffix?: string;
}

const NumberField: React.FC<NumberFieldProps> = ({ label, value, onChange, min = 0, max = 9999, suffix }) => {
    const clamp = (n: number) => Math.min(max, Math.max(min, n));
    // 用字符串草稿承载输入过程，避免受控数字在清空/中间态时被强制回填导致无法自由输入
    const [draft, setDraft] = useState(String(value));
    const focusedRef = useRef(false);

    useEffect(() => {
        if (!focusedRef.current) setDraft(String(value));
    }, [value]);

    const handleInputChange = (raw: string) => {
        setDraft(raw);
        const n = Number(raw);
        if (raw !== '' && !isNaN(n)) {
            onChange(clamp(n));
        }
    };

    const handleBlur = () => {
        focusedRef.current = false;
        const n = Number(draft);
        if (draft === '' || isNaN(n)) {
            setDraft(String(value));
        } else {
            const c = clamp(n);
            onChange(c);
            setDraft(String(c));
        }
    };

    const step = (delta: number) => {
        const c = clamp(value + delta);
        onChange(c);
        setDraft(String(c));
    };

    return (
        <div className="flex flex-col gap-1.5">
            <label className="text-[13px] font-medium text-slate-700">{label}</label>
            <div className="flex items-center gap-1.5">
                <button
                    type="button"
                    onClick={() => step(-1)}
                    className="w-8 h-9 rounded-lg border border-slate-200 text-slate-500 hover:border-[#1677ff] hover:text-[#1677ff] flex items-center justify-center transition-colors"
                >
                    <Minus size={14} />
                </button>
                <div className="relative flex-1">
                    <input
                        type="text"
                        inputMode="numeric"
                        value={draft}
                        onFocus={() => { focusedRef.current = true; }}
                        onChange={(e) => handleInputChange(e.target.value.replace(/[^0-9]/g, ''))}
                        onBlur={handleBlur}
                        className="w-full h-9 px-3 rounded-lg border border-slate-200 bg-white text-sm text-slate-700 text-center focus:outline-none focus:border-[#1677ff]"
                    />
                    {suffix && <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-slate-400 pointer-events-none">{suffix}</span>}
                </div>
                <button
                    type="button"
                    onClick={() => step(1)}
                    className="w-8 h-9 rounded-lg border border-slate-200 text-slate-500 hover:border-[#1677ff] hover:text-[#1677ff] flex items-center justify-center transition-colors"
                >
                    <Plus size={14} />
                </button>
            </div>
        </div>
    );
};

// ============================================================================
// 资产展示小组件
// ============================================================================

const ASSET_META = {
    characters: { label: '人物', icon: Users, color: 'text-[#1677ff] bg-[#e8f1ff]' },
    scenes: { label: '场景', icon: MapPin, color: 'text-[#00b42a] bg-[#e8ffea]' },
    props: { label: '道具', icon: Package, color: 'text-[#ff7d00] bg-[#fff3e8]' },
} as const;

interface AssetListProps {
    assets: { characters: { name: string; description?: string }[]; scenes: { name: string; description?: string }[]; props: { name: string; description?: string }[] };
    /** 在固定高度的容器中使用时，三列撑满高度并各自滚动 */
    fill?: boolean;
}

/** 三列资产清单（人物 / 场景 / 道具） */
const AssetList: React.FC<AssetListProps> = ({ assets, fill = false }) => {
    return (
        <div className={fill ? 'grid grid-cols-3 gap-3 h-full' : 'grid grid-cols-3 gap-3'}>
            {(Object.keys(ASSET_META) as (keyof typeof ASSET_META)[]).map((key) => {
                const meta = ASSET_META[key];
                const items = assets[key] || [];
                return (
                    <div key={key} className={`border border-slate-200 rounded-lg overflow-hidden flex flex-col ${fill ? 'h-full' : ''}`}>
                        <div className="flex items-center gap-1.5 px-3 py-2 bg-[#fafafa] border-b border-slate-100 shrink-0">
                            <meta.icon size={14} className={meta.color.split(' ')[0]} />
                            <span className="text-[13px] font-medium text-slate-700">{meta.label}</span>
                            <span className="text-[12px] text-slate-400 ml-auto">{items.length}</span>
                        </div>
                        <div className={`p-2 overflow-y-auto ${fill ? 'flex-1' : 'max-h-[220px]'}`}>
                            {items.length === 0 ? (
                                <div className="text-[12px] text-slate-300 py-2 text-center">—</div>
                            ) : (
                                items.map((item, i) => (
                                    <div key={i} className="px-1.5 py-1.5 rounded hover:bg-slate-50">
                                        <div className="text-[13px] text-slate-800 font-medium">{item.name}</div>
                                        {item.description && <div className="text-[11px] text-slate-400 mt-0.5 leading-snug">{item.description}</div>}
                                    </div>
                                ))
                            )}
                        </div>
                    </div>
                );
            })}
        </div>
    );
};

// ============================================================================
// 主组件
// ============================================================================

interface CreateProjectModalProps {
    isOpen: boolean;
    onClose: () => void;
    onCreate: (data: CreateProjectData) => void;
}

export const CreateProjectModal: React.FC<CreateProjectModalProps> = ({ isOpen, onClose, onCreate }) => {
    const [step, setStep] = useState(1);

    // 第 1 步：基础信息
    const [name, setName] = useState('');
    const [contentType, setContentType] = useState(CONTENT_TYPES[0]);
    const [department, setDepartment] = useState(DEPARTMENTS[0]);
    const [owner, setOwner] = useState(OWNERS[0]);
    const [productionMode, setProductionMode] = useState(PRODUCTION_MODES[1]);
    const [aspectRatio, setAspectRatio] = useState(ASPECT_RATIOS[0]);
    const [targetDuration, setTargetDuration] = useState(90);

    // 第 2 步：选择剧本
    const [sourceTab, setSourceTab] = useState<'library' | 'upload'>('library');
    const [search, setSearch] = useState('');
    const [selectedScriptId, setSelectedScriptId] = useState<string>(LIBRARY_SCRIPTS[0].id);
    const [uploadedFileName, setUploadedFileName] = useState('');
    const [uploadedScriptText, setUploadedScriptText] = useState('');
    const fileInputRef = useRef<HTMLInputElement>(null);

    // 第 3 步：剧本分集
    const [analysisStatus, setAnalysisStatus] = useState<'idle' | 'analyzing' | 'done' | 'error'>('idle');
    const [analysisError, setAnalysisError] = useState('');
    const [analysis, setAnalysis] = useState<ScriptAnalysis | null>(null);
    // 第 3 / 4 步左侧分集导航当前选中的集索引
    const [activeEpisode, setActiveEpisode] = useState(0);
    // 记录上次成功解析时的输入指纹，用于判断返回修改后是否需要重新解析
    const analyzedInputRef = useRef('');

    // 第 4 步：资产识别
    const [assetStatus, setAssetStatus] = useState<'idle' | 'analyzing' | 'done' | 'error'>('idle');
    const [assetError, setAssetError] = useState('');

    // 轻量提示
    const [toast, setToast] = useState('');
    const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const showToast = (msg: string) => {
        setToast(msg);
        if (toastTimer.current) clearTimeout(toastTimer.current);
        toastTimer.current = setTimeout(() => setToast(''), 2000);
    };

    // 打开时重置
    useEffect(() => {
        if (isOpen) {
            setStep(1);
            setName('');
            setContentType(CONTENT_TYPES[0]);
            setDepartment(DEPARTMENTS[0]);
            setOwner(OWNERS[0]);
            setProductionMode(PRODUCTION_MODES[1]);
            setAspectRatio(ASPECT_RATIOS[0]);
            setTargetDuration(90);
            setSourceTab('library');
            setSearch('');
            setSelectedScriptId(LIBRARY_SCRIPTS[0].id);
            setUploadedFileName('');
            setUploadedScriptText('');
            resetAnalysis();
        }
    }, [isOpen]);

    useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

    const selectedScript = LIBRARY_SCRIPTS.find((s) => s.id === selectedScriptId) || LIBRARY_SCRIPTS[0];

    const resetAnalysis = () => {
        setAnalysisStatus('idle');
        setAnalysisError('');
        setAnalysis(null);
        setActiveEpisode(0);
        setAssetStatus('idle');
        setAssetError('');
    };

    /** 解析输入指纹：时长 + 剧本来源 + 剧本标识 */
    const getInputKey = () =>
        `${targetDuration}|${sourceTab}|${sourceTab === 'upload' ? uploadedFileName : selectedScriptId}`;

    /**
     * 跳转到指定步骤（前进或回退均可）。
     * 「上一步」仅用于回退查看，不会清除任何已产生的数据。
     */
    const goToStep = (target: number) => {
        if (target < 1 || target > STEPS.length) return;
        setStep(target);
    };

    const handleNext = () => {
        if (step === 1) {
            if (!name.trim()) { showToast('请填写项目名称'); return; }
            goToStep(2);
            return;
        }
        if (step === 2) {
            if (sourceTab === 'upload' && !uploadedFileName) { showToast('请先上传剧本文件'); return; }
            // 剧本或时长发生变化时才清空旧解析结果；仅回退查看则保留
            if (analyzedInputRef.current && analyzedInputRef.current !== getInputKey()) resetAnalysis();
            goToStep(3);
            return;
        }
        if (step === 3) {
            if (analysisStatus !== 'done') { showToast('请先完成剧本分集'); return; }
            goToStep(4);
            return;
        }
        if (step === 4) {
            if (assetStatus !== 'done') { showToast('请先完成资产识别'); return; }
            goToStep(5);
            return;
        }
    };

    const handlePrev = () => {
        if (step > 1) goToStep(step - 1);
    };

    /** 读取上传文件内容：支持 .txt / .md / .docx（老版 .doc 需另存为 .docx） */
    const handleUploadFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (!file) return;
        setUploadedFileName(file.name);
        const ext = (file.name.split('.').pop() || '').toLowerCase();
        try {
            if (ext === 'txt' || ext === 'md' || ext === 'text') {
                setUploadedScriptText(await file.text());
            } else if (ext === 'docx') {
                const text = await extractDocxText(await file.arrayBuffer());
                if (!text.trim()) { setUploadedScriptText(''); showToast('未能从 Word 文档中提取到文本'); return; }
                setUploadedScriptText(text);
            } else if (ext === 'doc') {
                setUploadedScriptText('');
                showToast('暂不支持老版 .doc，请用 Word 另存为 .docx 后上传');
            } else {
                setUploadedScriptText('');
                showToast('仅支持 .txt / .md / .docx 文档');
            }
        } catch {
            setUploadedScriptText('');
            showToast('文件读取失败，请重试');
        }
    };

    /** 当前剧本全文（library 取演示文本，upload 取已提取的文本内容） */
    const getScriptText = () =>
        (sourceTab === 'upload' ? uploadedScriptText : DEMO_SCRIPT_TEXTS[selectedScriptId] || '').trim();

    const genre = sourceTab === 'upload' ? '' : selectedScript.genre;

    /** 第 3 步：只做「分集」（不识别资产），调用后端 /split-episodes，速度快 */
    const handleStartSplit = async () => {
        const text = getScriptText();
        if (!text) {
            showToast('缺少剧本内容，无法分集');
            return;
        }

        setAnalysisStatus('analyzing');
        setAnalysisError('');
        setAnalysis(null);
        setAssetStatus('idle');
        setAssetError('');

        try {
            // 先尝试按文中「第N集」标记本地切分：可靠则走预切分模式（长剧本不截断、不串集）
            const preSplit = splitByEpisodeMarkers(text);
            const result = await splitEpisodes({
                text,
                title: dramaName,
                genre,
                targetDuration,
                preSplit: preSplit || undefined,
            });
            setAnalysis({
                totalEpisodes: result.totalEpisodes,
                episodes: result.episodes.map((e) => ({ ...e, assets: { characters: [], scenes: [], props: [] } })),
                assets: { characters: [], scenes: [], props: [] },
            });
            setAnalysisStatus('done');
            setActiveEpisode(0);
            analyzedInputRef.current = getInputKey();
        } catch (err) {
            setAnalysisError(err instanceof Error ? err.message : '分集失败');
            setAnalysisStatus('error');
        }
    };

    /** 第 4 步：基于已确定的分集识别每集资产，调用后端 /analyze-assets */
    const handleStartAssets = async () => {
        if (!analysis || analysis.episodes.length === 0) {
            showToast('请先完成剧本分集');
            return;
        }
        const text = getScriptText();
        setAssetStatus('analyzing');
        setAssetError('');
        try {
            const result = await analyzeAssets({
                text,
                title: dramaName,
                genre,
                episodes: analysis.episodes,
            });
            setAnalysis((prev) => prev ? {
                ...prev,
                assets: result.assets,
                episodes: prev.episodes.map((ep) => {
                    const matched = result.episodes.find((r) => Number(r.episode) === Number(ep.episode));
                    return { ...ep, assets: matched ? matched.assets : { characters: [], scenes: [], props: [] } };
                }),
            } : prev);
            setAssetStatus('done');
            setActiveEpisode(0);
        } catch (err) {
            setAssetError(err instanceof Error ? err.message : '资产识别失败');
            setAssetStatus('error');
        }
    };

    const updateEpisodeTitle = (idx: number, title: string) => {
        setAnalysis((prev) => prev ? {
            ...prev,
            episodes: prev.episodes.map((e, i) => i === idx ? { ...e, title } : e),
        } : prev);
    };

    const scriptName = sourceTab === 'upload'
        ? uploadedFileName.replace(/\.[^.]+$/, '')
        : selectedScript.name;
    const dramaName = sourceTab === 'upload'
        ? uploadedFileName.replace(/\.[^.]+$/, '')
        : selectedScript.drama;

    const totalEpisodes = analysis?.totalEpisodes || 0;

    const handleSubmit = () => {
        onCreate({
            name: name.trim(),
            category: contentType,
            department,
            owner,
            productionMode,
            aspectRatio,
            targetDuration,
            scriptSource: sourceTab === 'upload' ? '本地上传' : '资源库',
            scriptName,
            dramaName,
            totalEpisodes,
            scriptAnalysis: analysis,
        });
        onClose();
    };

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-[100] flex items-center justify-center p-4">
            <div className="bg-white rounded-2xl shadow-2xl w-[920px] max-w-[95vw] max-h-[92vh] overflow-hidden flex flex-col">

                {/* 顶部标题 + 步骤条 */}
                <div className="px-6 pt-5 pb-4 border-b border-slate-100">
                    <div className="flex items-start justify-between">
                        <div>
                            <h3 className="text-lg font-semibold text-slate-900">新建制作项目</h3>
                            <p className="text-[12px] text-slate-400 mt-0.5">先建立项目草稿，再完成剧本分集、资产识别与拆集确认。</p>
                        </div>
                        <button
                            onClick={onClose}
                            className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition-colors"
                        >
                            <X size={18} />
                        </button>
                    </div>

                    {/* 步骤条（已完成的步骤可点击回退修改） */}
                    <div className="mt-4 flex items-center gap-1">
                        {STEPS.map((s, i) => {
                            const num = i + 1;
                            const isDone = num < step;
                            const isCurrent = num === step;
                            const clickable = isDone;
                            return (
                                <React.Fragment key={s.title}>
                                    {i > 0 && (
                                        <div className={`h-px flex-1 min-w-3 ${num <= step ? 'bg-[#1677ff]' : 'bg-slate-200'}`} />
                                    )}
                                    <div
                                        onClick={clickable ? () => goToStep(num) : undefined}
                                        title={clickable ? `返回「${s.title}」修改` : undefined}
                                        className={`flex flex-col items-center gap-1 shrink-0 ${clickable ? 'cursor-pointer' : ''}`}
                                    >
                                        <div className={`w-7 h-7 rounded-full flex items-center justify-center text-[12px] font-semibold border transition-colors ${isDone ? 'bg-[#1677ff] border-[#1677ff] text-white' : isCurrent ? 'bg-[#e8f1ff] border-[#1677ff] text-[#1677ff]' : 'bg-white border-slate-200 text-slate-400'} ${clickable ? 'hover:opacity-80' : ''}`}>
                                            {isDone ? <Check size={14} /> : num}
                                        </div>
                                        <div className="text-center">
                                            <div className={`text-[12px] font-medium leading-tight ${isCurrent ? 'text-[#1677ff]' : isDone ? 'text-slate-700' : 'text-slate-400'} ${clickable ? 'hover:text-[#1677ff]' : ''}`}>{s.title}</div>
                                            <div className="text-[10px] text-slate-400 leading-tight mt-0.5 hidden lg:block">{s.desc}</div>
                                        </div>
                                    </div>
                                </React.Fragment>
                            );
                        })}
                    </div>
                </div>

                {/* 内容区 */}
                <div className="flex-1 overflow-y-auto px-6 py-5">
                    {/* ============ 第 1 步：项目基础信息 ============ */}
                    {step === 1 && (
                        <div className="grid grid-cols-2 gap-x-6 gap-y-4 max-w-[680px] mx-auto">
                            <div className="col-span-2">
                                <label className="text-[13px] font-medium text-slate-700">
                                    <span className="text-red-500">* </span>项目名称
                                </label>
                                <input
                                    type="text"
                                    value={name}
                                    onChange={(e) => setName(e.target.value)}
                                    placeholder="请输入项目名称"
                                    className="mt-1.5 w-full h-9 px-3 rounded-lg border border-slate-200 bg-white text-sm text-slate-700 focus:outline-none focus:border-[#1677ff]"
                                />
                            </div>
                            <SelectField label="内容类型" required value={contentType} options={CONTENT_TYPES} onChange={setContentType} />
                            <SelectField label="制作部门" required value={department} options={DEPARTMENTS} onChange={setDepartment} />
                            <SelectField label="项目负责人" required value={owner} options={OWNERS} onChange={setOwner} />

                            <div className="col-span-2">
                                <label className="text-[13px] font-medium text-slate-700">生产模式</label>
                                <div className="mt-1.5 flex gap-3">
                                    {PRODUCTION_MODES.map((mode) => (
                                        <label key={mode} className="flex items-center gap-2 cursor-pointer text-sm text-slate-700">
                                            <input
                                                type="radio"
                                                name="productionMode"
                                                checked={productionMode === mode}
                                                onChange={() => setProductionMode(mode)}
                                                className="accent-[#1677ff]"
                                            />
                                            {mode}
                                        </label>
                                    ))}
                                </div>
                            </div>

                            <div className="col-span-2 max-w-[260px]">
                                <NumberField label="单集目标时长" value={targetDuration} onChange={setTargetDuration} min={10} max={600} suffix="秒" />
                            </div>
                        </div>
                    )}

                    {/* ============ 第 2 步：选择剧本 ============ */}
                    {step === 2 && (
                        <div>
                            <div className="flex items-center gap-1 border-b border-slate-100 mb-4">
                                <button
                                    onClick={() => setSourceTab('library')}
                                    className={`px-4 h-9 text-sm font-medium border-b-2 transition-colors ${sourceTab === 'library' ? 'text-[#1677ff] border-[#1677ff]' : 'text-slate-500 border-transparent hover:text-slate-700'}`}
                                >
                                    资源库选择
                                </button>
                                <button
                                    onClick={() => setSourceTab('upload')}
                                    className={`px-4 h-9 text-sm font-medium border-b-2 transition-colors ${sourceTab === 'upload' ? 'text-[#1677ff] border-[#1677ff]' : 'text-slate-500 border-transparent hover:text-slate-700'}`}
                                >
                                    本地上传剧本
                                </button>
                            </div>

                            {sourceTab === 'library' ? (
                                <>
                                    <div className="relative mb-4">
                                        <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                                        <input
                                            type="text"
                                            value={search}
                                            onChange={(e) => setSearch(e.target.value)}
                                            placeholder="搜索剧本名、剧目或题材"
                                            className="w-full h-9 pl-9 pr-3 rounded-lg border border-slate-200 bg-white text-sm text-slate-700 focus:outline-none focus:border-[#1677ff]"
                                        />
                                    </div>
                                    <div className="flex flex-col gap-2">
                                        {LIBRARY_SCRIPTS.filter((s) => {
                                            const kw = search.trim().toLowerCase();
                                            if (!kw) return true;
                                            return (s.name + s.drama + s.genre).toLowerCase().includes(kw);
                                        }).map((s) => {
                                            const active = s.id === selectedScriptId;
                                            return (
                                                <button
                                                    key={s.id}
                                                    type="button"
                                                    onClick={() => setSelectedScriptId(s.id)}
                                                    className={`flex items-center gap-3 px-4 py-3 rounded-xl border text-left transition-colors ${active ? 'border-[#1677ff] bg-[#f5f9ff]' : 'border-slate-200 bg-white hover:border-slate-300'}`}
                                                >
                                                    <FileText size={20} className={active ? 'text-[#1677ff]' : 'text-slate-400'} />
                                                    <div className="flex-1 min-w-0">
                                                        <div className="flex items-center gap-2">
                                                            <span className={`text-sm font-medium ${active ? 'text-[#1677ff]' : 'text-slate-800'}`}>{s.name}</span>
                                                            <span className="text-[11px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-500">{s.version}</span>
                                                        </div>
                                                        <div className="text-[12px] text-slate-400 mt-0.5">{s.drama} · {s.genre} · {s.episodes} 集 · {s.words} · {s.updatedAt}</div>
                                                    </div>
                                                    {active && <CheckCircle2 size={18} className="text-[#1677ff] shrink-0" />}
                                                </button>
                                            );
                                        })}
                                    </div>
                                </>
                            ) : uploadedFileName ? (
                                <div className="border border-slate-200 rounded-xl p-4">
                                    <div className="flex items-center justify-between mb-3">
                                        <div className="flex items-center gap-2 min-w-0">
                                            <FileText size={18} className="text-[#1677ff] shrink-0" />
                                            <span className="text-sm font-medium text-slate-800 truncate">{uploadedFileName}</span>
                                            <span className="text-[12px] text-slate-400 whitespace-nowrap">{uploadedScriptText.length} 字</span>
                                        </div>
                                        <button
                                            type="button"
                                            onClick={() => fileInputRef.current?.click()}
                                            className="text-[12px] text-[#1677ff] hover:underline shrink-0 ml-3"
                                        >
                                            重新上传
                                        </button>
                                    </div>
                                    <div className="border border-slate-100 rounded-lg bg-[#fafafa] p-3 max-h-[280px] overflow-y-auto">
                                        <pre className="text-[12px] text-slate-600 whitespace-pre-wrap leading-relaxed font-sans">
                                            {uploadedScriptText || '（未能提取到文本内容，请确认文档格式）'}
                                        </pre>
                                    </div>
                                    <input ref={fileInputRef} type="file" accept=".txt,.md,.text,.doc,.docx" className="hidden" onChange={handleUploadFile} />
                                </div>
                            ) : (
                                <div
                                    onClick={() => fileInputRef.current?.click()}
                                    className="border-2 border-dashed border-slate-200 rounded-xl py-14 flex flex-col items-center justify-center text-slate-400 hover:border-[#1677ff] hover:text-[#1677ff] cursor-pointer transition-colors"
                                >
                                    <Upload size={28} className="mb-3" />
                                    <div className="text-sm text-slate-600">点击上传剧本文件</div>
                                    <div className="text-[12px] text-slate-400 mt-1">支持 .txt / .md / .docx 文档</div>
                                    <input ref={fileInputRef} type="file" accept=".txt,.md,.text,.doc,.docx" className="hidden" onChange={handleUploadFile} />
                                </div>
                            )}
                        </div>
                    )}

                    {/* ============ 第 3 步：剧本分集 ============ */}
                    {step === 3 && (
                        <div>
                            {analysisStatus === 'idle' && (
                                <div className="py-16 flex flex-col items-center justify-center text-center">
                                    <div className="w-16 h-16 rounded-full bg-[#e8f1ff] text-[#1677ff] flex items-center justify-center mb-4">
                                        <Sparkles size={28} />
                                    </div>
                                    <div className="text-[15px] font-medium text-slate-800 mb-1">启动智能分集</div>
                                    <div className="text-[12px] text-slate-400 mb-6 max-w-[420px]">
                                        AI 将分析剧本全文，自动识别分集，并生成每集的标题与剧情概要
                                    </div>
                                    <div className="flex items-center gap-4">
                                        <div className="text-[12px] text-slate-400">集数由 AI 根据剧本内容自动识别</div>
                                        <button
                                            onClick={handleStartSplit}
                                            className="flex items-center gap-2 h-9 px-5 rounded-lg bg-[#1677ff] hover:bg-[#4080ff] text-white text-sm font-medium transition-colors"
                                        >
                                            <Sparkles size={15} />
                                            启动智能分集
                                        </button>
                                    </div>
                                </div>
                            )}

                            {analysisStatus === 'analyzing' && (
                                <div className="py-20 flex flex-col items-center justify-center text-center">
                                    <Loader2 size={32} className="text-[#1677ff] animate-spin mb-4" />
                                    <div className="text-[15px] font-medium text-slate-800 mb-1">AI 正在智能分集</div>
                                    <div className="text-[12px] text-slate-400">正在识别分集、生成每集标题与剧情概要…</div>
                                    <div className="text-[12px] text-slate-400 mt-3">剧本较长时约需 1~3 分钟，请耐心等待，不要关闭窗口</div>
                                </div>
                            )}

                            {analysisStatus === 'error' && (
                                <div className="py-20 flex flex-col items-center justify-center text-center">
                                    <div className="w-14 h-14 rounded-full bg-[#ffece8] text-[#f53f3f] flex items-center justify-center mb-4">
                                        <AlertCircle size={26} />
                                    </div>
                                    <div className="text-[15px] font-medium text-slate-800 mb-1">分集失败</div>
                                    <div className="text-[12px] text-slate-400 mb-5 max-w-[420px]">{analysisError || '请稍后重试'}</div>
                                    <button
                                        onClick={handleStartSplit}
                                        className="flex items-center gap-2 h-9 px-5 rounded-lg bg-[#1677ff] hover:bg-[#4080ff] text-white text-sm font-medium transition-colors"
                                    >
                                        <RefreshCw size={15} />
                                        重新分集
                                    </button>
                                </div>
                            )}

                            {analysisStatus === 'done' && analysis && (
                                <div>
                                    {/* 结果头 */}
                                    <div className="flex items-center justify-between mb-3">
                                        <div className="flex items-center gap-2">
                                            <CheckCircle2 size={18} className="text-[#00b42a]" />
                                            <span className="text-[14px] font-medium text-slate-800">分集完成，共 {analysis.episodes.length} 集</span>
                                            <span className="text-[12px] text-slate-400">· 左侧选择分集，右侧查看对应剧本原文</span>
                                        </div>
                                        <button
                                            onClick={handleStartSplit}
                                            className="flex items-center gap-1.5 h-8 px-3 rounded-lg border border-slate-200 text-slate-600 hover:border-[#1677ff] hover:text-[#1677ff] text-[13px] transition-colors"
                                        >
                                            <RefreshCw size={14} />
                                            重新分集
                                        </button>
                                    </div>

                                    {/* 分集阅读器：左侧分集导航 + 右侧剧本原文 */}
                                    <div className="flex gap-3 h-[430px]">
                                        {/* 左侧分集导航 */}
                                        <div className="w-[150px] shrink-0 border border-slate-200 rounded-lg overflow-hidden flex flex-col">
                                            <div className="px-3 py-2 text-[12px] font-medium text-slate-500 bg-[#fafafa] border-b border-slate-100">分集目录</div>
                                            <div className="flex-1 overflow-y-auto">
                                                {analysis.episodes.map((ep, idx) => {
                                                    const active = activeEpisode === idx;
                                                    return (
                                                        <button
                                                            key={idx}
                                                            type="button"
                                                            onClick={() => setActiveEpisode(idx)}
                                                            className={`w-full text-left px-3 py-2 border-l-2 transition-colors ${active ? 'bg-[#e8f1ff] border-[#1677ff]' : 'border-transparent hover:bg-slate-50'}`}
                                                        >
                                                            <div className={`text-[13px] font-medium ${active ? 'text-[#1677ff]' : 'text-slate-700'}`}>
                                                                第 {String(ep.episode).padStart(2, '0')} 集
                                                            </div>
                                                            <div className={`text-[12px] truncate ${active ? 'text-[#1677ff]/70' : 'text-slate-400'}`}>
                                                                {ep.title}
                                                            </div>
                                                        </button>
                                                    );
                                                })}
                                            </div>
                                        </div>

                                        {/* 右侧内容：标题 / 概要 / 剧本原文 */}
                                        <div className="flex-1 min-w-0 border border-slate-200 rounded-lg overflow-hidden flex flex-col">
                                            {analysis.episodes[activeEpisode] ? (() => {
                                                const ep = analysis.episodes[activeEpisode];
                                                return (
                                                    <>
                                                        <div className="px-4 py-2.5 border-b border-slate-100 flex items-center gap-3">
                                                            <span className="text-[12px] text-slate-400 whitespace-nowrap">
                                                                第 {String(ep.episode).padStart(2, '0')} 集
                                                            </span>
                                                            <input
                                                                type="text"
                                                                value={ep.title}
                                                                onChange={(e) => updateEpisodeTitle(activeEpisode, e.target.value)}
                                                                className="w-[160px] px-2 py-1 rounded border border-transparent hover:border-slate-200 focus:border-[#1677ff] focus:outline-none text-[13px] font-medium text-slate-800 bg-transparent"
                                                            />
                                                            <span className="flex-1" />
                                                            <span className="text-[12px] text-slate-400 whitespace-nowrap">{ep.wordCount} 字</span>
                                                            <span className="text-[12px] text-slate-400 whitespace-nowrap">{formatDurationSeconds(ep.durationSeconds)}</span>
                                                        </div>
                                                        <div className="px-4 py-2 text-[12px] text-slate-500 leading-relaxed bg-[#fafafa] border-b border-slate-100">
                                                            {ep.summary || '暂无概要'}
                                                        </div>
                                                        <div className="flex-1 overflow-y-auto px-4 py-3 text-[13px] leading-7 text-slate-700 whitespace-pre-wrap">
                                                            {ep.content && ep.content.trim()
                                                                ? ep.content
                                                                : '（未能定位到该集的剧本原文，可点击右上角「重新分集」重试）'}
                                                        </div>
                                                    </>
                                                );
                                            })() : (
                                                <div className="flex-1 flex items-center justify-center text-[13px] text-slate-400">
                                                    请选择左侧分集
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            )}
                        </div>
                    )}

                    {/* ============ 第 4 步：智能解析（资产识别） ============ */}
                    {step === 4 && (
                        <div>
                            {assetStatus === 'idle' && (
                                <div className="py-16 flex flex-col items-center justify-center text-center">
                                    <div className="w-16 h-16 rounded-full bg-[#e8f1ff] text-[#1677ff] flex items-center justify-center mb-4">
                                        <Package size={28} />
                                    </div>
                                    <div className="text-[15px] font-medium text-slate-800 mb-1">启动资产识别</div>
                                    <div className="text-[12px] text-slate-400 mb-6 max-w-[420px]">
                                        基于已确认的 {analysis?.episodes.length || 0} 集分集，AI 将识别每集涉及的人物、场景、道具
                                    </div>
                                    <button
                                        onClick={handleStartAssets}
                                        className="flex items-center gap-2 h-9 px-5 rounded-lg bg-[#1677ff] hover:bg-[#4080ff] text-white text-sm font-medium transition-colors"
                                    >
                                        <Sparkles size={15} />
                                        启动资产识别
                                    </button>
                                </div>
                            )}

                            {assetStatus === 'analyzing' && (
                                <div className="py-20 flex flex-col items-center justify-center text-center">
                                    <Loader2 size={32} className="text-[#1677ff] animate-spin mb-4" />
                                    <div className="text-[15px] font-medium text-slate-800 mb-1">AI 正在识别资产</div>
                                    <div className="text-[12px] text-slate-400">正在提取每集的人物 / 场景 / 道具…</div>
                                </div>
                            )}

                            {assetStatus === 'error' && (
                                <div className="py-20 flex flex-col items-center justify-center text-center">
                                    <div className="w-14 h-14 rounded-full bg-[#ffece8] text-[#f53f3f] flex items-center justify-center mb-4">
                                        <AlertCircle size={26} />
                                    </div>
                                    <div className="text-[15px] font-medium text-slate-800 mb-1">资产识别失败</div>
                                    <div className="text-[12px] text-slate-400 mb-5 max-w-[420px]">{assetError || '请稍后重试'}</div>
                                    <button
                                        onClick={handleStartAssets}
                                        className="flex items-center gap-2 h-9 px-5 rounded-lg bg-[#1677ff] hover:bg-[#4080ff] text-white text-sm font-medium transition-colors"
                                    >
                                        <RefreshCw size={15} />
                                        重新识别
                                    </button>
                                </div>
                            )}

                            {assetStatus === 'done' && analysis && (
                                <div>
                                    {/* 结果头 */}
                                    <div className="flex items-center justify-between mb-3">
                                        <div className="flex items-center gap-2">
                                            <CheckCircle2 size={18} className="text-[#00b42a]" />
                                            <span className="text-[14px] font-medium text-slate-800">资产识别完成</span>
                                            <span className="text-[12px] text-slate-400">
                                                全剧 人物 {analysis.assets.characters.length} · 场景 {analysis.assets.scenes.length} · 道具 {analysis.assets.props.length}
                                            </span>
                                            <span className="text-[12px] text-slate-400">· 左侧选择分集查看每集资产</span>
                                        </div>
                                        <button
                                            onClick={handleStartAssets}
                                            className="flex items-center gap-1.5 h-8 px-3 rounded-lg border border-slate-200 text-slate-600 hover:border-[#1677ff] hover:text-[#1677ff] text-[13px] transition-colors"
                                        >
                                            <RefreshCw size={14} />
                                            重新识别
                                        </button>
                                    </div>

                                    {/* 资产阅读器：左侧分集导航 + 右侧该集资产 */}
                                    <div className="flex gap-3 h-[430px]">
                                        {/* 左侧分集导航 */}
                                        <div className="w-[150px] shrink-0 border border-slate-200 rounded-lg overflow-hidden flex flex-col">
                                            <div className="px-3 py-2 text-[12px] font-medium text-slate-500 bg-[#fafafa] border-b border-slate-100">分集目录</div>
                                            <div className="flex-1 overflow-y-auto">
                                                {analysis.episodes.map((ep, idx) => {
                                                    const active = activeEpisode === idx;
                                                    const count = ep.assets.characters.length + ep.assets.scenes.length + ep.assets.props.length;
                                                    return (
                                                        <button
                                                            key={idx}
                                                            type="button"
                                                            onClick={() => setActiveEpisode(idx)}
                                                            className={`w-full text-left px-3 py-2 border-l-2 transition-colors ${active ? 'bg-[#e8f1ff] border-[#1677ff]' : 'border-transparent hover:bg-slate-50'}`}
                                                        >
                                                            <div className={`text-[13px] font-medium ${active ? 'text-[#1677ff]' : 'text-slate-700'}`}>
                                                                第 {String(ep.episode).padStart(2, '0')} 集
                                                            </div>
                                                            <div className={`text-[12px] truncate ${active ? 'text-[#1677ff]/70' : 'text-slate-400'}`}>
                                                                {ep.title} · {count} 项
                                                            </div>
                                                        </button>
                                                    );
                                                })}
                                            </div>
                                        </div>

                                        {/* 右侧该集资产 */}
                                        <div className="flex-1 min-w-0 border border-slate-200 rounded-lg overflow-hidden flex flex-col">
                                            {analysis.episodes[activeEpisode] ? (() => {
                                                const ep = analysis.episodes[activeEpisode];
                                                const count = ep.assets.characters.length + ep.assets.scenes.length + ep.assets.props.length;
                                                return (
                                                    <>
                                                        <div className="px-4 py-2.5 border-b border-slate-100 flex items-center gap-3">
                                                            <span className="text-[12px] text-slate-400 whitespace-nowrap">
                                                                第 {String(ep.episode).padStart(2, '0')} 集
                                                            </span>
                                                            <span className="text-[13px] font-medium text-slate-800">{ep.title}</span>
                                                            <span className="flex-1" />
                                                            <span className="text-[12px] text-slate-400 whitespace-nowrap">{count} 项资产</span>
                                                        </div>
                                                        <div className="flex-1 min-h-0 px-4 py-3">
                                                            {count > 0 ? (
                                                                <AssetList assets={ep.assets} fill />
                                                            ) : (
                                                                <div className="flex h-full items-center justify-center text-[13px] text-slate-400">
                                                                    该集未识别到资产
                                                                </div>
                                                            )}
                                                        </div>
                                                    </>
                                                );
                                            })() : (
                                                <div className="flex-1 flex items-center justify-center text-[13px] text-slate-400">
                                                    请选择左侧分集
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            )}
                        </div>
                    )}

                    {/* ============ 第 5 步：确认创建 ============ */}
                    {step === 5 && (
                        <div className="max-w-[560px] mx-auto">
                            <div className="border border-slate-200 rounded-xl overflow-hidden mb-4">
                                <table className="w-full text-sm">
                                    <tbody>
                                        {[
                                            ['项目名称', name],
                                            ['内容类型', contentType],
                                            ['锁定剧本', scriptName],
                                            ['已确认集数', `${totalEpisodes} 集`],
                                            ['生产模式', productionMode],
                                            ['项目负责人', owner],
                                        ].map(([k, v]) => (
                                            <tr key={k} className="border-b border-slate-100 last:border-0">
                                                <td className="px-4 py-3 w-32 bg-[#fafafa] text-slate-500">{k}</td>
                                                <td className="px-4 py-3 text-slate-800 font-medium">{v}</td>
                                            </tr>
                                        ))}
                                        {analysis && (
                                            <tr>
                                                <td className="px-4 py-3 w-32 bg-[#fafafa] text-slate-500">识别资产</td>
                                                <td className="px-4 py-3 text-slate-800">
                                                    人物 {analysis.assets.characters.length} · 场景 {analysis.assets.scenes.length} · 道具 {analysis.assets.props.length}
                                                </td>
                                            </tr>
                                        )}
                                    </tbody>
                                </table>
                            </div>

                            <label className="flex items-center gap-2 text-sm text-slate-600 mb-2 cursor-pointer">
                                <input type="checkbox" checked readOnly className="accent-[#1677ff]" />
                                拆集结果已确认并锁定为 V1
                            </label>
                            <label className="flex items-center gap-2 text-sm text-slate-600 cursor-pointer">
                                <input type="checkbox" checked readOnly className="accent-[#1677ff]" />
                                创建后通知项目负责人处理资产确认
                            </label>
                        </div>
                    )}
                </div>

                {/* 底部按钮 */}
                <div className="px-6 py-4 border-t border-slate-100 flex items-center justify-between">
                    <button
                        onClick={step === 1 ? onClose : handlePrev}
                        className="h-9 px-4 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 text-sm transition-colors"
                    >
                        {step === 1 ? '取消' : '上一步'}
                    </button>
                    {step < 5 ? (
                        <button
                            onClick={handleNext}
                            disabled={(step === 3 && analysisStatus !== 'done') || (step === 4 && assetStatus !== 'done')}
                            className={`flex items-center gap-1.5 h-9 px-4 rounded-lg text-sm font-medium transition-colors ${(step === 3 && analysisStatus !== 'done') || (step === 4 && assetStatus !== 'done') ? 'bg-slate-100 text-slate-400 cursor-not-allowed' : 'bg-[#1677ff] hover:bg-[#4080ff] text-white'}`}
                        >
                            下一步
                            <ArrowRight size={15} />
                        </button>
                    ) : (
                        <button
                            onClick={handleSubmit}
                            className="flex items-center gap-1.5 h-9 px-4 rounded-lg bg-[#1677ff] hover:bg-[#4080ff] text-white text-sm font-medium transition-colors"
                        >
                            <CheckCircle2 size={15} />
                            创建项目并进入资产确认
                        </button>
                    )}
                </div>

                {/* Toast 提示 */}
                {toast && (
                    <div className="absolute bottom-20 left-1/2 -translate-x-1/2 bg-slate-900/90 text-white text-[13px] px-4 py-2 rounded-lg shadow-lg z-30">
                        {toast}
                    </div>
                )}
            </div>
        </div>
    );
};

export default CreateProjectModal;
