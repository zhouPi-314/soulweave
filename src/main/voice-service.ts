/**
 * SoulWeave S3-11：外部语音服务 provider（GPT-SoVITS / CosyVoice）
 *
 * 定位
 * ────
 * 这两类服务的运行时是 Python + CUDA（3–5 GB），不可能打进安装包。
 * 所以它们以「用户自行部署的本地 HTTP 服务」形式接入：
 *
 *   部署方式参照规划文档对 NapCat 的约定 —— 不打包，用户自行安装。
 *
 * 安全约束
 * ────────
 * 1. 只允许 localhost / 127.0.0.1 / 局域网私网地址（防止误配到公网把文本发出去）
 * 2. 超时严格（探活 2.5s，合成 60s）
 * 3. 响应大小上限（防止异常响应吃满内存）
 */

import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

export interface ProbeResult {
  ok: boolean;
  status?: number;
  ms?: number;
  error?: string;
}

/** 只允许本地/私网地址：语音合成会把待朗读文本发过去 */
export function isPrivateHost(hostname: string): boolean {
  const h = String(hostname || '').toLowerCase();
  if (h === 'localhost' || h === '::1' || h === '127.0.0.1') return true;
  if (/^127\./.test(h)) return true;
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  return false;
}

function request(
  urlStr: string,
  opts: { method?: string; timeoutMs?: number; body?: string; maxBytes?: number; headers?: Record<string, string> } = {}
): Promise<{ ok: boolean; status?: number; buf?: Buffer; text?: string; ms?: number; error?: string }> {
  const t0 = Date.now();
  const timeoutMs = opts.timeoutMs ?? 5000;
  const maxBytes = opts.maxBytes ?? 24 * 1024 * 1024;

  return new Promise((resolve) => {
    let u: URL;
    try { u = new URL(urlStr); } catch (e) {
      resolve({ ok: false, error: '地址格式不正确' });
      return;
    }
    if (!isPrivateHost(u.hostname)) {
      resolve({ ok: false, error: '只允许本地/私网地址（防止文本被发到公网）' });
      return;
    }

    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + (u.search || ''),
      method: opts.method || 'GET',
      timeout: timeoutMs,
      headers: Object.assign(
        { 'Content-Length': opts.body ? Buffer.byteLength(opts.body) : 0 },
        opts.headers || {}
      ),
    }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > maxBytes) {
          try { req.destroy(); } catch (e) { /* ignore */ }
          resolve({ ok: false, status: res.statusCode, error: '响应过大（超过上限）', ms: Date.now() - t0 });
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({
          ok: (res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300,
          status: res.statusCode,
          buf,
          text: buf.slice(0, 400).toString('utf8'),
          ms: Date.now() - t0,
        });
      });
    });

    req.on('timeout', () => {
      try { req.destroy(); } catch (e) { /* ignore */ }
      resolve({ ok: false, error: '超时', ms: Date.now() - t0 });
    });
    req.on('error', (e) => resolve({ ok: false, error: String(e).slice(0, 200), ms: Date.now() - t0 }));

    if (opts.body) req.write(opts.body);
    req.end();
  });
}

/** 探活：只要服务有响应（任何 2xx/3xx/4xx 说明端口通了）就算可达 */
export async function probeService(baseUrl: string, timeoutMs = 2500): Promise<ProbeResult> {
  if (!baseUrl) return { ok: false, error: '未配置服务地址' };
  const r = await request(baseUrl, { method: 'GET', timeoutMs, maxBytes: 256 * 1024 });
  // 4xx 也说明服务活着（只是这个路径没有内容）
  const reachable = r.status !== undefined;
  return {
    ok: reachable,
    status: r.status,
    ms: r.ms,
    error: reachable ? undefined : r.error,
  };
}

export interface ServiceSynthOptions {
  /** 服务基地址，如 http://127.0.0.1:9880 */
  baseUrl: string;
  /** 'gptsovits' 走 GET /tts；'cosyvoice' 走 POST /tts（JSON） */
  kind?: 'gptsovits' | 'cosyvoice';
  text: string;
  /** GPT-SoVITS 需要参考音频 */
  refAudioPath?: string;
  promptText?: string;
  textLang?: string;
  promptLang?: string;
  timeoutMs?: number;
}

export interface ServiceSynthResult {
  ok: boolean;
  base64?: string;
  bytes?: number;
  ms?: number;
  contentType?: string;
  error?: string;
}

/** 合成：把服务返回的音频字节转 base64 交给渲染层播放 */
export async function synthesizeService(o: ServiceSynthOptions): Promise<ServiceSynthResult> {
  const body = String(o.text || '').trim();
  if (!body) return { ok: false, error: '文本为空' };
  if (!o.baseUrl) return { ok: false, error: '未配置服务地址' };

  const kind = o.kind || 'gptsovits';
  const timeoutMs = o.timeoutMs ?? 60000;
  let urlStr = '';
  let method = 'GET';
  let payload: string | undefined;
  const headers: Record<string, string> = {};

  if (kind === 'gptsovits') {
    // GPT-SoVITS api_v2：GET /tts?text=...&text_lang=zh&ref_audio_path=...
    const u = new URL(o.baseUrl.replace(/\/+$/, '') + '/tts');
    u.searchParams.set('text', body);
    u.searchParams.set('text_lang', o.textLang || 'zh');
    if (o.refAudioPath) u.searchParams.set('ref_audio_path', o.refAudioPath);
    if (o.promptText) u.searchParams.set('prompt_text', o.promptText);
    u.searchParams.set('prompt_lang', o.promptLang || o.textLang || 'zh');
    u.searchParams.set('text_split_method', 'cut5');
    u.searchParams.set('media_type', 'wav');
    urlStr = u.toString();
  } else {
    urlStr = o.baseUrl.replace(/\/+$/, '') + '/tts';
    method = 'POST';
    payload = JSON.stringify({ text: body, lang: o.textLang || 'zh', format: 'wav' });
    headers['Content-Type'] = 'application/json';
  }

  const r = await request(urlStr, { method, timeoutMs, body: payload, headers });
  if (!r.ok) {
    const hint = r.text ? ' | ' + r.text.slice(0, 160) : '';
    return { ok: false, error: (r.error || ('HTTP ' + r.status)) + hint, ms: r.ms };
  }
  const buf = r.buf || Buffer.alloc(0);
  if (buf.length < 44) return { ok: false, error: '响应不是有效音频（太小）', ms: r.ms };

  const isRiff = buf.toString('ascii', 0, 4) === 'RIFF';
  const isMp3 = buf.slice(0, 3).toString('ascii') === 'ID3' || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0);
  if (!isRiff && !isMp3) {
    return { ok: false, error: '响应不是 WAV/MP3 音频（可能配置错误或需要鉴权）', ms: r.ms };
  }

  return {
    ok: true,
    base64: buf.toString('base64'),
    bytes: buf.length,
    ms: r.ms,
    contentType: isRiff ? 'audio/wav' : 'audio/mpeg',
  };
}
