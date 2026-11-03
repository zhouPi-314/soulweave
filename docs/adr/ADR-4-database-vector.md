# ADR-4｜数据库与向量检索

> **状态**：提议（待负责人批准）｜**日期**：2026-10-26｜**阶段**：S1

## 背景

PostgreSQL 18.6 已确认作为主数据库（V1.7 基线）。但 **pgvector 无法安装**（详见 S0 补充报告 §4）。

## 事实

| 项 | 值 |
|---|---|
| PostgreSQL | 18.6，**Running**，端口 5432 |
| 安装路径 | `D:\PostgreSQL\18` |
| 构建方式 | **MSVC**（`pg_config --cc` = `cl`） |
| 扩展数 | 62 个 `.control` |
| pgvector | **0**（未安装） |

**pgvector 安装的三个障碍**：

1. **无 Windows 预编译包** — 官方只提供 Linux/macOS 包管理器方式
2. **必须 nmake 编译** — 需要 MSVC
3. **MinGW 编译无法链接** — 本机 PG 是 MSVC 构建，ABI 不兼容

**而 MSVC 安装强制写入 C 盘**（约 2–6 GB），违反当前约束。

## 决策

**分两阶段**：

### 阶段 1（S1–S3）：PostgreSQL + 应用层向量

- 所有关系数据存 PostgreSQL
- 向量以 `float4[]` 或 `bytea` 存储
- 检索在 Node 侧做余弦相似度计算
- 记忆规模 < 10 万条时性能可接受（推断，需实测）

### 阶段 2（S4 前）：三选一

| 方案 | 成本 | 风险 |
|---|---|---|
| **A. 装 VS Build Tools** | C 盘 2–6 GB | 违反当前约束，需负责人批准 |
| **B. Docker + pgvector** | 需启动 Docker | data root 需确认在 D 盘 |
| **C. 评估 pglite** | 0（WASM） | 是否适合做主库未验证 |

## 为什么不用 SQLite 做主库

V1.7 明确：**SQLite 仅作待评估备选，不可无批准替换既定记忆能力**。

注意区分：
- **SQLite** = 独立数据库，**违反 V1.7**
- **pglite** = PostgreSQL 的 WASM 构建，**不违反**（仍是 PG 语义）

## 数据模型草案

```sql
CREATE TABLE characters (
  id            UUID PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('local_dsh','cloud_api')),
  protection    TEXT NOT NULL CHECK (protection IN ('fixed_protected','default_protected','normal')),
  name          TEXT NOT NULL,
  persona_ref   UUID,
  voice_ref     UUID,
  avatar_ref    TEXT,
  state         TEXT NOT NULL DEFAULT 'active',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 唯一 local_dsh 约束
CREATE UNIQUE INDEX one_local_dsh ON characters (kind)
  WHERE kind = 'local_dsh';

-- 记忆（含向量，阶段 1 用 float4[]）
CREATE TABLE memories (
  id              UUID PRIMARY KEY,
  owner_character UUID NOT NULL REFERENCES characters(id),
  scope           TEXT NOT NULL CHECK (scope IN ('private','shared')),
  sensitivity     SMALLINT NOT NULL DEFAULT 0,
  content         TEXT NOT NULL,
  embedding       REAL[],
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ON memories (owner_character, scope);
```

## 检索顺序（V1.7 强制）

```text
1. 按 owner_character 过滤（权限）
2. 按 scope 过滤（私有/共享）
3. 按 sensitivity 过滤（敏感度）
4. 向量相似度排序
5. 返回
```

**不能先做向量排序再过滤**——那会泄漏其他角色的记忆存在性。

## 待验证

- [ ] 10 万条记忆的应用层向量检索耗时（S4）
- [ ] REAL[] vs bytea 的存储效率
- [ ] pglite 的持久化与并发能力

## 参考

- S0 补充报告 §4
- 02 §4（数据域与隔离）
- V1.7 D56（数据库条款）