import React, { useState, useEffect, useCallback } from 'react';
import { ArrowLeft, Check, X, Loader2, Inbox, User } from 'lucide-react';
import {
    ChangeRequest,
    FIELD_LABELS,
    fetchChangeRequests,
    reviewChangeRequest,
} from '../services/projectService';

interface ApprovalsPageProps {
    user: { name?: string; role?: string } | null;
    onBack: () => void;
}

const REQ_STATUS: Record<string, { label: string; badge: string }> = {
    pending: { label: '待审批', badge: 'bg-[#fff3e8] text-[#ff7d00]' },
    approved: { label: '已通过', badge: 'bg-[#e8ffea] text-[#00b42a]' },
    rejected: { label: '已拒绝', badge: 'bg-[#ffece8] text-[#f53f3f]' },
};

const ROLE_LABELS: Record<string, string> = {
    admin: '管理员',
    project_manager: '项目主管',
    team_leader: '组长',
    user: '组员',
};

/** 申请审批页：主管/管理员集中查看并处理「申请修改」 */
export const ApprovalsPage: React.FC<ApprovalsPageProps> = ({ user, onBack }) => {
    const [requests, setRequests] = useState<ChangeRequest[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [processingId, setProcessingId] = useState<string | null>(null);

    const load = useCallback(async () => {
        setLoading(true);
        setError('');
        try {
            setRequests(await fetchChangeRequests());
        } catch (e: any) {
            setError(e.message || '加载申请失败');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { load(); }, [load]);

    const handleReview = async (id: string, approve: boolean) => {
        setProcessingId(id);
        setError('');
        try {
            await reviewChangeRequest(id, approve);
            await load();
        } catch (e: any) {
            setError(e.message || '操作失败');
        } finally {
            setProcessingId(null);
        }
    };

    const pendingCount = requests.filter((r) => r.status === 'pending').length;

    return (
        <div
            className="h-screen w-screen overflow-hidden bg-[#f0f2f5] text-slate-800 font-sans"
            style={{ '--focus-ring': '#1677ff', '--focus-ring-offset': '1px' } as React.CSSProperties}
        >
            <main className="flex h-full flex-col overflow-hidden">
                {/* 顶栏 */}
                <div className="bg-white border-b border-slate-200 px-6 h-14 flex items-center gap-4 shrink-0">
                    <button
                        onClick={onBack}
                        className="flex items-center gap-1.5 text-sm text-slate-500 hover:text-[#1677ff] transition-colors"
                    >
                        <ArrowLeft size={16} />
                        返回项目列表
                    </button>
                    <span className="text-slate-300">/</span>
                    <h1 className="text-[15px] font-semibold text-slate-900">申请审批</h1>
                    <span className="text-xs text-slate-400">{user?.name} · {user?.role ? (ROLE_LABELS[user.role] || user.role) : ''}</span>
                </div>

                <div className="flex-1 overflow-y-auto">
                    <div className="max-w-[900px] mx-auto px-6 py-6">
                        <div className="flex items-center justify-between mb-4">
                            <div>
                                <h2 className="text-[20px] font-semibold text-slate-900">项目修改申请</h2>
                                <p className="text-sm text-slate-500 mt-1">组长提交的修改申请，审批通过后将应用到项目</p>
                            </div>
                            <span className="text-sm text-slate-500">
                                {pendingCount > 0 ? <span className="text-[#ff7d00] font-medium">{pendingCount} 条待审批</span> : '暂无待审批'}
                            </span>
                        </div>

                        {error && <div className="mb-4 text-[13px] text-red-500">{error}</div>}

                        {loading ? (
                            <div className="flex items-center justify-center py-20 text-slate-400">
                                <Loader2 size={20} className="animate-spin mr-2" />
                                加载中...
                            </div>
                        ) : requests.length === 0 ? (
                            <div className="flex flex-col items-center justify-center py-20 text-slate-400">
                                <Inbox size={40} className="mb-3" />
                                <span className="text-sm">暂无申请记录</span>
                            </div>
                        ) : (
                            <div className="flex flex-col gap-3">
                                {requests.map((r) => {
                                    const st = REQ_STATUS[r.status] || REQ_STATUS.pending;
                                    const isPending = r.status === 'pending';
                                    const changeKeys = Object.keys(r.changes || {});
                                    return (
                                        <div key={r.id} className="bg-white rounded-xl border border-slate-200 p-4">
                                            <div className="flex items-start justify-between">
                                                <div>
                                                    <div className="flex items-center gap-2">
                                                        <span className="text-[14px] font-semibold text-slate-900">{r.projectName}</span>
                                                        <span className="text-xs text-slate-400">{r.projectCode}</span>
                                                    </div>
                                                    <div className="flex items-center gap-2 mt-1.5 text-xs text-slate-500">
                                                        <User size={13} />
                                                        <span>{r.requesterName}</span>
                                                        <span className="text-slate-300">·</span>
                                                        <span>{ROLE_LABELS[r.requesterRole] || r.requesterRole}</span>
                                                        <span className="text-slate-300">·</span>
                                                        <span>{new Date(r.createdAt).toLocaleString()}</span>
                                                    </div>
                                                </div>
                                                <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs shrink-0 ${st.badge}`}>{st.label}</span>
                                            </div>

                                            {/* 变更内容 */}
                                            <div className="mt-3 bg-[#fafafa] border border-slate-100 rounded-lg px-3 py-2">
                                                {changeKeys.length === 0 ? (
                                                    <span className="text-xs text-slate-400">无字段变更</span>
                                                ) : (
                                                    <div className="flex flex-wrap gap-x-6 gap-y-1.5">
                                                        {changeKeys.map((key) => (
                                                            <div key={key} className="text-[13px]">
                                                                <span className="text-slate-500">{FIELD_LABELS[key] || key}：</span>
                                                                <span className="text-slate-800 font-medium">{String((r.changes as any)[key])}</span>
                                                            </div>
                                                        ))}
                                                    </div>
                                                )}
                                            </div>

                                            {r.reason && (
                                                <div className="mt-2 text-[13px] text-slate-600">
                                                    <span className="text-slate-400">理由：</span>{r.reason}
                                                </div>
                                            )}

                                            {/* 审批操作 */}
                                            {isPending && (
                                                <div className="mt-3 flex items-center justify-end gap-2.5">
                                                    <button
                                                        onClick={() => handleReview(r.id, false)}
                                                        disabled={processingId === r.id}
                                                        className="h-8 px-3.5 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 text-[13px] flex items-center gap-1 transition-colors disabled:opacity-60"
                                                    >
                                                        <X size={14} />
                                                        拒绝
                                                    </button>
                                                    <button
                                                        onClick={() => handleReview(r.id, true)}
                                                        disabled={processingId === r.id}
                                                        className="h-8 px-3.5 rounded-lg bg-[#1677ff] hover:bg-[#4080ff] text-white text-[13px] flex items-center gap-1 transition-colors disabled:opacity-60"
                                                    >
                                                        {processingId === r.id ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                                                        通过
                                                    </button>
                                                </div>
                                            )}

                                            {!isPending && r.approverName && (
                                                <div className="mt-2 text-[12px] text-slate-400 text-right">
                                                    由 {r.approverName} 处理于 {r.reviewedAt ? new Date(r.reviewedAt).toLocaleString() : ''}
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                </div>
            </main>
        </div>
    );
};

export default ApprovalsPage;
