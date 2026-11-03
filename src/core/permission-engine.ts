/**
 * 权限引擎 L0–L5
 *
 * V1.7 要求：
 * - 工具权限与聊天文本解耦（角色不能通过提示词授予自己权限）
 * - deny-by-default：未知动作默认最高风险
 * - 请求 → 身份/范围/风险校验 → 规则决定 → 审批 → 执行 → 审计
 *
 * 分级依据：影响范围 × 可逆性 × 外泄风险
 */

import type { ActionLevel, PolicyDecision } from '../shared/types.js';

/**
 * L0 — 纯读取，无副作用
 *   例：读自己的配置、读公开信息、渲染 Live2D
 *
 * L1 — 本机低风险写入，可撤销
 *   例：写自己的记忆、改自己的音量、切换表情
 *
 * L2 — 本机中等风险
 *   例：写共享记忆、发起网络请求、读用户指定文件
 *
 * L3 — 本机高风险 / 外部副作用
 *   例：执行 shell 命令、读写任意文件、安装组件
 *
 * L4 — 对外发布 / 涉及第三方
 *   例：发 QQ 消息、发布空间动态、加好友
 *
 * L5 — 不可逆 / 涉及凭据或资金
 *   例：删除角色数据、修改 API 密钥、产生费用、卸载
 */
export type { ActionLevel };

export interface ActionRequest {
  /** 动作标识，如 'memory.write.private' */
  action: string;
  /** 发起角色 */
  actorId: string;
  /** 目标资源 */
  target?: string;
  /** 动作参数（用于规则匹配，不用于权限判定） */
  payload?: Record<string, unknown>;
}

export interface ActionRule {
  /** 动作前缀匹配，如 'memory.write' 匹配 'memory.write.private' */
  pattern: string;
  level: ActionLevel;
  /** 是否需要用户显式批准 */
  requiresApproval: boolean;
  /** 说明 */
  description: string;
}

/** 默认规则表 —— deny-by-default 的兜底 */
const DEFAULT_RULES: ActionRule[] = [
  // L0 纯读
  { pattern: 'config.read',        level: 'L0', requiresApproval: false, description: '读取自己的配置' },
  { pattern: 'character.read',     level: 'L0', requiresApproval: false, description: '读取角色信息' },
  { pattern: 'live2d.render',      level: 'L0', requiresApproval: false, description: '渲染 Live2D' },
  { pattern: 'voice.list',         level: 'L0', requiresApproval: false, description: '列出可用音色' },

  // L1 本机低风险
  { pattern: 'memory.write.private', level: 'L1', requiresApproval: false, description: '写自己的私有记忆' },
  { pattern: 'character.self.update', level: 'L1', requiresApproval: false, description: '更新自己的非关键设置' },
  { pattern: 'voice.play',         level: 'L1', requiresApproval: false, description: '播放语音' },

  // L2 本机中等
  { pattern: 'memory.write.shared', level: 'L2', requiresApproval: true,  description: '写共享记忆' },
  { pattern: 'memory.read.other',   level: 'L2', requiresApproval: true,  description: '读取其他角色的记忆' },
  { pattern: 'network.request',     level: 'L2', requiresApproval: false, description: '发起网络请求' },
  { pattern: 'file.read.user',      level: 'L2', requiresApproval: true,  description: '读取用户指定文件' },

  // L3 本机高风险
  { pattern: 'shell.execute',       level: 'L3', requiresApproval: true,  description: '执行 shell 命令' },
  { pattern: 'file.write.any',      level: 'L3', requiresApproval: true,  description: '写入任意文件' },
  { pattern: 'component.install',   level: 'L3', requiresApproval: true,  description: '安装组件' },

  // L4 对外
  { pattern: 'qq.send.message',     level: 'L4', requiresApproval: true,  description: '发送 QQ 消息' },
  { pattern: 'qq.add.friend',       level: 'L4', requiresApproval: true,  description: '添加 QQ 好友' },
  { pattern: 'social.publish',      level: 'L4', requiresApproval: true,  description: '发布社交动态' },

  // L5 不可逆
  { pattern: 'character.purge',     level: 'L5', requiresApproval: true,  description: '永久删除角色' },
  { pattern: 'secret.read',         level: 'L5', requiresApproval: true,  description: '读取密钥' },
  { pattern: 'secret.write',        level: 'L5', requiresApproval: true,  description: '修改密钥' },
  { pattern: 'billing.spend',       level: 'L5', requiresApproval: true,  description: '产生费用' },
];

/** 未知动作的默认等级 —— deny-by-default */
const UNKNOWN_LEVEL: ActionLevel = 'L5';

export interface PermissionEngineOptions {
  rules?: ActionRule[];
  /** 角色级许可白名单：某角色额外允许的动作前缀 */
  grants?: Record<string, string[]>;
  /** 角色级禁令：优先级高于 grants */
  denies?: Record<string, string[]>;
}

export class PermissionEngine {
  private rules: ActionRule[];
  private grants: Record<string, string[]>;
  private denies: Record<string, string[]>;

  constructor(opts: PermissionEngineOptions = {}) {
    this.rules = opts.rules ?? DEFAULT_RULES;
    this.grants = opts.grants ?? {};
    this.denies = opts.denies ?? {};
  }

  /**
   * 判定一个动作。
   *
   * 顺序（V1.7 强制）：
   * 1. 角色禁令（最高优先级）
   * 2. 规则匹配
   * 3. 角色许可
   * 4. 未知 → L5
   */
  evaluate(req: ActionRequest): PolicyDecision {
    // 1. 显式禁令
    if (this.matchAny(this.denies[req.actorId], req.action)) {
      return {
        allowed: false,
        level: UNKNOWN_LEVEL,
        reason: '角色 ' + req.actorId + ' 被明确禁止执行 ' + req.action,
        requiresApproval: false,
      };
    }

    // 2. 规则匹配（最长前缀优先）
    const rule = this.findRule(req.action);

    if (!rule) {
      // 4. 未知动作
      return {
        allowed: false,
        level: UNKNOWN_LEVEL,
        reason: '未知动作 "' + req.action + '"，按 deny-by-default 拒绝。' +
                '如需允许，请显式添加规则。',
        requiresApproval: false,
      };
    }

    // 3. 角色许可可以降低审批要求（但不能跨级放行 L4/L5）
    const granted = this.matchAny(this.grants[req.actorId], req.action);
    const needsApproval = rule.requiresApproval && !(granted && this.isGrantable(rule.level));

    return {
      allowed: true,
      level: rule.level,
      reason: rule.description,
      requiresApproval: needsApproval,
    };
  }

  /** 取动作的等级（不判定权限） */
  levelOf(action: string): ActionLevel {
    return this.findRule(action)?.level ?? UNKNOWN_LEVEL;
  }

  /** 列出所有规则（供 UI 展示） */
  listRules(): ActionRule[] {
    return [...this.rules];
  }

  // ── 内部 ────────────────────────────────────────

  private findRule(action: string): ActionRule | undefined {
    // 最长前缀匹配
    let best: ActionRule | undefined;
    for (const r of this.rules) {
      if (action === r.pattern || action.startsWith(r.pattern + '.')) {
        if (!best || r.pattern.length > best.pattern.length) best = r;
      }
    }
    return best;
  }

  private matchAny(patterns: string[] | undefined, action: string): boolean {
    if (!patterns) return false;
    return patterns.some(p => action === p || action.startsWith(p + '.'));
  }

  /** 只有 L0–L3 可被角色级许可豁免审批 */
  private isGrantable(level: ActionLevel): boolean {
    return level === 'L0' || level === 'L1' || level === 'L2' || level === 'L3';
  }
}
