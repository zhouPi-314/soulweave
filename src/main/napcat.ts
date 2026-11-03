import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';

/**
 * 内置 NapCat 协议端（D59.02 落地，方案 A：完整版随包）
 *
 * 【为什么由应用自己启动，而不是让用户手动开】
 * 用户要的是"装好就能连 QQ"。手动启动协议端会立刻劝退一半人。
 * 但协议端本身是注入进 QQ 的第三方程序，应用不能假装它是自己的：
 *  - 许可要求原样分发（我们不改它一行代码）
 *  - 注入需要 QQ 已安装；没有 QQ 时必须明确告知，而不是静默失败
 *  - 首次启动要让用户显式确认"账号风险由自己承担"
 *
 * 【状态怎么判断】
 * 不去解析 NapCat 的日志（版本一变就失效），只看它对外暴露的 OneBot 端口：
 * 3000（默认）/ 6099 / 3001 —— 端口能连上就认为在跑。
 */

const NAPCAT_PORT_CANDIDATES = [3000, 6099, 3001, 3002];

export function napcatRoot(): string {
  const packaged = path.join((process as any).resourcesPath || '', 'napcat');
  if (fs.existsSync(path.join(packaged, 'napcat.mjs'))) return packaged;
  return path.join(app.getAppPath(), 'resources', 'napcat');
}

export function napcatInfo() {
  try {
    const root = napcatRoot();
    const has = fs.existsSync(path.join(root, 'napcat.mjs'));
    let version: any = null;
    try { version = JSON.parse(fs.readFileSync(path.join(root, 'version.json'), 'utf8')); } catch { /* ignore */ }
    const launcher = ['launcher-user.bat', 'launcher-win10-user.bat', 'launcher.bat']
      .map((f) => path.join(root, f)).find((f) => fs.existsSync(f)) || '';
    return {
      ok: true,
      bundled: has,
      root,
      version: version ? version.version : null,
      license: version ? version.license : null,
      launcher,
      ports: NAPCAT_PORT_CANDIDATES,
    };
  } catch (e) { return { ok: false, bundled: false, error: String(e).slice(0, 160) }; }
}

function portOpen(port: number, host = '127.0.0.1', timeout = 600): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ port, host });
    const done = (v: boolean) => { try { s.destroy(); } catch { /* ignore */ } resolve(v); };
    s.setTimeout(timeout);
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
  });
}

/** 找到正在监听的 OneBot 端口；都没有就是没在跑 */
export async function napcatStatus() {
  const info = napcatInfo();
  if (!info.bundled) return { ok: true, bundled: false, running: false, port: null, info };
  for (const p of NAPCAT_PORT_CANDIDATES) {
    if (await portOpen(p)) return { ok: true, bundled: true, running: true, port: p, info };
  }
  return { ok: true, bundled: true, running: false, port: null, info };
}

/**
 * 启动协议端。detached + unref：NapCat 是独立进程，应用退出不该把它带走
 * （用户可能正用 QQ 聊着）。停止要显式调用 stop。
 */
export function napcatStart(): { ok: boolean; error?: string } {
  const info = napcatInfo();
  if (!info.bundled) return { ok: false, error: '安装包内没有内置协议端' };
  if (!info.launcher) return { ok: false, error: '找不到启动脚本（可能被打包排除）' };
  try {
    const child = spawn('cmd.exe', ['/c', info.launcher], {
      cwd: info.root,
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    child.unref();
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e).slice(0, 200) }; }
}

export function napcatStop(): { ok: boolean; error?: string } {
  try {
    // 只杀 NapCat 自己的引导进程与注入器，不动 QQ 本身
    spawn('taskkill', ['/F', '/IM', 'NapCatWinBootMain.exe', '/T'], { stdio: 'ignore', windowsHide: true });
    spawn('taskkill', ['/F', '/IM', 'NapCatWinBootHook.exe', '/T'], { stdio: 'ignore', windowsHide: true });
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e).slice(0, 200) }; }
}
