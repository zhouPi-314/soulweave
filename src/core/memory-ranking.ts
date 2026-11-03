/**
 * SoulWeave S4：混合检索评分
 *
 * **算法来源（如实标注）**：Mem0 开源项目
 *   - mem0/utils/scoring.py  score_and_rank / get_bm25_params / normalize_bm25
 *   - mem0/memory/main.py    _search_vector_store（过取 top_k*4、实体加成上限 0.5）
 *
 * 我们没有照抄代码，而是复刻它的**数学结构**：
 *   1. 语义分数先过阈值（语义不过关的，关键词再强也不救）
 *   2. 关键词分数用 logistic sigmoid 归一到 [0,1]（BM25 原始分无界）
 *   3. 三路信号相加后除以「理论最大值」，再裁到 1.0
 *
 * 为什么需要它：纯余弦对专名（小明/杭州/3年级2班）很弱 ——
 * 向量把「杭州」和「上海」放在很近的位置，但对「杭州」这个词本身不敏感。
 * 关键词通道补的正是这个短板。
 */

/** 关键词分数的权重上限（Mem0 用 0.5） */
export const ENTITY_BOOST_WEIGHT = 0.5;

/** 关键词通道在总分母里的权重（Mem0 给满 1.0） */
export const KEYWORD_WEIGHT = 1.0;

/**
 * 按查询词数返回 sigmoid 参数（照搬 Mem0 的表）。
 * 词越多，原始 BM25 分越高，所以中点和陡度要跟着调。
 */
export function bm25Params(termCount: number): { midpoint: number; steepness: number } {
  const n = Math.max(1, termCount | 0);
  if (n <= 3) return { midpoint: 5.0, steepness: 0.7 };
  if (n <= 6) return { midpoint: 7.0, steepness: 0.6 };
  if (n <= 9) return { midpoint: 9.0, steepness: 0.5 };
  if (n <= 15) return { midpoint: 10.0, steepness: 0.5 };
  return { midpoint: 12.0, steepness: 0.5 };
}

/** logistic sigmoid：把无界的 BM25 原始分压到 [0,1] */
export function normalizeBm25(rawScore: number, midpoint: number, steepness: number): number {
  if (!Number.isFinite(rawScore)) return 0;
  const z = -steepness * (rawScore - midpoint);
  // 防止 exp 溢出
  if (z > 700) return 0;
  if (z < -700) return 1;
  return 1 / (1 + Math.exp(z));
}

/**
 * 中文分词（够用就好）：
 *   - CJK 连续段切成 2 字 bigram（中文检索的常规做法）
 *   - 只有 1 个字时保留单字
 *   - 拉丁字母/数字按词切，转小写
 */
export function tokenizeForKeyword(text: string): string[] {
  const s = String(text || '').toLowerCase();
  const out: string[] = [];
  const re = /[\u4e00-\u9fa5]+|[a-z0-9_]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const tok = m[0];
    if (/^[a-z0-9_]/.test(tok)) { out.push(tok); continue; }
    if (tok.length === 1) { out.push(tok); continue; }
    for (let i = 0; i + 2 <= tok.length; i++) out.push(tok.slice(i, i + 2));
  }
  return [...new Set(out)];
}

/**
 * 在一个文档集合上算 BM25 相关分。
 *
 * 注意：我们的候选集是「SQL 关键词命中集」，不是全库 ——
 * 所以 IDF 用 N = 范围内的总条数（由调用方传入）近似，
 * 不是严格的全语料 IDF。这一点在文档里说清楚，不假装精确。
 */
export function bm25Raw(
  queryTokens: string[],
  docs: Array<{ id: string; content: string }>,
  corpusSize: number,
): Map<string, number> {
  const out = new Map<string, number>();
  if (!queryTokens.length || !docs.length) return out;

  const k1 = 1.5;
  const b = 0.75;
  const N = Math.max(docs.length, corpusSize || docs.length);

  const tokenized = docs.map((d) => ({
    id: d.id,
    toks: tokenizeForKeyword(d.content),
  }));
  const avgLen = tokenized.reduce((a, t) => a + t.toks.length, 0) / Math.max(1, tokenized.length) || 1;

  for (const qt of queryTokens) {
    // df：包含该词元的文档数
    let df = 0;
    for (const d of tokenized) if (d.toks.indexOf(qt) >= 0) df++;
    if (df === 0) continue;
    const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));

    for (const d of tokenized) {
      let tf = 0;
      for (const t of d.toks) if (t === qt) tf++;
      if (!tf) continue;
      const norm = tf * (k1 + 1) / (tf + k1 * (1 - b + b * (d.toks.length / avgLen)));
      out.set(d.id, (out.get(d.id) || 0) + idf * norm);
    }
  }
  return out;
}

/**
 * BM25，但 df 由外部提供（全局 df）。
 *
 * 这是修正「本地 IDF」的做法：上一版只用候选集里的 df，
 * 候选集本身是关键词命中的子集，df 会被系统性低估 —— 常见词被当成罕见词，
 * 权重被放大。用全库 df 后才是标准 BM25。
 *
 * @param dfArr 每个查询词元在**全库**中包含它的文档数（与 tokens 顺序一致）
 * @param corpusSize 全库（限本角色范围）文档总数
 */
export function bm25RawGlobal(
  tokens: string[],
  docs: Array<{ id: string; content: string }>,
  dfArr: number[],
  corpusSize: number,
): Map<string, number> {
  const out = new Map<string, number>();
  if (!tokens.length || !docs.length) return out;

  const k1 = 1.5;
  const b = 0.75;
  const N = Math.max(1, corpusSize || docs.length);

  const tokenized = docs.map((d) => ({ id: d.id, toks: tokenizeForKeyword(d.content) }));
  const avgLen = tokenized.reduce((a, t) => a + t.toks.length, 0) / Math.max(1, tokenized.length) || 1;

  for (let i = 0; i < tokens.length; i++) {
    const qt = tokens[i];
    const df = Math.max(0, Number(dfArr[i]) || 0);
    if (df === 0) continue;
    // 标准 BM25 IDF（加 1 保证非负）
    const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));

    for (const d of tokenized) {
      let tf = 0;
      for (const t of d.toks) if (t === qt) tf++;
      if (!tf) continue;
      const norm = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (d.toks.length / avgLen)));
      out.set(d.id, (out.get(d.id) || 0) + idf * norm);
    }
  }
  return out;
}

export interface FuseInput {
  /** 语义相似度（余弦），作为主信号 */
  semantic: number;
  /** 归一化到 [0,1] 的关键词分 */
  keyword?: number;
  /** 归一化到 [0,1] 的实体/关联加成 */
  boost?: number;
  /** 语义阈值：低于它直接被排除，关键词再强也不救 */
  threshold: number;
  /**
   * 全局信号开关。**必须由调用方按整批候选算好再传**。
   *
   * 为什么不能按单条自动判断：Mem0 的 max_possible 是看「这一批里
   * 有没有关键词/加成信号」，整批共用一个分母。
   * 如果逐条判断，有关键词的那条会被除以 2、没有的除以 1，
   * 分数就不可比了（实测会把关键词命中的条目排到后面）。
   */
  signals?: { keyword: boolean; boost: boolean };
}

/** 单条融合：完全按 Mem0 的加法 + 自适应分母 */
export function fuseScore(input: FuseInput): { ok: boolean; score: number; detail?: any } {
  const semantic = Number(input.semantic) || 0;
  const kw = Math.max(0, Math.min(1, Number(input.keyword) || 0));
  const boost = Math.max(0, Math.min(ENTITY_BOOST_WEIGHT, Number(input.boost) || 0));

  // 阈值卡在融合之前 —— 这是 Mem0 的关键设计，照做
  if (semantic < input.threshold) return { ok: false, score: 0 };

  // 优先用调用方给的全局信号；没给才退回逐条判断（单条调用场景）
  const hasKw = input.signals ? input.signals.keyword : kw > 0;
  const hasBoost = input.signals ? input.signals.boost : boost > 0;
  let maxPossible = 1.0;
  if (hasKw) maxPossible += KEYWORD_WEIGHT;
  if (hasBoost) maxPossible += ENTITY_BOOST_WEIGHT;

  const rawCombined = semantic + (hasKw ? kw * KEYWORD_WEIGHT : 0) + boost;
  const score = Math.min(rawCombined / maxPossible, 1.0);

  return {
    ok: true,
    score,
    detail: { semantic, keyword: kw, boost, maxPossible, rawCombined },
  };
}

/** 批量融合 + 排序（对应 Mem0 的 score_and_rank） */
export function scoreAndRank<T extends { id: string }>(
  items: T[],
  getSemantic: (x: T) => number,
  keywordScores: Map<string, number>,
  boostScores: Map<string, number>,
  threshold: number,
  topK: number,
): Array<T & { fusedScore: number }> {
  const out: Array<T & { fusedScore: number }> = [];
  // 全局信号：整批共用同一个分母（对齐 Mem0 的 has_bm25 / has_entity）
  const signals = { keyword: keywordScores.size > 0, boost: boostScores.size > 0 };
  for (const it of items) {
    const r = fuseScore({
      semantic: getSemantic(it),
      keyword: keywordScores.get(it.id) || 0,
      boost: boostScores.get(it.id) || 0,
      threshold,
      signals,
    });
    if (!r.ok) continue;
    out.push({ ...it, fusedScore: r.score } as T & { fusedScore: number });
  }
  out.sort((a, b) => (b.fusedScore - a.fusedScore) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  return out.slice(0, Math.max(1, topK));
}
