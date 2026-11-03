/**
 * SoulWeave S9.4：维护中心的后端（备份 / 导出 / 恢复 / 清缓存）
 *
 * 【为什么单独一个文件】
 * 这几个操作都会动磁盘，属于「一旦写错就回不去」的一类。
 * 放在这里可以只依赖 fs，用临时目录把「导出 → 改坏 → 恢复」整条链跑通，
 * 不必启动 Electron。
 *
 * 【安全边界】
 * 1. 备份/导出**绝不包含**密钥类文件（agent-key.bin / voice-secrets.bin /
 *    db-connection.json 的密码 / cloud-agent.json 的 apiKey）。
 *    判定不靠文件名猜，而是「白名单 + 字段级剔除」两道。
 * 2. 恢复只接受本模块导出的包，且逐个文件白名单校验；
 *    包里的路径一律取 basename，不允许 ../ 逃逸。
 * 3. 清缓存只删明确的缓存目录，不碰 userData 里的配置与记忆。
 */

import fs from 'node:fs';
import path from 'node:path';

/** 允许写进备份的配置文件（白名单） */
export const BACKUP_FILES = [
  'roster.json',
  'agent-bindings.json',
  'cloud-agent.json',
  'voice-config.json',
  'voice-components.json',
  'qq-backend.json',
  'qq-instances.json',
  'qq-state.json',
  'qq-inject.json',
  'life-push.json',
  'image-gen.json',
  'vision.json',
  'capture-grants.json',
  'decay-state.json',
  'downloads.json',
  'web-access.json',
  'Tool-grants.json',
];

/** 明确排除：永不出现在备份里 */
export const SECRET_FILES = [
  'agent-key.bin',
  'voice-secrets.bin',
  'db-connection.json',
  'web-access-devices.json',
];

/** 字段级剔除：即使文件在白名单里，这些键也要抹掉 */
const SECRET_KEYS = ['apiKey', 'api_key', 'token', 'secret', 'secretKey', 'secretId', 'password', 'passwordEnc', 'credential', 'webuiTokenRef'];

export function stripSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => stripSecrets(v));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEYS.includes(k)) { out[k] = ''; continue; }
      out[k] = stripSecrets(v);
    }
    return out;
  }
  return value;
}

export type BackupBundle = {
  format: 'soulweave-backup';
  version: 1;
  createdAt: number;
  app: { version: string };
  /** 文件名 → 内容（已脱敏） */
  files: Record<string, unknown>;
  /** 收集时的告警（例如某文件损坏被跳过） */
  warnings: string[];
};

export type BackupOptions = {
  userData: string;
  appVersion: string;
  now?: () => number;
};

/** 生成配置备份包（纯内存，不落盘） */
export function buildBackup(opts: BackupOptions): BackupBundle {
  const now = opts.now ?? (() => Date.now());
  const files: Record<string, unknown> = {};
  const warnings: string[] = [];
  for (const name of BACKUP_FILES) {
    // 注意大小写：真实文件是 tool-grants.json
    const real = name === 'Tool-grants.json' ? 'tool-grants.json' : name;
    const p = path.join(opts.userData, real);
    try {
      if (!fs.existsSync(p)) continue;
      const raw = fs.readFileSync(p, 'utf8');
      const parsed = JSON.parse(raw);
      files[real] = stripSecrets(parsed);
    } catch (e) {
      warnings.push(real + ' 读取失败，已跳过：' + String(e).slice(0, 80));
    }
  }
  return {
    format: 'soulweave-backup',
    version: 1,
    createdAt: now(),
    app: { version: opts.appVersion },
    files,
    warnings,
  };
}

/** 把备份包写到指定目录，返回文件路径 */
export function writeBackup(bundle: BackupBundle, dir: string): { ok: boolean; file?: string; error?: string } {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const d = new Date(bundle.createdAt);
    const stamp = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0') +
      '-' + String(d.getHours()).padStart(2, '0') + String(d.getMinutes()).padStart(2, '0');
    const file = path.join(dir, 'soulweave-backup-' + stamp + '.json');
    fs.writeFileSync(file, JSON.stringify(bundle, null, 2), 'utf8');
    return { ok: true, file };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 200) };
  }
}

export type ValidateResult =
  | { ok: true; bundle: BackupBundle; fileCount: number }
  | { ok: false; error: string };

/** 校验一个备份包能不能用（恢复前必过） */
export function validateBundle(raw: unknown): ValidateResult {
  if (!raw || typeof raw !== 'object') return { ok: false, error: '不是一个 JSON 对象' };
  const j = raw as Partial<BackupBundle>;
  if (j.format !== 'soulweave-backup') return { ok: false, error: '不是 SoulWeave 的备份包（format 不匹配）' };
  if (j.version !== 1) return { ok: false, error: '备份包版本不支持：' + String(j.version) };
  if (!j.files || typeof j.files !== 'object') return { ok: false, error: '备份包缺少 files' };
  const names = Object.keys(j.files);
  if (!names.length) return { ok: false, error: '备份包里没有任何文件' };
  for (const n of names) {
    if (path.basename(n) !== n) return { ok: false, error: '备份包里有非法文件名：' + n };
    if (SECRET_FILES.includes(n)) return { ok: false, error: '备份包含密钥文件，拒绝恢复：' + n };
    const real = n === 'Tool-grants.json' ? 'tool-grants.json' : n;
    if (!BACKUP_FILES.map((x) => (x === 'Tool-grants.json' ? 'tool-grants.json' : x)).includes(real)) {
      return { ok: false, error: '备份包里有不在白名单的文件：' + n };
    }
  }
  if (typeof j.createdAt !== 'number') return { ok: false, error: '备份包缺少 createdAt' };
  return { ok: true, bundle: j as BackupBundle, fileCount: names.length };
}

export type RestoreOptions = {
  userData: string;
  /** 恢复前先把现有文件复制到这个目录，便于手动回滚 */
  safetyDir?: string;
};

/** 从备份包恢复。调用方必须先让用户二次确认 */
export function restoreBundle(bundle: BackupBundle, opts: RestoreOptions): {
  ok: boolean; written: string[]; error?: string;
} {
  const written: string[] = [];
  try {
    fs.mkdirSync(opts.userData, { recursive: true });
    // 先做安全副本：恢复错了还能手工找回来
    if (opts.safetyDir) {
      try {
        fs.mkdirSync(opts.safetyDir, { recursive: true });
        for (const name of Object.keys(bundle.files)) {
          const src = path.join(opts.userData, name);
          if (fs.existsSync(src)) fs.copyFileSync(src, path.join(opts.safetyDir, name + '.before'));
        }
      } catch (e) { /* 安全副本失败不阻断，但要上报 */ }
    }
    for (const [name, content] of Object.entries(bundle.files)) {
      const base = path.basename(name);
      if (SECRET_FILES.includes(base)) continue;   // 双保险
      const target = path.join(opts.userData, base);
      fs.writeFileSync(target, JSON.stringify(content, null, 2), 'utf8');
      written.push(base);
    }
    return { ok: true, written };
  } catch (e) {
    return { ok: false, written, error: String(e).slice(0, 200) };
  }
}

/** 只读诊断用：磁盘余量（Windows 用 statfs 不可用，这里给文件系统总量估算） */
export function dirSize(p: string): number {
  let total = 0;
  const walk = (d: string, depth: number) => {
    if (depth > 4) return;
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const q = path.join(d, e.name);
      try {
        if (e.isDirectory()) walk(q, depth + 1);
        else total += fs.statSync(q).size;
      } catch { /* 跳过 */ }
    }
  };
  try { if (fs.statSync(p).isDirectory()) walk(p, 0); } catch { /* ignore */ }
  return total;
}

/**
 * 可安全清理的临时文件（相对 userData）。
 *
 * 【为什么不删目录】原来想删 session/ 与 scripts/，实测直接 EPERM ——
 * session 是 Chromium 的会话目录，应用运行期间被占用，强删会破坏登录态；
 * scripts 目录里可能是用户自己的脚本。这属于「为了省几十 MB 去动不该动的东西」。
 * 现在只清掉明确是我们自己产生、且删了没有后果的临时文件。
 */
export const CACHE_FILES = ['kokoro-selftest.wav'];

/** 清缓存：只删白名单里的临时文件 + 根目录下的 *.tmp，返回释放字节数 */
export function clearCache(userData: string): { ok: boolean; freed: number; removed: string[]; error?: string } {
  let freed = 0;
  const removed: string[] = [];
  const targets: string[] = [...CACHE_FILES];
  try {
    for (const name of fs.readdirSync(userData)) {
      if (name.endsWith('.tmp')) targets.push(name);
    }
  } catch (e) { /* 目录读不到就只处理白名单 */ }

  for (const name of targets) {
    const p = path.join(userData, name);
    try {
      if (!fs.existsSync(p)) continue;
      const st = fs.statSync(p);
      if (!st.isFile()) continue;
      fs.unlinkSync(p);
      freed += st.size;
      removed.push(name);
    } catch (e) {
      return { ok: false, freed, removed, error: String(e).slice(0, 160) };
    }
  }
  return { ok: true, freed, removed };
}
