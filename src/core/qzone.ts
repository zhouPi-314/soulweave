/**
 * SoulWeave S11：QQ 空间发布管线
 *
 * 一条动态的生命周期：
 *   draft（草稿）→ pending（待审，当 requireConfirm）→ approved → published
 *                                     ↘ rejected
 *   任何一步失败 → 回草稿，并保留原因
 *
 * 【为什么不直接发】
 * PRD：默认不执行未经配置的公开发布；每次发布可配为必须确认。
 * 所以「生成内容」和「发出去」必须是两个动作，中间有审批闸门。
 *
 * 【失败降级】
 * 未登录 / 接口异常 / 被风控时，不丢内容 —— 退回草稿箱并给出可复制的文本，
 * 用户可以自己去 QQ 手动发（PRD 明确的降级路径）。
 *
 * 本文件不直接调 QQ：发送能力通过 deps 注入，便于单测。
 */

import type { QzonePolicy, QzoneContentKind, QzoneRight } from './qzone-policy.js';
import {
  checkPublish, commitPublish, screenContent, DEFAULT_QZONE_POLICY,
  EMPTY_USAGE, RIGHT_LABELS, dayKey,
} from './qzone-policy.js';
import type { QzoneUsage } from './qzone-policy.js';

export type DraftState = 'draft' | 'pending' | 'published' | 'rejected' | 'failed';

export type QzoneDraft = {
  id: string;
  kind: QzoneContentKind;
  content: string;
  images: string[];
  right: QzoneRight;
  targetUins: string[];
  state: DraftState;
  createdAt: number;
  updatedAt: number;
  /** 审核/发布失败原因 */
  reason?: string;
  /** 发布成功后的 tid */
  tid?: string;
  publishedAt?: number;
};

export type QzoneStore = {
  version: 1;
  policy: QzonePolicy;
  usage: QzoneUsage;
  drafts: QzoneDraft[];
};

export function emptyStore(): QzoneStore {
  return { version: 1, policy: { ...DEFAULT_QZONE_POLICY }, usage: { ...EMPTY_USAGE }, drafts: [] };
}

/** 生成一个稳定的短 id（不用随机，便于测试复现） */
export function makeId(now: number, seq: number): string {
  return 'qz-' + now.toString(36) + '-' + seq;
}

export type PipelineDeps = {
  read: () => QzoneStore;
  write: (s: QzoneStore) => boolean | { ok: boolean; error?: string };
  /** 真正发到 QQ；返回 tid 或抛错 */
  send: (d: QzoneDraft) => Promise<{ tid: string }>;
  now?: () => number;
};

export type OpResult<T = unknown> =
  | ({ ok: true } & T)
  | { ok: false; error: string; degraded?: boolean; draftId?: string };

function clone<T>(v: T): T { try { return JSON.parse(JSON.stringify(v)); } catch { return v; } }

/** 新建草稿（不发送） */
export function createDraft(
  store: QzoneStore,
  input: { kind: QzoneContentKind; content: string; images?: string[]; right?: QzoneRight; targetUins?: string[] },
  now: number
): QzoneDraft {
  const seq = store.drafts.length + 1;
  const d: QzoneDraft = {
    id: makeId(now, seq),
    kind: input.kind,
    content: String(input.content || '').trim(),
    images: (input.images || []).slice(0, 9),   // QQ 空间单条最多 9 图
    right: input.right ?? store.policy.defaultRight,
    targetUins: input.targetUins ?? store.policy.targetUins.slice(),
    state: 'draft',
    createdAt: now,
    updatedAt: now,
  };
  return d;
}

/**
 * 提交：做策略检查。需要确认就进待审，否则直接发布。
 */
export async function submitDraft(draftId: string, deps: PipelineDeps): Promise<OpResult<{ state: DraftState; tid?: string }>> {
  const now = deps.now ? deps.now() : Date.now();
  const store = deps.read();
  const draft = store.drafts.find((d) => d.id === draftId);
  if (!draft) return { ok: false, error: '找不到该草稿' };
  if (draft.state === 'published') return { ok: false, error: '该动态已经发过了' };

  const scr = screenContent(draft.content);
  if (!scr.ok) return { ok: false, error: scr.reason || '内容未通过检查' };

  const chk = checkPublish(store.policy, {
    kind: draft.kind,
    content: draft.content,
    images: draft.images,
    right: draft.right,
    targetUins: draft.targetUins,
    now,
  }, store.usage);
  if (!chk.ok) {
    // 【降级】策略不通过不是错误，是要告诉用户为什么 + 保住内容
    return { ok: false, error: chk.reason, degraded: true, draftId };
  }

  if (store.policy.requireConfirm) {
    const next = clone(store);
    const d = next.drafts.find((x) => x.id === draftId)!;
    d.state = 'pending';
    d.updatedAt = now;
    if (!deps.write(next)) return { ok: false, error: '保存失败' };
    return { ok: true, state: 'pending' };
  }

  return await publishDraft(draftId, deps);
}

/** 审批通过 → 发布 */
export async function approveDraft(draftId: string, deps: PipelineDeps): Promise<OpResult<{ state: DraftState; tid?: string }>> {
  const now = deps.now ? deps.now() : Date.now();
  const store = deps.read();
  const draft = store.drafts.find((d) => d.id === draftId);
  if (!draft) return { ok: false, error: '找不到该草稿' };
  if (draft.state !== 'pending') return { ok: false, error: '只有待审的动态可以批准（当前：' + draft.state + '）' };

  // 审批时重新过一遍策略：等待期间可能已经超时/超限
  const chk = checkPublish(store.policy, {
    kind: draft.kind, content: draft.content, images: draft.images,
    right: draft.right, targetUins: draft.targetUins, now,
  }, store.usage);
  if (!chk.ok) return { ok: false, error: chk.reason, degraded: true, draftId };

  return await publishDraft(draftId, deps);
}

/** 驳回 */
export function rejectDraft(draftId: string, deps: PipelineDeps, reason = '人工驳回'): OpResult<{ state: DraftState }> {
  const now = deps.now ? deps.now() : Date.now();
  const store = deps.read();
  const draft = store.drafts.find((d) => d.id === draftId);
  if (!draft) return { ok: false, error: '找不到该草稿' };
  const next = clone(store);
  const d = next.drafts.find((x) => x.id === draftId)!;
  d.state = 'rejected';
  d.reason = reason;
  d.updatedAt = now;
  if (!deps.write(next)) return { ok: false, error: '保存失败' };
  return { ok: true, state: 'rejected' };
}

/**
 * 真正发布。
 * 失败不丢内容：状态退回 draft 并记原因（PRD 的「退化为草稿」）。
 */
export async function publishDraft(draftId: string, deps: PipelineDeps): Promise<OpResult<{ state: DraftState; tid?: string }>> {
  const now = deps.now ? deps.now() : Date.now();
  const store = deps.read();
  const draft = store.drafts.find((d) => d.id === draftId);
  if (!draft) return { ok: false, error: '找不到该草稿' };
  if (draft.state === 'published') return { ok: false, error: '该动态已经发过了' };

  let tid = '';
  try {
    const r = await deps.send(draft);
    tid = String((r && r.tid) || '');
    if (!tid) throw new Error('接口没有返回 tid');
  } catch (e) {
    const next = clone(store);
    const d = next.drafts.find((x) => x.id === draftId)!;
    d.state = 'failed';
    d.reason = '发送失败：' + String(e).slice(0, 200);
    d.updatedAt = now;
    deps.write(next);
    return { ok: false, error: d.reason, degraded: true, draftId };
  }

  const next = clone(store);
  const d = next.drafts.find((x) => x.id === draftId)!;
  d.state = 'published';
  d.tid = tid;
  d.publishedAt = now;
  d.updatedAt = now;
  delete d.reason;
  next.usage = commitPublish(next.usage, now);
  if (!deps.write(next)) return { ok: false, error: '发送成功但保存失败（tid=' + tid + '）' };
  return { ok: true, state: 'published', tid };
}

/**
 * 修改草稿内容。
 *
 * 【为什么需要】
 * 审批流程里最常见的情况不是「通过」或「驳回」，而是「改一下再发」。
 * 没有编辑能力，用户只能驳回再新建，草稿箱会堆垃圾。
 *
 * 只允许改 draft / failed / rejected 三种状态；待审的不能偷偷改内容
 * （否则等于绕过审批 —— 你批准的是 A，发出去的是 B）。
 */
export function updateDraft(
  draftId: string,
  patch: { content?: string; images?: string[]; right?: any; targetUins?: string[]; kind?: any },
  deps: Pick<PipelineDeps, 'read' | 'write' | 'now'>
): OpResult<{ draft: QzoneDraft }> {
  const now = deps.now ? deps.now() : Date.now();
  const store = deps.read();
  const idx = store.drafts.findIndex((d) => d.id === draftId);
  if (idx < 0) return { ok: false, error: '找不到该草稿' };
  const cur = store.drafts[idx];
  if (cur.state === 'published') return { ok: false, error: '已发布的动态不能修改' };
  if (cur.state === 'pending') return { ok: false, error: '待审的动态不能改内容（否则等于绕过审批），请先驳回再改' };

  const next = clone(store);
  const d = next.drafts[idx];
  if (patch.content !== undefined) {
    const c = String(patch.content).trim();
    if (!c && !(patch.images || d.images).length) return { ok: false, error: '内容与图片不能都为空' };
    if (c.length > 2000) return { ok: false, error: '正文过长（上限 2000 字）' };
    d.content = c;
  }
  if (patch.images !== undefined) d.images = (patch.images || []).slice(0, 9);
  if (patch.right !== undefined) d.right = patch.right;
  if (patch.targetUins !== undefined) d.targetUins = (patch.targetUins || []).slice();
  if (patch.kind !== undefined) d.kind = patch.kind;
  d.state = 'draft';
  d.updatedAt = now;
  delete d.reason;
  if (!deps.write(next)) return { ok: false, error: '保存失败' };
  return { ok: true, draft: d };
}

/** 把失败/驳回的草稿重新放回草稿箱 */
export function requeueDraft(draftId: string, deps: PipelineDeps): OpResult<{ state: DraftState }> {
  const now = deps.now ? deps.now() : Date.now();
  const store = deps.read();
  if (!store.drafts.some((d) => d.id === draftId)) return { ok: false, error: '找不到该草稿' };
  const next = clone(store);
  const d = next.drafts.find((x) => x.id === draftId)!;
  d.state = 'draft';
  d.updatedAt = now;
  delete d.reason;
  if (!deps.write(next)) return { ok: false, error: '保存失败' };
  return { ok: true, state: 'draft' };
}

/** 供 UI 展示：分组 + 一句话状态 */
export function summarize(store: QzoneStore): {
  draft: number; pending: number; published: number; rejected: number; failed: number;
  usage: { today: number; limit: number; lastAt: number };
  rightLabel: string;
} {
  const c = { draft: 0, pending: 0, published: 0, rejected: 0, failed: 0 };
  for (const d of store.drafts) c[d.state] = (c[d.state] || 0) + 1;
  // 当天计数：跨天就归零（不要拿昨天的用量吓用户）
  const today = store.usage.day === dayKey(Date.now()) ? store.usage.count : 0;
  return {
    ...c,
    usage: { today, limit: store.policy.dailyLimit, lastAt: store.usage.lastAt },
    rightLabel: RIGHT_LABELS[store.policy.defaultRight] || '未知',
  };
}
