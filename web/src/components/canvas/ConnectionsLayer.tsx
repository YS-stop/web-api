/**
 * ConnectionsLayer.tsx
 * 
 * Renders the SVG connections between nodes on the canvas.
 * Includes permanent connections and temporary drag connections.
 */

import React, { useEffect, useRef, useState } from 'react';
import { NodeData, NodeStatus, NodeType, Viewport } from '../../types';
import { calculateConnectionPath } from '../../utils/connectionHelpers';

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Get the width of a node based on its type and content
 * @param node - The node to calculate width for
 * @param parentNode - Optional parent node (used for Editor nodes to determine width when they have input content)
 */
const getNodeWidth = (node: NodeData, parentNode?: NodeData): number => {
    // Image Editor with input from parent: width depends on aspect ratio
    if (node.type === NodeType.IMAGE_EDITOR) {
        const hasInput = parentNode && parentNode.status === NodeStatus.SUCCESS && parentNode.resultUrl;
        if (hasInput && parentNode.resultAspectRatio) {
            const parts = parentNode.resultAspectRatio.split('/');
            if (parts.length === 2) {
                const aspectRatio = parseFloat(parts[0]) / parseFloat(parts[1]);
                // For portrait images: height=500px, width=500*aspectRatio
                // For landscape images: width is capped at 500px
                if (aspectRatio < 1) {
                    return 500 * aspectRatio;
                } else {
                    return 500;
                }
            }
        }
        // Empty: width 340px
        return 340;
    }

    // Video Editor with input: uses 16:9 aspect ratio with maxWidth 500px
    if (node.type === NodeType.VIDEO_EDITOR) {
        const hasInput = parentNode && parentNode.status === NodeStatus.SUCCESS && parentNode.resultUrl;
        if (hasInput) {
            // Video uses 16:9, and width is capped at 500px
            // height = width / (16/9), maxHeight = 500px
            // So width = min(500, height * 16/9) where height is capped at 500
            // Result: width = min(500, 500 * 16/9) = min(500, 888) = 500
            return 500;
        }
        // Empty: width 340px
        return 340;
    }

    // Video Merge with result: 16:9 preview capped at 500px, same as Video Editor
    if (node.type === NodeType.VIDEO_MERGE) {
        return node.resultUrl ? 500 : 340;
    }

    // Video nodes are wider
    if (node.type === NodeType.VIDEO) return 385;
    // Camera Angle nodes have fixed width
    if (node.type === NodeType.CAMERA_ANGLE) return 340;
    // Image and other nodes
    return 365;
};

/**
 * Estimate the height of a node based on its type and aspect ratio.
 * The node card height is determined by the content's aspect ratio or min-height for empty states.
 * Note: The title label is positioned ABOVE the card (-top-8), not inside it.
 * @param node - The node to calculate height for
 * @param parentNode - Optional parent node (used for Editor nodes to determine if they have input content)
 */
const getNodeHeight = (node: NodeData, parentNode?: NodeData): number => {
    const baseWidth = getNodeWidth(node, parentNode);
    const hasContent = node.status === NodeStatus.SUCCESS && node.resultUrl;

    // Handle Image Editor nodes
    if (node.type === NodeType.IMAGE_EDITOR) {
        // Check if has input from parent
        const hasInput = parentNode && parentNode.status === NodeStatus.SUCCESS && parentNode.resultUrl;
        if (hasInput && parentNode.resultAspectRatio) {
            // Use parent's aspect ratio to calculate actual dimensions
            // Image Editor with content: width=auto maxWidth=500px, image has maxHeight=500px
            const parts = parentNode.resultAspectRatio.split('/');
            if (parts.length === 2) {
                const aspectRatio = parseFloat(parts[0]) / parseFloat(parts[1]);
                // For portrait images (aspectRatio < 1): height is capped at 500px
                // For landscape images (aspectRatio >= 1): width is capped at 500px
                if (aspectRatio < 1) {
                    // Portrait: height = 500px, width = 500 * aspectRatio
                    return 500;
                } else {
                    // Landscape: width = 500px, height = 500 / aspectRatio
                    return 500 / aspectRatio;
                }
            }
        }
        // Empty: minHeight 380px
        return 380;
    }

    // Handle Video Editor nodes
    if (node.type === NodeType.VIDEO_EDITOR) {
        // Check if has input from parent
        const hasInput = parentNode && parentNode.status === NodeStatus.SUCCESS && parentNode.resultUrl;
        if (hasInput) {
            // Video editor shows 16:9 when has content (line 301 in CanvasNode.tsx)
            return Math.min(baseWidth / (16 / 9), 500);
        }
        // Empty: minHeight 380px
        return 380;
    }

    // Handle Camera Angle nodes
    if (node.type === NodeType.CAMERA_ANGLE) {
        const hasContent = node.status === NodeStatus.SUCCESS && node.resultUrl;
        if (hasContent && node.resultAspectRatio) {
            // Use actual result dimensions when content exists
            const parts = node.resultAspectRatio.split('/');
            if (parts.length === 2) {
                const aspectRatio = parseFloat(parts[0]) / parseFloat(parts[1]);
                return 340 / aspectRatio; // width is 340px
            }
        }
        // Loading/empty state: minHeight 340px (see CanvasNode.tsx Camera Angle section)
        return 340;
    }

    // Parse aspect ratio to calculate content height for Image/Video nodes
    let aspectRatio: number;

    if (hasContent && node.resultAspectRatio) {
        // Use actual result dimensions when content exists
        const parts = node.resultAspectRatio.split('/');
        if (parts.length === 2) {
            aspectRatio = parseFloat(parts[0]) / parseFloat(parts[1]);
        } else {
            aspectRatio = 16 / 9;
        }
    } else if (hasContent && node.aspectRatio && node.aspectRatio !== 'Auto') {
        // Use selected aspect ratio for content
        const parts = node.aspectRatio.split(':');
        if (parts.length === 2) {
            aspectRatio = parseFloat(parts[0]) / parseFloat(parts[1]);
        } else {
            aspectRatio = 16 / 9;
        }
    } else {
        // Empty/placeholder state: Both Image and Video use 4/3 (see NodeContent.tsx line 307)
        aspectRatio = 4 / 3;
    }

    // Calculate content height from aspect ratio
    return baseWidth / aspectRatio;
};

interface Connection {
    parentId: string;
    childId: string;
}

interface ConnectionsLayerProps {
    nodes: NodeData[];
    viewport: Viewport;
    // Connection dragging state
    isDraggingConnection: boolean;
    connectionStart: { nodeId: string; handle: 'left' | 'right' } | null;
    tempConnectionEnd: { x: number; y: number } | null;
    // Selection
    selectedConnection: Connection | null;
    onEdgeClick: (e: React.MouseEvent, parentId: string, childId: string) => void;
    canvasTheme?: 'dark' | 'light';
}

export const ConnectionsLayer: React.FC<ConnectionsLayerProps> = ({
    nodes,
    viewport,
    isDraggingConnection,
    connectionStart,
    tempConnectionEnd,
    selectedConnection,
    onEdgeClick,
    canvasTheme = 'dark'
}) => {
    // 节点真实尺寸（DOM 测量）。
    // 图片/视频节点宽度会随内容自适应（340 → 最大 500），仅用固定估算会让连线端点
    // 落在节点内部或悬空，出现"线没对齐"的问题。
    const nodesRef = useRef(nodes);
    nodesRef.current = nodes;
    const sizesRef = useRef<Map<string, { width: number; height: number }>>(new Map());
    const [, setSizeVersion] = useState(0);

    const nodeIdsKey = nodes.map((n) => n.id).join('|');

    useEffect(() => {
        let disposed = false;

        const measure = () => {
            let changed = false;
            const alive = new Set(nodesRef.current.map((n) => n.id));

            // 清理已删除节点
            for (const id of Array.from(sizesRef.current.keys())) {
                if (!alive.has(id)) {
                    sizesRef.current.delete(id);
                    changed = true;
                }
            }

            for (const node of nodesRef.current) {
                const el = document.querySelector(`[data-node-id="${CSS.escape(node.id)}"]`) as HTMLElement | null;
                if (!el) continue;
                const width = el.offsetWidth;
                const height = el.offsetHeight;
                if (!width || !height) continue;
                const prev = sizesRef.current.get(node.id);
                if (!prev || prev.width !== width || prev.height !== height) {
                    sizesRef.current.set(node.id, { width, height });
                    changed = true;
                }
            }

            if (changed && !disposed) setSizeVersion((v) => v + 1);
        };

        measure();

        const observed = nodesRef.current
            .map((n) => document.querySelector(`[data-node-id="${CSS.escape(n.id)}"]`) as HTMLElement | null)
            .filter((el): el is HTMLElement => !!el);

        const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
        observed.forEach((el) => observer?.observe(el));
        window.addEventListener('resize', measure);
        // 图片/视频加载完成后节点尺寸会变，补一次延迟测量
        const timer = window.setTimeout(measure, 300);

        return () => {
            disposed = true;
            observer?.disconnect();
            window.removeEventListener('resize', measure);
            window.clearTimeout(timer);
        };
    }, [nodeIdsKey]);

    const widthOf = (node: NodeData, parent?: NodeData) =>
        sizesRef.current.get(node.id)?.width ?? getNodeWidth(node, parent);
    const heightOf = (node: NodeData, parent?: NodeData) =>
        sizesRef.current.get(node.id)?.height ?? getNodeHeight(node, parent);

    // Render permanent connections between nodes
    const connections: React.ReactNode[] = [];

    nodes.forEach(node => {
        if (!node.parentIds || node.parentIds.length === 0) return;

        node.parentIds.forEach(parentId => {
            const parent = nodes.find(n => n.id === parentId);
            if (!parent) return;

            const startX = parent.x + widthOf(parent);
            const startY = parent.y + heightOf(parent) / 2;
            const endX = node.x;
            const endY = node.y + heightOf(node, parent) / 2;

            const path = calculateConnectionPath(startX, startY, endX, endY, 'right');
            const isSelected = selectedConnection?.parentId === parentId && selectedConnection?.childId === node.id;

            connections.push(
                <g
                    key={`${parent.id}-${node.id}`}
                    onClick={(e) => onEdgeClick(e, parent.id, node.id)}
                    className="cursor-pointer group pointer-events-auto"
                >
                    <path d={path} stroke="transparent" strokeWidth="20" fill="none" />
                    <path
                        d={path}
                        stroke={isSelected
                            ? (canvasTheme === 'dark' ? '#fff' : '#2563eb')
                            : (canvasTheme === 'dark' ? '#444' : '#d1d5db')}
                        strokeWidth="2"
                        fill="none"
                        className={`transition-colors ${!isSelected ? (canvasTheme === 'dark' ? 'group-hover:stroke-neutral-300' : 'group-hover:stroke-neutral-500') : ''}`}
                    />
                </g>
            );
        });
    });

    // Render temporary drag connection
    let tempLine = null;
    if (isDraggingConnection && connectionStart && tempConnectionEnd) {
        const startNode = nodes.find(n => n.id === connectionStart.nodeId);
        if (startNode) {
            const startX = connectionStart.handle === 'right' ? startNode.x + widthOf(startNode) : startNode.x;
            const startY = startNode.y + heightOf(startNode) / 2;
            const endX = (tempConnectionEnd.x - viewport.x) / viewport.zoom;
            const endY = (tempConnectionEnd.y - viewport.y) / viewport.zoom;

            const path = calculateConnectionPath(
                startX,
                startY,
                endX,
                endY,
                connectionStart.handle
            );

            tempLine = (
                <path
                    d={path}
                    stroke={canvasTheme === 'dark' ? '#fff' : '#2563eb'}
                    strokeWidth="2"
                    strokeDasharray="5,5"
                    fill="none"
                    className="pointer-events-none opacity-50"
                />
            );
        }
    }

    return (
        <>
            {connections}
            {tempLine}
        </>
    );
};
