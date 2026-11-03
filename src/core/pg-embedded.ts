/**
 * SoulWeave：内置 PostgreSQL 控制器
 *
 * 用户决定（2026-11-02）：A 内置 + 首启自动初始化，端口 55432，数据库必须。
 *
 * 【设计要点】
 * 1. 只监听 127.0.0.1，密码随机生成后写入用户数据目录（不上传、不进日志）。
 * 2. 不注册 Windows 服务：作为子进程随应用启停，卸载时不会留下系统级残留。
 * 3. 如果用户机器上已有可用 PostgreSQL，可以用 detectExisting() 让用户选择复用。
 * 4. initdb 必须用纯 ASCII 路径（含中文的 %USERPROFILE% 会让 initdb 失败）。
 */
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';

export interface PgPaths {
  /** resources/pg（安装目录内） */
  pgRoot: string;
  /** 数据目录（用户数据目录下的 pgdata） */
  dataDir: string;
  /** 配置落盘位置 */
  configFile: string;
}

export interface PgStatus {
  /** installed=二进制存在；initialized=数据目录已 initdb；running=端口可连 */
  installed: boolean;
  initialized: boolean;
  running: boolean;
  port: number;
  host: string;
  database: string;
  user: string;
  /** 已存在的系统级 PostgreSQL（用户自己装的） */
  existing?: { port: number } | null;
  error?: string;
}

const DEFAULT_PORT = 55432;
const DB_NAME = 'soulweave';
const DB_USER = 'soulweave';

function bin(pgRoot: string, exe: string): string {
  return path.join(pgRoot, 'bin', exe);
}

function isAscii(s: string): boolean {
  return !/[^\x00-\x7F]/.test(s);
}

/** 端口是否已被监听（用于判断实例是否在跑 / 端口冲突） */
export function portOpen(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ port, host });
    const done = (v: boolean) => { try { s.destroy(); } catch (e) { /* ignore */ } resolve(v); };
    s.setTimeout(600);
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
  });
}

/** 选一个可用端口：从 base 起最多试 10 个 */
export async function pickPort(base = DEFAULT_PORT): Promise<number> {
  for (let i = 0; i < 10; i++) {
    if (!(await portOpen(base + i))) return base + i;
  }
  return base + 10;
}

export class EmbeddedPostgres {
  private opts: PgPaths;
  private child: any = null;

  constructor(opts: PgPaths) {
    this.opts = opts;
  }

  private readConfig(): any | null {
    try {
      if (!fs.existsSync(this.opts.configFile)) return null;
      return JSON.parse(fs.readFileSync(this.opts.configFile, 'utf8'));
    } catch (e) { return null; }
  }

  private writeConfig(cfg: Record<string, any>): void {
    try {
      fs.mkdirSync(path.dirname(this.opts.configFile), { recursive: true });
      fs.writeFileSync(this.opts.configFile, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    } catch (e) { /* 写失败由调用方感知 */ }
  }

  /** 连接参数：优先用配置文件，其次按默认 */
  connection(): { host: string; port: number; database: string; user: string; password: string } {
    const c = this.readConfig() || {};
    const dataDir = c.dataDir || this.opts.dataDir;
    let pw = String(c.password || '');
    if (!pw) {
      try { pw = fs.readFileSync(path.join(dataDir, '.soulweave-pw'), 'utf8').trim(); } catch (e) { pw = ''; }
    }
    return {
      host: c.host || '127.0.0.1',
      port: Number(c.port) || DEFAULT_PORT,
      database: c.database || DB_NAME,
      user: c.user || DB_USER,
      password: pw,
    };
  }

  status(): PgStatus {
    const installed = fs.existsSync(bin(this.opts.pgRoot, 'postgres.exe'));
    const initialized = fs.existsSync(path.join(this.opts.dataDir, 'PG_VERSION'));
    const c = this.readConfig() || {};
    return {
      installed,
      initialized,
      running: false,
      port: Number(c.port) || DEFAULT_PORT,
      host: c.host || '127.0.0.1',
      database: c.database || DB_NAME,
      user: c.user || DB_USER,
    };
  }

  async refreshRunning(): Promise<PgStatus> {
    const st = this.status();
    st.running = await portOpen(st.port);
    return st;
  }

  /** 初始化数据目录（幂等）。成功返回连接参数 */
  async initialize(): Promise<{ ok: boolean; error?: string; port?: number }> {
    if (!fs.existsSync(bin(this.opts.pgRoot, 'initdb.exe'))) {
      return { ok: false, error: '内置数据库组件缺失（resources/pg/bin/initdb.exe 不存在）' };
    }
    // initdb 不接受非 ASCII 路径：数据目录指向含中文的用户目录时必须换到 ASCII 位置
    let dataDir = this.opts.dataDir;
    if (!isAscii(dataDir)) {
      const alt = path.join('C:\\ProgramData', 'SoulWeave', 'pgdata');
      dataDir = alt;
    }
    // 集群已存在但没有可用密码 → 说明配置丢了，这个集群无法再登录。
    // 直接重建，避免"数据库在跑但永远连不上"的僵尸状态。
    const havePw = (() => { try { return fs.readFileSync(path.join(dataDir, '.soulweave-pw'), 'utf8').trim().length > 0; } catch (e) { return false; } })();
    const cfgNow = this.readConfig();
    if (fs.existsSync(path.join(dataDir, 'PG_VERSION')) && !havePw && !(cfgNow && cfgNow.password)) {
      try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    }
    const port = await pickPort(DEFAULT_PORT);
    const password = crypto.randomBytes(18).toString('base64url');

    if (!fs.existsSync(path.join(dataDir, 'PG_VERSION'))) {
      fs.mkdirSync(dataDir, { recursive: true });
      const pwFile = path.join(path.dirname(dataDir), '.pgpw');
      fs.writeFileSync(pwFile, password, { mode: 0o600 });
      const r = spawnSync(bin(this.opts.pgRoot, 'initdb.exe'), [
        '-D', dataDir, '-U', DB_USER, '--auth=scram-sha-256',
        '--pwfile', pwFile, '--encoding=UTF8', '--locale=C',
      ], { windowsHide: true, encoding: 'utf8', timeout: 120000 });
      try { fs.unlinkSync(pwFile); } catch (e) { /* ignore */ }
      if (r.status !== 0) {
        return { ok: false, error: 'initdb 失败：' + String((r.stderr || r.stdout || '').slice(0, 300)) };
      }
    }

    // 端口写进配置（重启后沿用）
    this.writeConfig({ host: '127.0.0.1', port, database: DB_NAME, user: DB_USER, password, dataDir });
    try { fs.writeFileSync(path.join(dataDir, '.soulweave-pw'), password, { mode: 0o600 }); } catch (e) { /* ignore */ }
    const started = await this.start();
    if (!started.ok) return { ok: false, error: started.error };
    const created = spawnSync(bin(this.opts.pgRoot, 'createdb.exe'), [
      '-h', '127.0.0.1', '-p', String(port), '-U', DB_USER, DB_NAME,
    ], { windowsHide: true, encoding: 'utf8', timeout: 30000, env: { ...process.env, PGPASSWORD: password } });
    if (created.status !== 0 && !String(created.stderr || '').includes('already exists')) {
      return { ok: false, error: 'createdb 失败：' + String((created.stderr || '').slice(0, 300)) };
    }
    return { ok: true, port };
  }

  /** 以子进程形式启动（不注册服务） */
  async start(): Promise<{ ok: boolean; error?: string }> {
    const cfg = this.readConfig() || {};
    const dataDir = cfg.dataDir || this.opts.dataDir;
    if (await portOpen(Number(cfg.port) || DEFAULT_PORT)) return { ok: true }; // 已在跑
    try {
      this.child = spawn(bin(this.opts.pgRoot, 'postgres.exe'), [
        '-D', dataDir, '-p', String(Number(cfg.port) || DEFAULT_PORT), '-h', '127.0.0.1',
      ], { windowsHide: true, stdio: 'ignore' });
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 250));
        if (await portOpen(Number(cfg.port) || DEFAULT_PORT)) return { ok: true };
      }
      return { ok: false, error: '数据库启动超时（4 秒内端口未就绪）' };
    } catch (e) {
      return { ok: false, error: '启动失败：' + String(e).slice(0, 200) };
    }
  }

  /** 停止子进程（应用退出时调用） */
  stop(): void {
    try { if (this.child) { this.child.kill(); this.child = null; } } catch (e) { /* ignore */ }
  }

  /** 给 pg 连接池用的配置 */
  poolConfig(): Record<string, any> {
    const c = this.connection();
    return { host: c.host, port: c.port, user: c.user, password: c.password, database: c.database };
  }
}
