/**
 * SoulWeave S3-13：Kokoro provider
 *
 * 三个技术要点（均已实测确认）
 * ────────────────────────────────
 * 1. **音素化必须用 espeak-ng**。Kokoro 的 tokenizer 就是 espeak + phonemizer，
 *    没有纯 JS 替代。这里通过 koffi FFI 直接调 espeak-ng.dll 的 C API
 *    （DLL 由用户装 Piper 时一并获得，不额外分发）。
 *
 * 2. **不能循环调用 espeak_TextToPhonemes**。该函数靠推进 char** 指针遍历分句，
 *    而 koffi 无法把这个出参写回 JS，导致每次返回同一句。
 *    解决办法：**自己按标点分句**，一句一次调用，绕开指针推进。
 *
 * 3. **voices-v1.0.bin 是 ZIP**（PK\x03\x04），每个音色是一个 .npy。
 *    需要自己解 ZIP（stored/deflate）并解析 .npy 头。
 *
 * 安全：.pth/.ckpt 绝不加载；本模块只读 .onnx / .npy / .json，不含可执行内容。
 */

import fs from 'node:fs';
import os from 'node:os';
import {
  hasNonAsciiPath as asciiHasNonAscii,
  pickAsciiCacheDir as asciiPickDir,
  ensureAsciiDir as asciiEnsureDir,
} from '../core/ascii-cache.js';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';

/**
 * ESM 环境下加载 CJS 原生模块（koffi / onnxruntime-node）。
 * 本项目 main 编译为 ESM，直接写 require 会报 "require is not defined"（已实测）。
 */
const requireCjs = createRequire(
  typeof __filename !== 'undefined' ? __filename : import.meta.url
);

/** 每个音色的风格向量长度 = Kokoro 的最大 token 数 */
const MAX_TOKENS = 510;

// ── 1. espeak-ng FFI ──────────────────────────────

let espeakLib: any = null;
let espeakInited = false;

/** 在给定目录里找 espeak-ng.dll（通常与 piper.exe 同目录） */
export function findEspeakDll(dirs: string[]): string | null {
  for (const d of dirs) {
    if (!d) continue;
    for (const name of ['espeak-ng.dll', 'libespeak-ng.dll', 'espeak.dll']) {
      const p = path.join(d, name);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

export function findEspeakData(dirs: string[]): string | null {
  for (const d of dirs) {
    if (!d) continue;
    const p = path.join(d, 'espeak-ng-data');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * espeak-ng 的数据目录必须是纯 ASCII 路径。
 *
 * 【实测踩过的坑（2026-11-01）】
 * 把 espeak-ng-data 放在带中文的路径下时，
 * espeak_Initialize 拿不到数据，会去读编译期默认的 /usr/share/espeak-ng-data，
 * 打印一行错误后**直接 exit()** —— 表现是整个应用进程消失，连异常都抓不到。
 * 在纯 Node 下同样如此（退出码 1）。
 *
 * 把同一份数据复制到 ASCII 目录后再初始化就完全正常
 * （实测 zf_xiaobei 合成 75530 字节 WAV，1.96 秒）。
 *
 * 所以这里：路径已是 ASCII 就原样用；否则复制到 ASCII 缓存目录再用。
 */
export function hasNonAsciiPath(p: string): boolean {
  return asciiHasNonAscii(p);
}

/** 选一个 ASCII 缓存目录（与 piper 共用同一套规则） */
export function pickAsciiCacheDir(): string {
  return asciiPickDir('espeak');
}

/**
 * 确保 espeak 数据目录是 ASCII 路径。
 *
 * 【实测踩过的坑（2026-11-01）】
 * 把 espeak-ng-data 放在带中文的路径下时，
 * espeak_Initialize 拿不到数据，会去读编译期默认的 /usr/share/espeak-ng-data，
 * 打印一行错误后**直接 exit()** —— 表现是整个应用进程消失，连异常都抓不到。
 * 复制到 ASCII 目录后正常（zf_xiaobei 合成 75530 字节 WAV）。
 *
 * 具体复制逻辑已抽到 core/ascii-cache.ts（piper 也用同一套）。
 */
export function ensureAsciiEspeakData(
  dataDir: string,
  opts: { cacheRoot?: string } = {}
): { ok: boolean; path?: string; copied?: boolean; error?: string } {
  if (!dataDir) return { ok: false, error: '没有 espeak 数据目录' };
  const r = asciiEnsureDir(dataDir, 'espeak', 'phontab');
  if (!r.ok) return { ok: false, error: r.error };
  if (opts.cacheRoot && r.copied) {
    // 允许调用方指定缓存根（仅测试用）
    return r;
  }
  return r;
}

function ensureEspeak(dllPath: string, dataPath: string): { ok: boolean; error?: string } {
  if (espeakInited && espeakLib) return { ok: true };
  try {
    // 动态 require，避免在不需要 Kokoro 的环境里加载原生模块
    const koffi = requireCjs('koffi');
    const lib = koffi.load(dllPath);
    const r = lib.func('int espeak_Initialize(int,int,const char*,int)')(1, 0, dataPath, 0);
    if (r < 0) return { ok: false, error: 'espeak_Initialize 失败: ' + r };
    espeakLib = lib;
    espeakInited = true;
    return { ok: true };
  } catch (e) {
    return { ok: false, error: '加载 espeak-ng 失败: ' + String(e).slice(0, 200) };
  }
}

/** 按标点分句（避免依赖 espeak 的指针推进） */
function splitClauses(text: string): string[] {
  const parts = String(text).match(/[^，。！？；,!?;\n]+[，。！？；,!?;\n]?/g) || [String(text)];
  return parts.map((s) => s.trim()).filter(Boolean).slice(0, 60);
}

/**
 * 中文/多语种音素化。
 * @returns IPA 音素串；失败返回 { error }
 */
function phonemize(text: string, voice: string): { phonemes?: string; error?: string } {
  if (!espeakLib) return { error: 'espeak 未初始化' };
  try {
    const setVoice = espeakLib.func('int espeak_SetVoiceByName(const char*)');
    const rv = setVoice(voice);
    if (rv !== 0) return { error: 'espeak 不支持音色 ' + voice + '（code ' + rv + '）' };

    const ttp = espeakLib.func('char *espeak_TextToPhonemes(void **textptr, int textmode, int phonememode)');
    let out = '';
    for (const clause of splitClauses(text)) {
      const buf = Buffer.from(clause + '\0', 'utf8');
      const holder = [buf];
      // 一句通常一次调用返回完整音素；再多调一次若返回相同内容则停止
      const first = ttp(holder, 1, 0x02);
      if (!first) continue;
      let got = String(first);
      // 兜底：万一 espeak 仍分两次吐出不同片段，再取一次
      const second = ttp(holder, 1, 0x02);
      if (second && String(second) !== got) got += String(second);

      // 【S3-17 关键修正】保留标点。
      // espeak 会把标点当分隔符吃掉，但 Kokoro 的 vocab 里 , . ! ? ; 都是有 id 的，
      // 它们在音素流里会被渲染成「停顿」。Python 版（phonemizer）保留标点，
      // 因此同一句话 Python 3.80s / 本实现 3.10s —— 差的就是这些停顿。
      const tail = clause.match(/[，。！？；,.!?;]$/);
      out += ' ' + got + (tail ? tail[0] : '');
    }
    return { phonemes: normalizePunctuation(out.trim()) };
  } catch (e) {
    return { error: String(e).slice(0, 200) };
  }
}

// ── 2. vocab ──────────────────────────────────────

export interface KokoroConfig {
  vocab: Record<string, number>;
  sampleRate: number;
}

export function loadKokoroConfig(kokoroDir: string): { ok: boolean; cfg?: KokoroConfig; error?: string } {
  try {
    const p = path.join(kokoroDir, 'config.json');
    if (!fs.existsSync(p)) return { ok: false, error: 'config.json 不存在（vocab 必需）' };
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!j.vocab || typeof j.vocab !== 'object') return { ok: false, error: 'config.json 缺少 vocab' };
    return { ok: true, cfg: { vocab: j.vocab, sampleRate: 24000 } };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 200) };
  }
}

/**
 * 全角标点 → 半角标点。
 *
 * 【为什么必需】Kokoro v1.0 的 vocab 只收 ASCII 标点（, . ! ? ; 有 id），
 * 中文全角 ，。！？； 全都不在词表里，会被 tokenize 直接丢掉。
 * 结果就是「句子之间没有停顿」，听感上语速偏快（实测 6.8 字/秒 vs 自然的 5.5）。
 * 映射后这些标点能正常产生停顿。
 */
const PUNCT_MAP: Record<string, string> = {
  '，': ',', '。': '.', '！': '!', '？': '?', '；': ';',
  '、': ',', '：': ':', '“': '"', '”': '"', '‘': "'", '’': "'",
};

export function normalizePunctuation(s: string): string {
  let out = '';
  for (const ch of s) out += (PUNCT_MAP[ch] !== undefined ? PUNCT_MAP[ch] : ch);
  return out;
}

/** 音素 → token id（与 kokoro_onnx 的 tokenize 行为一致：过滤不在词表里的字符） */
export function tokenize(phonemes: string, vocab: Record<string, number>): number[] {
  const out: number[] = [];
  for (const ch of String(phonemes)) {
    const id = vocab[ch];
    if (typeof id === 'number') out.push(id);
  }
  return out;
}

// ── 3. voices zip / npy ───────────────────────────

/** 极简 ZIP 读取：返回 { 文件名: 解压后 Buffer } */
export function readZip(buf: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  // 找中央目录结束记录 EOCD
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return files;
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);

    // 本地头
    if (localOff + 30 <= buf.length && buf.readUInt32LE(localOff) === 0x04034b50) {
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      const raw = buf.slice(dataStart, dataStart + compSize);
      try {
        files.set(name, method === 0 ? raw : zlib.inflateRawSync(raw));
      } catch (e) { /* 跳过损坏项 */ }
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

export interface NpyArray { shape: number[]; data: Float32Array }

/** 解析 .npy（只支持 float32 / float64） */
export function parseNpy(buf: Buffer): NpyArray | null {
  if (buf.length < 10 || buf[0] !== 0x93) return null;
  const major = buf[6];
  let headerLen: number, dataStart: number;
  if (major === 1) { headerLen = buf.readUInt16LE(8); dataStart = 10 + headerLen; }
  else { headerLen = buf.readUInt32LE(8); dataStart = 12 + headerLen; }
  const header = buf.toString('latin1', major === 1 ? 10 : 12, dataStart);
  const shapeM = header.match(/\(([0-9,\s]+)\)/);
  const shape = shapeM ? shapeM[1].split(',').map((s) => s.trim()).filter(Boolean).map(Number) : [];
  const isF64 = /'<f8'|'f8'/.test(header);
  if (!/'<f4'|'f4'/.test(header) && !isF64) return null;
  const count = shape.reduce((a, b) => a * b, 1);
  const bytes = isF64 ? 8 : 4;
  if (dataStart + count * bytes > buf.length) return null;
  const data = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    data[i] = isF64 ? buf.readDoubleLE(dataStart + i * 8) : buf.readFloatLE(dataStart + i * 4);
  }
  return { shape, data };
}

/** 读某个音色的风格向量（缓存） */
const styleCache = new Map<string, Float32Array>();

export function loadStyle(kokoroDir: string, voiceId: string): { ok: boolean; style?: Float32Array; dim?: number; error?: string } {
  const key = voiceId;
  if (styleCache.has(key)) {
    const s = styleCache.get(key)!;
    return { ok: true, style: s, dim: 256 };
  }
  try {
    const binPath = path.join(kokoroDir, 'voices-v1.0.bin');
    if (!fs.existsSync(binPath)) return { ok: false, error: 'voices-v1.0.bin 不存在' };
    const zip = readZip(fs.readFileSync(binPath));
    const entry = zip.get(voiceId + '.npy');
    if (!entry) return { ok: false, error: '音色 ' + voiceId + ' 不在 voices-v1.0.bin 中' };
    const arr = parseNpy(entry);
    if (!arr) return { ok: false, error: '风格向量解析失败' };
    // 形如 (510, 256)
    const dim = arr.shape.length >= 2 ? arr.shape[arr.shape.length - 1] : 256;
    styleCache.set(key, arr.data);
    return { ok: true, style: arr.data, dim };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 200) };
  }
}

/** 列出 voices-v1.0.bin 里的音色名 */
export function listKokoroVoices(kokoroDir: string): string[] {
  try {
    const binPath = path.join(kokoroDir, 'voices-v1.0.bin');
    if (!fs.existsSync(binPath)) return [];
    const zip = readZip(fs.readFileSync(binPath));
    return Array.from(zip.keys())
      .filter((n) => n.endsWith('.npy'))
      .map((n) => n.replace(/\.npy$/, ''))
      .sort();
  } catch (e) {
    return [];
  }
}

// ── 4. 推理 + WAV ─────────────────────────────────

/**
 * 裁剪首尾静音。
 *
 * 【为什么必需】实测同一句话：
 *   Python（kokoro-onnx，默认 trim=True）→ 1.56s
 *   本实现（未裁剪）              → 1.93s
 * 相差的 0.37s **不是音素或风格差异**，而是首尾静音。
 * 裁剪后时长对齐，听感也更干净（不会先静半秒再开口）。
 *
 * 阈值取「峰值的一定比例」，避免把轻辅音当静音切掉。
 *
 * 【阈值实测（同一句话，原始 1.93s / Python 1.56s）】
 *   th=0.02   → 1.18s   切太狠，会吃掉句首气口
 *   th=0.005  → 1.49s
 *   th=0.001  → 1.52s   ← 采用，最接近 Python
 *   th=0.0002 → 1.53s   几乎不裁剪
 */
export function trimSilence(samples: Float32Array, thresholdRatio = 0.001): Float32Array {
  const n = samples.length;
  if (!n) return samples;
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const a = samples[i] < 0 ? -samples[i] : samples[i];
    if (a > peak) peak = a;
  }
  if (peak <= 0.0001) return samples;
  const th = peak * thresholdRatio;
  let start = 0;
  while (start < n && Math.abs(samples[start]) < th) start++;
  let end = n - 1;
  while (end > start && Math.abs(samples[end]) < th) end--;
  if (start === 0 && end === n - 1) return samples;
  // 两端各留 20ms 余量，避免切掉气口
  const pad = Math.floor(24000 * 0.02);
  const s = Math.max(0, start - pad);
  const e = Math.min(n - 1, end + pad);
  return samples.subarray(s, e + 1);
}

/** Float32 PCM → 16bit WAV */
export function encodeWav(samples: Float32Array, sampleRate: number): Buffer {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);        // PCM
  buf.writeUInt16LE(1, 22);        // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  return buf;
}

let ortSession: any = null;
let ortSessionPath = '';

async function getSession(modelPath: string): Promise<any> {
  if (ortSession && ortSessionPath === modelPath) return ortSession;
  const ort = requireCjs('onnxruntime-node');
  ortSession = await ort.InferenceSession.create(modelPath);
  ortSessionPath = modelPath;
  return ortSession;
}

/**
 * 预先创建 ONNX 会话（预热）。
 * 首次 InferenceSession.create 要加载 310 MB 模型，约 1.3~1.7 秒；
 * 预热后用户第一次合成只需推理时间。
 */
export async function warmupSession(modelPath: string): Promise<boolean> {
  await getSession(modelPath);
  return true;
}

export interface KokoroSynthResult {
  ok: boolean;
  base64?: string;
  bytes?: number;
  ms?: number;
  sampleRate?: number;
  tokens?: number;
  error?: string;
}

/**
 * 合成。
 * @param kokoroDir 含 kokoro-v1.0.onnx / voices-v1.0.bin / config.json
 * @param espeakDirs 用于定位 espeak-ng.dll 与 espeak-ng-data 的候选目录
 */
export async function synthesizeKokoro(
  kokoroDir: string,
  text: string,
  opts: { voiceId?: string; speed?: number; lang?: string; espeakDirs?: string[] } = {}
): Promise<KokoroSynthResult> {
  const t0 = Date.now();
  const body = String(text || '').trim();
  if (!body) return { ok: false, error: '文本为空' };
  if (body.length > 800) return { ok: false, error: 'Kokoro 单次上限 800 字（模型 token 上限 510）' };

  const dirs = opts.espeakDirs || [kokoroDir];
  const dll = findEspeakDll(dirs);
  if (!dll) return { ok: false, error: '找不到 espeak-ng.dll（请先安装 espeak 组件并指定位置）' };
  const dataDir = findEspeakData(dirs);
  if (!dataDir) return { ok: false, error: '找不到 espeak-ng-data 目录' };

  // espeak 在非 ASCII 数据路径下会直接 exit()，必须先转成 ASCII 路径
  const ascii = ensureAsciiEspeakData(dataDir);
  if (!ascii.ok || !ascii.path) return { ok: false, error: ascii.error || 'espeak 数据路径不可用' };

  const ini = ensureEspeak(dll, ascii.path);
  if (!ini.ok) return { ok: false, error: ini.error };

  const modelPath = path.join(kokoroDir, 'kokoro-v1.0.onnx');
  if (!fs.existsSync(modelPath)) return { ok: false, error: 'kokoro-v1.0.onnx 不存在' };

  const cfgRes = loadKokoroConfig(kokoroDir);
  if (!cfgRes.ok || !cfgRes.cfg) return { ok: false, error: cfgRes.error };

  const voiceId = opts.voiceId || 'zf_xiaoxiao';
  const ph = phonemize(body, opts.lang || 'cmn');
  if (ph.error) return { ok: false, error: ph.error };
  if (!ph.phonemes) return { ok: false, error: '音素化为空' };

  const ids = tokenize(ph.phonemes, cfgRes.cfg.vocab);
  if (!ids.length) return { ok: false, error: '音素全部不在词表内（音色/语种不匹配？）' };
  const n = Math.min(ids.length, MAX_TOKENS);

  const st = loadStyle(kokoroDir, voiceId);
  if (!st.ok || !st.style) return { ok: false, error: st.error };

  try {
    const ort = requireCjs('onnxruntime-node');
    const sess = await getSession(modelPath);

    const inputIds = new ort.Tensor('int64', BigInt64Array.from(ids.slice(0, n).map((x) => BigInt(x))), [1, n]);
    // 风格向量取「与 token 数对应」的那一行，形状 (1, dim)
    const dim = st.dim || 256;
    const rowLen = dim;
    const rows = Math.floor(st.style.length / rowLen);
    const rowIdx = Math.max(0, Math.min(rows - 1, n - 1));
    const styleData = new Float32Array(rowLen);
    for (let i = 0; i < rowLen; i++) styleData[i] = st.style[rowIdx * rowLen + i];
    const style = new ort.Tensor('float32', styleData, [1, rowLen]);
    const speed = new ort.Tensor('float32', Float32Array.from([opts.speed || 1.0]), [1]);

    // 模型真实输入名（实测）是 tokens / style / speed，不是 input_ids
    const feeds: any = { tokens: inputIds, style, speed };
    const out = await sess.run(feeds);
    const key = Object.keys(out)[0];
    const rawAudio = out[key].data as Float32Array;
    // S3-14：裁剪首尾静音（对齐 Python 版行为）
    const audio = trimSilence(rawAudio);

    const wav = encodeWav(audio, cfgRes.cfg.sampleRate);
    return {
      ok: true,
      base64: wav.toString('base64'),
      bytes: wav.length,
      ms: Date.now() - t0,
      sampleRate: cfgRes.cfg.sampleRate,
      tokens: n,
    };
  } catch (e) {
    return { ok: false, error: '推理失败: ' + String(e).slice(0, 240), ms: Date.now() - t0 };
  }
}
