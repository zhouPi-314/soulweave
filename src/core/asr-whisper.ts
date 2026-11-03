/*
 * SoulWeave S7：本地语音识别（whisper.cpp 子进程）
 *
 * 依据：用户决策「本地 whisper 内置 base，其余可下载」
 *
 * 【为什么用子进程而不是绑定】
 * whisper.cpp 的 Node 绑定需要编译原生模块，跨 Electron ABI 会炸；
 * 而官方已经提供 Windows x64 预编译包（8.9 MB），直接 spawn 最稳。
 *
 * 【踩过的坑：模型路径不能含中文】
 * 实测：exe 放在中文路径下正常；但**模型路径含中文时 whisper-cli 直接崩**
 * （exit -1073740791 = 0xC0000409，和之前 sd.cpp 的核显崩溃是同一类）。
 * 而 SoulWeave 的默认数据目录是 <workspace>
 * 所以这里做**自动转存**：检测到非 ASCII 路径就把模型复制到纯 ASCII 缓存目录，
 * 用短路径调用，用户无感。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { soulweaveCacheRoot } from './ascii-cache.js';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

// ─── 常量 ───────────────────────────────────────────

export const WHISPER_EXE_NAME = 'whisper-cli.exe';

export interface WhisperResult {
  ok: boolean;
  text?: string;
  /** 分段（带时间戳） */
  segments?: Array<{ from: number; to: number; text: string }>;
  /** 检测到的语言 */
  language?: string;
  error?: string;
  code?: string;
  ms?: number;
  /** 实际用的模型名 */
  model?: string;
}

// ─── 路径工具（纯函数） ─────────────────────────────

/** 路径里有没有非 ASCII 字符（中文、日文、emoji 都算） */
export function hasNonAscii(p: string): boolean {
  return /[^\x00-\x7F]/.test(String(p || ''));
}

/**
 * 找一个「保证纯 ASCII」的缓存目录。
 *
 * 顺序：
 *   1. 用户 TEMP（若路径为纯 ASCII，例如 C:\Users\<用户名>\AppData\Local\Temp）
 *   2. C:\ProgramData\SoulWeave
 *   3. 系统盘根目录下的 SoulWeave-cache
 */
export function pickAsciiCacheDir(opts: { tmpdir?: string; exists?: (p: string) => boolean; mkdir?: (p: string) => void } = {}): string {
  const tmp = opts.tmpdir || os.tmpdir();
  const exists = opts.exists || ((p: string) => { try { return fs.existsSync(p); } catch (e) { return false; } });
  const mkdir = opts.mkdir || ((p: string) => { try { fs.mkdirSync(p, { recursive: true }); } catch (e) { /* ignore */ } });

  // 缓存根统一由 ascii-cache 提供（默认 <工作区>\cache，不落系统盘）
  const candidates = [
    path.join(soulweaveCacheRoot(), 'whisper'),
    path.join(tmp, 'soulweave-whisper'),
  ];
  for (const c of candidates) {
    if (hasNonAscii(c)) continue;
    try { mkdir(c); } catch (e) { continue; }
    if (exists(c)) return c;
  }
  return candidates[candidates.length - 1];
}

/** 模型文件的 ASCII 缓存名（用 hash 避免同名冲突） */
export function asciiCacheName(modelPath: string): string {
  const h = crypto.createHash('sha1').update(String(modelPath)).digest('hex').slice(0, 12);
  const base = path.basename(String(modelPath || 'model.bin')).replace(/[^\w.\-]/g, '_');
  return h + '-' + base;
}

/**
 * 确保模型有一个 ASCII 路径可用。
 *
 * 已经是 ASCII 就原样返回；否则复制到缓存目录（按大小+mtime 判断是否需刷新）。
 */
export function ensureAsciiModelPath(
  modelPath: string,
  opts: { cacheDir?: string; exists?: (p: string) => boolean; sizeOf?: (p: string) => number; copy?: (a: string, b: string) => void } = {},
): { ok: boolean; path: string; copied: boolean; error?: string } {
  const src = String(modelPath || '');
  if (!src) return { ok: false, path: '', copied: false, error: '没有模型路径' };
  if (!hasNonAscii(src)) return { ok: true, path: src, copied: false };

  const exists = opts.exists || ((p: string) => { try { return fs.existsSync(p); } catch (e) { return false; } });
  const sizeOf = opts.sizeOf || ((p: string) => { try { return fs.statSync(p).size; } catch (e) { return -1; } });
  const copy = opts.copy || ((a: string, b: string) => { fs.copyFileSync(a, b); });

  if (!exists(src)) return { ok: false, path: '', copied: false, error: '模型文件不存在：' + src };

  // 传进来的缓存目录本身也可能是中文（比如用户数据目录），
  // 那就没意义了 —— 退回到真正的 ASCII 目录。
  const dir = opts.cacheDir && !hasNonAscii(opts.cacheDir) ? opts.cacheDir : pickAsciiCacheDir();
  const dst = path.join(dir, asciiCacheName(src));
  const srcSize = sizeOf(src);
  const dstSize = sizeOf(dst);
  if (dstSize === srcSize && dstSize > 0) return { ok: true, path: dst, copied: false };

  try {
    copy(src, dst);
    return { ok: true, path: dst, copied: true };
  } catch (e: any) {
    return { ok: false, path: '', copied: false, error: '复制模型失败：' + String(e && e.message ? e.message : e).slice(0, 150) };
  }
}

// ─── 命令构造（纯函数，便于测试） ───────────────────

export interface WhisperRunOptions {
  exePath: string;
  modelPath: string;
  audioPath: string;
  language?: string;
  /** 线程数；0 = 自动 */
  threads?: number;
  /** 输出 JSON 的路径前缀（whisper 会写 <prefix>.json） */
  outPrefix?: string;
  /** 超时 */
  timeoutMs?: number;
}

/** 组装参数数组 */
export function buildWhisperArgs(o: WhisperRunOptions): string[] {
  const args: string[] = [
    '-m', o.modelPath,
    '-f', o.audioPath,
    '-l', String(o.language || 'auto'),
    '-nt',                    // 不输出时间戳到 stdout，避免解析噪声
  ];
  const t = Number(o.threads);
  if (Number.isFinite(t) && t > 0) args.push('-t', String(Math.floor(t)));
  if (o.outPrefix) args.push('-oj', '-of', o.outPrefix);
  return args;
}

/**
 * 从 whisper 的 JSON 里取结果。
 *
 * 注意：whisper-cli 的 JSON 是**UTF-8 写盘**，但 Windows 控制台输出可能是 GBK，
 * 所以一律读 JSON 文件，不解析 stdout。
 */
export function parseWhisperJson(raw: any): { text: string; segments: Array<{ from: number; to: number; text: string }>; language?: string } {
  const segs: Array<{ from: number; to: number; text: string }> = [];
  const arr = raw && Array.isArray(raw.transcription) ? raw.transcription : [];
  for (const s of arr) {
    if (!s || typeof s !== 'object') continue;
    const text = String(s.text || '').trim();
    if (!text) continue;
    const off = s.offsets || {};
    segs.push({
      from: Number(off.from) || 0,
      to: Number(off.to) || 0,
      text,
    });
  }
  const language = raw && raw.result && raw.result.language ? String(raw.result.language) : undefined;
  return { text: segs.map((x) => x.text).join('').trim(), segments: segs, language };
}

// ─── 运行 ───────────────────────────────────────────

export function resolveWhisperExe(dirs: string[]): string | null {
  for (const d of dirs) {
    if (!d) continue;
    const p = path.join(d, WHISPER_EXE_NAME);
    try { if (fs.existsSync(p)) return p; } catch (e) { /* ignore */ }
  }
  return null;
}

/**
 * 跑一次转写。
 *
 * 永不抛异常；所有失败都变成 { ok:false, code, error }。
 */
export async function transcribeWhisper(o: WhisperRunOptions): Promise<WhisperResult> {
  const t0 = Date.now();
  if (!o.exePath) return { ok: false, code: 'NO_BINARY', error: '没找到 whisper-cli.exe' };
  if (!fs.existsSync(o.exePath)) return { ok: false, code: 'NO_BINARY', error: 'whisper-cli.exe 不存在' };
  if (!o.modelPath) return { ok: false, code: 'NO_MODEL', error: '没有选择模型' };
  if (!fs.existsSync(o.modelPath)) return { ok: false, code: 'NO_MODEL', error: '模型文件不存在' };
  if (!o.audioPath || !fs.existsSync(o.audioPath)) return { ok: false, code: 'NO_AUDIO', error: '音频文件不存在' };

  // 关键：模型路径必须 ASCII，否则 whisper 直接崩
  const fixed = ensureAsciiModelPath(o.modelPath);
  if (!fixed.ok) return { ok: false, code: 'NO_MODEL', error: fixed.error };

  const outPrefix = o.outPrefix || path.join(path.dirname(fixed.path), 'out-' + Date.now().toString(36));
  const jsonPath = outPrefix + '.json';
  const args = buildWhisperArgs({ ...o, modelPath: fixed.path, outPrefix });
  const timeout = Number(o.timeoutMs) || 180000;

  try {
    const r = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      let out = '', err = '';
      let child: any;
      try {
        child = spawn(o.exePath, args, { windowsHide: true, cwd: path.dirname(o.exePath) });
      } catch (e: any) {
        resolve({ code: -1, stdout: '', stderr: String(e && e.message ? e.message : e) });
        return;
      }
      const timer = setTimeout(() => { try { child.kill(); } catch (e) { void e; } }, timeout);
      child.stdout?.on('data', (d: any) => { out += String(d); });
      child.stderr?.on('data', (d: any) => { err += String(d); });
      child.on('close', (code: number) => { clearTimeout(timer); resolve({ code: code == null ? -1 : code, stdout: out, stderr: err }); });
      child.on('error', (e: any) => { clearTimeout(timer); resolve({ code: -1, stdout: out, stderr: String(e) }); });
    });

    const ms = Date.now() - t0;

    // 崩溃码：0xC0000409 等
    if (r.code !== 0) {
      const hex = (r.code >>> 0).toString(16).toUpperCase();
      if (r.code === -1073740791 || hex === 'C0000409') {
        return {
          ok: false, code: 'CRASH', ms,
          error: 'whisper 进程崩溃（0xC0000409）。常见原因：模型文件损坏，或路径含非 ASCII 字符。',
        };
      }
      return { ok: false, code: 'RUN_FAILED', ms, error: (r.stderr || '').slice(-300) || ('退出码 ' + r.code) };
    }

    // 读 JSON（不解析 stdout：控制台可能是 GBK）
    if (fs.existsSync(jsonPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        const parsed = parseWhisperJson(raw);
        try { fs.unlinkSync(jsonPath); } catch (e) { void e; }
        return { ok: true, text: parsed.text, segments: parsed.segments, language: parsed.language, ms, model: path.basename(fixed.path) };
      } catch (e) { /* 落到 stdout 解析 */ }
    }

    // 兜底：从 stdout 里抠（去掉时间戳行）
    const lines = String(r.stdout || '').split(/\r?\n/)
      .map((l) => l.replace(/^\s*\[[^\]]*\]\s*/, '').trim())
      .filter(Boolean);
    return { ok: true, text: lines.join('').trim(), segments: [], ms };
  } catch (e: any) {
    return { ok: false, code: 'RUN_FAILED', error: String(e && e.message ? e.message : e).slice(0, 200), ms: Date.now() - t0 };
  }
}

/** 探测本机 whisper 运行时是否就绪 */
export function probeWhisperRuntime(dirs: string[], models: Array<{ id: string; path: string; installed: boolean }>): {
  exeFound: boolean;
  exePath: string | null;
  modelsInstalled: number;
  ready: boolean;
} {
  const exe = resolveWhisperExe(dirs);
  const installed = (models || []).filter((m) => m.installed).length;
  return { exeFound: !!exe, exePath: exe, modelsInstalled: installed, ready: !!exe && installed > 0 };
}