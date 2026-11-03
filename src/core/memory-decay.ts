/**
 * SoulWeave S4：记忆衰减与清理
 *
 * 【策略（用户已确认，写在 src/shared/memory-policy.json）】
 *   · 原始消息：180 天后删除
 *   · 普通记忆：半衰期 90 天（strength = importance × 0.5^(闲置天数/90)）
 *   · 冷却区：strength 0.15–0.4
 *   · 淡忘：闲置 ≥ 90 天且 strength < 0.15 → 软删除（可恢复）
 *   · 淡忘后保留 180 天 → 硬删除
 *   · 永不遗忘：用户标记 / 第一次事件 / 未解决冲突 / 人设记忆
 *   · 软上限：20000 条
 *
 * 【为什么把 strength 写回 importance】
 * 衰减要有实际效果：检索是按 importance 排序的，
 * 如果只在查的时候临时算，排序就用不上。
 * 所以每个周期把算出来的 strength 写回 importance（只降不升）。
 *
 * 【为什么先软删除再硬删除】
 * 软删除可恢复，用户误伤还能救。180 天之后才真正消失。
 */

import type { MemoryRepository } from './memory-repository.js';

export interface DecayPolicy {
  rawMessageDays: number;
  ordinaryHalfLifeDays: number;
  coldStrengthRange: [number, number];
  fadedIdleDays: number;
  fadedKeepDays: number;
  softCapMemories: number;
  /**
   * 增量扫描窗口（小时）。
   * 只有「上次复核时间早于这么久之前」或「从未复核过」的记忆才参与本轮计算。
   * 设为 0 表示每轮全表扫描（数据量小时无所谓，大了会慢）。
   */
  scanWindowHours: number;
}

/** 与 src/shared/memory-policy.json 保持一致的默认值 */
export const DEFAULT_DECAY: DecayPolicy = {
  rawMessageDays: 180,
  ordinaryHalfLifeDays: 90,
  coldStrengthRange: [0.15, 0.4],
  fadedIdleDays: 90,
  fadedKeepDays: 180,
  softCapMemories: 20000,
  scanWindowHours: 6,
};

/** 永不遗忘的最低重要度（覆盖 first_time=0.95 与 explicit_remember=1.0） */
export const NEVER_FORGET_IMPORTANCE = 0.95;

export type MemoryLifecycle = 'active' | 'cold' | 'faded' | 'expired';

export interface MemoryDecayRow {
  id: string;
  importance: number;
  created_at: string;
  last_accessed_at: string | null;
  deleted_at: string | null;
  source: string | null;
  pinned?: boolean;
}

export interface DecayPlanItem {
  id: string;
  from: number;
  to: number;
  idleDays: number;
  state: MemoryLifecycle;
  reason: string;
}

export interface DecayResult {
  ok: boolean;
  dryRun: boolean;
  scanned: number;
  decayed: number;
  faded: number;
  hardDeleted: number;
  messagesDeleted: number;
  overCap: number;
  protectedCount: number;
  /** 因未解决冲突而被保护的条数 */
  conflictProtected?: number;
  /** 本轮参与计算的行数（增量扫描后的） */
  scanWindowHours?: number;
  ms?: number;
  items?: DecayPlanItem[];
  error?: string;
}

function daysSince(iso: string | null, now: Date): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  if (!isFinite(t)) return 0;
  return Math.max(0, (now.getTime() - t) / 86400000);
}

/** 计算衰减后的强度 */
export function decayStrength(importance: number, idleDays: number, halfLifeDays: number): number {
  const imp = Number(importance) || 0;
  const hl = halfLifeDays > 0 ? halfLifeDays : 90;
  return imp * Math.pow(0.5, idleDays / hl);
}

/** 判定生命周期状态 */
export function classify(strength: number, idleDays: number, policy: DecayPolicy): MemoryLifecycle {
  const [coldLow, coldHigh] = policy.coldStrengthRange;
  if (strength < coldLow && idleDays >= policy.fadedIdleDays) return 'faded';
  if (strength < coldHigh) return 'cold';
  return 'active';
}

/** 是否受保护（永不遗忘） */
export function isProtected(row: MemoryDecayRow): boolean {
  // 用户主动标记 —— 最高优先级，明确表达「别忘」
  if (row.pinned === true) return true;
  const src = String(row.source || '');
  if (src === 'user_marked' || src === 'persona' || src === 'first_time_event') return true;
  if (Number(row.importance) >= NEVER_FORGET_IMPORTANCE) return true;
  return false;
}

export interface RunDecayOptions {
  dryRun?: boolean;
  /** 只处理某个角色（不传则全部） */
  ownerCharacter?: string;
  policy?: Partial<DecayPolicy>;
  /** 预览时最多返回多少条明细 */
  previewLimit?: number;
}

/**
 * 执行一个衰减周期。
 * dryRun=true 时只计算不写入，用于界面预览。
 */
export async function runDecay(
  repo: MemoryRepository,
  opts: RunDecayOptions = {}
): Promise<DecayResult> {
  const t0 = Date.now();
  const policy: DecayPolicy = { ...DEFAULT_DECAY, ...(opts.policy || {}) };
  const now = new Date();
  const dry = opts.dryRun === true;

  const ownerFilter = opts.ownerCharacter
    ? " AND owner_character = '" + String(opts.ownerCharacter).replace(/'/g, "''") + "'::uuid"
    : '';

  // 1) 取需要复核的记忆（增量：只取到了复核时间的行）
  const dueCond = policy.scanWindowHours > 0
    ? " AND (decay_at IS NULL OR decay_at < now() - interval '" + Math.round(policy.scanWindowHours) + " hours')"
    : '';
  const q = await repo.exec(
    "SELECT id, importance, created_at, last_accessed_at, deleted_at, source, pinned, decay_at " +
    "FROM memories WHERE TRUE" + ownerFilter + dueCond);
  if (!q.ok) return { ok: false, dryRun: dry, scanned: 0, decayed: 0, faded: 0, hardDeleted: 0, messagesDeleted: 0, overCap: 0, protectedCount: 0, error: q.error };

  const rows: MemoryDecayRow[] = (q.rows || []).map((x: any) => ({
    ...x, importance: Number(x.importance) || 0,
  }));

  // 「未解决冲突」的记忆受保护 —— 冲突没定论就删掉，等于替用户做了决定
  const conflictIds = opts.ownerCharacter
    ? await repo.pendingConflictMemoryIds(opts.ownerCharacter)
    : new Set<string>();

  const live = rows.filter((r) => !r.deleted_at);
  const softDeleted = rows.filter((r) => !!r.deleted_at);

  const items: DecayPlanItem[] = [];
  /** 本轮评估过的所有记忆 id —— 含受保护的，它们也要打上「已复核」时间戳 */
  const evaluated: string[] = [];
  let protectedCount = 0;
  const updates: Array<{ id: string; importance: number }> = [];
  const toFade: string[] = [];

  for (const r of live) {
    evaluated.push(r.id);
    if (isProtected(r) || conflictIds.has(r.id)) { protectedCount++; continue; }
    const base = r.last_accessed_at || r.created_at;
    const idleDays = daysSince(base, now);
    const strength = decayStrength(r.importance, idleDays, policy.ordinaryHalfLifeDays);
    const state = classify(strength, idleDays, policy);
    if (state === 'faded') {
      toFade.push(r.id);
      items.push({ id: r.id, from: r.importance, to: strength, idleDays, state, reason: '闲置 ' + Math.round(idleDays) + ' 天，强度降到 ' + strength.toFixed(3) });
    } else if (Math.abs(strength - r.importance) >= 0.01) {
      updates.push({ id: r.id, importance: strength });
      items.push({ id: r.id, from: r.importance, to: strength, idleDays, state, reason: '衰减' });
    }
  }

  // 2) 硬删除：软删除超过保留期的
  const hardCutoff = policy.fadedIdleDays + policy.fadedKeepDays;
  const toHardDelete = softDeleted
    .filter((r) => !isProtected(r) && !conflictIds.has(r.id))
    .filter((r) => daysSince(r.deleted_at, now) >= hardCutoff)
    .map((r) => r.id);

  // 3) 软上限：超出则按强度最低的非保护记忆淡忘
  let overCap = 0;
  const liveAfter = live.length - toFade.length;
  if (policy.softCapMemories > 0 && liveAfter > policy.softCapMemories) {
    overCap = liveAfter - policy.softCapMemories;
    const candidates = live
      .filter((r) => !isProtected(r) && !toFade.includes(r.id))
      .sort((a, b) => a.importance - b.importance)
      .slice(0, overCap);
    for (const c of candidates) toFade.push(c.id);
  }

  // 4) 原始消息清理（180 天）
  const msgCut = await repo.exec(
    "SELECT COUNT(*)::int AS n FROM messages WHERE created_at < now() - interval '" +
    String(Math.round(policy.rawMessageDays)) + " days'" + ownerFilter.replace('owner_character', 'character_id'));
  const messagesToDelete = (msgCut.rows || [])[0] ? Number((msgCut.rows || [])[0].n) || 0 : 0;

  const result: DecayResult = {
    ok: true, dryRun: dry, scanned: rows.length,
    decayed: updates.length, faded: toFade.length,
    hardDeleted: toHardDelete.length, messagesDeleted: messagesToDelete,
    overCap, protectedCount, conflictProtected: conflictIds.size,
    scanWindowHours: policy.scanWindowHours, ms: Date.now() - t0,
    items: items.slice(0, opts.previewLimit ?? 20),
  };

  if (dry) return result;

  // 5) 落库
  // 先把所有评估过的行标记为「已复核」—— 包括受保护的行。
  // 否则它们的 decay_at 永远是 NULL，增量扫描每轮都会重新捞它们，增量就形同虚设。
  if (evaluated.length) {
    const list = evaluated.map((id) => "'" + String(id).replace(/'/g, "''") + "'").join(',');
    await repo.exec("UPDATE memories SET decay_at = now() WHERE id = ANY(ARRAY[" + list + "]::uuid[]) RETURNING 1");
  }
  for (const u of updates) {
    await repo.exec(
      "UPDATE memories SET importance = :'imp'::real, decay_at = now() WHERE id = :'id'::uuid",
      { imp: Math.max(0, Math.round(u.importance * 10000) / 10000), id: u.id });
  }
  if (toFade.length) {
    const list = toFade.map((id) => "'" + String(id).replace(/'/g, "''") + "'").join(',');
    await repo.exec("UPDATE memories SET deleted_at = now() WHERE id = ANY(ARRAY[" + list + "]::uuid[]) AND deleted_at IS NULL RETURNING 1");
  }
  if (toHardDelete.length) {
    const list = toHardDelete.map((id) => "'" + String(id).replace(/'/g, "''") + "'").join(',');
    await repo.exec("DELETE FROM memories WHERE id = ANY(ARRAY[" + list + "]::uuid[]) RETURNING 1");
  }
  if (messagesToDelete > 0) {
    await repo.exec(
      "DELETE FROM messages WHERE created_at < now() - interval '" +
      String(Math.round(policy.rawMessageDays)) + " days'" + ownerFilter.replace('owner_character', 'character_id'));
  }

  result.ms = Date.now() - t0;
  return result;
}
