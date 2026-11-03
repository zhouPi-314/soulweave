/**
 * SoulWeave S3-19：讯飞在线语音合成（WebSocket）
 *
 * 协议：wss://tts-api.xfyun.cn/v2/tts
 * 鉴权：在 URL 上带 authorization / date / host 三个参数
 *   signature_origin = "host: tts-api.xfyun.cn\\ndate: <RFC1123>\\nGET /v2/tts HTTP/1.1"
 *   signature        = base64(hmac_sha256(signature_origin, apiSecret))
 *   auth_origin      = 'api_key="..", algorithm="hmac-sha256", headers="host date request-line", signature=".."'
 *   authorization    = base64(auth_origin)
 */

import crypto from 'node:crypto';
import type { OnlineResult } from './voice-online-volc.js';

export interface XfyunOptions {
  appId: string;
  apiKey: string;
  apiSecret: string;
  text: string;
  /** 发音人，默认 xiaoyan */
  voice?: string;
  /** 语速 0~100，默认 50 */
  speed?: number;
  timeoutMs?: number;
  /** 仅测试：覆盖 host */
  host?: string;
  protocol?: 'ws:' | 'wss:';
  port?: number;
  /** 固定时间（仅测试，保证签名可复现） */
  fixedDate?: string;
}

export const XFYUN_VOICES = [
  { id: 'xiaoyan', label: '小燕（女）' },
  { id: 'aisjiuxu', label: '许久（男）' },
  { id: 'aisxping', label: '小萍（女）' },
  { id: 'aisjinger', label: '小婧（女）' },
];

/** 生成带签名的 WebSocket URL（导出以便单测） */
export function buildXfyunUrl(o: { apiKey: string; apiSecret: string; host?: string; date?: string; path?: string }): { url: string; date: string } {
  const host = o.host || 'tts-api.xfyun.cn';
  const pth = o.path || '/v2/tts';
  const date = o.date || new Date().toUTCString();
  const origin = 'host: ' + host + '\\n' + 'date: ' + date + '\\n' + 'GET ' + pth + ' HTTP/1.1';
  const sig = crypto.createHmac('sha256', o.apiSecret).update(origin, 'utf8').digest('base64');
  const authOrigin = 'api_key="' + o.apiKey + '", algorithm="hmac-sha256", headers="host date request-line", signature="' + sig + '"';
  const auth = Buffer.from(authOrigin, 'utf8').toString('base64');
  return { url: 'wss://' + host + pth + '?authorization=' + encodeURIComponent(auth) + '&date=' + encodeURIComponent(date) + '&host=' + encodeURIComponent(host), date };
}

export async function synthesizeXfyun(o: XfyunOptions): Promise<OnlineResult> {
  const t0 = Date.now();
  const text = String(o.text || '').trim();
  if (!text) return { ok: false, error: '文本为空' };
  if (text.length > 2000) return { ok: false, error: '单次上限 2000 字' };
  if (!o.appId || !o.apiKey || !o.apiSecret) return { ok: false, error: '未配置 AppID / APIKey / APISecret' };

  const host = o.host || 'tts-api.xfyun.cn';
  const built = buildXfyunUrl({ apiKey: o.apiKey, apiSecret: o.apiSecret, host, date: o.fixedDate });
  let url = built.url;
  if (o.protocol === 'ws:' || o.port) {
    url = url.replace('wss://', 'ws://');
    if (o.port) url = url.replace(host, host + ':' + o.port);
  }

  return new Promise<OnlineResult>((resolve) => {
    let done = false;
    const parts: Buffer[] = [];
    const finish = (r: OnlineResult) => {
      if (done) return;
      done = true;
      try { ws.close(); } catch (e) { /* ignore */ }
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ok: false, error: '超时', ms: Date.now() - t0 }), o.timeoutMs ?? 30000);
    let ws: any;
    try {
      ws = new (globalThis as any).WebSocket(url);
    } catch (e) {
      clearTimeout(timer);
      resolve({ ok: false, error: 'WebSocket 创建失败: ' + String(e).slice(0, 120) });
      return;
    }
    ws.onopen = () => {
      const body = {
        common: { app_id: o.appId },
        business: { aue: 'lame', sfl: 1, auf: 'audio/L16;rate=16000', vcn: o.voice || 'xiaoyan', speed: typeof o.speed === 'number' ? o.speed : 50, tte: 'UTF8' },
        data: { status: 2, text: Buffer.from(text, 'utf8').toString('base64') },
      };
      try { ws.send(JSON.stringify(body)); } catch (e) { finish({ ok: false, error: String(e).slice(0, 120) }); }
    };
    ws.onmessage = (ev: any) => {
      let j: any = null;
      try { j = JSON.parse(typeof ev.data === 'string' ? ev.data : ''); } catch (e) { return; }
      if (j.code !== 0) { clearTimeout(timer); finish({ ok: false, error: 'code=' + j.code + ' ' + (j.message || ''), ms: Date.now() - t0 }); return; }
      const d = j.data || {};
      if (d.audio) parts.push(Buffer.from(d.audio, 'base64'));
      if (d.status === 2) {
        clearTimeout(timer);
        const buf = Buffer.concat(parts);
        finish({ ok: buf.length > 0, base64: buf.toString('base64'), bytes: buf.length, ms: Date.now() - t0, contentType: 'audio/mpeg', error: buf.length ? undefined : '未收到音频数据' });
      }
    };
    ws.onerror = () => { clearTimeout(timer); finish({ ok: false, error: 'WebSocket 错误', ms: Date.now() - t0 }); };
    ws.onclose = () => { if (!done) { clearTimeout(timer); const buf = Buffer.concat(parts); finish({ ok: buf.length > 0, base64: buf.toString('base64'), bytes: buf.length, ms: Date.now() - t0, contentType: 'audio/mpeg', error: buf.length ? undefined : '连接提前关闭' }); } };
  });
}
