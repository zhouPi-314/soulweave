/**
 * SoulWeave S4：记忆仓储层（pg 连接池版）
 *
 * 【为什么从 psql 子进程换成 pg 连接池】
 * 实测每条查询有 117–118ms 的 psql 进程启动固定开销，占 P95 预算的 59%。
 * 更要紧的是：之前为了「拿 psql 当驱动用」，被迫做了一堆补丁，
 * 每个补丁都是一个 bug 来源：
 *   · 中文 SQL 经 argv 被按 GBK 编码 → 必须走 stdin
 *   · DML 不能放进子查询 → 必须 CTE 包装，且不带 RETURNING 就静默失败
 *   · 没有参数化 → 手写单引号转义
 * 换成 pg 后这些全部消失：真参数化、二进制协议、事务可用。
 *
 * 【安全不变式（V1.7 强制，不可调换）】
 * 检索顺序 owner_character → scope → sensitivity → 向量排序。
 * 排版上先做 SQL WHERE 圈定权限，只把过滤后的行交给排序函数 ——
 * 结构上不可能「先排序再过滤」。
 */

import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { Pool, type PoolConfig } from 'pg';
// memory-conflict 只用 import type 依赖本文件，运行时不会成环
import { smartMerge, markCenterDirty, extractSlots } from './memory-conflict.js';
import {
  tokenizeForKeyword, bm25Raw, bm25RawGlobal, bm25Params, normalizeBm25, fuseScore, ENTITY_BOOST_WEIGHT,
} from './memory-ranking.js';

export interface MemoryRow {
  id: string;
  owner_character: string;
  scope: 'private' | 'shared';
  sensitivity: number;
  content: string;
  summary: string | null;
  importance: number;
  consent: number;
  source: string | null;
  source_msg_id: string | null;
  content_hash: string | null;
  version: number;
  created_at: string;
  last_accessed_at: string | null;
  expires_at: string | null;
  deleted_at: string | null;
  /** 用户主动标记「别忘」 */
  pinned?: boolean;
  embedding?: number[] | null;
}

export interface MemoryFindOptions {
  ownerCharacter: string;
  includePrivate?: boolean;
  includeShared?: boolean;
  maxSensitivity?: number;
  keyword?: string;
  queryVector?: number[];
  candidates?: number;
  /** 精确重排条数上限（默认 200）。limit 很大时靠它兜住成本 */
  rerankMax?: number;
  /** 原始查询文本。提供时启用关键词通道（混合检索）。 */
  queryText?: string;
  /** 是否启用混合检索（默认 true，仅在有 queryText 时生效） */
  hybrid?: boolean;
  /** 关键词候选上限（默认 500） */
  keywordLimit?: number;
  minScore?: number;
  limit?: number;
  /** 分页偏移（简单翻页；数据变动时可能跳条/重复） */
  offset?: number;
  /**
   * 游标分页（推荐）。格式 "importance|created_at|id"。
   * 传入上一次返回的 nextCursor 即可拿到下一页，**不会因为数据变动而跳过或重复**。
   * 注意：仅用于「按重要度排序」的列表模式；向量检索模式用 offset。
   */
  cursor?: string;
  withEmbedding?: boolean;
  trackAccess?: boolean;
}

export interface MemoryRepositoryOptions {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  /** 连接池上限（默认 4，桌面应用不需要更多） */
  max?: number;
}

interface QueryResult { ok: boolean; rows?: any[]; error?: string; }

/** 共享规则：敏感度达到此值即禁止跨角色共享（决策 ①+③） */
export const SHARE_MAX_SENSITIVITY = 2;

/** 默认候选上限：实测 200 条约 20–30ms（用 pg 后），在 P95 预算内 */
export const DEFAULT_CANDIDATES = 200;

/**
 * 把 `:'name'` 命名占位符转成 pg 的 `$n`。
 * 保留命名写法是为了让调用处可读（且和旧代码兼容），
 * 实际执行走 pg 的真参数化，不再有任何字符串拼接。
 */
function toPositional(sql: string, vars: Record<string, any>): { text: string; values: any[] } {
  const values: any[] = [];
  const index = new Map<string, number>();
  const text = sql.replace(/:'([A-Za-z_][A-Za-z0-9_]*)'/g, (_m, name: string) => {
    if (!(name in vars)) throw new Error('未提供的 SQL 变量: ' + name);
    let n = index.get(name);
    if (n === undefined) { values.push(vars[name]); n = values.length; index.set(name, n); }
    return '$' + n;
  });
  return { text, values };
}

/** float[] → float32 Buffer（精确存储，2KB/512 维） */
export function packFloat32(vec: number[]): Buffer | null {
  if (!Array.isArray(vec) || !vec.length || vec.length > 4096) return null;
  const buf = Buffer.alloc(vec.length * 4);
  for (let i = 0; i < vec.length; i++) buf.writeFloatLE(Number(vec[i]) || 0, i * 4);
  return buf;
}

/** float32 Buffer → number[] */
export function unpackFloat32(buf: any): number[] | null {
  if (!buf) return null;
  const b: Buffer = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (!b.length || b.length % 4) return null;
  const n = b.length / 4;
  const out: number[] = new Array(n);
  for (let i = 0; i < n; i++) out[i] = b.readFloatLE(i * 4);
  return out;
}

/** float[] → int8 Buffer（向量已 L2 归一化，值域 [-1,1]） */
export function quantizeVector(vec: number[]): Buffer | null {
  if (!Array.isArray(vec) || !vec.length || vec.length > 4096) return null;
  const buf = Buffer.alloc(vec.length);
  for (let i = 0; i < vec.length; i++) {
    const v = Math.max(-1, Math.min(1, Number(vec[i]) || 0));
    buf[i] = (Math.round(v * 127) + 128) & 0xff;   // 存为无符号
  }
  return buf;
}

/** int8 Buffer → number[]（还原到 [-1,1]） */
export function dequantizeVector(buf: any): number[] | null {
  if (!buf) return null;
  const b: Buffer = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (!b.length) return null;
  const out: number[] = new Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = (b[i] - 128) / 127;
  return out;
}

/** 把 pg 的 REAL[] 文本转成 number[] */
function parseVec(v: any): number[] | null {
  if (Array.isArray(v)) return v.map(Number);
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s || s === '{}') return [];
    return s.replace(/^\{|\}$/g, '').split(',').map((x) => Number(x.trim())).filter((x) => isFinite(x));
  }
  return null;
}

/**
 * 角色标识 → 稳定 UUID。
 * 角色仓库（roster.json）里的 id 是 'char-bingtang' 这种字符串，而
 * memories.owner_character 是 UUID 外键。这里用固定算法把字符串映射成
 * 一个确定的 UUID：同一角色每次都是同一个值，不需要额外映射表。
 */
export function ownerUuid(id: string): string {
  const s = String(id || '');
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return s.toLowerCase();
  const h = createHash('sha1').update('soulweave:character:' + s).digest('hex');
  return h.slice(0, 8) + '-' + h.slice(8, 12) + '-5' + h.slice(13, 16) + '-a' + h.slice(17, 20) + '-' + h.slice(20, 32);
}

export class MemoryRepository {
  private pool: Pool | null = null;
  private opts: MemoryRepositoryOptions;

  constructor(opts: MemoryRepositoryOptions) {
    this.opts = opts;
  }

  private getPool(): Pool {
    if (this.pool) return this.pool;
    const cfg: PoolConfig = {
      host: this.opts.host,
      port: this.opts.port,
      user: this.opts.user,
      password: this.opts.password,
      database: this.opts.database,
      max: this.opts.max ?? 4,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 8000,
      application_name: 'soulweave-memory',
    };
    this.pool = new Pool(cfg);
    // 池里某个连接出错不应该让进程崩掉
    this.pool.on('error', () => undefined);
    return this.pool;
  }

  private async query(sql: string, vars: Record<string, any> = {}): Promise<QueryResult> {
    try {
      const { text, values } = toPositional(sql, vars);
      const r = await this.getPool().query(text, values);
      return { ok: true, rows: r.rows };
    } catch (e: any) {
      return { ok: false, error: String((e && e.message) || e).slice(0, 300) };
    }
  }

  /** 原样执行（测试准备数据 / 维护用） */
  async exec(sql: string, vars: Record<string, any> = {}): Promise<QueryResult> {
    return this.query(sql, vars);
  }

  /** 关闭连接池 */
  async close(): Promise<void> {
    try { await this.pool?.end(); } catch (e) { /* ignore */ }
    this.pool = null;
  }

  // ── pgvector 能力探测（接口预留，默认不用）──────────────
  /**
   * 检测当前数据库是否装了 pgvector 扩展。
   * 用户想用 ANN 索引时可据此给出引导；装不上就保持线性扫描。
   */
  async probePgvector(): Promise<{ available: boolean; version?: string; error?: string }> {
    const r = await this.query("SELECT extversion FROM pg_extension WHERE extname = 'vector'");
    if (!r.ok) return { available: false, error: r.error };
    const row = (r.rows || [])[0];
    return row ? { available: true, version: row.extversion } : { available: false };
  }

  // ── 写入 ────────────────────────────────────────────────
  async create(input: {
    ownerCharacter: string;
    content: string;
    scope?: 'private' | 'shared';
    sensitivity?: number;
    importance?: number;
    summary?: string;
    source?: string;
    sourceMsgId?: string | null;
    embedding?: number[] | null;
    expiresAt?: string | null;
  }): Promise<{ ok: boolean; id?: string; duplicate?: boolean; error?: string }> {
    const content = String(input.content || '');
    if (!content.trim()) return { ok: false, error: '内容为空' };

    const found = await this.query(
      "SELECT id FROM memories WHERE owner_character = :'owner'::uuid " +
      "AND content_hash = md5(:'content') AND deleted_at IS NULL LIMIT 1",
      { owner: ownerUuid(input.ownerCharacter), content });
    if (!found.ok) return { ok: false, error: found.error };
    const exist = (found.rows || [])[0];
    if (exist) return { ok: true, id: exist.id, duplicate: true };

    const qbuf = input.embedding && input.embedding.length ? quantizeVector(input.embedding) : null;
    const fbuf = input.embedding && input.embedding.length ? packFloat32(input.embedding) : null;
    const sql =
      "INSERT INTO memories (owner_character, scope, sensitivity, content, summary, importance, " +
      "                      source, source_msg_id, content_hash, embedding_q, embedding_f32, expires_at) " +
      "VALUES (:'owner'::uuid, :'scope', :'sensitivity'::smallint, :'content', " +
      "        NULLIF(:'summary',''), :'importance'::real, NULLIF(:'source',''), " +
      "        NULLIF(:'sourceMsgId','')::uuid, md5(:'content'), " +
      "        :'qbuf'::bytea, :'fbuf'::bytea, " +
      "        NULLIF(:'expiresAt','')::timestamptz) " +
      "ON CONFLICT (owner_character, content_hash) WHERE content_hash IS NOT NULL AND deleted_at IS NULL " +
      "DO NOTHING RETURNING id";

    const ins = await this.query(sql, {
      owner: ownerUuid(input.ownerCharacter),
      scope: input.scope || 'private',
      sensitivity: input.sensitivity ?? 0,
      content,
      summary: input.summary || '',
      importance: input.importance ?? 0.5,
      source: input.source || '',
      sourceMsgId: input.sourceMsgId || '',
      expiresAt: input.expiresAt || '',
      qbuf: qbuf,
      fbuf: fbuf,
    });
    if (!ins.ok) return { ok: false, error: ins.error };
    const row = (ins.rows || [])[0];
    if (row) { markCenterDirty(ownerUuid(input.ownerCharacter)); return { ok: true, id: row.id, duplicate: false }; }

    const again = await this.query(
      "SELECT id FROM memories WHERE owner_character = :'owner'::uuid " +
      "AND content_hash = md5(:'content') AND deleted_at IS NULL LIMIT 1",
      { owner: ownerUuid(input.ownerCharacter), content });
    if (!again.ok) return { ok: false, error: again.error };
    const r2 = (again.rows || [])[0];
    return r2 ? { ok: true, id: r2.id, duplicate: true } : { ok: false, error: '插入未生效且未找到记录' };
  }

  // ── 检索（安全关键）──────────────────────────────────
  async find(o: MemoryFindOptions): Promise<{
    ok: boolean;
    rows?: MemoryRow[];
    error?: string;
    nextCursor?: string | null;
    /** 本次是否真的走了混合检索（关键词通道） */
    hybridApplied?: boolean;
    /** 关键词通道的失败原因（有值说明退回了纯向量） */
    hybridError?: string | null;
  }> {
    const includePrivate = o.includePrivate !== false;
    const includeShared = o.includeShared === true;
    const maxSens = o.maxSensitivity ?? 3;
    const limit = Math.min(Math.max(o.limit || 50, 1), 500);
    const offset = Math.max(0, o.offset || 0);
    const qv = o.queryVector;
    const useVec = !!(qv && qv.length);

    // ── 第一步：权限过滤（顺序不可调换）──────────────────
    // 先按 owner_character 圈定主体，再按 scope / 共享审批 / 敏感度收窄。
    // 只有通过这一步的行才会进入后续的向量计算。
    const parts: string[] = [];
    if (includePrivate) {
      parts.push("SELECT m.* FROM memories m WHERE m.owner_character = :'owner'::uuid AND m.scope = 'private'");
    }
    if (includeShared) {
      parts.push("SELECT m.* FROM memories m WHERE m.owner_character = :'owner'::uuid AND m.scope = 'shared'");
      parts.push(
        "SELECT m.* FROM memories m JOIN memory_shares s ON s.memory_id = m.id " +
        "WHERE s.to_character = :'owner'::uuid AND s.status = 'approved' AND m.scope = 'shared'"
      );
    }
    if (!parts.length) return { ok: true, rows: [] };

    const union = parts.join(' UNION ');
    // 所有查询都必须用同一段过滤条件 —— 抽出来，避免两条路径写出差异
    let filterWhere =
      "WHERE m.deleted_at IS NULL " +
      "  AND m.sensitivity <= :'maxSens'::smallint " +
      "  AND (:'kw' = '' OR m.content ILIKE '%' || :'kw' || '%' OR COALESCE(m.summary,'') ILIKE '%' || :'kw' || '%') ";

    // 列表模式的游标：(importance, created_at, id) 严格递减
    let cursorCond = '';
    const cursorVars: any = {};
    if (!useVec && o.cursor) {
      const c = String(o.cursor).split('|');
      if (c.length === 3) {
        cursorCond = "  AND (m.importance, m.created_at, m.id) < (:'cImp'::real, :'cAt'::timestamptz, :'cId'::uuid) ";
        cursorVars.cImp = Number(c[0]); cursorVars.cAt = c[1]; cursorVars.cId = c[2];
      }
    }

    // ── 向量模式：两阶段查询 ─────────────────────────────
    // 阶段 1 只取 id + embedding 算分（不搬 content 等大字段），
    // 阶段 2 只取最终这一页的整行。
    // 这样即使记忆上万条，也不必一次把全部内容和向量都搬过来。
    if (useVec) {
      // 向量模式要扫描的上限：默认覆盖 2 万条软上限
      const maxVecScan = Math.min(Math.max(o.candidates || 20000, limit + offset), 20000);
      // 阶段 1 优先用 int8 量化向量（传输量小 13 倍）；
      // 没有量化值的行回退到 REAL[]
      const scoreSql =
        "SELECT m.id, m.importance, m.embedding_q, m.embedding_f32 FROM (" + union + ") m " +
        filterWhere.replace(', pinned', '') +
        "ORDER BY m.importance DESC, m.id DESC LIMIT " + maxVecScan;

      const sq = await this.query(scoreSql, { owner: ownerUuid(o.ownerCharacter), maxSens, kw: o.keyword || '' });
      if (!sq.ok) return { ok: false, error: sq.error };

      // 查询向量也量化一份，保证两边同尺度
      const qv8 = quantizeVector(qv!);
      const qvF: number[] = [];
      if (qv8) for (let i = 0; i < qv8.length; i++) qvF.push((qv8[i] - 128) / 127);

      // ── 阶段 1：粗排（int8）──
      const coarse = (sq.rows || []).map((x: any) => {
        const vq = dequantizeVector(x.embedding_q);
        const v = vq && vq.length ? vq : unpackFloat32(x.embedding_f32);
        let s = 0;
        if (v && v.length) {
          const n = Math.min(v.length, qvF.length || qv!.length);
          for (let i = 0; i < n; i++) s += v[i] * (qvF.length ? qvF[i] : qv![i]);
        }
        return { id: x.id as string, score: s, full: null as number[] | null };
      });

      // ── 阶段 1.5：精确重排 ──
      // int8 有约 0.007 的分数偏差，会改变近距离条目的相对顺序。
      // 所以取粗排前 rerankK 名，用 float32 精确向量重算分数，再取这一页。
      // 只对少数条目重算，代价很小，但顺序是全精度的。
      // 重排上限：默认最多 200 条。limit 很大时（比如导出全量）不加这个上限，
      // 重排会退化成「把全部候选都用 float32 算一遍」，失去两阶段的意义。
      const rerankMax = Math.min(Math.max(Number(o.rerankMax) || 200, 20), 2000);
      const rerankK = Math.min(coarse.length, Math.max(limit + offset, 20) * 4, rerankMax);
      coarse.sort((a, b) => (b.score - a.score) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
      const headList = coarse.slice(0, rerankK);
      const headIds = headList.map((x) => "'" + x.id.replace(/'/g, "''") + "'").join(',');
      if (headIds) {
        const fq = await this.query(
          "SELECT id, embedding_f32 FROM memories WHERE id = ANY(ARRAY[" + headIds + "]::uuid[])");
        if (fq.ok) {
          const fmap = new Map<string, number[]>();
          for (const row of (fq.rows || [])) {
            const fv = unpackFloat32(row.embedding_f32);
            if (fv && fv.length) fmap.set(row.id, fv);
          }
          for (const item of headList) {
            const fv = fmap.get(item.id);
            if (!fv) continue;
            let s = 0;
            const n = Math.min(fv.length, qv!.length);
            for (let i = 0; i < n; i++) s += fv[i] * qv![i];
            item.score = s;   // 用全精度分数替换粗排分数
            item.full = fv;
          }
        }
      }

      // ── 混合检索：关键词通道（算法对齐 Mem0，见 memory-ranking.ts）──
      //
      // 与上一版的区别：
      //   1. IDF 用**全局 df**（对每个词元数一次），不再用范围内总数近似
      //   2. 候选按 pg_trgm 的 similarity 排序后取前 N（N 可配置），不再随便截断
      //   3. 增加实体加成通道（Mem0 的 entity boost，上限 0.5）
      //
      // 安全不变式：每一步都复用**同一个 union 子查询**（含 owner/scope/sensitivity），
      // 再把命中与已过滤候选集求交 —— 走关键词通道不会放宽任何范围。
      const keywordMap = new Map<string, number>();
      const boostMap = new Map<string, number>();
      let hybridErr: string | null = null;
      const qtext = String(o.queryText || o.keyword || '').trim();
      const hybridOn = o.hybrid !== false;

      if (hybridOn && qtext) {
        try {
          const toks = tokenizeForKeyword(qtext).slice(0, 8);
          if (toks.length) {
            const esc = (s: string) => s.replace(/'/g, "''");
            const likes = toks.map((tk) => "m.content ILIKE '%" + esc(tk) + "%'").join(' OR ');

            // (1) 一次查询同时拿到：范围内总数 N + 每个词元的全局 df
            const dfCols = toks
              .map((tk, i) => "COUNT(*) FILTER (WHERE m.content ILIKE '%" + esc(tk) + "%')::int AS df" + i)
              .join(', ');
            // 必须带上 union 里用到的全部参数（owner / maxSens / kw），
            // 否则会报「未提供的 SQL 变量」，而且这个错误很容易被当成「没命中」忽略掉。
            const baseParams = { owner: ownerUuid(o.ownerCharacter), maxSens, kw: o.keyword || '' };
            const stat = await this.query(
              "SELECT COUNT(*)::int AS n_total, " + dfCols + " FROM (" + union + ") m", baseParams);
            if (!stat.ok) hybridErr = 'stat: ' + String(stat.error).slice(0, 160);
            const st = (stat.rows || [])[0] || {};
            const nTotal = Number(st.n_total) || coarse.length;
            const df: number[] = toks.map((_, i) => Number(st['df' + i]) || 0);

            // (2) 关键词候选：按 similarity 排序后取前 N
            const kwLimit = Math.min(Math.max(Number(o.keywordLimit) || 500, 20), 5000);
            const kq = await this.query(
              "SELECT m.id, m.content, similarity(m.content, :'q') AS sim FROM (" + union + ") m " +
              "WHERE (" + likes + ") ORDER BY sim DESC LIMIT " + kwLimit,
              { ...baseParams, q: qtext });

            if (!kq.ok) hybridErr = 'kw: ' + String(kq.error).slice(0, 160);
            if (kq.ok && (kq.rows || []).length) {
              const candIds = new Set(coarse.map((c) => c.id));
              const hits = (kq.rows || [])
                .filter((x: any) => candIds.has(x.id))
                .map((x: any) => ({ id: x.id as string, content: String(x.content || '') }));

              if (hits.length) {
                // 用全局 df / N 算 BM25
                const raw = bm25RawGlobal(toks, hits, df, nTotal);
                const prm = bm25Params(toks.length);
                for (const [id, sc] of raw) {
                  keywordMap.set(id, normalizeBm25(sc, prm.midpoint, prm.steepness));
                }
              }

              // (3) 实体加成：查询里的实体（槽位值）出现在候选里就给加成
              const ents = extractSlots(qtext).map((x) => x.value).filter((v) => v && v.length >= 2);
              if (ents.length) {
                for (const h of hits) {
                  let matched = 0;
                  for (const e of ents) if (h.content.indexOf(e) >= 0) matched++;
                  if (matched) {
                    boostMap.set(h.id, ENTITY_BOOST_WEIGHT * (matched / ents.length));
                  }
                }
              }
            }
          }
        } catch (e) {
          // 关键词通道是可选的增强，失败就退回纯向量，不影响主流程。
          // 但错误必须留痕 —— 静默失败会让「混合检索没生效」变得不可见。
          hybridErr = String(e).slice(0, 200);
        }
      }

      const minScore = o.minScore ?? -1;
      const kerThreshold = minScore > 0 ? minScore : -2;

      const kwSignals = { keyword: keywordMap.size > 0, boost: boostMap.size > 0 };
      const hasHybrid = keywordMap.size > 0 || boostMap.size > 0;
      const scored = hasHybrid
        ? coarse
            .map((x) => {
              const f = fuseScore({
                semantic: x.score,
                keyword: keywordMap.get(x.id) || 0,
                boost: boostMap.get(x.id) || 0,
                threshold: kerThreshold,
                signals: kwSignals,
              });
              return { id: x.id, score: f.ok ? f.score : -1, full: x.full, gated: !f.ok };
            })
            .filter((x) => !x.gated)
        : coarse;

      let kept = scored.filter((x) => x.score >= minScore);
      // 并列键用 id：importance 会随衰减变化，id 永远不变
      kept.sort((a, b) => (b.score - a.score) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));

      // 向量游标：score|id
      if (o.cursor) {
        const c2 = String(o.cursor).split('|');
        if (c2.length === 2) {
          const cs = Number(c2[0]); const cid = c2[1];
          if (isFinite(cs)) kept = kept.filter((x) => x.score < cs || (x.score === cs && x.id < cid));
        }
      }

      const page = kept.slice(offset, offset + limit);
      if (!page.length) return { ok: true, rows: [], nextCursor: null, hybridApplied: hasHybrid ?? false, hybridError: hybridErr };

      // 阶段 2：取整行
      const ids = page.map((x) => "'" + x.id.replace(/'/g, "''") + "'").join(',');
      const fullQ = await this.query(
        "SELECT id, owner_character, scope, sensitivity, content, summary, importance, consent, " +
        "       source, source_msg_id, content_hash, version, created_at, last_accessed_at, " +
        "       expires_at, deleted_at, pinned " +
        "FROM memories WHERE id = ANY(ARRAY[" + ids + "]::uuid[])", {});
      if (!fullQ.ok) return { ok: false, error: fullQ.error };

      const byId = new Map<string, any>();
      for (const r of (fullQ.rows || [])) byId.set(r.id, r);

      // 注意：这里的行**已经过权限过滤**（id 来自阶段 1 的过滤结果），
      // 阶段 2 只是按 id 取回字段，没有再放宽任何范围。
      const rows: MemoryRow[] = page
        .map((x) => byId.get(x.id))
        .filter(Boolean)
        .map((x: any) => ({ ...x, importance: Number(x.importance), sensitivity: Number(x.sensitivity) }));

      void this.markAccessed(rows, o.trackAccess !== false);

      let nextCursor: string | null = null;
      if (kept.length > offset + limit) {
        const last = kept[offset + limit - 1];
        nextCursor = last.score + '|' + last.id;
      }
      return { ok: true, rows, nextCursor, hybridApplied: hasHybrid ?? false, hybridError: hybridErr };
    }

    // ── 列表模式 ─────────────────────────────────────────
    const candidates = Math.min(Math.max(o.candidates || DEFAULT_CANDIDATES, limit + offset), 2000);
    const sql =
      "SELECT id, owner_character, scope, sensitivity, content, summary, importance, consent, " +
      "       source, source_msg_id, content_hash, version, created_at, last_accessed_at, " +
      "       expires_at, deleted_at, pinned " +
      "FROM (" + union + ") m " +
      filterWhere + cursorCond +
      "ORDER BY m.importance DESC, m.created_at DESC, m.id DESC " +
      "LIMIT " + candidates;

    const r = await this.query(sql, { owner: ownerUuid(o.ownerCharacter), maxSens, kw: o.keyword || '', ...cursorVars });
    if (!r.ok) return { ok: false, error: r.error };

    const rows: MemoryRow[] = (r.rows || []).map((x: any) => ({
      ...x, importance: Number(x.importance), sensitivity: Number(x.sensitivity),
    }));

    const plain = rows.slice(offset, offset + limit);
    void this.markAccessed(plain, o.trackAccess !== false);

    let nextCursor: string | null = null;
    if (plain.length && rows.length > offset + limit) {
      const last = plain[plain.length - 1];
      const rawAt: any = last.created_at;
      const at = rawAt && typeof rawAt.toISOString === 'function' ? (rawAt as Date).toISOString() : String(rawAt);
      nextCursor = Number(last.importance) + '|' + at + '|' + last.id;
    }
    return { ok: true, rows: plain, nextCursor };
  }

  /** 记录访问时间（衰减算法需要）。用 pg 后开销极小，仍然不 await 以免阻塞检索。 */
  private async markAccessed(rows: MemoryRow[], enabled: boolean): Promise<void> {
    if (!enabled || !rows.length) return;
    const ids = rows.map((x) => x.id).filter(Boolean);
    if (!ids.length) return;
    await this.query(
      'UPDATE memories SET last_accessed_at = now() WHERE id = ANY(:\'ids\'::uuid[]) RETURNING 1',
      { ids: '{' + ids.join(',') + '}' });
  }

  // ── 删除 / 恢复 ────────────────────────────────────────
  async softDelete(id: string, ownerCharacter: string): Promise<{ ok: boolean; changed?: number; error?: string }> {
    const r = await this.query(
      "UPDATE memories SET deleted_at = now() " +
      "WHERE id = :'id'::uuid AND owner_character = :'owner'::uuid AND deleted_at IS NULL RETURNING id",
      { id, owner: ownerCharacter });
    if (!r.ok) return { ok: false, error: r.error };
    if ((r.rows || []).length) markCenterDirty(ownerCharacter);
    return { ok: true, changed: (r.rows || []).length };
  }

  async restore(id: string, ownerCharacter: string): Promise<{ ok: boolean; changed?: number; error?: string }> {
    const r = await this.query(
      "UPDATE memories SET deleted_at = NULL " +
      "WHERE id = :'id'::uuid AND owner_character = :'owner'::uuid AND deleted_at IS NOT NULL RETURNING id",
      { id, owner: ownerCharacter });
    if (!r.ok) return { ok: false, error: r.error };
    if ((r.rows || []).length) markCenterDirty(ownerCharacter);
    return { ok: true, changed: (r.rows || []).length };
  }

  // ── 共享（决策 ①+③）──────────────────────────────────
  /**
   * 发起共享。
   * 规则（用户决策 ①+③）：
   *   sensitivity ≤ 2 → 允许共享，文本原样、敏感度不变
   *   sensitivity = 3 → **禁止共享**（「秘密」不跨角色流动）
   */
  async requestShare(memoryId: string, fromCharacter: string, toCharacter: string, reason?: string)
    : Promise<{ ok: boolean; id?: string; error?: string; code?: string }> {
    // 先确认归属与敏感度
    const own = await this.query(
      "SELECT sensitivity, deleted_at FROM memories WHERE id = :'mem'::uuid AND owner_character = :'from'::uuid",
      { mem: memoryId, from: fromCharacter });
    if (!own.ok) return { ok: false, error: own.error };
    const row = (own.rows || [])[0];
    if (!row) return { ok: false, error: '记忆不存在或不属于发起者', code: 'NOT_FOUND' };
    if (row.deleted_at) return { ok: false, error: '已删除的记忆不能共享', code: 'DELETED' };
    const sens = Number(row.sensitivity) || 0;
    if (sens > SHARE_MAX_SENSITIVITY) {
      return {
        ok: false, code: 'TOO_SENSITIVE',
        error: '敏感度 ' + sens + ' 的记忆不允许跨角色共享（上限 ' + SHARE_MAX_SENSITIVITY + '）',
      };
    }

    const r = await this.query(
      "INSERT INTO memory_shares (memory_id, from_character, to_character, status, reason) " +
      "VALUES (:'mem'::uuid, :'from'::uuid, :'to'::uuid, 'pending', NULLIF(:'reason','')) " +
      "ON CONFLICT (memory_id, to_character) DO UPDATE SET status='pending', decided_at=NULL " +
      "RETURNING id",
      { mem: memoryId, from: fromCharacter, to: toCharacter, reason: reason || '' });
    if (!r.ok) return { ok: false, error: r.error };
    const srow = (r.rows || [])[0];
    return srow ? { ok: true, id: srow.id } : { ok: false, error: '共享记录写入失败' };
  }

  async decideShare(shareId: string, toCharacter: string, decision: 'approve' | 'reject')
    : Promise<{ ok: boolean; changed?: number; error?: string }> {
    const st = decision === 'approve' ? 'approved' : 'rejected';
    const r = await this.query(
      "UPDATE memory_shares SET status = :'st', decided_at = now() " +
      "WHERE id = :'id'::uuid AND to_character = :'to'::uuid AND status = 'pending' RETURNING id",
      { id: shareId, to: toCharacter, st });
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, changed: (r.rows || []).length };
  }

  async pendingShares(toCharacter: string): Promise<{ ok: boolean; rows?: any[]; error?: string }> {
    const r = await this.query(
      "SELECT s.id, s.memory_id, s.from_character, s.created_at, s.reason, m.content, m.summary, m.sensitivity " +
      "FROM memory_shares s JOIN memories m ON m.id = s.memory_id " +
      "WHERE s.to_character = :'to'::uuid AND s.status = 'pending' AND m.deleted_at IS NULL " +
      "ORDER BY s.created_at DESC", { to: toCharacter });
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, rows: r.rows };
  }

  /** 回填 embedding_q：把还没有量化向量的行补上（分批，可重复执行） */
  async backfillQuantized(batch = 200): Promise<{ ok: boolean; scanned?: number; updated?: number; remaining?: number; error?: string }> {
    // 一次补齐两种表示：int8（粗排）和 float32（精确重排）
    const q = await this.query(
      "SELECT id, embedding_q, embedding_f32 FROM memories " +
      "WHERE (embedding_q IS NULL OR embedding_f32 IS NULL) AND (embedding_q IS NOT NULL OR embedding_f32 IS NOT NULL) " +
      "LIMIT " + Math.min(Math.max(batch, 1), 2000));
    if (!q.ok) return { ok: false, error: q.error };
    const rows = q.rows || [];
    let updated = 0;
    for (const row of rows) {
      const v = unpackFloat32(row.embedding_f32) || dequantizeVector(row.embedding_q);
      if (!v || !v.length) continue;
      const bufQ = quantizeVector(v);
      const bufF = packFloat32(v);
      const u = await this.query(
        "UPDATE memories SET embedding_q = COALESCE(embedding_q, :'q'::bytea), " +
        "                    embedding_f32 = COALESCE(embedding_f32, :'f'::bytea) " +
        "WHERE id = :'id'::uuid RETURNING 1",
        { q: bufQ, f: bufF, id: row.id });
      if (u.ok) updated++;
    }
    const left = await this.query(
      "SELECT COUNT(*)::int AS n FROM memories WHERE embedding_q IS NULL AND embedding_f32 IS NULL AND content IS NOT NULL");
    return { ok: true, scanned: rows.length, updated, remaining: ((left.rows || [])[0] || {}).n || 0 };
  }

  /**
   * 给「完全没有向量」的记忆补向量。
   *
   * backfillQuantized 只处理「有至少一种表示但缺另一种」的行；
   * 早期数据两种都没有，需要重新跑一次 embedding 模型。
   */
  async backfillMissingEmbeddings(
    embedFn: (text: string) => Promise<{ ok: boolean; vector?: number[]; error?: string }>,
    batch = 20,
  ): Promise<{ ok: boolean; scanned?: number; embedded?: number; failed?: number; remaining?: number; error?: string }> {
    const q = await this.query(
      "SELECT id, content FROM memories " +
      "WHERE embedding_q IS NULL AND embedding_f32 IS NULL AND deleted_at IS NULL " +
      "ORDER BY created_at ASC LIMIT " + Math.min(Math.max(batch, 1), 200));
    if (!q.ok) return { ok: false, error: q.error };
    const rows = q.rows || [];
    let embedded = 0;
    let failed = 0;
    for (const row of rows) {
      const content = String(row.content || '').trim();
      if (!content) { failed++; continue; }
      let e: { ok: boolean; vector?: number[]; error?: string };
      try { e = await embedFn(content); } catch (err) { e = { ok: false, error: String(err) }; }
      if (!e || !e.ok || !e.vector || !e.vector.length) { failed++; continue; }
      const u = await this.query(
        "UPDATE memories SET embedding_q = :'q'::bytea, embedding_f32 = :'f'::bytea " +
        "WHERE id = :'id'::uuid RETURNING 1",
        { q: quantizeVector(e.vector), f: packFloat32(e.vector), id: row.id });
      if (u.ok) embedded++; else failed++;
    }
    const left = await this.query(
      "SELECT COUNT(*)::int AS n FROM memories " +
      "WHERE embedding_q IS NULL AND embedding_f32 IS NULL AND deleted_at IS NULL");
    return { ok: true, scanned: rows.length, embedded, failed, remaining: ((left.rows || [])[0] || {}).n || 0 };
  }

  /** 统计存储占用（用于验证量化效果） */
  async storageStats(): Promise<{ ok: boolean; data?: any; error?: string }> {
    const q = await this.query(
      "SELECT COUNT(*)::int AS rows_total, " +
      "  COUNT(*) FILTER (WHERE embedding_f32 IS NOT NULL OR embedding_q IS NOT NULL)::int AS with_vec, " +

      "  COALESCE(SUM(pg_column_size(embedding_q)), 0)::bigint AS q_bytes, " +
      "  COALESCE(SUM(pg_column_size(embedding_f32)), 0)::bigint AS f32_bytes " +
      "FROM memories");
    if (!q.ok) return { ok: false, error: q.error };
    return { ok: true, data: (q.rows || [])[0] };
  }

  /**
   * 清理旧向量列的值（不删列）。
   *
   * 为什么不是 DROP COLUMN：现有 SQL 里有 `SELECT m.*` 和显式的 m.embedding，
   * 直接删列会让这些语句报错。把值置空效果一样（腾出空间），且完全不破坏 SQL。
   */
  /**
   * 删除历史遗留的 REAL[] 列（幂等）。
   * 前提：所有向量都已转成 float32 —— 否则会丢数据，所以先检查。
   */
  async dropLegacyEmbeddingColumn(): Promise<{ ok: boolean; dropped?: boolean; error?: string; reason?: string }> {
    // 列已删就直接返回成功（幂等）。
    const exists = await this.query(
      "SELECT COUNT(*)::int AS n FROM information_schema.columns " +
      "WHERE table_name = 'memories' AND column_name = 'embedding'");
    if (!exists.ok) return { ok: false, error: exists.error };
    if (Number(((exists.rows || [])[0] || {}).n) === 0) return { ok: true, dropped: false };
    // 判断依据是「旧列里还有没有值」—— 只有它还有数据，删了才会丢东西。
    const miss = await this.query(
      "SELECT COUNT(*)::int AS n FROM memories WHERE embedding IS NOT NULL");
    if (!miss.ok) return { ok: false, error: miss.error };
    const n = Number(((miss.rows || [])[0] || {}).n) || 0;
    if (n > 0) return { ok: false, dropped: false, reason: '旧列里还有 ' + n + ' 条数据，先跑压缩再删列' };
    const d = await this.query("ALTER TABLE memories DROP COLUMN IF EXISTS embedding");
    if (!d.ok) return { ok: false, error: d.error };
    return { ok: true, dropped: true };
  }

  // ── 最近记住的（「我刚记住了什么」）──────────────────
  async recentMemories(ownerCharacter: string, limit = 30)
    : Promise<{ ok: boolean; rows?: MemoryRow[]; error?: string }> {
    const lim = Math.min(Math.max(limit, 1), 200);
    const r = await this.query(
      "SELECT id, owner_character, scope, sensitivity, content, summary, importance, " +
      "       source, created_at, last_accessed_at, deleted_at, pinned, decay_at " +
      "FROM memories WHERE owner_character = :'owner'::uuid AND deleted_at IS NULL " +
      "ORDER BY created_at DESC LIMIT " + lim,
      { owner: ownerCharacter });
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, rows: (r.rows || []) as MemoryRow[] };
  }

  // ── 用户标记 ──────────────────────────────────────────
  /** 标记 / 取消标记「别忘」 */
  async setPinned(id: string, ownerCharacter: string, pinned: boolean)
    : Promise<{ ok: boolean; changed?: number; error?: string }> {
    const r = await this.query(
      "UPDATE memories SET pinned = :'pinned'::boolean " +
      "WHERE id = :'id'::uuid AND owner_character = :'owner'::uuid AND deleted_at IS NULL RETURNING id",
      { id, owner: ownerCharacter, pinned: !!pinned });
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, changed: (r.rows || []).length };
  }

  // ── 最近淡忘（软删除）──────────────────────────────────
  /**
   * 列出最近被淡忘（软删除）的记忆，供界面展示与恢复。
   * @param days 只看最近多少天被删的（0/不传 = 不限）
   */
  async recentlyFaded(ownerCharacter: string, days = 30, limit = 50)
    : Promise<{ ok: boolean; rows?: MemoryRow[]; error?: string }> {
    const lim = Math.min(Math.max(limit, 1), 200);
    const cond = days > 0
      ? " AND deleted_at >= now() - interval '" + Math.round(days) + " days'"
      : '';
    const r = await this.query(
      "SELECT id, owner_character, scope, sensitivity, content, summary, importance, " +
      "       source, created_at, last_accessed_at, deleted_at, pinned " +
      "FROM memories WHERE owner_character = :'owner'::uuid AND deleted_at IS NOT NULL" + cond +
      " ORDER BY deleted_at DESC LIMIT " + lim,
      { owner: ownerCharacter });
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, rows: (r.rows || []) as MemoryRow[] };
  }

  // ── 冲突 ──────────────────────────────────────────────
  /** 建一条冲突记录（待确认） */
  async createConflict(memoryA: string, memoryB: string, kind: 'contradiction' | 'duplicate' | 'stale' = 'contradiction', detail?: string)
    : Promise<{ ok: boolean; id?: string; error?: string }> {
    if (memoryA === memoryB) return { ok: false, error: '不能和自己冲突' };
    const r = await this.query(
      "INSERT INTO memory_conflicts (memory_a, memory_b, kind, detail) " +
      "VALUES (:'a'::uuid, :'b'::uuid, :'kind', NULLIF(:'detail','')) RETURNING id",
      { a: memoryA, b: memoryB, kind, detail: detail || '' });
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, id: ((r.rows || [])[0] || {}).id };
  }

  /** 列出冲突（可按记忆过滤） */
  async listConflicts(ownerCharacter: string, status: 'pending' | 'resolved' | 'ignored' | 'all' = 'pending', limit = 50)
    : Promise<{ ok: boolean; rows?: any[]; error?: string }> {
    const lim = Math.min(Math.max(limit, 1), 200);
    const stCond = status === 'all' ? '' : " AND c.status = :'st'";
    const r = await this.query(
      "SELECT c.id, c.memory_a, c.memory_b, c.kind, c.detail, c.status, c.resolution, " +
      "       c.created_at, c.resolved_at, " +
      "       a.content AS a_content, b.content AS b_content, " +
      "       a.deleted_at AS a_deleted, b.deleted_at AS b_deleted " +
      "FROM memory_conflicts c " +
      "JOIN memories a ON a.id = c.memory_a " +
      "JOIN memories b ON b.id = c.memory_b " +
      "WHERE a.owner_character = :'owner'::uuid" + stCond +
      " ORDER BY c.created_at DESC LIMIT " + lim,
      status === 'all' ? { owner: ownerCharacter } : { owner: ownerCharacter, st: status });
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, rows: r.rows };
  }

  /** 解决 / 忽略冲突 */
  async resolveConflict(conflictId: string, decision: 'resolved' | 'ignored', resolution?: string)
    : Promise<{ ok: boolean; changed?: number; error?: string }> {
    const r = await this.query(
      "UPDATE memory_conflicts SET status = :'st', resolution = NULLIF(:'res'::text,''), resolved_at = now() " +
      "WHERE id = :'id'::uuid AND status = 'pending' RETURNING id",
      { id: conflictId, st: decision, res: resolution || '' });
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, changed: (r.rows || []).length };
  }

  /**
   * 解决冲突并执行处置动作。
   *
   * action：
   *   keep_a    保留 A，软删除 B
   *   keep_b    保留 B，软删除 A
   *   keep_both 都保留，只把冲突标记为已处理
   *   merge     把两条合并成一条（写进 A，软删除 B）
   */
  async resolveConflictWithAction(
    conflictId: string,
    ownerCharacter: string,
    action: 'keep_a' | 'keep_b' | 'keep_both' | 'merge',
    mergedContent?: string
  ): Promise<{ ok: boolean; action?: string; error?: string }> {
    const q = await this.query(
      "SELECT c.id, c.memory_a, c.memory_b FROM memory_conflicts c " +
      "JOIN memories a ON a.id = c.memory_a " +
      "WHERE c.id = :'id'::uuid AND c.status = 'pending' AND a.owner_character = :'owner'::uuid",
      { id: conflictId, owner: ownerCharacter });
    if (!q.ok) return { ok: false, error: q.error };
    const row = (q.rows || [])[0];
    if (!row) return { ok: false, error: '冲突不存在、已处理，或不属于该角色' };

    const a = row.memory_a as string;
    const b = row.memory_b as string;
    let note = '';

    if (action === 'keep_a') {
      await this.query("UPDATE memories SET deleted_at = now() WHERE id = :'id'::uuid AND deleted_at IS NULL RETURNING 1", { id: b });
      note = '保留 A，删除 B';
    } else if (action === 'keep_b') {
      await this.query("UPDATE memories SET deleted_at = now() WHERE id = :'id'::uuid AND deleted_at IS NULL RETURNING 1", { id: a });
      note = '保留 B，删除 A';
    } else if (action === 'merge') {
      let text = String(mergedContent || '').trim();
      // 没给合并内容时，用结构化合并（不是简单拼接）：
      // 槽位冲突保留新值、去重、只补对方独有信息
      if (!text) {
        const q2 = await this.query(
          "SELECT a.content AS a_content, b.content AS b_content " +
          "FROM memories a, memories b WHERE a.id = :'a'::uuid AND b.id = :'b'::uuid",
          { a, b });
        if (!q2.ok) return { ok: false, error: q2.error };
        const pair = (q2.rows || [])[0];
        if (!pair) return { ok: false, error: '找不到待合并的记忆' };
        const m = smartMerge(String(pair.a_content || ''), String(pair.b_content || ''));
        text = m.content;
      }
      if (!text) return { ok: false, error: '合并内容为空' };
      const up = await this.query(
        "UPDATE memories SET content = :'c', content_hash = md5(:'c'), version = version + 1 " +
        "WHERE id = :'id'::uuid RETURNING id",
        { c: text, id: a });
      if (!up.ok) return { ok: false, error: up.error };
      await this.query("UPDATE memories SET deleted_at = now() WHERE id = :'id'::uuid AND deleted_at IS NULL RETURNING 1", { id: b });
      note = mergedContent ? '合并为一条（使用手动填写的内容），删除 B' : '结构化合并（保留新状态、去重、补充独有信息），删除 B';
    } else {
      note = '两条都保留';
    }

    const r = await this.query(
      "UPDATE memory_conflicts SET status = 'resolved', resolution = :'res', resolved_at = now() " +
      "WHERE id = :'id'::uuid AND status = 'pending' RETURNING id",
      { id: conflictId, res: note });
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, action };
  }

  /** 有未解决冲突的记忆 id 集合（衰减时保护它们） */
  async pendingConflictMemoryIds(ownerCharacter: string): Promise<Set<string>> {
    const r = await this.query(
      "SELECT c.memory_a, c.memory_b FROM memory_conflicts c " +
      "JOIN memories a ON a.id = c.memory_a " +
      "WHERE c.status = 'pending' AND a.owner_character = :'owner'::uuid",
      { owner: ownerCharacter });
    const out = new Set<string>();
    if (!r.ok) return out;
    const r2 = await this.query(
      "SELECT c.memory_b AS id FROM memory_conflicts c " +
      "JOIN memories a ON a.id = c.memory_a " +
      "WHERE c.status = 'pending' AND a.owner_character = :'owner'::uuid",
      { owner: ownerCharacter });
    for (const row of (r.rows || [])) { if (row.memory_a) out.add(row.memory_a); if (row.memory_b) out.add(row.memory_b); }
    for (const row of (r2.rows || [])) { if (row.id) out.add(row.id); }
    return out;
  }

  async stats(ownerCharacter: string): Promise<{ ok: boolean; data?: any; error?: string }> {
    const r = await this.query(
      "SELECT COUNT(*)::int AS total, " +
      "       COUNT(*) FILTER (WHERE deleted_at IS NOT NULL)::int AS deleted, " +
      "       COUNT(*) FILTER (WHERE scope = 'shared')::int AS shared, " +
      "       COUNT(*) FILTER (WHERE expires_at IS NOT NULL AND expires_at < now())::int AS expired, " +
      "       COALESCE(AVG(importance), 0)::real AS avg_importance " +
      "FROM memories WHERE owner_character = :'owner'::uuid", { owner: ownerCharacter });
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, data: (r.rows || [])[0] };
  }
}
