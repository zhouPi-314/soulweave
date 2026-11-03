-- SoulWeave S1 数据库 Schema
-- 目标：PostgreSQL 18.6
-- 状态：已在独立库 soulweave（PostgreSQL 18.6 / UTF8）执行并通过 10 步验证（2026-10-27）
-- 注意：本文件仅含 CREATE ... IF NOT EXISTS 的幂等建表，【不是迁移系统】：
--       无结构漂移检测、无 schema 版本表、无回滚脚本、无数据迁移。
--
-- 设计依据：
--   V1.7 D55（动态多角色）、D58（角色保护分层）、D60（自主对话）
--   ADR-4（PostgreSQL + 应用层向量）

BEGIN;

-- ─────────────────────────────────────────────────────
-- 1. 角色注册表
-- ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS characters (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- local_dsh 当前唯一；cloud_api 可多个
  kind              TEXT NOT NULL CHECK (kind IN ('local_dsh', 'cloud_api')),

  -- D58：固定保护 ≠ 默认保护
  protection        TEXT NOT NULL CHECK (protection IN (
                      'fixed_protected',      -- 冰糖
                      'default_protected',    -- 小橘子
                      'normal'                -- 其他云端角色
                    )),

  name              TEXT NOT NULL,
  display_name      TEXT,

  -- 资源引用（不存实际数据，只存指针）
  persona_ref       UUID,
  voice_ref         UUID,
  avatar_ref        TEXT,

  state             TEXT NOT NULL DEFAULT 'active'
                    CHECK (state IN ('active','sleeping','trashed','deleting','deleted')),

  -- 隔离与配额
  memory_scope      TEXT NOT NULL DEFAULT 'private' CHECK (memory_scope IN ('private','shared')),
  budget_daily_usd  NUMERIC(10,4),

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at        TIMESTAMPTZ
);

-- D58：冰糖唯一性（数据库级强制，不只靠 UI）
CREATE UNIQUE INDEX IF NOT EXISTS one_local_dsh
  ON characters (kind)
  WHERE kind = 'local_dsh' AND state <> 'deleted';

-- D58：固定保护角色不可删除（软约束，最终由服务层+触发器强制）
CREATE INDEX IF NOT EXISTS idx_characters_state ON characters (state);

COMMENT ON TABLE characters IS '角色注册表：V1.7 D55/D58';
COMMENT ON COLUMN characters.protection IS 'fixed_protected=冰糖不可删；default_protected=小橘子首期无永久删除入口';

-- ─────────────────────────────────────────────────────
-- 2. 人格卡版本
-- ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS persona_versions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  character_id  UUID NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  version       INTEGER NOT NULL,
  content       JSONB NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (character_id, version)
);

-- ─────────────────────────────────────────────────────
-- 3. 会话与消息
-- ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS conversations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  character_id    UUID NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  scene           TEXT NOT NULL CHECK (scene IN ('qq_group','qq_private','desktop','web','character_dm')),
  external_id     TEXT,              -- QQ 群号 / 私聊 QQ 号
  title           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_conversations_character ON conversations (character_id, scene);

CREATE TABLE IF NOT EXISTS messages (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id   UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  character_id      UUID REFERENCES characters(id) ON DELETE SET NULL,

  role              TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
  content           TEXT NOT NULL,

  -- D.1：每条消息都记录归属
  task_id           UUID,
  origin_type       TEXT CHECK (origin_type IN ('user_direct','ai_autonomous','user_requested_discussion')),

  -- 幂等
  external_msg_id   TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages (conversation_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_messages_external
  ON messages (conversation_id, external_msg_id)
  WHERE external_msg_id IS NOT NULL;

-- ─────────────────────────────────────────────────────
-- 4. 任务（D.1 状态机持久化）
-- ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tasks (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  origin                 TEXT NOT NULL CHECK (origin IN (
                           'user_direct','ai_autonomous','user_requested_discussion')),
  state                  TEXT NOT NULL DEFAULT 'created'
                         CHECK (state IN ('created','active','completed','cancelled','expired')),

  -- D.1-2：授权回复集合
  authorized_responders  UUID[] NOT NULL DEFAULT '{}',
  authorized_steps       JSONB NOT NULL DEFAULT '{}'::jsonb,
  used_steps             JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- 讨论额度（所有角色合计）
  global_quota           INTEGER NOT NULL DEFAULT 6
                         CHECK (global_quota BETWEEN 1 AND 30),
  sent_count             INTEGER NOT NULL DEFAULT 0,

  -- 可信触发
  trigger_event_id       TEXT NOT NULL,
  trigger_entry          TEXT NOT NULL CHECK (trigger_entry IN ('qq','desktop','web')),
  trigger_source_msg_id  TEXT NOT NULL,

  -- 复合指令（D60.1-A）
  parent_task_id         UUID REFERENCES tasks(id) ON DELETE SET NULL,

  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at             TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_tasks_state ON tasks (state);
CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks (parent_task_id);

COMMENT ON COLUMN tasks.global_quota IS 'V1.7 D.1-5：讨论 1-30，所有角色合计';

-- ─────────────────────────────────────────────────────
-- 5. 记忆
-- ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS memories (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_character   UUID NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  scope             TEXT NOT NULL DEFAULT 'private' CHECK (scope IN ('private','shared')),
  sensitivity       SMALLINT NOT NULL DEFAULT 0 CHECK (sensitivity BETWEEN 0 AND 3),

  content           TEXT NOT NULL,
  -- 阶段 1：应用层向量。阶段 2 可改 vector(1024)
  embedding         REAL[],

  source_msg_id     UUID REFERENCES messages(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_accessed_at  TIMESTAMPTZ
);

-- 检索必须先按 owner 过滤（V1.7 强制）
CREATE INDEX IF NOT EXISTS idx_memories_owner ON memories (owner_character, scope, sensitivity);

-- ─────────────────────────────────────────────────────
-- 6. 权限与审计
-- ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS approvals (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  character_id    UUID REFERENCES characters(id) ON DELETE CASCADE,
  action          TEXT NOT NULL,
  level           TEXT NOT NULL CHECK (level IN ('L0','L1','L2','L3','L4','L5')),
  payload         JSONB NOT NULL DEFAULT '{}'::jsonb,
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','approved','denied','expired','consumed')),
  expires_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals (status, expires_at);

CREATE TABLE IF NOT EXISTS audit_events (
  id          BIGSERIAL PRIMARY KEY,
  at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor       TEXT NOT NULL,
  action      TEXT NOT NULL,
  target      TEXT,
  result      TEXT NOT NULL CHECK (result IN ('ok','denied','error')),
  detail      JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_events (at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_events (actor, at DESC);

-- 审计只追加：禁止 UPDATE/DELETE
CREATE OR REPLACE RULE audit_no_update AS
  ON UPDATE TO audit_events DO INSTEAD NOTHING;
CREATE OR REPLACE RULE audit_no_delete AS
  ON DELETE TO audit_events DO INSTEAD NOTHING;

-- ─────────────────────────────────────────────────────
-- 7. 用量记录
-- ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS usage_records (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  character_id    UUID REFERENCES characters(id) ON DELETE SET NULL,
  provider        TEXT NOT NULL,
  model           TEXT,
  input_tokens    INTEGER,
  output_tokens   INTEGER,
  cost_usd        NUMERIC(10,6),
  at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_usage_at ON usage_records (at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_character ON usage_records (character_id, at DESC);

COMMIT;


-- ─────────────────────────────────────────────────────
-- 迁移合并：量化向量列（历史迁移文件里散落，统一在这里补，幂等）
-- ─────────────────────────────────────────────────────
ALTER TABLE memories ADD COLUMN IF NOT EXISTS embedding_q    BYTEA;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS embedding_f32  BYTEA;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS pinned         BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS consent        SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS summary        TEXT;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS importance     SMALLINT NOT NULL DEFAULT 1;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS content_hash   TEXT;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS version        INTEGER NOT NULL DEFAULT 1;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS decay_at       TIMESTAMPTZ;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS deleted_at     TIMESTAMPTZ;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS expires_at     TIMESTAMPTZ;
-- 去重写入依赖这个唯一索引（ON CONFLICT (owner_character, content_hash)）
CREATE UNIQUE INDEX IF NOT EXISTS uniq_memories_dedupe
  ON memories (owner_character, content_hash)
  WHERE content_hash IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_memories_f32_null ON memories (owner_character) WHERE embedding_f32 IS NULL;
