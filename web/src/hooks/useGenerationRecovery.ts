/**
 * useGenerationRecovery.ts
 * 
 * Custom hook that checks for nodes in 'loading' status and polls
 * the backend to see if their generation has finished.
 */

import { useEffect, useCallback, useRef } from 'react';
import { NodeData, NodeStatus } from '../types';
import { extractVideoLastFrame } from '../utils/videoHelpers';

interface UseGenerationRecoveryOptions {
    nodes: NodeData[];
    updateNode: (id: string, updates: Partial<NodeData>) => void;
}

export const useGenerationRecovery = ({
    nodes,
    updateNode
}: UseGenerationRecoveryOptions) => {
    // Use a ref to access current nodes without causing re-renders
    const nodesRef = useRef<NodeData[]>(nodes);
    nodesRef.current = nodes;

    // 每个节点的连续失败次数：后端重启时短暂不可达属正常（任务会被 restore 继续跑），
    // 连续多次仍失败才判定连接中断，避免节点永远停在 loading。
    const failureCountsRef = useRef<Record<string, number>>({});
    const MAX_CONSECUTIVE_FAILURES = 3; // 10s × 3 ≈ 30s

    const checkStatus = useCallback(async (nodeId: string) => {
        try {
            const response = await fetch(`/api/generation-status/${nodeId}`);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);

            const data = await response.json();
            failureCountsRef.current[nodeId] = 0;

            // 服务端任务已明确失败：停止轮询并展示原因
            if (data.status === 'failed') {
                updateNode(nodeId, {
                    status: NodeStatus.ERROR,
                    errorMessage: data.error || '生成失败，请重新生成',
                    generationStartTime: undefined
                });
                return;
            }

            if (data.status === 'success' && data.resultUrl) {
                // Access nodes via ref to avoid stale closure
                const node = nodesRef.current.find(n => n.id === nodeId);

                // Race condition check: If node has a generationStartTime, compare with result's createdAt
                // This prevents applying stale results from previous generations
                if (node?.generationStartTime && data.createdAt) {
                    const resultCreatedAt = new Date(data.createdAt).getTime();
                    if (resultCreatedAt < node.generationStartTime) {
                        // Stale result, skip silently (don't spam console)
                        return;
                    }
                }

                console.log(`[Recovery] Found new result for node ${nodeId}`);

                // Update node with success status and result URL
                const updates: Partial<NodeData> = {
                    status: NodeStatus.SUCCESS,
                    resultUrl: data.resultUrl,
                    errorMessage: undefined,
                    generationStartTime: undefined // Clear the timestamp after successful recovery
                };

                // If it's a video, extract the last frame for chaining
                if (data.type === 'video') {
                    try {
                        const lastFrame = await extractVideoLastFrame(data.resultUrl);
                        updates.lastFrame = lastFrame;
                    } catch (err) {
                        console.error(`[Recovery] Failed to extract last frame for node ${nodeId}:`, err);
                    }
                }

                updateNode(nodeId, updates);
            }
        } catch (error) {
            const failures = (failureCountsRef.current[nodeId] || 0) + 1;
            failureCountsRef.current[nodeId] = failures;

            if (failures >= MAX_CONSECUTIVE_FAILURES) {
                updateNode(nodeId, {
                    status: NodeStatus.ERROR,
                    errorMessage: '与生成服务的连接已中断（后端可能已重启），请确认服务恢复后重新生成',
                    generationStartTime: undefined
                });
                delete failureCountsRef.current[nodeId];
                return;
            }

            console.error(`[Recovery] Error checking status for node ${nodeId}:`, error);
        }
    }, [updateNode]); // Only updateNode as dependency, nodes accessed via ref

    // Track loading node IDs for stable dependency
    const loadingNodeIds = nodes
        .filter(n => n.status === NodeStatus.LOADING)
        .map(n => n.id)
        .join(',');

    useEffect(() => {
        if (!loadingNodeIds) return;

        const nodeIds = loadingNodeIds.split(',');

        // Check each loading node every 10 seconds
        const checkAll = () => {
            nodeIds.forEach(nodeId => checkStatus(nodeId));
        };

        checkAll(); // Initial check

        const interval = setInterval(checkAll, 10000); // Check every 10s

        return () => clearInterval(interval);
    }, [loadingNodeIds, checkStatus]); // Stable string dependency instead of nodes array
};

