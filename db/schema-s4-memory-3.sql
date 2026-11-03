-- 量化向量：int8 存储，用于大规模粗排
-- 512 维 REAL[] 的文本形式约 9KB/行；int8 只要 512 字节（base64 后 683B），
-- 20000 行从 ~40MB 降到 ~3MB。
ALTER TABLE memories ADD COLUMN IF NOT EXISTS embedding_q BYTEA;
CREATE INDEX IF NOT EXISTS idx_memories_q_null ON memories (owner_character) WHERE embedding_q IS NULL AND embedding IS NOT NULL;
