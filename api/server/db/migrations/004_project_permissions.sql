-- ---------------------------------------------------------------------------
-- 004 项目权限隔离
--
-- users.leader_id    成员归属的上级：组员 → 所属组长；组长 → 所属主管（可选）
-- projects.leader_id 项目归属的组长：组长自建时 = 自己；主管/管理员可指派
--
-- 可见性规则（由应用层实现）：
--   管理员 / 项目主管 → 全部项目
--   组长             → 仅 leader_id = 自己
--   组员             → 仅 leader_id = 自己所属组长
-- ---------------------------------------------------------------------------

ALTER TABLE users ADD COLUMN IF NOT EXISTS leader_id TEXT NOT NULL DEFAULT '';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS leader_id TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_users_leader ON users (leader_id);
CREATE INDEX IF NOT EXISTS idx_projects_leader ON projects (leader_id);
