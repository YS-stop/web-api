import React from 'react';
import { useTranslation } from 'react-i18next';
import { X, Languages, Moon, Sun, LogOut, Users } from 'lucide-react';

interface SettingsPanelProps {
  isOpen: boolean;
  onClose: () => void;
  canvasTheme: 'dark' | 'light';
  onToggleTheme: () => void;
  user?: { name?: string; role?: string; email?: string } | null;
  onLogout?: () => void;
  onOpenUserManagement?: () => void;
}

export const SettingsPanel: React.FC<SettingsPanelProps> = ({
  isOpen,
  onClose,
  canvasTheme,
  onToggleTheme,
  user = null,
  onLogout,
  onOpenUserManagement,
}) => {
  const { t, i18n } = useTranslation();

  if (!isOpen) return null;

  const changeLanguage = (lang: string) => {
    i18n.changeLanguage(lang);
    localStorage.setItem('twitcanva-lang', lang);
  };

  const isDark = canvasTheme === 'dark';

  const ROLE_LABELS: Record<string, string> = {
    admin: '管理员',
    project_manager: '项目主管',
    team_leader: '组长',
    user: '组员',
  };

  return (
    <div className="fixed inset-0 bg-slate-950/60 backdrop-blur-md flex items-center justify-center z-[120] p-4">
      <div
        className={
          'w-[420px] max-w-[90vw] rounded-3xl p-6 shadow-2xl border ' +
          (isDark ? 'bg-[#191724]/95 border-violet-200/15' : 'bg-white/95 border-slate-200')
        }
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <h3 className={'text-lg font-semibold ' + (isDark ? 'text-white' : 'text-neutral-900')}>
            {t('settings.title')}
          </h3>
          <button
            onClick={onClose}
            className={
              'w-9 h-9 rounded-xl flex items-center justify-center transition-colors ' +
              (isDark ? 'text-neutral-400 hover:bg-white/10 hover:text-white' : 'text-neutral-500 hover:bg-slate-100 hover:text-slate-900')
            }
            title={t('settings.close')}
          >
            <X size={18} />
          </button>
        </div>

        {/* Language */}
        <div className="mb-6">
          <div className="flex items-center gap-2 mb-2">
            <Languages size={16} className={isDark ? 'text-neutral-400' : 'text-neutral-500'} />
            <span className={'text-sm font-medium ' + (isDark ? 'text-neutral-200' : 'text-neutral-800')}>
              {t('settings.language')}
            </span>
          </div>
          <p className={'text-xs mb-2 ' + (isDark ? 'text-neutral-500' : 'text-neutral-400')}>
            {t('settings.languageDesc')}
          </p>
          <div className="flex gap-2">
            {[
              { value: 'zh', label: t('settings.chinese') },
              { value: 'en', label: t('settings.english') },
            ].map((opt) => (
              <button
                key={opt.value}
                onClick={() => changeLanguage(opt.value)}
                className={
                  'flex-1 px-3 py-2 rounded-lg text-sm font-medium border transition-colors ' +
                  (i18n.language === opt.value
                    ? 'bg-violet-600 border-violet-400 text-white shadow-lg shadow-violet-500/20'
                    : (isDark ? 'bg-white/[.05] border-white/10 text-neutral-300 hover:bg-white/[.1]' : 'bg-slate-100 border-slate-200 text-slate-700 hover:bg-slate-200'))
                }
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {/* Account */}
        {user && (
          <div className={'mb-6 p-3 rounded-xl border flex items-center gap-3 ' + (isDark ? 'bg-white/[.03] border-white/10' : 'bg-slate-50 border-slate-200')}>
            <div className="flex-1 min-w-0">
              <div className={'text-xs ' + (isDark ? 'text-neutral-400' : 'text-neutral-500')}>
                {ROLE_LABELS[user.role || ''] || user.role}
              </div>
              <div className={'text-sm font-medium truncate ' + (isDark ? 'text-white' : 'text-neutral-900')}>{user.name || '未命名'}</div>
            </div>
          </div>
        )}

        {/* Appearance */}
        <div className="mb-6">
          <div className="flex items-center gap-2 mb-2">
            {isDark ? <Moon size={16} className="text-neutral-400" /> : <Sun size={16} className="text-neutral-500" />}
            <span className={'text-sm font-medium ' + (isDark ? 'text-neutral-200' : 'text-neutral-800')}>
              {t('settings.appearance')}
            </span>
          </div>
          <button
            onClick={onToggleTheme}
            className={
              'w-full px-3 py-2 rounded-lg text-sm font-medium border transition-colors flex items-center justify-center gap-2 ' +
              (isDark ? 'bg-white/[.05] border-white/10 text-neutral-300 hover:bg-white/[.1]' : 'bg-slate-100 border-slate-200 text-slate-700 hover:bg-slate-200')
            }
          >
            {isDark ? <Sun size={16} /> : <Moon size={16} />}
            {isDark ? t('settings.lightMode') : t('settings.darkMode')}
          </button>
        </div>

        {/* User Management（管理员 / 项目主管 / 组长可见） */}
        {onOpenUserManagement && ['admin', 'project_manager', 'team_leader'].includes(user?.role || '') && (
          <div className="mb-6">
            <div className="flex items-center gap-2 mb-2">
              <Users size={16} className={isDark ? 'text-neutral-400' : 'text-neutral-500'} />
              <span className={'text-sm font-medium ' + (isDark ? 'text-neutral-200' : 'text-neutral-800')}>
                用户管理
              </span>
            </div>
            <button
              onClick={onOpenUserManagement}
              className={
                'w-full px-3 py-2 rounded-lg text-sm font-medium border transition-colors flex items-center justify-center gap-2 ' +
                (isDark ? 'bg-white/[.05] border-white/10 text-neutral-300 hover:bg-white/[.1]' : 'bg-slate-100 border-slate-200 text-slate-700 hover:bg-slate-200')
              }
            >
              <Users size={16} />
              管理用户与权限
            </button>
          </div>
        )}

        {/* Footer */}
        <div className="flex justify-end gap-2">
          {onLogout && (
            <button
              onClick={onLogout}
              className={'px-4 py-2 rounded-lg text-sm transition-colors flex items-center gap-1.5 ' + (isDark ? 'bg-red-500/15 hover:bg-red-500/25 text-red-300' : 'bg-red-50 hover:bg-red-100 text-red-600')}
            >
              <LogOut size={14} />
              登出
            </button>
          )}
          <button
            onClick={onClose}
            className={
              'px-4 py-2 rounded-lg text-sm transition-colors ' +
              (isDark ? 'bg-violet-600 hover:bg-violet-500 text-white' : 'bg-slate-900 hover:bg-slate-700 text-white')
            }
          >
            {t('settings.close')}
          </button>
        </div>
      </div>
    </div>
  );
};
