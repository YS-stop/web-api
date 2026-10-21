/**
 * db/migrate.js
 *
 * 建表 / 迁移执行器（支持多版本，按顺序执行未应用的部分）。
 *
 * 用法（在 api/ 目录下）：
 *   node server/db/migrate.js           执行所有未应用的迁移（幂等）
 *   node server/db/migrate.js --dry-run 只打印将要执行的 SQL 与校验和
 *   node server/db/migrate.js --force   忽略「已应用」记录，重新执行全部
 *   node server/db/migrate.js --to 002  只执行到指定版本
 *
 * 迁移记录写入 schema_migrations：同一版本内容变更时会给出警告，
 * 提示新增一个迁移文件，而不是悄悄修改已上线的结构。
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API_DIR = path.resolve(HERE, '..', '..');

// 允许从任意目录启动，始终读取 api/.env
dotenv.config({ path: path.join(API_DIR, '.env'), quiet: true });

const { transaction, closePool, describeTarget, healthCheck } = await import('./index.js');

/**
 * 迁移清单：严格按顺序追加，已发布的版本号与文件不再改动。
 */
const MIGRATIONS = [
    { version: '001_p0_init', file: 'schema.sql', desc: 'P0 业务表（用户/项目/分集/工作流/任务/媒体/聊天）' },
    { version: '002_project_state', file: path.join('migrations', '002_project_state.sql'), desc: '制作过程状态（资产确认/分镜/配音/任务台账）' },
    { version: '003_image_tasks', file: path.join('migrations', '003_image_tasks.sql'), desc: '图片生成任务（服务端后台队列）' },
    { version: '004_project_permissions', file: path.join('migrations', '004_project_permissions.sql'), desc: '项目权限隔离（成员归属组长 / 项目归属组长）' },
    { version: '005_project_jobs_actor', file: path.join('migrations', '005_project_jobs_actor.sql'), desc: '生成任务触发人（按 token 记录，只写一次）' },
];

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const force = args.includes('--force');
const toIndex = args.indexOf('--to');
const toVersion = toIndex >= 0 ? args[toIndex + 1] : null;

function sha256(text) {
    return crypto.createHash('sha256').update(text).digest('hex');
}

/** 按 `;` 切分语句仅用于 dry-run 展示（不解析字符串内的分号） */
function previewStatements(sql) {
    return sql
        .split(/;\s*(?:\r?\n|$)/)
        .map((s) => s.trim())
        .filter(Boolean);
}

/** 读取并校验迁移文件，返回带 sql / checksum 的列表 */
function loadMigrations() {
    const list = MIGRATIONS.map((item) => {
        const fullPath = path.join(HERE, item.file);
        if (!fs.existsSync(fullPath)) {
            throw new Error(`找不到迁移文件: ${fullPath}`);
        }
        const sql = fs.readFileSync(fullPath, 'utf-8');
        return {
            ...item,
            fullPath,
            sql,
            checksum: sha256(sql),
            statements: previewStatements(sql),
        };
    });

    if (!toVersion) return list;

    const cut = list.findIndex((m) => m.version.startsWith(toVersion));
    if (cut < 0) throw new Error(`未知版本: ${toVersion}`);
    return list.slice(0, cut + 1);
}

async function main() {
    const migrations = loadMigrations();

    console.log('============================================================');
    console.log(`[migrate] 目标库   : ${describeTarget()}`);
    console.log(`[migrate] 迁移数   : ${migrations.length}${toVersion ? `（--to ${toVersion}）` : ''}`);
    for (const m of migrations) {
        console.log(`[migrate]   ${m.version.padEnd(18)} ${String(m.statements.length).padStart(3)} 条语句  ${m.checksum.slice(0, 12)}…  ${m.desc}`);
    }
    console.log('============================================================');

    if (dryRun) {
        for (const m of migrations) {
            console.log(`\n--- ${m.version} ---`);
            m.statements.forEach((s, i) => {
                const firstLine = s.split('\n').find((line) => line.trim() && !line.trim().startsWith('--')) || '';
                console.log(`${String(i + 1).padStart(2)}. ${firstLine.trim().slice(0, 100)}`);
            });
        }
        console.log('\n[migrate] --dry-run：未连接数据库，未执行任何语句。');
        return;
    }

    const health = await healthCheck();
    if (!health.ok) {
        throw new Error(`数据库连接失败：${health.error}`);
    }
    console.log(`[migrate] 已连接，${String(health.version).split(',')[0]}`);

    // 先确保迁移记录表存在（schema.sql 里也有，这里提前建，便于查历史）
    await transaction(async (client) => {
        await client.query(`
            CREATE TABLE IF NOT EXISTS schema_migrations (
                version    TEXT PRIMARY KEY,
                checksum   TEXT NOT NULL,
                applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )
        `);
    });

    for (const migration of migrations) {
        await transaction(async (client) => {
            const existing = await client.query(
                'SELECT version, checksum, applied_at FROM schema_migrations WHERE version = $1',
                [migration.version],
            );
            const record = existing.rows[0];

            if (record && record.checksum !== migration.checksum) {
                console.warn(
                    `[migrate] 警告：${migration.version} 已应用过，但文件内容已变化。\n` +
                    '           已有环境不会自动变更表结构，请新增迁移版本而不是修改历史版本。',
                );
            }
            if (record && !force) {
                console.log(`[migrate] ${migration.version} 已应用（${record.applied_at.toISOString()}），跳过。`);
                return;
            }

            // 迁移文件内部全是幂等语句，重复执行安全
            await client.query(migration.sql);
            await client.query(
                `INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)
                 ON CONFLICT (version) DO UPDATE SET checksum = EXCLUDED.checksum, applied_at = now()`,
                [migration.version, migration.checksum],
            );
            console.log(`[migrate] ${migration.version} 执行完成（${migration.statements.length} 条语句）。`);
        });
    }

    // 输出建表结果，便于确认
    const tables = await transaction(async (client) => {
        const result = await client.query(`
            SELECT table_name
            FROM information_schema.tables
            WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
            ORDER BY table_name
        `);
        return result.rows.map((r) => r.table_name);
    });
    console.log(`[migrate] 当前表（${tables.length}）: ${tables.join(', ')}`);
}

main()
    .catch((error) => {
        console.error('[migrate] 失败:', error.message);
        process.exitCode = 1;
    })
    .finally(async () => {
        await closePool();
    });
