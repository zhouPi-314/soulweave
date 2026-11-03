/**
 * SoulWeave S5：语音消息编解码
 *
 * 【范围与边界】
 * QQ 语音消息的线上格式是 **SILK**（腾讯自有），也兼容 AMR。
 * 这两个编码器**没有纯 JS 的可靠实现**，业界通行做法是外部可执行文件：
 *   - SILK：silk_v3_encoder / silk_v3_decoder（Skype 开源，需自行编译）
 *   - AMR ：ffmpeg -c:a libopencore_amrnb
 *
 * **当前状态（2026-10-30）**：SILK 编解码器已内置。
 *   - silk_v3_encoder.exe / silk_v3_decoder.exe（MIT，kn007/silk-v3-decoder）
 *   - 实测参数：-Fs_API 16000 -rate 24000 -tencent
 *   - 实测 1 秒音频 → 2538 字节，头部 02 23 21 53 49 4c 4b 5f 56 33
 *
 * 这一层的策略：
 *   1. **能自己做的全部自己做**（WAV 解析/生成、PCM 重采样、时长、格式嗅探）
 *   2. 编码器做成**可插拔适配器**，优先用内置的，用户也可覆盖路径
 *   3. 没有工具时**明确降级**：给出可读的原因，而不是静默失败
 *
 * 这样：没有外部依赖时 QQ 语音发不出去，但**文字消息完全不受影响**。
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

// ─── WAV ───────────────────────────────────────────────

export interface WavInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  /** 数据段字节数 */
  dataBytes: number;
  /** 时长秒 */
  durationSeconds: number;
  /** 音频格式码：1=PCM */
  formatCode: number;
  /** PCM 数据在 buffer 中的偏移 */
  dataOffset: number;
}

/**
 * 解析 WAV 头。
 *
 * 不假设 44 字节固定头 —— 真实文件里经常有 LIST/fact 等附加块，
 * 必须按块遍历，否则会读到错误的偏移（这是最常见的 WAV 解析 bug）。
 */
export function parseWav(buf: Buffer): WavInfo | null {
  if (!buf || buf.length < 12) return null;
  if (buf.toString('ascii', 0, 4) !== 'RIFF') return null;
  if (buf.toString('ascii', 8, 12) !== 'WAVE') return null;

  let off = 12;
  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  let formatCode = 0;
  let dataOffset = -1;
  let dataBytes = 0;

  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;

    if (id === 'fmt ' && body + 16 <= buf.length) {
      formatCode = buf.readUInt16LE(body);
      channels = buf.readUInt16LE(body + 2);
      sampleRate = buf.readUInt32LE(body + 4);
      bitsPerSample = buf.readUInt16LE(body + 14);
    } else if (id === 'data') {
      dataOffset = body;
      // 有些文件 size 字段不可信（流式写入时为 0 或 0xFFFFFFFF）
      dataBytes = size > 0 && body + size <= buf.length ? size : buf.length - body;
      break;
    }

    // 块按偶数对齐
    const advance = 8 + size + (size % 2);
    if (advance <= 0) break;
    off += advance;
  }

  if (dataOffset < 0 || !sampleRate || !channels) return null;

  const bytesPerFrame = (bitsPerSample / 8) * channels;
  const durationSeconds = bytesPerFrame > 0 ? dataBytes / bytesPerFrame / sampleRate : 0;

  return { sampleRate, channels, bitsPerSample, dataBytes, durationSeconds, formatCode, dataOffset };
}

/** 生成 44 字节标准 WAV 头 + PCM 数据 */
export function buildWav(pcm: Buffer, sampleRate: number, channels = 1, bitsPerSample = 16): Buffer {
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);          // fmt 块大小
  header.writeUInt16LE(1, 20);           // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** 取出 WAV 里的 PCM 数据（去掉所有头/附加块） */
export function extractPcm(buf: Buffer): Buffer | null {
  const info = parseWav(buf);
  if (!info) return null;
  return buf.subarray(info.dataOffset, info.dataOffset + info.dataBytes);
}

// ─── 重采样 ─────────────────────────────────────────────

/**
 * 16 位单声道 PCM 重采样（线性插值）。
 *
 * 用途：SILK 要求 16 kHz，而多数 TTS 输出 24 kHz / 22.05 kHz。
 *
 * 【为什么用线性插值而不是 sinc】
 * 语音消息是**低码率有损压缩**，后续还要过 SILK 编码器，
 * 插值引入的微小混叠会被编码器自身的有损特性淹没。
 * 用 sinc 多花几十倍 CPU 换一个听不出来的差异不值得。
 */
export function resamplePcm16(pcm: Buffer, fromRate: number, toRate: number, channels = 1): Buffer {
  if (fromRate === toRate || fromRate <= 0 || toRate <= 0) return pcm;
  if (channels !== 1) return pcm;   // 只处理单声道（QQ 语音本来就是单声道）

  const inSamples = Math.floor(pcm.length / 2);
  if (inSamples < 2) return pcm;

  const ratio = toRate / fromRate;
  const outSamples = Math.max(1, Math.floor(inSamples * ratio));
  const out = Buffer.alloc(outSamples * 2);

  for (let i = 0; i < outSamples; i++) {
    const src = i / ratio;
    const i0 = Math.floor(src);
    const i1 = Math.min(inSamples - 1, i0 + 1);
    const frac = src - i0;
    const s0 = pcm.readInt16LE(i0 * 2);
    const s1 = pcm.readInt16LE(i1 * 2);
    const v = Math.round(s0 + (s1 - s0) * frac);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, v)), i * 2);
  }
  return out;
}

/** 多声道降为单声道 */
export function toMono(pcm: Buffer, channels: number, bitsPerSample = 16): Buffer {
  if (channels <= 1 || bitsPerSample !== 16) return pcm;
  const frames = Math.floor(pcm.length / (2 * channels));
  const out = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += pcm.readInt16LE((i * channels + c) * 2);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sum / channels))), i * 2);
  }
  return out;
}

/** 估算 SILK/AMR 语音消息的时长（按码率） */
export function estimateDuration(bytes: number, codec: 'silk' | 'amr'): number {
  // SILK 常用 12–24 kbps；AMR-NB 固定 12.2 kbps
  const bitsPerSecond = codec === 'silk' ? 16000 : 12200;
  return bytes > 0 ? (bytes * 8) / bitsPerSecond : 0;
}

// ─── 格式嗅探 ───────────────────────────────────────────

export type AudioFormat = 'wav' | 'silk' | 'amr' | 'mp3' | 'ogg' | 'unknown';

export function sniffFormat(buf: Buffer): AudioFormat {
  if (!buf || buf.length < 4) return 'unknown';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE') return 'wav';
  // 标准 SILK：#!SILK_V3
  if (buf.length >= 9 && buf.toString('ascii', 0, 9) === '#!SILK_V3') return 'silk';
  // 腾讯 SILK（QQ / 微信）：前面多一个字节 0x02（也见过 0x03）
  // 这是实测发现的：不识别这个前缀，收到的 QQ 语音会被判成 unknown。
  if (buf.length >= 10 && (buf[0] === 0x02 || buf[0] === 0x03) &&
      buf.toString('ascii', 1, 10) === '#!SILK_V3') return 'silk';
  // AMR-NB：#!AMR\n
  if (buf.length >= 6 && buf.toString('ascii', 0, 6) === '#!AMR\n') return 'amr';
  // AMR-WB：#!AMR-WB\n
  if (buf.length >= 9 && buf.toString('ascii', 0, 9) === '#!AMR-WB\n') return 'amr';
  if (buf.length >= 3 && buf.toString('ascii', 0, 3) === 'ID3') return 'mp3';
  if (buf.length >= 2 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return 'mp3';
  if (buf.length >= 4 && buf.toString('ascii', 0, 4) === 'OggS') return 'ogg';
  return 'unknown';
}

// ─── 编码器适配器（外部工具）────────────────────────────

export interface CodecTool {
  /** 可执行文件路径 */
  path: string;
  /** 版本（可选） */
  version?: string;
}

export interface CodecAvailability {
  silkEncoder: CodecTool | null;
  silkDecoder: CodecTool | null;
  ffmpeg: CodecTool | null;
  /** 能否编码成 QQ 语音 */
  canEncode: boolean;
  /** 能否解码 QQ 语音 */
  canDecode: boolean;
  /** 给用户看的说明 */
  hint: string;
}

/**
 * 探测外部工具。
 *
 * 只探测**用户显式配置的路径**，不去 PATH 里乱找 ——
 * 桌面应用擅自执行 PATH 上的同名程序是安全隐患。
 */
/**
 * 内置工具的候选路径。
 *
 * 开发期在 04_test-assets，打包后在 resources/。
 * 顺序很重要：先看内置（我们打包的），再看用户配置的。
 */
export function defaultCodecCandidates(): Record<string, string[]> {
  // 开发期素材目录由主进程通过 SOULWEAVE_TEST_ASSETS 注入（打包后为空）。
  // 这样安装包里不会出现任何开发机绝对路径。
  const devBases = [
    (process.env.SOULWEAVE_TEST_ASSETS || '').trim(),
    path.join(process.cwd(), '04_test-assets'),
    path.join(process.cwd(), '..', '..', '04_test-assets'),
  ].filter(Boolean);
  const dev = devBases[0] || '';
  const devJoin = (...p: string[]) => devBases.map((b) => path.join(b, ...p));
  return {
    silkEncoder: [
      ...devJoin('silk', 'silk_v3_encoder.exe'),
      'resources/silk/silk_v3_encoder.exe',
    ],
    silkDecoder: [
      ...devJoin('silk', 'silk_v3_decoder.exe'),
      'resources/silk/silk_v3_decoder.exe',
    ],
    ffmpeg: [
      ...devJoin('ffmpeg-lgpl', 'bin', 'ffmpeg.exe'),
      'resources/ffmpeg/bin/ffmpeg.exe',
    ],
  };
}

export async function probeCodecTools(opts: {
  silkEncoderPath?: string;
  silkDecoderPath?: string;
  ffmpegPath?: string;
}): Promise<CodecAvailability> {
  const cands = defaultCodecCandidates();
  const firstExisting = (list?: string[]): string | undefined => {
    for (const c of (list || [])) {
      try { if (fs.existsSync(c)) return c; } catch (e) { void e; }
    }
    return undefined;
  };

  const probe = async (p?: string): Promise<CodecTool | null> => {
    if (!p) return null;
    try {
      const r = await runProcess(p, ['--help'], 3000);
      // 大多数工具 --help 返回非 0 也算存在
      return { path: p, version: (r.stdout + r.stderr).slice(0, 80).trim() || undefined };
    } catch (e) {
      return null;
    }
  };

  const [silkEncoder, silkDecoder, ffmpeg] = await Promise.all([
    probe(opts.silkEncoderPath || firstExisting(cands.silkEncoder)),
    probe(opts.silkDecoderPath || firstExisting(cands.silkDecoder)),
    probe(opts.ffmpegPath || firstExisting(cands.ffmpeg)),
  ]);

  const canEncode = !!(silkEncoder || ffmpeg);
  const canDecode = !!(silkDecoder || ffmpeg);

  let hint = '';
  if (!canEncode && !canDecode) {
    hint = '未检测到 SILK / ffmpeg。QQ 语音收发不可用，文字消息不受影响。' +
      '请在设置里指定 silk_v3_encoder / silk_v3_decoder 路径。';
  } else if (!canEncode) {
    hint = '只能接收语音，不能发送（缺少编码器）。';
  } else if (!canDecode) {
    hint = '只能发送语音，不能接收（缺少解码器）。';
  } else {
    hint = '语音收发可用。';
  }

  return { silkEncoder, silkDecoder, ffmpeg, canEncode, canDecode, hint };
}

/** 跑一个子进程并收集输出（不经过 shell，避免注入） */
function runProcess(exe: string, args: string[], timeoutMs = 15000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let done = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      reject(e); return;
    }
    let stdout = ''; let stderr = '';
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill(); } catch (e) { void e; }
      reject(new Error('超时 ' + timeoutMs + 'ms'));
    }, timeoutMs);

    child.stdout?.on('data', (d) => { stdout += String(d); });
    child.stderr?.on('data', (d) => { stderr += String(d); });
    child.on('error', (e) => {
      if (done) return;
      done = true; clearTimeout(timer); reject(e);
    });
    child.on('close', (code) => {
      if (done) return;
      done = true; clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

// ─── 转换流程 ───────────────────────────────────────────

export interface EncodeResult {
  ok: boolean;
  data?: Buffer;
  format?: AudioFormat;
  durationSeconds?: number;
  error?: string;
  /** 降级说明（例如「未安装编码器」） */
  fallback?: string;
}

/**
 * 用 silk_v3_encoder 把 16kHz 单声道 16bit PCM 编成腾讯 SILK。
 *
 * 参数来源：实测确定（不是抄文档，文档没写）。
 *   -Fs_API 16000     输入采样率必须是 16k（SILK 的固定要求）
 *   -rate 24000       输出码率，24 kbps 是 QQ/微信常用档
 *   -tencent          加上腾讯格式的 0x02 头（不加就是标准 SILK 头）
 *
 * 实测：1 秒音频 → 2538 字节，头部 02 23 21 53 49 4c 4b 5f 56 33
 */
export async function encodePcmToSilk(
  pcm16k: Buffer,
  encoderPath: string,
  opts: { rate?: number; tencent?: boolean; timeoutMs?: number } = {},
): Promise<{ ok: boolean; data?: Buffer; error?: string }> {
  const os = await import('node:os');
  const fsMod = await import('node:fs');
  const pathMod = await import('node:path');
  const dir = fsMod.mkdtempSync(pathMod.join(os.tmpdir(), 'sw-silk-'));
  const inPcm = pathMod.join(dir, 'in.pcm');
  const outSilk = pathMod.join(dir, 'out.silk');
  try {
    if (!pcm16k.length) return { ok: false, error: 'PCM 为空' };
    fsMod.writeFileSync(inPcm, pcm16k);
    const args = [inPcm, outSilk, '-Fs_API', '16000', '-rate', String(opts.rate ?? 24000)];
    if (opts.tencent !== false) args.push('-tencent');
    const r = await runProcess(encoderPath, args, opts.timeoutMs ?? 20000);
    if (r.code !== 0) return { ok: false, error: '编码器返回 ' + r.code + ': ' + r.stderr.slice(0, 120) };
    if (!fsMod.existsSync(outSilk)) return { ok: false, error: '编码器没有产出文件' };
    const data = fsMod.readFileSync(outSilk);
    if (!data.length) return { ok: false, error: '编码结果为空' };
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 150) };
  } finally {
    try { fsMod.rmSync(dir, { recursive: true, force: true }); } catch (e) { void e; }
  }
}

/**
 * 用 silk_v3_decoder 把 SILK 解成 PCM。
 *
 * 实测：解码输出是 **24 kHz**（跟随编码时的 -rate），不是 16k。
 * 需要 16k 的话调用方自己再 resamplePcm16 一次。
 */
export async function decodeSilkToPcm(
  silk: Buffer,
  decoderPath: string,
  opts: { timeoutMs?: number } = {},
): Promise<{ ok: boolean; pcm?: Buffer; error?: string }> {
  const os = await import('node:os');
  const fsMod = await import('node:fs');
  const pathMod = await import('node:path');
  const dir = fsMod.mkdtempSync(pathMod.join(os.tmpdir(), 'sw-silk-'));
  const inSilk = pathMod.join(dir, 'in.silk');
  const outPcm = pathMod.join(dir, 'out.pcm');
  try {
    if (!silk.length) return { ok: false, error: 'SILK 为空' };

    // 先按原样试一次（kn007 的构建能识别腾讯的 0x02 头）
    const attempt = async (data: Buffer): Promise<{ ok: boolean; pcm?: Buffer }> => {
      try { if (fsMod.existsSync(outPcm)) fsMod.unlinkSync(outPcm); } catch (e) { void e; }
      fsMod.writeFileSync(inSilk, data);
      const r = await runProcess(decoderPath, [inSilk, outPcm], opts.timeoutMs ?? 20000);
      if (r.code !== 0 || !fsMod.existsSync(outPcm)) return { ok: false };
      const pcm = fsMod.readFileSync(outPcm);
      return pcm.length ? { ok: true, pcm } : { ok: false };
    };

    let res = await attempt(silk);

    // 失败则剥掉腾讯前缀再试（不同构建的容错不一样）
    if (!res.ok && silk.length > 10 &&
        (silk[0] === 0x02 || silk[0] === 0x03) &&
        silk.toString('ascii', 1, 10) === '#!SILK_V3') {
      res = await attempt(silk.subarray(1));
    }

    if (!res.ok) return { ok: false, error: '解码失败（已尝试原始与去前缀两种）' };
    return { ok: true, pcm: res.pcm };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 150) };
  } finally {
    try { fsMod.rmSync(dir, { recursive: true, force: true }); } catch (e) { void e; }
  }
}

/**
 * 把 WAV（TTS 输出）转成 QQ 语音。
 *
 * 链路：WAV → 取 PCM → 降混单声道 → 重采样到 16k → SILK 编码
 *
 * 没有编码器时**不报错崩掉**，返回带 fallback 说明的失败 ——
 * 上层据此决定「改发文字」。
 */
export async function wavToQqVoice(
  wav: Buffer,
  tools: CodecAvailability,
  opts: { maxDurationSeconds?: number } = {},
): Promise<EncodeResult> {
  const info = parseWav(wav);
  if (!info) return { ok: false, error: '不是合法的 WAV 文件' };

  const maxDur = opts.maxDurationSeconds ?? 60;
  if (info.durationSeconds > maxDur) {
    return { ok: false, error: '语音时长 ' + info.durationSeconds.toFixed(1) + 's 超过上限 ' + maxDur + 's' };
  }

  if (!tools.silkEncoder) {
    return {
      ok: false,
      fallback: '未安装 SILK 编码器，已跳过语音发送（文字消息不受影响）',
      error: '缺少语音编码器',
    };
  }

  // WAV → PCM → 单声道 → 16k
  let pcm = extractPcm(wav);
  if (!pcm) return { ok: false, error: 'WAV 里没有 PCM 数据' };
  pcm = toMono(pcm, info.channels, info.bitsPerSample);
  if (info.sampleRate !== 16000) {
    pcm = resamplePcm16(pcm, info.sampleRate, 16000, 1);
  }

  const r = await encodePcmToSilk(pcm, tools.silkEncoder.path, { rate: 24000, tencent: true });
  if (!r.ok || !r.data) {
    return { ok: false, error: r.error || '编码失败', fallback: '编码失败，建议改发文字' };
  }
  return { ok: true, data: r.data, format: 'silk', durationSeconds: info.durationSeconds };
}

/** 判断一条 QQ 语音是否值得尝试解码 */
export function canDecodeVoice(buf: Buffer, tools: CodecAvailability): { ok: boolean; reason?: string } {
  const fmt = sniffFormat(buf);
  if (fmt === 'wav') return { ok: true };
  if (fmt === 'silk' || fmt === 'amr') {
    if (!tools.canDecode) return { ok: false, reason: '收到 ' + fmt + ' 语音，但未安装解码器，无法播放' };
    return { ok: true };
  }
  return { ok: false, reason: '未知语音格式' };
}
