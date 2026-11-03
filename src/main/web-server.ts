/**
 * SoulWeave S8：手机 Web / 远程访问的 HTTP + WS 服务
 *
 * 【为什么独立成文件，而不是继续往 index.ts 里堆】
 * index.ts 已经 33 万字节。Web 服务对外暴露，是最需要单独审计的一块；
 * 放在这里可以完全不 import electron，用 scripts/test-web-server.mjs
 * 起真服务、发真请求来测。
 *
 * 【安全底线（每一条都对应 ADR-6 的一条决策）】
 *   1. 路由是**白名单**，不是 ipcMain 镜像。不存在 /api/ipc?channel=...
 *   2. 除 /api/health、/api/pair、/api/session 外，全部要会话令牌 + 作用域
 *   3. 静态文件只从 webRoot 出，路径穿越、点文件、未知后缀一律 404
 *   4. 请求体上限 64 KB，超了直接断开，不缓冲
 *   5. 认证失败的请求计入 IP 退避
 *   6. 默认只监听 127.0.0.1（由调用方决定 host，这里不强加）
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import type { WebAuth, WebScope } from '../core/web-auth.js';

// ── 对外接口 ───────────────────────────────────────────

/** 主进程注入的窄接口：Web 只可能调用到这里 */
export type WebApiHost = {
  version(): string;
  /** [view] 概览：两个角色、服务状态、资源 */
  status(ctx: { deviceId: string }): Promise<unknown>;
  /** [view] 角色列表 */
  characters(): Promise<unknown>;
  /** [chat] 发一条消息，走 Core 同一路径 */
  chat(input: { text: string; characterId: string; origin: 'web' }, ctx: { deviceId: string }): Promise<unknown>;
  /** [memory:read] */
  memorySearch(input: { q: string; limit: number; ownerCharacter?: string }, ctx: { deviceId: string }): Promise<unknown>;

  /** [memory:write] 标记 / 取消「别忘」。不改内容、不删除，最安全的写操作 */
  memoryPin?(input: { id: string; pinned: boolean; ownerCharacter?: string }, ctx: { deviceId: string }): Promise<unknown>;
  /** [social:read] */
  socialStatus(ctx: { deviceId: string }): Promise<unknown>;

  /**
   * [chat] 流式聊天。实现方每拿到一段文字就调 emit，
   * 服务端立刻转成 chat.delta 推给浏览器。
   *
   * DSH 的 --json 只在一个 assistant 消息**提交**后才发 text 事件，
   * 所以这里是「一段一段」而不是「一字一字」；对 40 秒的等待来说已经够用。
   * 不提供时退回 chat()，一次性返回。
   */
  chatStream?(input: { text: string; characterId: string; origin: 'web' }, ctx: { deviceId: string },
    emit: (ev: { type: 'text' | 'progress'; text: string }) => void): Promise<unknown>;

  /** [chat] 语音转写：入参是 base64 音频，返回文本 */
  asr?(input: { audioBase64: string; mime?: string }, ctx: { deviceId: string }): Promise<unknown>;

  /** [chat] 语音合成：返回 base64 wav */
  tts?(input: { text: string; characterId?: string }, ctx: { deviceId: string }): Promise<unknown>;
};

export type WebServerOptions = {
  auth: WebAuth;
  host: WebApiHost;
  /** dist/web 的绝对路径 */
  webRoot: string;
  port: number;
  /** 监听地址，默认 127.0.0.1 */
  bindHost?: string;
  /** 日志（默认不输出） */
  log?: (line: string) => void;
};

export type WebServerInfo = {
  running: boolean;
  host: string;
  port: number;
  url: string;
  /** 是否只监听回环 */
  loopbackOnly: boolean;
};

const MAX_BODY = 64 * 1024;
/** 语音接口要传音频，单独放宽（约 3 分钟 opus / 1 分钟 16k wav） */
const MAX_AUDIO_BODY = 8 * 1024 * 1024;
const AUTH_TIMEOUT_MS = 5000;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

// ── 小工具 ─────────────────────────────────────────────

function send(res: http.ServerResponse, code: number, body: unknown, extra: Record<string, string> = {}): void {
  const isStr = typeof body === 'string';
  const payload = isStr ? (body as string) : JSON.stringify(body ?? null);
  res.writeHead(code, {
    'Content-Type': isStr ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    ...extra,
  });
  res.end(payload);
}
function json(res: http.ServerResponse, code: number, body: unknown): void {
  send(res, code, body);
}

function clientIp(req: http.IncomingMessage): string {
  // 只信任 socket 地址。不做 X-Forwarded-For 解析：
  // 那些头可以被任意伪造，用它们做限速等于给攻击者一个绕过开关。
  const a = req.socket.remoteAddress || '';
  return a.replace(/^::ffff:/, '');
}

async function readJson(req: http.IncomingMessage, maxBytes = MAX_BODY): Promise<{ ok: true; value: any } | { ok: false; code: number; error: string }> {
  const ct = String(req.headers['content-type'] || '');
  if (!/^application\/json\b/i.test(ct)) return { ok: false, code: 415, error: '需要 application/json' };
  const len = Number(req.headers['content-length'] || 0);
  if (len > maxBytes) return { ok: false, code: 413, error: '请求体过大' };
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    total += (c as Buffer).length;
    if (total > maxBytes) {
      // 不 destroy：还能把 413 写回去，客户端才知道发生了什么。
      // 剩下没读的字节由 Node 自己丢弃，requestTimeout 兜底。
      return { ok: false, code: 413, error: '请求体过大' };
    }
    chunks.push(c as Buffer);
  }
  if (!total) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
  } catch {
    return { ok: false, code: 400, error: 'JSON 解析失败' };
  }
}

function bearer(req: http.IncomingMessage): string {
  const h = String(req.headers.authorization || '');
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : '';
}

/** 允许的 MIME 后缀白名单。未知后缀不服务，避免把 .map/.bak/.env 之类漏出去 */
function isServable(p: string): boolean {
  return Object.prototype.hasOwnProperty.call(MIME, path.extname(p).toLowerCase());
}

// ── 服务 ───────────────────────────────────────────────

export class WebServer {
  private opts: WebServerOptions;
  private server: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private sockets = new Set<WebSocket>();
  private listening = false;
  private boundPort = 0;

  constructor(opts: WebServerOptions) {
    this.opts = opts;
  }

  private log(s: string): void {
    if (this.opts.log) this.opts.log(s);
  }

  info(): WebServerInfo {
    const host = this.opts.bindHost || '127.0.0.1';
    const loopbackOnly = host === '127.0.0.1' || host === 'localhost' || host === '::1';
    return {
      running: this.listening,
      host,
      port: this.boundPort || this.opts.port,
      url: 'http://' + (host === '0.0.0.0' ? '127.0.0.1' : host) + ':' + (this.boundPort || this.opts.port),
      loopbackOnly,
    };
  }

  async start(): Promise<WebServerInfo> {
    if (this.server) return this.info();
    const srv = http.createServer((req, res) => {
      this.handle(req, res).catch((e) => {
        this.log('handler error: ' + String(e));
        try { json(res, 500, { ok: false, error: 'internal' }); } catch { /* 响应可能已发出 */ }
      });
    });
    // 头部超时：慢速攻击（slowloris）不应拖住进程
    srv.headersTimeout = 10_000;
    srv.requestTimeout = 20_000;
    srv.keepAliveTimeout = 5_000;

    this.wss = new WebSocketServer({ noServer: true });
    srv.on('upgrade', (req, socket, head) => {
      const u = safeUrl(req);
      if (!u || u.pathname !== '/ws') { socket.destroy(); return; }
      this.wss!.handleUpgrade(req, socket, head, (ws) => this.onWs(ws, req));
    });

    await new Promise<void>((resolve, reject) => {
      const onErr = (e: Error) => reject(e);
      srv.once('error', onErr);
      srv.listen(this.opts.port, this.opts.bindHost || '127.0.0.1', () => {
        srv.off('error', onErr);
        const addr = srv.address();
        this.boundPort = typeof addr === 'object' && addr ? addr.port : this.opts.port;
        resolve();
      });
    });

    this.server = srv;
    this.listening = true;
    this.log('web listening ' + this.info().url);
    return this.info();
  }

  /** 关闭：先解 WS，再关 HTTP。返回时端口已释放 */
  async stop(): Promise<void> {
    for (const ws of this.sockets) {
      try { ws.close(1001, 'server stopping'); } catch { /* ignore */ }
    }
    this.sockets.clear();
    if (this.wss) { try { this.wss.close(); } catch { /* ignore */ } this.wss = null; }
    const srv = this.server;
    this.server = null;
    this.listening = false;
    if (!srv) return;
    await new Promise<void>((resolve) => {
      srv.close(() => resolve());
      // 兜底：keep-alive 连接可能挂住 close
      setTimeout(() => resolve(), 1500).unref?.();
    });
  }

  /** 向所有已认证连接广播（状态变更等） */
  broadcast(type: string, payload: unknown): void {
    const msg = JSON.stringify({ type, payload });
    for (const ws of this.sockets) {
      if (ws.readyState === WebSocket.OPEN) { try { ws.send(msg); } catch { /* ignore */ } }
    }
  }

  // ── HTTP 路由 ──

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const u = safeUrl(req);
    if (!u) { json(res, 400, { ok: false, error: 'bad url' }); return; }
    const method = String(req.method || 'GET').toUpperCase();
    const p = u.pathname;

    // 基础安全头（页面也带，见 serveStatic 的 CSP）
    res.setHeader('X-Frame-Options', 'DENY');

    if (p.startsWith('/api/')) {
      await this.handleApi(method, p, req, res);
      return;
    }
    if (method !== 'GET' && method !== 'HEAD') { json(res, 405, { ok: false, error: 'method' }); return; }
    this.serveStatic(p, req, res);
  }

  private async handleApi(method: string, p: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const ip = clientIp(req);
    const auth = this.opts.auth;

    // —— 无需认证 ——
    if (method === 'GET' && p === '/api/health') {
      json(res, 200, { ok: true, name: 'SoulWeave', version: this.opts.host.version() });
      return;
    }

    if (p === '/api/pair') {
      if (method !== 'POST') { json(res, 405, { ok: false, error: 'method' }); return; }
      const body = await readJson(req);
      if (!body.ok) { json(res, body.code, { ok: false, error: body.error }); return; }
      const r = auth.pair(String((body.value && body.value.code) || ''), {
        ip,
        label: String((body.value && body.value.label) || ''),
        userAgent: String(req.headers['user-agent'] || ''),
      });
      if (!r.ok) {
        if (r.retryAfterMs) res.setHeader('Retry-After', String(Math.ceil(r.retryAfterMs / 1000)));
        json(res, r.reason === 'rate_limited' ? 429 : 401, { ok: false, reason: r.reason });
        return;
      }
      json(res, 200, { ok: true, deviceToken: r.token, deviceId: r.deviceId, scopes: r.scopes });
      return;
    }

    if (p === '/api/session') {
      if (method === 'POST') {
        const body = await readJson(req);
        if (!body.ok) { json(res, body.code, { ok: false, error: body.error }); return; }
        const r = auth.createSession(String((body.value && body.value.deviceToken) || ''), { ip });
        if (!r.ok) {
          if (r.retryAfterMs) res.setHeader('Retry-After', String(Math.ceil(r.retryAfterMs / 1000)));
          json(res, r.reason === 'rate_limited' ? 429 : 401, { ok: false, reason: r.reason });
          return;
        }
        json(res, 200, { ok: true, sessionToken: r.token, scopes: r.scopes, expiresAt: r.expiresAt });
        return;
      }
      if (method === 'DELETE') {
        auth.destroySession(bearer(req));
        json(res, 200, { ok: true });
        return;
      }
      json(res, 405, { ok: false, error: 'method' });
      return;
    }

    // —— 需要会话 ——
    //
    // 【限速只拦「猜令牌」，不拦自己的合法会话】
    //
    // 早先的写法是「先查退避，再校验令牌」，结果上一次 401 会让这个 IP
    // 在接下来 1 秒内连带着合法令牌的请求一起 429 —— 用户打错一次就被锁。
    // 现在先做一次廉价判断：这个令牌在不在我们的会话表里。
    //   · 在表里  → 不可能是猜的，跳过退避，直接校验
    //   · 不在表里 → 算「猜」，仍处于退避/锁定期的直接 429，连校验都不做
    const token = bearer(req);
    if (!auth.hasSession(token)) {
      const rl = auth.checkRate('auth:' + ip, ip);
      if (!rl.ok) {
        if (rl.retryAfterMs) res.setHeader('Retry-After', String(Math.max(1, Math.ceil(rl.retryAfterMs / 1000))));
        json(res, 429, { ok: false, reason: 'rate_limited' });
        return;
      }
    }
    const need = requiredScope(p, method);
    if (!need) { json(res, 404, { ok: false, error: 'not found' }); return; }

    if (need !== 'any') {
      const a = auth.authorize(token, need, ip);
      if (a.ok) auth.noteSuccess('auth:' + ip);
      if (!a.ok) {
        if (a.reason === 'rate_limited') { json(res, 429, { ok: false, reason: a.reason }); return; }
        auth.noteFailure('auth:' + ip, ip);
        json(res, 401, { ok: false, reason: a.reason });
        return;
      }
    } else {
      // 只要「有个有效会话」即可（例如申请管理员）
      if (!auth.authorize(token, 'view', ip).ok) { auth.noteFailure('auth:' + ip, ip); json(res, 401, { ok: false, reason: 'no_session' }); return; }
    }

    await this.dispatch(method, p, req, res, token, need);
  }

  private async dispatch(
    method: string, p: string, req: http.IncomingMessage, res: http.ServerResponse,
    token: string, need: WebScope | 'any'
  ): Promise<void> {
    const auth = this.opts.auth;
    const host = this.opts.host;
    const ctxOf = () => {
      const a = auth.authorize(token, 'view');
      return { deviceId: a.ok ? a.deviceId : '' };
    };

    if (method === 'GET' && p === '/api/whoami') {
      const a = auth.authorize(token, 'view');
      json(res, 200, { ok: true, scopes: a.ok ? a.scopes : [], deviceId: a.ok ? a.deviceId : '' });
      return;
    }
    if (method === 'GET' && p === '/api/status') {
      json(res, 200, { ok: true, data: await host.status(ctxOf()) });
      return;
    }
    if (method === 'GET' && p === '/api/characters') {
      json(res, 200, { ok: true, data: await host.characters() });
      return;
    }
    if (method === 'POST' && p === '/api/chat') {
      const body = await readJson(req);
      if (!body.ok) { json(res, body.code, { ok: false, error: body.error }); return; }
      const text = String((body.value && body.value.text) || '').slice(0, 4000).trim();
      if (!text) { json(res, 400, { ok: false, error: '内容为空' }); return; }
      const characterId = String((body.value && body.value.characterId) || '0');
      const r = await host.chat({ text, characterId, origin: 'web' }, ctxOf());
      json(res, 200, { ok: true, data: r });
      return;
    }
    if (method === 'GET' && p === '/api/memory/search') {
      const u = safeUrl(req)!;
      const q = String(u.searchParams.get('q') || '').slice(0, 200);
      const limit = Math.min(50, Math.max(1, Number(u.searchParams.get('limit') || 10) || 10));
      const ownerCharacter = String(u.searchParams.get('character') || '').slice(0, 64);
      json(res, 200, { ok: true, data: await host.memorySearch({ q, limit, ownerCharacter }, ctxOf()) });
      return;
    }
    if (method === 'POST' && p === '/api/asr') {
      if (!host.asr) { json(res, 501, { ok: false, error: '语音转写未启用' }); return; }
      const body = await readJson(req, MAX_AUDIO_BODY);
      if (!body.ok) { json(res, body.code, { ok: false, error: body.error }); return; }
      const audioBase64 = String((body.value && body.value.audioBase64) || '');
      if (!audioBase64) { json(res, 400, { ok: false, error: '没有音频' }); return; }
      const r: any = await host.asr({ audioBase64, mime: String((body.value && body.value.mime) || '') }, ctxOf());
      json(res, 200, { ok: !!(r && r.ok), text: String((r && r.text) || ''), code: (r && r.code) || '', error: String((r && r.error) || '') });
      return;
    }
    if (method === 'POST' && p === '/api/tts') {
      if (!host.tts) { json(res, 501, { ok: false, error: '语音合成未启用' }); return; }
      const body = await readJson(req);
      if (!body.ok) { json(res, body.code, { ok: false, error: body.error }); return; }
      const text = String((body.value && body.value.text) || '').slice(0, 1200);
      if (!text.trim()) { json(res, 400, { ok: false, error: '内容为空' }); return; }
      const r: any = await host.tts({ text, characterId: String((body.value && body.value.characterId) || '0') }, ctxOf());
      if (!r || !r.ok || !r.base64) { json(res, 200, { ok: false, error: String((r && r.error) || '合成失败') }); return; }
      json(res, 200, { ok: true, audioBase64: r.base64, mime: 'audio/wav', voiceId: (r && r.voiceId) || '' });
      return;
    }
    if (method === 'GET' && p === '/api/social/status') {
      json(res, 200, { ok: true, data: await host.socialStatus(ctxOf()) });
      return;
    }
    if (method === 'POST' && p === '/api/memory/pin') {
      if (!host.memoryPin) { json(res, 501, { ok: false, error: '记忆修改未启用' }); return; }
      const body = await readJson(req);
      if (!body.ok) { json(res, body.code, { ok: false, error: body.error }); return; }
      const id = String((body.value && body.value.id) || '').slice(0, 64);
      if (!id) { json(res, 400, { ok: false, error: '缺少记忆 id' }); return; }
      const r: any = await host.memoryPin({
        id,
        pinned: (body.value && body.value.pinned) === true,
        ownerCharacter: String((body.value && body.value.ownerCharacter) || ''),
      }, ctxOf());
      json(res, 200, { ok: !!(r && r.ok), changed: (r && r.changed) || 0, error: String((r && r.error) || '') });
      return;
    }
    if (method === 'GET' && p === '/api/devices') {
      json(res, 200, { ok: true, data: auth.listDevices() });
      return;
    }
    const rev = /^\/api\/devices\/([A-Za-z0-9_-]{1,64})$/.exec(p);
    if (rev && method === 'DELETE') {
      const ok = auth.revokeDevice(rev[1], clientIp(req));
      json(res, ok ? 200 : 404, { ok });
      return;
    }
    if (method === 'POST' && p === '/api/admin/request') {
      const body = await readJson(req);
      if (!body.ok) { json(res, body.code, { ok: false, error: body.error }); return; }
      const r = auth.requestApproval(token, (body.value && body.value.scopes) || [], clientIp(req));
      json(res, r.ok ? 200 : 403, r.ok ? { ok: true, approvalId: r.approvalId } : { ok: false, reason: r.reason });
      return;
    }

    void need;
    json(res, 404, { ok: false, error: 'not found' });
  }

  // ── 静态文件 ──

  private serveStatic(rawPath: string, req: http.IncomingMessage, res: http.ServerResponse): void {
    let rel: string;
    try {
      rel = decodeURIComponent(rawPath);
    } catch {
      json(res, 400, { ok: false, error: 'bad path' });
      return;
    }
    if (rel.indexOf('\0') >= 0) { json(res, 400, { ok: false, error: 'bad path' }); return; }
    if (rel === '/' || rel === '') rel = '/index.html';
    // 只允许根路径下的相对路径，且不允许点文件
    if (!rel.startsWith('/')) { json(res, 404, { ok: false, error: 'not found' }); return; }
    const segs = rel.split('/').filter(Boolean);
    if (segs.some((s) => s === '..' || s === '.' || s.startsWith('.'))) { json(res, 404, { ok: false, error: 'not found' }); return; }

    const root = path.resolve(this.opts.webRoot);
    let file = path.resolve(root, segs.join(path.sep));
    if (file !== root && !file.startsWith(root + path.sep)) { json(res, 404, { ok: false, error: 'not found' }); return; }

    // 无后缀（前端路由）→ index.html；有后缀但不在白名单 → 404
    if (!path.extname(file)) {
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) file = path.join(root, 'index.html');
    }
    if (!isServable(file)) { json(res, 404, { ok: false, error: 'not found' }); return; }

    let st: fs.Stats;
    try { st = fs.statSync(file); } catch { json(res, 404, { ok: false, error: 'not found' }); return; }
    if (!st.isFile()) { json(res, 404, { ok: false, error: 'not found' }); return; }

    const ext = path.extname(file).toLowerCase();
    const isHtml = ext === '.html';
    const headers: Record<string, string> = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': String(st.size),
      // HTML 不缓存（发版后必须立刻拿到新 index）；带 hash 的 assets 长缓存
      'Cache-Control': isHtml ? 'no-store' : (file.includes(path.sep + 'assets' + path.sep) ? 'public, max-age=31536000, immutable' : 'public, max-age=300'),
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    };
    if (isHtml) {
      // 移动端页面不需要 eval / 内联脚本以外的东西；connect-src 放开 ws 与自身
      headers['Content-Security-Policy'] =
        "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; " +
        "style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' ws: wss:; " +
        "object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
    }
    res.writeHead(200, headers);
    if (String(req.method).toUpperCase() === 'HEAD') { res.end(); return; }
    const stream = fs.createReadStream(file);
    stream.on('error', () => { try { res.destroy(); } catch { /* ignore */ } });
    stream.pipe(res);
  }

  // ── WebSocket ──

  private onWs(ws: WebSocket, req: http.IncomingMessage): void {
    const ip = clientIp(req);
    let authed = false;
    let scopes: string[] = [];
    let deviceId = '';
    let chatBusy = false;
    const timer = setTimeout(() => {
      if (!authed) { try { ws.close(4401, 'auth timeout'); } catch { /* ignore */ } }
    }, AUTH_TIMEOUT_MS);
    timer.unref?.();

    ws.on('message', (raw) => {
      let msg: any = null;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (!msg || typeof msg.type !== 'string') return;

      if (!authed) {
        if (msg.type !== 'auth') { try { ws.close(4401, 'auth required'); } catch { /* ignore */ } return; }
        const a = this.opts.auth.authorize(String(msg.token || ''), 'view', ip);
        if (!a.ok) {
          this.opts.auth.noteFailure('auth:' + ip, ip);
          try { ws.close(4401, 'auth failed'); } catch { /* ignore */ }
          return;
        }
        authed = true;
        scopes = a.scopes;
        deviceId = a.deviceId;
        clearTimeout(timer);
        this.sockets.add(ws);
        try { ws.send(JSON.stringify({ type: 'ready', deviceId: a.deviceId, scopes: a.scopes })); } catch { /* ignore */ }
        return;
      }

      if (msg.type === 'ping') {
        try { ws.send(JSON.stringify({ type: 'pong', at: Date.now() })); } catch { /* ignore */ }
        return;
      }

      if (msg.type === 'chat') {
        // 每条连接一次只跑一轮：避免连点把预算打穿
        if (chatBusy) { try { ws.send(JSON.stringify({ type: 'chat.error', id: msg.id, error: '上一句还没说完' })); } catch { /* ignore */ } return; }
        if (!scopes.includes('chat')) { try { ws.send(JSON.stringify({ type: 'chat.error', id: msg.id, error: '没有 chat 权限' })); } catch { /* ignore */ } return; }
        const text = String(msg.text || '').slice(0, 4000).trim();
        if (!text) { try { ws.send(JSON.stringify({ type: 'chat.error', id: msg.id, error: '内容为空' })); } catch { /* ignore */ } return; }
        const id = String(msg.id || '');
        const characterId = String(msg.characterId || '0');
        chatBusy = true;
        const send = (o: unknown) => { try { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(o)); } catch { /* ignore */ } };
        void (async () => {
          try {
            const host = this.opts.host;
            let r: any;
            if (host.chatStream) {
              r = await host.chatStream({ text, characterId, origin: 'web' }, { deviceId }, (ev) => {
                if (ev.type === 'progress') send({ type: 'chat.progress', id, text: ev.text });
                else send({ type: 'chat.delta', id, text: ev.text });
              });
            } else {
              r = await host.chat({ text, characterId, origin: 'web' }, { deviceId });
            }
            send({
              type: 'chat.done', id,
              ok: !!(r && r.ok),
              text: String((r && r.text) || ''),
              error: String((r && r.error) || ''),
              code: String((r && r.code) || ''),
              deniedTool: String((r && r.deniedTool) || ''),
            });
          } catch (e) {
            send({ type: 'chat.done', id, ok: false, text: '', error: String(e).slice(0, 200) });
          } finally {
            chatBusy = false;
          }
        })();
        return;
      }
      // 其它类型在后续子阶段实现；未知类型静默忽略而不是报错回传细节
    });

    ws.on('close', () => { clearTimeout(timer); this.sockets.delete(ws); });
    ws.on('error', () => { clearTimeout(timer); this.sockets.delete(ws); });
  }
}

/** 解析请求 URL；畸形直接 null（不要用 new URL(req.url) 直接崩） */
function safeUrl(req: http.IncomingMessage): URL | null {
  try {
    return new URL(String(req.url || '/'), 'http://localhost');
  } catch {
    return null;
  }
}

/** 路由 → 需要的作用域。返回 null 表示不存在这条路由 */
export function requiredScope(p: string, method: string): WebScope | 'any' | null {
  const m = String(method || 'GET').toUpperCase();
  if (m === 'GET' && p === '/api/whoami') return 'view';
  if (m === 'GET' && p === '/api/status') return 'view';
  if (m === 'GET' && p === '/api/characters') return 'view';
  if (m === 'POST' && p === '/api/chat') return 'chat';
  if (m === 'POST' && p === '/api/asr') return 'chat';
  if (m === 'POST' && p === '/api/tts') return 'chat';
  if (m === 'GET' && p === '/api/memory/search') return 'memory:read';
  if (m === 'POST' && p === '/api/memory/pin') return 'memory:write';
  if (m === 'GET' && p === '/api/social/status') return 'social:read';
  if (m === 'GET' && p === '/api/devices') return 'admin';
  if (m === 'DELETE' && /^\/api\/devices\/[A-Za-z0-9_-]{1,64}$/.test(p)) return 'admin';
  if (m === 'POST' && p === '/api/admin/request') return 'any';
  return null;
}
