/*
 * SoulWeave S6：主动行为的三重闸门
 *
 * 依据：01 需求 6.4「规则+AI 决策的主动行为，受免打扰、预算、权限、平台频率限制约束」
 *      路线图 S6 验收标准「时间窗/频率/预算可控」
 *
 * 【三重闸门】
 *   第一重：时间窗 —— 当前时段允许主动吗？免打扰？
 *   第二重：频率   —— 今天主动几次？距上次多久？
 *   第三重：预算   —— Token/费用超限了吗？
 *
 * 三重都过才允许。任何一重不过都返回明确原因（给 UI 显示）。
 */

// ─── 类型 ───────────────────────────────────────────

export type ProactiveKind = 'private_chat' | 'diary' | 'album' | 'share';

export interface TimeWindow {
  /** 允许主动的时段，分钟。空数组 = 不限制 */
  ranges: Array<{ startMinute: number; endMinute: number }>;
  /** 免打扰时段（优先级最高），分钟 */
  quietRanges: Array<{ startMinute: number; endMinute: number }>;
  /** 允许的星期（位掩码）。127 = 每天 */
  daysMask: number;
}

export interface FrequencyLimit {
  /** 同一会话最小间隔（秒） */
  cooldownSeconds: number;
  /** 每天最多主动次数 */
  dailyMax: number;
  /** 每小时的软上限（防止集中轰炸） */
  hourlyMax: number;
}

export interface BudgetLimit {
  /** 每天最多主动轮次（AI 调用次数） */
  dailyMaxRounds: number;
  /** 每天最多 Token */
  dailyMaxTokens: number;
  /** 每天最多估算费用（元） */
  dailyMaxCost: number;
}

export interface UsageState {
  day: string;              // YYYY-MM-DD
  kind: ProactiveKind;
  count: number;
  rounds: number;
  tokens: number;
  cost: number;
  lastAt: number | null;    // 毫秒时间戳
  /** 本小时已用次数 */
  hourCount: number;
  hourKey: string;          // YYYY-MM-DD-HH
}

export interface GateResult {
  ok: boolean;
  /** 被哪一重挡住 */
  blockedBy?: 'time' | 'frequency' | 'budget';
  /** 给用户看的原因 */
  reason?: string;
  /** 建议重试时间（毫秒时间戳），可能为空 */
  retryAt?: number;
}

// ─── 默认值 ─────────────────────────────────────────

export const DEFAULT_TIME_WINDOW: TimeWindow = {
  // 默认全天允许（用户可收窄）
  ranges: [],
  // 默认免打扰 23:00-08:00
  quietRanges: [{ startMinute: 23 * 60, endMinute: 8 * 60 }],
  daysMask: 127,
};

export const DEFAULT_FREQUENCY: FrequencyLimit = {
  cooldownSeconds: 1800,   // 同一会话 30 分钟
  dailyMax: 12,            // 每天最多 12 次主动
  hourlyMax: 3,            // 每小时最多 3 次
};

export const DEFAULT_BUDGET: BudgetLimit = {
  dailyMaxRounds: 30,
  dailyMaxTokens: 200000,
  dailyMaxCost: 2.0,       // 2 元
};

// ─── 工具 ───────────────────────────────────────────

function minuteOf(d: Date): number { return d.getHours() * 60 + d.getMinutes(); }

function inRange(minute: number, start: number, end: number): boolean {
  if (end > start) return minute >= start && minute < end;
  if (end < start) return minute >= start || minute < end;  // 跨午夜
  return true;  // 0 长度 = 全天
}

function weekdayBit(d: Date): number {
  const js = d.getDay();
  return js === 0 ? 6 : js - 1;
}

export function dayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + dd;
}

export function hourKey(d: Date): string {
  return dayKey(d) + '-' + String(d.getHours()).padStart(2, '0');
}

export function emptyUsage(now: Date, kind: ProactiveKind): UsageState {
  return {
    day: dayKey(now),
    kind,
    count: 0,
    rounds: 0,
    tokens: 0,
    cost: 0,
    lastAt: null,
    hourCount: 0,
    hourKey: hourKey(now),
  };
}

/** 把跨天的 usage 归零（保留 hourCount 如果还是同一小时） */
export function rollUsage(u: UsageState, now: Date, kind: ProactiveKind): UsageState {
  const dk = dayKey(now);
  const hk = hourKey(now);
  if (u.day !== dk) {
    return {
      day: dk, kind,
      count: 0, rounds: 0, tokens: 0, cost: 0,
      lastAt: u.lastAt,   // 保留 lastAt，跨天冷却仍然有效
      hourCount: u.hourKey === hk ? u.hourCount : 0,
      hourKey: hk,
    };
  }
  if (u.hourKey !== hk) {
    return { ...u, hourCount: 0, hourKey: hk };
  }
  return { ...u, kind };
}

// ─── 三重闸门 ───────────────────────────────────────

export interface GateInput {
  now: Date;
  window: TimeWindow;
  frequency: FrequencyLimit;
  budget: BudgetLimit;
  usage: UsageState;
  /** 本次预计消耗（可选，用于预算预判） */
  estimatedTokens?: number;
  estimatedCost?: number;
}

/**
 * 依次检查三重闸门。
 *
 * 顺序很重要：时间窗最先（最便宜），预算最后（最贵）。
 * 这样能避免在免打扰时段还去查数据库算 Token。
 */
export function checkGates(input: GateInput): GateResult {
  const now = input.now;
  const minute = minuteOf(now);

  // ── 第一重：时间窗 ──
  // 免打扰优先
  for (const q of input.window.quietRanges || []) {
    if (inRange(minute, q.startMinute, q.endMinute)) {
      const retry = nextMinuteTime(now, q.endMinute);
      return {
        ok: false, blockedBy: 'time',
        reason: '免打扰时段（至 ' + fmtMin(q.endMinute) + '）',
        retryAt: retry,
      };
    }
  }
  // 星期限制
  const bit = weekdayBit(now);
  if ((input.window.daysMask & (1 << bit)) === 0) {
    return { ok: false, blockedBy: 'time', reason: '今天不允许主动行为' };
  }
  // 允许时段（空 = 不限）
  const ranges = input.window.ranges || [];
  if (ranges.length > 0) {
    const hit = ranges.some((r) => inRange(minute, r.startMinute, r.endMinute));
    if (!hit) {
      return { ok: false, blockedBy: 'time', reason: '不在允许的主动时段内' };
    }
  }

  // ── 第二重：频率 ──
  const u = input.usage;
  if (u.count >= input.frequency.dailyMax) {
    return {
      ok: false, blockedBy: 'frequency',
      reason: '今日主动次数已达上限 (' + u.count + '/' + input.frequency.dailyMax + ')',
    };
  }
  if (u.hourCount >= input.frequency.hourlyMax) {
    return {
      ok: false, blockedBy: 'frequency',
      reason: '本小时主动次数已达上限 (' + u.hourCount + '/' + input.frequency.hourlyMax + ')',
    };
  }
  if (u.lastAt != null && input.frequency.cooldownSeconds > 0) {
    const elapsed = now.getTime() - u.lastAt;
    const need = input.frequency.cooldownSeconds * 1000;
    if (elapsed < need) {
      const left = Math.ceil((need - elapsed) / 1000);
      return {
        ok: false, blockedBy: 'frequency',
        reason: '冷却中，还需 ' + left + ' 秒',
        retryAt: u.lastAt + need,
      };
    }
  }

  // ── 第三重：预算 ──
  if (u.rounds >= input.budget.dailyMaxRounds) {
    return {
      ok: false, blockedBy: 'budget',
      reason: '今日主动轮次已达上限 (' + u.rounds + '/' + input.budget.dailyMaxRounds + ')',
    };
  }
  const estTok = Number(input.estimatedTokens) || 0;
  if (u.tokens + estTok > input.budget.dailyMaxTokens) {
    return {
      ok: false, blockedBy: 'budget',
      reason: '今日 Token 预算不足（已用 ' + u.tokens + '，上限 ' + input.budget.dailyMaxTokens + '）',
    };
  }
  const estCost = Number(input.estimatedCost) || 0;
  if (u.cost + estCost > input.budget.dailyMaxCost) {
    return {
      ok: false, blockedBy: 'budget',
      reason: '今日费用预算不足（已用 ¥' + u.cost.toFixed(2) + '，上限 ¥' + input.budget.dailyMaxCost.toFixed(2) + '）',
    };
  }

  return { ok: true };
}

/** 记录一次成功的主动行为 */
export function commitUsage(
  u: UsageState,
  now: Date,
  kind: ProactiveKind,
  opts?: { rounds?: number; tokens?: number; cost?: number },
): UsageState {
  const rolled = rollUsage(u, now, kind);
  return {
    ...rolled,
    count: rolled.count + 1,
    hourCount: rolled.hourCount + 1,
    rounds: rolled.rounds + (Number(opts?.rounds) || 1),
    tokens: rolled.tokens + (Number(opts?.tokens) || 0),
    cost: rolled.cost + (Number(opts?.cost) || 0),
    lastAt: now.getTime(),
  };
}

// ─── 辅助 ───────────────────────────────────────────

function fmtMin(m: number): string {
  const v = ((m % 1440) + 1440) % 1440;
  return String(Math.floor(v / 60)).padStart(2, '0') + ':' + String(v % 60).padStart(2, '0');
}

/** 从 now 推到下一个 targetMinute 的时间戳 */
function nextMinuteTime(now: Date, targetMinute: number): number {
  const d = new Date(now.getTime());
  d.setHours(Math.floor(targetMinute / 60), targetMinute % 60, 0, 0);
  if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
  return d.getTime();
}
