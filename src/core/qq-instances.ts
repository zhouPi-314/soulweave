/*
 * SoulWeave：NapCat 多实例（多 QQ 账号）
 *
 * 【为什么需要这个模块】
 * 一个 NapCat 进程 = 一个 QQ 登录 = 一套端口。
 * 之前代码把「一个实例」写死在整个登录链路里（6099 / 3000 / 3001），
 * 所以第二个 QQ 号根本没有地方登 —— 用户看到的「只能扫码登录一个号」就是这么来的。
 *
 * 现在的模型：
 *   实例 = { 一套 NapCat 目录, WebUI 端口, HTTP 端口, WS 端口 }
 *   每个实例独立登录一个 QQ，独立一套 OneBot 端口，互不干扰。
 *
 * 【为什么不整目录复制】
 * Shell 目录里 node_modules / native / static / worker 加起来上百 MB，
 * 复制一份又慢又占地方，而这些东西本来就可以共享。
 * 所以：重目录做 junction（Windows 目录联接，不需要管理员），小文件照常复制，
 * 只有 config / 日志 / 缓存是每个实例独占的。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export interface QqInstance {
  /** 稳定 id，'main' 是主实例 */
  id: string;
  /** 用户看得见的名字 */
  label: string;
  /** 这个实例的 NapCat Shell 绝对目录 */
  shellDir: string;
  webuiPort: number;
  httpPort: number;
  wsPort: number;
  /** 由 SoulWeave 创建的（可删除）还是用户原有的 */
  managed: boolean;
  /** 绑到哪个 OneBot 账号 label（qq-service 里那个） */
  accountLabel?: string;
}

export interface QqInstancesFile {
  version: number;
  instances: QqInstance[];
}

export const MAIN_INSTANCE_ID = 'main';
export const INSTANCES_FILE_VERSION = 1;

export const DEFAULT_PORTS = { webuiPort: 6099, httpPort: 3000, wsPort: 3001 };

/** 重目录走 junction，别复制 */
const JUNCTION_DIRS = ['node_modules', 'native', 'static', 'worker'];
/** 这些是运行期状态，不能带进新实例 */
const SKIP_FILES = /\.(db|db-shm|db-wal)$/i;
const SKIP_DIRS = ['config', 'cache', 'logs'];

export function defaultInstances(shellDir: string | null): QqInstancesFile {
  const instances: QqInstance[] = [];
  if (shellDir) {
    instances.push({
      id: MAIN_INSTANCE_ID,
      label: '主实例',
      shellDir,
      ...DEFAULT_PORTS,
      managed: false,
    });
  }
  return { version: INSTANCES_FILE_VERSION, instances };
}

// ─── 端口 ───────────────────────────────────────────

export interface InstancePorts { webuiPort: number; httpPort: number; wsPort: number }

/**
 * 给新实例挑一套端口。
 *
 * 规则：WebUI 从 6099 起 +2（避开常见占用），OneBot 从 3000 起 +2。
 * 已经有实例占用的端口一律跳过。
 */
export function allocateInstancePorts(existing: InstancePorts[], reserved: number[] = []): InstancePorts {
  const used = new Set<number>(reserved);
  for (const p of existing) {
    used.add(p.webuiPort); used.add(p.httpPort); used.add(p.wsPort);
  }
  let webuiPort = 0;
  for (let p = 6099; p < 6300; p += 2) { if (!used.has(p)) { webuiPort = p; break; } }
  if (!webuiPort) webuiPort = 6099;

  let httpPort = 0;
  for (let p = 3000; p < 3300; p += 2) {
    if (!used.has(p) && !used.has(p + 1)) { httpPort = p; break; }
  }
  if (!httpPort) httpPort = 3000;

  return { webuiPort, httpPort, wsPort: httpPort + 1 };
}

/** 端口冲突校验（实例之间不能撞） */
export function validateInstancePorts(instances: InstancePorts[]): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const seen = new Map<number, number>();
  instances.forEach((it, i) => {
    for (const [name, port] of [['WebUI', it.webuiPort], ['HTTP', it.httpPort], ['WS', it.wsPort]] as const) {
      if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        errors.push('实例 ' + (i + 1) + ' 的 ' + name + ' 端口非法：' + port);
        continue;
      }
      const prev = seen.get(port);
      if (prev !== undefined) {
        errors.push(name + ' 端口 ' + port + ' 与实例 ' + (prev + 1) + ' 冲突');
      } else {
        seen.set(port, i);
      }
    }
  });
  return { ok: errors.length === 0, errors };
}

// ─── 配置写入 ───────────────────────────────────────

export function newToken(): string {
  return crypto.randomBytes(6).toString('hex');
}

function ensureDir(d: string): void {
  fs.mkdirSync(d, { recursive: true });
}

function readJson(f: string): any {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; }
}

function writeJson(f: string, v: any): void {
  ensureDir(path.dirname(f));
  fs.writeFileSync(f, JSON.stringify(v, null, 2), 'utf8');
}

/** 写 webui.json：端口 + 令牌 */
export function writeWebuiConfig(shellDir: string, opts: { port: number; token?: string }): { token: string } {
  const f = path.join(shellDir, 'config', 'webui.json');
  const cur = readJson(f) || {};
  const token = opts.token || cur.token || newToken();
  writeJson(f, { ...cur, host: '127.0.0.1', port: opts.port, token, autoLoginAccount: '' });
  return { token };
}

/**
 * 写 onebot11.json **模板**。
 *
 * NapCat 登录新账号时，如果找不到 onebot11_<uin>.json，
 * 会拿 onebot11.json 当模板复制一份（napcat.mjs 里的实测落点）。
 * 所以在这里预先写死本实例的端口，登录后端口天然就是对的，不用二次改配置。
 */
export function writeOnebotTemplate(
  shellDir: string,
  opts: { httpPort: number; wsPort: number; token?: string; label?: string },
): void {
  const f = path.join(shellDir, 'config', 'onebot11.json');
  const token = opts.token || '';
  writeJson(f, {
    imageDownloadProxy: '',
    enableLocalFile2Url: false,
    musicSignUrl: '',
    parseMultMsg: false,
    network: {
      httpServers: [{
        token,
        port: opts.httpPort,
        enable: true,
        debug: false,
        host: '127.0.0.1',
        enableWebsocket: false,
        name: 'soulweave-' + (opts.label || 'instance') + '-http',
        messagePostFormat: 'array',
        enableCors: true,
      }],
      websocketServers: [{
        token,
        port: opts.wsPort,
        enable: true,
        reportSelfMessage: false,
        debug: false,
        heartInterval: 30000,
        host: '127.0.0.1',
        name: 'soulweave-' + (opts.label || 'instance') + '-ws',
        messagePostFormat: 'array',
      }],
      httpSseServers: [],
      websocketClients: [],
      httpClients: [],
      plugins: [],
    },
  });
}

/** 写 napcat.json：这个实例要留下日志，方便排查 */
export function writeNapcatConfig(shellDir: string): void {
  const f = path.join(shellDir, 'config', 'napcat.json');
  const cur = readJson(f) || {};
  writeJson(f, {
    fileLog: true,
    consoleLog: true,
    fileLogLevel: 'info',
    consoleLogLevel: 'info',
    packetBackend: 'auto',
    packetServer: '',
    o3HookMode: 1,
    ...cur,
  });
}

/** 登录后，已经有 onebot11_<uin>.json 时把它改成我们的端口 */
export function patchAccountOnebotConfig(
  shellDir: string,
  uin: string,
  opts: { httpPort: number; wsPort: number; token?: string; label?: string },
): boolean {
  const f = path.join(shellDir, 'config', 'onebot11_' + uin + '.json');
  const cur = readJson(f);
  if (!cur) return false;
  const token = opts.token || '';
  cur.network = {
    ...(cur.network || {}),
    httpServers: [{
      token, port: opts.httpPort, enable: true, debug: false, host: '127.0.0.1',
      enableWebsocket: false, name: 'soulweave-' + (opts.label || uin) + '-http',
      messagePostFormat: 'array', enableCors: true,
    }],
    websocketServers: [{
      token, port: opts.wsPort, enable: true, reportSelfMessage: false, debug: false,
      heartInterval: 30000, host: '127.0.0.1', name: 'soulweave-' + (opts.label || uin) + '-ws',
      messagePostFormat: 'array',
    }],
  };
  writeJson(f, cur);
  return true;
}

// ─── 目录准备 ───────────────────────────────────────

export interface PrepareResult {
  ok: boolean;
  error?: string;
  token?: string;
  copied?: number;
  junctions?: number;
}

/**
 * 从模板 Shell 目录派生一个新实例目录。
 *
 * 只复制小文件；node_modules / native / static / worker 用 junction 指过去。
 * 这样新实例几 MB、几秒就能建好，而不是复制上百 MB。
 */
export function prepareInstanceDir(
  srcShellDir: string,
  destShellDir: string,
  ports: InstancePorts,
): PrepareResult {
  try {
    if (!fs.existsSync(path.join(srcShellDir, 'napcat.mjs'))) {
      return { ok: false, error: '模板目录不像 NapCat Shell：' + srcShellDir };
    }
    fs.rmSync(destShellDir, { recursive: true, force: true });
    ensureDir(destShellDir);

    let copied = 0, junctions = 0;
    for (const entry of fs.readdirSync(srcShellDir, { withFileTypes: true })) {
      const name = entry.name;
      if (SKIP_DIRS.includes(name)) continue;
      const src = path.join(srcShellDir, name);
      const dest = path.join(destShellDir, name);

      if (entry.isDirectory()) {
        if (JUNCTION_DIRS.includes(name)) {
          try {
            fs.symlinkSync(src, dest, 'junction');
            junctions++;
          } catch (e) {
            // junction 建不了就退化成复制（慢但能跑）
            fs.cpSync(src, dest, { recursive: true });
          }
        }
        // 其它目录（例如 future 的 extensions）直接复制
        else {
          fs.cpSync(src, dest, { recursive: true });
        }
        continue;
      }

      if (SKIP_FILES.test(name)) continue;
      fs.copyFileSync(src, dest);
      copied++;
    }

    const { token } = writeWebuiConfig(destShellDir, { port: ports.webuiPort });
    writeOnebotTemplate(destShellDir, {
      httpPort: ports.httpPort, wsPort: ports.wsPort, token: '', label: path.basename(destShellDir),
    });
    writeNapcatConfig(destShellDir);
    ensureDir(path.join(destShellDir, 'logs'));
    ensureDir(path.join(destShellDir, 'cache'));

    return { ok: true, token, copied, junctions };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 300) };
  }
}

/** 读某个实例目录里的 WebUI 令牌 */
export function readInstanceToken(shellDir: string): string {
  const w = readJson(path.join(shellDir, 'config', 'webui.json'));
  return w && typeof w.token === 'string' ? w.token : '';
}

// ─── 存储 ───────────────────────────────────────────

export class InstanceStore {
  private file: string;
  private data: QqInstancesFile;
  private defaultShellDir: string | null;

  constructor(dir: string, defaultShellDir: string | null = null) {
    this.file = path.join(dir, 'qq-instances.json');
    this.defaultShellDir = defaultShellDir;
    this.data = this.load();
  }

  private load(): QqInstancesFile {
    try {
      if (fs.existsSync(this.file)) {
        const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        if (j && Array.isArray(j.instances)) {
          const instances = j.instances
            .filter((x: any) => x && x.id && x.shellDir)
            .map((x: any) => ({
              id: String(x.id),
              label: String(x.label || x.id),
              shellDir: String(x.shellDir),
              webuiPort: Number(x.webuiPort) || DEFAULT_PORTS.webuiPort,
              httpPort: Number(x.httpPort) || DEFAULT_PORTS.httpPort,
              wsPort: Number(x.wsPort) || DEFAULT_PORTS.wsPort,
              managed: !!x.managed,
              accountLabel: x.accountLabel ? String(x.accountLabel) : undefined,
            }));
          return { version: INSTANCES_FILE_VERSION, instances };
        }
      }
    } catch (e) { /* 坏文件回落 */ }
    const d = defaultInstances(this.defaultShellDir);
    this.save(d);
    return d;
  }

  private save(d: QqInstancesFile = this.data): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(d, null, 2), 'utf8');
    } catch (e) { /* 写失败不抛 */ }
  }

  list(): QqInstance[] { return this.data.instances.slice(); }

  get(id: string): QqInstance | undefined {
    return this.data.instances.find((x) => x.id === id);
  }

  /** 主实例缺失时补上（用户可能从没配过） */
  ensureMain(shellDir: string | null): QqInstance | null {
    if (!shellDir) return null;
    const cur = this.get(MAIN_INSTANCE_ID);
    if (cur) {
      if (cur.shellDir !== shellDir) { cur.shellDir = shellDir; this.save(); }
      return cur;
    }
    const it: QqInstance = {
      id: MAIN_INSTANCE_ID, label: '主实例', shellDir,
      ...DEFAULT_PORTS, managed: false,
    };
    this.data.instances.unshift(it);
    this.save();
    return it;
  }

  add(input: Omit<QqInstance, 'id' | 'managed'> & { id?: string }): { ok: boolean; instance?: QqInstance; error?: string } {
    const id = input.id || 'i' + Date.now().toString(36);
    if (this.get(id)) return { ok: false, error: '实例 id 已存在：' + id };
    if (this.data.instances.some((x) => x.shellDir === input.shellDir)) {
      return { ok: false, error: '这个目录已经被另一个实例占用' };
    }
    const v = validateInstancePorts([...this.data.instances, input]);
    if (!v.ok) return { ok: false, error: v.errors.join('; ') };

    const it: QqInstance = {
      id, label: input.label, shellDir: input.shellDir,
      webuiPort: input.webuiPort, httpPort: input.httpPort, wsPort: input.wsPort,
      managed: true, accountLabel: input.accountLabel,
    };
    this.data.instances.push(it);
    this.save();
    return { ok: true, instance: it };
  }

  update(id: string, patch: Partial<QqInstance>): { ok: boolean; instance?: QqInstance; error?: string } {
    const it = this.get(id);
    if (!it) return { ok: false, error: '实例不存在' };
    const next = { ...it, ...patch, id: it.id };
    const others = this.data.instances.filter((x) => x.id !== id);
    const v = validateInstancePorts([...others, next]);
    if (!v.ok) return { ok: false, error: v.errors.join('; ') };
    Object.assign(it, next);
    this.save();
    return { ok: true, instance: it };
  }

  remove(id: string): { ok: boolean; error?: string } {
    const it = this.get(id);
    if (!it) return { ok: false, error: '实例不存在' };
    if (id === MAIN_INSTANCE_ID) return { ok: false, error: '主实例不能删除' };
    this.data.instances = this.data.instances.filter((x) => x.id !== id);
    this.save();
    return { ok: true };
  }

  /** 给下一个新实例挑端口 */
  nextPorts(): InstancePorts {
    return allocateInstancePorts(this.data.instances);
  }
}
