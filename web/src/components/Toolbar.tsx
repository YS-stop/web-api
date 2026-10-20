import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  LayoutGrid,
  Image as ImageIcon,
  History,
  LayoutTemplate,
  Plus,
  X
} from 'lucide-react';

// ============================================================================
// TYPES
// ============================================================================

interface ToolbarProps {
  onAddClick?: (e: React.MouseEvent) => void;
  onWorkflowsClick?: (e: React.MouseEvent) => void;
  onAssetsClick?: (e: React.MouseEvent) => void;
  onHistoryClick?: (e: React.MouseEvent) => void;
  onTemplatesClick?: (e: React.MouseEvent) => void;
  canvasTheme?: 'dark' | 'light';
}

// ============================================================================
// COMPONENT
// ============================================================================

export const Toolbar: React.FC<ToolbarProps> = ({
  onAddClick,
  onWorkflowsClick,
  onAssetsClick,
  onHistoryClick,
  onTemplatesClick,
  canvasTheme = 'dark'
}) => {
  const { t } = useTranslation();
  const [collapsed, setCollapsed] = useState(false);

  const isDark = canvasTheme === 'dark';

  const iconBtn = (isDark
    ? 'text-neutral-400 hover:text-white hover:bg-white/10'
    : 'text-slate-500 hover:text-violet-700 hover:bg-violet-50'
  );

  // 折叠态：圆点按钮（对齐项目画布）
  if (collapsed) {
    return (
      <button
        onClick={() => setCollapsed(false)}
        className="fixed left-5 top-1/2 -translate-y-1/2 w-7 h-7 rounded-full flex items-center justify-center shadow-md shadow-violet-500/20 bg-gradient-to-br from-violet-400 to-violet-600 text-white hover:scale-105 transition-all duration-200 z-50"
        title="展开工具栏"
      >
        <Plus size={14} />
      </button>
    );
  }

  return (
    <div className={`fixed left-5 top-1/2 -translate-y-1/2 flex flex-col items-center gap-2 p-1.5 rounded-2xl shadow-2xl backdrop-blur-xl z-50 transition-colors duration-300 ${isDark ? 'bg-[#161521]/90 border border-violet-200/10' : 'bg-white/90 border border-slate-200'
      }`}>
      <button
        onClick={() => setCollapsed(true)}
        className="w-9 h-9 rounded-xl flex items-center justify-center transition-all duration-200 text-neutral-400 hover:text-white hover:bg-white/10"
        title="收起工具栏"
      >
        <X size={16} />
      </button>

      <button
        className={`w-10 h-10 rounded-xl flex items-center justify-center hover:scale-105 transition-all duration-200 shadow-lg ${isDark ? 'bg-gradient-to-br from-violet-400 to-violet-600 text-white shadow-violet-500/25 hover:from-violet-300 hover:to-violet-500' : 'bg-gradient-to-br from-violet-600 to-indigo-600 text-white hover:from-violet-500 hover:to-indigo-500'
          }`}
        onClick={onAddClick}
        title={t('toolbar.add')}
      >
        <Plus size={20} />
      </button>

      <button
        className={`w-9 h-9 rounded-xl flex items-center justify-center transition-all duration-200 ${iconBtn}`}
        onClick={onWorkflowsClick}
        title={t('toolbar.workflows')}
      >
        <LayoutGrid size={20} />
      </button>
      <button
        className={`w-9 h-9 rounded-xl flex items-center justify-center transition-all duration-200 ${iconBtn}`}
        title={t('toolbar.assets')}
        onClick={onAssetsClick}
      >
        <ImageIcon size={20} />
      </button>
      <button
        className={`w-9 h-9 rounded-xl flex items-center justify-center transition-all duration-200 ${iconBtn}`}
        onClick={onHistoryClick}
        title={t('toolbar.history')}
      >
        <History size={20} />
      </button>
      <button
        className={`w-9 h-9 rounded-xl flex items-center justify-center transition-all duration-200 ${iconBtn}`}
        onClick={onTemplatesClick}
        title={t('toolbar.templates')}
      >
        <LayoutTemplate size={20} />
      </button>
    </div>
  );
};
