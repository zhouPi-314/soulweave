/**
 * SoulWeave：把「第三方程序需要读取的路径」转成纯 ASCII。
 *
 * 【为什么需要这个模块】
 * 同一类 bug 已经在三个地方出现过：
 *   · whisper-cli：模型路径含中文 → 0xC0000409 栈溢出崩溃（S7）
 *   · espeak-ng（Kokoro 用）：数据路径含中文 → espeak 自己 exit()，主进程凭空消失（S10）
 *   · piper：模型路径含中文 → 崩溃；espeak 数据路径含中文 → "Illegal byte sequence"（S10 收尾）
 *
 * 这些第三方程序的共同点是：内部把路径当成窄字符（ANSI/UTF-8）交给 C 库，
 * 遇到非 ASCII 就行为未定义 —— 轻则报错，重则整个进程消失。
 * 我们的用户目录很可能就是中文的（Windows 中文用户名、项目盘带中文），所以必须兜住。
 *
 * 策略：原路径是 ASCII 就直接用；否则复制到 ASCII 缓存目录再用（幂等）。
 * 缓存目录优先 C:\ProgramData\SoulWeave（系统级、纯 ASCII），其次系统临时目录。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** 路径里是否含非 ASCII 字符 */
export function hasNonAsciiPath(p: string): boolean {
  return /[^\x00-\x7f]/.test(String(p || ''));
}

/**
 * SoulWeave 的缓存根目录。
 *
 * 【为什么不能再写死开发机的路径】
 * 旧实现直接返回一个开发机的绝对路径 —— 装到用户电脑上根本不存在，
 * 语音/转写缓存会全部失败。现在按优先级取：
 *   1. 环境变量 SOULWEAVE_CACHE（主进程启动时会把它设成用户数据目录下的 cache）
 *   2. SOULWEAVE_DATA_ROOT/cache
 *   3. 系统临时目录下的 SoulWeave-cache（最后兜底，一定能写）
 */
export function soulweaveCacheRoot(): string {
  const fromEnv = process.env.SOULWEAVE_CACHE;
  if (fromEnv && fromEnv.trim()) return path.resolve(fromEnv.trim());
  const dataRoot = process.env.SOULWEAVE_DATA_ROOT;
  if (dataRoot && dataRoot.trim()) return path.join(path.resolve(dataRoot.trim()), 'cache');
  return path.join(os.tmpdir(), 'SoulWeave', 'cache');
}

/**
 * 选一个纯 ASCII 的缓存根目录。
 * @param kind 子目录名（piper / espeak / whisper …）
 */
export function pickAsciiCacheDir(kind: string): string {
  const candidates = [
    path.join(soulweaveCacheRoot(), kind),
    path.join(os.tmpdir(), 'soulweave-' + kind),
  ];
  for (const c of candidates) {
    if (!hasNonAsciiPath(c)) return c;
  }
  return candidates[candidates.length - 1];
}

/** 递归复制目录（目标已存在时覆盖同名文件） */
export function copyDirDeep(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const a = path.join(src, e.name);
    const b = path.join(dst, e.name);
    if (e.isDirectory()) copyDirDeep(a, b);
    else {
      // 大小相同就跳过，避免每次启动都复制几十 MB
      try {
        if (fs.existsSync(b) && fs.statSync(b).size === fs.statSync(a).size) continue;
      } catch (err) { /* 忽略，照常复制 */ }
      fs.copyFileSync(a, b);
    }
  }
}

/**
 * 确保一个**目录**在 ASCII 路径下可用。
 * @returns 可用的 ASCII 路径；失败时给出原因
 */
export function ensureAsciiDir(
  srcDir: string,
  kind: string,
  requiredFile?: string
): { ok: boolean; path?: string; copied?: boolean; error?: string } {
  if (!srcDir) return { ok: false, error: '没有指定目录' };
  if (!fs.existsSync(srcDir)) return { ok: false, error: '目录不存在：' + srcDir };
  if (requiredFile && !fs.existsSync(path.join(srcDir, requiredFile))) {
    return { ok: false, error: '目录不完整（缺 ' + requiredFile + '）' };
  }
  if (!hasNonAsciiPath(srcDir)) return { ok: true, path: srcDir, copied: false };
  try {
    const root = pickAsciiCacheDir(kind);
    const dst = path.join(root, path.basename(srcDir));
    let copied = false;
    if (requiredFile ? !fs.existsSync(path.join(dst, requiredFile)) : !fs.existsSync(dst)) {
      copyDirDeep(srcDir, dst);
      copied = true;
    }
    if (requiredFile && !fs.existsSync(path.join(dst, requiredFile))) {
      return { ok: false, error: '复制到 ASCII 目录失败：' + dst };
    }
    return { ok: true, path: dst, copied };
  } catch (e) {
    return { ok: false, error: '复制失败：' + String(e).slice(0, 160) };
  }
}

/**
 * 确保一批**文件**在同一个 ASCII 目录下可用（例如 .onnx + .onnx.json）。
 * @returns 对应的新路径数组（顺序与输入一致）
 */
export function ensureAsciiFiles(
  srcFiles: string[],
  kind: string
): { ok: boolean; paths?: string[]; copied?: boolean; error?: string } {
  const list = (srcFiles || []).filter(Boolean);
  if (!list.length) return { ok: false, error: '没有指定文件' };
  for (const f of list) {
    if (!fs.existsSync(f)) return { ok: false, error: '文件不存在：' + f };
  }
  if (!list.some((f) => hasNonAsciiPath(f))) return { ok: true, paths: list.slice(), copied: false };
  try {
    const root = pickAsciiCacheDir(kind);
    fs.mkdirSync(root, { recursive: true });
    let copied = false;
    const out: string[] = [];
    for (const f of list) {
      const dst = path.join(root, path.basename(f));
      try {
        const same = fs.existsSync(dst) && fs.statSync(dst).size === fs.statSync(f).size;
        if (!same) { fs.copyFileSync(f, dst); copied = true; }
      } catch (e) {
        fs.copyFileSync(f, dst);
        copied = true;
      }
      out.push(dst);
    }
    return { ok: true, paths: out, copied };
  } catch (e) {
    return { ok: false, error: '复制失败：' + String(e).slice(0, 160) };
  }
}
