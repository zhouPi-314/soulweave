/*
 * SoulWeave S6：角色作息引擎
 *
 * 依据：01 需求 6.1「与现实时间同步的虚拟作息」
 *      01 需求 7.8「作息计划、生活事件、场景」
 *
 * 【设计原则】
 * 1. 纯函数 —— 给定「当前时间 + 日程表」返回「现在在做什么」，不碰数据库
 * 2. 跨午夜支持 —— 23:00 睡觉到 07:00 起床，是同一段
 * 3. 用户可改 —— 默认只是默认，角色卡里能改
 * 4. 兜底安全 —— 日程为空/解析失败时返回「休息」，不抛异常
 */

// ─── 类型 ───────────────────────────────────────────

export type ActivityKind =
  | 'wake'
  | 'work'
  | 'meal'
  | 'rest'
  | 'sleep'
  | 'activity'
  | 'custom';

export interface ScheduleSlot {
  id?: string;
  ownerCharacter: string;
  kind: ActivityKind;
  /** 一天内第几分钟，0-1439 */
  startMinute: number;
  /** 结束分钟；若 < startMinute 表示跨午夜 */
  endMinute: number;
  /** 位掩码：bit0=周一 … bit6=周日。127 = 每天 */
  daysMask: number;
  title: string;
  scene?: string;
  enabled?: boolean;
}

export interface CurrentActivity {
  kind: ActivityKind;
  title: string;
  scene?: string;
  /** 这段日程的结束时间（分钟） */
  endsAtMinute: number;
  /** 距离结束还有多少分钟 */
  minutesLeft: number;
  /** 是否是默认值（没有匹配到任何日程） */
  isFallback: boolean;
}

// ─── 常量 ───────────────────────────────────────────

export const ALL_DAYS = 127; // 0b1111111

/** 星期几（0=周日…6=周六）→ 位掩码位号（0=周一…6=周日） */
export function weekdayBit(date: Date): number {
  const jsDay = date.getDay(); // 0=Sun … 6=Sat
  return jsDay === 0 ? 6 : jsDay - 1;
}

export function maskHasDay(mask: number, date: Date): boolean {
  return (mask & (1 << weekdayBit(date))) !== 0;
}

// ─── 核心：当前活动 ──────────────────────────────────

/**
 * 判断某个角色在指定时刻正在做什么。
 *
 * 跨午夜处理：
 *   23:00-07:00 的「睡觉」段，startMinute=1380, endMinute=420
 *   当前 02:00（minute=120）→ 落在段内
 *
 * 匹配优先级：先找跨午夜段，再找普通段。
 * 多段重叠时取「开始时间最晚的」（更具体）。
 */
export function currentActivity(
  slots: ScheduleSlot[],
  now: Date,
  ownerCharacter?: string,
): CurrentActivity {
  const minute = now.getHours() * 60 + now.getMinutes();

  const candidates = slots.filter((s) => {
    if (s.enabled === false) return false;
    if (ownerCharacter && s.ownerCharacter !== ownerCharacter) return false;
    return maskHasDay(s.daysMask, now);
  });

  const hits: Array<{ slot: ScheduleSlot; minutesLeft: number }> = [];

  for (const s of candidates) {
    const start = s.startMinute;
    const end = s.endMinute;

    if (end > start) {
      // 普通段：09:00-12:00
      if (minute >= start && minute < end) {
        hits.push({ slot: s, minutesLeft: end - minute });
      }
    } else if (end < start) {
      // 跨午夜段：23:00-07:00
      if (minute >= start) {
        hits.push({ slot: s, minutesLeft: 1440 - minute + end });
      } else if (minute < end) {
        hits.push({ slot: s, minutesLeft: end - minute });
      }
    } else {
      // start === end：视为全天（0 长度的段没有意义，按全天处理更安全）
      hits.push({ slot: s, minutesLeft: 1440 - minute });
    }
  }

  if (!hits.length) {
    // 兜底：休息
    return {
      kind: 'rest',
      title: '休息中',
      endsAtMinute: 1440,
      minutesLeft: 1440 - minute,
      isFallback: true,
    };
  }

  // 取开始时间最晚的（最具体的）
  hits.sort((a, b) => {
    const sa = a.slot.startMinute;
    const sb = b.slot.startMinute;
    // 跨午夜段（start 很大）优先
    const aCross = a.slot.endMinute < a.slot.startMinute;
    const bCross = b.slot.endMinute < b.slot.startMinute;
    if (aCross !== bCross) return aCross ? -1 : 1;
    return sb - sa;
  });

  const best = hits[0];
  return {
    kind: best.slot.kind,
    title: best.slot.title,
    scene: best.slot.scene,
    endsAtMinute: best.slot.endMinute,
    minutesLeft: best.minutesLeft,
    isFallback: false,
  };
}

// ─── 默认作息 ───────────────────────────────────────

/**
 * 默认作息（用户可在角色卡里改）。
 *
 * 你确认：「默认你现在推荐的作息，但用户可以在角色卡里修改」
 */
export const DEFAULT_SCHEDULES: Record<string, ScheduleSlot[]> = {
  冰糖: [
    { ownerCharacter: '冰糖', kind: 'sleep', startMinute: 23 * 60, endMinute: 7 * 60, daysMask: ALL_DAYS, title: '睡觉' },
    { ownerCharacter: '冰糖', kind: 'wake', startMinute: 7 * 60, endMinute: 8 * 60, daysMask: ALL_DAYS, title: '起床洗漱' },
    { ownerCharacter: '冰糖', kind: 'meal', startMinute: 8 * 60, endMinute: 9 * 60, daysMask: ALL_DAYS, title: '早餐' },
    { ownerCharacter: '冰糖', kind: 'work', startMinute: 9 * 60, endMinute: 12 * 60, daysMask: ALL_DAYS, title: '上午工作' },
    { ownerCharacter: '冰糖', kind: 'meal', startMinute: 12 * 60, endMinute: 13 * 60, daysMask: ALL_DAYS, title: '午饭' },
    { ownerCharacter: '冰糖', kind: 'rest', startMinute: 13 * 60, endMinute: 14 * 60, daysMask: ALL_DAYS, title: '午休' },
    { ownerCharacter: '冰糖', kind: 'work', startMinute: 14 * 60, endMinute: 18 * 60, daysMask: ALL_DAYS, title: '下午工作' },
    { ownerCharacter: '冰糖', kind: 'meal', startMinute: 18 * 60, endMinute: 19 * 60, daysMask: ALL_DAYS, title: '晚饭' },
    { ownerCharacter: '冰糖', kind: 'rest', startMinute: 19 * 60, endMinute: 23 * 60, daysMask: ALL_DAYS, title: '自由时间' },
  ],
  小橘子: [
    { ownerCharacter: '小橘子', kind: 'sleep', startMinute: 23 * 60, endMinute: 8 * 60, daysMask: ALL_DAYS, title: '睡觉' },
    { ownerCharacter: '小橘子', kind: 'wake', startMinute: 8 * 60, endMinute: 9 * 60, daysMask: ALL_DAYS, title: '起床' },
    { ownerCharacter: '小橘子', kind: 'meal', startMinute: 9 * 60, endMinute: 10 * 60, daysMask: ALL_DAYS, title: '早餐' },
    { ownerCharacter: '小橘子', kind: 'work', startMinute: 10 * 60, endMinute: 12 * 60, daysMask: ALL_DAYS, title: '上午活动' },
    { ownerCharacter: '小橘子', kind: 'meal', startMinute: 12 * 60, endMinute: 13 * 60, daysMask: ALL_DAYS, title: '午饭' },
    { ownerCharacter: '小橘子', kind: 'rest', startMinute: 13 * 60, endMinute: 15 * 60, daysMask: ALL_DAYS, title: '午休' },
    { ownerCharacter: '小橘子', kind: 'work', startMinute: 15 * 60, endMinute: 18 * 60, daysMask: ALL_DAYS, title: '下午活动' },
    { ownerCharacter: '小橘子', kind: 'meal', startMinute: 18 * 60, endMinute: 19 * 60, daysMask: ALL_DAYS, title: '晚饭' },
    { ownerCharacter: '小橘子', kind: 'rest', startMinute: 19 * 60, endMinute: 23 * 60, daysMask: ALL_DAYS, title: '自由时间' },
  ],
};

// ─── 校验 ───────────────────────────────────────────

export function validateSlot(s: Partial<ScheduleSlot>): { ok: boolean; error?: string } {
  const n = (v: unknown) => Number(v);
  const start = n(s.startMinute);
  const end = n(s.endMinute);
  if (!Number.isInteger(start) || start < 0 || start > 1439) {
    return { ok: false, error: '开始时间必须是 0-1439 的整数' };
  }
  if (!Number.isInteger(end) || end < 0 || end > 1440) {
    return { ok: false, error: '结束时间必须是 0-1440 的整数' };
  }
  if (!s.title || !String(s.title).trim()) {
    return { ok: false, error: '标题不能为空' };
  }
  const mask = n(s.daysMask);
  if (!Number.isInteger(mask) || mask < 1 || mask > 127) {
    return { ok: false, error: '重复日必须是 1-127 的位掩码' };
  }
  return { ok: true };
}

/** 把分钟数格式化成 HH:MM */
export function formatMinute(m: number): string {
  const v = ((m % 1440) + 1440) % 1440;
  const h = Math.floor(v / 60);
  const mm = v % 60;
  return String(h).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
}

/** 解析 HH:MM → 分钟 */
export function parseMinute(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s).trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mm = Number(m[2]);
  if (h > 24 || mm > 59) return null;
  if (h === 24 && mm !== 0) return null;
  return h * 60 + mm;
}
