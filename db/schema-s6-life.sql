-- SoulWeave S6：主动生活 · 数据层
-- 依据：01 需求第 6 章 / 7.8 节，D46（虚构/真实标识）

-- ─── 角色作息（与现实时间同步） ──────────────────────
CREATE TABLE IF NOT EXISTS life_schedule (
  id            BIGSERIAL PRIMARY KEY,
  owner_character TEXT NOT NULL,
  kind          TEXT NOT NULL,          -- wake/work/meal/rest/sleep/activity/custom
  start_minute  INT  NOT NULL,          -- 一天内第几分钟 0-1439
  end_minute    INT  NOT NULL,
  days_mask     INT  NOT NULL DEFAULT 127,  -- 位掩码，bit0=周一 … bit6=周日
  title         TEXT NOT NULL,
  scene         TEXT,
  enabled       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_life_schedule_owner ON life_schedule (owner_character, enabled);

-- ─── 生活事件 / 日记 ────────────────────────────────
CREATE TABLE IF NOT EXISTS life_event (
  id              BIGSERIAL PRIMARY KEY,
  owner_character TEXT NOT NULL,
  kind            TEXT NOT NULL,        -- diary/event/activity/reminder/mood
  title           TEXT NOT NULL,
  body            TEXT,
  mood            TEXT,                 -- 心情标签
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- D46 合规底线：默认虚构
  is_fictional    BOOLEAN NOT NULL DEFAULT TRUE,
  ai_generated    BOOLEAN NOT NULL DEFAULT FALSE,
  source          TEXT NOT NULL DEFAULT 'user',   -- user/rule/ai
  -- 共享与可见性（复用 S4 的权限模型）
  scope           TEXT NOT NULL DEFAULT 'private', -- private/shared
  deleted_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_life_event_owner_time ON life_event (owner_character, occurred_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_life_event_kind ON life_event (kind) WHERE deleted_at IS NULL;

-- ─── 虚拟相册 ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS life_media (
  id              BIGSERIAL PRIMARY KEY,
  owner_character TEXT NOT NULL,
  event_id        BIGINT REFERENCES life_event(id) ON DELETE SET NULL,
  rel_path        TEXT NOT NULL,        -- 相对于媒体根目录
  media_kind      TEXT NOT NULL DEFAULT 'photo',  -- photo/illustration
  width           INT,
  height          INT,
  bytes           BIGINT,
  prompt          TEXT,                 -- 生成用的提示词（可追溯）
  provider        TEXT,                 -- pollinations/openai/local-sd
  -- D46 合规底线：默认虚构
  is_fictional    BOOLEAN NOT NULL DEFAULT TRUE,
  ai_generated    BOOLEAN NOT NULL DEFAULT FALSE,
  favorite        BOOLEAN NOT NULL DEFAULT FALSE,
  deleted_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_life_media_owner_time ON life_media (owner_character, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_life_media_event ON life_media (event_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_life_media_fav ON life_media (owner_character, favorite) WHERE deleted_at IS NULL AND favorite;

-- ─── 角色共同活动 ──────────────────────────────────
CREATE TABLE IF NOT EXISTS life_joint_activity (
  id              BIGSERIAL PRIMARY KEY,
  participants    TEXT[] NOT NULL,      -- ['冰糖','小橘子']
  kind            TEXT NOT NULL,
  title           TEXT NOT NULL,
  body            TEXT,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at        TIMESTAMPTZ,
  is_fictional    BOOLEAN NOT NULL DEFAULT TRUE,
  ai_generated    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_life_joint_time ON life_joint_activity (started_at DESC);

-- ─── 主动行为预算（时间窗/频率/预算） ───────────────
CREATE TABLE IF NOT EXISTS life_proactive_usage (
  id              BIGSERIAL PRIMARY KEY,
  owner_character TEXT NOT NULL,
  day             DATE NOT NULL,
  kind            TEXT NOT NULL,        -- private_chat/diary/album/share
  count           INT NOT NULL DEFAULT 0,
  last_at         TIMESTAMPTZ,
  UNIQUE (owner_character, day, kind)
);
CREATE INDEX IF NOT EXISTS idx_life_proactive_day ON life_proactive_usage (day DESC);
