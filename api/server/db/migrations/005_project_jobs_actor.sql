-- ---------------------------------------------------------------------------
-- 005 生成任务触发人
--
-- 背景：项目按组长归属（见 004），同组多人共享同一批项目。
-- 因此任务台账必须逐条记录「这次生成是谁点的」，
-- 否则失败任务无从追溯，也无法按人筛选。
--
-- 三条约束（由应用层 upsertJob 实现）：
--   1) 只信 token：created_by 由后端从 req.user 写入，不接受前端传入；
--   2) 只写一次：任务首次创建时落值，后续终态更新（succeeded / failed）不覆盖。
--      否则 A 发起、B 回来收尾轮询时，任务会被记到 B 名下；
--   3) 存快照：姓名与角色一并落库。人员改名、换组、停用后，
--      历史任务的归属不会跟着漂移。
--
-- created_by 为空 = 系统任务，或 005 之前写入的历史任务。
-- 前端对空值显示「未记录」，不臆测成人。
-- ---------------------------------------------------------------------------

ALTER TABLE project_jobs ADD COLUMN IF NOT EXISTS created_by TEXT NOT NULL DEFAULT '';
ALTER TABLE project_jobs ADD COLUMN IF NOT EXISTS created_by_name TEXT NOT NULL DEFAULT '';
ALTER TABLE project_jobs ADD COLUMN IF NOT EXISTS created_by_role TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_project_jobs_created_by ON project_jobs (project_id, created_by);
