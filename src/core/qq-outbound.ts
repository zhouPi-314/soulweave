/**
 * SoulWeave S5：出站发送闸门
 *
 * 职责：在「真正发出去之前」做最后一层检查。
 * 与 TaskMachine 的分工：
 *   - TaskMachine 管**任务额度**（这个任务还能发几条）
 *   - 这里管**速率与预算**（这个账号现在能不能发）
 *
 * 【为什么要分两层】
 * 任务额度用完会直接拒绝，但「额度还有、现在不能发」也是常态：
 * 冷却中、每日上限到了、预算超了。这些都不该消耗任务额度。
 */

export interface OutboundLimits {
  /** 单会话冷却秒数（同一群/同一人连续回复的最小间隔） */
  cooldownSeconds: number;
  /** 每账号每日最大消息数 */
  dailyMaxMessages: number;
  /** 每账号每日最大轮次 */
  dailyMaxRounds: number;
}

export const DEFAULT_OUTBOUND_LIMITS: OutboundLimits = {
  cooldownSeconds: 60,
  dailyMaxMessages: 300,
  dailyMaxRounds: 100,
};

export interface OutboundState {
  /** conversationKey → 上次发送时间（ms） */
  lastSentAt: Map<string, number>;
  /** 账号 → 当日已发消息数 */
  dailyMessages: Map<string, number>;
  /** 账号 → 当日已用轮次 */
  dailyRounds: Map<string, number>;
  /** 账号 → 当日计数所属日期（YYYY-MM-DD） */
  dailyDate: Map<string, string>;
}

export function createOutboundState(): OutboundState {
  return {
    lastSentAt: new Map(),
    dailyMessages: new Map(),
    dailyRounds: new Map(),
    dailyDate: new Map(),
  };
}

export type OutboundVerdict =
  | { ok: true }
  | { ok: false; reason: string; code: 'COOLDOWN' | 'DAILY_MESSAGES' | 'DAILY_ROUNDS' };

/** 本地日期键（用本地时区，因为用户感知的「今天」是本地时间） */
export function dayKey(now: number): string {
  const d = new Date(now);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

/**
 * 检查是否允许发送。
 *
 * 纯函数：只读 state，不改。真正扣减在 commitOutbound()。
 * 这样「先检查后发送」失败时不会误扣计数。
 */
export function checkOutbound(
  state: OutboundState,
  accountLabel: string,
  conversationKey: string,
  limits: OutboundLimits,
  now: number,
): OutboundVerdict {
  const today = dayKey(now);
  const storedDay = state.dailyDate.get(accountLabel);

  // 跨天自动清零（不需要定时任务）
  const msgToday = storedDay === today ? (state.dailyMessages.get(accountLabel) || 0) : 0;
  const roundToday = storedDay === today ? (state.dailyRounds.get(accountLabel) || 0) : 0;

  if (msgToday >= limits.dailyMaxMessages) {
    return {
      ok: false,
      code: 'DAILY_MESSAGES',
      reason: '今日消息数已达上限 (' + msgToday + '/' + limits.dailyMaxMessages + ')',
    };
  }
  if (roundToday >= limits.dailyMaxRounds) {
    return {
      ok: false,
      code: 'DAILY_ROUNDS',
      reason: '今日轮次已达上限 (' + roundToday + '/' + limits.dailyMaxRounds + ')',
    };
  }

  const last = state.lastSentAt.get(conversationKey);
  if (last !== undefined && limits.cooldownSeconds > 0) {
    const elapsed = (now - last) / 1000;
    if (elapsed < limits.cooldownSeconds) {
      const wait = Math.ceil(limits.cooldownSeconds - elapsed);
      return {
        ok: false,
        code: 'COOLDOWN',
        reason: '冷却中，还需 ' + wait + ' 秒（同一会话 ' + limits.cooldownSeconds + ' 秒内只回一次）',
      };
    }
  }

  return { ok: true };
}

/**
 * 扣减计数。**必须在发送成功后调用**。
 *
 * 为什么不是发送前：发送失败（网络错误）时如果已扣减，
 * 用户就白白损失了一次额度。发送成功再扣更符合直觉。
 */
export function commitOutbound(
  state: OutboundState,
  accountLabel: string,
  conversationKey: string,
  now: number,
  isNewRound = true,
): void {
  const today = dayKey(now);
  if (state.dailyDate.get(accountLabel) !== today) {
    state.dailyDate.set(accountLabel, today);
    state.dailyMessages.set(accountLabel, 0);
    state.dailyRounds.set(accountLabel, 0);
  }
  state.lastSentAt.set(conversationKey, now);
  state.dailyMessages.set(accountLabel, (state.dailyMessages.get(accountLabel) || 0) + 1);
  if (isNewRound) {
    state.dailyRounds.set(accountLabel, (state.dailyRounds.get(accountLabel) || 0) + 1);
  }
}

/** 供 UI 显示当前用量 */
export function outboundUsage(
  state: OutboundState,
  accountLabel: string,
  limits: OutboundLimits,
  now: number,
): { messages: number; rounds: number; maxMessages: number; maxRounds: number } {
  const today = dayKey(now);
  const same = state.dailyDate.get(accountLabel) === today;
  return {
    messages: same ? (state.dailyMessages.get(accountLabel) || 0) : 0,
    rounds: same ? (state.dailyRounds.get(accountLabel) || 0) : 0,
    maxMessages: limits.dailyMaxMessages,
    maxRounds: limits.dailyMaxRounds,
  };
}

/**
 * 出站消息的内容安全处理。
 *
 * 两件事：
 * 1. 去掉 AI 常加的「（笑）」「*叹气*」这类舞台指示 —— 在 QQ 里显得很假
 * 2. 长度截断，避免一条消息刷屏
 */
export function sanitizeOutgoing(text: string, maxLen = 800): string {
  let s = String(text || '');

  // 去掉整行的括号动作描述（只去独立成行的，不误伤正文里的括号）
  // 注意：删除后可能留下空行，所以紧接着要压空白
  s = s.replace(/^[ \t]*[（(][^）)\n]{1,20}[）)][ \t]*$/gm, '');
  s = s.replace(/\n[ \t]*\n/g, '\n');
  s = s.replace(/^\n+/, '');
  // 去掉 markdown 强调符（QQ 不渲染）
  s = s.replace(/\*\*(.+?)\*\*/g, '$1');
  s = s.replace(/(?<!\*)\*(?!\*)([^*\n]{1,40})\*(?!\*)/g, '$1');
  // 连续空行压成一个
  s = s.replace(/\n{3,}/g, '\n\n');
  s = s.trim();

  if (s.length > maxLen) {
    s = s.slice(0, maxLen - 1) + '…';
  }
  return s;
}

/**
 * 判断 AI 的回复是否构成「自我重复」，用于防止互聊循环。
 *
 * 场景：两个角色在同一个群里，A 说了什么，B 复述一遍，A 再复述。
 * 检查最近 N 条里有没有高度相似的。
 */
export function isRepetitive(candidate: string, recent: string[], threshold = 0.85): boolean {
  const norm = (s: string) => String(s || '').replace(/[\s\p{P}]/gu, '').toLowerCase();
  const c = norm(candidate);
  if (!c) return true;
  for (const r of recent) {
    const t = norm(r);
    if (!t) continue;
    if (c === t) return true;
    // 简单相似度：短串被长串包含即算重复
    if (c.length >= 8 && t.length >= 8 && (c.indexOf(t) >= 0 || t.indexOf(c) >= 0)) return true;
    // Jaccard（2-gram）
    if (c.length >= 6 && t.length >= 6) {
      const grams = (x: string) => {
        const set = new Set<string>();
        for (let i = 0; i + 2 <= x.length; i++) set.add(x.slice(i, i + 2));
        return set;
      };
      const A = grams(c); const B = grams(t);
      let inter = 0;
      for (const g of A) if (B.has(g)) inter++;
      const union = A.size + B.size - inter;
      if (union > 0) {
        const sim = inter / union;
        // 短句（<12 字）的 2-gram 集合小，分母天然偏大，
        // 用同一个阈值会漏判 —— 按长度适当放宽。
        const minLen = Math.min(c.length, t.length);
        const eff = minLen < 12 ? Math.max(0.6, threshold - 0.15) : threshold;
        if (sim >= eff) return true;
      }
    }
  }
  return false;
}
