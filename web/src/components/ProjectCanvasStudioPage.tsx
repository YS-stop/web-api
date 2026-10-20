/**
 * ProjectCanvasStudioPage.tsx
 *
 * 项目制作画布（/canvas-studio/:projectId）。
 *
 * 说明：
 *   这里原先是一套独立的「阶段流程图」画布（固定 1260×520 的业务节点卡片、
 *   右侧节点审核面板、顶部三阶段面包屑、审核/配音/资产弹窗）。
 *   现已按需求废弃，改为直接复用旧画布（/canvas/:projectId）的完整能力：
 *     - 无限画布 + 节点拖拽/缩放/平移/连线/框选/右键菜单
 *     - 文本 / 图片 / 视频 / 合并成片 / 图片编辑 / 视频编辑等节点
 *     - 分镜导入、生成任务台账、剧本与资产左侧面板
 *   唯一区别是配色：本路由使用白色主题，旧路由保持深色。
 */
import React from 'react';
import { ProjectCanvasPage } from './ProjectCanvasPage';

interface ProjectCanvasStudioPageProps {
    projectId: string;
    /** 从项目详情按集进入时指定的集号；不传则用第 1 集 */
    initialEpisode?: number;
    onBack: () => void;
}

export const ProjectCanvasStudioPage: React.FC<ProjectCanvasStudioPageProps> = ({
    projectId,
    initialEpisode,
    onBack,
}) => (
    <ProjectCanvasPage
        projectId={projectId}
        initialEpisode={initialEpisode}
        onBack={onBack}
        theme="light"
    />
);

export default ProjectCanvasStudioPage;
