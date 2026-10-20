import React, { useState } from 'react';
import { X, Send, Loader2 } from 'lucide-react';
import {
    Project,
    ProjectEditableFields,
    FIELD_LABELS,
    EDITABLE_FIELDS,
} from '../../services/projectService';

interface ChangeRequestModalProps {
    project: Project;
    onClose: () => void;
    onSubmit: (changes: ProjectEditableFields, reason: string) => Promise<void>;
}

/** 组长发起「申请修改」：填写各字段新值 + 理由，提交给主管审批 */
export const ChangeRequestModal: React.FC<ChangeRequestModalProps> = ({ project, onClose, onSubmit }) => {
    // 每个字段的新值草稿（空字符串表示「不改」）
    const [draft, setDraft] = useState<Record<string, string>>({});
    const [reason, setReason] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState('');

    const numericFields = ['targetDuration', 'totalEpisodes'];

    const setField = (key: string, value: string) => {
        setDraft((prev) => ({ ...prev, [key]: value }));
    };

    // 收集「与原值不同」的字段
    const collectChanges = (): ProjectEditableFields => {
        const changes: ProjectEditableFields = {};
        for (const key of EDITABLE_FIELDS) {
            const raw = (draft[key] ?? '').trim();
            if (raw === '') continue;
            const current = (project as any)[key];
            if (numericFields.includes(key)) {
                const n = Number(raw);
                if (!isNaN(n) && n !== Number(current)) (changes as any)[key] = n;
            } else if (raw !== String(current ?? '')) {
                (changes as any)[key] = raw;
            }
        }
        return changes;
    };

    const handleSubmit = async () => {
        const changes = collectChanges();
        if (Object.keys(changes).length === 0) {
            setError('请至少填写一处与当前值不同的修改内容');
            return;
        }
        if (!reason.trim()) {
            setError('请填写修改理由');
            return;
        }
        setError('');
        setSubmitting(true);
        try {
            await onSubmit(changes, reason.trim());
            onClose();
        } catch (e: any) {
            setError(e.message || '提交失败');
            setSubmitting(false);
        }
    };

    return (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-[130] flex items-center justify-center p-4">
            <div className="bg-white rounded-2xl shadow-2xl w-[720px] max-w-[95vw] max-h-[92vh] overflow-hidden flex flex-col">
                {/* 头部 */}
                <div className="px-6 pt-5 pb-4 border-b border-slate-100 flex items-start justify-between">
                    <div>
                        <h3 className="text-lg font-semibold text-slate-900">申请修改项目</h3>
                        <p className="text-[12px] text-slate-400 mt-0.5">
                            {project.code} · {project.name}　—　填写需修改的字段新值，提交后由主管审批
                        </p>
                    </div>
                    <button
                        onClick={onClose}
                        className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition-colors"
                    >
                        <X size={18} />
                    </button>
                </div>

                {/* 字段列表 */}
                <div className="flex-1 overflow-y-auto px-6 py-4">
                    <div className="text-[12px] text-slate-400 mb-2">在「新值」列填写需要修改的内容，留空表示不改</div>
                    <div className="border border-slate-200 rounded-lg overflow-hidden">
                        <div className="grid grid-cols-[140px_1fr_1fr] gap-2 px-4 py-2 bg-[#fafafa] border-b border-slate-100 text-[12px] font-medium text-slate-500">
                            <span>字段</span>
                            <span>当前值</span>
                            <span>新值</span>
                        </div>
                        {EDITABLE_FIELDS.map((key) => {
                            const current = String((project as any)[key] ?? '');
                            const isNumeric = numericFields.includes(key);
                            return (
                                <div key={key} className="grid grid-cols-[140px_1fr_1fr] gap-2 px-4 py-2 border-b border-slate-50 last:border-b-0 items-center">
                                    <span className="text-[13px] text-slate-600">{FIELD_LABELS[key]}</span>
                                    <span className="text-[13px] text-slate-400 truncate">{current || '—'}</span>
                                    <input
                                        type="text"
                                        inputMode={isNumeric ? 'numeric' : undefined}
                                        value={draft[key] ?? ''}
                                        onChange={(e) => setField(key, isNumeric ? e.target.value.replace(/[^0-9]/g, '') : e.target.value)}
                                        placeholder={isNumeric ? '数字' : '留空不改'}
                                         /* 显式白底 + 强制浅色方案，避免全局 color-scheme: dark 导致输入框出现深色底 */
                                        style={{ colorScheme: 'light' }}
                                        className="flex-1 h-8 px-2.5 rounded-lg border border-slate-200 bg-white text-[13px] text-slate-700 placeholder:text-slate-400 focus:outline-none focus:border-[#1677ff]"
                                    />
                                </div>
                            );
                        })}
                    </div>

                    {/* 理由 */}
                    <div className="mt-4">
                        <label className="text-[13px] font-medium text-slate-700">修改理由 <span className="text-red-500">*</span></label>
                        <textarea
                            value={reason}
                            onChange={(e) => setReason(e.target.value)}
                            placeholder="说明修改原因，供主管审批参考"
                            rows={3}
                            /* 显式白底 + 强制浅色方案，避免全局 color-scheme: dark 导致输入框出现深色底 */
                            className="mt-1.5 w-full px-3 py-2 rounded-lg border border-slate-200 bg-white text-[13px] text-slate-700 focus:outline-none focus:border-[#1677ff] resize-none"
                        />
                    </div>

                    {error && <div className="mt-3 text-[12px] text-red-500">{error}</div>}
                </div>

                {/* 底部 */}
                <div className="px-6 py-4 border-t border-slate-100 flex items-center justify-end gap-3">
                    <button
                        onClick={onClose}
                        className="h-9 px-4 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 text-sm transition-colors"
                    >
                        取消
                    </button>
                    <button
                        onClick={handleSubmit}
                        disabled={submitting}
                        className="h-9 px-4 rounded-lg bg-[#1677ff] hover:bg-[#4080ff] text-white text-sm font-medium flex items-center gap-1.5 transition-colors disabled:opacity-60"
                    >
                        {submitting ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
                        提交申请
                    </button>
                </div>
            </div>
        </div>
    );
};

export default ChangeRequestModal;
