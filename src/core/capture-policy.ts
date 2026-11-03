/*
 * SoulWeave S7：屏幕截图授权闸门
 *
 * 依据：
 *   01 需求 §3.2「视觉：用户发来的图片、**经明确授权的屏幕截图**；禁止默认持续截屏」
 *   01 需求 §7.5「权限在后端强制执行，不能仅靠提示词；**屏幕截图按需授权**」
 *   D31「用户主动上传图片与授权截图，**不持续抓屏**」
 *   路线图 S7 退出标准「**未授权不能截图** / 对外发布」
 *
 * 【这个文件为什么必须存在，而且必须先写】
 * 截图是整个应用里唯一「能看见用户屏幕上一切」的能力。
 * 一旦它出错，代价不是「功能不好用」，而是把密码、聊天记录、身份证照片送出去。
 * 所以：
 *   · 默认零授权（没授权就是拒绝，不是弹窗问）
 *   · 一次授权只对应一次截取（不存在「一直允许」的常驻模式）
 *   · 会话授权有硬过期时间，且应用退出即失效
 *   · 每次判定都留审计（允许也记，拒绝也记）
 *
 * 【纯函数】
 * 判定逻辑不碰 IO，这样才能把「过期 / 撤销 / 越权」这些分支全部穷举测试。
 */

// ─── 类型 ───────────────────────────────────────────

/**
 * 授权范围。
 *
 * 刻意**没有** 'always' / 'forever'：
 * 「一直允许截屏」等于持续抓屏，正是需求明令禁止的。
 */
export type CaptureScope =
  | 'once'      // 一次，用完即失效
  | 'session'   // 本次会话内有效，到期或应用退出即失效
  | 'denied';   // 明确拒绝，不再打扰

export const CAPTURE_SCOPES: CaptureScope[] = ['once', 'session', 'denied'];

/** 截什么 */
export type CaptureTargetKind = 'fullscreen' | 'window';

export interface CaptureGrant {
  /** 授权对象（角色） */
  ownerCharacter: string;
  scope: CaptureScope;
  /** 允许截取的范围 */
  targetKind: CaptureTargetKind;
  /** targetKind = window 时，允许的窗口 id（空数组 = 任意窗口） */
  windowIds?: string[];
  /** 授权时间（毫秒时间戳） */
  grantedAt: number;
  /** 过期时间；once 为 null（用掉即废），session 必须有值 */
  expiresAt: number | null;
  /** 已用次数（once 用掉一次就作废） */
  usedCount: number;
  /** 撤销时间 */
  revokedAt?: number | null;
}

export interface CaptureRequest {
  ownerCharacter: string;
  targetKind: CaptureTargetKind;
  /** targetKind = window 时必填 */
  windowId?: string;
  /** 当前时间（毫秒），由调用方注入便于测试 */
  now: number;
}

export type CaptureDecisionCode =
  | 'ALLOWED'          // 有有效授权
  | 'NO_GRANT'         // 从来没授权过
  | 'DENIED_BY_USER'   // 用户明确拒绝
  | 'EXPIRED'          // 会话授权过期
  | 'REVOKED'          // 被撤销
  | 'CONSUMED'         // 一次性授权已用完
  | 'TARGET_MISMATCH'  // 授权范围不含这个窗口
  | 'BAD_REQUEST';     // 请求本身非法

export interface CaptureDecision {
  allowed: boolean;
  code: CaptureDecisionCode;
  reason: string;
  /** 这次判定是否应该弹窗询问用户 */
  shouldAsk: boolean;
}

// ─── 常量 ───────────────────────────────────────────

/** 会话授权默认有效期：30 分钟（够一次调试，不足以被长期滥用） */
export const SESSION_TTL_MS = 30 * 60 * 1000;

/** 截图权限的动作名（配合 permission-engine 的 L3） */
export const CAPTURE_ACTION = 'media.capture';

// ─── 判定（纯函数，核心） ───────────────────────────

/**
 * 判断这次截图请求能不能放行。
 *
 * 判定顺序是刻意设计的：
 *   1. 请求本身合法吗（坏请求直接拒，不进入后续逻辑）
 *   2. 有授权记录吗（没有 → 不是拒绝，是「该问用户」）
 *   3. 用户明确拒绝过吗（拒绝优先于一切，连问都不该再问）
 *   4. 被撤销了吗
 *   5. 过期了吗
 *   6. 用完了吗
 *   7. 范围对得上吗
 */
export function evaluateCapture(
  req: CaptureRequest,
  grant: CaptureGrant | null | undefined,
): CaptureDecision {
  // 1. 请求合法性
  if (!req || !String(req.ownerCharacter || '').trim()) {
    return { allowed: false, code: 'BAD_REQUEST', reason: '缺少角色标识', shouldAsk: false };
  }
  if (req.targetKind !== 'fullscreen' && req.targetKind !== 'window') {
    return { allowed: false, code: 'BAD_REQUEST', reason: '截图范围非法', shouldAsk: false };
  }
  if (req.targetKind === 'window' && !String(req.windowId || '').trim()) {
    return { allowed: false, code: 'BAD_REQUEST', reason: '截窗口时必须指定窗口', shouldAsk: false };
  }
  const now = Number(req.now);
  if (!Number.isFinite(now) || now <= 0) {
    return { allowed: false, code: 'BAD_REQUEST', reason: '缺少有效时间', shouldAsk: false };
  }

  // 2. 没有授权记录 → 该问用户，不是「拒绝」
  if (!grant) {
    return {
      allowed: false, code: 'NO_GRANT',
      reason: '这个角色还没有截图授权',
      shouldAsk: true,
    };
  }

  // 3. 用户明确拒绝：永远不再问
  if (grant.scope === 'denied') {
    return {
      allowed: false, code: 'DENIED_BY_USER',
      reason: '你之前拒绝了这个角色的截图请求',
      shouldAsk: false,
    };
  }

  // 4. 撤销
  if (grant.revokedAt != null && Number(grant.revokedAt) > 0) {
    return {
      allowed: false, code: 'REVOKED',
      reason: '截图授权已被撤销',
      shouldAsk: true,
    };
  }

  // 5. 过期
  if (grant.expiresAt != null && Number(grant.expiresAt) <= now) {
    return {
      allowed: false, code: 'EXPIRED',
      reason: '截图授权已过期',
      shouldAsk: true,
    };
  }

  // 6. 一次性授权用完了吗
  if (grant.scope === 'once' && Number(grant.usedCount || 0) >= 1) {
    return {
      allowed: false, code: 'CONSUMED',
      reason: '这次授权已经用掉了，需要重新确认',
      shouldAsk: true,
    };
  }

  // 7. 范围是否覆盖
  if (grant.targetKind === 'window' && req.targetKind === 'fullscreen') {
    return {
      allowed: false, code: 'TARGET_MISMATCH',
      reason: '你只授权了单个窗口，不能截整个屏幕',
      shouldAsk: true,
    };
  }
  if (grant.targetKind === 'window' && req.targetKind === 'window') {
    const allowed = Array.isArray(grant.windowIds) ? grant.windowIds : [];
    if (allowed.length && !allowed.includes(String(req.windowId))) {
      return {
        allowed: false, code: 'TARGET_MISMATCH',
        reason: '这个窗口不在授权范围内',
        shouldAsk: true,
      };
    }
  }

  return { allowed: true, code: 'ALLOWED', reason: '已有有效授权', shouldAsk: false };
}

// ─── 授权构造与消费（纯函数） ───────────────────────

export interface NewGrantInput {
  ownerCharacter: string;
  scope: CaptureScope;
  targetKind: CaptureTargetKind;
  windowIds?: string[];
  now: number;
  /** 会话授权有效期，默认 SESSION_TTL_MS */
  ttlMs?: number;
}

/** 造一条新授权 */
export function makeGrant(input: NewGrantInput): CaptureGrant {
  const scope = CAPTURE_SCOPES.includes(input.scope) ? input.scope : 'once';
  const ttl = Number(input.ttlMs) > 0 ? Number(input.ttlMs) : SESSION_TTL_MS;
  return {
    ownerCharacter: String(input.ownerCharacter || '').trim(),
    scope,
    targetKind: input.targetKind === 'window' ? 'window' : 'fullscreen',
    windowIds: input.targetKind === 'window' ? (input.windowIds || []).map(String) : [],
    grantedAt: Number(input.now) || 0,
    // once 不设过期：它靠 usedCount 作废，而不是靠时间
    expiresAt: scope === 'session' ? (Number(input.now) || 0) + ttl : null,
    usedCount: 0,
    revokedAt: null,
  };
}

/**
 * 用掉一次授权。
 *
 * 只对 once / session 有意义：
 *   once    → usedCount+1，之后 evaluateCapture 会判 CONSUMED
 *   session → 也计数，但判定不看 usedCount（会话内可以多次）
 *   denied  → 不改
 */
export function consumeGrant(grant: CaptureGrant): CaptureGrant {
  if (!grant) return grant;
  if (grant.scope === 'denied') return { ...grant };
  return { ...grant, usedCount: Number(grant.usedCount || 0) + 1 };
}

/** 撤销授权（保留记录，审计要看） */
export function revokeGrant(grant: CaptureGrant, now: number): CaptureGrant {
  return { ...grant, revokedAt: Number(now) || 0 };
}

/** 应用退出时把会话授权全部作废（返回新数组） */
export function expireAllSessions(grants: CaptureGrant[]): CaptureGrant[] {
  return (grants || []).map((g) => (g.scope === 'session' ? { ...g, revokedAt: Number(g.revokedAt || 0) || 1 } : g));
}

// ─── 审计 ───────────────────────────────────────────

export interface CaptureAuditEntry {
  at: number;
  ownerCharacter: string;
  targetKind: CaptureTargetKind;
  windowId?: string;
  allowed: boolean;
  code: CaptureDecisionCode;
  reason: string;
  /** 截图产物的引用（没截成时为 null） */
  artifactRef: string | null;
}

/** 造一条审计（纯函数，便于断言字段齐全） */
export function makeAudit(req: CaptureRequest, decision: CaptureDecision, artifactRef: string | null): CaptureAuditEntry {
  return {
    at: Number(req.now) || 0,
    ownerCharacter: String(req.ownerCharacter || ''),
    targetKind: req.targetKind,
    windowId: req.windowId ? String(req.windowId) : undefined,
    allowed: !!decision.allowed,
    code: decision.code,
    reason: decision.reason,
    artifactRef: artifactRef || null,
  };
}

/** 审计里是否含有敏感内容（供发布前隐私审查用） */
export function auditLooksClean(entry: CaptureAuditEntry): boolean {
  const blob = JSON.stringify(entry);
  // 审计只该记「谁、何时、能不能截」，不该记图片内容本身
  return !/data:image|base64|iVBORw0KGgo/.test(blob);
}
