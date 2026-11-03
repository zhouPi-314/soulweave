/**
 * SoulWeave S11：QQ 空间发布策略
 *
 * 【为什么单独一层】
 * 需求里最硬的几条全在策略上，不在发送上：
 *   · 默认不执行未经配置的公开发布
 *   · 每次发布可配置为「必须确认」，开启时无批准不得发送
 *   · 即使允许自动发布，也受频率、时段、内容类型、公开范围限制
 *
 * 所以先把「能不能发」判清楚，再谈「怎么发」。本文件不联网、不写盘，纯函数。
 */

/** 公开范围，与 NapCat 的 ugc_right 一一对应 */
export type QzoneRight = 1 | 4 | 16 | 64 | 128;

export type QzoneContentKind = 'life' | 'art' | 'fiction';

export type QzoneWindow = { start: string; end: string };   // 'HH:MM'

export type QzonePolicy = {
  /** 总开关，默认关 */
  enabled: boolean;
  /** 每次发布是否必须人工确认，默认开（PRD 要求可配，且默认从严） */
  requireConfirm: boolean;
  /** 每日最多发几条 */
  dailyLimit: number;
  /** 两条之间最小间隔（分钟） */
  minIntervalMin: number;
  /** 允许发布的时段（本地时间），空数组表示不限 */
  windows: QzoneWindow[];
  /** 允许的内容类型 */
  allowedKinds: QzoneContentKind[];
  /** 默认公开范围 */
  defaultRight: QzoneRight;
  /** 部分可见/部分不可见时的 QQ 号 */
  targetUins: string[];
};

export const DEFAULT_QZONE_POLICY: QzonePolicy = {
  enabled: false,
  requireConfirm: true,
  dailyLimit: 2,
  minIntervalMin: 180,
  windows: [{ start: '09:00', end: '22:30' }],
  allowedKinds: ['life', 'art'],
  defaultRight: 1,
  targetUins: [],
};

export const VALID_RIGHTS: QzoneRight[] = [1, 4, 16, 64, 128];

export const RIGHT_LABELS: Record<QzoneRight, string> = {
  1: '所有人可见',
  4: '好友可见',
  16: '部分好友可见',
  64: '仅自己可见',
  128: '部分好友不可见',
};

/** 'HH:MM' → 分钟数；非法返回 null */
export function parseHm(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  if (h < 0 || h > 23 || mi < 0 || mi > 59) return null;
  return h * 60 + mi;
}

/** 把时间戳换算成本地当天分钟数 */
export function minutesOfDay(ts: number): number {
  const d = new Date(ts);
  return d.getHours() * 60 + d.getMinutes();
}

/** 本地日期键 YYYY-MM-DD，用于「每日」计数 */
export function dayKey(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/** 校验策略本身是否合法（配置写入前用） */
export function validatePolicy(p: Partial<QzonePolicy>): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (p.dailyLimit !== undefined && (!Number.isInteger(p.dailyLimit) || p.dailyLimit < 0 || p.dailyLimit > 20)) {
    errors.push('每日上限需为 0–20 的整数');
  }
  if (p.minIntervalMin !== undefined && (!Number.isInteger(p.minIntervalMin) || p.minIntervalMin < 0 || p.minIntervalMin > 24 * 60)) {
    errors.push('最小间隔需为 0–1440 分钟的整数');
  }
  if (p.defaultRight !== undefined && !VALID_RIGHTS.includes(p.defaultRight)) {
    errors.push('公开范围只能是 1 / 4 / 16 / 64 / 128');
  }
  if (p.windows !== undefined) {
    if (!Array.isArray(p.windows)) errors.push('时段需为数组');
    else for (const w of p.windows) {
      const a = parseHm(w?.start), b = parseHm(w?.end);
      if (a === null || b === null) { errors.push('时段格式需为 HH:MM'); break; }
      if (a === b) { errors.push('时段起止不能相同'); break; }
    }
  }
  if (p.allowedKinds !== undefined) {
    const valid = ['life', 'art', 'fiction'];
    if (!Array.isArray(p.allowedKinds) || p.allowedKinds.some((k) => !valid.includes(k))) {
      errors.push('内容类型只能是 life / art / fiction');
    }
  }
  // 16/128 必须有目标号，否则 NapCat 会直接报错
  const right = p.defaultRight ?? DEFAULT_QZONE_POLICY.defaultRight;
  if ((right === 16 || right === 128) && !(p.targetUins && p.targetUins.length)) {
    errors.push('公开范围为 16 或 128 时必须指定 QQ 号');
  }
  return { ok: errors.length === 0, errors };
}

export type QzoneUsage = {
  /** 已发送记录的日期键 */
  day: string;
  /** 当天已发条数 */
  count: number;
  /** 上一条成功发布的时间戳（0 表示没有） */
  lastAt: number;
};

export const EMPTY_USAGE: QzoneUsage = { day: '', count: 0, lastAt: 0 };

export type PublishCheck =
  | { ok: true }
  | { ok: false; code: string; reason: string };

/**
 * 判断「现在能不能发」。
 * 顺序按「先粗后细」：开关 → 类型 → 时段 → 频率 → 范围。
 */
export function checkPublish(
  policy: QzonePolicy,
  input: { kind: QzoneContentKind; content: string; images?: string[]; right?: QzoneRight; targetUins?: string[]; now: number },
  usage: QzoneUsage
): PublishCheck {
  if (!policy.enabled) return { ok: false, code: 'disabled', reason: 'QQ 空间发布未开启' };

  if (!policy.allowedKinds.includes(input.kind)) {
    return { ok: false, code: 'kind', reason: '不允许的内容类型：' + input.kind };
  }

  const body = String(input.content || '').trim();
  const imgs = input.images || [];
  if (!body && !imgs.length) return { ok: false, code: 'empty', reason: '内容与图片都为空' };
  if (body.length > 2000) return { ok: false, code: 'too-long', reason: '正文过长（上限 2000 字）' };

  // 时段
  if (policy.windows && policy.windows.length) {
    const now = minutesOfDay(input.now);
    const inAny = policy.windows.some((w) => {
      const a = parseHm(w.start), b = parseHm(w.end);
      if (a === null || b === null) return false;
      // 支持跨零点，例如 22:00–02:00
      return a <= b ? (now >= a && now < b) : (now >= a || now < b);
    });
    if (!inAny) return { ok: false, code: 'window', reason: '当前不在允许发布的时段内' };
  }

  // 频率：按当天重新计数（跨天自动归零）
  const day = dayKey(input.now);
  const count = usage.day === day ? usage.count : 0;
  if (count >= policy.dailyLimit) {
    return { ok: false, code: 'daily-limit', reason: '已达今日上限（' + policy.dailyLimit + ' 条）' };
  }
  if (usage.lastAt > 0) {
    const gapMin = (input.now - usage.lastAt) / 60000;
    if (gapMin < policy.minIntervalMin) {
      const left = Math.ceil(policy.minIntervalMin - gapMin);
      return { ok: false, code: 'interval', reason: '距上次发布不足 ' + policy.minIntervalMin + ' 分钟（还需 ' + left + ' 分钟）' };
    }
  }

  // 公开范围
  const right = input.right ?? policy.defaultRight;
  if (!VALID_RIGHTS.includes(right)) return { ok: false, code: 'right', reason: '公开范围不合法' };
  if ((right === 16 || right === 128) && !((input.targetUins ?? policy.targetUins) || []).length) {
    return { ok: false, code: 'target', reason: '该公开范围必须指定好友 QQ 号' };
  }

  return { ok: true };
}

/** 成功发一条后更新用量 */
export function commitPublish(usage: QzoneUsage, now: number): QzoneUsage {
  const day = dayKey(now);
  const count = usage.day === day ? usage.count + 1 : 1;
  return { day, count, lastAt: now };
}

/** 内容积极度粗筛：明显消极/危险的词先拦下来（不是价值观审查，是需求要求「积极乐观向上」） */
const NEGATIVE_PATTERNS = [
  /自杀|自残|想死|死了算了/,
  /仇恨|种族歧视|地域黑/,
  /赌博|博彩|代练|刷单/,
];

export function screenContent(text: string): { ok: boolean; reason?: string } {
  const s = String(text || '');
  for (const p of NEGATIVE_PATTERNS) {
    if (p.test(s)) return { ok: false, reason: '内容不适合公开发布（命中：' + p.source + '）' };
  }
  return { ok: true };
}
