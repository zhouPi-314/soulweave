/*
 * SoulWeave S5：自主连续消息（AI 自发接力）
 *
 * 这是 S5 里**最容易失控**的部分。规划里的约束（原文）：
 *   - D60：自主连续消息默认 6 条，可配 1–30
 *   - Gate J：AI 自发消息不重新触发自己；正确计数；预算/冷却/日上限生效
 *   - 退出标准：无互聊循环
 *
 * 【为什么需要单独一层】
 * TaskMachine 只管「这个任务还能发几条」。但自主消息真正的风险是
 * **A 说话 → 触发 B → B 说话 → 触发 A → …** 的无限接力。
 * 那个循环不在 TaskMachine 的视野里，必须在源头切断。
 *
 * 【三条切断线】
 * 1. **来源标记**：AI 发的消息带标记，入站时一律不算可信触发。
 * 2. **接力深度**：一条消息最多接力 N 代，超过就停。
 * 3. **回合额度**：一轮最多 6 条（可配），发完这一轮就结束，不会自动开新轮。
 */

import type { ConversationScene } from '../shared/types.js';
import { DISCUSSION_QUOTA_MIN, DISCUSSION_QUOTA_MAX, DEFAULT_QUOTA } from '../shared/types.js';

/** 零宽空格：用户看不见，但回环时能识别 */
export const AI_ORIGIN_MARK = String.fromCharCode(0x200b);

export interface AutonomousLimits {
  maxMessagesPerRound: number;
  cooldownSeconds: number;
  dailyMaxRounds: number;
  dailyMaxMessages: number;
  quietHours: { start: string; end: string } | null;
  /** 最大接力深度：一条消息最多引发几代 AI 发言 */
  maxRelayDepth: number;
}

export const DEFAULT_AUTONOMOUS_LIMITS: AutonomousLimits = {
  maxMessagesPerRound: DEFAULT_QUOTA,
  cooldownSeconds: 60,
  dailyMaxRounds: 100,
  dailyMaxMessages: 300,
  quietHours: null,
  maxRelayDepth: 1,
};

export function limitsForScene(
  scene: ConversationScene,
  overrides?: Partial<Record<ConversationScene, Partial<AutonomousLimits>>>,
  base: AutonomousLimits = DEFAULT_AUTONOMOUS_LIMITS,
): AutonomousLimits {
  const o = (overrides && overrides[scene]) || {};
  return { ...base, ...o };
}

/** 校验额度范围（D.1-5：1–30，超范围拒绝而不是截断） */
export function validateQuota(n: unknown): { ok: boolean; quota: number; error?: string } {
  const v = Number(n);
  if (!Number.isFinite(v) || Math.floor(v) !== v) {
    return { ok: false, quota: DEFAULT_QUOTA, error: '额度必须是整数' };
  }
  if (v < DISCUSSION_QUOTA_MIN || v > DISCUSSION_QUOTA_MAX) {
    return {
      ok: false, quota: DEFAULT_QUOTA,
      error: '额度必须在 ' + DISCUSSION_QUOTA_MIN + '–' + DISCUSSION_QUOTA_MAX + ' 之间，收到 ' + v,
    };
  }
  return { ok: true, quota: v };
}

/** 判断当前是否在安静时段（支持跨午夜，如 23:00–07:00） */
export function inQuietHours(now: Date, quiet: { start: string; end: string } | null): boolean {
  if (!quiet) return false;
  const parse = (s: string): number | null => {
    const m = String(s || '').match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    const h = parseInt(m[1], 10); const mi = parseInt(m[2], 10);
    if (h > 23 || mi > 59) return null;
    return h * 60 + mi;
  };
  const s = parse(quiet.start); const e = parse(quiet.end);
  if (s === null || e === null) return false;
  const cur = now.getHours() * 60 + now.getMinutes();
  if (s <= e) return cur >= s && cur < e;
  return cur >= s || cur < e;
}

export type RoundState = 'idle' | 'active' | 'completed' | 'cancelled';

export interface AutonomousRound {
  id: string;
  scene: ConversationScene;
  conversationKey: string;
  accountLabel: string;
  state: RoundState;
  quota: number;
  sent: number;
  relayDepth: number;
  startedAt: number;
  lastSentAt: number;
}

export interface AutonomousDailyState {
  date: string;
  rounds: number;
  messages: number;
}

export type StartRoundVerdict =
  | { ok: true; round: AutonomousRound }
  | { ok: false; reason: string; code: 'QUIET_HOURS' | 'DAILY_ROUNDS' | 'DAILY_MESSAGES' | 'COOLDOWN' | 'BAD_QUOTA' | 'DEPTH_EXCEEDED' };

let roundSeq = 0;
function nextRoundId(): string {
  return 'auto-' + Date.now().toString(36) + '-' + (++roundSeq).toString(36);
}

function todayKey(now: number): string {
  const d = new Date(now);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

export class AutonomousEngine {
  private rounds = new Map<string, AutonomousRound>();
  private daily = new Map<string, AutonomousDailyState>();
  private lastRoundEnd = new Map<string, number>();

  startRound(input: {
    scene: ConversationScene;
    conversationKey: string;
    accountLabel: string;
    quota?: number;
    relayDepth?: number;
    limits: AutonomousLimits;
    now?: number;
  }): StartRoundVerdict {
    const now = input.now ?? Date.now();
    const lim = input.limits;
    const relayDepth = Math.max(0, Math.floor(input.relayDepth ?? 0));

    if (relayDepth > lim.maxRelayDepth) {
      return {
        ok: false, code: 'DEPTH_EXCEEDED',
        reason: '接力深度 ' + relayDepth + ' 超过上限 ' + lim.maxRelayDepth + '（防止互聊循环）',
      };
    }

    if (inQuietHours(new Date(now), lim.quietHours)) {
      return { ok: false, code: 'QUIET_HOURS', reason: '当前在安静时段，不主动开口' };
    }

    const q = validateQuota(input.quota ?? lim.maxMessagesPerRound);
    if (!q.ok) return { ok: false, code: 'BAD_QUOTA', reason: q.error || '额度不合法' };

    const dayKey = input.accountLabel + '|' + input.scene;
    let st = this.daily.get(dayKey);
    if (!st || st.date !== todayKey(now)) {
      st = { date: todayKey(now), rounds: 0, messages: 0 };
      this.daily.set(dayKey, st);
    }
    if (st.rounds >= lim.dailyMaxRounds) {
      return {
        ok: false, code: 'DAILY_ROUNDS',
        reason: '今日轮次已达上限 (' + st.rounds + '/' + lim.dailyMaxRounds + ')',
      };
    }
    if (st.messages >= lim.dailyMaxMessages) {
      return {
        ok: false, code: 'DAILY_MESSAGES',
        reason: '今日消息已达上限 (' + st.messages + '/' + lim.dailyMaxMessages + ')',
      };
    }

    const lastEnd = this.lastRoundEnd.get(input.conversationKey);
    if (lastEnd !== undefined && lim.cooldownSeconds > 0) {
      const elapsed = (now - lastEnd) / 1000;
      if (elapsed < lim.cooldownSeconds) {
        const wait = Math.ceil(lim.cooldownSeconds - elapsed);
        return {
          ok: false, code: 'COOLDOWN',
          reason: '上一轮结束才 ' + Math.floor(elapsed) + ' 秒，还需 ' + wait + ' 秒',
        };
      }
    }

    const round: AutonomousRound = {
      id: nextRoundId(),
      scene: input.scene,
      conversationKey: input.conversationKey,
      accountLabel: input.accountLabel,
      state: 'active',
      quota: q.quota,
      sent: 0,
      relayDepth,
      startedAt: now,
      lastSentAt: 0,
    };
    this.rounds.set(round.id, round);
    st.rounds++;
    return { ok: true, round };
  }

  recordSend(roundId: string, now = Date.now()): { ok: boolean; finished: boolean; reason?: string } {
    const r = this.rounds.get(roundId);
    if (!r) return { ok: false, finished: true, reason: '轮次不存在' };
    if (r.state !== 'active') return { ok: false, finished: true, reason: '轮次已结束' };

    r.sent++;
    r.lastSentAt = now;

    const st = this.daily.get(r.accountLabel + '|' + r.scene);
    if (st) st.messages++;

    if (r.sent >= r.quota) {
      r.state = 'completed';
      this.lastRoundEnd.set(r.conversationKey, now);
      return { ok: true, finished: true, reason: '本轮额度已用完 (' + r.sent + '/' + r.quota + ')' };
    }
    return { ok: true, finished: false };
  }

  endRound(roundId: string, state: 'completed' | 'cancelled' = 'cancelled', now = Date.now()): void {
    const r = this.rounds.get(roundId);
    if (!r || r.state !== 'active') return;
    r.state = state;
    this.lastRoundEnd.set(r.conversationKey, now);
  }

  shrinkQuota(roundId: string, newQuota: number): { ok: boolean; remaining: number; finished: boolean } {
    const r = this.rounds.get(roundId);
    if (!r || r.state !== 'active') return { ok: false, remaining: 0, finished: true };
    const v = validateQuota(newQuota);
    if (!v.ok) return { ok: false, remaining: Math.max(0, r.quota - r.sent), finished: false };
    r.quota = Math.min(r.quota, v.quota);
    const remaining = Math.max(0, r.quota - r.sent);
    if (remaining === 0) {
      r.state = 'completed';
      this.lastRoundEnd.set(r.conversationKey, Date.now());
      return { ok: true, remaining: 0, finished: true };
    }
    return { ok: true, remaining, finished: false };
  }

  getRound(roundId: string): AutonomousRound | undefined {
    const r = this.rounds.get(roundId);
    return r ? { ...r } : undefined;
  }

  activeRounds(): AutonomousRound[] {
    return [...this.rounds.values()].filter(r => r.state === 'active').map(r => ({ ...r }));
  }

  usage(accountLabel: string, scene: ConversationScene, now = Date.now()): AutonomousDailyState {
    const st = this.daily.get(accountLabel + '|' + scene);
    if (!st || st.date !== todayKey(now)) return { date: todayKey(now), rounds: 0, messages: 0 };
    return { ...st };
  }

  prune(olderThanMs = 3600_000, now = Date.now()): number {
    let n = 0;
    for (const [id, r] of this.rounds) {
      if (r.state !== 'active' && now - r.startedAt > olderThanMs) {
        this.rounds.delete(id);
        n++;
      }
    }
    return n;
  }
}

/** 给 AI 发的消息打标记 */
export function markAiOrigin(text: string): string {
  return AI_ORIGIN_MARK + String(text || '');
}

/** 判断一条消息是不是 AI 自己发的（回环识别） */
export function isAiOrigin(text: string): boolean {
  return String(text || '').startsWith(AI_ORIGIN_MARK);
}

/** 去掉标记，得到真正的文本 */
export function stripAiOrigin(text: string): string {
  const s = String(text || '');
  return s.startsWith(AI_ORIGIN_MARK) ? s.slice(AI_ORIGIN_MARK.length) : s;
}

/** 计算一条入站消息的接力深度 */
export function computeRelayDepth(
  text: string,
  previousDepth: number | null,
  maxRelayDepth: number,
): number {
  if (!isAiOrigin(text)) return 0;
  if (previousDepth === null) return maxRelayDepth + 1;
  return previousDepth + 1;
}
