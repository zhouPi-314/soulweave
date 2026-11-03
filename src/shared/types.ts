/**
 * SoulWeave 核心类型定义
 *
 * 严格对应 V1.7:
 * - D60 方案 D.1（任务归属、授权回复集合）
 * - D58（角色保护分层）
 * - D55（动态多角色）
 */

// ─── 角色 ───────────────────────────────────────────────

export type CharacterKind = 'local_dsh' | 'cloud_api';

/** D58：固定保护 ≠ 默认保护 */
export type ProtectionLevel =
  | 'fixed_protected'      // 冰糖：当前版本不可删除
  | 'default_protected'    // 小橘子：首期无永久删除入口
  | 'normal';              // 其他云端角色

export type CharacterState =
  | 'active' | 'sleeping' | 'trashed' | 'deleting' | 'deleted';

export interface Character {
  id: string;
  kind: CharacterKind;
  protection: ProtectionLevel;
  name: string;
  personaRef: string | null;
  voiceRef: string | null;
  avatarRef: string | null;
  state: CharacterState;
  createdAt: Date;
}

// ─── D60 方案 D.1：任务归属 ─────────────────────────────

/** 三类任务，来自 V1.7 D60.1 */
export type TaskOrigin =
  | 'user_direct'                  // 用户直接问答（含明确要求分别回答）
  | 'ai_autonomous'                // AI 自发接力
  | 'user_requested_discussion';   // 用户明确要求多角色讨论

export type TaskState =
  | 'created' | 'active' | 'completed' | 'cancelled' | 'expired';

/** 可信触发来源 —— 决定任务能否建立 */
export interface TrustedTrigger {
  /** 稳定事件 ID，用于幂等 */
  eventId: string;
  /** 入口：QQ / Desktop / Web */
  entry: 'qq' | 'desktop' | 'web';
  /** 原始用户消息 ID（不可伪造） */
  sourceMessageId: string;
  /** 会话绑定证据 */
  sessionBinding: string;
  /** 创建时间 */
  at: Date;
}

export interface ConversationTask {
  id: string;
  origin: TaskOrigin;
  state: TaskState;

  /** D.1-2：授权回复的角色集合 */
  authorizedResponders: string[];

  /** D.1-2：每角色授权回复步数（默认 1） */
  authorizedSteps: Record<string, number>;

  /** 关联的触发（user_direct / user_requested_discussion 必填） */
  trigger: TrustedTrigger | null;

  /** 父任务（复合指令场景，D60.1-A） */
  parentTaskId: string | null;

  /** 讨论/自主轮次的全局消息额度（所有角色合计） */
  globalQuota: number;

  /** 已发送条数（原子累加） */
  sentCount: number;

  /** 已用掉的授权步数 */
  usedSteps: Record<string, number>;

  createdAt: Date;
  expiresAt: Date | null;
}

// ─── D60：自主对话策略 ──────────────────────────────────

export type ConversationScene = 'qq_group' | 'desktop' | 'character_dm';

export interface AutonomousPolicy {
  scene: ConversationScene;
  /** 默认 6，范围 1–30 */
  maxMessagesPerRound: number;
  /** 冷却（秒） */
  cooldownSeconds: number;
  dailyMaxRounds: number;
  dailyMaxMessages: number;
  quietHours: { start: string; end: string } | null;
}

/** 单次讨论的额度范围（D.1-5） */
export const DISCUSSION_QUOTA_MIN = 1;
export const DISCUSSION_QUOTA_MAX = 30;
export const DEFAULT_QUOTA = 6;

// ─── 权限 ───────────────────────────────────────────────

/** L0–L5 动作分级（对应 V1.7 权限中心） */
export type ActionLevel = 'L0' | 'L1' | 'L2' | 'L3' | 'L4' | 'L5';

export interface PolicyDecision {
  allowed: boolean;
  level: ActionLevel;
  reason: string;
  requiresApproval: boolean;
}

// ─── 记忆 ───────────────────────────────────────────────

export type MemoryScope = 'private' | 'shared';

export interface MemoryRecord {
  id: string;
  ownerCharacter: string;
  scope: MemoryScope;
  sensitivity: number;
  content: string;
  embedding: number[] | null;
  createdAt: Date;
}

// ─── 审计 ───────────────────────────────────────────────

export interface AuditEvent {
  id: string;
  at: Date;
  actor: string;
  action: string;
  target: string | null;
  result: 'ok' | 'denied' | 'error';
  detail: Record<string, unknown>;
}
