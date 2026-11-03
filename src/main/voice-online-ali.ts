/**
 * SoulWeave S3-19：阿里云智能语音交互（NLS）
 *
 * 两步流程，比其它厂商多一层：
 *   1) RPC 调 CreateToken 换临时 Token（用 AccessKey 签名，HMAC-SHA1）
 *   2) 用 Token 连 WebSocket 发合成请求
 *
 * 第 1 步签名（阿里云 RPC 风格 v1）：
 *   CanonicalizedQueryString = 参数按 key 排序后 percentEncode 拼接
 *   StringToSign = POST&percentEncode("/")&percentEncode(CanonicalizedQueryString)
 *   Signature    = base64(hmac_sha1(AccessKeySecret + "&", StringToSign))
 *
 * 第 2 步 WebSocket：wss://nls-gateway-cn-shanghai.aliyuncs.com/ws/v1?token=...
 */

import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import type { OnlineResult } from './voice-online-volc.js';

export interface AliOptions {
  accessKeyId: string;
  accessKeySecret: string;
  appKey: string;
  text: string;
  voice?: string;
  region?: string;
  timeoutMs?: number;
  endpointHost?: string;
  endpointProtocol?: 'http:' | 'https:';
  endpointPort?: number;
  fixedTimestamp?: string;
  fixedNonce?: string;
}

export const ALI_VOICES = [
  { id: 'xiaoyun', label: '小云（女）' },
  { id: 'xiaogang', label: '小刚（男）' },
  { id: 'ruoxi', label: '若兮（女）' },
  { id: 'siqi', label: '思琪（女，童声）' },
];

/** 阿里云要求的 percentEncode（比 encodeURIComponent 多了几个替换） */
export function aliEncode(s: string): string {
  return encodeURIComponent(s)
    .replace(/\+/g, '%20')
    .replace(/\*/g, '%2A')
    .replace(/%7E/g, '~');
}

/** 生成 CreateToken 的签名与完整 URL（导出以便单测） */
export function signAliToken(o: {
  accessKeyId: string; accessKeySecret: string; region?: string;
  timestamp?: string; nonce?: string;
}): { url: string; signature: string; canonical: string } {
  const region = o.region || 'cn-shanghai';
  const params: Record<string, string> = {
    AccessKeyId: o.accessKeyId,
    Action: 'CreateToken',
    Format: 'JSON',
    RegionId: region,
    SignatureMethod: 'HMAC-SHA1',
    SignatureNonce: o.nonce || crypto.randomUUID(),
    SignatureVersion: '1.0',
    Timestamp: o.timestamp || new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    Version: '2019-02-28',
  };
  const canonical = Object.keys(params).sort().map((k) => aliEncode(k) + '=' + aliEncode(params[k])).join('&');
  const stringToSign = 'POST&' + aliEncode('/') + '&' + aliEncode(canonical);
  const signature = crypto.createHmac('sha1', o.accessKeySecret + '&').update(stringToSign, 'utf8').digest('base64');
  const url = 'https://nls-meta.' + region + '.aliyuncs.com/?Signature=' + aliEncode(signature) + '&' + canonical;
  return { url, signature, canonical };
}

async function fetchToken(o: AliOptions): Promise<{ ok: boolean; token?: string; error?: string }> {
  const signed = signAliToken({
    accessKeyId: o.accessKeyId, accessKeySecret: o.accessKeySecret,
    region: o.region, timestamp: o.fixedTimestamp, nonce: o.fixedNonce,
  });
  const host = o.endpointHost || ('nls-meta.' + (o.region || 'cn-shanghai') + '.aliyuncs.com');
  const protocol = o.endpointProtocol || 'https:';
  const port = o.endpointPort || (protocol === 'https:' ? 443 : 80);
  // 用签名结果的 query 部分，但主机可能被覆盖（测试用）
  const qs = signed.url.slice(signed.url.indexOf('?') + 1);
  return new Promise((resolve) => {
    const mod = protocol === 'https:' ? https : http;
    const req = mod.request({ protocol, hostname: host, port, path: '/?' + qs, method: 'POST', timeout: o.timeoutMs ?? 15000, headers: { 'Content-Length': 0 } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let j: any = null;
        try { j = JSON.parse(raw); } catch (e) { resolve({ ok: false, error: 'Token 响应非 JSON：' + raw.slice(0, 160) }); return; }
        if (j.Token && j.Token.Id) { resolve({ ok: true, token: j.Token.Id }); return; }
        resolve({ ok: false, error: 'Token 获取失败：' + raw.slice(0, 200) });
      });
    });
    req.on('timeout', () => { try { req.destroy(); } catch (e) { /* ignore */ } resolve({ ok: false, error: 'Token 请求超时' }); });
    req.on('error', (e) => resolve({ ok: false, error: String(e).slice(0, 160) }));
    req.end();
  });
}

export async function synthesizeAli(o: AliOptions): Promise<OnlineResult> {
  const t0 = Date.now();
  const text = String(o.text || '').trim();
  if (!text) return { ok: false, error: '文本为空' };
  if (text.length > 500) return { ok: false, error: '单次上限 500 字' };
  if (!o.accessKeyId || !o.accessKeySecret || !o.appKey) return { ok: false, error: '未配置 AccessKey 或 AppKey' };

  const tk = await fetchToken(o);
  if (!tk.ok || !tk.token) return { ok: false, error: tk.error, ms: Date.now() - t0 };

  const region = o.region || 'cn-shanghai';
  const url = 'wss://nls-gateway-' + region + '.aliyuncs.com/ws/v1?token=' + encodeURIComponent(tk.token);

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
    try { ws = new (globalThis as any).WebSocket(url); }
    catch (e) { clearTimeout(timer); resolve({ ok: false, error: 'WebSocket 创建失败: ' + String(e).slice(0, 120) }); return; }
    ws.onopen = () => {
      const body = {
        header: { appkey: o.appKey, message_id: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now())).replace(/-/g, ''), task: 'tts', streaming: 'duplex' },
        payload: { text, format: 'mp3', sample_rate: 16000, voice: o.voice || 'xiaoyun', enable_subtitle: false },
      };
      try { ws.send(JSON.stringify(body)); } catch (e) { finish({ ok: false, error: String(e).slice(0, 120) }); }
    };
    ws.onmessage = (ev: any) => {
      let j: any = null;
      try { j = JSON.parse(typeof ev.data === 'string' ? ev.data : ''); } catch (e) { return; }
      const name = (j.header && j.header.name) || '';
      if (name === 'TaskFailed') { clearTimeout(timer); finish({ ok: false, error: 'TaskFailed: ' + JSON.stringify(j.header || {}).slice(0, 200), ms: Date.now() - t0 }); return; }
      const audio = j.payload && j.payload.audio;
      if (audio) parts.push(Buffer.from(audio, 'base64'));
      if (name === 'SynthesisCompleted' || name === 'TaskFinished') {
        clearTimeout(timer);
        const buf = Buffer.concat(parts);
        finish({ ok: buf.length > 0, base64: buf.toString('base64'), bytes: buf.length, ms: Date.now() - t0, contentType: 'audio/mpeg', error: buf.length ? undefined : '未收到音频' });
      }
    };
    ws.onerror = () => { clearTimeout(timer); finish({ ok: false, error: 'WebSocket 错误', ms: Date.now() - t0 }); };
    ws.onclose = () => { clearTimeout(timer); const buf = Buffer.concat(parts); if (!done) finish({ ok: buf.length > 0, base64: buf.toString('base64'), bytes: buf.length, ms: Date.now() - t0, contentType: 'audio/mpeg', error: buf.length ? undefined : '连接提前关闭' }); };
  });
}
