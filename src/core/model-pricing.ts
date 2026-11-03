/**
 * SoulWeave：模型定价与费用换算
 *
 * 【价格来源】DeepSeek 官方文档（2026-10-29 抓取）：
 *   https://api-docs.deepseek.com/quick_start/pricing
 *
 * 单价单位：**美元 / 100 万 token**，且为**高峰价**；
 * 官方说明「低谷价是高峰价的一半」，高峰时段为
 *   UTC 01:00–04:00 与 06:00–10:00（周一至周五，排除中国法定节假日）。
 *
 * | 模型 | 缓存命中 | 缓存未命中 | 输出 |
 * |---|---|---|---|
 * | deepseek-flash | 0.006 | 0.3 | 1.2 |
 * | deepseek-v4-pro | 0.044 | 1.32 | 3.96 |
 *
 * ⚠️ **已知限制**
 * 1. 中国法定节假日无法自动识别 —— 节假日当天会被当工作日算（价格偏高）。
 * 2. 汇率不是官方数据，是用户可改的配置项，默认 7.2。
 * 3. 本模块只做「估算」，用于预算闸门；**不能当作账单**。
 */

export interface ModelRates {
  /** 缓存命中的输入单价（USD / 1M token），高峰价 */
  cacheHit: number;
  /** 缓存未命中的输入单价（USD / 1M token），高峰价 */
  cacheMiss: number;
  /** 输出单价（USD / 1M token），高峰价 */
  output: number;
}

/** 高峰价（官方表） */
export const PEAK_RATES: Record<string, ModelRates> = {
  'deepseek-flash': { cacheHit: 0.006, cacheMiss: 0.3, output: 1.2 },
  'deepseek-v4-pro': { cacheHit: 0.044, cacheMiss: 1.32, output: 3.96 },
};

/** 取得某模型的高峰单价；未知模型回落到 flash */
export function ratesFor(model: string): ModelRates {
  const key = String(model || '').trim().toLowerCase();
  if (PEAK_RATES[key]) return PEAK_RATES[key];
  // 兼容：deepseek-v4-flash / deepseek-v4.1-flash-free 等都按 flash 计价
  if (key.includes('pro')) return PEAK_RATES['deepseek-v4-pro'];
  return PEAK_RATES['deepseek-flash'];
}

/**
 * 是否处于高峰时段。
 * 官方：UTC 01:00–04:00 与 06:00–10:00，周一至周五，排除中国法定节假日。
 * 节假日无法识别，这里只按「工作日 + 时段」判定 —— 会高估价格（保守方向）。
 */
export function isPeak(now: Date = new Date()): boolean {
  const dow = now.getUTCDay();          // 0=周日, 6=周六
  if (dow === 0 || dow === 6) return false;
  const h = now.getUTCHours();
  return (h >= 1 && h < 4) || (h >= 6 && h < 10);
}

/** 当前适用费率（高峰 ×1，低谷 ×0.5） */
export function currentRates(model: string, now: Date = new Date()): ModelRates {
  const base = ratesFor(model);
  const f = isPeak(now) ? 1 : 0.5;
  return {
    cacheHit: base.cacheHit * f,
    cacheMiss: base.cacheMiss * f,
    output: base.output * f,
  };
}

export interface UsageSplit {
  /** 缓存未命中的输入 token */
  missInput: number;
  /** 缓存命中的输入 token */
  hitInput: number;
  /** 输出 token */
  output: number;
}

export interface CostResult {
  /** 美元 */
  usd: number;
  /** 人民币（按给定汇率） */
  cny: number;
  /** 是否高峰 */
  peak: boolean;
  /** 使用的费率快照，便于审计 */
  rates: ModelRates;
}

/**
 * 按用量算一笔费用。
 * 三段分别计价：缓存命中输入、缓存未命中输入、输出。
 */
export function computeCost(u: UsageSplit, model: string, usdToCny: number, now: Date = new Date()): CostResult {
  const rates = currentRates(model, now);
  const miss = Math.max(0, Number(u.missInput) || 0);
  const hit = Math.max(0, Number(u.hitInput) || 0);
  const out = Math.max(0, Number(u.output) || 0);
  const usd =
    (miss / 1e6) * rates.cacheMiss +
    (hit / 1e6) * rates.cacheHit +
    (out / 1e6) * rates.output;
  const rate = Number(usdToCny) > 0 ? Number(usdToCny) : 7.2;
  return { usd, cny: usd * rate, peak: isPeak(now), rates };
}

/**
 * 把两种 usage 形状归一到 UsageSplit。
 *   DSH：inputTokens = 未命中，cacheReadTokens = 命中，outputTokens = 输出
 *   网关：prompt_tokens 含缓存，需减去 cached_tokens
 */
export function normalizeUsage(u: any): UsageSplit | null {
  if (!u || typeof u !== 'object') return null;
  // 已经归一过的形状（agent-session 返回的 AgentUsage：input/output/cacheRead）
  if (u.input != null || u.cacheRead != null || u.output != null) {
    return {
      missInput: Number(u.input || 0),
      hitInput: Number(u.cacheRead || 0),
      output: Number(u.output || 0),
    };
  }
  // DSH 原始形状
  if (u.inputTokens != null || u.cacheReadTokens != null) {
    return {
      missInput: Number(u.inputTokens || 0),
      hitInput: Number(u.cacheReadTokens || 0),
      output: Number(u.outputTokens || 0),
    };
  }
  // 网关（OpenAI 兼容）形状
  if (u.prompt_tokens != null || u.completion_tokens != null) {
    const prompt = Number(u.prompt_tokens || 0);
    const cached = Number((u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || u.cache_read_tokens || 0);
    return {
      missInput: Math.max(0, prompt - cached),
      hitInput: cached,
      output: Number(u.completion_tokens || 0),
    };
  }
  return null;
}
