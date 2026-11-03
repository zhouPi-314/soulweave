import fs from 'node:fs';
import path from 'node:path';

/**
 * D56.11 / D56.22：安装状态机 + 失败恢复 + 事务回滚
 *
 * 每个安装阶段写一条记录：进行中 → 成功 / 失败(带原因)。
 * 启动时如果发现上一次安装没有走到 finish，就进入"可修复"状态：
 * 用户可以点"修复安装"重跑对应阶段（建库→建表→角色同步→资源包），
 * 而不是卸载重装。
 *
 * 为什么需要它：向导的四个步骤分别会动数据库、表结构、磁盘资源，
 * 任何一步中断（关机、杀进程、端口被占）都会留下"半装好"的状态，
 * 而半装好比没装更难排查。
 */

export type StageName = 'env' | 'database' | 'schema' | 'characters' | 'packs' | 'finish';
export type StageStatus = 'pending' | 'running' | 'ok' | 'failed';

export type InstallState = {
  version: 1;
  startedAt: string;
  updatedAt: string;
  appVersion: string;
  completed: boolean;
  stages: Record<StageName, { status: StageStatus; at?: string; error?: string; note?: string }>;
};

const ORDER: StageName[] = ['env', 'database', 'schema', 'characters', 'packs', 'finish'];

function emptyState(appVersion: string): InstallState {
  const stages: any = {};
  for (const s of ORDER) stages[s] = { status: 'pending' };
  const now = new Date().toISOString();
  return { version: 1, startedAt: now, updatedAt: now, appVersion, completed: false, stages };
}

export class InstallStateStore {
  private file: string;
  constructor(private userDataDir: string, private appVersion: string) {
    this.file = path.join(userDataDir, 'install-state.json');
  }

  read(): InstallState {
    try {
      if (fs.existsSync(this.file)) {
        const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        if (j && j.version === 1 && j.stages) return j as InstallState;
      }
    } catch (e) { /* 损坏就重建 */ }
    return emptyState(this.appVersion);
  }

  private write(s: InstallState): void {
    s.updatedAt = new Date().toISOString();
    fs.mkdirSync(this.userDataDir, { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf8');
    fs.renameSync(tmp, this.file); // 原子替换，避免断电写半个文件
  }

  begin(): InstallState {
    const s = emptyState(this.appVersion);
    this.write(s);
    return s;
  }

  stage(name: StageName, status: StageStatus, extra?: { error?: string; note?: string }): InstallState {
    const s = this.read();
    s.stages[name] = { status, at: new Date().toISOString(), ...(extra || {}) };
    if (status === 'ok' && name === 'finish') s.completed = true;
    this.write(s);
    return s;
  }

  /** 跑一个阶段：失败会记录原因，但不抛异常（由调用方决定是否中断） */
  async run<T>(name: StageName, fn: () => Promise<{ ok: boolean; error?: string; note?: string }>): Promise<{ ok: boolean; error?: string; note?: string }> {
    this.stage(name, 'running');
    let r: { ok: boolean; error?: string; note?: string };
    try { r = await fn(); }
    catch (e: any) { r = { ok: false, error: String((e && e.message) || e).slice(0, 200) }; }
    this.stage(name, r.ok ? 'ok' : 'failed', { error: r.error, note: r.note });
    return r;
  }

  /** 半装好：完成了数据库但没 finish，或任何阶段 failed */
  needsRepair(): { needed: boolean; reason?: string; failed: StageName[] } {
    const s = this.read();
    const failed = ORDER.filter((n) => s.stages[n].status === 'failed');
    if (failed.length) return { needed: true, reason: '上次安装有阶段失败：' + failed.join(', '), failed };
    if (!s.completed && s.stages.database.status === 'ok') {
      return { needed: true, reason: '上次安装没走完（数据库已就绪但未完成）', failed: [] };
    }
    return { needed: false, failed: [] };
  }

  summary(): { state: InstallState; needed: boolean; reason?: string } {
    const r = this.needsRepair();
    return { state: this.read(), needed: r.needed, reason: r.reason };
  }
}
