-- ============================================================
-- SoulWeave S4：记忆体系 schema 增量
-- ============================================================
--
-- 依据：02 §4 数据域（需要 memories / memory_embeddings /
--       memory_shares / memory_conflicts 四个实体）
--       01 §4 记忆要求（来源追踪、重要程度、过期/遗忘、冲突检测、
--       版本/纠错、去重、共享审批、删除传播）
--
-- 设计原则：
--   1. **幂等**：全部 IF NOT EXISTS，可重复执行。
--   2. **不破坏已有数据**：只 ADD COLUMN，不改既有列类型。
--   3. 向量继续用 REAL[]（ADR-4 阶段 1）；memory_embeddings 用于
--      多嵌入模型共存，主向量仍内联在 memories.embedding 以保检索速度。
--   4. 软删除：deleted_at 非空即视为已删，查询必须带 deleted_at IS NULL。
--
-- ============================================================

-- ── 1. memories 补字段 ─────────────────────────────────────
ALTER TABLE memories ADD COLUMN IF NOT EXISTS consent      SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS source       TEXT;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS summary      TEXT;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS importance   REAL NOT NULL DEFAULT 0.5;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS content_hash TEXT;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS version      INTEGER NOT NULL DEFAULT 1;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS expires_at   TIMESTAMPTZ;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS deleted_at   TIMESTAMPTZ;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS decay_at     TIMESTAMPTZ;

-- 约束：重要度 0–1；同意状态 0 未批准 / 1 已批准 / 2 已拒绝
DO $$ BEGIN
  ALTER TABLE memories ADD CONSTRAINT memories_importance_chk
    CHECK (importance >= 0 AND importance <= 1);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE memories ADD CONSTRAINT memories_consent_chk
    CHECK (consent IN (0, 1, 2));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── 2. 去重：同一角色下内容哈希唯一（软删除的不算）────────
CREATE UNIQUE INDEX IF NOT EXISTS uq_memories_hash
  ON memories (owner_character, content_hash)
  WHERE content_hash IS NOT NULL AND deleted_at IS NULL;

-- ── 3. 检索用索引（scope-first 必备）────────────────────────
-- 检索顺序：owner_character → scope → sensitivity → 向量排序
CREATE INDEX IF NOT EXISTS idx_memories_live
  ON memories (owner_character, scope, sensitivity, deleted_at)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_memories_expires
  ON memories (expires_at)
  WHERE expires_at IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_memories_importance
  ON memories (owner_character, importance DESC)
  WHERE deleted_at IS NULL;

-- ── 4. memory_embeddings：多嵌入模型共存 ────────────────────
CREATE TABLE IF NOT EXISTS memory_embeddings (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_id   UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  model       TEXT NOT NULL,
  dim         INTEGER NOT NULL CHECK (dim > 0),
  vector      REAL[] NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (memory_id, model)
);

CREATE INDEX IF NOT EXISTS idx_mem_emb_memory ON memory_embeddings (memory_id);
CREATE INDEX IF NOT EXISTS idx_mem_emb_model  ON memory_embeddings (model);

-- ── 5. memory_shares：共享授权（含审批状态）────────────────
CREATE TABLE IF NOT EXISTS memory_shares (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_id      UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  from_character UUID NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  to_character   UUID NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  -- pending 待审批 / approved 已批准 / rejected 已拒绝 / revoked 已撤销
  status         TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','approved','rejected','revoked')),
  reason         TEXT,
  decided_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (memory_id, to_character)
);

CREATE INDEX IF NOT EXISTS idx_mem_shares_to
  ON memory_shares (to_character, status);
CREATE INDEX IF NOT EXISTS idx_mem_shares_from
  ON memory_shares (from_character, status);

-- ── 6. memory_conflicts：冲突待确认 ─────────────────────────
CREATE TABLE IF NOT EXISTS memory_conflicts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_a    UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  memory_b    UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  -- contradiction 互相矛盾 / duplicate 疑似重复 / stale 过时
  kind        TEXT NOT NULL DEFAULT 'contradiction'
              CHECK (kind IN ('contradiction','duplicate','stale')),
  detail      TEXT,
  status      TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending','resolved','ignored')),
  resolution  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  CONSTRAINT memory_conflicts_pair_chk CHECK (memory_a <> memory_b)
);

CREATE INDEX IF NOT EXISTS idx_mem_conflicts_status
  ON memory_conflicts (status, created_at DESC);

-- ── 7. 审计：记忆删除必须可追溯 ─────────────────────────────
-- 复用既有 audit_events 表（不新建），只加一个索引方便按记忆查
CREATE INDEX IF NOT EXISTS idx_audit_memory
  ON audit_events (at DESC)
  WHERE action LIKE 'memory.%';

-- ============================================================
-- 完成。校验：
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name='memories' ORDER BY ordinal_position;
-- ============================================================
