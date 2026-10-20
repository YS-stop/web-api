import React from 'react';
import { useTranslation } from 'react-i18next';
import { X, Type, Image as ImageIcon, Video, LayoutTemplate, ArrowRight } from 'lucide-react';
import { NodeType } from '../types';

// ============================================================================
// TYPES
// ============================================================================

export interface TemplateNodeSpec {
    type: NodeType;
    title: string;
    prompt: string;
    dx: number;
    dy: number;
    parentIndices?: number[]; // index into the template's nodes array
}

export interface WorkflowTemplate {
    id: string;
    name: string;
    description: string;
    icon: 'text-to-image' | 'image-to-video' | 'text-to-video';
    nodes: TemplateNodeSpec[];
}

// ============================================================================
// PRESET TEMPLATES
// ============================================================================

export const PRESET_TEMPLATES: WorkflowTemplate[] = [
    {
        id: 'text-to-image',
        name: '文生图',
        description: '文本节点生成一张图片，适合快速出图。',
        icon: 'text-to-image',
        nodes: [
            { type: NodeType.TEXT, title: '文本', prompt: '', dx: 0, dy: 0 },
            { type: NodeType.IMAGE, title: '图片', prompt: '', dx: 380, dy: 0, parentIndices: [0] }
        ]
    },
    {
        id: 'image-to-video',
        name: '图生视频',
        description: '图片节点生成一段动态视频。',
        icon: 'image-to-video',
        nodes: [
            { type: NodeType.IMAGE, title: '图片', prompt: '', dx: 0, dy: 0 },
            { type: NodeType.VIDEO, title: '视频', prompt: '', dx: 380, dy: 0, parentIndices: [0] }
        ]
    },
    {
        id: 'text-to-video',
        name: '文生视频',
        description: '文本节点直接生成一段视频。',
        icon: 'text-to-video',
        nodes: [
            { type: NodeType.TEXT, title: '文本', prompt: '', dx: 0, dy: 0 },
            { type: NodeType.VIDEO, title: '视频', prompt: '', dx: 380, dy: 0, parentIndices: [0] }
        ]
    }
];

// ============================================================================
// COMPONENT
// ============================================================================

interface TemplateLibraryPanelProps {
    isOpen: boolean;
    onClose: () => void;
    onApplyTemplate: (template: WorkflowTemplate) => void;
    panelY?: number;
    canvasTheme?: 'dark' | 'light';
}

const TEMPLATE_ICONS: Record<WorkflowTemplate['icon'], React.ReactNode> = {
    'text-to-image': (
        <span className="flex items-center gap-1">
            <Type size={16} />
            <ArrowRight size={12} />
            <ImageIcon size={16} />
        </span>
    ),
    'image-to-video': (
        <span className="flex items-center gap-1">
            <ImageIcon size={16} />
            <ArrowRight size={12} />
            <Video size={16} />
        </span>
    ),
    'text-to-video': (
        <span className="flex items-center gap-1">
            <Type size={16} />
            <ArrowRight size={12} />
            <Video size={16} />
        </span>
    )
};

export const TemplateLibraryPanel: React.FC<TemplateLibraryPanelProps> = ({
    isOpen,
    onClose,
    onApplyTemplate,
    panelY = 100,
    canvasTheme = 'dark'
}) => {
    const { t } = useTranslation();

    if (!isOpen) return null;

    const isDark = canvasTheme === 'dark';

    return (
        <div
            className={`fixed left-20 z-40 w-[560px] backdrop-blur-xl border rounded-2xl shadow-2xl flex flex-col max-h-[500px] overflow-hidden animate-in slide-in-from-left-4 duration-200 transition-colors ${isDark ? 'bg-[#0a0a0a]/95 border-neutral-800' : 'bg-white/95 border-neutral-200'}`}
            style={{ top: Math.min(window.innerHeight - 510, Math.max(20, panelY)) }}
        >
            <div className={`flex items-center justify-between p-4 border-b ${isDark ? 'border-neutral-800' : 'border-neutral-200'}`}>
                <div className="flex items-center gap-2">
                    <LayoutTemplate size={18} className={isDark ? 'text-violet-300' : 'text-violet-600'} />
                    <h2 className={`text-base font-medium ${isDark ? 'text-white' : 'text-neutral-900'}`}>{t('templateLibrary.title')}</h2>
                </div>
                <button
                    onClick={onClose}
                    className={`p-2 rounded-lg transition-colors ${isDark ? 'hover:bg-neutral-800 text-neutral-400 hover:text-white' : 'hover:bg-neutral-100 text-neutral-500 hover:text-neutral-900'}`}
                >
                    <X size={18} />
                </button>
            </div>

            <p className={`px-4 pt-3 text-xs ${isDark ? 'text-neutral-500' : 'text-neutral-400'}`}>{t('templateLibrary.describe')}</p>

            <div className="p-4 flex flex-col gap-3 overflow-y-auto">
                {PRESET_TEMPLATES.map(template => (
                    <div
                        key={template.id}
                        className={`flex items-center gap-3 p-3 rounded-xl border transition-colors ${isDark ? 'bg-neutral-900/60 border-neutral-800 hover:border-neutral-600' : 'bg-white border-neutral-200 hover:border-neutral-300'}`}
                    >
                        <div className={`w-12 h-12 shrink-0 rounded-lg flex items-center justify-center ${isDark ? 'bg-neutral-800 text-violet-300' : 'bg-violet-50 text-violet-600'}`}>
                            {TEMPLATE_ICONS[template.icon]}
                        </div>
                        <div className="min-w-0 flex-1">
                            <div className={`text-sm font-medium ${isDark ? 'text-white' : 'text-neutral-900'}`}>{template.name}</div>
                            <div className={`text-xs mt-0.5 ${isDark ? 'text-neutral-500' : 'text-neutral-500'}`}>{template.description}</div>
                            <div className={`text-[11px] mt-1 ${isDark ? 'text-neutral-600' : 'text-neutral-400'}`}>
                                {t('templateLibrary.nodes', { count: template.nodes.length })}
                            </div>
                        </div>
                        <button
                            onClick={() => onApplyTemplate(template)}
                            className={`shrink-0 h-9 px-3 rounded-lg text-sm font-medium transition-colors ${isDark ? 'bg-violet-500 hover:bg-violet-400 text-white' : 'bg-violet-600 hover:bg-violet-700 text-white'}`}
                        >
                            {t('templateLibrary.apply')}
                        </button>
                    </div>
                ))}
            </div>
        </div>
    );
};
