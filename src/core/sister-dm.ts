/**
 * SoulWeave S11：姐妹私聊（角色之间互发 QQ 私聊）
 *
 * 【需求】
 * D23：默认仅群聊，Desktop 可选开启「姐妹间完整社交」。S11 的"私聊"就是这一段。
 *
 * 【为什么必须防回环】
 * 两个角色各自绑一个 QQ 号。A 发一条 → B 的收到事件触发 B 自动回复 → A 又收到 → A 再回……
 * 这不是"两个 AI 聊天很有趣"，这是无限循环 + 账号风控 + 花钱。
 *
 * 抵挡手段有三层，缺一不可：
 *   1. 链路深度：一条消息最多再引发 N 次自动回复（默认 1），超过必须等人类介入；
 *   2. AI 标记：我们自己发的消息带 AI 标记，收到带标记的消息**不自动回**；
 *   3. 频率：每小时/每天上限 + 最小间隔。
 *
 * 本文件只管第 1、3 层（纯逻辑、可测）；第 2 层由调用方用 qq-autonomous 的
 * markAiOrigin / isAiOrigin 判定。
 */

export type DmPolicy = {
  /** 默认关闭：不开启就不发任何私聊 */
  enabled: boolean;
  /** 每小时最多几条 */
  maxPerHour: number;
  /** 每天最多几条 */
  maxPerDay: number;
  /** 两条之间最小间隔（分钟） */
  minIntervalMin: number;
  /** 一条消息最多再引发几次自动回复（防回环的核心参数） */
  maxChainDepth: number;
};

export const DEFAULT_DM_POLICY: DmPolicy = {
  enabled: false,
  maxPerHour: 4,
  maxPerDay: 20,
  minIntervalMin: 5,
  maxChainDepth: 1,
};

/** 链路深度硬顶：无论策略怎么写，都不允许超过 3 层 */
export const HARD_MAX_CHAIN_DEPTH = 3;

export type DmUsage = {
  hourKey: string;
  hourCount: number;
  dayKey: string;
  dayCount: number;
  lastAt: number;
};

export const EMPTY_DM_USAGE: DmUsage = { hourKey: '', hourCount: 0, dayKey: '', dayCount: 0, lastAt: 0 };

export function hourKeyOf(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours());
}

export function dayKeyOf(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

export function validateDmPolicy(p: Partial<DmPolicy>): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (p.maxPerHour !== undefined && (!Number.isInteger(p.maxPerHour) || p.maxPerHour < 0 || p.maxPerHour > 60)) {
    errors.push('每小时上限需为 0–60');
  }
  if (p.maxPerDay !== undefined && (!Number.isInteger(p.maxPerDay) || p.maxPerDay < 0 || p.maxPerDay > 200)) {
    errors.push('每天上限需为 0–200');
  }
  if (p.minIntervalMin !== undefined && (!Number.isInteger(p.minIntervalMin) || p.minIntervalMin < 0 || p.minIntervalMin > 1440)) {
    errors.push('最小间隔需为 0–1440 分钟');
  }
  if (p.maxChainDepth !== undefined && (!Number.isInteger(p.maxChainDepth) || p.maxChainDepth < 0 || p.maxChainDepth > HARD_MAX_CHAIN_DEPTH)) {
    errors.push('链路深度需为 0–' + HARD_MAX_CHAIN_DEPTH);
  }
  return { ok: errors.length === 0, errors };
}

export type DmCheck =
  | { ok: true }
  | { ok: false; code: string; reason: string };

/**
 * 能不能发这条私聊。
 * @param depth 这条消息处在第几层（0 = 用户手动点出来的，1 = 由一条消息自动引发，…）
 */
export function checkDm(
  policy: DmPolicy,
  usage: DmUsage,
  input: { now: number; depth?: number; fromSelfId?: string | null; toSelfId?: string | null; text?: string }
): DmCheck {
  if (!policy.enabled) return { ok: false, code: 'disabled', reason: '姐妹私聊未开启' };

  const from = String(input.fromSelfId || '').trim();
  const to = String(input.toSelfId || '').trim();
  if (!from) return { ok: false, code: 'no-from', reason: '发送方账号还没登录，拿不到 QQ 号' };
  if (!to) return { ok: false, code: 'no-to', reason: '接收方账号还没登录，拿不到 QQ 号' };
  if (from === to) return { ok: false, code: 'self', reason: '不能发给自己' };

  const text = String(input.text || '').trim();
  if (!text) return { ok: false, code: 'empty', reason: '内容为空' };
  if (text.length > 300) return { ok: false, code: 'too-long', reason: '单条过长（上限 300 字）' };

  // 链路深度：硬顶
  const depth = Math.max(0, Math.floor(input.depth ?? 0));
  const cap = Math.min(policy.maxChainDepth, HARD_MAX_CHAIN_DEPTH);
  if (depth > cap) {
    return { ok: false, code: 'depth', reason: '这条是自动回复的第 ' + depth + ' 层，超过上限 ' + cap + '（防止两个角色无限对话）' };
  }

  const hour = hourKeyOf(input.now);
  const day = dayKeyOf(input.now);
  const hourCount = usage.hourKey === hour ? usage.hourCount : 0;
  const dayCount = usage.dayKey === day ? usage.dayCount : 0;
  if (hourCount >= policy.maxPerHour) return { ok: false, code: 'hour-limit', reason: '本小时已达上限（' + policy.maxPerHour + ' 条）' };
  if (dayCount >= policy.maxPerDay) return { ok: false, code: 'day-limit', reason: '今天已达上限（' + policy.maxPerDay + ' 条）' };
  if (usage.lastAt > 0) {
    const gap = (input.now - usage.lastAt) / 60000;
    if (gap < policy.minIntervalMin) {
      return { ok: false, code: 'interval', reason: '距上一条不足 ' + policy.minIntervalMin + ' 分钟（还需 ' + Math.ceil(policy.minIntervalMin - gap) + ' 分钟）' };
    }
  }
  return { ok: true };
}

/** 成功发出一条后更新用量 */
export function recordDm(usage: DmUsage, now: number): DmUsage {
  const hour = hourKeyOf(now);
  const day = dayKeyOf(now);
  return {
    hourKey: hour,
    hourCount: usage.hourKey === hour ? usage.hourCount + 1 : 1,
    dayKey: day,
    dayCount: usage.dayKey === day ? usage.dayCount + 1 : 1,
    lastAt: now,
  };
}

/**
 * 收到对方消息时，该不该自动回。
 * @param incomingIsAi 这条消息是不是我们自己（AI）发的
 * @param incomingDepth 它的链路深度
 */
export function shouldAutoReply(
  policy: DmPolicy,
  incoming: { isAiOrigin: boolean; depth?: number }
): { reply: boolean; reason: string } {
  if (!policy.enabled) return { reply: false, reason: '姐妹私聊未开启' };
  if (incoming.isAiOrigin) return { reply: false, reason: '对方这条是 AI 发的，不自动回（否则两个角色会无限对话）' };
  const depth = Math.max(0, Math.floor(incoming.depth ?? 0));
  const cap = Math.min(policy.maxChainDepth, HARD_MAX_CHAIN_DEPTH);
  if (depth >= cap) return { reply: false, reason: '已到链路深度上限 ' + cap };
  return { reply: true, reason: '可以回' };
}

/** 给界面用的汇总 */
export function summarizeDm(policy: DmPolicy, usage: DmUsage, now: number): {
  enabled: boolean; hour: number; hourLimit: number; day: number; dayLimit: number; lastAt: number;
} {
  return {
    enabled: policy.enabled,
    hour: usage.hourKey === hourKeyOf(now) ? usage.hourCount : 0,
    hourLimit: policy.maxPerHour,
    day: usage.dayKey === dayKeyOf(now) ? usage.dayCount : 0,
    dayLimit: policy.maxPerDay,
    lastAt: usage.lastAt,
  };
}
