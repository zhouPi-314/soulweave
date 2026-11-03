/**
 * SoulWeave S3-8：Piper provider
 *
 * 设计要点
 * ────────
 * 1. **子进程调用**：piper.exe 是独立进程，不与 SoulWeave 链接。
 *    这是让 espeak-ng(GPL-3.0) 的义务不蔓延到主体程序的关键
 *    （聚合 vs 衍生作品的分界）。
 * 2. **文本走 stdin**：piper 从标准输入读，不是命令行参数。
 * 3. **UTF-8**：Node 的 spawn 需要显式保证编码，否则中文会乱码。
 * 4. **输出 WAV → base64**：与现有 Web Audio 播放层对接。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { hasNonAsciiPath, ensureAsciiFiles, ensureAsciiDir, pickAsciiCacheDir } from '../core/ascii-cache.js';
import path from 'node:path';

export interface PiperVoice {
  id: string;          // 文件名主干，如 zh_CN-huayan-medium
  name: string;        // 展示名
  language: string;    // zh_CN / en_US …
  phonemeType: string; // espeak / pinyin / text …
}

export interface PiperSynthResult {
  ok: boolean;
  base64?: string;
  bytes?: number;
  ms?: number;
  sampleRate?: number;
  error?: string;
}

/**
 * 当前 Piper 构建支持的音素方案。
 *
 * 【为什么需要】
 * Piper 的中文音色有两种音素方案：
 *   - espeak  （如 zh_CN-huayan-medium）→ 可用
 *   - pinyin  （如 zh_CN-chaowen-medium）→ 在 piper 2023.11.14 上**直接崩溃**
 *     实测退出码 -1073740791（0xC0000409 STATUS_STACK_BUFFER_OVERRUN）
 *
 * 所以枚举时必须按 phoneme_type 过滤，否则用户选了就崩。
 * 若将来换用支持 pinyin 的更新构建，只需把 'pinyin' 加进来。
 */
const SUPPORTED_PHONEME_TYPES = new Set(['espeak', 'text']);

/** 读 .onnx.json 的 phoneme_type；读不到时返回 null（视为未知） */
function readPhonemeType(configPath: string): string | null {
  try {
    const j = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const t = j && (j.phoneme_type || j.phonemeType);
    return typeof t === 'string' ? t : null;
  } catch (e) {
    return null;
  }
}

/** 从 piper 目录扫出可用音色（*.onnx 且存在同名 .onnx.json，且音素方案受支持） */
export function listPiperVoices(piperDir: string): PiperVoice[] {
  return scanPiperVoices(piperDir).voices;
}

/**
 * 扫描并同时返回「被跳过的不支持音色」。
 * 引导页可以据此告诉用户「这个音色需要更新的 Piper 版本」，而不是默默消失。
 */
export function scanPiperVoices(piperDir: string): {
  voices: PiperVoice[];
  skipped: Array<{ id: string; phonemeType: string }>;
} {
  const out: PiperVoice[] = [];
  const skipped: Array<{ id: string; phonemeType: string }> = [];
  try {
    for (const f of fs.readdirSync(piperDir)) {
      if (!f.endsWith('.onnx')) continue;
      const base = f.slice(0, -5);
      const cfgPath = path.join(piperDir, base + '.onnx.json');
      if (!fs.existsSync(cfgPath)) continue;

      // 过滤不支持的音素方案（见 SUPPORTED_PHONEME_TYPES 注释）
      const pt = readPhonemeType(cfgPath);
      if (pt !== null && !SUPPORTED_PHONEME_TYPES.has(pt)) {
        skipped.push({ id: base, phonemeType: pt });
        continue;
      }

      const parts = base.split('-');
      out.push({
        id: base,
        name: base,
        language: parts[0] || '',
        phonemeType: pt || 'unknown',
      });
    }
  } catch (e) { /* ignore */ }
  return { voices: out.sort((a, b) => a.id.localeCompare(b.id)), skipped };
}

/** 读 WAV 头的采样率（Piper 输出标准 PCM WAV） */
function wavSampleRate(buf: Buffer): number | undefined {
  try {
    if (buf.length < 44) return undefined;
    if (buf.toString('ascii', 0, 4) !== 'RIFF') return undefined;
    if (buf.toString('ascii', 8, 12) !== 'WAVE') return undefined;
    // 扫 fmt 块
    let off = 12;
    while (off + 8 <= buf.length) {
      const id = buf.toString('ascii', off, off + 4);
      const size = buf.readUInt32LE(off + 4);
      if (id === 'fmt ' && off + 8 + 16 <= buf.length) {
        return buf.readUInt32LE(off + 12);
      }
      off += 8 + size + (size % 2);
    }
  } catch (e) { /* ignore */ }
  return undefined;
}

/**
 * 合成。
 * 注意：piper 需要能定位到 espeak-ng-data；它默认在 exe 同目录找，
 * 也支持 --espeak_data 显式指定。
 */
export function synthesizePiper(
  piperDir: string,
  text: string,
  opts: { voiceId?: string; espeakDataPath?: string | null; lengthScale?: number; noiseScale?: number } = {}
): Promise<PiperSynthResult> {
  const t0 = Date.now();
  const body = String(text || '').trim();
  if (!body) return Promise.resolve({ ok: false, error: '文本为空' });
  if (body.length > 3000) return Promise.resolve({ ok: false, error: '单次合成文本过长（上限 3000 字）' });

  const exe = path.join(piperDir, 'piper.exe');
  if (!fs.existsSync(exe)) return Promise.resolve({ ok: false, error: 'piper.exe 不存在' });

  const voices = listPiperVoices(piperDir);
  if (!voices.length) return Promise.resolve({ ok: false, error: 'piper 目录中没有可用音色（.onnx + .onnx.json）' });

  const voiceId = opts.voiceId && voices.some((v) => v.id === opts.voiceId) ? opts.voiceId : voices[0].id;
  const modelPath = path.join(piperDir, voiceId + '.onnx');

  // 【必须 ASCII】实测（2026-11-01）：模型路径含中文时 piper 直接 0xC0000409 崩溃；
  // 模型放到 C:\ProgramData 下的 ASCII 目录后，加载只用 0.26 秒就正常了。
  const modelAscii = ensureAsciiFiles([modelPath, modelPath + '.json'], 'piper-models');
  if (!modelAscii.ok || !modelAscii.paths) {
    return Promise.resolve({ ok: false, error: '模型路径不可用：' + (modelAscii.error || '未知') });
  }
  const [asciiModel, asciiCfg] = modelAscii.paths;

  // espeak 数据目录同理：非 ASCII 时 espeak 报 "Illegal byte sequence"
  let espeakData = opts.espeakDataPath || path.join(piperDir, 'espeak-ng-data');
  const dataAscii = ensureAsciiDir(espeakData, 'espeak', 'phontab');
  if (!dataAscii.ok || !dataAscii.path) {
    return Promise.resolve({ ok: false, error: 'espeak 数据不可用：' + (dataAscii.error || '未知') });
  }
  espeakData = dataAscii.path;

  // 输出也要 ASCII（曾出现临时目录是中文导致的失败）
  let outDir = os.tmpdir();
  if (hasNonAsciiPath(outDir)) outDir = pickAsciiCacheDir('piper-out');
  try { fs.mkdirSync(outDir, { recursive: true }); } catch (e) { /* ignore */ }
  const outWav = path.join(outDir, 'sw-piper-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7) + '.wav');

  const args: string[] = ['--model', asciiModel, '--config', asciiCfg, '--output_file', outWav];
  if (espeakData) args.push('--espeak_data', espeakData);
  if (typeof opts.lengthScale === 'number') args.push('--length_scale', String(opts.lengthScale));
  if (typeof opts.noiseScale === 'number') args.push('--noise_scale', String(opts.noiseScale));

  return new Promise<PiperSynthResult>((resolve) => {
    let done = false;
    const finish = (r: PiperSynthResult) => { if (!done) { done = true; resolve(r); } };

    let ps;
    try {
      ps = spawn(exe, args, { cwd: piperDir, windowsHide: true });
    } catch (e) {
      finish({ ok: false, error: '启动 piper 失败: ' + String(e) });
      return;
    }

    let err = '';
    ps.stderr.on('data', (d) => { err += d.toString('utf8'); });
    ps.on('error', (e) => finish({ ok: false, error: 'piper 进程错误: ' + String(e) }));

    const timer = setTimeout(() => { try { ps.kill(); } catch (e) { /* ignore */ } }, 30000);

    ps.on('close', (code) => {
      clearTimeout(timer);
      try {
        if (!fs.existsSync(outWav)) {
          finish({ ok: false, error: (err || ('piper 退出码 ' + code)).slice(0, 300), ms: Date.now() - t0 });
          return;
        }
        const buf = fs.readFileSync(outWav);
        if (!buf.length) { finish({ ok: false, error: 'piper 输出为空' }); return; }
        finish({
          ok: true,
          base64: buf.toString('base64'),
          bytes: buf.length,
          ms: Date.now() - t0,
          sampleRate: wavSampleRate(buf),
        });
      } catch (e) {
        finish({ ok: false, error: String(e) });
      } finally {
        try { if (fs.existsSync(outWav)) fs.unlinkSync(outWav); } catch (e) { /* ignore */ }
      }
    });

    // 文本走 stdin（UTF-8 由 Node 的 Buffer 写入保证）
    try {
      ps.stdin.write(body, 'utf8');
      ps.stdin.end();
    } catch (e) {
      finish({ ok: false, error: '写入文本失败: ' + String(e) });
    }
  });
}
