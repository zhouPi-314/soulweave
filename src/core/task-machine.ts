/**
 * D.1 任务归属状态机
 *
 * V1.7 D60.25–D60.33 的强制实现。
 *
 * 核心规则：
 * 1. 只有可信用户触发能创建 user_direct / user_requested_discussion
 * 2. AI 自发消息一律进入 ai_autonomous，即使直接任务未结束
 * 3. 讨论额度 1–30，所有角色合计
 * 4. 禁止自动拆分、自动续轮
 */

import type {
  ConversationTask, TaskOrigin, TrustedTrigger, Character
} from '../shared/types.js';
import {
  DISCUSSION_QUOTA_MIN, DISCUSSION_QUOTA_MAX, DEFAULT_QUOTA
} from '../shared/types.js';

export class TaskMachineError extends Error {
  constructor(
    public readonly code:
      | 'QUOTA_OUT_OF_RANGE'
      | 'NO_TRUSTED_TRIGGER'
      | 'NOT_AUTHORIZED_RESPONDER'
      | 'TASK_NOT_ACTIVE'
      | 'QUOTA_EXHAUSTED'
      | 'STEP_EXHAUSTED'
      | 'CANNOT_SELF_EXTEND',
    message: string
  ) { super(message); this.name = 'TaskMachineError'; }
}

export interface SendReceipt {
  taskId: string;
  characterId: string;
  /** 预留后的全局计数快照 */
  seq: number;
  at: Date;
}

export type SendVerdict =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string; code: string };

export interface CreateDirectTaskInput {
  trigger: TrustedTrigger;
  authorizedResponders: string[];
  /** 每角色授权步数，默认 1 */
  stepsPerResponder?: number;
  /** 任务超时（毫秒），默认 5 分钟 */
  timeoutMs?: number;
}

export interface CreateDiscussionTaskInput {
  trigger: TrustedTrigger;
  participants: string[];
  /** 用户指定的讨论长度；未指定用默认 */
  quota?: number;
  timeoutMs?: number;
}

let seq = 0;
function nextId(prefix: string): string {
  return prefix + '-' + Date.now().toString(36) + '-' + (++seq).toString(36);
}

export class TaskMachine {
  private tasks = new Map<string, ConversationTask>();

  // ── 创建 ──────────────────────────────────────────

  /**
   * 创建 user_direct 任务。
   *
   * D.1-1：必须有可信触发，且触发必须来自用户入口。
   */
  createDirectTask(input: CreateDirectTaskInput): ConversationTask {
    this.assertTrusted(input.trigger);

    const steps = input.stepsPerResponder ?? 1;
    if (steps < 1) {
      throw new TaskMachineError('STEP_EXHAUSTED', '授权步数必须 >= 1');
    }

    const task: ConversationTask = {
      id: nextId('task-direct'),
      origin: 'user_direct',
      state: 'active',
      authorizedResponders: [...input.authorizedResponders],
      authorizedSteps: Object.fromEntries(
        input.authorizedResponders.map(r => [r, steps])
      ),
      trigger: input.trigger,
      parentTaskId: null,
      // 直接任务不占自主额度
      globalQuota: Infinity,
      sentCount: 0,
      usedSteps: Object.fromEntries(input.authorizedResponders.map(r => [r, 0])),
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + (input.timeoutMs ?? 5 * 60_000)),
    };

    this.tasks.set(task.id, task);
    return task;
  }

  /**
   * 创建 user_requested_discussion 任务。
   *
   * D.1-5：单次总 AI 消息数 1–30，所有角色合计。
   * D.1-6：超范围拒绝，禁止自动拆分。
   */
  createDiscussionTask(input: CreateDiscussionTaskInput): ConversationTask {
    this.assertTrusted(input.trigger);

    const quota = input.quota ?? DEFAULT_QUOTA;

    // D.1-5：范围校验，绝不自动拆分
    if (quota < DISCUSSION_QUOTA_MIN || quota > DISCUSSION_QUOTA_MAX) {
      throw new TaskMachineError(
        'QUOTA_OUT_OF_RANGE',
        `讨论额度必须在 ${DISCUSSION_QUOTA_MIN}–${DISCUSSION_QUOTA_MAX} 之间，收到 ${quota}。` +
        `禁止自动拆分为多个轮次。`
      );
    }

    const task: ConversationTask = {
      id: nextId('task-disc'),
      origin: 'user_requested_discussion',
      state: 'active',
      authorizedResponders: [...input.participants],
      authorizedSteps: {},
      trigger: input.trigger,
      parentTaskId: null,
      globalQuota: quota,
      sentCount: 0,
      usedSteps: {},
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + (input.timeoutMs ?? 30 * 60_000)),
    };

    this.tasks.set(task.id, task);
    return task;
  }

  /**
   * 创建复合任务（D60.1-A）。
   *
   * 用户一次说「先各自说说看法，然后互相讨论」时，
   * 拆成两个关联子任务，而不是合并成一个。
   */
  createCompositeTask(
    trigger: TrustedTrigger,
    direct: Omit<CreateDirectTaskInput,'trigger'>,
    discussion: Omit<CreateDiscussionTaskInput,'trigger'>
  ): { direct: ConversationTask; discussion: ConversationTask; parentId: string } {
    const parentId = nextId('task-parent');

    const d = this.createDirectTask({ ...direct, trigger });
    const c = this.createDiscussionTask({ ...discussion, trigger });

    d.parentTaskId = parentId;
    c.parentTaskId = parentId;

    return { direct: d, discussion: c, parentId };
  }

  // ── 发送准入 ──────────────────────────────────────

  /**
   * 判定一次发送是否被允许。
   *
   * 这是 Gate J 的核心：所有绕过路径都必须在这里被拦住。
   */
  authorizeSend(
    taskId: string,
    characterId: string
  ): SendVerdict {
    const task = this.tasks.get(taskId);
    if (!task) {
      return { kind: 'deny', reason: '任务不存在', code: 'TASK_NOT_ACTIVE' };
    }

    // ── 授权优先（G2-C1 修复，2026-10-27）──
    //
    // D.1-2：只有本任务授权的参与角色可以发言。
    //
    // 为什么必须在【状态判定之前】：
    //   1. 授权回答「谁能访问这个任务」，状态回答「这个任务现在能不能用」。
    //      访问控制应先于资源状态判定，否则未授权方可从错误码反推额度与状态。
    //   2. 若放在状态判定之后，任务一旦 completed / cancelled / expired，
    //      未授权角色就会收到 QUOTA_EXHAUSTED 或 TASK_NOT_ACTIVE，
    //      把「越权」误报成「额度/状态」问题，掩盖真实原因。
    //
    // 注：ai_autonomous 当前没有创建入口（见 G2_01 §1.3），其
    // authorizedResponders 的来源在 V1.7 中尚未定义，故此处不预设语义、
    // 不对该 origin 施加本校验。
    if (task.origin === 'user_direct' || task.origin === 'user_requested_discussion') {
      if (!task.authorizedResponders.includes(characterId)) {
        return {
          kind: 'deny',
          reason: characterId + ' 不在本任务的授权回复集合内',
          code: 'NOT_AUTHORIZED_RESPONDER'
        };
      }
    }
    if (task.state !== 'active') {
      // 区分「因额度耗尽而完成」与「被取消/过期」
      if (task.state === 'completed' && task.sentCount >= task.globalQuota) {
        return {
          kind: 'deny',
          reason: '全局额度已用完 (' + task.sentCount + '/' + task.globalQuota + ')',
          code: 'QUOTA_EXHAUSTED'
        };
      }
      return { kind: 'deny', reason: '任务状态为 ' + task.state, code: 'TASK_NOT_ACTIVE' };
    }
    if (task.expiresAt && task.expiresAt < new Date()) {
      task.state = 'expired';
      return { kind: 'deny', reason: '任务已过期', code: 'TASK_NOT_ACTIVE' };
    }

    // 直接任务：检查授权步数
    if (task.origin === 'user_direct') {
      // 授权集合已在上方「授权优先」块校验，此处只判步数
      const max = task.authorizedSteps[characterId] ?? 0;
      const used = task.usedSteps[characterId] ?? 0;
      if (used >= max) {
        return { kind: 'deny', reason: characterId + ' 已用完授权步数 (' + used + '/' + max + ')', code: 'STEP_EXHAUSTED' };
      }
      return { kind: 'allow' };
    }

    // 讨论 / 自主：全局额度（授权已在「授权优先」块校验）
    if (task.sentCount >= task.globalQuota) {
      return { kind: 'deny', reason: '全局额度已用完 (' + task.sentCount + '/' + task.globalQuota + ')', code: 'QUOTA_EXHAUSTED' };
    }
    return { kind: 'allow' };
  }

  /**
   * 原子预留一次发送名额。
   *
   * 【为什么需要它】authorizeSend() + commitSend() 两段式在**同步**代码里安全，
   * 但一旦中间插入任何 await（数据库 I/O、网络、消息队列），就会出现
   * TOCTOU 竞争：多个调用同时通过检查，然后各自提交，导致超额。
   *
   * reserve() 把「检查 + 扣减」压成一次同步调用，不留 await 间隙，
   * 因此在单线程 Node 中天然原子。接入数据库后，应由事务/行锁保证同等语义。
   *
   * @returns 预留成功返回预留凭据；失败返回拒绝原因
   */
  reserve(taskId: string, characterId: string):
    | { ok: true; receipt: SendReceipt }
    | { ok: false; reason: string; code: string } {
    const check = this.authorizeSend(taskId, characterId);
    if (check.kind === 'deny') {
      return { ok: false, reason: check.reason, code: check.code };
    }

    const task = this.tasks.get(taskId)!;
    if (task.origin === 'user_direct') {
      task.usedSteps[characterId] = (task.usedSteps[characterId] ?? 0) + 1;
    } else {
      task.sentCount++;
      if (task.sentCount >= task.globalQuota) task.state = 'completed';
    }

    return {
      ok: true,
      receipt: { taskId, characterId, seq: task.sentCount, at: new Date() },
    };
  }

  /**
   * 原子结算一次发送。
   *
   * 必须在 authorizeSend 通过后调用，且与发送动作在同一事务内。
   */
  commitSend(taskId: string, characterId: string): void {
    const check = this.authorizeSend(taskId, characterId);
    if (check.kind === 'deny') {
      throw new TaskMachineError(check.code as any, check.reason);
    }
    const task = this.tasks.get(taskId)!;

    if (task.origin === 'user_direct') {
      task.usedSteps[characterId] = (task.usedSteps[characterId] ?? 0) + 1;
    } else {
      task.sentCount++;
      if (task.sentCount >= task.globalQuota) {
        task.state = 'completed';
      }
    }
  }

  // ── 状态变更 ──────────────────────────────────────

  complete(taskId: string): void {
    const t = this.tasks.get(taskId);
    if (t) t.state = 'completed';
  }

  cancel(taskId: string): void {
    const t = this.tasks.get(taskId);
    if (t) t.state = 'cancelled';
  }

  /**
   * D.1-6：禁止 AI 自行续轮或拆分。
   *
   * 唯一合法的续轮方式是用户再次发起（新任务）。
   */
  attemptSelfExtend(taskId: string): never {
    throw new TaskMachineError(
      'CANNOT_SELF_EXTEND',
      'AI 不能自行延长或拆分任务。只有可信用户可发起新任务。'
    );
  }

  get(taskId: string): ConversationTask | undefined {
    return this.tasks.get(taskId);
  }

  // ── 内部 ──────────────────────────────────────────

  private assertTrusted(trigger: TrustedTrigger): void {
    if (!trigger || !trigger.eventId || !trigger.sourceMessageId) {
      throw new TaskMachineError(
        'NO_TRUSTED_TRIGGER',
        '缺少可信触发：必须提供 eventId 与 sourceMessageId。' +
        'AI 输出、插件回调不能伪造用户授权。'
      );
    }
    if (!['qq','desktop','web'].includes(trigger.entry)) {
      throw new TaskMachineError(
        'NO_TRUSTED_TRIGGER',
        '未知入口：' + trigger.entry
      );
    }
  }
}
