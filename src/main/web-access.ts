/**
 * SoulWeave S8：手机 Web / 远程访问的配置、持久化与服务生命周期
 *
 * 把「认证内核（core/web-auth）」「HTTP 服务（main/web-server）」「配置文件」
 * 三者粘起来，并且**把 Electron 依赖挡在外面** —— 这个文件只碰 fs 和 path，
 * 所以 index.ts 只需要接十来行，测试也能直接构造。
 *
 * 【默认值为什么是这样的】
 *   enabled: false   —— 需求 §8「不默认公开」
 *   bindHost: 127.0.0.1 —— 默认只给本机；开局域网必须是用户显式选择
 *   port: 8930       —— 高位端口，避开常见服务
 */

import fs from 'node:fs';
import path from 'node:path';
import { WebAuth, type WebScope } from '../core/web-auth.js';
import { WebServer, type WebApiHost, type WebServerInfo } from './web-server.js';

export type WebAccessConfig = {
  enabled: boolean;
  port: number;
  /** '127.0.0.1' 只给本机；'0.0.0.0' 全开；也可以填具体网卡地址 */
  bindHost: string;
  /** 用户是否已确认「在局域网明文暴露」的风险 */
  lanAcknowledged: boolean;
};

export const DEFAULT_WEB_CONFIG: WebAccessConfig = {
  enabled: false,
  port: 8930,
  bindHost: '127.0.0.1',
  lanAcknowledged: false,
};

export const LOOPBACK_HOSTS = ['127.0.0.1', '::1', 'localhost'];

export function isLoopbackHost(h: string): boolean {
  return LOOPBACK_HOSTS.includes(String(h || '').toLowerCase());
}

function isValidPort(n: unknown): boolean {
  const v = Number(n);
  return Number.isInteger(v) && v >= 1024 && v <= 65535;
}

/** 只保留认识的值，坏配置一律回默认，绝不让非法值把服务绑到奇怪的地方 */
export function normalizeWebConfig(raw: unknown): WebAccessConfig {
  const j = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const port = isValidPort(j.port) ? Number(j.port) : DEFAULT_WEB_CONFIG.port;
  let bindHost = typeof j.bindHost === 'string' && j.bindHost.trim() ? j.bindHost.trim() : DEFAULT_WEB_CONFIG.bindHost;
  // 只接受 IP 字面量或 localhost，避免解析异常值
  if (!/^[0-9a-fA-F:.]{2,45}$/.test(bindHost) && !isLoopbackHost(bindHost)) bindHost = DEFAULT_WEB_CONFIG.bindHost;
  return {
    enabled: j.enabled === true,
    port,
    bindHost,
    lanAcknowledged: j.lanAcknowledged === true,
  };
}

export type WebAccessManagerOptions = {
  /** 配置目录（一般是 USER_DATA） */
  dir: string;
  /** dist/web 绝对路径 */
  webRoot: string;
  host: WebApiHost;
  log?: (line: string) => void;
};

export type WebAccessState = {
  config: WebAccessConfig;
  info: WebServerInfo;
  pairing: { active: boolean; expiresAt: number; attemptsLeft: number; code?: string };
  sessions: number;
  devices: Array<{ id: string; label: string; scopes: WebScope[]; createdAt: number; lastSeenAt: number; revokedAt: number | null }>;
  approvals: Array<{ id: string; deviceId: string; label: string; scopes: WebScope[]; at: number }>;
  /** 明文传输警告：只有回环才安全 */
  transportWarning: string;
};

export class WebAccessManager {
  private opts: WebAccessManagerOptions;
  private cfg: WebAccessConfig = { ...DEFAULT_WEB_CONFIG };
  private auth: WebAuth = new WebAuth();
  private server: WebServer | null = null;
  private lastError = '';

  constructor(opts: WebAccessManagerOptions) {
    this.opts = opts;
    this.load();
  }

  private get configFile(): string { return path.join(this.opts.dir, 'web-access.json'); }
  private get devicesFile(): string { return path.join(this.opts.dir, 'web-access-devices.json'); }

  private log(s: string): void { if (this.opts.log) this.opts.log(s); }

  load(): void {
    try {
      if (fs.existsSync(this.configFile)) {
        this.cfg = normalizeWebConfig(JSON.parse(fs.readFileSync(this.configFile, 'utf8')));
      }
    } catch (e) { this.log('web config read failed: ' + String(e)); this.cfg = { ...DEFAULT_WEB_CONFIG }; }
    try {
      if (fs.existsSync(this.devicesFile)) {
        this.auth = WebAuth.fromJSON(JSON.parse(fs.readFileSync(this.devicesFile, 'utf8')));
      }
    } catch (e) { this.log('web devices read failed: ' + String(e)); this.auth = new WebAuth(); }
  }

  /** 只存摘要；文件中从来没有明文令牌 */
  private saveDevices(): void {
    try {
      fs.mkdirSync(this.opts.dir, { recursive: true });
      fs.writeFileSync(this.devicesFile, JSON.stringify(this.auth.toJSON(), null, 2), 'utf8');
    } catch (e) { this.log('web devices write failed: ' + String(e)); }
  }

  saveConfig(patch: Partial<WebAccessConfig>): WebAccessConfig {
    const next = normalizeWebConfig({ ...this.cfg, ...patch });
    this.cfg = next;
    try {
      fs.mkdirSync(this.opts.dir, { recursive: true });
      fs.writeFileSync(this.configFile, JSON.stringify(next, null, 2), 'utf8');
    } catch (e) { this.log('web config write failed: ' + String(e)); }
    return next;
  }

  getConfig(): WebAccessConfig { return { ...this.cfg }; }

  /** 按当前配置启动/停止服务 */
  async apply(): Promise<WebServerInfo> {
    this.lastError = '';
    if (!this.cfg.enabled) {
      await this.stop();
      return this.info();
    }
    // 换端口/地址需要重启
    if (this.server) await this.stop();
    const srv = new WebServer({
      auth: this.auth,
      host: this.opts.host,
      webRoot: this.opts.webRoot,
      port: this.cfg.port,
      bindHost: this.cfg.bindHost,
      log: (s) => this.log(s),
    });
    try {
      await srv.start();
      this.server = srv;
    } catch (e) {
      this.lastError = String(e);
      this.log('web start failed: ' + this.lastError);
      this.server = null;
    }
    return this.info();
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const s = this.server;
    this.server = null;
    try { await s.stop(); } catch (e) { this.log('web stop failed: ' + String(e)); }
  }

  async dispose(): Promise<void> {
    this.auth.destroyAllSessions();
    await this.stop();
  }

  info(): WebServerInfo {
    if (this.server) return this.server.info();
    return {
      running: false,
      host: this.cfg.bindHost,
      port: this.cfg.port,
      url: 'http://' + (isLoopbackHost(this.cfg.bindHost) ? '127.0.0.1' : this.cfg.bindHost) + ':' + this.cfg.port,
      loopbackOnly: isLoopbackHost(this.cfg.bindHost),
    };
  }

  /** 生成配对码（桌面界面显示）。会先销毁旧码 */
  newPairingCode(): { code: string; expiresAt: number } {
    if (!this.cfg.enabled) throw new Error('Web 访问未开启');
    return this.auth.issuePairingCode();
  }

  cancelPairing(): void { this.auth.cancelPairing(); }

  /** 撤销一台设备：立刻踢掉它的全部会话 */
  revokeDevice(id: string): boolean {
    const ok = this.auth.revokeDevice(id);
    if (ok) this.saveDevices();
    return ok;
  }

  approve(approvalId: string): { ok: boolean; deviceId?: string; scopes?: WebScope[] } {
    const r = this.auth.approve(approvalId);
    if (r.ok) this.saveDevices();
    return r;
  }

  deny(approvalId: string): boolean { return this.auth.deny(approvalId); }

  /** 关掉服务时把所有会话清空：下次开启必须重新用设备令牌换会话 */
  clearSessions(): void { this.auth.destroyAllSessions(); }

  audit(limit = 100) { return this.auth.auditLog(limit); }

  state(): WebAccessState {
    const info = this.info();
    const devices = this.auth.listDevices().map((d) => ({
      id: d.id, label: d.label, scopes: d.scopes,
      createdAt: d.createdAt, lastSeenAt: d.lastSeenAt, revokedAt: d.revokedAt,
    }));
    let warning = '';
    if (!info.loopbackOnly) {
      warning = '当前对外监听 ' + info.host + '，局域网内为明文 HTTP。仅在可信网络使用；跨公网请走 Tailscale。';
    }
    return {
      config: this.getConfig(),
      info,
      pairing: this.auth.pairingState(),
      sessions: this.auth.sessionCount(),
      devices,
      approvals: this.auth.pendingApprovals(),
      transportWarning: warning,
    };
  }

  /** 服务启动失败原因（端口占用等），给界面显示 */
  lastStartError(): string { return this.lastError; }
}
