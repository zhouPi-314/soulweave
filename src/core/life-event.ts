/*
 * SoulWeave S6：生活事件 / 日记
 *
 * 依据：01 需求 6.2「角色可适度主动分享虚拟生活照片、插画、日记；
 *                  明确区分虚构/AI 生成内容与真实经历」
 *      01 需求 7.8「日记、生活事件、事件历史、虚构内容标识」
 *      D46「Life Studio 日记、日程、AI 图片、活动、相册与真实/虚构标记」
 *
 * 【合规底线】
 * is_fictional 默认 TRUE —— 宁可标错，不可漏标。
 * 用户手动记录的「真实经历」必须显式设 false，且 source='user'。
 */

// ─── 类型 ───────────────────────────────────────────

export type EventKind = 'diary' | 'event' | 'activity' | 'reminder' | 'mood';
export type EventSource = 'user' | 'rule' | 'ai';
export type EventScope = 'private' | 'shared';

export interface LifeEvent {
  id?: number;
  ownerCharacter: string;
  kind: EventKind;
  title: string;
  body?: string;
  mood?: string;
  occurredAt: string;
  /** D46：是否虚构。默认 true */
  isFictional: boolean;
  /** 是否 AI 生成 */
  aiGenerated: boolean;
  source: EventSource;
  scope: EventScope;
  createdAt?: string;
  deletedAt?: string | null;
}

export interface ListEventsOptions {
  ownerCharacter: string;
  kinds?: EventKind[];
  from?: string;
  to?: string;
  search?: string;
  limit?: number;
  offset?: number;
  includeDeleted?: boolean;
}

// ─── 校验 ───────────────────────────────────────────

const VALID_KINDS: EventKind[] = ['diary', 'event', 'activity', 'reminder', 'mood'];
const VALID_SOURCES: EventSource[] = ['user', 'rule', 'ai'];
const VALID_SCOPES: EventScope[] = ['private', 'shared'];

export const TITLE_MAX = 200;
export const BODY_MAX = 20000;
export const MOOD_MAX = 40;

export function validateEvent(e: Partial<LifeEvent>): { ok: boolean; error?: string } {
  if (!e.ownerCharacter || !String(e.ownerCharacter).trim()) {
    return { ok: false, error: '缺少角色标识' };
  }
  if (!e.kind || !VALID_KINDS.includes(e.kind)) {
    return { ok: false, error: '事件类型非法：' + String(e.kind) };
  }
  const title = String(e.title || '').trim();
  if (!title) return { ok: false, error: '标题不能为空' };
  if (title.length > TITLE_MAX) return { ok: false, error: '标题过长（上限 ' + TITLE_MAX + '）' };
  if (e.body && String(e.body).length > BODY_MAX) {
    return { ok: false, error: '正文过长（上限 ' + BODY_MAX + '）' };
  }
  if (e.mood && String(e.mood).length > MOOD_MAX) {
    return { ok: false, error: '心情标签过长（上限 ' + MOOD_MAX + '）' };
  }
  if (e.source && !VALID_SOURCES.includes(e.source)) {
    return { ok: false, error: '来源非法：' + String(e.source) };
  }
  if (e.scope && !VALID_SCOPES.includes(e.scope)) {
    return { ok: false, error: '可见范围非法：' + String(e.scope) };
  }
  if (e.occurredAt && Number.isNaN(Date.parse(String(e.occurredAt)))) {
    return { ok: false, error: '时间格式非法' };
  }
  return { ok: true };
}

// ─── 规范化：强制合规默认 ───────────────────────────

/**
 * 把用户/AI 给的数据规范化成可入库的形状。
 *
 * 关键规则：
 * - 只有 source='user' 且显式 isFictional=false 才算「真实经历」
 * - 其余情况一律 isFictional=true
 *
 * 这条规则防止 AI 或规则引擎「不小心」把虚构内容标成真实。
 */
export function normalizeEvent(e: Partial<LifeEvent>): LifeEvent {
  const source: EventSource = VALID_SOURCES.includes(e.source as EventSource)
    ? (e.source as EventSource)
    : 'user';

  const kind: EventKind = VALID_KINDS.includes(e.kind as EventKind)
    ? (e.kind as EventKind)
    : 'event';

  const isUserReal = source === 'user' && e.isFictional === false;
  const isFictional = isUserReal ? false : true;

  return {
    ownerCharacter: String(e.ownerCharacter || '').trim(),
    kind,
    title: String(e.title || '').trim().slice(0, TITLE_MAX),
    body: e.body ? String(e.body).slice(0, BODY_MAX) : undefined,
    mood: e.mood ? String(e.mood).trim().slice(0, MOOD_MAX) : undefined,
    occurredAt: e.occurredAt && !Number.isNaN(Date.parse(String(e.occurredAt)))
      ? new Date(String(e.occurredAt)).toISOString()
      : new Date().toISOString(),
    isFictional,
    aiGenerated: source === 'ai' ? true : !!e.aiGenerated,
    source,
    scope: VALID_SCOPES.includes(e.scope as EventScope) ? (e.scope as EventScope) : 'private',
  };
}

// ─── 展示辅助 ───────────────────────────────────────

export interface EventBadge {
  fictional: boolean;
  aiGenerated: boolean;
  labels: string[];
}

/** 生成虚构/AI 标识（D46 要求 UI 必须可见） */
export function eventBadge(e: Pick<LifeEvent, 'isFictional' | 'aiGenerated'>): EventBadge {
  const labels: string[] = [];
  if (e.isFictional) labels.push('虚构');
  if (e.aiGenerated) labels.push('AI 生成');
  return { fictional: !!e.isFictional, aiGenerated: !!e.aiGenerated, labels };
}

// ─── 生成日记草稿（给 AI 用） ───────────────────────

export function buildDiaryPrompt(input: {
  characterName: string;
  persona?: string;
  activityTitle?: string;
  mood?: string;
  extra?: string;
}): string {
  const lines = [
    '你是「' + input.characterName + '」，一个有稳定人格的虚拟角色。',
    input.persona ? '人格设定：' + input.persona : '',
    '',
    '请用第一人称写一篇简短的虚拟生活日记（150-300 字）。',
    input.activityTitle ? '当前活动：' + input.activityTitle : '',
    input.mood ? '当前心情：' + input.mood : '',
    input.extra ? '补充：' + input.extra : '',
    '',
    '要求：',
    '1. 语气自然、真诚，符合角色人格',
    '2. 内容积极乐观向上',
    '3. 这是虚拟生活记录，不需要假装是真实人类经历',
    '4. 不要输出标题，直接写正文',
  ];
  return lines.filter((l) => l !== '').join('\n');
}

/** 从 AI 输出里清理出正文（去掉常见前缀） */
export function cleanDiaryBody(raw: string): string {
  let s = String(raw || '').trim();
  const fence = String.fromCharCode(96, 96, 96);
  s = s.replace(new RegExp('^' + fence + '[a-z]*\\n?', 'i'), '');
  s = s.replace(new RegExp('\\n?' + fence + '$', 'i'), '');
  s = s.replace(/^(日记|正文|内容)[：:]\s*/i, '');
  return s.slice(0, BODY_MAX).trim();
}

// ─── 列表查询参数规范化 ─────────────────────────────

export function normalizeListOptions(o: Partial<ListEventsOptions>): ListEventsOptions & { limit: number; offset: number } {
  const limit = Math.min(Math.max(Number(o.limit) || 20, 1), 100);
  const offset = Math.max(Number(o.offset) || 0, 0);
  return {
    ownerCharacter: String(o.ownerCharacter || '').trim(),
    kinds: Array.isArray(o.kinds) ? o.kinds.filter((k) => VALID_KINDS.includes(k)) : undefined,
    from: o.from,
    to: o.to,
    search: o.search ? String(o.search).trim().slice(0, 100) : undefined,
    limit,
    offset,
    includeDeleted: !!o.includeDeleted,
  };
}
