/**
 * SoulWeave S5：QQ 社交服务（编排层）
 *
 * 把四层粘起来，并负责持久化：
 *   onebot-protocol  ← 解析
 *   qq-account       ← 连接
 *   qq-inbound       ← 准入
 *   task-machine     ← 额度
 *   qq-outbound      ← 速率
 *
 * 【为什么单独一层】
 * 上面四层都是纯逻辑，不知道「配置从哪来」「状态存哪」。
 * 这层负责这些，也负责给 UI 提供统一的查询接口。
 */

import fs from 'node:fs';
import path from 'node:path';

import { QqAccountManager } from './qq-account.js';
import type { AccountConfig, AccountStatus, TransportFactory, ActionReceipt } from './qq-account.js';
import { decideInbound, DEFAULT_QQ_POLICY, stripSelfFromPolicy } from './qq-inbound.js';
import type { QqPolicy, InboundDecision } from './qq-inbound.js';
import {
  normalizeEvent, normalizeGroupList, normalizeFriendList,
  buildSendMsg, parseActionResponse, redactUrl, messageDedupKey,
} from './onebot-protocol.js';
import type { OneBotMessageEvent, FriendInfo, GroupInfo } from './onebot-protocol.js';
import {
  createOutboundState, checkOutbound, commitOutbound, outboundUsage,
  sanitizeOutgoing, isRepetitive, DEFAULT_OUTBOUND_LIMITS,
} from './qq-outbound.js';
import type { OutboundLimits, OutboundState } from './qq-outbound.js';
import { TaskMachine } from './task-machine.js';
import { allocatePorts, allocateNextPorts, validatePorts, defaultPortsFor } from './qq-port-alloc.js';
import type { PortPair } from './qq-port-alloc.js';
import {
  parseWav, sniffFormat, canDecodeVoice, wavToQqVoice,
  estimateDuration, probeCodecTools,
} from './voice-codec.js';
import type { CodecAvailability } from './voice-codec.js';
import {
  AutonomousEngine, markAiOrigin, isAiOrigin, stripAiOrigin,
  limitsForScene, DEFAULT_AUTONOMOUS_LIMITS, validateQuota,
} from './qq-autonomous.js';
import type { AutonomousLimits } from './qq-autonomous.js';

export interface QqPersistedState {
  version: number;
  policy: QqPolicy;
  /** 每个 QQ 账号各一份白名单（谁能触发）。缺省回落 policy */
  policies?: Record<string, QqPolicy>;
  limits: OutboundLimits;
  accounts: Array<{
    label: string;
    characterId: string | null;
    wsUrl: string;
    backend: string;
    /** 注意：**不存令牌明文**，只存「是否有令牌」的标记 */
    hasToken: boolean;
    /** 该实例占用的端口（多实例自动分配） */
    ports?: PortPair;
  }>;
  /** 每日用量（按账号） */
  usage: Record<string, { date: string; messages: number; rounds: number }>;
  /** 最近 N 条 AI 回复（防重复用，不持久化正文，只存指纹） */
  recentFingerprints: string[];
}

const STATE_VERSION = 1;

/**
 * 最多同时接几个 QQ 账号。
 *
 * 原设计是「多角色 = 双账号」，但角色名册允许建多个云端角色，
 * 每个角色又只能独占一个 QQ 号，所以 2 个明显不够用。
 * 每个账号要一套独立的 NapCat 实例（端口、config、QQ 进程），
 * 4 个是「够用又不至于把机器拖垮」的折中。
 */
export const MAX_QQ_ACCOUNTS = 4;

/**
 * 一次发送的真实结果。
 *
 * 和旧的 { ok, error } 相比多了三样东西：
 *   retcode       OneBot 原始返回码，0 才是真发出去
 *   messageId     消息 id，能拿去撤回、能证明平台确实收下了
 *   selfTarget    目标是机器人自己吗（QQ 不会投递给「自己」）
 */
export interface SendReceipt extends ActionReceipt {
  messageId?: string | null;
  selfTarget?: boolean;
  warning?: string;
}

export interface QqServiceOptions {
  /** 状态文件绝对路径 */
  statePath: string;
  /** 传输层工厂（生产用 WsTransport，测试可注入假实现） */
  transportFactory: TransportFactory;
  /** 取令牌明文（从 safeStorage，不落盘） */
  getToken?: (label: string) => string | null;
  /**
   * 图片理解回调（S7）。
   *
   * 只有配置里开启了 QQ 图片识别才会被调用。
   * 返回一段文字描述，会挂到事件上作为附加上下文；
   * 返回 null / ok:false 表示不识别或失败，消息照常处理，不阻塞。
   */
  onImageDescribe?: (info: {
    accountLabel: string;
    event: OneBotMessageEvent;
    segments: any[];
  }) => Promise<{ ok: boolean; text?: string; error?: string } | null>;

  /** 触发 AI 回复的回调 */
  onTrigger?: (info: {
    accountLabel: string;
    decision: Extract<InboundDecision, { action: 'trigger' }>;
    event: OneBotMessageEvent;
  }) => Promise<string | null>;
  /** 生成自主消息的回调（第 index 条，本轮共 quota 条） */
  onAutonomous?: (info: {
    accountLabel: string;
    roundId: string;
    index: number;
    quota: number;
    prompt: string;
  }) => Promise<string | null>;
  /** 日志 */
  log?: (msg: string) => void;
}

export class QqService {
  private manager: QqAccountManager;
  private tasks = new TaskMachine();
  private autonomy = new AutonomousEngine();
  private autoLimits: AutonomousLimits = { ...DEFAULT_AUTONOMOUS_LIMITS };
  private codec: CodecAvailability = {
    silkEncoder: null, silkDecoder: null, ffmpeg: null,
    canEncode: false, canDecode: false,
    hint: '未探测语音工具（QQ 语音不可用，文字消息不受影响）',
  };
  private outbound: OutboundState = createOutboundState();
  private seenKeys = new Set<string>();
  private state: QqPersistedState;
  private opts: QqServiceOptions;
  private recentReplies: string[] = [];
  private selfIds = new Map<string, string>();
  private groups = new Map<string, Array<{ groupId: string; groupName: string }>>();
  private friends = new Map<string, Array<{ userId: string; nickname: string; remark: string }>>();

  constructor(options: QqServiceOptions) {
    this.opts = options;
    this.state = this.loadState();

    this.manager = new QqAccountManager({
      transportFactory: options.transportFactory,
      onEvent: (label, raw) => { void this.handleRawEvent(label, raw); },
      onStatusChange: (st) => { this.saveState(); void st; },
      log: (m) => this.opts.log?.(m),
    });

    for (const a of this.state.accounts) {
      this.manager.upsertAccount({
        label: a.label,
        characterId: a.characterId,
        wsUrl: a.wsUrl,
        accessToken: null,
        backend: (a.backend as any) || 'custom',
      });
    }
  }

  // ── 持久化 ──

  private loadState(): QqPersistedState {
    const empty: QqPersistedState = {
      version: STATE_VERSION,
      policy: { ...DEFAULT_QQ_POLICY },
      limits: { ...DEFAULT_OUTBOUND_LIMITS },
      accounts: [],
      usage: {},
      recentFingerprints: [],
    };
    try {
      const p = this.opts.statePath;
      if (!fs.existsSync(p)) return empty;
      const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
      // 老配置没有 ownerIds 字段：补空数组，别让后续代码读到 undefined。
      const fixPolicy = (p: any) => {
        const out = { ...empty.policy, ...(p || {}) };
        if (!Array.isArray(out.ownerIds)) out.ownerIds = [];
        if (!Array.isArray(out.allowedUserIds)) out.allowedUserIds = [];
        if (!Array.isArray(out.allowedGroupIds)) out.allowedGroupIds = [];
        return out;
      };
      const rawPolicies = raw.policies && typeof raw.policies === 'object' ? raw.policies : {};
      const policies: Record<string, any> = {};
      for (const k of Object.keys(rawPolicies)) policies[k] = fixPolicy(rawPolicies[k]);
      return {
        version: STATE_VERSION,
        policy: fixPolicy(raw.policy),
        policies,
        limits: { ...empty.limits, ...(raw.limits || {}) },
        accounts: Array.isArray(raw.accounts) ? raw.accounts : [],
        usage: raw.usage && typeof raw.usage === 'object' ? raw.usage : {},
        recentFingerprints: Array.isArray(raw.recentFingerprints) ? raw.recentFingerprints.slice(-50) : [],
      };
    } catch (e) {
      return empty;
    }
  }

  private saveState(): void {
    try {
      // 把当前用量同步进持久化结构
      const usage: QqPersistedState['usage'] = {};
      for (const st of this.manager.statuses()) {
        const u = outboundUsage(this.outbound, st.label, this.state.limits, Date.now());
        if (u.messages || u.rounds) {
          usage[st.label] = { date: new Date().toISOString().slice(0, 10), messages: u.messages, rounds: u.rounds };
        }
      }
      this.state.usage = usage;
      this.state.recentFingerprints = this.recentReplies.slice(-50);
      fs.mkdirSync(path.dirname(this.opts.statePath), { recursive: true });
      fs.writeFileSync(this.opts.statePath, JSON.stringify(this.state, null, 2), 'utf8');
    } catch (e) {
      this.opts.log?.('保存 QQ 状态失败: ' + String(e).slice(0, 120));
    }
  }

  // ── 账号 ──

  addAccount(cfg: AccountConfig): { ok: boolean; error?: string } {
    if (this.state.accounts.length >= MAX_QQ_ACCOUNTS) {
      return { ok: false, error: '最多 ' + MAX_QQ_ACCOUNTS + ' 个 QQ 账号（每个账号一套 NapCat 实例）' };
    }
    if (!cfg.wsUrl) return { ok: false, error: 'WebSocket 地址不能为空' };
    if (this.state.accounts.some(a => a.label === cfg.label)) {
      return { ok: false, error: '账号标识已存在: ' + cfg.label };
    }
    this.state.accounts.push({
      label: cfg.label,
      characterId: cfg.characterId,
      wsUrl: cfg.wsUrl,
      backend: String(cfg.backend || 'custom'),
      hasToken: !!cfg.accessToken,
    });
    this.manager.upsertAccount(cfg);
    this.saveState();
    return { ok: true };
  }

  /**
   * 把某个账号对应的角色改掉。
   *
   * 「角色管理」里把账号绑到另一个角色时，必须同步这里，
   * 否则「社交」页还显示旧角色，两处说法不一致，用户没法判断哪个是真的。
   */
  setAccountCharacter(label: string, characterId: string | null): { ok: boolean; error?: string } {
    const acc = this.state.accounts.find(a => a.label === label);
    if (!acc) return { ok: false, error: '账号不存在: ' + label };
    acc.characterId = characterId || null;
    this.saveState();
    return { ok: true };
  }

  removeAccount(label: string): { ok: boolean; error?: string } {
    const i = this.state.accounts.findIndex(a => a.label === label);
    if (i < 0) return { ok: false, error: '账号不存在' };
    try { this.manager.stop(label); } catch (e) { void e; }
    this.state.accounts.splice(i, 1);
    this.saveState();
    return { ok: true };
  }

  async startAccount(label: string): Promise<AccountStatus | { error: string }> {
    try {
      return await this.manager.start(label);
    } catch (e) {
      return { error: String(e).slice(0, 150) };
    }
  }

  stopAccount(label: string): { ok: boolean; error?: string } {
    try {
      this.manager.stop(label);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e).slice(0, 150) };
    }
  }

  stopAll(): void {
    this.manager.stopAll();
    this.saveState();
  }

  statuses(): AccountStatus[] {
    return this.manager.statuses();
  }

  // ── 策略与限制 ──

  /**
   * 某个账号的白名单。
   *
   * 【为什么要按账号分开】
   * 两个 QQ 号的好友和群完全不是同一批。共用一份白名单时，
   * A 号的群会被 B 号当成可信来源 —— 既不合逻辑，也不安全。
   * 没有单独配置过的账号回落到全局 policy（老配置不受影响）。
   */
  getPolicy(label?: string): QqPolicy {
    if (label) {
      const p = (this.state.policies || {})[label];
      if (p) return { ...this.state.policy, ...p };
    }
    return { ...this.state.policy };
  }

  /**
   * 改白名单。
   *
   * 【服务端强制剔除本号】
   * 前端也有一段守卫，但它依赖 selfUin 能解析出来；实例记录没回填、
   * 或重启后 selfId 还没学到时，守卫会静默失效，于是「把自己加进允许私聊」
   * 就真的写进去了。这里用已知的 selfId 兜底，任何路径都进不来。
   */
  setPolicy(patch: Partial<QqPolicy>, label?: string): {
    ok: boolean;
    policy: QqPolicy;
    /** 被剔除的本号（有值就说明用户试图加自己） */
    removedSelf?: string[];
  } {
    const selfUin = label ? (this.selfIds.get(label) || '') : '';
    let removedSelf: string[] = [];

    if (label) {
      const cur = this.getPolicy(label);
      const merged: QqPolicy = { ...cur, ...patch };
      const cleaned = stripSelfFromPolicy(merged, selfUin);
      removedSelf = cleaned.removed;
      this.state.policies = { ...(this.state.policies || {}), [label]: cleaned.policy };
      this.saveState();
      return { ok: true, policy: this.getPolicy(label), removedSelf };
    }
    {
      const merged: QqPolicy = { ...this.state.policy, ...patch };
      const cleaned = stripSelfFromPolicy(merged, selfUin);
      removedSelf = cleaned.removed;
      this.state.policy = cleaned.policy;
    }
    this.saveState();
    return { ok: true, policy: this.getPolicy(), removedSelf };
  }

  /** 所有账号各自的白名单（没单独配过的用全局） */
  policiesByAccount(): Record<string, QqPolicy> {
    const out: Record<string, QqPolicy> = {};
    for (const a of this.state.accounts) out[a.label] = this.getPolicy(a.label);
    return out;
  }

  getLimits(): OutboundLimits { return { ...this.state.limits }; }

  setLimits(patch: Partial<OutboundLimits>): { ok: boolean; limits: OutboundLimits } {
    const clamp = (v: unknown, min: number, max: number, def: number) => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : def;
    };
    this.state.limits = {
      cooldownSeconds: clamp(patch.cooldownSeconds ?? this.state.limits.cooldownSeconds, 0, 3600, 60),
      dailyMaxMessages: clamp(patch.dailyMaxMessages ?? this.state.limits.dailyMaxMessages, 1, 10000, 300),
      dailyMaxRounds: clamp(patch.dailyMaxRounds ?? this.state.limits.dailyMaxRounds, 1, 10000, 100),
    };
    this.saveState();
    return { ok: true, limits: this.getLimits() };
  }

  usage(label: string): { messages: number; rounds: number; maxMessages: number; maxRounds: number } {
    return outboundUsage(this.outbound, label, this.state.limits, Date.now());
  }

  // ── 入站 ──

  private async handleRawEvent(label: string, raw: string): Promise<void> {
    let obj: any;
    try { obj = JSON.parse(raw); } catch (e) { this.opts.log?.('[dbg] JSON 解析失败'); return; }

    // 动作响应（带 echo）不是事件，忽略
    if (obj && typeof obj === 'object' && obj.echo !== undefined && obj.post_type === undefined) return;

    const st = this.manager.status(label);
    const selfId = this.selfIds.get(label) || '';
    const ev = normalizeEvent(obj, selfId);
    if (!ev) return;

    // 记录 self_id（用于判断「是不是自己发的」）
    if (ev.selfId && !this.selfIds.has(label)) this.selfIds.set(label, ev.selfId);

    // 元事件：心跳里带 self_id，顺便刷新在线状态
    if (ev.kind === 'meta') return;
    if (ev.kind !== 'message_private' && ev.kind !== 'message_group') return;
    this.opts.log?.('[' + label + '] 收到消息 kind=' + ev.kind + ' from=' + (ev as any).userId);

    const msgEv = ev as OneBotMessageEvent;

    // ── S7：QQ 图片理解（必须在 decideInbound 之前）──
    //
    // 【为什么顺序很重要】
    // decideInbound 会因为「没有文字」直接忽略。而用户甩一张图不说话，
    // 是最自然的表达方式之一。所以先把图看懂、把描述塞进 text，
    // 再让闸门判断 —— 这样「只发图」也能触发回复。
    //
    // 默认关闭（好友发来的图可能是别人的隐私）。开启后：
    //   · 失败不阻塞回复
    //   · 描述作为上下文，不是最终回复
    const images = msgEv.segments.filter((s: any) => s.type === 'image');
    if (images.length && this.opts.onImageDescribe) {
      try {
        const desc = await this.opts.onImageDescribe({ accountLabel: label, event: msgEv, segments: images });
        if (desc && desc.ok && desc.text) {
          this.opts.log?.('[' + label + '] 图片理解: ' + desc.text.slice(0, 60));
          msgEv.imageDescription = desc.text;
          // 把描述并进 text：模型能「看到」对方发了什么
          const head = String(msgEv.text || '').replace(/\[图片\]/g, '').trim();
          msgEv.text = (head ? head + '\n' : '') + '[对方发来一张图片，内容是：' + desc.text + ']';
        } else if (desc && !desc.ok) {
          this.opts.log?.('[' + label + '] 图片理解失败: ' + String(desc.error || '').slice(0, 80));
        }
      } catch (e) {
        this.opts.log?.('[' + label + '] 图片理解异常: ' + String(e).slice(0, 80));
      }
    }

    const decision = decideInbound(msgEv, {
      policy: this.getPolicy(label),
      selfId: this.selfIds.get(label) || msgEv.selfId,
      seenKeys: this.seenKeys,
      characterId: st?.characterId || null,
    });

    if (decision.action === 'duplicate') return;
    if (decision.action === 'ignore') {
      this.opts.log?.('[' + label + '] 忽略: ' + decision.reason);
      return;
    }

    // 记录已处理，保证幂等。
    // 【必须用 messageDedupKey】decideInbound 查的是 messageDedupKey(ev)，
    // 早先用 'messageId:time' 会两边键不一致 —— 等于幂等完全没生效，
    // 断线重连重投同一条消息就会重复回复。
    this.seenKeys.add(messageDedupKey(msgEv));

    // 语音消息：协议层已把它转成 [语音] 标记。
    // 真正的解码需要 OneBot 提供音频 URL，属于后续接入点，
    // 这里先记录以便 UI 显示与排障。
    const hasVoice = msgEv.segments.some((s: any) => s.type === 'record');
    if (hasVoice) {
      this.opts.log?.('[' + label + '] 收到语音消息（解码能力: ' + (this.codec.canDecode ? '可用' : '未安装解码器') + '）');
    }

    // ── 出站闸门 ──
    const conv = decision.conversationKey;
    const gate = checkOutbound(this.outbound, label, conv, this.state.limits, Date.now());
    if (!gate.ok) {
      this.opts.log?.('[' + label + '] 出站拒绝: ' + gate.reason);
      return;
    }

    // ── 交给上层生成回复 ──
    let reply: string | null = null;
    try {
      reply = await this.opts.onTrigger?.({ accountLabel: label, decision, event: msgEv }) ?? null;
    } catch (e) {
      this.opts.log?.('[' + label + '] 生成回复失败: ' + String(e).slice(0, 120));
      return;
    }
    if (!reply) return;

    const clean = sanitizeOutgoing(reply);
    if (!clean) return;

    // 防自我重复
    if (isRepetitive(clean, this.recentReplies)) {
      this.opts.log?.('[' + label + '] 回复与最近内容重复，跳过');
      return;
    }

    const sent = this.sendMessage(label, decision.target, clean, decision.atUser ? msgEv.userId : null);
    if (sent.ok) {
      commitOutbound(this.outbound, label, conv, Date.now());
      this.recentReplies.push(clean);
      if (this.recentReplies.length > 20) this.recentReplies.shift();
      this.saveState();
    } else {
      this.opts.log?.('[' + label + '] 发送失败: ' + sent.error);
    }
  }

  // ── 出站 ──

  sendMessage(
    label: string,
    target: { kind: 'private' | 'group'; id: string },
    text: string,
    atUserId: string | null = null,
  ): { ok: boolean; error?: string } {
    // 打上 AI 来源标记：这条消息如果回流（被同群其他角色看到），
    // 入站闸门能识别出「这不是人类说的」，从而不构成可信触发。
    const marked = markAiOrigin(text);
    const segments: any[] = [];
    if (atUserId) segments.push({ type: 'at', data: { qq: atUserId } });
    segments.push({ type: 'text', data: { text: marked } });
    const action = buildSendMsg(target, segments);
    return this.manager.sendAction(label, action);
  }

  /**
   * 发送任意消息段（图片、语音等）。
   * 主动行为推送图片时用这个：文本走 sendMessage，图片需要 image 段。
   */
  sendMessageSegments(
    label: string,
    target: { kind: 'private' | 'group'; id: string },
    segments: any[],
  ): { ok: boolean; error?: string } {
    if (!Array.isArray(segments) || !segments.length) {
      return { ok: false, error: '消息段为空' };
    }
    return this.manager.sendAction(label, buildSendMsg(target, segments));
  }

  /**
   * 发一条**等回执**的消息。
   *
   * 和 sendMessage 的区别只有一个，但很关键：
   * ok 代表 OneBot 明确回了 retcode=0，而不是「帧写出去了」。
   * 所有需要告诉用户「到底发没发到」的地方都必须用这个。
   */
  async sendMessageNow(
    label: string,
    target: { kind: 'private' | 'group'; id: string },
    text: string,
    opts: { atUserId?: string | null; timeoutMs?: number } = {},
  ): Promise<SendReceipt> {
    const segments: any[] = [];
    if (opts.atUserId) segments.push({ type: 'at', data: { qq: opts.atUserId } });
    segments.push({ type: 'text', data: { text: markAiOrigin(text) } });
    return this.sendMessageSegmentsNow(label, target, segments, opts);
  }

  /** 同上，任意消息段 */
  async sendMessageSegmentsNow(
    label: string,
    target: { kind: 'private' | 'group'; id: string },
    segments: any[],
    opts: { timeoutMs?: number } = {},
  ): Promise<SendReceipt> {
    if (!Array.isArray(segments) || !segments.length) {
      return { ok: false, retcode: -1, status: 'unknown', data: null, echo: '', replied: false, error: '消息段为空', selfTarget: false };
    }
    // 先确认「我自己是谁」，否则自投递检测会因为 selfId 为空而永远不命中
    await this.ensureSelfId(label);
    const selfTarget = this.isSelfTarget(label, target);
    const r = await this.manager.sendActionAwait(label, buildSendMsg(target, segments), opts.timeoutMs || 10_000);
    const mid = r.data && (r.data.message_id != null ? r.data.message_id : r.data.messageId);
    const receipt: SendReceipt = {
      ...r,
      messageId: mid == null ? null : String(mid),
      selfTarget,
    };
    // 自发的消息 QQ 会回 retcode=0 但对方（自己）永远收不到，必须点出来
    if (receipt.ok && selfTarget) {
      receipt.warning = '目标就是当前登录的机器人账号本身，QQ 不会把消息投递给「自己」。请改填你本人的另一个 QQ 号，或者选一个群。';
    }
    return receipt;
  }

  /**
   * S11：发一条任意 OneBot/NapCat action。
   *
   * 空间（send_qzone_msg）这类扩展接口不在 OneBot 标准里，
   * 单独包一个口子，避免每加一个能力就往 service 里塞一个方法。
   */
  /** 主动问一次「我是谁」，让 selfId 有值（姐妹私聊要用） */
  async ensureSelfIdFor(label: string): Promise<string | null> {
    try {
      await this.ensureSelfId(label);
      return this.selfIds.get(label) || null;
    } catch (e) { return null; }
  }

  async sendRawAction(label: string, action: string, params: any, timeoutMs = 20_000) {
    return this.manager.sendActionAwait(label, { action, params: params || {} }, timeoutMs);
  }

  /**
   * 确保知道这个账号登录的 QQ 号。
   *
   * 【为什么必须补这一步】
   * selfId 原本只在「收到消息事件」时从事件里学。
   * 一个刚上线、还没人说话的账号，selfId 是空的 —— 于是「发给自己」检测永远不命中，
   * 明明绑的是机器人本人，界面却显示 selfTarget: false。
   * 用 get_login_info 主动问一次就能确定，而且不用等人说话。
   */
  async ensureSelfId(label: string, timeoutMs = 3000): Promise<string | null> {
    const cur = this.selfIdOf(label);
    if (cur) return cur;
    const r = await this.manager.sendActionAwait(label, { action: 'get_login_info', params: {} }, timeoutMs);
    if (!r.ok || !r.data) return null;
    const uid = r.data.user_id != null ? String(r.data.user_id) : '';
    if (!uid) return null;
    this.manager.setSelfId(label, uid);
    return uid;
  }

  /**
   * 从 OneBot 侧问一次「我是谁」。
   *
   * WebUI 那条路可能因为凭证过期/版本差异拿不到登录信息，
   * 但 OneBot 一连上就一定能答。所以判定登录状态时用它兜底。
   */
  async fetchLoginInfo(label: string, timeoutMs = 4000): Promise<{ ok: boolean; uin: string; nick: string }> {
    const r = await this.manager.sendActionAwait(label, { action: 'get_login_info', params: {} }, timeoutMs);
    if (!r.ok || !r.data) return { ok: false, uin: '', nick: '' };
    const uin = r.data.user_id != null ? String(r.data.user_id) : '';
    const nick = r.data.nickname != null ? String(r.data.nickname) : '';
    if (uin) this.manager.setSelfId(label, uin);
    return { ok: !!uin, uin, nick };
  }

  /** 目标是当前登录账号自己吗（私聊才存在这个问题） */
  isSelfTarget(label: string, target: { kind: 'private' | 'group'; id: string }): boolean {
    if (target.kind !== 'private') return false;
    const st = this.manager.status(label);
    const selfId = st && st.selfId ? String(st.selfId) : '';
    return !!selfId && String(target.id) === selfId;
  }

  /** 当前账号已登录的 QQ 号（没连上时为 null） */
  selfIdOf(label: string): string | null {
    const st = this.manager.status(label);
    return st && st.selfId ? String(st.selfId) : null;
  }

  // ── 群/好友列表 ──

  requestGroupList(label: string): { ok: boolean; error?: string } {
    return this.manager.sendAction(label, { action: 'get_group_list', params: {}, echo: 'gl:' + Date.now() });
  }

  requestFriendList(label: string): { ok: boolean; error?: string } {
    return this.manager.sendAction(label, { action: 'get_friend_list', params: {}, echo: 'fl:' + Date.now() });
  }

  /**
   * 主动拉一次好友列表（等回执，拿到就返回）。
   *
   * 旧的 requestFriendList 只把请求丢出去，列表要等事件回来才更新；
   * 界面做「选好友」下拉时必须当场拿到结果，所以需要这个。
   */
  async fetchFriendList(label: string, timeoutMs = 8000): Promise<{ ok: boolean; friends: FriendInfo[]; error?: string }> {
    const r = await this.manager.sendActionAwait(label, { action: 'get_friend_list', params: {} }, timeoutMs);
    if (!r.ok) return { ok: false, friends: [], error: r.error || ('retcode ' + r.retcode) };
    const friends = normalizeFriendList(r.data);
    this.friends.set(label, friends);
    return { ok: true, friends };
  }

  /** 主动拉一次群列表（等回执） */
  async fetchGroupList(label: string, timeoutMs = 8000): Promise<{ ok: boolean; groups: GroupInfo[]; error?: string }> {
    const r = await this.manager.sendActionAwait(label, { action: 'get_group_list', params: {} }, timeoutMs);
    if (!r.ok) return { ok: false, groups: [], error: r.error || ('retcode ' + r.retcode) };
    const groups = normalizeGroupList(r.data);
    this.groups.set(label, groups);
    return { ok: true, groups };
  }

  setGroupList(label: string, raw: unknown): void {
    this.groups.set(label, normalizeGroupList(raw));
  }

  setFriendList(label: string, raw: unknown): void {
    this.friends.set(label, normalizeFriendList(raw));
  }

  getGroupList(label: string) { return this.groups.get(label) || []; }
  getFriendList(label: string) { return this.friends.get(label) || []; }

  // ── 语音消息 ──

  /** 探测并缓存外部语音工具 */
  async probeCodecs(opts: { silkEncoderPath?: string; silkDecoderPath?: string; ffmpegPath?: string }): Promise<CodecAvailability> {
    this.codec = await probeCodecTools(opts);
    return this.codec;
  }

  codecStatus(): CodecAvailability { return { ...this.codec }; }

  /**
   * 发送语音消息。
   *
   * 传 WAV（TTS 输出）或已编码的 SILK/AMR。
   * 没有编码器时**不抛异常**，返回可读原因，由上层决定改发文字。
   */
  async sendVoice(
    label: string,
    target: { kind: 'private' | 'group'; id: string },
    audio: Buffer,
  ): Promise<{ ok: boolean; error?: string; fallback?: string; format?: string; durationSeconds?: number }> {
    const fmt = sniffFormat(audio);

    let payload: Buffer = audio;
    let outFormat = fmt;

    if (fmt === 'wav') {
      const r = await wavToQqVoice(audio, this.codec);
      if (!r.ok) {
        return { ok: false, error: r.error, fallback: r.fallback };
      }
      payload = r.data!;
      outFormat = r.format || 'silk';
    } else if (fmt === 'silk' || fmt === 'amr') {
      // 已经是 QQ 支持的格式，直接发
    } else {
      return { ok: false, error: '不支持的音频格式：' + fmt };
    }

    const duration = fmt === 'wav'
      ? (parseWav(audio)?.durationSeconds || 0)
      : estimateDuration(payload.length, fmt === 'amr' ? 'amr' : 'silk');

    const action = {
      action: 'send_msg',
      params: {
        message_type: target.kind,
        ...(target.kind === 'group' ? { group_id: Number(target.id) || target.id } : { user_id: Number(target.id) || target.id }),
        message: [{
          type: 'record',
          data: {
            file: 'base64://' + payload.toString('base64'),
            // OneBot v11 用这个字段表示时长（部分实现需要）
            // 不强制要求，没有也能发
          },
        }],
      },
    };

    const sent = this.manager.sendAction(label, action);
    if (!sent.ok) return { ok: false, error: sent.error };
    return { ok: true, format: outFormat, durationSeconds: duration };
  }

  /** 判断收到的一条语音能否处理 */
  canHandleIncomingVoice(audio: Buffer): { ok: boolean; reason?: string; format?: string } {
    const r = canDecodeVoice(audio, this.codec);
    return { ...r, format: sniffFormat(audio) };
  }

  // ── 多实例端口管理 ──

  /** 当前所有实例的端口占用 */
  listPorts(): Array<{ label: string; ports: PortPair }> {
    return this.state.accounts
      .filter(a => !!a.ports)
      .map(a => ({ label: a.label, ports: a.ports as PortPair }));
  }

  /**
   * 新增账号时自动分配端口。
   *
   * 如果用户显式给了 wsUrl 就用他的；否则按实例序号自动分配，
   * 并生成对应的 wsUrl（ws://127.0.0.1:<port>）。
   */
  async addAccountAuto(cfg: {
    label: string;
    characterId: string | null;
    wsUrl?: string;
    backend: string;
    accessToken: string | null;
  }): Promise<{ ok: boolean; error?: string; ports?: PortPair; wsUrl?: string }> {
    if (this.state.accounts.length >= MAX_QQ_ACCOUNTS) {
      return { ok: false, error: '最多 ' + MAX_QQ_ACCOUNTS + ' 个 QQ 账号（每个账号一套 NapCat 实例）' };
    }
    if (this.state.accounts.some(a => a.label === cfg.label)) {
      return { ok: false, error: '账号标识已存在: ' + cfg.label };
    }

    // 已有实例的端口作为保留
    const existing = this.listPorts().map(x => x.ports);
    let ports: PortPair;
    let wsUrl: string;

    if (cfg.wsUrl && cfg.wsUrl.trim()) {
      wsUrl = cfg.wsUrl.trim();
      // 从 URL 里推端口，其余按默认规则补
      const m = wsUrl.match(/:([0-9]+)/);
      const p = m ? Number(m[1]) : 3001;
      ports = { http: p - 1, ws: p, webui: 6099 + existing.length * 2 };
    } else {
      const next = await allocateNextPorts(existing);
      ports = next;
      wsUrl = 'ws://127.0.0.1:' + next.ws;
    }

    // 端口冲突校验
    const all = [...existing, ports];
    const v = validatePorts(all);
    if (!v.ok) return { ok: false, error: v.errors.join('; ') };

    const ok = this.addAccount({
      label: cfg.label,
      characterId: cfg.characterId,
      wsUrl,
      accessToken: cfg.accessToken,
      backend: cfg.backend as any,
    });
    if (!ok.ok) return ok;

    // 记录端口
    const acc = this.state.accounts.find(a => a.label === cfg.label);
    if (acc) acc.ports = ports;
    this.saveState();
    return { ok: true, ports, wsUrl };
  }

  /** 记录账号实际使用的端口（多实例时由实例配置决定） */
  setAccountPorts(label: string, ports: PortPair): { ok: boolean; error?: string } {
    const acc = this.state.accounts.find(a => a.label === label);
    if (!acc) return { ok: false, error: '账号不存在: ' + label };
    acc.ports = { http: ports.http, ws: ports.ws, webui: ports.webui };
    this.saveState();
    return { ok: true };
  }

  /** 生成 NapCat 的 OneBot 配置片段（给用户复制到 NapCat 里） */
  buildNapCatConfig(label: string): { ok: boolean; config?: any; error?: string } {
    const acc = this.state.accounts.find(a => a.label === label);
    if (!acc) return { ok: false, error: '账号不存在' };
    const ports = acc.ports || defaultPortsFor(0);
    return {
      ok: true,
      config: {
        network: {
          httpServers: [{
            name: 'soulweave-' + label + '-http',
            host: '127.0.0.1',
            port: ports.http,
            enable: true,
            messagePostFormat: 'array',
            enableCors: true,
            token: '',
          }],
          websocketServers: [{
            name: 'soulweave-' + label + '-ws',
            host: '127.0.0.1',
            port: ports.ws,
            enable: true,
            messagePostFormat: 'array',
            heartInterval: 30000,
            token: '',
          }],
        },
      },
    };
  }

  // ── 自主连续消息 ──

  getAutoLimits(): AutonomousLimits { return { ...this.autoLimits }; }

  setAutoLimits(patch: Partial<AutonomousLimits>): { ok: boolean; limits: AutonomousLimits; error?: string } {
    const next = { ...this.autoLimits };

    if (patch.maxMessagesPerRound !== undefined) {
      const v = validateQuota(patch.maxMessagesPerRound);
      if (!v.ok) return { ok: false, limits: { ...this.autoLimits }, error: v.error };
      next.maxMessagesPerRound = v.quota;
    }
    if (patch.cooldownSeconds !== undefined) {
      next.cooldownSeconds = Math.min(3600, Math.max(0, Math.round(Number(patch.cooldownSeconds) || 0)));
    }
    if (patch.dailyMaxRounds !== undefined) {
      next.dailyMaxRounds = Math.min(10000, Math.max(1, Math.round(Number(patch.dailyMaxRounds) || 1)));
    }
    if (patch.dailyMaxMessages !== undefined) {
      next.dailyMaxMessages = Math.min(10000, Math.max(1, Math.round(Number(patch.dailyMaxMessages) || 1)));
    }
    if (patch.maxRelayDepth !== undefined) {
      // 接力深度上限 3：再高就接近「互相刷屏」了
      next.maxRelayDepth = Math.min(3, Math.max(0, Math.round(Number(patch.maxRelayDepth) || 0)));
    }
    if (patch.quietHours !== undefined) next.quietHours = patch.quietHours;

    this.autoLimits = next;
    this.saveState();
    return { ok: true, limits: this.getAutoLimits() };
  }

  /** 用户叫停某个会话的自主轮次 */
  stopAutonomous(conversationKey: string): { ok: boolean; stopped: number } {
    let stopped = 0;
    for (const r of this.autonomy.activeRounds()) {
      if (r.conversationKey === conversationKey) {
        this.autonomy.endRound(r.id, 'cancelled');
        stopped++;
      }
    }
    return { ok: true, stopped };
  }

  /** 手动发起一轮自主消息（用户明确要求 AI 主动说话） */
  async startAutonomousRound(input: {
    accountLabel: string;
    scene: 'qq_group' | 'character_dm';
    conversationKey: string;
    target: { kind: 'private' | 'group'; id: string };
    quota?: number;
    prompt?: string;
  }): Promise<{ ok: boolean; sent?: number; reason?: string }> {
    const lim = limitsForScene(input.scene, undefined, this.autoLimits);
    const start = this.autonomy.startRound({
      scene: input.scene,
      conversationKey: input.conversationKey,
      accountLabel: input.accountLabel,
      quota: input.quota,
      relayDepth: 0,
      limits: lim,
    });
    if (!start.ok) return { ok: false, reason: start.reason };

    const roundId = start.round.id;
    let sent = 0;
    try {
      for (let i = 0; i < start.round.quota; i++) {
        const r = await this.opts.onAutonomous?.({
          accountLabel: input.accountLabel,
          roundId,
          index: i,
          quota: start.round.quota,
          prompt: input.prompt || '',
        });
        const text = r ? String(r).trim() : '';
        if (!text) break;

        const gate = checkOutbound(this.outbound, input.accountLabel, input.conversationKey, this.state.limits, Date.now());
        if (!gate.ok) { break; }

        const res = this.sendMessage(input.accountLabel, input.target, sanitizeOutgoing(text), null);
        if (!res.ok) break;

        commitOutbound(this.outbound, input.accountLabel, input.conversationKey, Date.now());
        const rec = this.autonomy.recordSend(roundId);
        sent++;
        if (rec.finished) break;
      }
    } finally {
      this.autonomy.endRound(roundId, 'completed');
      this.saveState();
    }
    return { ok: true, sent };
  }

  autonomousUsage(accountLabel: string, scene: 'qq_group' | 'character_dm') {
    return this.autonomy.usage(accountLabel, scene);
  }

  activeAutonomousRounds() {
    return this.autonomy.activeRounds();
  }

  /** 供 UI 显示 */
  snapshot(): any {
    return {
      accounts: this.manager.statuses(),
      policy: this.getPolicy(),
      policies: this.policiesByAccount(),
      limits: this.getLimits(),
      usage: Object.fromEntries(this.manager.statuses().map(s => [s.label, this.usage(s.label)])),
      groups: Object.fromEntries(this.groups),
      friends: Object.fromEntries(this.friends),
      autoLimits: this.getAutoLimits(),
      autoRounds: this.autonomy.activeRounds(),
      ports: this.listPorts(),
      codec: this.codecStatus(),
    };
  }
}
