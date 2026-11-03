/*
 * SoulWeave S5：QQ 登录桥接
 *
 * 【二维码：可用（2026-10-30 实测纠正）】
 *
 * 早期结论「NapCat 不提供二维码接口」是**错的**。实际接口：
 *   POST /api/QQLogin/GetQQLoginQrcode  → { code:0, data:{ qrcode:"<URL>" } }
 *   POST /api/QQLogin/RefreshQRcode
 * 未登录时有数据；已登录返回 { code:-1, message:"QQ Is Logined" }。
 *
 * 而且 NapCat 会把二维码 PNG 写到 <shell>/cache/qrcode.png，
 * 直接读文件转 base64 就能在 SoulWeave 里显示，无需额外渲染依赖。
 *
 * SoulWeave 的登录界面做的是：
 *   1. 探测本地端（6099 WebUI / 3000 HTTP / 3001 WS）
 *   2. **未登录时直接在应用内显示二维码**
 *   3. 已登录时显示账号昵称
 *   4. 备用：拉 QQ 登录窗口（用户授权范围内）
 *   5. 登录后自动发现 OneBot 端口并连接
 *
 * 【安全】
 * - 永不接触 QQ 密码 / 扫码内容
 * - WebUI 令牌只用于本机 127.0.0.1，不落日志
 * - 登录凭证（Credential）只在内存，不持久化
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';

export interface QqWebUiOptions {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
}

export interface QqLoginInfo {
  loggedIn: boolean;
  uin: string;
  nick: string;
  uid: string;
}

export interface QqBackendProbe {
  kind: 'napcat' | 'snowluma' | 'lagrange' | 'unknown';
  webuiUrl: string | null;
  onebotHttp: string | null;
  onebotWs: string | null;
  reachable: boolean;
  note: string;
}

/**
 * NapCat / SnowLuma 的 WebUI 客户端。
 *
 * 认证流程（从 WebUI 前端 bundle 反查得到，不是猜的）：
 *   hash = SHA256(token + ".napcat")
 *   POST /api/auth/login { hash, totpCode }  → { data: { Credential } }
 *   Authorization: Bearer <Credential>
 *
 * 注意：所有**读接口都是 POST**，GET 会 404。这是实测结论。
 */
export class QqWebUiClient {
  private cred = '';
  private opts: Required<QqWebUiOptions>;

  constructor(options: QqWebUiOptions) {
    this.opts = { timeoutMs: 5000, ...options };
  }

  /** 取 WebUI 令牌指纹（用于显示「已配置」，不泄漏原文） */
  tokenFingerprint(): string {
    if (!this.opts.token) return '';
    return crypto.createHash('sha256').update(this.opts.token).digest('hex').slice(0, 8);
  }

  async login(): Promise<{ ok: boolean; error?: string }> {
    if (!this.opts.token) return { ok: false, error: '未配置 WebUI 令牌' };
    const hash = crypto.createHash('sha256').update(this.opts.token + '.napcat').digest('hex');
    try {
      const r = await this.post('/api/auth/login', { hash, totpCode: '' });
      const j = await r.json();
      const c = j && j.data && j.data.Credential;
      if (!c) return { ok: false, error: '登录失败：' + (j && j.message || '无凭证返回') };
      this.cred = String(c);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: '连不上 WebUI: ' + String(e).slice(0, 100) };
    }
  }

  /**
   * 校验并**必要时重新登录**。
   *
   * 【为什么必须能自愈】
   * NapCat 在 QQ 登录/登出时会重建会话，之前缓存的 Credential 直接失效。
   * 旧实现只在第��次使用时登录一次，之后一直拿旧凭证请求 ——
   * 结果是「手机上明明已登录 Windows，面板上永远显示未登录」。
   */
  async checkAuth(force = false): Promise<boolean> {
    if (force) this.cred = '';
    if (!this.cred) { const l = await this.login(); if (!l.ok) return false; }
    try {
      const r = await this.post('/api/auth/check', {});
      const j = await r.json();
      if (j && j.code === 0) return true;
    } catch (e) { /* 掉到下面重试 */ }
    // 凭证过期：清掉重登一次
    this.cred = '';
    const again = await this.login();
    if (!again.ok) return false;
    try {
      const r2 = await this.post('/api/auth/check', {});
      const j2 = await r2.json();
      return !!(j2 && j2.code === 0);
    } catch (e) { return false; }
  }

  /** 查 QQ 登录状态 */
  async getLoginInfo(): Promise<QqLoginInfo> {
    const empty: QqLoginInfo = { loggedIn: false, uin: '', nick: '', uid: '' };

    const once = async (): Promise<QqLoginInfo | null> => {
      try {
        const r = await this.post('/api/QQLogin/GetQQLoginInfo', {});
        if (r.status === 401 || r.status === 403) return null;
        const j = await r.json();
        if (j && j.code !== undefined && j.code !== 0) return null;
        const d = (j && j.data) || {};
        const uin = String(d.uin || '');
        return { loggedIn: !!uin && uin !== '0', uin, nick: String(d.nick || ''), uid: String(d.uid || '') };
      } catch (e) { return null; }
    };

    if (!this.cred) { const l = await this.login(); if (!l.ok) return empty; }
    const first = await once();
    if (first) return first;

    // 凭证过期：重登一次再问
    this.cred = '';
    const again = await this.login();
    if (!again.ok) return empty;
    return (await once()) || empty;
  }

  /**
   * 取登录二维码。
   *
   * 实测（2026-10-30）：NapCat 提供 `POST /api/QQLogin/GetQQLoginQrcode`，
   * 返回 `{ code:0, data:{ qrcode: "<URL>" } }`（是 URL 字符串，不是图片）。
   * 已登录时返回 `{ code:-1, message:"QQ Is Logined" }`。
   *
   * 另外 NapCat 会把二维码 PNG 写到 `<app>/cache/qrcode.png`，
   * 直接读文件比从 URL 自己渲染更省事、也不需要额外依赖。
   */
  async getQrCode(napCatShellDir?: string): Promise<{
    ok: boolean;
    url?: string;
    pngBase64?: string;
    /** PNG 内容的指纹（前 16 位 sha256），用于判断二维码是否已刷新 */
    pngHash?: string;
    loggedIn?: boolean;
    error?: string;
  }> {
    if (!this.cred) { const l = await this.login(); if (!l.ok) return { ok: false, error: l.error }; }
    try {
      const r = await this.post('/api/QQLogin/GetQQLoginQrcode', {});
      const j = await r.json();
      if (j && typeof j.message === 'string' && /logined/i.test(j.message)) {
        return { ok: false, loggedIn: true, error: 'QQ 已登录' };
      }
      const url = (j && j.code === 0 && j.data && j.data.qrcode) ? String(j.data.qrcode) : '';

      // 优先读 NapCat 自己写的 PNG（最稳，不需要前端渲染二维码）
      let pngBase64: string | undefined;
      let pngHash: string | undefined;
      if (napCatShellDir) {
        const png = path.join(napCatShellDir, 'cache', 'qrcode.png');
        try {
          if (fs.existsSync(png)) {
            const buf = fs.readFileSync(png);
            // 有效 PNG 至少几百字节且以 PNG 签名开头
            if (buf.length > 200 && buf.subarray(0, 4).toString('hex') === '89504e47') {
              pngBase64 = buf.toString('base64');
              pngHash = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
            }
          }
        } catch (e) { void e; }
      }

      if (url || pngBase64) return { ok: true, url, pngBase64, pngHash };
      return { ok: false, error: (j && j.message) || '取二维码失败' };
    } catch (e) {
      return { ok: false, error: String(e).slice(0, 120) };
    }
  }

  /** 刷新二维码 */
  async refreshQrCode(): Promise<{ ok: boolean; error?: string }> {
    if (!this.cred) { const l = await this.login(); if (!l.ok) return { ok: false, error: l.error }; }
    try {
      const r = await this.post('/api/QQLogin/RefreshQRcode', {});
      const j = await r.json();
      return (j && j.code === 0) ? { ok: true } : { ok: false, error: (j && j.message) || '刷新失败' };
    } catch (e) {
      return { ok: false, error: String(e).slice(0, 120) };
    }
  }

  async getVersion(): Promise<string> {
    if (!this.cred) { const l = await this.login(); if (!l.ok) return ''; }
    try {
      const r = await fetch(this.opts.baseUrl + '/api/base/GetNapCatVersion', {
        method: 'GET',
        headers: this.headers(),
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
      const j = await r.json();
      return String((j && j.data) || '');
    } catch (e) { return ''; }
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.cred) h.Authorization = 'Bearer ' + this.cred;
    return h;
  }

  private async post(p: string, body: unknown): Promise<Response> {
    return fetch(this.opts.baseUrl + p, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body || {}),
      signal: AbortSignal.timeout(this.opts.timeoutMs),
    });
  }
}

// ─── 探测 ─────────────────────────────────────────────

async function tcpAlive(host: string, port: number, timeoutMs = 800): Promise<boolean> {
  return new Promise((resolve) => {
    const s = new net.Socket();
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      try { s.destroy(); } catch (e) { void e; }
      resolve(ok);
    };
    s.setTimeout(timeoutMs);
    s.once('connect', () => finish(true));
    s.once('timeout', () => finish(false));
    s.once('error', () => finish(false));
    try { s.connect(port, host); } catch (e) { finish(false); }
  });
}

/**
 * 探测本机有哪些 OneBot 端在跑。
 *
 * 端口约定（三个端都用这套）：
 *   WebUI  : 6099（NapCat / SnowLuma）
 *   HTTP   : 3000
 *   WS     : 3001
 */
export async function probeBackends(webuiPorts = [6099]): Promise<QqBackendProbe> {
  const result: QqBackendProbe = {
    kind: 'unknown', webuiUrl: null, onebotHttp: null, onebotWs: null,
    reachable: false, note: '未发现 OneBot 端',
  };

  for (const p of webuiPorts) {
    if (await tcpAlive('127.0.0.1', p)) {
      result.webuiUrl = 'http://127.0.0.1:' + p;
      result.reachable = true;
      break;
    }
  }

  if (await tcpAlive('127.0.0.1', 3000)) result.onebotHttp = 'http://127.0.0.1:3000';
  if (await tcpAlive('127.0.0.1', 3001)) result.onebotWs = 'ws://127.0.0.1:3001';

  if (result.webuiUrl) {
    result.kind = 'napcat';
    result.note = '发现 WebUI（NapCat / SnowLuma）';
  } else if (result.onebotWs || result.onebotHttp) {
    result.kind = 'lagrange';
    result.note = '发现 OneBot 端口（可能是 Lagrange）';
  }

  if (result.reachable && !result.onebotWs && !result.onebotHttp) {
    result.note += '；但 OneBot 端口未监听 —— QQ 可能尚未登录';
  }
  return result;
}

// ─── 启动 NapCat / 打开 QQ 登录窗口 ─────────────────────

export interface LaunchResult {
  ok: boolean;
  error?: string;
  launched?: string;
  needsElevation?: boolean;
  phase?: 'starting' | 'already-running';
  /** 拉起的引导进程 pid（不代表 NapCat 已就绪） */
  pid?: number;
}

/** 探测某个端口是否在监听 */
async function portUp(port: number, timeoutMs = 700): Promise<boolean> {
  return new Promise((resolve) => {
    const s = new net.Socket();
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      try { s.destroy(); } catch (e) { void e; }
      resolve(ok);
    };
    s.setTimeout(timeoutMs);
    s.once('connect', () => finish(true));
    s.once('timeout', () => finish(false));
    s.once('error', () => finish(false));
    try { s.connect(port, '127.0.0.1'); } catch (e) { finish(false); }
  });
}

/** 从注册表读 QQ 安装路径 */
function findQqExe(): string | null {
  try {
    const r = spawnSync('reg', [
      'query',
      'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QQ',
      '/v', 'UninstallString',
    ], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    const out = String(r.stdout || '');
    const m = out.match(/UninstallString\s+REG_SZ\s+(.+)/i);
    if (!m) return null;
    let uninstall = m[1].trim();
    if (uninstall.startsWith('"')) uninstall = uninstall.slice(1);
    if (uninstall.endsWith('"')) uninstall = uninstall.slice(0, -1);
    const dir = path.dirname(uninstall);
    const exe = path.join(dir, 'QQ.exe');
    return fs.existsSync(exe) ? exe : null;
  } catch (e) {
    return null;
  }
}

/** 找 NapCat Shell 目录（版本号会变） */
function findShellDir(napCatRoot: string): string | null {
  const base = path.join(napCatRoot, 'OneKey', 'NapCat.Shell.Windows.OneKey');
  try {
    if (!fs.existsSync(base)) return null;
    const dirs = fs.readdirSync(base).filter((d) => /^NapCat\..+\.Shell$/i.test(d));
    for (const d of dirs) {
      const full = path.join(base, d);
      if (fs.existsSync(path.join(full, 'launcher.bat'))) return full;
    }
    return dirs.length ? path.join(base, dirs[0]) : null;
  } catch (e) {
    return null;
  }
}

/**
 * 启动 NapCat（管理员）并拉起 QQ。
 *
 * 【实测记录（2026-10-30 ~ 10-31，走了很多弯路）】
 *
 * 1. **必须管理员权限**。非管理员时 NapCat 的 worker 会崩：
 *    `[Fork] Worker进程意外退出 (1/3)`，端口一个都不起。
 *
 * 2. **不能内联 `powershell -Command "..."`**。引号嵌套必然炸
 *    （`The string is missing the terminator`）。
 *
 * 3. **不能加 `-WindowStyle Hidden`**。实测加了之后
 *    `Start-Process ... -Verb RunAs` 会静默失败（返回 0 但什么都不起）。
 *    去掉就正常。这是最容易踩的坑 —— 想「优雅地隐藏窗口」反而让功能失效。
 *
 * 4. **不能加 `-Wait`**。launcher.bat 里有 pause，-Wait 会永久挂住。
 *
 * 5. **不要经 cmd.exe 转一手**。直接 `Start-Process launcher.bat -Verb RunAs`
 *    是唯一稳定的组合（实测 6099 能起来）。
 *
 * 所以这里最终选：写 .ps1（避免引号问题）→ `powershell -File` →
 * ps1 里就一行 `Start-Process <launcher.bat> -Verb RunAs`。
 */
/**
 * 启动 NapCat（管理员）并拉起 QQ —— **不经过 launcher.bat**。
 *
 * 【为什么重写】
 *
 * launcher.bat 是批处理，必须由 cmd.exe 执行；cmd 提权就必然显示黑窗。
 * 而 `-WindowStyle Hidden` 会让 `Start-Process -Verb RunAs` 静默失败
 * （实测：返回 0 但什么都不起）。这是个死结。
 *
 * 解法：把 bat 里那点逻辑用 Node 重写，直接调 NapCatWinBootMain.exe：
 *
 *   launcher.bat 做的事          →  这里怎么做
 *   ─────────────────────────────────────────────
 *   net session 检查管理员        →  PowerShell 提权时自带
 *   注册表查 QQ 路径              →  findQqExe()（spawnSync reg query）
 *   设 5 个 NAPCAT_* 环境变量     →  在 .ps1 里显式 set
 *   调 NapCatWinBootMain.exe      →  Start-Process -WindowStyle Hidden
 *
 * 关键：**提权的是 exe，不是 cmd**。控制台程序用 -WindowStyle Hidden
 * 提权时能正常隐藏（对 cmd 不行，这是 Windows 的行为差异）。
 *
 * 环境变量通过 .ps1 里显式 set 传递，不依赖父进程继承
 * （提权会创建新的环境块，父进程的变量不会自动带过去）。
 */
/**
 * 启动 NapCat（管理员）+ 拉起 QQ，**不显示黑窗**。
 *
 * 【踩过的坑（2026-10-31，按顺序）】
 *
 * 1. `Start-Process -WindowStyle Hidden -Verb RunAs`（cmd 包 bat）
 *    → 静默失败：返回 0，什么都不起。
 *
 * 2. `Start-Process NapCatWinBootMain.exe -WindowStyle Hidden -Verb RunAs`
 *    （绕过 bat 直接调 exe）
 *    → 无黑窗，但 **6099 端口不起**。exe 能注入 QQ 但 NapCat 主进程不跑。
 *    → 说明 launcher.bat 里的 cmd 环境是必需的（exe 依赖继承的控制台）。
 *
 * 3. `wscript.exe + VBS`（sh.Run "cmd /c bat", 0, False）
 *    → ✅ 6099 起来（5s），cmd 窗口 0
 *
 * 4. **`System.Diagnostics.ProcessStartInfo`**（本实现）
 *    → ✅ 6099 起来（2s），cmd 窗口 0
 *    → 更快、不依赖 VBS，所以选它。
 *
 * 关键：`UseShellExecute = true` + `Verb = "runas"` 提权，
 * 同时 `WindowStyle = Hidden` 只隐藏被启动的 cmd，
 * **UAC 弹窗和 QQ 窗口不受影响**。
 * 这和 `Start-Process -WindowStyle Hidden` 的行为差异是 Windows 的坑。
 */
/**
 * 直接按 Shell 目录启动 NapCat（多实例用）。
 *
 * 和 launchQqLoginWindow 的区别：那个从「根目录 + OneKey 结构」去找 Shell，
 * 这个拿到的就是一个具体实例目录，所以能同时跑多份。
 */
/**
 * 启动某个实例：**非阻塞**、默认不提权。
 *
 * 【上一版为什么「卡死」】
 * 用 spawnSync 跑一个 runas 提权的 powershell：
 *   ① spawnSync 会**阻塞 Electron 主进程**，UAC 弹窗没被点掉时主进程整片冻住，
 *      渲染层的 IPC 永远回不来 —— 用户看到的就是「点了没反应、等很久」；
 *   ② 提权窗口一旦没被批准，进程根本不存在，端口自然也不起。
 *
 * 现在的做法：
 *   · 直接 spawn NapCatWinBootMain.exe（这正是手动启动时能跑起来的那条路），
 *     detached + stdio ignore，**立刻返回**，绝不阻塞；
 *   · 失败与否由上层轮询端口判断，不靠这次调用的返回值猜。
 */
export function launchShellAsync(shellDir: string, qqPath?: string): LaunchResult {
  if (!shellDir || !fs.existsSync(path.join(shellDir, 'NapCatWinBootMain.exe'))) {
    return { ok: false, error: '这个实例目录里没有 NapCatWinBootMain.exe：' + shellDir };
  }
  if (!fs.existsSync(path.join(shellDir, 'napcat.mjs'))) {
    return { ok: false, error: '这个实例目录里没有 napcat.mjs：' + shellDir };
  }
  const qqExe = qqPath && fs.existsSync(qqPath) ? qqPath : findQqExe();
  if (!qqExe) return { ok: false, error: '没找到已安装的 QQ。' };

  try {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NAPCAT_PATCH_PACKAGE: path.join(shellDir, 'qqnt.json'),
      NAPCAT_LOAD_PATH: path.join(shellDir, 'loadNapCat.js'),
      NAPCAT_INJECT_PATH: path.join(shellDir, 'NapCatWinBootHook.dll'),
      NAPCAT_LAUNCHER_PATH: path.join(shellDir, 'NapCatWinBootMain.exe'),
      NAPCAT_MAIN_PATH: path.join(shellDir, 'napcat.mjs'),
    };
    const child = spawn(
      path.join(shellDir, 'NapCatWinBootMain.exe'),
      [qqExe, path.join(shellDir, 'NapCatWinBootHook.dll')],
      { cwd: shellDir, env, detached: true, stdio: 'ignore', windowsHide: true },
    );
    child.unref();
    return { ok: true, launched: path.basename(shellDir), phase: 'starting', pid: child.pid };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 200) };
  }
}

/** 提权启动（UAC）：同样异步、不阻塞，作为兜底手段 */
export function launchShellElevated(shellDir: string): LaunchResult {
  const bootExe = path.join(shellDir, 'NapCatWinBootMain.exe');
  if (!fs.existsSync(bootExe)) return { ok: false, error: '缺少 NapCatWinBootMain.exe：' + shellDir };
  try {
    const q = (s: string) => "'" + s.replace(/'/g, "''") + "'";
    const cmd = [
      '$ErrorActionPreference = "Stop"',
      '$psi = New-Object System.Diagnostics.ProcessStartInfo',
      '$psi.FileName = ' + q(bootExe),
      '$psi.WorkingDirectory = ' + q(shellDir),
      '$psi.UseShellExecute = $true',
      '$psi.Verb = "runas"',
      '$psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden',
      '[System.Diagnostics.Process]::Start($psi) | Out-Null',
    ].join('; ');
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', cmd], {
      detached: true, stdio: 'ignore', windowsHide: true,
    });
    child.unref();
    return { ok: true, launched: path.basename(shellDir), needsElevation: true, phase: 'starting' };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 200) };
  }
}

export async function launchQqShell(shellDir: string, qqPath?: string): Promise<LaunchResult> {
  if (!shellDir || !fs.existsSync(path.join(shellDir, 'launcher.bat'))) {
    return { ok: false, error: '这个实例目录里没有 launcher.bat：' + shellDir };
  }
  if (!fs.existsSync(path.join(shellDir, 'napcat.mjs'))) {
    return { ok: false, error: '这个实例目录里没有 napcat.mjs：' + shellDir };
  }
  const qqExe = qqPath && fs.existsSync(qqPath) ? qqPath : findQqExe();
  if (!qqExe) return { ok: false, error: '没找到已安装的 QQ。' };

  try {
    const ps1 = path.join(os.tmpdir(), 'soulweave-start-instance-' + crypto.createHash('sha1').update(shellDir).digest('hex').slice(0, 8) + '.ps1');
    const q = (s: string) => "'" + s.replace(/'/g, "''") + "'";
    const launcherBat = path.join(shellDir, 'launcher.bat');
    const script = [
      '$ErrorActionPreference = "Stop"',
      '',
      '$psi = New-Object System.Diagnostics.ProcessStartInfo',
      '$psi.FileName = "cmd.exe"',
      '$psi.Arguments = ' + q('/c "' + launcherBat + '"'),
      '$psi.WorkingDirectory = ' + q(shellDir),
      '$psi.UseShellExecute = $true',
      '$psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden',
      '$psi.Verb = "runas"',
      '[System.Diagnostics.Process]::Start($psi) | Out-Null',
    ].join('\r\n');
    fs.writeFileSync(ps1, script, 'utf8');

    const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1], {
      encoding: 'utf8', windowsHide: true, timeout: 60000,
    });
    const stderr = String(r.stderr || '').trim();
    if (r.error) return { ok: false, error: '启动失败：' + String(r.error).slice(0, 120) };
    if (/canceled by the user|操作已被用户取消/i.test(stderr)) {
      return { ok: false, error: '你在 UAC 窗口点了「否」。需要点「是」才能启动。' };
    }
    if (r.status !== 0 && stderr) return { ok: false, error: '启动失败：' + stderr.slice(0, 150) };
    return { ok: true, launched: path.basename(shellDir), needsElevation: true, phase: 'starting' };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 200) };
  }
}

export async function launchQqLoginWindow(opts: {
  napCatRoot?: string;
  qqPath?: string;
}): Promise<LaunchResult> {
  // ── 查重：已经在跑就直接返回，避免用户连点起多个实例 ──
  // （实测过连点 3 次起了 3 个 NapCatWinBootMain，端口冲突）
  if (await portUp(6099, 500)) {
    return { ok: true, launched: 'NapCat', phase: 'already-running' };
  }
  // 有进程但端口没起 = 卡住，让 UI 走「强制重启」
  if (hasStuckBootProcess()) {
    return {
      ok: false,
      error: '检测到残留的 NapCat 进程但端口未监听。请点「强制重启」清理后重试。',
    };
  }

  if (!opts.napCatRoot) {
    return { ok: false, error: '未配置 NapCat 根目录。请在「设置」里填写。' };
  }

  const shell = findShellDir(opts.napCatRoot);
  if (!shell) {
    return {
      ok: false,
      error: '没找到 NapCat 程序目录。请确认已解压 NapCat.Shell.Windows.OneKey.zip 到 <根目录>\\OneKey\\。',
    };
  }

  const launcherBat = path.join(shell, 'launcher.bat');
  if (!fs.existsSync(launcherBat)) {
    return { ok: false, error: 'NapCat 启动器缺失：' + launcherBat };
  }

  const qqExe = opts.qqPath && fs.existsSync(opts.qqPath) ? opts.qqPath : findQqExe();
  if (!qqExe) {
    return {
      ok: false,
      error: '没找到已安装的 QQ。请先从 im.qq.com 安装 QQ 客户端，再回来启动。',
    };
  }

  try {
    const ps1 = path.join(os.tmpdir(), 'soulweave-start-napcat.ps1');
    const q = (s: string) => "'" + s.replace(/'/g, "''") + "'";

    // ProcessStartInfo：提权 + 隐藏 cmd，但不影响 UAC/QQ 窗口
    const script = [
      '$ErrorActionPreference = "Stop"',
      '',
      '$psi = New-Object System.Diagnostics.ProcessStartInfo',
      '$psi.FileName = "cmd.exe"',
      '$psi.Arguments = ' + q('/c "' + launcherBat + '"'),
      '$psi.WorkingDirectory = ' + q(shell),
      '$psi.UseShellExecute = $true',
      '$psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden',
      '$psi.Verb = "runas"',
      '[System.Diagnostics.Process]::Start($psi) | Out-Null',
    ].join('\r\n');
    fs.writeFileSync(ps1, script, 'utf8');

    const r = spawnSync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1,
    ], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 60000,
    });

    const stderr = String(r.stderr || '').trim();
    if (r.error) {
      return { ok: false, error: '启动失败：' + String(r.error).slice(0, 120) };
    }
    if (/canceled by the user|操作已被用户取消/i.test(stderr)) {
      return { ok: false, error: '你在 UAC 窗口点了「否」。需要点「是」才能启动。' };
    }
    if (r.status !== 0 && stderr) {
      return { ok: false, error: '启动失败：' + stderr.slice(0, 150) };
    }

    return { ok: true, launched: 'NapCat', needsElevation: true, phase: 'starting' };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 200) };
  }
}


function hasStuckBootProcess(): boolean {
  try {
    const r = spawnSync('tasklist', ['/FI', 'IMAGENAME eq NapCatWinBootMain.exe', '/NH'], {
      encoding: 'utf8', windowsHide: true, timeout: 4000,
    });
    return /NapCatWinBootMain\.exe/i.test(String(r.stdout || ''));
  } catch (e) {
    return false;
  }
}

export function killStuckNapCat(): { ok: boolean; killed: number; error?: string } {
  let killed = 0;
  for (const name of ['NapCatWinBootMain.exe', 'QQ.exe']) {
    try {
      const r = spawnSync('taskkill', ['/F', '/IM', name, '/T'], {
        encoding: 'utf8', windowsHide: true, timeout: 8000,
      });
      if (/SUCCESS|成功/i.test(String(r.stdout || ''))) killed++;
    } catch (e) { void e; }
  }
  return { ok: true, killed };
}

/** 一次性拿到 UI 需要的全部状态 */
export async function probeQqStates(napCatRoot?: string): Promise<{
  napCatRunning: boolean;
  shellFound: boolean;
  qqInstalled: boolean;
  shellDir: string | null;
  httpUp: boolean;
  wsUp: boolean;
  webuiUp: boolean;
  /** 进程在但端口没起 = 卡住了 */
  stuck: boolean;
}> {
  const shell = napCatRoot ? findShellDir(napCatRoot) : null;
  const [webuiUp, httpUp, wsUp] = await Promise.all([
    portUp(6099), portUp(3000), portUp(3001),
  ]);
  const bootAlive = hasStuckBootProcess();
  return {
    napCatRunning: webuiUp,
    shellFound: !!shell,
    qqInstalled: !!findQqExe(),
    shellDir: shell,
    httpUp,
    wsUp,
    webuiUp,
    // 有进程但 webui 没起 → 卡住
    stuck: bootAlive && !webuiUp,
  };
}
