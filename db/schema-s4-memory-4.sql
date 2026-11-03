-- float32 精确向量：替代 REAL[] 文本存储
-- REAL[] 的文本形式约 9KB/行；float32 BYTEA 只要 2048 字节（512 维 × 4B）。
-- 配合 embedding_q(int8, 512B)，每行共 2.5KB，比原来省约 72%。
ALTER TABLE memories ADD COLUMN IF NOT EXISTS embedding_f32 BYTEA;
CREATE INDEX IF NOT EXISTS idx_memories_f32_null ON memories (owner_character) WHERE embedding_f32 IS NULL AND embedding IS NOT NULL;
