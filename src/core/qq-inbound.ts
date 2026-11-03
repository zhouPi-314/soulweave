/**
 * SoulWeave S5：入站适配器（QQ 事件 → 可信触发 / 任务）
 *
 * 这一层是 Gate J 的**入口闸门**。所有来自 QQ 的消息都必须经过它，
 * 判定「能不能触发 AI 回复」以及「算哪种任务」。
 *
 * 【安全规则（来自 V1.7 规划，不可放宽）】
 * 1. 第三方默认拒绝：不在白名单里的用户/群，一律不回复，也不计入任何额度。
 * 2. 只有**可信用户**的直接发言能创建 user_direct / user_requested_discussion。
 * 3. AI 自己的消息、机器人消息、系统消息永远不构成可信触发。
 * 4. 同一事件重复投递（断线重连）必须幂等。
 *
 * 【为什么规则 3 重要】
 * 如果不拦住「机器人消息」，两个 AI 角色互相回复就会形成无限循环 ——
 * 这正是 S5 退出标准里「无互聊循环」要防的东西。
 */

import type { OneBotMessageEvent } from './onebot-protocol.js';
import { messageDedupKey } from './onebot-protocol.js';
import type { TrustedTrigger } from '../shared/types.js';
import { isAiOrigin, stripAiOrigin } from './qq-autonomous.js';

/** 白名单配置：谁能触发 AI */
export interface QqPolicy {
  /**
   * 主人（主号）：你自己的 QQ。
   *
   * 和好友的区别不是「能不能说话」，而是「能要求什么」：
   * 主人可以让角色做事（切换、查记忆、跑工具），好友只能闲聊。
   * 每个账号建议只放一个。
   */
  ownerIds: string[];
  /** 好友：允许私聊触发的 QQ 号。只能闲聊，不能下达能力型指令。 */
  allowedUserIds: string[];
  /** 允许群聊触发的群号 */
  allowedGroupIds: string[];
  /**
   * 群里是否必须 @ 机器人才回复。
   * 默认 true —— 群里每条消息都回会非常吵，也容易被当成刷屏。
   */
  requireAtInGroup: boolean;
  /** 是否允许私聊（默认 true） */
  allowPrivate: boolean;
  /** 是否允许群聊（默认 true） */
  allowGroup: boolean;
}

export const DEFAULT_QQ_POLICY: QqPolicy = {
  ownerIds: [],
  allowedUserIds: [],
  allowedGroupIds: [],
  requireAtInGroup: true,
  allowPrivate: true,
  allowGroup: true,
};

/** 聊天级别 */
export type QqRole = 'owner' | 'friend';

/**
 * 判定一个 QQ 号在白名单里的级别。
 *
 * 主人优先：同时出现在两个名单里时按主人算（避免手滑加了两次就降权）。
 */
export function roleOf(policy: Partial<QqPolicy> | null | undefined, userId: string): QqRole | null {
  const id = String(userId || '');
  if (!id) return null;
  if (Array.isArray(policy && (policy as any).ownerIds) && (policy as any).ownerIds.indexOf(id) >= 0) return 'owner';
  if (Array.isArray(policy && (policy as any).allowedUserIds) && (policy as any).allowedUserIds.indexOf(id) >= 0) return 'friend';
  return null;
}

/**
 * 把本号从白名单里剔掉。
 *
 * 【为什么必须在服务端做】
 * 前端本来有一段守卫，但它依赖 selfUin 解析成功；
 * 实例记录还没回填 uin、或重启后 selfId 没拿到时，守卫会静默失效，
 * 于是「把自己加进允许私聊」就发生了。服务端兜底才彻底。
 */
export function stripSelfFromPolicy(policy: QqPolicy, selfUin: string): { policy: QqPolicy; removed: string[] } {
  const self = String(selfUin || '');
  if (!self) return { policy, removed: [] };
  const removed: string[] = [];
  const filter = (arr: string[]) => (Array.isArray(arr) ? arr : []).filter((x) => {
    if (String(x) === self) { removed.push(String(x)); return false; }
    return true;
  });
  return {
    policy: { ...policy, ownerIds: filter(policy.ownerIds), allowedUserIds: filter(policy.allowedUserIds) },
    removed,
  };
}

export type InboundDecision =
  | { action: 'ignore'; reason: string }
  | { action: 'duplicate'; key: string }
  | {
      action: 'trigger';
      /** 归属：直接回复还是受控讨论 */
      intent: 'user_direct' | 'user_requested_discussion';
      /** 讨论额度（intent=discussion 时有效） */
      quota?: number;
      trigger: TrustedTrigger;
      /** 用于喂模型的纯文本 */
      text: string;
      /** 触发者的聊天级别：主人 / 好友 */
      role: QqRole;
      /** 回复目标 */
      target: { kind: 'private' | 'group'; id: string };
      /** 发消息时是否要 @ 对方（群聊里更自然） */
      atUser: boolean;
      conversationKey: string;
    };

/** 判断一条消息是否来自「非人类」（机器人/系统），这类永远不能触发 */
export function isNonHumanEvent(ev: OneBotMessageEvent, selfId: string): boolean {
  // 自己发的
  if (ev.userId && ev.selfId && ev.userId === ev.selfId) return true;
  if (selfId && ev.userId === selfId) return true;
  // 群成员 role 为 null 且没有昵称 —— 大概率是系统消息
  if (!ev.sender.nickname && !ev.sender.card && !ev.sender.userId) return true;
  // AI 标记的消息：即使是另一个角色发的，也不算人类触发。
  // 这是防互聊循环的第一道线 —— 但注意它只拦「可信触发」，
  // 自主接力由 AutonomousEngine 的深度限制单独处理。
  if (isAiOrigin(ev.text)) return true;
  return false;
}

/**
 * 从消息文本里解析讨论意图。
 *
 * 只识别**明确**的讨论请求。宁可漏判（当成直接回复），
 * 也不能误判 —— 误判会让普通聊天被 30 条上限限制住（Gate J 场景⑨）。
 */
export function parseDiscussionIntent(text: string): { isDiscussion: boolean; quota?: number } {
  const s = String(text || '');

  // 必须出现「讨论/辩论/聊聊/各抒己见」这类明确词
  const DISCUSS_RE = /(讨论|辩论|各抒己见|互相说|聊聊看|你们俩|你俩|两个都|都说说|分别说)/;
  if (!DISCUSS_RE.test(s)) return { isDiscussion: false };

  // 显式条数：「讨论 10 条」「说 5 句」「来回 20 轮」
  const numMatch = s.match(/(?:讨论|说|聊|来回|各)\s*(\d{1,2})\s*(?:条|句|轮|次)/);
  if (numMatch) {
    const n = parseInt(numMatch[1], 10);
    if (Number.isFinite(n)) return { isDiscussion: true, quota: n };
  }

  return { isDiscussion: true };
}

export interface InboundContext {
  policy: QqPolicy;
  selfId: string;
  /** 已处理过的事件键（用于幂等），由调用方维护 */
  seenKeys: Set<string>;
  /** 该账号绑定的角色 ID（用于触发记录） */
  characterId: string | null;
  /** 事件入口标记 */
  entry?: 'qq';
}

/**
 * 判定一条入站消息该怎么处理。
 *
 * 纯函数：不写状态、不碰网络。seenKeys 由调用方传入并在返回 duplicate 时更新。
 */
export function decideInbound(ev: OneBotMessageEvent, ctx: InboundContext): InboundDecision {
  const policy = ctx.policy;

  // ── 1. 幂等去重（断线重连会重投）──
  const key = messageDedupKey(ev);
  if (ctx.seenKeys.has(key)) return { action: 'duplicate', key };

  // ── 2. 非人类消息直接丢弃（防互聊循环）──
  if (isNonHumanEvent(ev, ctx.selfId)) {
    return { action: 'ignore', reason: '非人类消息（机器人/系统/自己）' };
  }

  const isGroup = ev.kind === 'message_group';

  // ── 3. 通道开关 ──
  if (isGroup && !policy.allowGroup) return { action: 'ignore', reason: '群聊未启用' };
  if (!isGroup && !policy.allowPrivate) return { action: 'ignore', reason: '私聊未启用' };

  // ── 4. 第三方默认拒绝 ──
  //
  // 注意：群聊要同时检查「群在白名单」和「人在白名单」。
  // 只检查群的话，群里任何一个陌生人 @ 一下就能让 AI 说话。
  const role = roleOf(policy, ev.userId);
  if (isGroup) {
    if (!ev.groupId || policy.allowedGroupIds.indexOf(ev.groupId) < 0) {
      return { action: 'ignore', reason: '群 ' + (ev.groupId || '?') + ' 不在白名单' };
    }
    if (!role) {
      return { action: 'ignore', reason: '用户 ' + ev.userId + ' 不在白名单' };
    }
    if (policy.requireAtInGroup && !ev.atSelf) {
      return { action: 'ignore', reason: '群里未 @ 机器人' };
    }
  } else {
    if (!role) {
      return { action: 'ignore', reason: '用户 ' + ev.userId + ' 不在白名单' };
    }
  }

  // ── 5. 空消息不触发（去掉 AI 标记后再判断）──
  //
  // S7 例外：**只发了图片、没有文字**的消息也要能触发。
  // 否则用户「甩一张图」是最自然的表达方式，却被当成空消息丢掉。
  const text = stripAiOrigin(String(ev.text || '')).trim();
  const imageCount = Number(ev.imageCount) || 0;
  if (!text && imageCount === 0) {
    return { action: 'ignore', reason: '空消息（既没有文字也没有图片）' };
  }

  // ── 6. 构造可信触发 ──
  const intent = parseDiscussionIntent(text);
  // sessionBinding 是「这次触发绑定到哪个会话」的证据。
  // 用途：同一 eventId 不能被换到别的会话重放，
  // 也让审计日志能还原「这条回复是哪个群的哪条消息触发的」。
  const sessionBinding = [
    'qq',
    ctx.selfId || ev.selfId || '-',
    isGroup ? 'g:' + ev.groupId : 'p:' + ev.userId,
    ev.userId,
  ].join('|');

  const trigger: TrustedTrigger = {
    // 可信触发的本质：这个 eventId 只能由 OneBot 从真实 QQ 消息产生，
    // 模型输出、插件回调都拿不到它。
    eventId: 'qq:' + key,
    sourceMessageId: ev.messageId || key,
    entry: 'qq',
    sessionBinding,
    at: new Date(ev.time * 1000),
  };

  return {
    action: 'trigger',
    intent: intent.isDiscussion ? 'user_requested_discussion' : 'user_direct',
    quota: intent.quota,
    trigger,
    text,
    role: role as QqRole,
    target: isGroup
      ? { kind: 'group', id: String(ev.groupId) }
      : { kind: 'private', id: ev.userId },
    atUser: isGroup,
    conversationKey: isGroup ? 'qq_group:' + ev.groupId : 'qq_private:' + ev.userId,
  };
}

/**
 * 白名单变更校验。
 *
 * 空白名单意味着「谁都不能触发」，不是「谁都能触发」——
 * 这是最容易被写反的地方，所以单独抽出来并测试。
 */
export function validatePolicy(p: QqPolicy): { ok: boolean; warnings: string[] } {
  const warnings: string[] = [];
  const owners = Array.isArray((p as any).ownerIds) ? (p as any).ownerIds : [];
  if (!owners.length) {
    warnings.push('还没设主人：主人可用指令让角色做事，好友只能闲聊。建议把你自己的号设为主人。');
  }
  if (owners.length > 1) {
    warnings.push('设了 ' + owners.length + ' 个主人：每个都会拥有完整指令权限，确认这是你要的。');
  }
  if (!p.allowedUserIds.length) {
    warnings.push('可信用户白名单为空：任何人都无法触发 AI（这是安全默认值，不是配置错误）');
  }
  if (p.allowGroup && !p.allowedGroupIds.length) {
    warnings.push('群聊已启用但群白名单为空：所有群都会被拒绝');
  }
  for (const id of p.allowedUserIds) {
    if (!/^\d{5,12}$/.test(id)) warnings.push('可疑的用户 QQ 号: ' + id);
  }
  for (const id of p.allowedGroupIds) {
    if (!/^\d{5,12}$/.test(id)) warnings.push('可疑的群号: ' + id);
  }
  return { ok: true, warnings };
}
