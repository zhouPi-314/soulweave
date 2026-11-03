import fs from 'node:fs';
import path from 'node:path';

/**
 * D56.20 补完：更新失败的自动回滚
 *
 * 【为什么用"启动计数"而不是心跳】
 * 更新装坏最常见的样子是：进程起来就崩、或卡在白屏，根本没有机会上报心跳。
 * 所以判断依据只能是"这次启动有没有走到健康点"：
 *   · 安装前写 update-pending.json（attempts=0）
 *   · 每次启动 attempts+1
 *   · 启动后能正常显示主窗口 → 清除标记（healthy）
 *   · 第二次启动仍然没健康 → 判定为坏版本，回滚
 * 阈值取 2 而不是 1：第一次崩溃可能是偶发（显卡驱动、端口抢占），
 * 第二次还崩才动手，避免误伤。
 */

export type Pending = {
  at: string;
  from: string;
  to?: string;
  backup?: string;
  attempts: number;
};

const PENDING = 'update-pending.json';
const REPORT = 'rollback-report.json';

export function readPending(userDataDir: string): Pending | null {
  try {
    const f = path.join(userDataDir, PENDING);
    if (!fs.existsSync(f)) return null;
    const j = JSON.parse(fs.readFileSync(f, 'utf8') || '{}');
    return { at: String(j.at || ''), from: String(j.from || ''), to: j.to ? String(j.to) : undefined, backup: j.backup ? String(j.backup) : undefined, attempts: Number(j.attempts || 0) };
  } catch (e) { return null; }
}

export function writePending(userDataDir: string, p: Omit<Pending, 'attempts'> & { attempts?: number }): void {
  fs.mkdirSync(userDataDir, { recursive: true });
  const j: Pending = { at: p.at, from: p.from, to: p.to, backup: p.backup, attempts: p.attempts ?? 0 };
  fs.writeFileSync(path.join(userDataDir, PENDING), JSON.stringify(j, null, 2), 'utf8');
}

/** 启动时调用：没有标记直接返回 null；有则计数 +1，达到阈值就回滚。 */
export function evaluateAtStartup(userDataDir: string, threshold = 2): { action: 'none' | 'counted' | 'rollback'; pending?: Pending; restored?: string[]; error?: string } {
  const p = readPending(userDataDir);
  if (!p) return { action: 'none' };
  p.attempts += 1;
  try { fs.writeFileSync(path.join(userDataDir, PENDING), JSON.stringify(p, null, 2), 'utf8'); } catch (e) { /* ignore */ }
  if (p.attempts < threshold) return { action: 'counted', pending: p };

  // 达到阈值：还原配置级备份（数据库本身不在这里，避免覆盖用户数据）
  const restored: string[] = [];
  let error: string | undefined;
  try {
    if (p.backup && fs.existsSync(p.backup)) {
      for (const name of ['db-connection.json', 'memory-db.json', 'roster.json', 'avatar-models.json', 'settings.json', 'first-run.json']) {
        const src = path.join(p.backup, name);
        if (!fs.existsSync(src)) continue;
        try { fs.copyFileSync(src, path.join(userDataDir, name)); restored.push(name); }
        catch (e) { error = String(e).slice(0, 160); }
      }
    } else {
      error = '备份目录不存在，仅记录报告';
    }
  } catch (e) { error = String(e).slice(0, 160); }

  // 暂停自动更新，避免同一坏版本被反复拉起
  try {
    const feed = path.join(userDataDir, 'update-feed.json');
    let j: any = {};
    try { if (fs.existsSync(feed)) j = JSON.parse(fs.readFileSync(feed, 'utf8') || '{}'); } catch (e) { j = {}; }
    j.paused = true;
    j.pausedAt = new Date().toISOString();
    j.pausedReason = '连续启动失败已自动回滚';
    fs.writeFileSync(feed, JSON.stringify(j, null, 2), 'utf8');
  } catch (e) { /* ignore */ }

  const report = {
    at: new Date().toISOString(),
    from: p.from, to: p.to, attempts: p.attempts,
    restored, error,
    note: '配置级回滚已执行；应用版本本身需要重新安装上一个版本（安装包未被替换）。',
  };
  try { fs.writeFileSync(path.join(userDataDir, REPORT), JSON.stringify(report, null, 2), 'utf8'); } catch (e) { /* ignore */ }
  try { fs.rmSync(path.join(userDataDir, PENDING), { force: true }); } catch (e) { /* ignore */ }
  return { action: 'rollback', pending: p, restored, error };
}

/** 主窗口真正显示出来之后调用：这次启动是健康的，清掉标记。 */
export function markHealthy(userDataDir: string): { ok: boolean; wasPending: boolean } {
  const p = readPending(userDataDir);
  if (!p) return { ok: true, wasPending: false };
  try { fs.rmSync(path.join(userDataDir, PENDING), { force: true }); return { ok: true, wasPending: true }; }
  catch (e) { return { ok: false, wasPending: true }; }
}

export function lastReport(userDataDir: string): any | null {
  try {
    const f = path.join(userDataDir, REPORT);
    if (!fs.existsSync(f)) return null;
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (e) { return null; }
}
