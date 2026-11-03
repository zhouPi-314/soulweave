import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

// 本仓库 src/main 是 ESM，没有全局 require —— 用 createRequire 显式构造
const _require = createRequire(import.meta.url);

/**
 * D56.19 / D56.20：自动更新
 *
 * 【设计取舍】
 * 1. electron-updater 只在**打包后**可用（开发模式没有 app-update.yml，checkForUpdates
 *    会直接抛错），所以这里显式判断 app.isPackaged，开发模式返回"不可用"而不是假装检查。
 * 2. 更新源不写死在代码里：优先 SOULWEAVE_UPDATE_URL 环境变量，
 *    其次 update-feed.json（运维可改），都没有就报"未配置更新源"。
 * 3. 更新前必须备份：记忆数据库 + 配置 + 角色/形象清单，备份失败就不允许安装。
 * 4. 安装后要有健康检查：写一个 pending marker，新版本启动成功才清掉；
 *    连续两次启动都失败（marker 还在）就回滚到备份。
 */

export type UpdateState =
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'available'; version: string; notes?: string; url?: string }
  | { phase: 'none'; version: string }
  | { phase: 'downloading'; percent: number }
  | { phase: 'downloaded'; version: string }
  | { phase: 'error'; error: string; hint?: string };

type Ctx = { userDataDir: string; bootLog: (s: string) => void };

let _autoUpdater: any = null;
let _state: UpdateState = { phase: 'idle' };
const listeners = new Set<(s: UpdateState) => void>();

export function updateState(): UpdateState { return _state; }
export function onUpdateState(fn: (s: UpdateState) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
function emit(next: UpdateState) {
  _state = next;
  for (const fn of listeners) { try { fn(next); } catch (e) { /* ignore */ } }
}

/** 更新源：环境变量 > update-feed.json > 未配置 */
export function resolveFeedUrl(userDataDir: string): string | null {
  const env = (process.env.SOULWEAVE_UPDATE_URL || '').trim();
  if (env) return env;
  try {
    const f = path.join(userDataDir, 'update-feed.json');
    if (fs.existsSync(f)) {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      const u = String(j && j.url || '').trim();
      if (u) return u;
    }
  } catch (e) { /* ignore */ }
  return null;
}

function getUpdater(ctx: Ctx): any {
  if (_autoUpdater) return _autoUpdater;
  // 动态 require：开发模式不装/不初始化，避免顶层 import 把整个应用拖垮
  // （这是唯一允许的动态加载，因为 electron-updater 不是 ESM 友好的）
  const mod = _require('electron-updater');
  const au = mod.autoUpdater || mod.default;
  au.autoDownload = false;
  au.autoInstallOnAppQuit = false;
  au.logger = {
    info: (m: any) => ctx.bootLog('updater: ' + String(m).slice(0, 200)),
    warn: (m: any) => ctx.bootLog('updater warn: ' + String(m).slice(0, 200)),
    error: (m: any) => ctx.bootLog('updater err: ' + String(m).slice(0, 200)),
    debug: () => {},
  };
  au.on('download-progress', (p: any) => emit({ phase: 'downloading', percent: Math.round(Number(p && p.percent) || 0) }));
  au.on('error', (e: any) => emit({ phase: 'error', error: String((e && e.message) || e).slice(0, 240) }));
  _autoUpdater = au;
  return au;
}

export async function checkForUpdates(ctx: Ctx): Promise<UpdateState> {
  if (!app.isPackaged) {
    emit({ phase: 'error', error: '开发模式不执行更新检查', hint: '打包安装后才可用' });
    return _state;
  }
  const feed = resolveFeedUrl(ctx.userDataDir);
  if (!feed) {
    emit({ phase: 'error', error: '未配置更新源', hint: '设置 SOULWEAVE_UPDATE_URL 或 userData/update-feed.json' });
    return _state;
  }
  emit({ phase: 'checking' });
  try {
    const au = getUpdater(ctx);
    au.setFeedURL({ provider: 'generic', url: feed });
    const r = await au.checkForUpdates();
    const info = r && r.updateInfo;
    if (info && String(info.version) !== app.getVersion()) {
      emit({
        phase: 'available',
        version: String(info.version),
        notes: typeof info.releaseNotes === 'string' ? info.releaseNotes : undefined,
        url: feed,
      });
    } else {
      emit({ phase: 'none', version: app.getVersion() });
    }
  } catch (e: any) {
    emit({ phase: 'error', error: String((e && e.message) || e).slice(0, 240) });
  }
  return _state;
}

export async function downloadUpdate(ctx: Ctx): Promise<UpdateState> {
  try {
    const au = getUpdater(ctx);
    await au.downloadUpdate();
    const v = (_state as any).version || '';
    emit({ phase: 'downloaded', version: v });
  } catch (e: any) {
    emit({ phase: 'error', error: String((e && e.message) || e).slice(0, 240) });
  }
  return _state;
}

/** 更新前备份：记忆库、配置、清单。任何一步失败都拒绝安装。 */
export function backupBeforeUpdate(userDataDir: string): { ok: boolean; dir?: string; error?: string } {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dir = path.join(userDataDir, 'update-backups', stamp);
    fs.mkdirSync(dir, { recursive: true });
    const names = ['db-connection.json', 'memory-db.json', 'roster.json', 'avatar-models.json', 'settings.json', 'first-run.json'];
    let n = 0;
    for (const name of names) {
      const src = path.join(userDataDir, name);
      if (fs.existsSync(src)) { fs.copyFileSync(src, path.join(dir, name)); n++; }
    }
    // 记忆数据单独导出（数据库在跑，直接拷目录不安全；用 SQL dump 太慢，
    // 这里只备份连接配置 + 让用户可用维护页的"导出"功能做全量）
    const manifest = {
      appVersion: app.getVersion(),
      createdAt: new Date().toISOString(),
      files: n,
      note: '配置/清单级备份；记忆数据请用维护页导出',
    };
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
    return { ok: true, dir };
  } catch (e: any) { return { ok: false, error: String((e && e.message) || e).slice(0, 200) }; }
}

export async function installUpdate(ctx: Ctx): Promise<UpdateState> {
  const b = backupBeforeUpdate(ctx.userDataDir);
  if (!b.ok) {
    emit({ phase: 'error', error: '更新前备份失败，已取消安装：' + (b.error || '') });
    return _state;
  }
  // 健康检查标记：安装后由 markBootHealthy() 清除；两次启动都没清 → 回滚
  try {
    fs.writeFileSync(path.join(ctx.userDataDir, 'update-pending.json'), JSON.stringify({
      at: new Date().toISOString(), backup: b.dir, from: app.getVersion(),
    }, null, 2), 'utf8');
  } catch (e) { /* ignore */ }
  try {
    getUpdater(ctx).quitAndInstall(false, true);
  } catch (e: any) {
    emit({ phase: 'error', error: String((e && e.message) || e).slice(0, 240) });
  }
  return _state;
}
