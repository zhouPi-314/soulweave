/*
 * SoulWeave S6：主动行为引擎
 *
 * 依据：01 需求 6.4「规则+AI 决策的主动行为，受免打扰、预算、权限、平台频率限制约束」
 *      路线图 S6 验收「时间窗/频率/预算可控」
 *
 * 【两种触发源（用户 Q2 的选择 A+B）】
 *   A 定时器：每天 1-3 次，随机时段
 *   B 事件驱动：想你了 / 分享日记 / 分享活动 / 里程碑 / 随机念头
 *   每次主动后写一条日记（Q2 的「+并更新日记/状态」）
 *
 * 【设计要点】
 * 1. 当天计划用「种子随机」生成 —— 同一天多次检查结果一致，不会每次刷新都变
 * 2. 所有闸门判断复用 life-budget.ts 的三重闸门，不重复实现
 * 3. 纯函数 + 注入时钟/随机 —— 可测试
 */

import {
  checkGates, commitUsage, rollUsage, emptyUsage,
  dayKey, hourKey,
  type TimeWindow, type FrequencyLimit, type BudgetLimit, type UsageState,
  type ProactiveKind, type GateResult,
} from './life-budget.js';
import { currentActivity, type ScheduleSlot, type ActivityKind } from './life-schedule.js';

// ─── 类型 ───────────────────────────────────────────

export type TriggerKind = 'scheduled' | 'event';

export type EventSignalKind =
  | 'miss_user'        // 用户很久没说话了
  | 'share_diary'      // 想分享刚写的日记
  | 'share_activity'   // 想分享正在做的事
  | 'milestone'        // 里程碑（连续 N 天等）
  | 'random_thought';  // 随机念头

export interface ProactiveTrigger {
  kind: TriggerKind;
  /** 定时触发的计划点（分钟），事件触发为 undefined */
  plannedMinute?: number;
  /** 事件信号类型 */
  signal?: EventSignalKind;
  /** 给 AI 的上下文提示 */
  hint: string;
  /** 当时角色在做什么 */
  activity: { kind: ActivityKind; title: string };
}

export interface ProactivePlan {
  day: string;
  character: string;
  /** 今天计划主动的时间点（分钟），升序 */
  minutes: number[];
}

export interface EvaluateInput {
  now: Date;
  character: string;
  schedule: ScheduleSlot[];
  window: TimeWindow;
  frequency: FrequencyLimit;
  budget: BudgetLimit;
  usage: UsageState;
  /** 今天的计划（由 planDay 生成） */
  plan: ProactivePlan;
  /** 待处理的事件信号（可为空） */
  signals?: EventSignalKind[];
  /** 今天已消费过的计划点（避免同一计划点在容差窗口内重复触发） */
  consumedMinutes?: number[];
  /** 预计消耗 */
  estimatedTokens?: number;
  estimatedCost?: number;
}

export interface EvaluateResult {
  shouldAct: boolean;
  trigger?: ProactiveTrigger;
  /** 不行动的原因 */
  blockedBy?: 'time' | 'frequency' | 'budget' | 'no-plan' | 'not-due';
  reason?: string;
  /** 下次可行动时间 */
  nextAt?: number;
}

// ─── 种子随机（当天计划稳定） ───────────────────────

/** FNV-1a 字符串哈希 */
function hashString(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32：给定种子的确定性 PRNG */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── 当天计划 ───────────────────────────────────────

export interface PlanOptions {
  /** 每天主动次数范围，默认 1-3 */
  minPerDay?: number;
  maxPerDay?: number;
  /** 避开的活动类型（默认睡觉时不主动） */
  avoidKinds?: ActivityKind[];
}

/**
 * 生成某角色某天的主动计划。
 *
 * 确定性：同一 (character, day) 永远返回相同的 minutes。
 * 这样每 5 分钟检查一次也不会因为重新随机而错过或重复触发。
 */
export function planDay(
  character: string,
  date: Date,
  schedule: ScheduleSlot[],
  window: TimeWindow,
  opts: PlanOptions = {},
): ProactivePlan {
  const dk = dayKey(date);
  const minPerDay = Math.max(1, Number(opts.minPerDay) || 1);
  const maxPerDay = Math.max(minPerDay, Number(opts.maxPerDay) || 3);
  const avoid = opts.avoidKinds || (['sleep'] as ActivityKind[]);

  const rand = mulberry32(hashString(character + '|' + dk));
  const count = minPerDay + Math.floor(rand() * (maxPerDay - minPerDay + 1));

  // 收集可用分钟：允许时段内 & 非免打扰 & 角色不在睡觉
  const usable: number[] = [];
  // ranges 为空 = 全天允许（与 life-budget 的语义一致）
  const hasRanges = (window.ranges || []).length > 0;
  for (let m = 0; m < 1440; m += 15) {
    if (hasRanges && !inWindowRanges(m, window.ranges)) continue;
    if (inWindowRanges(m, window.quietRanges)) continue;
    // 检查角色当时的活动
    const probe = new Date(date.getTime());
    probe.setHours(Math.floor(m / 60), m % 60, 0, 0);
    const act = currentActivity(schedule, probe, character);
    if (avoid.includes(act.kind)) continue;
    usable.push(m);
  }

  if (!usable.length) {
    return { day: dk, character, minutes: [] };
  }

  // 均匀采样：把可用区间分成 count 段，每段随机取一个
  const minutes: number[] = [];
  const seg = usable.length / count;
  for (let i = 0; i < count; i++) {
    const start = Math.floor(i * seg);
    const end = Math.min(usable.length, Math.floor((i + 1) * seg));
    if (end <= start) continue;
    const pick = start + Math.floor(rand() * (end - start));
    minutes.push(usable[pick]);
  }

  minutes.sort((a, b) => a - b);
  // 去重
  const uniq = minutes.filter((m, i) => i === 0 || m !== minutes[i - 1]);
  return { day: dk, character, minutes: uniq };
}

/** 分钟是否落在任意区间内（支持跨午夜） */
function inWindowRanges(minute: number, ranges: Array<{ startMinute: number; endMinute: number }> | undefined): boolean {
  if (!ranges || ranges.length === 0) return false;
  for (const r of ranges) {
    const s = r.startMinute, e = r.endMinute;
    if (e > s) { if (minute >= s && minute < e) return true; }
    else if (e < s) { if (minute >= s || minute < e) return true; }
    else return true;
  }
  return false;
}

// ─── 事件信号判定 ───────────────────────────────────

export interface SignalContext {
  /** 距离用户上次发言多久（分钟） */
  minutesSinceUserTalk?: number;
  /** 是否有未分享的日记 */
  hasUnsharedDiary?: boolean;
  /** 连续互动天数 */
  streakDays?: number;
  /** 注入的随机源（测试用） */
  rand?: () => number;
}

/**
 * 从上下文推导出候选事件信号。
 *
 * 只返回「够格」的信号，不做闸门判断（闸门在 evaluate 里）。
 */
export function deriveSignals(ctx: SignalContext): EventSignalKind[] {
  const out: EventSignalKind[] = [];
  const rand = ctx.rand || Math.random;

  // 想你了：用户 12 小时以上没说话
  if (typeof ctx.minutesSinceUserTalk === 'number' && ctx.minutesSinceUserTalk >= 12 * 60) {
    out.push('miss_user');
  }

  // 有未分享的日记
  if (ctx.hasUnsharedDiary) out.push('share_diary');

  // 里程碑：连续 7 天 / 30 天 / 100 天
  if (typeof ctx.streakDays === 'number' && [7, 30, 100].includes(ctx.streakDays)) {
    out.push('milestone');
  }

  // 随机念头：低概率（5%），避免频繁
  if (rand() < 0.05) out.push('random_thought');

  return out;
}

// ─── 核心：评估是否该行动 ───────────────────────────

/** 定时触发的时间容差（分钟）。±5 分钟内算「到点」 */
export const DUE_TOLERANCE_MIN = 5;

/**
 * 综合判断当前是否应该主动。
 *
 * 顺序：
 *   1. 三重闸门（时间/频率/预算）—— 最便宜的判断先做
 *   2. 是否有事件信号（优先级高于定时）
 *   3. 定时计划是否到点
 */
export function evaluate(input: EvaluateInput): EvaluateResult {
  const now = input.now;
  const minute = now.getHours() * 60 + now.getMinutes();

  // 当前活动
  const act = currentActivity(input.schedule, now, input.character);
  const activity = { kind: act.kind, title: act.title };

  // ── 1. 三重闸门 ──
  const gate: GateResult = checkGates({
    now,
    window: input.window,
    frequency: input.frequency,
    budget: input.budget,
    usage: input.usage,
    estimatedTokens: input.estimatedTokens,
    estimatedCost: input.estimatedCost,
  });
  if (!gate.ok) {
    return {
      shouldAct: false,
      blockedBy: gate.blockedBy,
      reason: gate.reason,
      nextAt: gate.retryAt,
    };
  }

  // ── 2. 事件信号优先 ──
  const signals = input.signals || [];
  if (signals.length) {
    const signal = signals[0];
    return {
      shouldAct: true,
      trigger: {
        kind: 'event',
        signal,
        hint: signalHint(signal, act.title),
        activity,
      },
    };
  }

  // ── 3. 定时计划 ──
  if (input.plan.day !== dayKey(now)) {
    return { shouldAct: false, blockedBy: 'no-plan', reason: '今天的计划还没生成' };
  }
  if (!input.plan.minutes.length) {
    return { shouldAct: false, blockedBy: 'no-plan', reason: '今天没有可用的主动时段' };
  }

  // 找最近的计划点（跳过今天已消费过的）
  const consumed = new Set(input.consumedMinutes || []);
  let due: number | null = null;
  for (const m of input.plan.minutes) {
    if (consumed.has(m)) continue;
    const diff = minute - m;
    if (diff >= 0 && diff <= DUE_TOLERANCE_MIN) { due = m; break; }
  }
  if (due === null) {
    // 找下一个未来的计划点（未消费）
    const next = input.plan.minutes.find((m) => m > minute && !consumed.has(m));
    const nextAt = next !== undefined
      ? (() => { const d = new Date(now.getTime()); d.setHours(Math.floor(next / 60), next % 60, 0, 0); return d.getTime(); })()
      : undefined;
    return {
      shouldAct: false,
      blockedBy: 'not-due',
      reason: next !== undefined ? '还没到计划时间' : '今天的计划点都过了',
      nextAt,
    };
  }

  return {
    shouldAct: true,
    trigger: {
      kind: 'scheduled',
      plannedMinute: due,
      hint: scheduledHint(act.title, minute),
      activity,
    },
  };
}

// ─── 提示词构造 ─────────────────────────────────────

export function signalHint(signal: EventSignalKind, activityTitle: string): string {
  switch (signal) {
    case 'miss_user': return '你好久没跟我说话了，我想主动找你聊聊。（当前：' + activityTitle + '）';
    case 'share_diary': return '你刚写完一篇日记，想跟主人分享。（当前：' + activityTitle + '）';
    case 'share_activity': return '你现在正在「' + activityTitle + '」，想跟主人说说这件事。';
    case 'milestone': return '今天是个特别的日子（连续陪伴里程碑），想表达一下心情。';
    case 'random_thought': return '你突然想到一件有趣的小事，想跟主人分享。';
    default: return '你想主动跟主人说说话。';
  }
}

export function scheduledHint(activityTitle: string, minute: number): string {
  const hh = String(Math.floor(minute / 60)).padStart(2, '0');
  const mm = String(minute % 60).padStart(2, '0');
  return '现在是 ' + hh + ':' + mm + '，你正在「' + activityTitle + '」，想主动跟主人说句话。';
}

// ─── 状态机封装 ─────────────────────────────────────

export interface ProactiveRunnerOptions {
  character: string;
  schedule: ScheduleSlot[];
  window: TimeWindow;
  frequency: FrequencyLimit;
  budget: BudgetLimit;
  /** 初始用量（从持久化恢复） */
  usage?: UsageState;
  /** 注入时钟（测试用） */
  now?: () => Date;
  /** 计划参数 */
  planOpts?: PlanOptions;
}

/**
 * 主动行为运行器：维护计划、用量，对外提供 tick()。
 *
 * 上层只需每 N 分钟调一次 tick()，并在 onAct 里做事。
 */
export class ProactiveRunner {
  private opts: ProactiveRunnerOptions;
  private usage: UsageState;
  private plan: ProactivePlan | null = null;
  private clock: () => Date;

  constructor(opts: ProactiveRunnerOptions) {
    this.opts = opts;
    this.clock = opts.now || (() => new Date());
    this.usage = opts.usage || emptyUsage(this.clock(), 'private_chat');
  }

  /** 拿当天计划（懒生成） */
  getPlan(): ProactivePlan {
    const now = this.clock();
    const dk = dayKey(now);
    if (!this.plan || this.plan.day !== dk) {
      this.plan = planDay(this.opts.character, now, this.opts.schedule, this.opts.window, this.opts.planOpts);
    }
    return this.plan;
  }

  /** 强制重新生成计划（用户改了日程时） */
  resetPlan(): void { this.plan = null; this.consumedMinutes = []; this.consumedDay = ''; }

  /** 当前用量 */
  getUsage(): UsageState { return { ...this.usage }; }

  /** 事件信号注入 */
  /** 今天已消费的计划点 */
  private consumedMinutes: number[] = [];
  private consumedDay: string = '';

  private pendingSignals: EventSignalKind[] = [];
  pushSignal(s: EventSignalKind): void {
    if (!this.pendingSignals.includes(s)) this.pendingSignals.push(s);
  }

  /**
   * 检查一次。
   * 返回 shouldAct=true 时，调用方执行主动行为后必须调 commit()。
   */
  tick(extra?: { estimatedTokens?: number; estimatedCost?: number }): EvaluateResult {
    const now = this.clock();
    this.usage = rollUsage(this.usage, now, 'private_chat');

    const r = evaluate({
      now,
      character: this.opts.character,
      schedule: this.opts.schedule,
      window: this.opts.window,
      frequency: this.opts.frequency,
      budget: this.opts.budget,
      usage: this.usage,
      plan: this.getPlan(),
      signals: this.pendingSignals.slice(),
      consumedMinutes: this.getConsumed(),
      estimatedTokens: extra?.estimatedTokens,
      estimatedCost: extra?.estimatedCost,
    });

    return r;
  }

  /** 当天已消费的计划点（跨天自动清空） */
  private getConsumed(): number[] {
    const dk = dayKey(this.clock());
    if (this.consumedDay !== dk) {
      this.consumedDay = dk;
      this.consumedMinutes = [];
    }
    return this.consumedMinutes;
  }

  /** 确认执行了一次主动，记录用量和已消费点 */
  commit(
    consumedSignal?: EventSignalKind,
    extra?: { rounds?: number; tokens?: number; cost?: number; plannedMinute?: number },
  ): void {
    const now = this.clock();
    this.usage = commitUsage(this.usage, now, 'private_chat', extra);
    if (consumedSignal) {
      this.pendingSignals = this.pendingSignals.filter((s) => s !== consumedSignal);
    }
    // 记录计划点，防止容差窗口内重复触发
    const pm = extra?.plannedMinute;
    if (typeof pm === 'number') {
      const list = this.getConsumed();
      if (!list.includes(pm)) list.push(pm);
    }
  }

  /** 重置为今天的空用量 */
  resetUsage(): void {
    this.usage = emptyUsage(this.clock(), 'private_chat');
  }
}
