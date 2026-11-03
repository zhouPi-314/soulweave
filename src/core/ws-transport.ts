/**
 * SoulWeave S5：基于 ws 的 OneBot v11 传输层
 *
 * 只做一件事：把 WebSocket 的字节流包装成 qq-account.ts 需要的 Transport 接口。
 * 不解析业务、不判断权限、不碰任务状态。
 *
 * 【设计要点】
 * 1. 令牌通过 URL query 传递（OneBot v11 标准做法），但**日志一律脱敏**
 * 2. 连接超时独立于重连退避 —— 连不上和连上又断是两回事
 * 3. 关闭时先摘掉监听器再 close，避免触发「意外断开」导致误重连
 */

import { WebSocket } from 'ws';
import type { Transport } from './qq-account.js';
import { redactUrl } from './onebot-protocol.js';

export interface WsTransportOptions {
  /** 连接超时毫秒，默认 10 秒 */
  connectTimeoutMs?: number;
  /** 心跳间隔毫秒，0 表示不启用心跳 */
  pingIntervalMs?: number;
}

export class WsTransport implements Transport {
  private ws: WebSocket | null = null;
  private openCb: (() => void) | null = null;
  private closeCb: ((code: number, reason: string) => void) | null = null;
  private msgCb: ((data: string) => void) | null = null;
  private errCb: ((err: string) => void) | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private closedByUs = false;
  private readonly opts: Required<WsTransportOptions>;

  constructor(options: WsTransportOptions = {}) {
    this.opts = {
      connectTimeoutMs: 10_000,
      pingIntervalMs: 30_000,
      ...options,
    };
  }

  async connect(url: string): Promise<void> {
    this.closedByUs = false;
    const safeUrl = redactUrl(url);

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let ws: WebSocket;
      try {
        ws = new WebSocket(url, { handshakeTimeout: this.opts.connectTimeoutMs });
      } catch (e) {
        reject(new Error('创建连接失败 ' + safeUrl + ': ' + String(e).slice(0, 120)));
        return;
      }
      this.ws = ws;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { ws.terminate(); } catch (e) { void e; }
        reject(new Error('连接超时 ' + safeUrl));
      }, this.opts.connectTimeoutMs);

      ws.on('open', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.startPing();
        this.openCb?.();
        resolve();
      });

      ws.on('message', (data: unknown) => {
        try {
          const text = typeof data === 'string' ? data : String(data);
          this.msgCb?.(text);
        } catch (e) { void e; }
      });

      ws.on('error', (err: Error) => {
        const msg = redactUrl(String(err?.message || err)).slice(0, 200);
        this.errCb?.(msg);
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error('连接错误 ' + safeUrl + ': ' + msg));
        }
      });

      ws.on('close', (code: number, reason: Buffer) => {
        clearTimeout(timer);
        this.stopPing();
        const r = reason ? reason.toString().slice(0, 120) : '';
        if (!settled) {
          settled = true;
          reject(new Error('连接被关闭 ' + safeUrl + ' code=' + code));
          return;
        }
        // 主动关闭不触发重连回调
        if (!this.closedByUs) this.closeCb?.(code, r);
      });
    });
  }

  close(): void {
    this.closedByUs = true;
    this.stopPing();
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    try {
      // 先摘监听器：避免 close 事件里再触发一次「意外断开」
      ws.removeAllListeners('close');
      ws.close();
    } catch (e) { void e; }
    // 兜底：3 秒还没关掉就强杀，防止句柄泄漏
    setTimeout(() => {
      try { ws.terminate(); } catch (e) { void e; }
    }, 3000).unref?.();
  }

  send(payload: string): void {
    const ws = this.ws;
    if (!ws) throw new Error('未连接');
    if (ws.readyState !== WebSocket.OPEN) throw new Error('连接未就绪 (readyState=' + ws.readyState + ')');
    ws.send(payload);
  }

  onOpen(cb: () => void): void { this.openCb = cb; }
  onClose(cb: (code: number, reason: string) => void): void { this.closeCb = cb; }
  onMessage(cb: (data: string) => void): void { this.msgCb = cb; }
  onError(cb: (err: string) => void): void { this.errCb = cb; }

  private startPing(): void {
    if (this.opts.pingIntervalMs <= 0) return;
    this.stopPing();
    this.pingTimer = setInterval(() => {
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      try { ws.ping(); } catch (e) { void e; }
    }, this.opts.pingIntervalMs);
    this.pingTimer.unref?.();
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }
}

/**
 * 探测本地 OneBot 服务。
 *
 * 规划里写了「引导页自动发现本地 OneBot 服务」，
 * 这里实现最小可用版本：并发探测几个常见端口，看 WS 能不能握上手。
 *
 * 注意：**只探测 localhost**。不去扫局域网 —— 那属于越权探测。
 */
export async function probeOneBotPorts(
  ports: number[],
  timeoutMs = 1200,
): Promise<Array<{ port: number; ok: boolean; url: string }>> {
  const tasks = ports.map((port) => new Promise<{ port: number; ok: boolean; url: string }>((resolve) => {
    const url = 'ws://127.0.0.1:' + port;
    let done = false;
    let ws: WebSocket | null = null;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      try { ws?.removeAllListeners(); ws?.terminate(); } catch (e) { void e; }
      resolve({ port, ok, url });
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    try {
      ws = new WebSocket(url, { handshakeTimeout: timeoutMs });
      ws.on('open', () => { clearTimeout(timer); finish(true); });
      ws.on('error', () => { clearTimeout(timer); finish(false); });
      ws.on('close', () => { clearTimeout(timer); finish(false); });
    } catch (e) {
      clearTimeout(timer);
      finish(false);
    }
  }));
  return Promise.all(tasks);
}
