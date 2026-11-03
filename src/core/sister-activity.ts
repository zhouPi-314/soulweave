/**
 * SoulWeave S11：姐妹活动（可选）
 *
 * 【需求边界】
 * D23：默认仅群聊，Desktop 可选开启「姐妹间完整社交」。
 * S11 的增量是「姐妹活动」——两个角色围绕生活事件互相接话，而不是让两个模型自由对聊。
 *
 * 【为什么必须确定性】
 * 两个角色互相触发会形成回环：A 说话 → 触发 B → B 说话 → 又触发 A。
 * 一旦交给模型自由发挥，就是无限 Token 消耗 + 账号风险（QQ 风控）。
 *
 * 所以这里是**状态机**，不是「让模型聊聊看」：
 *   · 谁说话由轮次决定（交替），模型不能自己选
 *   · 轮数上限默认 3，硬顶 6（对齐 D60 连续消息上限）
 *   · 达到上限立刻结束，没有「再来一轮」的入口
 *   · 每日次数 + 冷却，防止一天刷几百条
 *
 * 本文件不调模型、不发消息：生成与发送由调用方注入。
 */

export type SisterPolicy = {
  /** 默认关闭：不开启就不产生任何活动 */
  enabled: boolean;
  /** 每场活动最多几轮（1–6，硬顶对应 D60） */
  maxRounds: number;
  /** 每天最多几场 */
  dailyLimit: number;
  /** 两场之间至少间隔多少分钟 */
  cooldownMin: number;
};

export const DEFAULT_SISTER_POLICY: SisterPolicy = {
  enabled: false,
  maxRounds: 3,
  dailyLimit: 2,
  cooldownMin: 240,
};

/** D60：连续消息默认 6 条，可配 1–30；这里是活动轮数，取 6 作硬顶 */
export const MAX_ROUNDS_HARD = 6;

export type ActivityState = 'running' | 'done' | 'aborted';

export type ActivityTurn = {
  round: number;
  speakerId: string;
  text: string;
  at: number;
};

export type Activity = {
  id: string;
  topic: string;
  participants: string[];
  state: ActivityState;
  turns: ActivityTurn[];
  startedAt: number;
  endedAt?: number;
  reason?: string;
};

export type SisterStore = {
  version: 1;
  policy: SisterPolicy;
  activities: Activity[];
  /** 当天日期与已开展场次 */
  day: string;
  countToday: number;
  lastAt: number;
};

export function emptySisterStore(): SisterStore {
  return {
    version: 1,
    policy: { ...DEFAULT_SISTER_POLICY },
    activities: [],
    day: '',
    countToday: 0,
    lastAt: 0,
  };
}

export function dayKeyOf(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/** 校验策略 */
export function validateSisterPolicy(p: Partial<SisterPolicy>): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (p.maxRounds !== undefined) {
    if (!Number.isInteger(p.maxRounds) || p.maxRounds < 1 || p.maxRounds > MAX_ROUNDS_HARD) {
      errors.push('轮数需为 1–' + MAX_ROUNDS_HARD + ' 的整数');
    }
  }
  if (p.dailyLimit !== undefined) {
    if (!Number.isInteger(p.dailyLimit) || p.dailyLimit < 0 || p.dailyLimit > 20) errors.push('每日场次需为 0–20');
  }
  if (p.cooldownMin !== undefined) {
    if (!Number.isInteger(p.cooldownMin) || p.cooldownMin < 0 || p.cooldownMin > 1440) errors.push('冷却需为 0–1440 分钟');
  }
  return { ok: errors.length === 0, errors };
}

export type StartCheck = { ok: true } | { ok: false; code: string; reason: string };

/** 能不能开一场新活动 */
export function checkStart(store: SisterStore, now: number): StartCheck {
  const pol = store.policy;
  if (!pol.enabled) return { ok: false, code: 'disabled', reason: '姐妹活动未开启' };
  const day = dayKeyOf(now);
  const count = store.day === day ? store.countToday : 0;
  // 先看有没有正在进行的活动：这比「冷却」更具体，理由也更好懂
  const running = store.activities.find((a) => a.state === 'running');
  if (running) return { ok: false, code: 'busy', reason: '上一场还没结束：' + running.topic };
  if (count >= pol.dailyLimit) return { ok: false, code: 'daily-limit', reason: '今天已经进行 ' + count + ' 场，达到上限' };
  if (store.lastAt > 0) {
    const gapMin = (now - store.lastAt) / 60000;
    if (gapMin < pol.cooldownMin) {
      return { ok: false, code: 'cooldown', reason: '距上一场不足 ' + pol.cooldownMin + ' 分钟（还需 ' + Math.ceil(pol.cooldownMin - gapMin) + ' 分钟）' };
    }
  }
  return { ok: true };
}

/** 开场：确定参与者与轮次上限（轮数在这里定死，之后无法加） */
export function createActivity(
  store: SisterStore,
  input: { topic: string; participants: string[] },
  now: number
): { ok: true; activity: Activity; store: SisterStore } | { ok: false; error: string } {
  const chk = checkStart(store, now);
  if (!chk.ok) return { ok: false, error: chk.reason };
  const parts = (input.participants || []).filter(Boolean);
  if (parts.length < 2) return { ok: false, error: '至少需要两个角色才能互动' };
  if (new Set(parts).size !== parts.length) return { ok: false, error: '参与者不能重复' };
  const topic = String(input.topic || '').trim();
  if (!topic) return { ok: false, error: '缺少活动主题' };

  const day = dayKeyOf(now);
  const activity: Activity = {
    id: 'sa-' + now.toString(36),
    topic,
    participants: parts.slice(0, 4),
    state: 'running',
    turns: [],
    startedAt: now,
  };
  const next: SisterStore = {
    ...store,
    activities: [...store.activities, activity],
    day,
    countToday: (store.day === day ? store.countToday : 0) + 1,
    lastAt: now,
  };
  return { ok: true, activity, store: next };
}

/**
 * 下一个该谁说话。
 * 【确定性】按 轮次 % 参与者数 取，模型无法干预。
 */
export function nextSpeaker(activity: Activity): string | null {
  if (activity.state !== 'running') return null;
  return activity.participants[activity.turns.length % activity.participants.length] || null;
}

/** 还能不能继续（轮数上限） */
export function remainingRounds(activity: Activity, maxRounds: number): number {
  return Math.max(0, maxRounds - activity.turns.length);
}

/**
 * 追加一句。
 * 说话人必须等于 nextSpeaker，否则拒绝 —— 这是防回环的核心。
 */
export function appendTurn(
  store: SisterStore,
  activityId: string,
  input: { speakerId: string; text: string },
  now: number
): { ok: true; activity: Activity; store: SisterStore; finished: boolean } | { ok: false; error: string } {
  const idx = store.activities.findIndex((a) => a.id === activityId);
  if (idx < 0) return { ok: false, error: '找不到该活动' };
  const act = store.activities[idx];
  if (act.state !== 'running') return { ok: false, error: '活动已结束' };

  const expect = nextSpeaker(act);
  if (!expect) return { ok: false, error: '活动已结束' };
  if (input.speakerId !== expect) {
    return { ok: false, error: '现在该 ' + expect + ' 说话，不能抢话（防止两个角色互相刷屏）' };
  }

  const text = String(input.text || '').trim();
  if (!text) return { ok: false, error: '内容为空' };
  if (text.length > 500) return { ok: false, error: '单条过长（上限 500 字）' };

  // 同一角色不能连续两次（交替天然保证，但数据可能被外部改坏，这里再挡一次）
  const last = act.turns[act.turns.length - 1];
  if (last && last.speakerId === input.speakerId) {
    return { ok: false, error: '同一个角色不能连续说话' };
  }

  const turn: ActivityTurn = { round: act.turns.length + 1, speakerId: input.speakerId, text, at: now };
  const turns = [...act.turns, turn];
  const maxRounds = Math.min(Math.max(1, store.policy.maxRounds), MAX_ROUNDS_HARD);
  const finished = turns.length >= maxRounds;
  const updated: Activity = {
    ...act,
    turns,
    state: finished ? 'done' : 'running',
    endedAt: finished ? now : undefined,
    reason: finished ? '达到轮数上限（' + maxRounds + '）' : undefined,
  };
  const activities = store.activities.slice();
  activities[idx] = updated;
  return { ok: true, activity: updated, store: { ...store, activities }, finished };
}

/** 提前结束 */
export function abortActivity(store: SisterStore, activityId: string, now: number, reason = '人工结束'): SisterStore | null {
  const idx = store.activities.findIndex((a) => a.id === activityId);
  if (idx < 0) return null;
  const act = store.activities[idx];
  if (act.state !== 'running') return store;
  const activities = store.activities.slice();
  activities[idx] = { ...act, state: 'aborted', endedAt: now, reason };
  return { ...store, activities };
}

/** 汇总：给界面用 */
export function summarizeSister(store: SisterStore, now: number): {
  running: number; done: number; aborted: number;
  today: number; limit: number; enabled: boolean;
} {
  const c = { running: 0, done: 0, aborted: 0 };
  for (const a of store.activities) c[a.state] = (c[a.state] || 0) + 1;
  const day = dayKeyOf(now);
  return {
    ...c,
    today: store.day === day ? store.countToday : 0,
    limit: store.policy.dailyLimit,
    enabled: store.policy.enabled,
  };
}
