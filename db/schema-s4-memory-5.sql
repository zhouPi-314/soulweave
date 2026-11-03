-- 关键词通道的索引基础：pg_trgm
--
-- 解决两个问题：
--   1. ILIKE '%词%' 走 GIN 索引，不再全表扫
--   2. 可以低成本算「全局 df」，IDF 不再用范围内总数近似
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_memories_content_trgm ON memories USING gin (content gin_trgm_ops);
