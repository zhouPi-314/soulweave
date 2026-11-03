-- ============================================================
-- SoulWeave S4：记忆标记与冲突保护 schema 增量
-- ============================================================
--
-- 1. memories.pinned —— 用户主动标记「这是重要的，别忘」
--    之前只能用 source='user_marked' 表达，但 source 表示来源出处，
--    语义混用会让「这条是自动提取的还是用户标记的」说不清。
--
-- 2/3/4. 衰减与冲突查询用的索引
--
-- ============================================================

ALTER TABLE memories ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_memories_pinned
  ON memories (owner_character) WHERE pinned AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_memories_decay_due
  ON memories (decay_at) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_mem_conflicts_a ON memory_conflicts (memory_a) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_mem_conflicts_b ON memory_conflicts (memory_b) WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_memories_deleted_at
  ON memories (owner_character, deleted_at DESC) WHERE deleted_at IS NOT NULL;
