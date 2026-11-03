/*
 * SoulWeave S7：OpenAI 兼容语音识别（audio/transcriptions）
 *
 * 依据：用户决策「第一层：OpenAI 兼容通用接口」
 *
 * 【为什么这一层最重要】
 * 一个实现就能接 OpenAI / Groq / 硅基流动 / DeepInfra / Fireworks /
 * Together / OpenRouter / 自建服务 / 中转站 —— 覆盖了绝大多数需求。
 * 所以它必须最稳、错误信息最清楚。
 */

export interface TranscribeOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 音频字节 */
  audio: Uint8Array;
  /** 文件名（服务端靠扩展名判格式，必须给对） */
  filename?: string;
  /** 语言提示（zh / en …；留空自动检测） */
  language?: string;
  /** 提示词（给模型上下文，如专有名词） */
  prompt?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export interface TranscribeResult {
  ok: boolean;
  text?: string;
  error?: string;
  code?: string;
  ms?: number;
  model?: string;
}

/**
 * 把 HTTP 错误翻成用户能照着做的结论。
 */
export function explainAsrError(status: number, body: any): { code: string; error: string } {
  const raw = typeof body === 'string' ? body : JSON.stringify(body || {});
  const msg = String((body && (body.error && body.error.message || body.message || body.msg)) || raw || '').slice(0, 300);

  if (status === 401 || status === 403) {
    return { code: 'NO_CONFIG', error: 'API Key 无效或无权限（HTTP ' + status + '）：' + msg };
  }
  if (status === 404) {
    return { code: 'NOT_SUPPORTED', error: '接口或模型不存在（HTTP 404）：' + msg };
  }
  if (status === 413) {
    return { code: 'AUDIO_TOO_BIG', error: '音频太大被拒（HTTP 413）：' + msg };
  }
  if (status === 429) {
    return { code: 'QUOTA', error: '额度或频率超限（HTTP 429）：' + msg };
  }
  if (status === 408 || status === 504) {
    return { code: 'TIMEOUT', error: '服务端超时（HTTP ' + status + '）' };
  }
  if (status === 400) {
    if (/audio|format|codec|unsupported/i.test(msg)) {
      return { code: 'AUDIO_INVALID', error: '音频格式不被支持：' + msg };
    }
    return { code: 'NETWORK', error: '请求被拒绝（HTTP 400）：' + msg };
  }
  return { code: 'NETWORK', error: 'HTTP ' + status + '：' + msg };
}

/** 组装 multipart 请求体（不依赖第三方库） */
export function buildMultipart(opts: {
  model: string;
  audio: Uint8Array;
  filename: string;
  language?: string;
  prompt?: string;
}): { body: Uint8Array; contentType: string } {
  const boundary = '----soulweave' + Math.random().toString(36).slice(2);
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];

  const push = (s: string) => chunks.push(enc.encode(s));

  const field = (name: string, value: string) => {
    push('--' + boundary + '\r\n');
    push('Content-Disposition: form-data; name="' + name + '"\r\n\r\n');
    push(value + '\r\n');
  };

  field('model', opts.model);
  if (opts.language) field('language', opts.language);
  if (opts.prompt) field('prompt', opts.prompt);
  field('response_format', 'json');

  push('--' + boundary + '\r\n');
  push('Content-Disposition: form-data; name="file"; filename="' + opts.filename + '"\r\n');
  push('Content-Type: ' + mimeForAudio(opts.filename) + '\r\n\r\n');
  chunks.push(opts.audio);
  push('\r\n--' + boundary + '--\r\n');

  const total = chunks.reduce((n, c) => n + c.length, 0);
  const body = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { body.set(c, off); off += c.length; }
  return { body, contentType: 'multipart/form-data; boundary=' + boundary };
}

export function mimeForAudio(filename: string): string {
  const f = String(filename || '').toLowerCase();
  if (f.endsWith('.wav')) return 'audio/wav';
  if (f.endsWith('.mp3')) return 'audio/mpeg';
  if (f.endsWith('.m4a')) return 'audio/mp4';
  if (f.endsWith('.ogg')) return 'audio/ogg';
  if (f.endsWith('.webm')) return 'audio/webm';
  if (f.endsWith('.flac')) return 'audio/flac';
  return 'application/octet-stream';
}

/** 从响应里取文字（兼容 text / data.text / results[0]） */
export function extractTranscript(body: any): string {
  if (!body) return '';
  if (typeof body === 'string') return body.trim();
  if (typeof body.text === 'string') return body.text.trim();
  if (body.data && typeof body.data.text === 'string') return body.data.text.trim();
  if (Array.isArray(body.results) && body.results[0]) {
    const r = body.results[0];
    if (typeof r.transcript === 'string') return r.transcript.trim();
    if (Array.isArray(r.alternatives) && r.alternatives[0]) {
      return String(r.alternatives[0].transcript || '').trim();
    }
  }
  return '';
}

/**
 * 转写一段音频。
 *
 * 永不抛异常：所有失败都变成 { ok:false, code, error }。
 */
export async function transcribeOpenAI(opts: TranscribeOptions): Promise<TranscribeResult> {
  const f = opts.fetch || fetch;
  const t0 = Date.now();

  if (!opts.baseUrl) return { ok: false, code: 'NO_CONFIG', error: '缺少服务地址' };
  if (!opts.apiKey) return { ok: false, code: 'NO_CONFIG', error: '缺少 API Key' };
  if (!opts.model) return { ok: false, code: 'NO_CONFIG', error: '缺少模型名' };
  if (!opts.audio || !opts.audio.length) return { ok: false, code: 'AUDIO_INVALID', error: '没有音频数据' };

  const url = String(opts.baseUrl).replace(/\/+$/, '') + '/audio/transcriptions';
  const filename = opts.filename || 'audio.wav';
  const timeout = opts.timeoutMs || 120000;

  try {
    const mp = buildMultipart({
      model: opts.model, audio: opts.audio, filename,
      language: opts.language, prompt: opts.prompt,
    });
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout);
    const r = await f(url, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + opts.apiKey, 'Content-Type': mp.contentType },
      body: mp.body,
      signal: ctl.signal,
    } as any);
    clearTimeout(timer);

    const ms = Date.now() - t0;
    const text = await r.text();
    let body: any = null;
    try { body = JSON.parse(text); } catch (e) { body = text; }

    if (!r.ok) {
      const e = explainAsrError(r.status, body);
      return { ok: false, code: e.code, error: e.error, ms, model: opts.model };
    }

    const out = extractTranscript(body);
    return { ok: true, text: out, ms, model: opts.model };
  } catch (e: any) {
    const ms = Date.now() - t0;
    const msg = String(e && e.message ? e.message : e);
    if (/abort/i.test(msg)) return { ok: false, code: 'TIMEOUT', error: '请求超时', ms };
    const code = String((e && e.cause && e.cause.code) || (e && e.code) || '');
    const detail = msg + ' ' + code;
    if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(detail)) return { ok: false, code: 'NETWORK', error: '域名解析失败', ms };
    if (/ECONNREFUSED/i.test(detail)) return { ok: false, code: 'NETWORK', error: '连接被拒绝', ms };
    return { ok: false, code: 'NETWORK', error: msg.slice(0, 200), ms };
  }
}

/** 造一段静音 WAV（用于测试连接，不占额度） */
export function makeSilentWav(seconds = 0.5, sampleRate = 16000): Uint8Array {
  const n = Math.max(1, Math.floor(seconds * sampleRate));
  const dataBytes = n * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);          // PCM
  buf.writeUInt16LE(1, 22);          // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);
  return new Uint8Array(buf);
}