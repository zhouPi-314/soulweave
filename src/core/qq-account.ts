/**
 * SoulWeave S5：QQ 双账号连接管理器
 *
 * 职责：管理 0–2 个 OneBot v11 连接的生命周期。
 * 不负责：消息解析（onebot-protocol）、任务计数（task-machine）、权限（permission-engine）。
 *
 * 【关键设计】
 * 1. **每账号独立连接**：两个 QQ 各连各的 OneBot 实例，互不影响。
 *    一个掉线不能让另一个也停。
 * 2. **令牌不进日志**：所有 URL 落日志前过 redactUrl()。
 * 3. **指数退避重连**：1s → 2s → 4s → … 上限 60s，避免被风控当成攻击。
 * 4. **状态可观测**：UI 要能显示「已连接 / 重连中 / 已停止 / 需要扫码」。
 *
 * 【为什么不直接 new WebSocket】
 * 传输层做成可注入的，测试时可以用假实现，不需要真实网络和真实 QQ 账号。
 */

import type { QqBackend } from '../shared/config-schema.js';
import { redactUrl } from './onebot-protocol.js';

export type AccountState =
  | 'idle'          // 未启用
  | 'connecting'    // 正在连接
  | 'online'        // 已连接
  | 'reconnecting'  // 断线重连中
  | 'stopped'       // 用户主动停止
  | 'failed';       // 连续失败，放弃

export interface AccountConfig {
  /** 账号标识（用户可读，如「冰糖号」），不是 QQ 号 */
  label: string;
  /** 绑定到哪个角色 */
  characterId: string | null;
  /** OneBot v11 WebSocket 地址 */
  wsUrl: string;
  /** 访问令牌（明文只在内存里，不落盘、不进日志） */
  accessToken: string | null;
  /** 仅显示用，不参与逻辑分支 */
  backend: QqBackend;
}

export interface AccountStatus {
  label: string;
  characterId: string | null;
  /**
   * 这个账号连的 OneBot 地址。
   *
   * 暴露出来是为了让「多实例」能对上号：
   * 实例按 wsPort 反查自己归哪个账号，没有这个字段就只能靠猜。
   */
  wsUrl: string;
  state: AccountState;
  /** 已登录的 QQ 号（连接后由 OneBot 上报） */
  selfId: string | null;
  /** 最近一次错误（已脱敏） */
  lastError: string | null;
  /** 重连次数 */
  retries: number;
  /** 下次重连时间（ms 时间戳），无则为 null */
  nextRetryAt: number | null;
  /** 已收到的消息事件数（用于 UI 显示活跃度） */
  received: number;
}

/** 可注入的传输层 */
export interface Transport {
  connect(url: string): Promise<void>;
  close(): void;
  send(payload: string): void;
  onOpen(cb: () => void): void;
  onClose(cb: (code: number, reason: string) => void): void;
  onMessage(cb: (data: string) => void): void;
  onError(cb: (err: string) => void): void;
}

export type TransportFactory = (label: string) => Transport;

export interface QqAccountManagerOptions {
  transportFactory: TransportFactory;
  /** 最大重连次数，默认 10（之后进入 failed） */
  maxRetries?: number;
  /** 初始退避毫秒，默认 1000 */
  baseBackoffMs?: number;
  /** 退避上限，默认 60000 */
  maxBackoffMs?: number;
  /** 事件回调（原始 JSON 字符串，由上层解析） */
  onEvent?: (label: string, raw: string) => void;
  /** 状态变化回调 */
  onStatusChange?: (status: AccountStatus) => void;
  /** 日志（已保证不含令牌） */
  log?: (msg: string) => void;
}

interface PendingAction {
  resolve: (r: ActionReceipt) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface AccountRuntime {
  cfg: AccountConfig;
  transport: Transport | null;
  status: AccountStatus;
  retryTimer: ReturnType<typeof setTimeout> | null;
  stoppedByUser: boolean;
  /** echo → 等待中的动作回执（见 sendActionAwait） */
  pending: Map<string, PendingAction>;
}

/** 一次动作的**真实**回执。ok 只由 retcode/status 决定，不看出站是否写成功。 */
export interface ActionReceipt {
  ok: boolean;
  /** OneBot retcode；-1 表示没有收到回执（超时/未连接） */
  retcode: number;
  status: 'ok' | 'failed' | 'async' | 'unknown';
  data: any;
  echo: string;
  /** 失败时的可读原因（含 OneBot 的 wording / message） */
  error?: string;
  /** 是否在超时内收到回执 */
  replied: boolean;
}

/**
 * 计算退避时间：base * 2^retries，封顶 max，并加 ±20% 抖动。
 *
 * 抖动是必须的：两个账号同时掉线时，如果退避完全一致，
 * 重连请求会永远同时到达，形成规律性尖峰，容易被风控识别。
 */
export function backoffDelay(retries: number, baseMs: number, maxMs: number): number {
  const exp = Math.min(maxMs, baseMs * Math.pow(2, Math.max(0, retries)));
  const jitter = 0.8 + Math.random() * 0.4;   // 0.8 – 1.2
  return Math.min(maxMs, Math.round(exp * jitter));
}

export class QqAccountManager {
  private accounts = new Map<string, AccountRuntime>();
  private opts: Required<Pick<QqAccountManagerOptions, 'maxRetries' | 'baseBackoffMs' | 'maxBackoffMs'>> & QqAccountManagerOptions;

  constructor(options: QqAccountManagerOptions) {
    this.opts = {
      maxRetries: 10,
      baseBackoffMs: 1000,
      maxBackoffMs: 60_000,
      ...options,
    };
  }

  /** 注册或更新一个账号（不自动连接） */
  upsertAccount(cfg: AccountConfig): AccountStatus {
    const existing = this.accounts.get(cfg.label);
    if (existing) {
      existing.cfg = cfg;
      existing.status.wsUrl = cfg.wsUrl;
      existing.status.characterId = cfg.characterId;
      return { ...existing.status };
    }
    const rt: AccountRuntime = {
      cfg,
      transport: null,
      stoppedByUser: false,
      retryTimer: null,
      pending: new Map(),
      status: {
        label: cfg.label,
        characterId: cfg.characterId,
        wsUrl: cfg.wsUrl,
        state: 'idle',
        selfId: null,
        lastError: null,
        retries: 0,
        nextRetryAt: null,
        received: 0,
      },
    };
    this.accounts.set(cfg.label, rt);
    return { ...rt.status };
  }

  /** 启动一个账号的连接 */
  async start(label: string): Promise<AccountStatus> {
    const rt = this.accounts.get(label);
    if (!rt) throw new Error('账号不存在: ' + label);
    if (!rt.cfg.wsUrl) {
      this.setStatus(rt, { state: 'failed', lastError: '未配置 WebSocket 地址' });
      return { ...rt.status };
    }
    rt.stoppedByUser = false;
    await this.connect(rt);
    return { ...rt.status };
  }

  /** 用户主动停止（不再自动重连） */
  stop(label: string): AccountStatus {
    const rt = this.accounts.get(label);
    if (!rt) throw new Error('账号不存在: ' + label);
    rt.stoppedByUser = true;
    if (rt.retryTimer) { clearTimeout(rt.retryTimer); rt.retryTimer = null; }
    try { rt.transport?.close(); } catch (e) { void e; }
    rt.transport = null;
    this.setStatus(rt, { state: 'stopped', nextRetryAt: null });
    return { ...rt.status };
  }

  /** 停止全部（应用退出时调用） */
  stopAll(): void {
    for (const label of this.accounts.keys()) {
      try { this.stop(label); } catch (e) { void e; }
    }
  }

  /** 断开但保留自动重连（网络恢复后由调度器重试） */
  disconnect(label: string): void {
    const rt = this.accounts.get(label);
    if (!rt) return;
    try { rt.transport?.close(); } catch (e) { void e; }
    rt.transport = null;
  }

  /** 记录 self_id（从事件里学到） */
  setSelfId(label: string, selfId: string): void {
    const rt = this.accounts.get(label);
    if (rt) { (rt.status as any).selfId = selfId; }
  }

  status(label: string): AccountStatus | null {
    const rt = this.accounts.get(label);
    return rt ? { ...rt.status } : null;
  }

  statuses(): AccountStatus[] {
    return [...this.accounts.values()].map(r => ({ ...r.status }));
  }

  /** 向指定账号发送动作请求 */
  sendAction(label: string, action: unknown): { ok: boolean; error?: string } {
    const rt = this.accounts.get(label);
    if (!rt) return { ok: false, error: '账号不存在' };
    if (!rt.transport) return { ok: false, error: '未连接' };
    if (rt.status.state !== 'online') return { ok: false, error: '状态为 ' + rt.status.state };
    try {
      rt.transport.send(JSON.stringify(action));
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e).slice(0, 150) };
    }
  }

  /**
   * 发送动作并**等待 OneBot 的真实回执**。
   *
   * 【为什么必须等回执】
   * sendAction 返回 ok 只代表「这一帧写进了 WebSocket」。
   * 消息到底有没有被 QQ 收下，只有回执里的 retcode / message_id 知道。
   * 之前的推送测试就栽在这：socket 写成功 = ok，于是「发送成功」是假的，
   * 用户那边一条也没收到。
   *
   * 回执通过 echo 关联。OneBot 按 echo 原样回显，所以只要每次请求带唯一 echo，
   * 就能把 N 个并发请求和它们的回执一一对上。
   */
  async sendActionAwait(
    label: string,
    action: { action: string; params?: Record<string, unknown>; echo?: string },
    timeoutMs = 10_000,
  ): Promise<ActionReceipt> {
    const rt = this.accounts.get(label);
    const echo = action.echo || 'sw-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    const base: ActionReceipt = { ok: false, retcode: -1, status: 'unknown', data: null, echo, replied: false };

    if (!rt) return { ...base, error: '账号不存在' };
    if (!rt.transport) return { ...base, error: '未连接' };
    if (rt.status.state !== 'online') return { ...base, error: '状态为 ' + rt.status.state };

    const payload = JSON.stringify({ ...action, echo });
    return new Promise<ActionReceipt>((resolve) => {
      const timer = setTimeout(() => {
        rt.pending.delete(echo);
        resolve({ ...base, error: '等 OneBot 回执超时（' + Math.round(timeoutMs / 1000) + 's）' });
      }, Math.max(500, timeoutMs));
      rt.pending.set(echo, { resolve, timer });
      try {
        rt.transport!.send(payload);
      } catch (e) {
        clearTimeout(timer);
        rt.pending.delete(echo);
        resolve({ ...base, error: '发送失败：' + String(e).slice(0, 120) });
      }
    });
  }

  // ── 内部 ──

  /** 把一条原始帧当作动作回执处理；命中返回 true（说明它不是事件） */
  private settlePending(rt: AccountRuntime, raw: string): boolean {
    if (!rt.pending.size) return false;
    let obj: any;
    try { obj = JSON.parse(raw); } catch (e) { return false; }
    if (!obj || typeof obj !== 'object') return false;
    // 事件一定带 post_type；回执一定不带
    if (obj.post_type) return false;
    const echo = obj.echo == null ? '' : String(obj.echo);
    if (!echo) return false;
    const p = rt.pending.get(echo);
    if (!p) return false;
    rt.pending.delete(echo);
    clearTimeout(p.timer);

    const status = obj.status === 'ok' ? 'ok' : obj.status === 'failed' ? 'failed' : obj.status === 'async' ? 'async' : 'unknown';
    const retcode = Number.isFinite(Number(obj.retcode)) ? Number(obj.retcode) : -1;
    const wording = obj.wording || obj.message || (obj.data && (obj.data.wording || obj.data.message)) || '';
    p.resolve({
      ok: status === 'ok' && retcode === 0,
      retcode, status,
      data: obj.data ?? null,
      echo,
      replied: true,
      error: status === 'ok' && retcode === 0 ? undefined : String(wording || ('retcode ' + retcode)),
    });
    return true;
  }

  /** 断线时把所有等待中的动作立刻失败，别让上层卡到超时 */
  private failPending(rt: AccountRuntime, reason: string): void {
    for (const [echo, p] of rt.pending) {
      clearTimeout(p.timer);
      p.resolve({ ok: false, retcode: -1, status: 'unknown', data: null, echo, replied: false, error: reason });
    }
    rt.pending.clear();
  }

  private async connect(rt: AccountRuntime): Promise<void> {
    if (rt.retryTimer) { clearTimeout(rt.retryTimer); rt.retryTimer = null; }
    this.setStatus(rt, { state: rt.status.retries > 0 ? 'reconnecting' : 'connecting', nextRetryAt: null });

    let t: Transport;
    try {
      t = this.opts.transportFactory(rt.cfg.label);
    } catch (e) {
      this.scheduleRetry(rt, '创建连接失败: ' + String(e).slice(0, 120));
      return;
    }
    rt.transport = t;

    t.onOpen(() => {
      this.setStatus(rt, { state: 'online', retries: 0, lastError: null, nextRetryAt: null });
      this.log(rt, '已连接 ' + redactUrl(rt.cfg.wsUrl));
    });

    t.onClose((code, reason) => {
      rt.transport = null;
      this.failPending(rt, '连接已关闭 code=' + code + ' ' + String(reason || '').slice(0, 60));
      if (rt.stoppedByUser) return;
      this.scheduleRetry(rt, '连接关闭 code=' + code + ' ' + String(reason || '').slice(0, 80));
    });

    t.onError((err) => {
      rt.status.lastError = redactUrl(String(err)).slice(0, 200);
      this.emit(rt);
    });

    t.onMessage((data) => {
      rt.status.received++;
      // 动作回执（有 echo、没有 post_type）不是事件，绝不能当消息事件往上抛，
      // 否则会被当成「有人说了话」触发角色回复。
      if (this.settlePending(rt, data)) return;
      try { this.opts.onEvent?.(rt.cfg.label, data); } catch (e) { void e; }
    });

    try {
      // 令牌通过 URL 传递（OneBot 标准做法），但绝不落日志
      const url = rt.cfg.wsUrl;
      this.log(rt, '正在连接 ' + redactUrl(url));
      await t.connect(url);
    } catch (e) {
      this.scheduleRetry(rt, '连接异常: ' + redactUrl(String(e)).slice(0, 120));
    }
  }

  private scheduleRetry(rt: AccountRuntime, reason: string): void {
    if (rt.stoppedByUser) return;
    const retries = rt.status.retries + 1;

    if (retries > this.opts.maxRetries) {
      this.setStatus(rt, { state: 'failed', retries, lastError: reason, nextRetryAt: null });
      this.log(rt, '重连次数超限，停止: ' + reason);
      return;
    }

    const delay = backoffDelay(retries, this.opts.baseBackoffMs, this.opts.maxBackoffMs);
    this.setStatus(rt, {
      state: 'reconnecting',
      retries,
      lastError: reason,
      nextRetryAt: Date.now() + delay,
    });
    this.log(rt, '将在 ' + delay + 'ms 后重连（第 ' + retries + ' 次）: ' + reason);

    rt.retryTimer = setTimeout(() => {
      rt.retryTimer = null;
      if (!rt.stoppedByUser) void this.connect(rt);
    }, delay);
  }

  private setStatus(rt: AccountRuntime, patch: Partial<AccountStatus>): void {
    rt.status = { ...rt.status, ...patch };
    this.emit(rt);
  }

  private emit(rt: AccountRuntime): void {
    try { this.opts.onStatusChange?.({ ...rt.status }); } catch (e) { void e; }
  }

  private log(rt: AccountRuntime, msg: string): void {
    // 双重保险：即使调用方传了带令牌的串，这里再脱敏一次
    this.opts.log?.('[' + rt.cfg.label + '] ' + redactUrl(msg));
  }
}
