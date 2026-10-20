/**
 * concurrency.ts
 *
 * 受控并发工具：批量任务时同时最多跑 limit 个，其余排队。
 *
 * 用于「资产一键生成」「分镜批量生成」等批量场景，
 * 避免纯串行（一个等一个、极慢）与全并发（瞬间打爆模型 QPS）两种极端。
 *
 * 并发上限与后端 modelChannel.js 的 CHANNEL_MAX_CONCURRENT（默认 3）对齐，
 * 前端先削峰，后端队列再兜底。
 */

/** 批量生成默认并发数（与后端 CHANNEL_MAX_CONCURRENT 默认值保持一致） */
export const BATCH_CONCURRENCY = 3;

/**
 * 视频批量：提交阶段并发。
 * 提交只是 createTask（1~3 秒），可并行铺开，让厂商侧尽快同时开始生成。
 * 上限仍需与后端 CHANNEL_MAX_CONCURRENT 对齐，避免瞬时打爆 QPS。
 */
export const VIDEO_SUBMIT_CONCURRENCY = 4;

/** 视频批量：轮询阶段并发。单次查询是轻量 GET，可高于提交并发。 */
export const VIDEO_POLL_CONCURRENCY = 16;

/**
 * 受控并发执行。
 *
 * - 同一时刻最多 limit 个 worker 在跑；
 * - 单个任务失败不会中断整批（结果以 PromiseSettledResult 返回）；
 * - 返回顺序与 items 一致。
 */
export const runWithConcurrency = async <T, R>(
    items: T[],
    worker: (item: T, index: number) => Promise<R>,
    limit: number = BATCH_CONCURRENCY
): Promise<PromiseSettledResult<R>[]> => {
    const results: PromiseSettledResult<R>[] = new Array(items.length);
    if (items.length === 0) return results;

    let cursor = 0;
    const runOne = async (): Promise<void> => {
        for (;;) {
            // JS 单线程，取号是同步的，多个 worker 不会拿到同一个下标
            const index = cursor++;
            if (index >= items.length) return;
            try {
                results[index] = { status: 'fulfilled', value: await worker(items[index], index) };
            } catch (reason) {
                results[index] = { status: 'rejected', reason };
            }
        }
    };

    const workers = Math.max(1, Math.min(limit, items.length));
    await Promise.all(Array.from({ length: workers }, () => runOne()));
    return results;
};
